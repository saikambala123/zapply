/**
 * Held-answer persistence.
 *
 *   node test/held-answers.spec.mjs
 *
 * Held answers used to live in a Map inside the content script. A Workday
 * application navigates on every step, each navigation tears the content script
 * down, and the Map went with it — so an answer edited on step 2 was gone before
 * the applicant reached the popup, and saving answers appeared to do nothing.
 *
 * They live in extension storage now. This runs the background's handlers
 * against a fake storage to prove an answer survives a teardown, that saving
 * moves it into the sync queue, and that nothing is uploaded on its own.
 */

import { readFileSync } from "node:fs";
import vm from "node:vm";

const EXT = process.env.ZAPPLY_EXT || "extension";

/* Enough of the extension APIs for the message handlers to run. */
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
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
  if (!ok) console.log(`         got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`);
};

const Q1 = "Why do you want to work here?";
const Q2 = "Please specify your veteran status.";

console.log("\nan edit is held, not banked");
await call({ type: "ZAPPLY_HOLD_ANSWERS", items: [{ question: Q1, answer: "Because of the team.", inputType: "textarea" }] });
check("held answer is stored", disk.heldAnswers?.length, 1);
check("nothing has entered the sync queue", disk.pendingResponses?.length ?? 0, 0);

console.log("\nit survives the content script being torn down");
const held = await call({ type: "ZAPPLY_GET_HELD" });
check("still readable after a navigation", held.data.held[0].question, Q1);
check("badge shows there is something waiting", chrome.__badge, "1");

console.log("\na second answer from a later step joins it");
await call({ type: "ZAPPLY_HOLD_ANSWERS", items: [{ question: Q2, answer: "I am not a protected veteran", inputType: "select" }] });
check("two answers held across two steps", disk.heldAnswers.length, 2);

console.log("\nre-answering one question replaces it rather than duplicating");
await call({ type: "ZAPPLY_HOLD_ANSWERS", items: [{ question: Q1, answer: "Because of the product.", inputType: "textarea" }] });
check("still two held", disk.heldAnswers.length, 2);
check("the newer wording won", disk.heldAnswers.find((r) => r.question === Q1).answer, "Because of the product.");

console.log("\nsaving one moves only that one into the sync queue");
await call({ type: "ZAPPLY_SAVE_HELD", questions: [Q1] });
check("one left held", disk.heldAnswers.length, 1);
check("one queued for sync", disk.pendingResponses.length, 1);
check("the right one was queued", disk.pendingResponses[0].question, Q1);
check("the answer type came with it", disk.pendingResponses[0].inputType, "textarea");

console.log("\nsaving the rest empties the held list");
await call({ type: "ZAPPLY_SAVE_HELD" });
check("nothing held", disk.heldAnswers.length, 0);
check("both queued", disk.pendingResponses.length, 2);
check("the dropdown kept its type", disk.pendingResponses.find((r) => r.question === Q2).inputType, "select");

console.log("\ndiscarding removes without queueing");
await call({ type: "ZAPPLY_HOLD_ANSWERS", items: [{ question: "A typo", answer: "asdf" }] });
await call({ type: "ZAPPLY_DISCARD_HELD", questions: ["A typo"] });
check("discarded answer is gone", disk.heldAnswers.length, 0);
check("and was never queued", disk.pendingResponses.length, 2);

console.log(fails ? `\n${fails} failing\n` : "\nall passing\n");
process.exit(fails ? 1 : 0);
