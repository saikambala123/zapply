/**
 * ATS coverage.
 *
 *   node test/coverage.spec.mjs
 *
 * Guards the claim, not the code. A published support matrix is worth nothing
 * unless something stops it drifting away from what the repository can actually
 * back — and drift in a support list always runs in the flattering direction.
 *
 * So: the matrix must be generated, must be current, and every adapter it calls
 * "verified" must have a fixture that the replay suite is really running.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src", "data", "ats-coverage.json");

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
  if (!ok) console.log(`         got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`);
};

console.log("\nthe matrix is generated, not hand-written");
check("the generator runs", (() => {
  try { execFileSync("node", [join(ROOT, "scripts", "build-coverage.mjs")], { stdio: "pipe" }); return true; }
  catch { return false; }
})(), true);
check("it produced a matrix", existsSync(OUT), true);

const matrix = JSON.parse(readFileSync(OUT, "utf8"));

console.log("\nit reflects the adapters that exist");
const atsSource = readFileSync(join(ROOT, "extension", "lib", "ats.js"), "utf8");
const declared = [...atsSource.matchAll(/^\s{4}([a-zA-Z][\w]*):\s*\{\s*$/gm)]
  .map((m) => m[1])
  .filter((k) => k !== "generic");
check("every adapter appears", matrix.rows.length, declared.length);
check("none is invented", matrix.rows.every((r) => declared.includes(r.key)), true);
check("the generic fallback is not counted as support", matrix.rows.some((r) => r.key === "generic"), false);

console.log("\n'verified' means a fixture is actually replayed");
const fixtureDir = join(ROOT, "test", "fixtures");
const fixtureAts = existsSync(fixtureDir)
  ? readdirSync(fixtureDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(fixtureDir, f), "utf8")).ats)
  : [];

for (const row of matrix.rows.filter((r) => r.tier === "verified")) {
  check(`${row.label} has a fixture on disk`, fixtureAts.includes(row.key), true);
  check(`${row.label} has assertions in it`, row.assertions > 0, true);
}
check(
  "nothing is called verified without one",
  matrix.rows.filter((r) => r.tier === "verified" && r.fixtures === 0).length,
  0
);

console.log("\nan untested adapter is not described as supported");
check(
  "adapters without fixtures are 'detected'",
  matrix.rows.filter((r) => r.fixtures === 0).every((r) => r.tier === "detected"),
  true
);

console.log("\nthe totals add up");
check("verified count", matrix.totals.verified, matrix.rows.filter((r) => r.tier === "verified").length);
check("adapter count", matrix.totals.adapters, matrix.rows.length);
check(
  "assertion count",
  matrix.totals.assertions,
  matrix.rows.reduce((n, r) => n + r.assertions, 0) +
    matrix.orphans.reduce((n, o) => n + (o.assertions ?? 0), 0)
);

console.log(
  `\n${matrix.totals.verified} of ${matrix.totals.adapters} adapters verified by ` +
    `${matrix.totals.fixtures} fixture(s)`
);
console.log(fails ? `${fails} failing\n` : "all passing\n");
process.exit(fails ? 1 : 0);
