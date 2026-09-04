/**
 * Pending-answer persistence and legacy migration.
 *
 *   node test/held-answers.spec.mjs
 *
 * Manual answers are now a durable local pending queue. They are uploaded only
 * when the applicant presses Sync now. Older builds used `heldAnswers`; the
 * background worker migrates that bucket into the same queue so upgrades do
 * not lose answers.
 */

import { readFileSync } from "node:fs";
import vm from "node:vm";

const EXT = process.env.ZAPPLY_EXT || "extension";
const disk = {};
const chrome = {
  storage: { local: {
    get: (keys, cb) => {
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {}; list.forEach((k) => { if (k in disk) out[k] = disk[k]; }); cb(out);
    },
    set: (obj, cb) => { Object.assign(disk, obj); cb && cb(); },
    remove: (keys, cb) => { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete disk[k]); cb && cb(); },
  } },
  runtime: { onMessage: { addListener: (fn) => { chrome.__onMessage = fn; } }, onInstalled: { addListener() {} },
             onStartup: { addListener() {} }, lastError: null, getURL: (p) => p, id: "test" },
  action: { setBadgeText(o) { chrome.__badge = o.text; }, setBadgeBackgroundColor() {} },
  tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} }, onActivated: { addListener() {} },
          onCreated: { addListener() {} }, onReplaced: { addListener() {} },
          query: (q, cb) => cb([]), sendMessage() {}, get(id, cb) { cb && cb({ id }); } },
  windows: { onFocusChanged: { addListener() {} }, WINDOW_ID_NONE: -1 },
  idle: { onStateChanged: { addListener() {} } },
  permissions: { contains: (p, cb) => cb(true) },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  webNavigation: { onCompleted: { addListener() {} }, onHistoryStateUpdated: { addListener() {} } },
  contextMenus: { create() {}, onClicked: { addListener() {} }, removeAll(cb) { cb && cb(); } },
  commands: { onCommand: { addListener() {} } },
  notifications: { create() {} },
  scripting: { executeScript() {} },
  declarativeNetRequest: { updateDynamicRules() {} },
};

const sb = { chrome, console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: async () => ({ ok: false, json: async () => ({}) }), URL, Date, Math, JSON, Promise, Map, Set, Array, Object, String, Number, Boolean, RegExp, Error, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent, btoa: (s) => Buffer.from(s).toString("base64"), atob: (s) => Buffer.from(s, "base64").toString() };
sb.self = sb; sb.globalThis = sb; sb.window = undefined;
vm.createContext(sb);
vm.runInContext(readFileSync(`${EXT}/background.js`, "utf8"), sb);

const call = (msg) => new Promise((resolve) => {
  const ok = chrome.__onMessage(msg, { tab: { id: 1 } }, resolve);
  if (!ok) resolve(undefined);
});

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${ok ? "" : `\n         got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log("\nmanual answers live in the durable pending queue");
await call({ type: "ZAPPLY_QUEUE_RESPONSES", responses: [
  { question: "Why do you want to work here?", answer: "Because of the product.", inputType: "textarea" },
  { question: "How did you hear about us?", answer: "Referral", inputType: "radio", options: ["LinkedIn", "Referral", "Job Board"] },
  { question: "Which shifts are you available for?", answer: "Evenings, Weekends", inputType: "checkbox", options: ["Mornings", "Evenings", "Weekends"] },
  { question: "Highest level of education?", answer: "Master's Degree", inputType: "select", options: ["High School", "Bachelor's Degree", "Master's Degree"] },
] });
check("four manual answers are pending", disk.pendingResponses?.length, 4);
check("radio keeps its question", disk.pendingResponses.find((r) => r.inputType === "radio")?.question, "How did you hear about us?");
check("checkbox keeps its question", disk.pendingResponses.find((r) => r.inputType === "checkbox")?.question, "Which shifts are you available for?");
check("dropdown keeps its type", disk.pendingResponses.find((r) => r.inputType === "select")?.inputType, "select");
check("badge counts pending answers", chrome.__badge, "4");

console.log("\nre-answering a question replaces the local pending record");
await call({ type: "ZAPPLY_QUEUE_RESPONSES", responses: [{ question: "How did you hear about us?", answer: "LinkedIn", inputType: "radio", options: ["LinkedIn", "Referral", "Job Board"] }] });
check("queue stays deduplicated", disk.pendingResponses.length, 4);
check("latest answer wins", disk.pendingResponses.find((r) => r.question === "How did you hear about us?")?.answer, "LinkedIn");

console.log("\nlegacy held answers migrate into pending");
await call({ type: "ZAPPLY_HOLD_ANSWERS", items: [{ question: "Legacy question", answer: "Legacy answer", inputType: "select" }] });
const pending = await call({ type: "ZAPPLY_GET_PENDING" });
check("legacy answer appears in pending", pending.data.responses.some((r) => r.question === "Legacy question"), true);
check("legacy held bucket is removed", disk.heldAnswers, undefined);
check("legacy answer is now in pendingResponses", disk.pendingResponses.some((r) => r.question === "Legacy question"), true);

console.log("\nclear only clears the local queue");
const cleared = await call({ type: "ZAPPLY_CLEAR_PENDING" });
check("clear reports every pending answer", cleared.data.cleared, 5);
check("pending queue is empty after clear", disk.pendingResponses, undefined);
check("legacy held bucket stays empty", disk.heldAnswers, undefined);

console.log(`\n${fails ? `${fails} failing` : "all passing"}\n`);
process.exit(fails ? 1 : 0);
