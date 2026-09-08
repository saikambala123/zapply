/**
 * The six things reported against the Dana-Farber Workday application.
 *
 *   node test/workday-danafarber.spec.mjs
 *
 *   1. CC-305 "Date" left blank — it is today's date, on every application.
 *   2. "How Did You Hear About Us?" left blank — LinkedIn sits two levels down
 *      a category tree, so nothing at the top level ever matched it.
 *   3. "Are you willing to relocate?" / "Are you 18 years or older?" left blank.
 *   4. A long question about a training programme answered "Yes" when nothing
 *      in the profile says so and the honest answer is No.
 *   5. The Terms checkbox left unticked, which blocks the whole form.
 *   6. School typed but never committed — Workday's typeahead needs Enter, and
 *      a blur without it throws the text away.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.ZAPPLY_EXT || join(ROOT, "extension");

const PROFILE = {
  _id: "p1", label: "Default",
  personal: { firstName: "Subhash", lastName: "Yala", email: "subhash@example.com", phone: "+1 555 0100" },
  workAuth: {
    authorizedToWork: "No",        // not authorised to work in the US
    requireSponsorship: "Yes",     // and will need sponsorship
    willingToRelocate: "Yes",
    over18: "Yes",
  },
  eeo: {},
  experience: [],
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
const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
page.on("pageerror", (e) => console.log("  page error:", e.message));
if (process.env.FXLOG) page.on("console", (m) => console.log("    ", m.text()));

await page.addInitScript(({ profile }) => {
  window.__ZAPPLY_TEST = true;
  window.__aiAsked = [];
  const session = {
    profile, profiles: [profile], responses: [], premium: false,
    settings: { showOverlay: false, reuseSavedResponses: true, fillDelayMs: 0, trackAutomatically: false, aiAnswers: true },
  };
  window.chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        if (msg?.type === "ZAPPLY_AI_ANSWER" || msg?.type === "ZAPPLY_AI_ANSWERS") {
          window.__aiAsked.push(msg);
          // The AI is unavailable in the test; a field it would have guessed
          // must be answered by a rule or left alone, never invented.
          setTimeout(() => cb && cb({ ok: false, error: "offline" }), 0);
          return;
        }
        const r = msg?.type === "ZAPPLY_GET_SESSION" ? { ok: true, data: session }
          : msg?.type === "ZAPPLY_CHECK" ? { ok: true, data: { duplicate: false } }
          : { ok: true, data: {} };
        setTimeout(() => cb && cb(r), 0);
      },
      onMessage: { addListener() {} },
    },
  };
}, { profile: PROFILE });

await page.goto(pathToFileURL(join(ROOT, "test/fixtures/workday-danafarber.html")).href);
for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
  await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
}
await page.waitForTimeout(400);

await page.evaluate(async () => await window.__zapply.run({ manual: true }));
await page.waitForTimeout(3000);

const s = await page.evaluate(() => window.__state());
console.log("\n  page state after fill:\n", JSON.stringify(s, null, 2), "\n");

const now = new Date();
const mm = String(now.getMonth() + 1).padStart(2, "0");
const dd = String(now.getDate()).padStart(2, "0");
const yyyy = String(now.getFullYear());

/* 1. CC-305 date */
check("the CC-305 Date is filled with today's date",
  s.date[0] === mm && s.date[1] === dd && s.date[2] === yyyy,
  `got ${JSON.stringify(s.date)}, expected ["${mm}","${dd}","${yyyy}"]`);

/* 2. How did you hear about us */
check("How Did You Hear About Us picks LinkedIn from inside the tree",
  s.source.includes("LinkedIn"), `chose ${JSON.stringify(s.source)}`);

/* 3. simple application questions */
check("'Are you willing to relocate?' is answered", s.relocate === "Yes", `got ${JSON.stringify(s.relocate)}`);
check("'Are you 18 years or older?' is answered", s.age === "Yes", `got ${JSON.stringify(s.age)}`);

/* 4. the long question must not be guessed */
check("the training-programme question is not answered Yes",
  s.cure !== "Yes", `got ${JSON.stringify(s.cure)}`);

/* 5. work authorisation pair, read from the profile */
check("work authorisation matches the profile (No)", s.workAuth === "No", `got ${JSON.stringify(s.workAuth)}`);
check("sponsorship matches the profile (Yes)", s.sponsorship === "Yes", `got ${JSON.stringify(s.sponsorship)}`);

/* 6. consent */
check("the Terms checkbox is ticked", s.agree === true, `got ${s.agree}`);

/* 7. education */
check("School or University is committed, not just typed",
  s.school === "Osmania University", `got ${JSON.stringify(s.school)}`);
check("Degree is filled", s.degree === "Master's Degree", `got ${JSON.stringify(s.degree)}`);
check("Field of Study is committed", s.fieldOfStudy === "Computer Science", `got ${JSON.stringify(s.fieldOfStudy)}`);

/* 8. self-id identity fields */
check("the CC-305 Name is the applicant's name", /Subhash/i.test(s.selfIdName), `got ${JSON.stringify(s.selfIdName)}`);
check("Employee ID is left blank", !s.employeeId, `got ${JSON.stringify(s.employeeId)}`);

await browser.close();
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed\n`);
process.exit(passed === results.length ? 0 : 1);
