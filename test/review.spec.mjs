/**
 * Pre-submit review.
 *
 *   node test/review.spec.mjs
 *
 * The panel is only useful if the right rows are at the top. Every problem in
 * this project was visible on screen before submission and none of them was
 * pointed out: a veteran declaration on the wrong option, a drafted sentence in
 * a Location box, an email address in a phone field. The ordering here is what
 * decides whether the applicant sees those before an employer does.
 *
 * `buildReviewRows` is deliberately free of DOM construction so it can be run
 * directly, which is what this does.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = process.env.ZAPPLY_EXT || join(HERE, "..", "extension");
const src = readFileSync(join(EXT, "content/autofill.js"), "utf8");

/* Lift the pure part out of the content script, with its dependencies stubbed. */
const slice = (from, to) => src.slice(src.indexOf(from), src.indexOf(to));
const body =
  slice("const REVIEW_RANK", "const review = {") +
  "\nreturn { buildReviewRows, reviewStatus, REVIEW_RANK };";

const { buildReviewRows } = new Function("M", "readValue", body)(
  {
    flaggedInvalid: (el) => Boolean(el.invalid),
    isRequired: (el) => Boolean(el.required),
    hasValue: (el) => Boolean(el.value),
  },
  (field) => field.el.value ?? ""
);

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
  if (!ok) console.log(`         got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`);
};

const control = (props = {}) => ({ value: "", required: false, invalid: false, ...props });
const applied = new Map();
const add = (label, value, source, props = {}) => {
  const el = control({ value, ...props });
  applied.set(el, { field: { el, label }, value, rule: { key: source }, source });
  return el;
};

/* A realistic mix, in the order a page would produce it. */
add("First Name", "Pradeep", "profile");
add("Phone Number", "pradeepbeeram91@gmail.com", "profile", { invalid: true, required: true });
add("Why do you want to work here?", "Because of the team.", "saved");
add("Location", "I am located in Jacksonville, Florida.", "ai");
add("City", "Jacksonville", "profile");

const unmatched = [
  { el: control({ required: true }), label: "Tax District", kind: "text" },
  { el: control({ required: false }), label: "Suffix", kind: "text" },
];

const rows = buildReviewRows(applied, unmatched);

console.log("\nthe risky rows come first");
check("order", rows.map((r) => r.status), [
  "rejected",   // the portal already refused it
  "drafted",    // written by the model, needs a human look
  "missing",    // required and still empty
  "saved",      // reused from another application
  "profile", "profile",
  "optional",   // empty, but nothing depends on it
]);
check("the rejected field is first", rows[0].label, "Phone Number");
check("the drafted answer is second", rows[1].label, "Location");
check("the required blank is third", rows[2].label, "Tax District");

console.log("\neach row says where its answer came from");
check("profile values are labelled", rows.find((r) => r.label === "First Name").status, "profile");
check("saved answers are labelled", rows.find((r) => r.label === "Why do you want to work here?").status, "saved");
check("drafted answers are labelled", rows.find((r) => r.label === "Location").status, "drafted");

console.log("\nblanks are only urgent when the form requires them");
check("required and empty is 'missing'", rows.find((r) => r.label === "Tax District").status, "missing");
check("optional and empty is not", rows.find((r) => r.label === "Suffix").status, "optional");

console.log("\nvalues shown are what is in the box now, not what was written");
const edited = new Map();
const box = control({ value: "Corrected By Hand" });
edited.set(box, { field: { el: box, label: "First Name" }, value: "Pradeep", rule: null, source: "profile" });
check("the current value wins", buildReviewRows(edited, [])[0].value, "Corrected By Hand");

console.log("\na field the applicant already filled is not listed as blank");
check("skipped", buildReviewRows(new Map(), [{ el: control({ value: "typed" }), label: "Notes", kind: "text" }]).length, 0);

console.log("\nfile inputs are left out — the panel cannot speak for an upload");
check("skipped", buildReviewRows(new Map(), [{ el: control(), label: "Resume", kind: "file" }]).length, 0);

console.log("\nordering is stable within a status");
const same = new Map();
["Alpha", "Bravo", "Charlie"].forEach((n) => add.call(null, n, "x", "profile") && 0);
["Alpha", "Bravo", "Charlie"].forEach((n) => {
  const el = control({ value: "x" });
  same.set(el, { field: { el, label: n }, value: "x", rule: null, source: "profile" });
});
check("page order preserved", buildReviewRows(same, []).map((r) => r.label), ["Alpha", "Bravo", "Charlie"]);

console.log(fails ? `\n${fails} failing\n` : "\nall passing\n");
process.exit(fails ? 1 : 0);
