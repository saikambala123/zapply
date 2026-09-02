import type { NextRequest } from "next/server";
import { connectDB } from "@/lib/db";
import Profile from "@/models/Profile";
import SavedResponse, { normalizeQuestion } from "@/models/SavedResponse";
import { requireUser } from "@/lib/auth";
import { ok, fail, handler, cors } from "@/lib/api";
import { isPremium } from "@/lib/plan";
import { textAIEnabled, askAI, askAIJSON, profileToContext, AI_SETUP_HINT } from "@/lib/ai";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const OPTIONS = () => cors();

/**
 * Questions the model is never asked, whatever the caller says.
 *
 * Two groups: anything inside a voluntary self-identification block, and the
 * factual identity fields that always have a profile value. Kept broad on
 * purpose — a refusal here costs a blank field the applicant can fill in, while
 * a wrong answer is a false declaration they may not notice.
 */
const IDENTITY_QUESTION_RE =
  /(voluntary\s+self[-\s]?identification|self[-\s]?identification\s+of\s+disability|form\s*cc-?305|cc-?305|section\s*503|omb\s*control\s*number|voluntary\s+disclosure|equal\s+employment\s+opportunity|\bveteran\b|\bdisabilit(y|ies)\b|\bethnicity\b|\brace\b|\bgender\b|\bemployee\s*(id|number)\b|\bdate\s*of\s*birth\b|\bsocial\s*security\b|\bssn\b)/i;

/**
 * Premium — writes an answer to a custom application question using the
 * candidate's own profile as the only source of facts.
 */
export const POST = handler(async (req: NextRequest) => {
  const user = await requireUser(req);
  if (!isPremium(user)) return fail("Generated answers are a Premium feature.", 402);
  if (!textAIEnabled()) return fail(AI_SETUP_HINT, 503);

  // A long form can ask for many drafts, but a runaway content script shouldn't
  // be able to bill an unbounded number of Gemini calls to this deployment.
  await rateLimit("ai-answer", String(user._id), { limit: 120, windowSec: 3600 });

  const { question, jobTitle, company, jobDescription, profileId, maxWords = 120, options, fieldType = "text", multiple = false } = await req.json();
  if (!question) return fail("We need the question text.", 400);

  /**
   * Voluntary self-identification and identity questions are refused here, not
   * just in the extension.
   *
   * The extension is the only caller today, but it is the caller that got this
   * wrong: a CC-305 "Name" box reached this route with the disability question
   * in its surrounding context and came back "Yes", and an "Employee ID" box
   * came back with the applicant's name. Both are declarations on a federal
   * form. Every one of these questions has a deterministic answer in the
   * profile or no answer at all, so a generated one is never the right output
   * and the refusal belongs on both sides of the wire.
   */
  if (IDENTITY_QUESTION_RE.test(String(question))) {
    return ok({ answer: "", skipped: "identity" });
  }

  await connectDB();
  const profile =
    (profileId && (await Profile.findOne({ _id: profileId, userId: user._id }).lean())) ||
    (await Profile.findOne({ userId: user._id, isDefault: true }).lean()) ||
    (await Profile.findOne({ userId: user._id }).lean());
  if (!profile) return fail("Create a profile first.", 400);

  const baseSystem =
    "You help a job applicant answer application questions. Use only facts present in their profile or in the answers they have given before — never invent employers, dates, numbers, credentials, immigration status, demographic information, or preferences. For sensitive questions, use an explicit profile value or choose the neutral decline option when one exists. Never guess.";

  // What this person has already answered elsewhere is the best source after
  // the profile itself: it is their own wording, already approved by them.
  // Wording differs between portals, so the model gets the shortlist and
  // decides, rather than relying on an exact key match.
  const memory = await loadRelatedAnswers(user._id, String(question));
  const memoryBlock = memory.length
    ? `\n\nAnswers this applicant has given before (reuse when the question means the same thing):\n${memory
        .map((m) => `- Q: ${m.question}\n  A: ${m.answer}`)
        .join("\n")}`
    : "";

  const context = `Applicant profile:\n${profileToContext(profile)}${memoryBlock}\n\nRole: ${jobTitle ?? "?"} at ${company ?? "?"}\n${
    jobDescription ? `Job description:\n${String(jobDescription).slice(0, 4000)}\n` : ""
  }\nApplication question: "${question}"`;

  // Checkbox groups can have several correct choices. Force JSON array output
  // so the extension can select multiple real DOM checkboxes instead of trying
  // to interpret a sentence such as "Python and Java".
  if (fieldType === "checkbox" && multiple && options?.length) {
    const result = await askAIJSON<{ answers?: string[] }>(
      `${baseSystem}\nFor a checkbox/multi-select question, return only choices that are supported by the profile. Return an empty array if none are supported.`,
      `${context}\n\nAvailable choices (use these exact strings only): ${options.join(" | ")}\nReturn JSON exactly as: {"answers":["choice 1","choice 2"]}`,
      500
    );
    const answers = Array.isArray(result?.answers)
      ? result.answers.filter((x) => options.includes(x)).slice(0, 20)
      : [];
    return ok({ answer: answers });
  }

  // A menu entry marked "(category, has sub-options)" is a heading, not an
  // answer. "How Did You Hear About Us?" on Workday shows "Job Board" and
  // "Social Media" at the top level and hides LinkedIn one level down, so the
  // model must be free to name a value that is not in the visible list.
  const hasCategories = Array.isArray(options) && options.some((o: string) => /\(category/i.test(o));

  const optionLine = options?.length
    ? hasCategories
      ? `\n\nThis is a single-choice menu with sub-menus. Entries marked "(category, has sub-options)" are headings — never answer with one. Reply with the single most accurate value for this applicant: either a plain entry from the list below, verbatim, or the specific value you expect to find inside the right category (for example answer "LinkedIn" rather than "Social Media"). Reply with the value only.\nMenu: ${options.join(" | ")}`
      : `\n\nThis is a single-choice field. Reply with exactly one option from this list, verbatim: ${options.join(" | ")}`
    : `\n\nWrite at most ${maxWords} words. Plain prose, first person, no greeting, no sign-off, no markdown.`;

  const answer = await askAI(baseSystem, `${context}${optionLine}`, 600);
  return ok({ answer: String(answer).replace(/\s*\(category[^)]*\)\s*/i, "").trim() });
});

/**
 * The saved answers most likely to be relevant to this question: an exact
 * normalized-key hit first, then anything sharing a meaningful word with it.
 */
async function loadRelatedAnswers(userId: unknown, question: string) {
  try {
    const key = normalizeQuestion(question);
    const words = key.split(/\s+/).filter((w) => w.length > 3).slice(0, 6);

    const rows = await SavedResponse.find({
      userId,
      answer: { $nin: ["", null] },
      ...(words.length ? { $or: [{ normalizedKey: key }, { normalizedKey: { $regex: words.join("|") } }] } : { normalizedKey: key }),
    })
      .select("question answer normalizedKey pinned useCount")
      .sort({ pinned: -1, useCount: -1, updatedAt: -1 })
      .limit(12)
      .lean();

    return (rows as Array<{ question?: string; answer?: string }>)
      .filter((r) => r?.question && r?.answer)
      .map((r) => ({ question: String(r.question).slice(0, 160), answer: String(r.answer).slice(0, 400) }));
  } catch {
    // Memory is an enhancement; never let it break answering.
    return [];
  }
}
