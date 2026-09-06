# Zapply v1.13.12 — Workday From/To Date Corruption Fix (Professional Release)

## Critical fix

Live Workday applications were filling **From** as `01/0018` instead of `01/2018`.

### Cause
1. Workday From/To boxes often omit an `MM/YYYY` placeholder, so the masked digit-by-digit writer was skipped.
2. Bulk write of `01/2018` was interpreted incorrectly by Workday’s mask.
3. Any 2-digit or zero-padded year (`18`, `0018`) was written as year `0018`.

### Fix
- Always expand years to a real **4-digit** year (`18` / `0018` → `2018`).
- Detect Workday From/To/Start/End date inputs even without an MM/YYYY placeholder.
- Prefer digit-by-digit masked write for MM/YYYY values; never leave a corrupted year on the control.
- `dateForField` always emits `MM/YYYY` with a full 4-digit year for experience From/To fields.

## Also retained
- Current-role checkbox only on the profile job marked current
- End dates left blank for current roles
- Per-row work history mapping

## Version
Chrome & Firefox extension **1.13.12**
