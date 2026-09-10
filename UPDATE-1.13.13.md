# Zapply 1.13.13 Workday source-menu repair

This release fixes the blocking loop reproduced in `VID20260910045605.mp4`.

## What the recording showed

Workday opened **How Did You Hear About Us?** as a root category tree containing
`Campus Campaign`, `Corporate Website`, `Direct Source`, `Job Board`,
`Online Recruiter`, `Other`, and `Staffing Agency`. Zapply typed `LinkedIn` into
the root Search box before entering a category. That tenant searched only the
current level, displayed its loading indicator, restored the same root list,
and never reached LinkedIn. The unresolved menu made the fill appear stuck.

## Fixed

- A Workday category tree is now drilled before its Search box is used.
- The recorded root-category shape is recognized even when Workday labels every
  row only as `promptOption` and omits hierarchy attributes from the DOM.
- Explicit parent rows are attempted before fallback leaf probes, preventing
  needless menu commits and reopen cycles.
- `Job Board` is prioritized for LinkedIn, followed by other viable parent
  categories. LinkedIn remains preferred over Social Media, Job Portal/Board,
  and Other.
- Category-child loading now has a dedicated bounded wait, so Workday's async
  prompt fetch is allowed to finish without slowing ordinary dropdowns.
- If no matching child is available, the menu closes and the fill continues;
  it does not repeatedly search the same root list.

All 1.13.12 profile-state, disability-date, eligibility, education, Pending
Answers, and Sync fixes remain included.

## Install

1. Extract `zapply-v1_13_13-fixed-source.zip`.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable Developer mode.
4. Remove or disable the older Zapply installation.
5. Select **Load unpacked** and choose `dist/chrome`.
6. Reload every Workday application tab before testing.

Firefox users can load `dist/firefox/manifest.json` from
`about:debugging#/runtime/this-firefox`.
