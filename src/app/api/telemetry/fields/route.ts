import type { NextRequest } from "next/server";
import { connectDB } from "@/lib/db";
import FieldOutcome from "@/models/FieldOutcome";
import { requireUser } from "@/lib/auth";
import { ok, fail, handler, cors } from "@/lib/api";
import { normalizeQuestion } from "@/models/SavedResponse";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const OPTIONS = () => cors();

/**
 * Fill outcomes from the extension.
 *
 * Batched and capped for the same reason the sync route is: this is untrusted
 * input arriving at volume, and an unbounded array walked with one database call
 * per item is a request that holds a connection open for minutes. Counters are
 * bounded per request too, so a client bug cannot inflate the numbers the
 * accuracy report is built on.
 */
const str = (max: number) => z.string().trim().max(max);

const Body = z.object({
  ats: str(60).optional(),
  items: z
    .array(
      z.object({
        label: str(500),
        ruleKey: str(80).nullable().optional(),
        source: z.enum(["profile", "saved", "ai", "blank", "unmatched"]).default("unmatched"),
        inputType: str(40).default("text"),
        filled: z.boolean().default(false),
        corrected: z.boolean().default(false),
        blank: z.boolean().default(false),
        rejected: z.boolean().default(false),
      })
    )
    .max(300),
});

export const POST = handler(async (req: NextRequest) => {
  const user = await requireUser(req);
  await connectDB();

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "That payload was not readable.", 400);
  }
  const { ats = "unknown", items } = parsed.data;

  /**
   * Several fields on one page can normalise to the same key — repeated rows,
   * or two boxes with the same label. They are folded together here so the
   * write is one operation per distinct question rather than per element.
   */
  const merged = new Map<string, ReturnType<typeof blank>>();
  const blank = () => ({
    sample: "",
    ruleKey: null as string | null,
    source: "unmatched",
    inputType: "text",
    fills: 0,
    corrections: 0,
    blanks: 0,
    rejections: 0,
  });

  for (const item of items) {
    const key = normalizeQuestion(item.label);
    if (!key) continue;
    const row = merged.get(key) ?? blank();
    row.sample = row.sample || item.label.slice(0, 160);
    row.ruleKey = item.ruleKey ?? row.ruleKey;
    row.source = item.source;
    row.inputType = item.inputType;
    if (item.filled) row.fills += 1;
    if (item.corrected) row.corrections += 1;
    if (item.blank) row.blanks += 1;
    if (item.rejected) row.rejections += 1;
    merged.set(key, row);
  }
  if (!merged.size) return ok({ recorded: 0 });

  // One round trip for the whole batch.
  await FieldOutcome.bulkWrite(
    Array.from(merged.entries()).map(([key, row]) => ({
      updateOne: {
        filter: { userId: user._id, ats, key },
        update: {
          $setOnInsert: { userId: user._id, ats, key },
          $set: {
            sample: row.sample,
            ruleKey: row.ruleKey,
            source: row.source,
            inputType: row.inputType,
            lastSeenAt: new Date(),
          },
          $inc: {
            fills: row.fills,
            corrections: row.corrections,
            blanks: row.blanks,
            rejections: row.rejections,
          },
        },
        upsert: true,
      },
    })),
    { ordered: false }
  );

  return ok({ recorded: merged.size });
});

/**
 * The accuracy report.
 *
 * Ordered by how much trouble a field causes rather than how often it appears,
 * because a question asked twice and wrong both times matters more than one
 * asked fifty times and always right.
 */
export const GET = handler(async (req: NextRequest) => {
  const user = await requireUser(req);
  await connectDB();

  const params = new URL(req.url).searchParams;
  const ats = params.get("ats");
  const filter: Record<string, unknown> = { userId: user._id };
  if (ats && ats !== "all") filter.ats = ats;

  const rows = await FieldOutcome.find(filter).sort({ corrections: -1, rejections: -1 }).limit(300).lean();

  const totals = rows.reduce(
    (acc, r) => {
      acc.fills += r.fills ?? 0;
      acc.corrections += r.corrections ?? 0;
      acc.blanks += r.blanks ?? 0;
      acc.rejections += r.rejections ?? 0;
      return acc;
    },
    { fills: 0, corrections: 0, blanks: 0, rejections: 0 }
  );

  // Of the fields we filled, the share the applicant did not have to touch.
  const accuracy = totals.fills > 0 ? 1 - totals.corrections / totals.fills : null;

  return ok({
    totals,
    accuracy,
    atsList: Array.from(new Set(rows.map((r) => r.ats))).sort(),
    rows: rows.map((r) => ({
      key: r.key,
      sample: r.sample,
      ats: r.ats,
      ruleKey: r.ruleKey,
      source: r.source,
      inputType: r.inputType,
      fills: r.fills ?? 0,
      corrections: r.corrections ?? 0,
      blanks: r.blanks ?? 0,
      rejections: r.rejections ?? 0,
      lastSeenAt: r.lastSeenAt,
    })),
  });
});
