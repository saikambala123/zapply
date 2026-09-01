/**
 * The opt-in switches.
 *
 *   node test/settings.spec.mjs
 *
 * Three of Zapply's settings let it write something the applicant did not
 * state: replacing an answer already in the form, attaching a résumé, and
 * answering a voluntary-disclosure question with "decline". All three are off
 * by default. This checks both halves of each: nothing happens when the switch
 * is off, and the intended thing happens when it is on.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "extension");

const BASE_PROFILE = {
  _id: "p1", label: "Default",
  personal: { firstName: "Madhu", lastName: "Kumar", email: "madhu.ittech@gmail.com", country: "United States" },
  workAuth: {},
  eeo: {},                       // deliberately empty: nothing to disclose from
  experience: [], education: [],
  documents: [{
    kind: "resume", isDefault: true, name: "madhu-resume.pdf", mimeType: "application/pdf",
    dataUrl: "data:application/pdf;base64,JVBERi0xLjQKJcOkw7zDtsOfCjEgMCBvYmoKPDwvVHlwZS9DYXRhbG9nPj4KZW5kb2JqCg==",
  }],
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

/** Runs one fill with the given settings and returns a reader for the page. */
async function fill({ settings = {}, profile = BASE_PROFILE, responses = [], prefill = {} } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", () => {});
  await page.addInitScript(({ profile, responses, settings }) => {
    window.__ZAPPLY_TEST = true;
    const session = {
      profile, profiles: [profile], responses, premium: false,
      settings: { showOverlay: false, fillDelayMs: 0, trackAutomatically: false, ...settings },
    };
    window.chrome = { runtime: { lastError: null,
      sendMessage(m, cb) {
        const r = m?.type === "ZAPPLY_GET_SESSION" ? { ok: true, data: session } : { ok: true, data: {} };
        setTimeout(() => cb && cb(r), 0);
      },
      onMessage: { addListener() {} } } };
  }, { profile, responses, settings });

  await page.goto(pathToFileURL(join(ROOT, "test/fixtures/forms.html")).href);
  for (const f of ["lib/field-map.js", "lib/matcher.js", "lib/ats.js", "content/autofill.js"]) {
    await page.addScriptTag({ content: await readFile(join(EXT, f), "utf8") });
  }
  if (Object.keys(prefill).length) {
    await page.evaluate((values) => {
      for (const [id, value] of Object.entries(values)) {
        const el = document.getElementById(id);
        if (el) el.value = value;
      }
    }, prefill);
  }
  await page.evaluate(() => window.__zapply.run({ manual: true }));

  return {
    read: (id) => page.evaluate((sel) => {
      const el = document.getElementById(sel);
      if (!el) return null;
      if (el.tagName === "SELECT") return el.value;
      if (el.tagName === "BUTTON") return el.getAttribute("aria-valuetext") || "";
      return el.value;
    }, id),
    files: () => page.evaluate(() => document.getElementById("resume").files.length),
    close: () => page.close(),
  };
}

/* ---------------- autoAttachResume ---------------- */
let run = await fill({});
check("resume not attached by default", (await run.files()) === 0);
await run.close();

run = await fill({ settings: { autoAttachResume: true } });
check("resume attached when the setting is on", (await run.files()) === 1);
await run.close();

/* ---------------- eeoFallbackDecline ---------------- */
run = await fill({});
check("empty EEO profile leaves gender blank by default", (await run.read("gender")) === "", `= ${await run.read("gender")}`);
check("empty EEO profile leaves ethnicity blank by default", (await run.read("ethnicity")) === "", `= ${await run.read("ethnicity")}`);
check("empty EEO profile leaves disability blank by default", (await run.read("disability")) === "", `= ${await run.read("disability")}`);
await run.close();

run = await fill({ settings: { eeoFallbackDecline: true } });
check("gender declines when the setting is on", (await run.read("gender")) === "Not Declared", `= ${await run.read("gender")}`);
check("ethnicity declines when the setting is on", (await run.read("ethnicity")) === "Decline to Self-Identify", `= ${await run.read("ethnicity")}`);
check("disability declines when the setting is on", (await run.read("disability")) === "I do not want to answer", `= ${await run.read("disability")}`);
await run.close();

/* ---------------- overwriteExisting ---------------- */
run = await fill({ prefill: { firstName: "Wrong Name", email: "stale@example.com" } });
check("an answer already in the form is left alone", (await run.read("firstName")) === "Wrong Name", `= ${await run.read("firstName")}`);
check("a stale email already in the form is left alone", (await run.read("email")) === "stale@example.com", `= ${await run.read("email")}`);
await run.close();

run = await fill({ settings: { overwriteExisting: true }, prefill: { firstName: "Wrong Name" } });
check("existing answers are corrected when the setting is on", (await run.read("firstName")) === "Madhu", `= ${await run.read("firstName")}`);
await run.close();

/* ---------------- reuseSavedResponses ---------------- */
const SAVED = [{ question: "What is your notice period?", normalizedKey: "notice period", answer: "2 weeks", aliases: [] }];

run = await fill({ responses: SAVED });
check("saved answers are used by default", (await run.read("noticeperiod")) === "2 weeks", `= ${await run.read("noticeperiod")}`);
await run.close();

run = await fill({ responses: SAVED, settings: { reuseSavedResponses: false } });
check("saved answers are skipped when the setting is off", (await run.read("noticeperiod")) === "", `= ${await run.read("noticeperiod")}`);
await run.close();

/* ---------------- a saved answer outranks the profile ---------------- */
run = await fill({
  profile: { ...BASE_PROFILE, personal: { ...BASE_PROFILE.personal, city: "Lisle" } },
  responses: [{ question: "City", normalizedKey: "city", answer: "Naperville", aliases: [] }],
});
check(
  "an exact saved answer beats the profile value",
  (await run.read("city")) === "Naperville",
  `city = ${await run.read("city")}`
);
await run.close();

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
