# Zapply 1.13.12 repair release

This release focuses on profile-authoritative autofill and reliable commits on
Workday, Greenhouse, iCIMS, Oracle, SAP, and generic application forms.

## Fixed

- **How did you hear about us?** always starts with `LinkedIn`. Native and
  custom dropdowns now follow this exact fallback order when LinkedIn is not
  available: `Social Media` / `Social Network`, `Job Portal` / `Job Board` /
  `Job Site`, then `Other`.
- Workday source trees are searched through nested categories even on tenants
  that expose every row only as `promptOption` and omit `aria-expanded`.
- A source subcategory or “Please specify source” follow-up is recognized as a
  source question instead of being sent to Saved Answers or AI.
- **State / Province / Region** is profile-owned and cannot be replaced by a
  similarly worded Saved Answer. US states, Canadian provinces, and Indian
  states resolve between full names, abbreviations, and ISO-style values such
  as `Illinois`, `IL`, and `US-IL`.
- **Voluntary Self-Identification of Disability** date fields inspect their
  nearest disclosure container when Workday omits the section name from the
  input label. Text dates default to the requested current `MM-DD-YYYY`; native
  date inputs remain `YYYY-MM-DD`, and split month/day/year controls receive the
  correct current segment.
- **Work authorization and sponsorship** recognize additional authorization,
  employment-eligibility, immigration-support, and inverted “without
  sponsorship” wording. These answers still come from explicit profile values
  first; missing legal/immigration facts are never invented by AI.
- Extension-written and AI-written values no longer appear as new Pending Saved
  Answers. Provenance now records the value the portal actually committed (for
  example `Social Media`, not the requested `LinkedIn`). A Pending answer is
  created only after the applicant changes that committed answer.

## Install

1. Extract `zapply-v1_13_12-fixed-source.zip`.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Enable Developer mode.
4. Remove or disable the older Zapply build.
5. Choose **Load unpacked** and select `dist/chrome`.
6. Reload any application tab that was already open.

Firefox users can load `dist/firefox/manifest.json` from
`about:debugging#/runtime/this-firefox`.

## Validation

The no-dependency extension regression suites cover source fallback/tree
selection, committed-value provenance, profile state aliases, CC-305 dates,
eligibility polarity, Workday date segments, Saved Answer sync, held answers,
row indexing, and dashboard regression guards. A real employer's live Workday
tenant and authenticated production database are not available in this local
workspace, so the final submission still needs human review as with any
autofill tool.
