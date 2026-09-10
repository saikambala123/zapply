/**
 * Regression test for two reported bugs:
 *
 *  1. "Are you willing to work over 40 hours a week / Saturdays / Sundays /
 *     evening shifts / travel?" had no profile field or field-map rule at
 *     all, so they were answered from a stale saved-answers cache (or the
 *     AI model) instead of the profile — the same "wrong answer replayed
 *     from somewhere else" shape as the sponsorship bug eligibility.spec.mjs
 *     already covers, just for a different set of questions.
 *
 *  2. "How did you hear about us?" was hardcoded to always answer
 *     "LinkedIn", ignoring the ProfileEditor's own dropdown for it.
 *
 *   node test/eligibility-extra.spec.mjs
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.ZAPPLY_EXT || join(ROOT, "extension");

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${detail && !pass ? `\n         ${detail}` : ""}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium",
  args: ["--no-sandbox"],
});

async function fill(profile, { responses = [] } = {}) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.addInitScript(({ profile, responses }) => {
    window.__ZAPPLY_TEST = true;
    window.__queued = [];
    const session = {
      profile, profiles: [profile], responses,
      premium: false,
      settings: {
        showOverlay: false, reuseSavedResponses: true, fillDelayMs: 0,
        trackAutomatically: false, eeoFallbackDecline: false,
      },
    };
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(m, cb) {
          if (m?.type === "ZAPPLY_QUEUE_RESPONSES") window.__queued.push(...(m.responses || []));
          if (m?.type === "ZAPPLY_HOLD_ANSWERS") window.__queued.push(...(m.items || []));
          const r = m?.type === "ZAPPLY_GET_SESSION" ? { ok: true, data: session }
            : m?.type === "ZAPPLY_CHECK" ? { ok: true, data: { duplicate: false } }
            : { ok: true, data: {} };
          setTimeout(() => cb && cb(r), 0);
        },
        onMessage: { addListener() {} },
      },
    };
  }, { profile, responses });
  await page.goto(pathToFileURL(join(ROOT, "test/fixtures/eligibility-extra.html")).href);
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  await page.waitForTimeout(250);
  await page.evaluate(async () => await window.__zapply.run({ manual: true }));
  await page.waitForTimeout(500);
  return page;
}

const BASE = {
  _id: "p1", label: "Default",
  personal: { firstName: "Madhu", lastName: "Kumar", email: "madhu.ittech@gmail.com" },
  workAuth: { authorizedToWork: "Yes", requireSponsorship: "No", over18: "Yes", previouslyEmployedHere: "No" },
  eeo: {}, education: [], experience: [], documents: [],
};

/* --- 1. every shift/schedule question answered from the profile --- */
{
  const page = await fill({
    ...BASE,
    workAuth: {
      ...BASE.workAuth,
      willingToWorkOvertime: "No",
      willingToWorkSaturdays: "Yes",
      willingToWorkSundays: "Yes",
      willingToWorkEvenings: "No",
      willingToTravel: "Yes",
      willingToRelocate: "No",
      howDidYouHear: "Indeed",
    },
  });
  const v = (id) => page.inputValue("#" + id);

  check("over 40 hours a week → No", (await v("q1")) === "No", `got "${await v("q1")}"`);
  check("work Saturdays → Yes", (await v("q2")) === "Yes", `got "${await v("q2")}"`);
  check("work Sundays → Yes", (await v("q3")) === "Yes", `got "${await v("q3")}"`);
  check("evening shifts → No", (await v("q4")) === "No", `got "${await v("q4")}"`);
  check("willing to travel → Yes", (await v("q5")) === "Yes", `got "${await v("q5")}"`);
  check("willing to relocate → No", (await v("q6")) === "No", `got "${await v("q6")}"`);
  check(
    "weekends derived as Yes (Saturday and Sunday agree)",
    (await v("q7")) === "Yes",
    `got "${await v("q7")}"`
  );
  check(
    "how did you hear → the profile's own choice (Indeed), not hardcoded LinkedIn",
    (await v("q8")) === "Indeed",
    `got "${await v("q8")}"`
  );
  await page.close();
}

/* --- 2. nothing is invented when the profile is silent, even with a saved
   answer banked from a different application for the exact same question --- */
{
  const page = await fill(
    { ...BASE, workAuth: { ...BASE.workAuth } },
    {
      responses: [
        { question: "Are you willing to work over 40 hours a week?", answer: "No" },
        { question: "Are you willing to work Saturdays?", answer: "Yes" },
      ],
    }
  );
  const v = (id) => page.inputValue("#" + id);
  for (const [id, label] of [
    ["q1", "over 40 hours a week"], ["q2", "Saturdays"], ["q3", "Sundays"],
    ["q4", "evening shifts"], ["q5", "travel"],
  ]) {
    check(
      `${label} is left blank when the profile has no answer (a stale saved answer is not replayed)`,
      (await v(id)) === "",
      `got "${await v(id)}"`
    );
  }
  await page.close();
}

/* --- 3. weekends is left blank when Saturday and Sunday genuinely differ --- */
{
  const page = await fill({
    ...BASE,
    workAuth: { ...BASE.workAuth, willingToWorkSaturdays: "Yes", willingToWorkSundays: "No" },
  });
  const v = (id) => page.inputValue("#" + id);
  check(
    "weekends left blank when Saturday and Sunday disagree",
    (await v("q7")) === "",
    `got "${await v("q7")}"`
  );
  await page.close();
}

/* --- 4. how did you hear falls back to LinkedIn only when the profile hasn't set a source --- */
{
  const page = await fill({ ...BASE, workAuth: { ...BASE.workAuth } });
  const v = (id) => page.inputValue("#" + id);
  check("how did you hear defaults to LinkedIn when unset", (await v("q8")) === "LinkedIn", `got "${await v("q8")}"`);
  await page.close();
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
