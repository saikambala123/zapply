/**
 * Work eligibility, EEO, and what happens when the profile has no answer.
 *
 *   node test/eligibility.spec.mjs
 *
 * The reported bug: sponsorship questions were being answered wrongly. Half of
 * them are asked the other way round — "Will you require sponsorship?" and "Are
 * you able to work without sponsorship?" want opposite answers from the same
 * fact — and the stored value was written into both. An applicant who needs no
 * sponsorship was therefore telling employers, on the second phrasing, that they
 * could not work without it. That answer is disqualifying, and it is wrong.
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

async function fill(profile, settings = {}) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.addInitScript(({ profile, settings }) => {
    window.__ZAPPLY_TEST = true;
    window.__queued = [];
    const session = {
      profile, profiles: [profile], responses: [], premium: false,
      settings: {
        showOverlay: false, reuseSavedResponses: true, fillDelayMs: 0,
        trackAutomatically: false, eeoFallbackDecline: false, ...settings,
      },
    };
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(m, cb) {
          if (m?.type === "ZAPPLY_QUEUE_RESPONSES") window.__queued.push(...(m.responses || []));
          const r = m?.type === "ZAPPLY_GET_SESSION" ? { ok: true, data: session }
            : m?.type === "ZAPPLY_CHECK" ? { ok: true, data: { duplicate: false } }
            : { ok: true, data: {} };
          setTimeout(() => cb && cb(r), 0);
        },
        onMessage: { addListener() {} },
      },
    };
  }, { profile, settings });
  await page.goto(pathToFileURL(join(ROOT, "test/fixtures/eligibility.html")).href);
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

/* --- 1. an applicant who needs no sponsorship --- */
{
  const page = await fill(BASE);
  const v = (id) => page.inputValue("#" + id);

  check("legally authorized to work → Yes", (await v("q1")) === "Yes", `got "${await v("q1")}"`);
  check("will you require sponsorship → No", (await v("q2")) === "No", `got "${await v("q2")}"`);
  check(
    "able to work WITHOUT sponsorship → Yes",
    (await v("q3")) === "Yes",
    `got "${await v("q3")}" — the question is the inverse of "do you require sponsorship"`
  );
  check("do you require sponsorship → No", (await v("q4")) === "No", `got "${await v("q4")}"`);
  check("at least 18 → Yes", (await v("q5")) === "Yes", `got "${await v("q5")}"`);
  check("previously employed here → No", (await v("q6")) === "No", `got "${await v("q6")}"`);

  /* --- 2. EEO stays blank when the profile has no answer --- */
  for (const [id, label] of [["e1","gender"],["e2","hispanic or latino"],["e3","race"],["e4","veteran status"],["e5","disability status"]]) {
    check(`${label} is left blank for the applicant to fill`, (await v(id)) === "", `got "${await v(id)}"`);
  }

  /* --- 3. editing a filled answer queues it for saving --- */
  const before = await page.evaluate(() => window.__queued.length);
  await page.selectOption("#q5", "No");
  await page.waitForTimeout(700);
  const queued = await page.evaluate(() => window.__queued.map((q) => ({ q: q.question, a: String(q.answer) })));
  const age = queued.filter((r) => r.q.toLowerCase().includes("18")).pop();
  check("editing an autofilled dropdown queues the new answer", age?.a === "No", JSON.stringify(queued.map((r) => `${r.q}=${r.a}`)));
  check("the fill's own answers are queued too", before > 0, `${before} queued after the fill`);
  await page.close();
}

/* --- 4. an applicant who does need sponsorship --- */
{
  const page = await fill({ ...BASE, workAuth: { ...BASE.workAuth, requireSponsorship: "Yes" } });
  const v = (id) => page.inputValue("#" + id);
  check("will you require sponsorship → Yes", (await v("q2")) === "Yes", `got "${await v("q2")}"`);
  check("able to work WITHOUT sponsorship → No", (await v("q3")) === "No", `got "${await v("q3")}"`);
  await page.close();
}

/* --- 5. nothing is invented when the profile is silent --- */
{
  const page = await fill({ ...BASE, workAuth: {} });
  const v = (id) => page.inputValue("#" + id);
  for (const id of ["q1", "q2", "q3", "q4", "q5", "q6"]) {
    check(`${id} is left blank when the profile has no answer`, (await v(id)) === "", `got "${await v(id)}"`);
  }
  await page.close();
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
