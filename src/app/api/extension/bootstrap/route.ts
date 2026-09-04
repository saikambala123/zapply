import type { NextRequest } from "next/server";
import { connectDB } from "@/lib/db";
import Profile from "@/models/Profile";
import SavedResponse from "@/models/SavedResponse";
import { requireUser } from "@/lib/auth";
import { ok, handler, cors } from "@/lib/api";
import { isPremium } from "@/lib/plan";

export const dynamic = "force-dynamic";
export const OPTIONS = () => cors();

function canonicalInputType(raw: unknown) {
  const t = String(raw ?? "").trim().toLowerCase();
  if (t === "textarea" || t === "long text" || t === "long-text") return "textarea";
  if (["select", "dropdown", "combobox", "menu", "listbox"].includes(t)) return "select";
  if (["radio", "choice", "choices", "radiogroup"].includes(t)) return "radio";
  if (["checkbox", "checkboxes", "check", "checkgroup", "checkbox-group"].includes(t)) return "checkbox";
  if (["date", "month", "number"].includes(t)) return t;
  return "text";
}

function isHumanQuestion(q: unknown) {
  const t = String(q ?? "").trim().replace(/\s+/g, " ");
  if (!t || t.length < 5 || t.length > 300) return false;
  if (/^[a-f0-9]{16,}(?:[-_][a-z0-9]+)*$/i.test(t)) return false;
  if (/^(?:[a-f0-9]{8,}\s+){2,}[a-f0-9]{4,}(?:\s|$)/i.test(t)) return false;
  if (/\b(?:labeled|labelled)\s+(?:checkbox|radio|dropdown|select|input)\b/i.test(t) && /^[a-z0-9\s_-]+$/i.test(t)) return false;
  if (/^(?:q|question|field|checkbox|radio|dropdown|select|input)(?:[_\- ]*(?:id|input|label|option|group))?\s*\d*$/i.test(t)) return false;
  if (/^(?:select|choose|please select|--|yes|no|true|false)$/i.test(t)) return false;
  return true;
}

/**
 * One payload the content script can cache: profiles, settings and every saved
 * answer. Called on install, on login, and whenever the dashboard pushes a change.
 */
export const GET = handler(async (req: NextRequest) => {
  const user = await requireUser(req);
  await connectDB();

  const [profiles, responses] = await Promise.all([
    Profile.find({ userId: user._id }).sort({ isDefault: -1 }).lean(),
    SavedResponse.find({ userId: user._id, source: "user" }).select("question normalizedKey aliases category answer inputType options source").lean(),
  ]);

  return ok({
    user: {
      id: String(user._id),
      name: (user as any).name,
      email: (user as any).email,
      premium: isPremium(user),
    },
    settings: (user as any).settings ?? {},
    activeProfileId: String((user as any).activeProfileId ?? profiles[0]?._id ?? ""),
    profiles: profiles.map((p) => ({ ...p, _id: String(p._id), userId: undefined })),
    responses: responses
      .filter((r) => isHumanQuestion((r as any).question))
      .map((r) => ({ ...r, _id: String(r._id), inputType: canonicalInputType((r as any).inputType), options: Array.isArray((r as any).options) ? (r as any).options.slice(0, 50).map((x: unknown) => String(x)).filter(Boolean) : [] })),
    syncedAt: new Date().toISOString(),
  });
});
