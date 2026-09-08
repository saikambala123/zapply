/**
 * A Greenhouse embed that lists Education above Work Experience.
 *
 *   node test/greenhouse-full.spec.mjs
 *
 * Reported with two screenshots: a second, empty Education block the applicant
 * had to delete, and screening dropdowns left on "Select...".
 *
 * Both came from the same place. The "Add another" buttons on a Greenhouse
 * embed are direct children of the form, and the kind of row they add was
 * decided from the button's text plus the visible text of its *grandparent* —
 * which is the whole page, containing "Education" and "Work Experience" both.
 * The test passed for whichever section was asked about, so `find` took the
 * first add-looking button in the document. With Education listed first that is
 * the wrong one twice: the experience pass clicked "Add another education", and
 * the Work Experience rows it existed to create were never created, so every
 * role after the first went unfilled.
 *
 * The third failure is separate. A field's label carries the heading of the
 * section it sits under, which is what lets a box labelled only "Company" be
 * read as work history. "Which Scout Motors location are you closest to?" sits
 * in Additional Information, below the last heading the walk can find, so it
 * inherited "Work Experience", matched the work-history Location rule, and was
 * answered from a job's city instead of the applicant's saved answer.
 *
 * Against the previous build: 2 Education blocks, 1 Work Experience block,
 * q2 left on "Select...".
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.ZAPPLY_EXT || join(ROOT, "extension");
const PROFILE = {
  _id: "p1", label: "D",
  personal: { firstName: "Madhu", lastName: "Kumar", email: "m@x.com", city: "Jacksonville", state: "Florida" },
  websites: {}, workAuth: { authorizedToWork: "Yes" }, eeo: {},
  experience: [
    { title: "Senior DevOps Engineer", company: "Northern Trust", startDate: "2022-03", endDate: "2025-01", current: false },
    { title: "DevOps Engineer", company: "One Trust LLC", startDate: "2021-06", endDate: "2022-02", current: false },
    { title: "Cloud Engineer", company: "Cognizant", startDate: "2019-01", endDate: "2021-05", current: false },
    { title: "Data Engineer", company: "Lenora Systems", startDate: "2017-01", endDate: "2018-06", current: false },
  ],
  education: [{ school: "Auburn University", degree: "Master's Degree", fieldOfStudy: "Computer Science" }],
  documents: [],
};
const SAVED = [
  { question: "This role is based out of the Scout Motors headquarters in Charlotte, North Carolina. Employees must live within 60 miles of the site for commuting. Please select the option that best describes your current situation:",
    answer: "I am willing to relocate within 3-6 months of my start date" },
  { question: "Which Scout Motors location are you closest to?", answer: "I do not live near a Scout Motors location" },
];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
page.on("pageerror", (e) => console.log("page error:", e.message));
await page.addInitScript(({ profile, saved }) => {
  window.__SAVED = saved;
  window.__ZAPPLY_TEST = true;
  const session = { profile, profiles: [profile], responses: window.__SAVED, premium: false,
    settings: { showOverlay: false, reuseSavedResponses: true, fillDelayMs: 0, trackAutomatically: false } };
  window.chrome = { runtime: { lastError: null, sendMessage(m, cb) {
    const r = m?.type === "ZAPPLY_GET_SESSION" ? { ok: true, data: session }
      : m?.type === "ZAPPLY_CHECK" ? { ok: true, data: { duplicate: false } } : { ok: true, data: {} };
    setTimeout(() => cb && cb(r), 0);
  }, onMessage: { addListener() {} } } };
}, { profile: PROFILE, saved: SAVED });
await page.goto(pathToFileURL(join(ROOT, "test/fixtures/greenhouse-full.html")).href + (process.env.ASYNC ? "?async=" + process.env.ASYNC : ""));
for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"])
  await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
await page.waitForTimeout(250);
const t0 = Date.now();
await page.evaluate(async () => await window.__zapply.run({ manual: true }));
const elapsed = Date.now() - t0;
await page.waitForTimeout(400);
const out = await page.evaluate(() => {
  const txt = (id) => { const n = document.getElementById(id); return n ? (n.dataset.value ?? n.textContent.trim()) : null; };
  const val = (id) => document.getElementById(id)?.value ?? null;
  return {
    eduBlocks: document.querySelectorAll(".edu-block").length,
    expBlocks: document.querySelectorAll(".exp-block").length,
    addEdu: window.__addEduClicks, addExp: window.__addExpClicks,
    school: txt("s1"), degree: txt("d1"), discipline: txt("p1"),
    q1: txt("q1"), q2: txt("q2"), state: txt("st"), city: val("city"),
    auth: [...document.querySelectorAll('input[name="auth"]')].filter((r) => r.checked).map((r) => r.value),
    company1: val("c1"), title1: val("t1"), company2: val("c2"),
  };
});

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${detail && !pass ? `\n         ${detail}` : ""}`);
};

console.log("\nrepeat sections are added to the right section");
check("one education entry leaves one education block", out.eduBlocks === 1, `${out.eduBlocks} blocks, ${out.addEdu} Add clicks`);
check("no 'Add another education' click at all", out.addEdu === 0, `${out.addEdu} clicks`);
check("four roles get four work experience blocks", out.expBlocks === 4, `${out.expBlocks} blocks, ${out.addExp} Add clicks`);
check("and the second role is actually filled", out.company2 === "One Trust LLC", `= ${JSON.stringify(out.company2)}`);

console.log("\nthe education comboboxes are answered from the profile");
check("school", out.school === "Auburn University", `= ${JSON.stringify(out.school)}`);
check("degree", out.degree === "Master's Degree", `= ${JSON.stringify(out.degree)}`);
check("discipline", out.discipline === "Computer Science", `= ${JSON.stringify(out.discipline)}`);

console.log("\nscreening dropdowns take the applicant's saved answer");
check("the long relocation question", out.q1 === "I am willing to relocate within 3-6 months of my start date", `= ${JSON.stringify(out.q1)}`);
check(
  "a question that merely contains the word 'location'",
  out.q2 === "I do not live near a Scout Motors location",
  `= ${JSON.stringify(out.q2)} — inheriting the Work Experience heading made this a work-history Location box`
);

console.log("\nthe rest of the form still fills from the profile");
check("current city", out.city === "Jacksonville", `= ${JSON.stringify(out.city)}`);
check("state of residence", out.state === "Florida", `= ${JSON.stringify(out.state)}`);
check("work authorisation radio", out.auth.join() === "Yes", JSON.stringify(out.auth));
check("first role", out.company1 === "Northern Trust" && out.title1 === "Senior DevOps Engineer", JSON.stringify([out.company1, out.title1]));

await browser.close();

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed ? 1 : 0);
