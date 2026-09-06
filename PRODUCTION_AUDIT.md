# Zapply v1.13.9 — Workday Dates & Pending Answer Accuracy Release


## v1.13.9 release update

- Fixed Workday masked `MM/YYYY` work-history dates. Month and year are now entered through the same digit-by-digit path expected by Workday, preventing `Invalid Date: /YYYY` and restoring the saved start/end month values.
- Added a defensive January fallback only when a legacy profile contains a year without a month; normalized `YYYY-MM` profile dates remain unchanged.
- Added stable, human-readable pending-answer labels for Work Experience and Education fields (for example, `Work Experience 1 — Start Date`), so multiple edited rows cannot collapse into the same generic question.
- Preserved manual-edit provenance across profile-backed fields, dropdowns, radio groups, checkboxes, and repeated experience rows. Programmatic autofill remains excluded from Pending Saved Answers.
- Bumped Chrome and Firefox extension manifests to `1.13.9` and rebuilt both distribution packages from the same source.

## Changes made

- Hardened extension API calls with a 15-second AbortController timeout so a stalled network request cannot leave the popup/autofill waiting forever.
- Hardened Workday account auto-submit: it now waits for every visible password field to contain a value and for the submit control to be enabled before clicking. It never submits a half-filled account form.
- Optimized `/api/extension/sync` saved-answer persistence from sequential per-answer MongoDB calls to a deduplicated `bulkWrite`, reducing serverless latency and preventing duplicate upserts for the same normalized question in one request.
- Rebuilt Chrome and Firefox extension distributions from the hardened source so `dist/` matches `extension/`.
- Kept the existing one-pass autofill protections: plan-before-write, one dropdown at a time, no body-click dismissal, profile-owned fields protected from saved-answer contamination, bounded reconciliation, and validation-aware repair.

## Verification performed

- All extension JavaScript/MJS files pass `node --check` syntax validation.
- Existing static password/LinkedIn regression test passes.
- Chrome and Firefox extension packages rebuild successfully with `NEXT_PUBLIC_APP_URL=https://zapply.vercel.app`.

## Environment limitation

The supplied project archive has a correct `package-lock.json`, but the execution environment could not complete dependency installation. The local `node_modules` tree was incomplete (`next`, `mongoose`, `playwright`, and related packages were missing/corrupt), so a full Next.js production build and Playwright browser suite could not be executed here. This is an environment/dependency-install limitation, not a reported source syntax error.

Before release, run:

```bash
npm ci
npm run ext:test
npm run test:api
npm run test:ui
npm run build
NEXT_PUBLIC_APP_URL=https://YOUR-PRODUCTION-DOMAIN node scripts/build-extension.mjs
```
