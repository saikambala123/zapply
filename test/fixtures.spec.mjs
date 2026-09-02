/**
 * Fixture replay.
 *
 *   node test/fixtures.spec.mjs
 *
 * Every fixture in `test/fixtures/` is rebuilt as a DOM and run through the real
 * matcher and rule table. A fixture that records which rule each field should
 * match becomes a permanent regression test for that form.
 *
 * This is the mechanism that should have existed from the start. Every accuracy
 * bug in this project was diagnosed from a photograph of a screen, and two were
 * misdiagnosed because the markup could not be inspected. A fixture takes one
 * click to capture and runs in milliseconds forever afterwards.
 *
 * Adding a form: press "Capture form" in the extension, drop the JSON into
 * `test/fixtures/`, then add an `expect` key naming the rule each field should
 * match. Fields without an `expect` are reported but not asserted, so a raw
 * capture can be committed immediately and annotated later.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { El, buildFixture, makeWindow } from "./lib/dom.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = process.env.ZAPPLY_EXT || join(HERE, "..", "extension");
const FIXTURES = join(HERE, "fixtures");

/* Load the matcher and rule table against the shared DOM. */
const root = new El("form");
const sandbox = makeWindow(root);
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(EXT, "lib/matcher.js"), "utf8"), sandbox);
vm.runInContext(readFileSync(join(EXT, "lib/field-map.js"), "utf8"), sandbox);
const M = sandbox.ZAPPLY_MATCHER;
const RULES = sandbox.ZAPPLY_FIELD_MAP;

let fails = 0;
let asserted = 0;
let unannotated = 0;

const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".json"));
if (!files.length) {
  console.log("\nNo fixtures yet. Press \"Capture form\" in the extension on any application\npage and drop the downloaded JSON into test/fixtures/.\n");
  process.exit(0);
}

for (const file of files) {
  const fixture = JSON.parse(readFileSync(join(FIXTURES, file), "utf8"));
  console.log(`\n${file}  (${fixture.ats}, ${fixture.fields.length} fields)`);

  /**
   * A capture must never contain an answer. This is asserted on every fixture
   * on every run, because the property that makes captures shareable is only
   * worth anything if it cannot quietly lapse.
   */
  const raw = JSON.stringify(fixture);
  const leaked = ["\"value\"", "\"checked\"", "\"selectedIndex\""].filter((k) => raw.includes(k));
  if (leaked.length) {
    fails++;
    console.log(`  FAIL contains ${leaked.join(", ")} — captures must not record answers`);
  } else {
    console.log("  ok   contains no answers");
  }

  const { controls } = buildFixture(fixture);

  for (const { el, field } of controls) {
    // The fixture's label is what the extension derived on the real page, which
    // is more faithful than anything this DOM could reconstruct.
    const label = field.label || "";
    const matched = M.matchRule(el, label, RULES)?.key ?? null;
    const own = label.split("|")[0].trim() || field.tag;

    if (!field.expect) {
      unannotated++;
      console.log(`  --   ${own} -> ${matched ?? "no match"}  (not annotated)`);
      continue;
    }

    asserted++;
    const want = field.expect === "none" ? null : field.expect;
    const ok = matched === want;
    if (!ok) fails++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${own} -> ${matched ?? "no match"}${ok ? "" : `  (expected ${want ?? "no match"})`}`);
  }
}

console.log(
  `\n${asserted} assertions across ${files.length} fixture${files.length === 1 ? "" : "s"}` +
    (unannotated ? `, ${unannotated} field${unannotated === 1 ? "" : "s"} awaiting annotation` : "")
);
console.log(fails ? `${fails} failing\n` : "all passing\n");
process.exit(fails ? 1 : 0);
