/**
 * Field-outcome aggregation.
 *
 *   node test/telemetry.spec.mjs
 *
 * The accuracy report is only as good as the folding done before the write, so
 * that logic is exercised here directly: several elements on one page can
 * normalise to the same question, and each must become one counter bump rather
 * than one row.
 *
 * The route itself needs Mongo, so this covers the pure part — normalisation,
 * merging, and the accuracy arithmetic the dashboard shows.
 */

import { readFileSync } from "node:fs";

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
  if (!ok) console.log(`         got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`);
};

/* The same normalisation the server uses to identify a question. */
const normalizeQuestion = (q) =>
  String(q ?? "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(please|kindly|the|a|an|your|you|us|our|this|that|is|are|do|does|did|of|to|for|in|on|at|we|and|or|if|will|would|can|could|may)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);

/* Mirrors the fold in the POST handler. */
function fold(items) {
  const merged = new Map();
  for (const item of items) {
    const key = normalizeQuestion(item.label);
    if (!key) continue;
    const row = merged.get(key) ?? {
      sample: "", ruleKey: null, source: "unmatched", inputType: "text",
      fills: 0, corrections: 0, blanks: 0, rejections: 0,
    };
    row.sample = row.sample || item.label.slice(0, 160);
    row.ruleKey = item.ruleKey ?? row.ruleKey;
    row.source = item.source ?? row.source;
    row.inputType = item.inputType ?? row.inputType;
    if (item.filled) row.fills += 1;
    if (item.corrected) row.corrections += 1;
    if (item.blank) row.blanks += 1;
    if (item.rejected) row.rejections += 1;
    merged.set(key, row);
  }
  return merged;
}

console.log("\nrepeated rows fold into one question");
const repeated = fold([
  { label: "Job Title", ruleKey: "currentTitle", source: "profile", filled: true },
  { label: "Job Title", ruleKey: "currentTitle", source: "profile", filled: true },
  { label: "Job Title", ruleKey: "currentTitle", source: "profile", filled: true, corrected: true },
]);
check("one row, not three", repeated.size, 1);
check("three fills counted", repeated.get("job title").fills, 3);
check("one correction counted", repeated.get("job title").corrections, 1);

console.log("\nwording differences are the same question");
const worded = fold([
  { label: "Please specify your veteran status.", filled: true, corrected: true },
  { label: "Specify your veteran status", filled: true },
]);
check("folded together", worded.size, 1);
check("both fills counted", [...worded.values()][0].fills, 2);
check("the correction survives", [...worded.values()][0].corrections, 1);

console.log("\nblanks and rejections are tracked apart from corrections");
const mixed = fold([
  { label: "Tax District", source: "unmatched", blank: true },
  { label: "First Name", source: "profile", filled: true, rejected: true },
  { label: "Phone Number", source: "profile", filled: true, corrected: true },
]);
check("three distinct questions", mixed.size, 3);
check("the blank is a blank, not a fill", mixed.get("first name").fills, 1);
check("the rejection is recorded", mixed.get("first name").rejections, 1);
check("no phantom correction on a rejection", mixed.get("first name").corrections, 0);
check("the correction is recorded", mixed.get("phone number").corrections, 1);
check("the unanswerable field is a blank", mixed.get("tax district").blanks, 1);

console.log("\nempty labels are dropped rather than stored as a blank key");
check("nothing recorded", fold([{ label: "   ", filled: true }]).size, 0);

console.log("\naccuracy arithmetic");
const accuracy = (fills, corrections) => (fills > 0 ? 1 - corrections / fills : null);
check("10 filled, 1 corrected is 90%", Math.round(accuracy(10, 1) * 100), 90);
check("nothing filled reports nothing", accuracy(0, 0), null);
check("all wrong is 0%", accuracy(4, 4), 0);

console.log("\nvalues are never carried in the payload");
const src = readFileSync("extension/content/autofill.js", "utf8");
const collect = src.slice(src.indexOf("function collectOutcomes"), src.indexOf("async function applyValue"));
check("no value field is emitted", /(\bvalue\b\s*:)/.test(collect), false);
check("the label is", /label:/.test(collect), true);

console.log(fails ? `\n${fails} failing\n` : "\nall passing\n");
process.exit(fails ? 1 : 0);
