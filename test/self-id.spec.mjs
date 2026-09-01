/**
 * Voluntary self-identification and EEO regression suite.
 *
 *   node test/self-id.spec.mjs
 *
 * Locks in the four reports from the Manulife / John Hancock Workday form:
 *
 *   - the veteran dropdown answered "I IDENTIFY AS A VETERAN, JUST NOT A
 *     PROTECTED VETERAN" for a non-veteran, because that option and "I AM NOT
 *     A PROTECTED VETERAN" reduced to the same id and scored identically;
 *   - the race dropdown answered "American Indian or Alaska Native" for an
 *     applicant whose profile says Asian, because race had no canonical
 *     domain and fell through to token overlap;
 *   - the CC-305 "Name" box was filled with "Yes" and "Employee ID" with the
 *     applicant's name, because both were unmatched and handed to the model;
 *   - the CC-305 "Date" box was never filled at all.
 *
 * Runs without a browser: the matcher and rule table are pure, and the two
 * DOM stubs below carry only the surface the code under test reads.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.ZAPPLY_EXT || join(ROOT, "extension");

const sb = {
  document: { addEventListener() {}, querySelectorAll: () => [], getElementById: () => null },
  setTimeout, clearTimeout, console,
  HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {},
  Event: class { constructor(t) { this.type = t; } },
  KeyboardEvent: class {}, MouseEvent: class {}, FocusEvent: class {},
  CSS: { escape: (s) => s },
};
sb.window = sb;
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(readFileSync(join(EXT, "lib/matcher.js"), "utf8"), sb);
vm.runInContext(readFileSync(join(EXT, "lib/field-map.js"), "utf8"), sb);
const M = sb.ZAPPLY_MATCHER;
const RULES = sb.ZAPPLY_FIELD_MAP;

let fails = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
  if (!ok) console.log(`         got ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
};

/* A control: matchRule reads only tagName, type and getAttribute. */
const el = (type = "text", attrs = {}) => ({
  tagName: type === "textarea" ? "TEXTAREA" : type === "select" ? "SELECT" : "INPUT",
  type, isContentEditable: false,
  getAttribute: (k) => (k === "type" ? type : attrs[k] ?? null),
  closest: () => null, querySelector: () => null,
});

/* A <select>: assigning .value moves selectedIndex, as the real one does. */
function makeSelect(texts) {
  const options = texts.map((t, i) => ({ textContent: t, value: t, index: i }));
  const node = {
    tagName: "SELECT", options, selectedIndex: 0,
    focus() {}, blur() {}, dispatchEvent() { return true; },
    getAttribute() { return null; }, setAttribute() {}, closest() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
  };
  Object.defineProperty(node, "value", {
    get() { return node.options[node.selectedIndex]?.value ?? ""; },
    set(v) { const i = node.options.findIndex((o) => o.value === v); if (i !== -1) node.selectedIndex = i; },
  });
  return node;
}
const pick = (texts, want, hint) => {
  const node = makeSelect(texts);
  return M.setSelectValue(node, want, undefined, hint) ? node.options[node.selectedIndex].textContent : null;
};

const PROFILE = {
  personal: { firstName: "Subhash", lastName: "Yalamadala", email: "subhash.yala19@gmail.com" },
  eeo: { race: "Asian", gender: "Male", veteranStatus: "I am not a protected veteran", disabilityStatus: "No" },
};
const SEC = "Voluntary Self-Identification of Disability | Form CC-305 | OMB Control Number 1250-0005";
const plan = (label, control = el()) => {
  const rule = M.matchRule(control, label, RULES);
  if (!rule) return { key: null, value: null, blank: false, identity: false };
  let value = null;
  try { value = rule.value(PROFILE, control, label, 0); } catch {}
  return { key: rule.key, value, blank: !!rule.blank, identity: !!rule.identity };
};

const d = new Date();
const pad = (n) => String(n).padStart(2, "0");
const TODAY_US = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
const TODAY_ISO = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

console.log("\nCC-305 block");
check("Name matches the self-ID rule", plan(`Name | ${SEC}`).key, "selfIdName");
check("Name is the applicant's legal name", plan(`Name | ${SEC}`).value, "Subhash Yalamadala");
check("Employee ID matches its own rule", plan(`Employee ID (if applicable) | ${SEC}`).key, "employeeId");
check("Employee ID is left blank", plan(`Employee ID (if applicable) | ${SEC}`).blank, true);
check("Date matches the self-ID date rule", plan(`Date | ${SEC}`).key, "selfIdDate");
check("Date is today, MM/DD/YYYY", plan(`Date | ${SEC}`).value, TODAY_US);
check("Date is ISO for a native date input", plan(`Date | ${SEC}`, el("date")).value, TODAY_ISO);

console.log("\nthe same labels elsewhere are unaffected");
check("a bare Name still resolves to fullName", plan("Name").key, "fullName");
check("a bare Date is still left alone", plan("Date").key, null);
check("Graduation Date is not today", plan("Graduation Date").key !== "selfIdDate", true);
check("Employment Start Date is not today", plan("Employment Start Date").key !== "selfIdDate", true);

console.log("\nidentity fields are unreachable by the model");
for (const label of ["First Name", "Email", "Please specify your gender.", "Please specify your veteran status."]) {
  check(`${label} is flagged identity`, plan(label, el(label.includes("specify") ? "select" : "text")).identity, true);
}

console.log("\nEEO canonicalisation");
const VH = "Please specify your veteran status.";
check("classifications option", M.eeoId("I IDENTIFY AS ONE OR MORE OF THE CLASSIFICATIONS OF A PROTECTED VETERAN", VH), "veteran:protected");
check("veteran-but-not-protected is its own branch", M.eeoId("I IDENTIFY AS A VETERAN, JUST NOT A PROTECTED VETERAN", VH), "veteran:unprotected");
check("not-a-protected-veteran", M.eeoId("I AM NOT A PROTECTED VETERAN", VH), "veteran:not");
const RH = "Please select one of the following race designations as defined above.";
for (const [option, want] of [
  ["Asian (Not Hispanic or Latino)", "race:asian"],
  ["American Indian or Alaska Native (Not Hispanic or Latino)", "race:americanindian"],
  ["White (Not Hispanic or Latino)", "race:white"],
  ["Black or African American (Not Hispanic or Latino)", "race:black"],
  ["Native Hawaiian or Other Pacific Islander (Not Hispanic or Latino)", "race:nativehawaiian"],
  ["Two or More Races (Not Hispanic or Latino)", "race:twoormore"],
  ["Hispanic or Latino", "race:hispanic"],
]) check(option, M.eeoId(option, RH), want);
const DH = "Voluntary Self-Identification of Disability";
check("'I do not want to answer' is a decline", M.eeoId("I do not want to answer", DH), "decline");
check("'I do not wish to answer' is a decline", M.eeoId("I do not wish to answer", DH), "decline");

console.log("\nveteran dropdown");
const VET = [
  "Select One",
  "I IDENTIFY AS ONE OR MORE OF THE CLASSIFICATIONS OF A PROTECTED VETERAN",
  "I IDENTIFY AS A VETERAN, JUST NOT A PROTECTED VETERAN",
  "I AM NOT A PROTECTED VETERAN",
  "I DON'T WISH TO ANSWER",
];
check("a non-veteran gets the plain 'not' wording", pick(VET, "I am not a protected veteran", VH), "I AM NOT A PROTECTED VETERAN");
check("a decline gets the decline option", pick(VET, "I don't wish to answer", VH), "I DON'T WISH TO ANSWER");
check("a protected veteran gets the classifications option", pick(VET, "I identify as one or more of the classifications of a protected veteran", VH), VET[1]);
check("a non-protected veteran can still reach their wording", pick(VET, "I identify as a veteran, just not a protected veteran", VH), VET[2]);
check("a non-veteran refuses a list offering only the veteran wording", pick([VET[0], VET[2]], "I am not a protected veteran", VH), null);

console.log("\nrace dropdown");
const RACE = [
  "Select One", "Hispanic or Latino", "White (Not Hispanic or Latino)",
  "Black or African American (Not Hispanic or Latino)",
  "Native Hawaiian or Other Pacific Islander (Not Hispanic or Latino)",
  "Asian (Not Hispanic or Latino)",
  "American Indian or Alaska Native (Not Hispanic or Latino)",
  "Two or More Races (Not Hispanic or Latino)",
];
check("Asian does not land on American Indian", pick(RACE, "Asian", RH), "Asian (Not Hispanic or Latino)");
check("Asian Indian lands on Asian", pick(RACE, "Asian Indian", RH), "Asian (Not Hispanic or Latino)");
check("Two or More Races is not read as Hispanic", pick(RACE, "Two or More Races", RH), "Two or More Races (Not Hispanic or Latino)");
check("American Indian is still reachable", pick(RACE, "American Indian or Alaska Native", RH), RACE[6]);

console.log("\ngender dropdown");
const GEN = ["Select One", "Man", "Woman", "I don't wish to answer"];
check("Male resolves to Man", pick(GEN, "Male", "Please specify your gender."), "Man");
check("Female resolves to Woman", pick(GEN, "Female", "Please specify your gender."), "Woman");

console.log(fails ? `\n${fails} failing\n` : "\nall passing\n");
process.exit(fails ? 1 : 0);
