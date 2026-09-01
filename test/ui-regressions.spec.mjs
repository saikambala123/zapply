/**
 * Regression tests for the second repair pass — the defects that only showed up
 * once the app was actually running and driven, not while reading it.
 *
 *   node test/ui-regressions.spec.mjs
 *
 * These are source-level assertions rather than a rendered-DOM harness: each one
 * pins the specific construct that caused the bug, so reintroducing it fails
 * here instead of in front of a user.
 */

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

let passed = 0;
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

/**
 * Source with comments removed.
 *
 * The fixes carry comments quoting the construct they replaced, so a naive
 * text match finds the old pattern inside the explanation of why it's gone and
 * reports a fixed bug as still present. Match against code only.
 */
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
const check = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
};

/* ------------------------------------------------------------------ */
/*  Client fetch: no bare res.json(), no unchecked writes             */
/* ------------------------------------------------------------------ */

const CLIENT_COMPONENTS = [
  "src/components/dashboard/ApplicationTable.tsx",
  "src/components/dashboard/ResponsesManager.tsx",
  "src/components/dashboard/ProfileWorkspace.tsx",
  "src/components/dashboard/ProfileEditor.tsx",
  "src/components/dashboard/SettingsPanel.tsx",
  "src/components/dashboard/PremiumPanel.tsx",
  "src/components/marketing/AuthForm.tsx",
];

check("no dashboard component parses a response body outside a guard", () => {
  for (const file of CLIENT_COMPONENTS) {
    const src = code(file);
    // `await res.json()` with no `.catch` is the construct that threw on an
    // HTML 502 body and skipped the setBusy(false) that followed it.
    const bare = src.match(/await\s+res\.json\(\)(?!\s*\.catch)/g) ?? [];
    assert.equal(bare.length, 0, `${file} still has ${bare.length} bare await res.json()`);
  }
});

check("the shared client helper never rejects", () => {
  const src = code("src/lib/client-api.ts");
  assert.match(src, /catch\s*\{\s*return\s*\{\s*ok:\s*false/, "fetch failure must resolve, not throw");
  assert.match(src, /res\.json\(\)\.catch\(\(\)\s*=>\s*null\)/, "a non-JSON body must not throw");
});

check("optimistic writes roll back when the request fails", () => {
  for (const file of [
    "src/components/dashboard/ApplicationTable.tsx",
    "src/components/dashboard/ResponsesManager.tsx",
  ]) {
    const src = read(file);
    assert.match(src, /const before = rows;/, `${file} must snapshot rows before an optimistic write`);
    assert.match(src, /setRows\(before\)/, `${file} must restore rows on failure`);
  }
});

/* ------------------------------------------------------------------ */
/*  Upsert endpoints returning an existing row                        */
/* ------------------------------------------------------------------ */

check("created rows replace a matching row instead of duplicating it", () => {
  for (const file of [
    "src/components/dashboard/ApplicationTable.tsx",
    "src/components/dashboard/ResponsesManager.tsx",
  ]) {
    const src = read(file);
    assert.match(
      src,
      /findIndex\(\(r\) => r\._id === row\._id\)/,
      `${file} must check for an existing _id — POST upserts, so it can return a row already on screen`
    );
  }
});

/* ------------------------------------------------------------------ */
/*  Profile duplication                                               */
/* ------------------------------------------------------------------ */

check("POST /api/profiles seeds every profile section, not just contact details", () => {
  const src = read("src/app/api/profiles/route.ts");
  for (const key of ["experience", "education", "skills", "workAuth", "compensation", "eeo"]) {
    assert.ok(src.includes(`"${key}"`), `${key} must be seedable or "Duplicate profile" loses it`);
  }
});

check("a part-filled profile row survives a save", () => {
  const src = read("src/lib/profile-shape.ts");
  assert.match(
    src,
    /filter\(\(e\) => e\.company \|\| e\.title \|\| e\.description/,
    "an experience row with only a description must not be dropped"
  );
  assert.match(
    src,
    /filter\(\(e\) => e\.school \|\| e\.degree \|\| e\.fieldOfStudy/,
    "a part-filled education row must not be dropped"
  );
});

/* ------------------------------------------------------------------ */
/*  Timezone                                                          */
/* ------------------------------------------------------------------ */

check("activity buckets use the local calendar, not UTC", () => {
  const src = code("src/lib/utils.ts");
  assert.doesNotMatch(src, /toISOString\(\)\.slice\(0,\s*10\)/, "UTC day keys misplace evening applications");
  assert.match(src, /export function localDateKey/);
});

check("localDateKey brackets the day correctly either side of midnight", () => {
  // The TS module can't be imported here without a compiler, so assert the
  // logic instead: the key must be built from local getters, never getUTC*.
  const src = code("src/lib/utils.ts");
  const body = src.slice(src.indexOf("export function localDateKey"));
  assert.match(body, /getFullYear\(\)/);
  assert.match(body, /getMonth\(\)/);
  assert.match(body, /getDate\(\)/);
  assert.doesNotMatch(body.slice(0, 400), /getUTC/);
});

check("the greeting and today count are computed client-side", () => {
  const page = code("src/app/dashboard/page.tsx");
  assert.doesNotMatch(page, /function greeting\(\)/, "server-side greeting uses the server's clock");
  assert.match(page, /TodaySummary/);
  assert.match(read("src/components/dashboard/TodaySummary.tsx"), /"use client"/);
});

/* ------------------------------------------------------------------ */
/*  Smaller correctness fixes                                         */
/* ------------------------------------------------------------------ */

check("the resume file input resets so the same file can be picked twice", () => {
  const src = code("src/components/dashboard/ProfileEditor.tsx");
  const uploads = src.match(/e\.target\.value = ""/g) ?? [];
  assert.ok(uploads.length >= 2, "both file inputs must clear their value before use");
});

check("the free-text start date is not bound to an <input type=\"date\">", () => {
  const src = code("src/components/dashboard/ProfileEditor.tsx");
  assert.doesNotMatch(
    src,
    /label="Available start date" type="date"/,
    'a date input renders "Immediately" as blank'
  );
});

check("clipboard success is only claimed when the write resolved", () => {
  const src = code("src/components/dashboard/PairExtension.tsx");
  assert.doesNotMatch(src, /navigator\.clipboard\?\.writeText/, "optional chaining hid the failure");
  assert.match(src, /await navigator\.clipboard\.writeText/);
  assert.match(src, /catch\s*\{/);
});

check("a database outage is reported as 503 with a cause, not an opaque 500", () => {
  const src = read("src/lib/api.ts");
  assert.match(src, /MongooseServerSelectionError/);
  assert.match(src, /503/);
  assert.match(src, /Atlas/i, "the message should name the usual cause");
});

/* ------------------------------------------------------------------ */
/*  Footer links resolve                                              */
/* ------------------------------------------------------------------ */

check("every legal link in the footer has a page behind it", () => {
  const footer = code("src/components/marketing/Footer.tsx");
  const hrefs = [...footer.matchAll(/href:\s*"(\/[a-z-]+)"/g)].map((m) => m[1]);
  for (const href of hrefs) {
    if (href === "/") continue;
    const path = `src/app${href}/page.tsx`;
    assert.doesNotThrow(() => read(path), `${href} is linked from the footer but ${path} does not exist`);
  }
});

console.log(`\n${passed} checks passed`);
