# Zapply v1.13.11 — Work History Dates & Current-Role Accuracy (Professional Release)

## Summary

This release ensures Workday work-experience blocks are filled **exactly** from the profile work history: correct start/end dates per row, and **"I currently work here" only on the role that is marked current** in the profile.

## Issues resolved

1. **Start / end dates filled incorrectly**  
   - From/To (and Month/Year) controls now resolve to the matching profile row’s `startDate` / `endDate`.  
   - End-date fields are left **empty** when the profile role is marked `current: true` (or has no end date).  
   - Profile `YYYY-MM` values are written as the form expects (e.g. `MM/YYYY` on Workday masked controls) without swapping or inventing months when a real month is stored.

2. **"I currently work here" applied to multiple experience blocks**  
   - The current-role checkbox/radio is evaluated **per row** against that row’s profile entry only.  
   - Only the profile job with `current: true` receives **Yes**; every other work-experience row receives **No**.  
   - Match patterns expanded to cover “I currently work here” and similar Workday wording; previous/past/education contexts are denied.

3. **Out-of-range experience rows**  
   - Rows beyond the number of saved jobs remain empty (no copying of job #1 into job #2).

## Technical changes

### `extension/lib/field-map.js`
- `experienceStartDate` / `experienceEndDate` (including high-weight From/To rules) use `jobAt(p, index)` and exact profile dates.
- `experienceEndDate`, `experienceEndMonth`, `experienceEndYear`, and end branch of `experienceDatePart` return `null` when `job.current` or missing `endDate`.
- `experienceStartMonth` / `experienceStartYear` require a real job + `startDate`.
- `currentJob` weight raised; value is strictly `jobAt(p, index).current ? "Yes" : "No"`; broader match + deny list.

### Retained from v1.13.10
- Masked and segmented Workday date writers with defensive January only for true year-only legacy data.
- Stable pending-answer labels for multi-row experience/education.

## Packaging
- Chrome & Firefox manifests: **1.13.11**
- `dist/chrome` and `dist/firefox` rebuilt from the same `extension/` source

## Verification
- `node --check` on matcher, field-map, autofill
- Static date-regression suite: 5/5 passed

## Deploy
1. Install/reload the 1.13.11 extension package.
2. Confirm profile work history: only one role should have “Currently work here” checked; dates should be `YYYY-MM`.
3. On a Workday application with multiple experience blocks, only the matching current role is checked and end dates stay blank for that role.
