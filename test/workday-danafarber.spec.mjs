/**
 * Regressions from a Dana-Farber Workday application (wd5.myworkdayjobs.com).
 *
 * Every case here was observed on a real form and photographed:
 *
 *   1. CC-305 "Voluntary Self-Identification of Disability" — the Name box and
 *      the Date box were both left empty. The rules gate on the CC-305 heading
 *      appearing in the derived label, and Workday renders that heading too far
 *      from the three boxes for deriveLabel to reach it, so the derived label
 *      for the date field is the bare word "Date".
 *
 *   2. "Are you currently authorized to work in the United States?" answered
 *      "No" and "Do you now, or will you in the future, require visa
 *      sponsorship…" answered "Yes" — both inverted. Four phrasings of these
 *      two questions matched no rule at all and fell through to saved answers
 *      and then to the model.
 *
 *   3. "Do you have a High School Diploma or GED?" was claimed by the `school`
 *      rule, because it contains the word "School", and the applicant's
 *      university name was written at a Yes/No dropdown.
 *
 *   4. "How Did You Hear About Us?" left empty. It is a hierarchical prompt:
 *      LinkedIn sits one level inside "Social Media".
 *
 *   5. "I agree to the Terms … and our Privacy Policy" was never planned, so
 *      Create Account stopped with "Error: Please check the box to continue".
 *
 *   6. Education "School or University" left empty — a search prompt whose list
 *      does not contain the applicant's school.
 *
 * Pure Node: no browser, no Playwright. Rule-table behaviour only.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, "..", "extension");

/* ------------------------------------------------------------------ */
/*  A DOM stub just deep enough for the rule table                     */
/* ------------------------------------------------------------------ */

/**
 * `inSelfIdBlock` walks parentElement looking for the CC-305 wording, so the
 * stub has to support ancestry and textContent. Everything else the matcher
 * touches is guarded with optional chaining or try/catch.
 */
function makeElement({ type = "text", attrs = {}, parent = null, text = "" } = {}) {
  const el = {
    tagName: type === "textarea" ? "TEXTAREA" : type === "select" ? "SELECT" : "INPUT",
    type,
    isContentEditable: false,
    textContent: text,
    parentElement: parent,
    getAttribute: (k) => (k === "type" ? type : attrs[k] ?? null),
    closest: (sel) => {
      // Only the data-automation-id form is used by the rules under test.
      let node = el;
      while (node) {
        const id = node.getAttribute?.("data-automation-id");
        if (id && /selfIdentification|disability|voluntaryDisclosure/i.test(id) &&
            /selfIdentification|disability|voluntaryDisclosure/i.test(sel)) {
          return node;
        }
        node = node.parentElement;
      }
      return null;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return el;
}

/** An ancestor chain whose top node carries the CC-305 preamble text. */
function selfIdBlock(field) {
  const outer = {
    tagName: "DIV",
    textContent:
      "Voluntary Self-Identification of Disability Form CC-305 OMB Control Number 1250-0005 " +
      "Expires 04/30/2026 Why are you being asked to complete this form?",
    parentElement: null,
    getAttribute: () => null,
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  field.parentElement = outer;
  return field;
}

const sandbox = {
  document: {
    body: { tagName: "BODY" },
    documentElement: { tagName: "HTML" },
    addEventListener() {},
    querySelectorAll: () => [],
    getElementById: () => null,
  },
  setTimeout,
  clearTimeout,
  console,
  HTMLInputElement: class {},
  HTMLTextAreaElement: class {},
  HTMLSelectElement: class {},
  Event: class { constructor(t) { this.type = t; } },
  KeyboardEvent: class {},
  MouseEvent: class {},
  FocusEvent: class {},
  CSS: { escape: (s) => s },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(path.join(EXT, "lib", "matcher.js"), "utf8"), sandbox);
vm.runInContext(readFileSync(path.join(EXT, "lib", "field-map.js"), "utf8"), sandbox);

const M = sandbox.ZAPPLY_MATCHER;
const RULES = sandbox.ZAPPLY_FIELD_MAP;

/* ------------------------------------------------------------------ */
/*  Harness                                                            */
/* ------------------------------------------------------------------ */

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return;
  failures++;
  console.error(`  FAIL  ${name}\n        expected ${e}\n        actual   ${a}`);
}

const PROFILE = {
  personal: { firstName: "Subhash", lastName: "Yala", fullName: "Subhash Yala" },
  workAuth: { authorizedToWork: "Yes", requireSponsorship: "No" },
  education: [
    { school: "Wichita State University", degree: "Master's Degree", fieldOfStudy: "Computer Science" },
  ],
};

function plan(label, el = makeElement({ type: "select" })) {
  const rule = M.matchRule(el, label, RULES);
  if (!rule) return { key: null, value: null, rule: null };
  let value = null;
  try { value = rule.value(PROFILE, el, label, 0); } catch { value = null; }
  return { key: rule.key, value, rule };
}

/* ------------------------------------------------------------------ */
/*  1. CC-305 — Name and Date, from the DOM rather than the label      */
/* ------------------------------------------------------------------ */

const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const TODAY_SLASH = `${pad(now.getMonth() + 1)}/${pad(now.getDate())}/${now.getFullYear()}`;
const TODAY_DASH = `${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${now.getFullYear()}`;
const TODAY_ISO = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const TODAY_DMY = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;

console.log("CC-305 block detected from the DOM, not the derived label");
{
  // Exactly what Workday gives us: the field's own label is the bare word.
  const dateBox = selfIdBlock(makeElement({ attrs: { placeholder: "MM/DD/YYYY" } }));
  check("bare 'Date' inside a CC-305 block matches selfIdDate", plan("Date", dateBox).key, "selfIdDate");
  check("…and is filled with today", plan("Date", dateBox).value, TODAY_SLASH);

  const nameBox = selfIdBlock(makeElement({ type: "text" }));
  check("bare 'Name' inside a CC-305 block matches selfIdName", plan("Name", nameBox).key, "selfIdName");
  check("…and is filled with the applicant's name", plan("Name", nameBox).value, "Subhash Yala");

  // The Workday wrapper names itself, which is the faster path.
  const named = makeElement({ attrs: { "data-automation-id": "selfIdentificationDate", placeholder: "MM/DD/YYYY" } });
  check("a wrapper named for self-identification is enough", plan("Date", named).key, "selfIdDate");
}

console.log("a bare Date outside a self-ID block is still left alone");
{
  const loose = makeElement({ attrs: { placeholder: "MM/DD/YYYY" } });
  check("bare 'Date' with no CC-305 context", plan("Date", loose).key, null);
  check("Graduation Date is not today", plan("Graduation Date", loose).key !== "selfIdDate", true);
  check("Employment Start Date is not today", plan("Employment Start Date", loose).key !== "selfIdDate", true);
}

/* ------------------------------------------------------------------ */
/*  1b. Today, in the format the control asks for                      */
/* ------------------------------------------------------------------ */

console.log("today is written in the format the control advertises");
{
  const inBlock = (attrs, type = "text") => selfIdBlock(makeElement({ type, attrs }));
  check("MM/DD/YYYY placeholder", plan("Date", inBlock({ placeholder: "MM/DD/YYYY" })).value, TODAY_SLASH);
  check("MM-DD-YYYY placeholder", plan("Date", inBlock({ placeholder: "MM-DD-YYYY" })).value, TODAY_DASH);
  check("DD/MM/YYYY placeholder", plan("Date", inBlock({ placeholder: "DD/MM/YYYY" })).value, TODAY_DMY);
  check("YYYY-MM-DD placeholder", plan("Date", inBlock({ placeholder: "YYYY-MM-DD" })).value, TODAY_ISO);
  check("aria-label carries the pattern", plan("Date", inBlock({ "aria-label": "Date MM-DD-YYYY" })).value, TODAY_DASH);
  check("native date input is always ISO", plan("Date", inBlock({}, "date")).value, TODAY_ISO);
  check("no hint at all falls back to US order", plan("Date", inBlock({})).value, TODAY_SLASH);
}

/* ------------------------------------------------------------------ */
/*  2. Work authorisation and sponsorship                              */
/* ------------------------------------------------------------------ */

console.log("every work-eligibility phrasing reaches a rule");
{
  // Profile: authorised to work, needs no sponsorship.
  const cases = [
    // [label, expected key, expected answer]
    ["Are you currently authorized to work in the United States?", "authorizedToWork", "Yes"],
    ["Are you legally authorized to work in the United States?", "authorizedToWork", "Yes"],
    ["Do you now, or will you in the future, require visa sponsorship to work in the United States?", "requireSponsorship", "No"],
    ["Will you now or in the future require sponsorship for employment visa status?", "requireSponsorship", "No"],

    // The four that matched nothing before this fix.
    ["Are you legally authorized to work in the United States without sponsorship?", "requireSponsorship", "Yes"],
    ["Are you legally authorized to work in the U.S. without company sponsorship?", "requireSponsorship", "Yes"],
    ["Visa Sponsorship Required?", "requireSponsorship", "No"],
    ["Sponsorship Required", "requireSponsorship", "No"],

    // \brequire\b does not match "Required"; \bneed\b does not match "Needed".
    ["Sponsorship Needed", "requireSponsorship", "No"],
    ["Will you require employer sponsorship to secure a work visa?", "requireSponsorship", "No"],
    ["Are you able to work in the United States without sponsorship now or in the future?", "requireSponsorship", "Yes"],
  ];
  for (const [label, key, answer] of cases) {
    check(`key   — ${label}`, plan(label).key, key);
    check(`value — ${label}`, plan(label).value, answer);
  }
}

console.log("a candidate who does need sponsorship gets the opposite answers");
{
  const needs = {
    ...PROFILE,
    workAuth: { authorizedToWork: "Yes", requireSponsorship: "Yes" },
  };
  const answer = (label) => {
    const el = makeElement({ type: "select" });
    const rule = M.matchRule(el, label, RULES);
    return rule ? rule.value(needs, el, label, 0) : null;
  };
  check("requires sponsorship — plain phrasing", answer("Do you require visa sponsorship?"), "Yes");
  check("requires sponsorship — inverted phrasing", answer("Can you work without sponsorship?"), "No");
}

console.log("work-eligibility questions are never answered from an empty profile");
{
  const blank = { personal: {}, workAuth: {}, education: [] };
  const answer = (label) => {
    const el = makeElement({ type: "select" });
    const rule = M.matchRule(el, label, RULES);
    if (!rule) return { key: null, value: null, profileOnly: false };
    let v = null;
    try { v = rule.value(blank, el, label, 0); } catch { v = null; }
    return { key: rule.key, value: v, profileOnly: Boolean(rule.profileOnly) };
  };
  for (const label of [
    "Are you currently authorized to work in the United States?",
    "Do you require visa sponsorship?",
    "Visa Sponsorship Required?",
  ]) {
    const r = answer(label);
    check(`no invented answer — ${label}`, r.value ?? null, null);
    check(`profileOnly, so no saved answer or model — ${label}`, r.profileOnly, true);
  }
}

console.log("the catch-all does not claim fields that merely mention a visa");
{
  const text = () => makeElement({ type: "text" });
  check("Passport Number", plan("Passport Number", text()).key, null);
  check("Upload a copy of your visa", plan("Upload a copy of your visa", text()).key, null);
  check("Have you ever had a visa denied?", plan("Have you ever had a visa denied?", text()).key, null);
  check("Visa expiry date", plan("Visa expiry date", text()).key, null);
  check("First Name still matches firstName", plan("First Name", text()).key, "firstName");
}

/* ------------------------------------------------------------------ */
/*  3. The diploma question is not a school name box                   */
/* ------------------------------------------------------------------ */

console.log("a Yes/No diploma question is not answered with a university name");
{
  check("High School Diploma or GED — key", plan("Do you have a High School Diploma or GED?").key, "highSchoolDiploma");
  check("High School Diploma or GED — value", plan("Do you have a High School Diploma or GED?").value, "Yes");
  check("a Master's implies secondary education", plan("Do you have a GED?").value, "Yes");

  // The real school box still works.
  check("School or University — key", plan("School or University").key, "school");
  check("School or University — value", plan("School or University").value, "Wichita State University");

  // …and answers nothing when the profile has no education.
  const noEducation = { ...PROFILE, education: [] };
  const el = makeElement({ type: "select" });
  const rule = M.matchRule(el, "Do you have a High School Diploma or GED?", RULES);
  check("no education recorded — no claim about a diploma", rule.value(noEducation, el, "", 0), null);
}

/* ------------------------------------------------------------------ */
/*  4. How Did You Hear About Us                                       */
/* ------------------------------------------------------------------ */

console.log("How Did You Hear About Us answers LinkedIn");
{
  const r = plan("How Did You Hear About Us?");
  check("matches howDidYouHear", r.key, "howDidYouHear");
  check("answers LinkedIn", r.value, "LinkedIn");

  // The synonym ladder is the fallback for portals that only offer categories,
  // and its order is the preference order: LinkedIn, then a professional or
  // social network, then a job board.
  const synonyms = (r.rule.options?.LinkedIn ?? []).map((s) => String(s).toLowerCase());
  const at = (needle) => synonyms.findIndex((s) => s.includes(needle));
  check("linkedin is preferred over social media", at("linkedin") < at("social media"), true);
  check("social media is preferred over a job board", at("social media") < at("job board"), true);
}

/* ------------------------------------------------------------------ */
/*  5. Consent boxes                                                   */
/* ------------------------------------------------------------------ */

console.log("terms and privacy boxes are ticked; nothing else is");
{
  const box = () => makeElement({ type: "checkbox" });
  const ticks = (label) => {
    const r = plan(label, box());
    return r.key === "agreementConsent" && r.value === "Yes";
  };

  for (const label of [
    "I agree to the Terms and understand information will be used as described here and in our Privacy Policy. | I agree.",
    "I agree.",
    "I accept the Terms of Service",
    "I have read and agree to the Privacy Policy",
    "I certify that the information provided is true and complete",
    "I acknowledge and accept the privacy notice",
    "Electronic Signature Consent",
  ]) {
    check(`ticks — ${label.slice(0, 46)}`, ticks(label), true);
  }

  for (const label of [
    "I would like to receive marketing emails about future opportunities",
    "Please add me to your talent community for job alerts",
    "Sign me up for the newsletter",
    "I do not agree to the terms",
    "I wish to opt out of data processing",
    "I decline to self-identify",
    "I consent to a background check",
    "I consent to a drug test",
    "Have you ever agreed to a non-compete?",
  ]) {
    check(`leaves alone — ${label.slice(0, 46)}`, ticks(label), false);
  }

  // The rule asserts rather than reports, so the planner marks it for review.
  check("agreement answers are flagged as asserted", plan("I agree.", box()).rule.asserted, true);
}

/* ------------------------------------------------------------------ */
/*  6. Free-text prompts                                               */
/* ------------------------------------------------------------------ */

console.log("open-text education fields are marked as free text");
{
  check("school accepts a typed value", plan("School or University").rule.freeText, true);
  check("field of study accepts a typed value", plan("Field of Study").rule.freeText, true);
  // A fixed-choice field must not, or a Degree picker could acquire an
  // invented value.
  check("degree is not free text", plan("Degree").rule.freeText ?? false, false);
}

/* ------------------------------------------------------------------ */

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`${failures} failing`);
  process.exit(1);
}
