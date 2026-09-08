/**
 * The pending list shows the whole question, and says which control it came from.
 *
 *   node test/pending-render.spec.mjs
 *
 * The reported row read "Question: option No, selected." — a screen-reader
 * announcement standing in for a 381-character question. Capture no longer
 * produces that, but the popup also has to be able to *show* a question that
 * long without burying the Save button, which is what the clamp is for.
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = process.env.ZAPPLY_EXT || join(ROOT, "extension");

const LONG =
  "If hired by StackAdapt, do you intend to hold any secondary employment, advisory " +
  "position (e.g. membership on a board of directors), or volunteer position that (1) is " +
  "on behalf of a business that would be competitive in nature to the business of " +
  "StackAdapt, (2) conflict with your ability to perform your duties at StackAdapt, or " +
  "(3) conflict with your working hours at StackAdapt?";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${detail && !pass ? `\n         ${detail}` : ""}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 420, height: 640 } });
page.on("pageerror", (e) => console.log("  page error:", e.message));

await page.addInitScript(() => {
  window.chrome = {
    runtime: { lastError: null, sendMessage(m, cb) { setTimeout(() => cb && cb({ ok: true, data: {} }), 0); }, onMessage: { addListener() {} } },
    tabs: { query(q, cb) { cb([]); }, sendMessage() {} },
    storage: { local: { get(k, cb) { cb({}); }, set(v, cb) { cb && cb(); } } },
  };
});
await page.goto(pathToFileURL(join(EXT, "popup/popup.html")).href);
await page.waitForTimeout(200);
const POPUP_SRC = await readFile(join(EXT, "popup/popup.js"), "utf8");

/* Render one long row and one short row through the popup's own renderer. */
const shape = await page.evaluate(({ long, src }) => {
  // The renderer is module-private; lift just it out to exercise the real code.
  const start = src.indexOf("function renderEntryText");
  const end = src.indexOf("\n}\n", src.indexOf("return { text, question };", start)) + 3;
  const fn = new Function(`${src.slice(start, end)}
    function typeLabel(t){ return String(t || "text").toUpperCase(); }
    return renderEntryText;`)();

  const host = document.createElement("div");
  host.style.width = "300px";
  document.body.appendChild(host);

  const longRow = fn({ question: long, answer: "No", inputType: "select", options: [] });
  const shortRow = fn({ question: "Have you previously worked at StackAdapt?", answer: "No", inputType: "select" });
  host.append(longRow.text, shortRow.text);

  const q = longRow.text.querySelector(".pending__q");
  const shortQ = shortRow.text.querySelector(".pending__q");
  const clampedHeight = q.getBoundingClientRect().height;
  q.classList.add("pending__q--open");
  const openHeight = q.getBoundingClientRect().height;

  return {
    fullTextPresent: q.textContent.includes("conflict with your working hours at StackAdapt?"),
    startsWithQuestionLabel: q.textContent.startsWith("Question: "),
    title: q.getAttribute("title") || "",
    isLong: q.classList.contains("pending__q--long"),
    shortIsNotClamped: !shortQ.classList.contains("pending__q--long"),
    clampedHeight, openHeight,
    typePill: longRow.text.querySelector(".pending__type")?.textContent || "",
    answer: longRow.text.querySelector(".pending__a")?.textContent || "",
  };
}, { long: LONG, src: POPUP_SRC });

check("the row carries the whole question, not a truncation", shape.fullTextPresent);
check("the question is labelled as the question", shape.startsWithQuestionLabel);
check("the full question is on the title for hover", shape.title === LONG, `title len ${shape.title.length}`);
check("a long question is clamped rather than filling the popup", shape.isLong && shape.clampedHeight > 0);
check("clamping actually shortens the row", shape.openHeight > shape.clampedHeight,
  `clamped ${shape.clampedHeight}px vs open ${shape.openHeight}px`);
check("a short question is left alone", shape.shortIsNotClamped);
check("the control type is shown", /SELECT|DROPDOWN/i.test(shape.typePill), `pill: ${shape.typePill}`);
check("the chosen answer is shown", /No/.test(shape.answer), `answer: ${shape.answer}`);

await browser.close();
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed\n`);
process.exit(passed === results.length ? 0 : 1);
