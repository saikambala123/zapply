/**
 * Greenhouse's react-select dropdowns: the question, and the school typeahead.
 *
 *   node test/greenhouse-select.spec.mjs
 *
 * Two reports, both on job-boards.greenhouse.io:
 *
 *   1. Answering a dropdown by hand banked the answer under the question
 *      "option No, selected." — which is react-select's own screen-reader
 *      announcement, not a question. The real question was 381 characters, over
 *      the 300-character ceiling every candidate had to pass, so it was thrown
 *      away and the announcement was the next thing that fit.
 *
 *   2. The Education block's School picker fetches its list remotely and shows
 *      nothing until something is typed, so it was left on "Select...".
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.ZAPPLY_EXT || join(ROOT, "extension");

const LONG_QUESTION =
  "If hired by StackAdapt, do you intend to hold any secondary employment, advisory " +
  "position (e.g. membership on a board of directors), or volunteer position that (1) is " +
  "on behalf of a business that would be competitive in nature to the business of " +
  "StackAdapt, (2) conflict with your ability to perform your duties at StackAdapt, or " +
  "(3) conflict with your working hours at StackAdapt?";

const PROFILE = {
  _id: "p1", label: "Default",
  personal: { firstName: "Pradeep", lastName: "Beeram", email: "pradeep@example.com" },
  workAuth: {}, eeo: {}, experience: [],
  education: [{ school: "Osmania University", degree: "Master's Degree", fieldOfStudy: "Computer Science" }],
  documents: [],
};

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${detail && !pass ? `\n         ${detail}` : ""}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
page.on("pageerror", (e) => console.log("  page error:", e.message));
if (process.env.FXLOG) page.on("console", (m) => { if (m.text().startsWith("[fx]")) console.log("   ", m.text()); });

await page.addInitScript(({ profile }) => {
  window.__ZAPPLY_TEST = true;
  window.__queued = [];
  const session = {
    profile, profiles: [profile], responses: [], premium: false,
    settings: { showOverlay: false, reuseSavedResponses: true, fillDelayMs: 0, trackAutomatically: false },
  };
  window.chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        if (msg?.type === "ZAPPLY_QUEUE_RESPONSES") window.__queued.push(...(msg.responses || []));
        if (msg?.type === "ZAPPLY_HOLD_ANSWERS") window.__queued.push(...(msg.items || []));
        const r = msg?.type === "ZAPPLY_GET_SESSION" ? { ok: true, data: session }
          : msg?.type === "ZAPPLY_CHECK" ? { ok: true, data: { duplicate: false } }
          : { ok: true, data: {} };
        setTimeout(() => cb && cb(r), 0);
      },
      onMessage: { addListener() {} },
    },
  };
}, { profile: PROFILE });

const LAG = process.env.LAG || "450";
await page.goto(`${pathToFileURL(join(ROOT, "test/fixtures/greenhouse-select.html")).href}?lag=${LAG}`);
for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
  await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
}
await page.waitForTimeout(400);

/* ---------- 1. answer the long dropdown question by hand ---------- */
await page.click('[data-rs="secondary"] .select__control');
await page.waitForTimeout(200);
await page.click('[data-rs="secondary"] .select__option:has-text("No")');
await page.waitForTimeout(400);
await page.click("h1");
await page.waitForTimeout(300);

/* ---------- 2. and the short one ---------- */
await page.click('[data-rs="worked-before"] .select__control');
await page.waitForTimeout(200);
await page.click('[data-rs="worked-before"] .select__option:has-text("No")');
await page.waitForTimeout(400);
await page.click("h1");
await page.waitForTimeout(300);

const held = await page.evaluate(() => window.__queued.slice());
console.log("\n  captured:", JSON.stringify(held, null, 2).slice(0, 900), "\n");

const longOne = held.find((h) => /secondary employment/i.test(h.question || ""));
const shortOne = held.find((h) => /previously worked/i.test(h.question || ""));
const announcement = held.find((h) => /option .*, ?selected|results available/i.test(h.question || ""));

check("the long question is captured as the question, not dropped",
  Boolean(longOne), `captured questions: ${held.map((h) => JSON.stringify(h.question)).join(", ")}`);
check("no screen-reader announcement is stored as a question",
  !announcement, `stored: ${announcement?.question}`);
check("the long question keeps its wording", Boolean(longOne) && longOne.question.startsWith("If hired by StackAdapt"),
  `${longOne?.question}`);
check("the long question's answer is the chosen option", longOne?.answer === "No", `answer: ${longOne?.answer}`);
check("the short question is captured too", Boolean(shortOne), `${held.map((h) => h.question).join(" / ")}`);
check("the short question's answer is the chosen option", shortOne?.answer === "No", `answer: ${shortOne?.answer}`);

/* ---------- 3. the same long-question problem on other control types ---------- */
await page.click('[data-rs="relocate"] input[value="Yes"]');
await page.waitForTimeout(400);
await page.click('[data-rs="ack"] input[value="Accurate"]');
await page.waitForTimeout(500);
await page.click("h1");
await page.waitForTimeout(300);

const all = await page.evaluate(() => window.__queued.slice());
const radio = all.find((h) => /willing to relocate/i.test(h.question || ""));
const checks = all.find((h) => /information you have provided/i.test(h.question || ""));
const anyNoise = all.find((h) => /option .*, ?selected|results available/i.test(h.question || ""));

check("a long question on a radio group is captured", Boolean(radio),
  `questions: ${all.map((h) => (h.question || "").slice(0, 40)).join(" / ")}`);
check("the radio group reports its type", radio?.inputType === "radio", `type: ${radio?.inputType}`);
check("the radio group's answer is the chosen option", radio?.answer === "Yes", `answer: ${radio?.answer}`);
check("a long question on a checkbox group is captured", Boolean(checks),
  `questions: ${all.map((h) => (h.question || "").slice(0, 40)).join(" / ")}`);
check("the checkbox group reports its type", checks?.inputType === "checkbox", `type: ${checks?.inputType}`);
check("no announcement reaches any control type", !anyNoise, `stored: ${anyNoise?.question}`);

/* ---------- 4. now press Fill and see whether School is answered ---------- */
await page.goto(`${pathToFileURL(join(ROOT, "test/fixtures/greenhouse-select.html")).href}?lag=${LAG}`);
for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
  await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
}
await page.waitForTimeout(400);

const started = Date.now();
await page.evaluate(async () => await window.__zapply.run({ manual: true }));
await page.waitForTimeout(2500);
const elapsed = Date.now() - started;

const shown = await page.evaluate(() => window.__shown());
const typed = await page.evaluate(() => window.__schoolQueries.slice());
const raw = await page.evaluate(() => window.__typed.slice());
console.log("  raw keystrokes into the school box:", JSON.stringify(raw));
console.log("  dropdowns now hold:", JSON.stringify(shown));
console.log("  school list was queried with:", JSON.stringify(typed), "\n");

check("School is filled from the profile", shown.school === "Osmania University", `school shows ${JSON.stringify(shown.school)}`);
check("the school typeahead was actually searched", typed.some((q) => q && q.length > 1), `queries: ${JSON.stringify(typed)}`);
check("Degree is filled from the profile", shown.degree === "Master's Degree", `degree shows ${JSON.stringify(shown.degree)}`);
check("the fill does not hang", elapsed < 20000, `${(elapsed / 1000).toFixed(1)}s`);

await browser.close();
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed\n`);
process.exit(passed === results.length ? 0 : 1);
