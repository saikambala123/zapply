import type { NextRequest } from "next/server";
import { connectDB } from "@/lib/db";
import Application from "@/models/Application";
import SavedResponse, { normalizeQuestion } from "@/models/SavedResponse";
import { requireUser } from "@/lib/auth";
import { ok, fail, handler, cors } from "@/lib/api";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const OPTIONS = () => cors();

function categorizeQuestion(q: string) {
  const s = q.toLowerCase();
  if (/sponsor|visa|authorized|work permit|immigration/.test(s)) return "work-authorization";
  if (/salary|compensation|pay|rate|bonus/.test(s)) return "compensation";
  if (/education|degree|school|university|college|gpa|major/.test(s)) return "education";
  if (/experience|employer|company|job title|role|responsibil/.test(s)) return "experience";
  if (/linkedin|github|portfolio|website|url/.test(s)) return "links";
  if (/location|city|state|address|country|phone|email/.test(s)) return "contact";
  if (/gender|race|ethnicity|veteran|disability|hispanic/.test(s)) return "eeo";
  if (/relocat|remote|hybrid|onsite|start date|notice period|availability/.test(s)) return "availability";
  return "general";
}

/**
 * The extension posts here after a successful autofill/submit:
 *   { application: {...}, responses: [{question, answer, inputType}] }
 * Both halves are optional so a page can report responses without an application.
 */
/**
 * The extension's sync payload.
 *
 * This is the highest-volume untrusted input the portal takes, and it had no
 * schema and no size limit. Two consequences worth closing:
 *
 *   - strings were written to the database at whatever length arrived, so one
 *     malformed capture could store a megabyte against a job title;
 *   - `responses` was walked with an awaited database call per item, so a
 *     thousand-item array became a thousand sequential round trips and a
 *     request that ties up a connection for minutes.
 *
 * Fields are capped at lengths comfortably above anything a real form produces,
 * and the array is capped at 200 — an application with more answers than that is
 * a bug, not a candidate.
 */
const str = (max: number) => z.string().trim().max(max);

const SyncBody = z.object({
  application: z
    .object({
      jobTitle: str(300),
      company: str(300).optional(),
      companyDomain: str(300).optional(),
      location: str(300).optional(),
      ats: str(60).optional(),
      url: str(2000).optional(),
      profileId: str(64).optional(),
      appliedAt: z.union([z.string(), z.number()]).optional(),
      autofill: z.record(z.unknown()).optional(),
    })
    .partial({ jobTitle: true })
    .optional(),
  responses: z
    .array(
      z.object({
        question: str(2000),
        answer: str(10000).optional(),
        inputType: str(40).optional(),
        options: z.array(str(500)).max(100).optional(),
        ats: str(60).optional(),
        domain: str(300).optional(),
      })
    )
    .max(200)
    .optional(),
});

export const POST = handler(async (req: NextRequest) => {
  const user = await requireUser(req);
  await connectDB();

  const parsed = SyncBody.safeParse(await req.json());
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "That sync payload was not readable.", 400);
  }
  const body = parsed.data;

  let application = null;
  if (body.application?.jobTitle) {
    const a = body.application;

    // `url` is the de-duplication key. Mongoose drops `undefined` from a query,
    // so an upsert filtered on a missing URL collapsed to `{ userId }` and
    // overwrote whichever application Mongo matched first. Insert instead.
    const url = typeof a.url === "string" && a.url.trim() ? a.url.trim() : null;

    const set = {
      userId: user._id,
      jobTitle: a.jobTitle,
      company: a.company,
      companyDomain: a.companyDomain,
      location: a.location,
      ats: a.ats,
      source: "extension" as const,
      profileId: a.profileId || undefined,
      lastActivityAt: new Date(),
      autofill: a.autofill ?? {},
    };
    const onInsert = {
      stage: "applied",
      appliedAt: a.appliedAt ? new Date(a.appliedAt) : new Date(),
      events: [{ stage: "applied", at: new Date() }],
    };

    application = url
      ? await Application.findOneAndUpdate(
          { userId: user._id, url },
          { $set: { ...set, url }, $setOnInsert: onInsert },
          { new: true, upsert: true, setDefaultsOnInsert: true }
        )
      : await Application.create({ ...set, ...onInsert });
  }

  let savedCount = 0;
  if (Array.isArray(body.responses) && body.responses.length) {
    for (const r of body.responses) {
      const question = String(r?.question || "").trim();
      const answer = String(r?.answer ?? "").trim();
      const normalizedKey = normalizeQuestion(question);
      if (!question || !answer || !normalizedKey) continue;

      const doc = await SavedResponse.findOne({ userId: user._id, normalizedKey });
      if (doc) {
        const aliases = new Set([...(doc.aliases || []), question]);
        doc.question = question;
        doc.answer = answer;
        doc.inputType = r.inputType || doc.inputType || "text";
        doc.options = Array.isArray(r.options) ? r.options.slice(0, 50) : doc.options;
        doc.ats = r.ats || doc.ats;
        doc.lastDomain = r.domain || doc.lastDomain;
        doc.lastUsedAt = new Date();
        doc.category = categorizeQuestion(question);
        doc.aliases = Array.from(aliases).slice(-30);
        doc.useCount = (doc.useCount || 0) + 1;
        await doc.save();
      } else {
        await SavedResponse.create({
          userId: user._id,
          question,
          normalizedKey,
          aliases: [question],
          answer,
          inputType: r.inputType || "text",
          options: Array.isArray(r.options) ? r.options.slice(0, 50) : [],
          ats: r.ats,
          lastDomain: r.domain,
          lastUsedAt: new Date(),
          category: categorizeQuestion(question),
          useCount: 1,
          source: "user",
        });
      }
      savedCount++;
    }
  }

  return ok({
    applicationId: application ? String(application._id) : null,
    responsesSaved: savedCount,
    syncedAt: new Date().toISOString(),
  });
});
