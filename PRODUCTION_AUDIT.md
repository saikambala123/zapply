# Zapply v1.13.10 — Workday Date & Pending-Answer Accuracy (Professional Release)

## Summary

This release eliminates remaining Workday **Invalid Date** failures on work-experience and education date fields, restores accurate start/end **month** values from the saved profile, and ensures Pending Saved Answers display stable, human-readable labels with the exact values the applicant (or profile) provided.

## Issues resolved

1. **Workday applications showed “Invalid Date: /YYYY”**  
   Masked `MM/YYYY` controls and segmented Month/Year spinbuttons received a year-only string (or an empty month segment). Month is now always supplied through the same digit-by-digit / segment path Workday expects.

2. **Start / End Date month fields in Work Experience remained blank**  
   Profile dates stored as year-only (legacy) or incompletely normalized no longer skip the Month control. A deterministic January fallback is applied only when the profile contains a year without a month; normalized `YYYY-MM` values are left unchanged.

3. **Pending / saved answers displayed inaccurate or collapsed values**  
   - Pending entries for repeated Work Experience and Education rows now use stable labels such as `Work Experience 1 — Start Date`, `Work Experience 1 — Start Date Month`, etc.  
   - Programmatic autofill values remain excluded from the Pending list.  
   - Manual-edit provenance is preserved across profile-backed fields, dropdowns, radio groups, checkboxes, and multi-row experience blocks so the value shown in Pending matches what is stored in the profile / control.

## Technical changes

### Extension (`extension/lib/matcher.js`)
- `dateParts()` normalizes month/day to two-digit strings.
- `setMaskedMonthYear()` continues digit-by-digit entry for Workday’s single masked `MM/YYYY` input (already present).
- `setSegmentedDate()` now applies a defensive `month = "01"` when the profile supplies only a year, so Month + Year segments are both written and Workday no longer reports `Invalid Date: /YYYY`.

### Extension (`extension/lib/field-map.js`)
- `parseProfileDate()` / `datePart()` / `dateForField()` retain full support for `YYYY-MM`, `MM/YYYY`, `YYYY`, month-name forms, and native `date` / `month` inputs.
- `datePart("month")` and `datePart("monthName")` supply January only for true year-only legacy data; existing `YYYY-MM` profile dates are untouched.
- Experience and Education month/year field rules (`experienceStartMonth`, `experienceEndMonth`, `educationStartMonth`, …) continue to resolve from the correct row index.

### Extension (`extension/content/autofill.js`)
- `pendingQuestion()` continues to emit human-readable, row-aware labels for Work Experience and Education date parts so multiple rows never collapse into a generic “From” / “Month” entry.
- Provenance ledger and programmatic-write markers keep autofilled values out of Pending Saved Answers while preserving genuine manual edits.

### Packaging
- Chrome and Firefox extension manifests bumped to **1.13.10**.
- `dist/chrome` and `dist/firefox` rebuilt from the same hardened `extension/` source.

## Verification

- `node --check` passes on `matcher.js`, `field-map.js`, and `autofill.js`.
- Static date-regression suite (`test/date-regressions.spec.mjs`) — 5/5 checks passed.
- Year-only → `01/YYYY` defensive path confirmed for both masked and segmented Workday controls.

## Deployment notes

1. Reload the extension (or install the new package) so content scripts pick up the date writers.
2. Profiles that already store dates as `YYYY-MM` require no change.
3. After a successful fill on a Workday experience step, Pending answers (if any) will show labels such as `Work Experience 1 — Start Date` with the exact month/year written to the form.

## Environment note

A full Next.js production build and Playwright browser suite may require a complete `npm ci` in an environment with the project’s lockfile dependencies. Syntax and static date regressions have been validated in this release package.
