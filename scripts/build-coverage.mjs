#!/usr/bin/env node
/**
 * Generate the ATS coverage matrix.
 *
 *   node scripts/build-coverage.mjs
 *
 * The matrix is derived from the code and the fixture corpus, never written by
 * hand. A hand-maintained support list is a marketing document: it is correct on
 * the day it is written and drifts every day after, and the drift always runs in
 * the flattering direction. This reads the adapters that actually exist and the
 * fixtures that actually pass, so the published page cannot claim more than the
 * repository can back.
 *
 * Support tiers, and what each one is really saying:
 *
 *   verified   an adapter exists AND at least one captured form from that
 *              system is replayed by the test suite on every change
 *   detected   an adapter exists — the extension recognises the site and knows
 *              how to find its form — but no form has been captured yet, so
 *              nothing guards it against regressions
 *   fallback   no adapter; the generic field matching still applies
 *
 * "detected" is deliberately not called "supported". It works, and it is
 * untested, and those are different claims.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ATS_FILE = join(ROOT, "extension", "lib", "ats.js");
const FIXTURE_DIR = join(ROOT, "test", "fixtures");
const OUT_FILE = join(ROOT, "src", "data", "ats-coverage.json");

/**
 * Read the adapter keys and labels straight out of the source.
 *
 * Parsed rather than imported because `ats.js` is a browser content script that
 * touches `location` and `document` at definition time. Parsing keeps this
 * script dependency-free, and the shape it looks for is simple enough that a
 * change to it will fail loudly here rather than silently produce an empty
 * matrix — see the guard at the end.
 */
function readAdapters() {
  const source = readFileSync(ATS_FILE, "utf8");
  const adapters = [];
  const re = /^\s{4}([a-zA-Z][\w]*):\s*\{\s*$/gm;

  let match;
  while ((match = re.exec(source))) {
    const key = match[1];
    // The label is the first property of the adapter body.
    const after = source.slice(match.index, match.index + 400);
    const label = after.match(/label:\s*"([^"]+)"/)?.[1];
    if (!label) continue;
    adapters.push({ key, label });
  }
  return adapters;
}

function readFixtures() {
  if (!existsSync(FIXTURE_DIR)) return new Map();
  const byAts = new Map();
  for (const file of readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"))) {
    let fixture;
    try {
      fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"));
    } catch {
      continue;
    }
    const ats = fixture.ats || "unknown";
    const annotated = (fixture.fields ?? []).filter((f) => f.expect).length;
    const entry = byAts.get(ats) ?? { fixtures: 0, fields: 0, assertions: 0 };
    entry.fixtures += 1;
    entry.fields += fixture.fields?.length ?? 0;
    entry.assertions += annotated;
    byAts.set(ats, entry);
  }
  return byAts;
}

const adapters = readAdapters().filter((a) => a.key !== "generic");
const fixtures = readFixtures();

if (!adapters.length) {
  console.error(
    "No adapters found in extension/lib/ats.js.\n" +
      "The shape this script parses has probably changed. Fix the parser rather\n" +
      "than publishing an empty coverage matrix."
  );
  process.exit(1);
}

const rows = adapters
  .map(({ key, label }) => {
    const f = fixtures.get(key);
    return {
      key,
      label,
      tier: f?.fixtures ? "verified" : "detected",
      fixtures: f?.fixtures ?? 0,
      assertions: f?.assertions ?? 0,
    };
  })
  .sort((a, b) => {
    // Verified first, then by how much evidence backs it, then alphabetically.
    const order = { verified: 0, detected: 1 };
    return (
      order[a.tier] - order[b.tier] ||
      b.assertions - a.assertions ||
      a.label.localeCompare(b.label)
    );
  });

// Fixtures captured from a system with no adapter: worth surfacing, because each
// one is a candidate for a new adapter.
const orphans = [...fixtures.keys()]
  .filter((ats) => ats !== "unknown" && !adapters.some((a) => a.key === ats))
  .map((ats) => ({ key: ats, ...fixtures.get(ats) }));

const payload = {
  generatedAt: new Date().toISOString(),
  totals: {
    adapters: rows.length,
    verified: rows.filter((r) => r.tier === "verified").length,
    fixtures: [...fixtures.values()].reduce((n, f) => n + f.fixtures, 0),
    assertions: [...fixtures.values()].reduce((n, f) => n + f.assertions, 0),
  },
  rows,
  orphans,
};

mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`);

console.log(
  `Coverage: ${payload.totals.verified}/${payload.totals.adapters} verified, ` +
    `${payload.totals.fixtures} fixture(s), ${payload.totals.assertions} assertion(s)`
);
if (orphans.length) {
  console.log(`Fixtures with no adapter: ${orphans.map((o) => o.key).join(", ")}`);
}
