import { connectDB } from "@/lib/db";
import User, { SETTINGS_FIELDS } from "@/models/User";
import { requireUser } from "@/lib/auth";
import { ok, fail, handler } from "@/lib/api";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  const user = await requireUser();
  return ok((user as any).settings ?? {});
});

export const PATCH = handler(async (req: Request) => {
  const user = await requireUser();
  await connectDB();
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail("Send an object of settings to change.", 400);
  }

  /**
   * Whitelisted and coerced. The old version interpolated every key the caller
   * sent straight into a `settings.<key>` update path, so a client could write
   * arbitrary field names — and arbitrarily large values — into the user
   * document with no validation and no size ceiling.
   */
  const update: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    const coerce = SETTINGS_FIELDS[key];
    if (!coerce) { rejected.push(key); continue; }
    update[`settings.${key}`] = coerce(value);
  }

  if (!Object.keys(update).length) {
    return fail(
      rejected.length
        ? `None of those are settings we recognise: ${rejected.slice(0, 5).join(", ")}.`
        : "There was nothing to update.",
      400
    );
  }

  const updated = await User.findByIdAndUpdate(user._id, { $set: update }, { new: true }).select("settings");

  return ok({ ...(updated?.settings?.toObject?.() ?? updated?.settings ?? {}), ignored: rejected });
});
