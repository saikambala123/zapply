# Reliability pass — step 1

Added `npm run test:browser-reliability`, a real Chromium test of the matcher.
It checks text input events against a separate accepted-value model, delayed
Workday-style source children, LinkedIn commitment, menu closure, no accidental
form submission, and no uncaught browser errors. It uses Playwright's managed
Chromium by default, with optional CHROMIUM_PATH for CI.

Run after installing project dependencies:

```sh
npx playwright install chromium
npm run test:browser-reliability
```

This is a synthetic browser fixture, not a live employer test. Chromium is not
installed in the repair workspace, so browser execution remains unverified.
JavaScript syntax and the existing deterministic regression suite were checked.
Runtime extension behavior is unchanged from 1.13.13 in this test-only update.

Next: expand the browser matrix to dependent fields, rerenders, iframe forms and
manual-edit capture, then strengthen committed-value verification (step 2).
