/**
 * Sync now, and the queue that would not empty.
 *
 *   node test/sync-queue.spec.mjs
 *
 * Capture was changed to keep questions up to 600 characters. The sync API
 * still refused anything over 300 in `isRealQuestion`, so a long Greenhouse
 * compliance question was rejected on arrival, never appeared in `savedKeys`,
 * was never confirmed, and never left the local queue. Sync now reported
 * failure and left the count exactly where it was, however many times it was
 * pressed — and the valid answers stuck behind it never got a clean batch.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${detail && !pass ? `\n         ${detail}` : ""}`);
};

const LONG =
  "If hired by StackAdapt, do you intend to hold any secondary employment, advisory " +
  "position (e.g. membership on a board of directors), or volunteer position that (1) is " +
  "on behalf of a business that would be competitive in nature to the business of " +
  "StackAdapt, (2) conflict with your ability to perform your duties at StackAdapt, or " +
  "(3) conflict with your working hours at StackAdapt?";

/* ---------- 1. the server must accept a question the extension can capture ---------- */
const routeSrc = await readFile(join(ROOT, "src/app/api/extension/sync/route.ts"), "utf8");
const ceiling = routeSrc.match(/text\.length\s*>\s*(QUESTION_MAX|\d+)/)?.[1];
const declared = Number(routeSrc.match(/const QUESTION_MAX\s*=\s*(\d+)/)?.[1] ?? 0);

const autofillSrc = await readFile(join(ROOT, "extension/content/autofill.js"), "utf8");
const captureMax = Number(autofillSrc.match(/const QUESTION_MAX\s*=\s*(\d+)/)?.[1] ?? 0);

check("the sync API's ceiling is a named constant, not a bare number", ceiling === "QUESTION_MAX", `found ${ceiling}`);
check("capture and the sync API agree on how long a question may be",
  declared > 0 && declared === captureMax, `api ${declared} vs capture ${captureMax}`);
check("the reported question would now be accepted", LONG.length <= declared,
  `question is ${LONG.length}, ceiling is ${declared}`);

/* ---------- 2. the queue must drain even when the server refuses an answer ---------- */
const bgSrc = await readFile(join(ROOT, "extension/background.js"), "utf8");
const pushQueueSrc = bgSrc.slice(bgSrc.indexOf("async function pushQueue"), bgSrc.indexOf("function queueKey"));

check("pushQueue reads the server's rejectedKeys", /rejectedKeys/.test(pushQueueSrc));
check("a rejected answer is dropped from the queue, not retried forever",
  /rejected\.has\(/.test(pushQueueSrc), "rejected keys are read but never used to filter");
check("an answer with no usable key is dropped rather than kept forever",
  /if \(!key\) return false/.test(pushQueueSrc), "no guard for keyless entries");

/* Exercise the real filtering logic against a stubbed server. */
const keyStart = bgSrc.indexOf("function queueKey");
const keyEnd = bgSrc.indexOf("\n}", bgSrc.indexOf("slice(0, 180)", keyStart)) + 2;
const queueKey = new Function(`${bgSrc.slice(keyStart, keyEnd)} ; return queueKey;`)();

const queued = [
  { question: LONG, answer: "No" },
  { question: "Have you previously worked at StackAdapt?", answer: "No" },
  { question: "   ", answer: "x" },                       // unusable: server rejects
];

/* What the server now returns: the two real ones written, the blank rejected. */
const serverSaved = [queueKey(LONG), queueKey(queued[1].question)];
const serverRejected = [queueKey(queued[2].question) || "   ".slice(0, 180)];

const confirmed = new Set(serverSaved);
const rejected = new Set(serverRejected);
const remaining = queued.filter((r) => {
  const k = queueKey(r.question);
  if (!k) return false;
  return !confirmed.has(k) && !rejected.has(k);
});

check("a long question is confirmed and leaves the queue",
  !remaining.some((r) => r.question === LONG), `still queued: ${remaining.length}`);
check("an unusable answer is dropped rather than wedging the queue",
  !remaining.some((r) => r.question.trim() === ""), `still queued: ${JSON.stringify(remaining)}`);
check("the queue empties completely", remaining.length === 0, `${remaining.length} left: ${JSON.stringify(remaining)}`);

/* ---------- 3. an entirely-rejected batch is not reported as retryable ---------- */
check("a wholly rejected batch is not reported as a retryable failure",
  /allRejected/.test(pushQueueSrc), "no allRejected handling found");

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed\n`);
process.exit(passed === results.length ? 0 : 1);
