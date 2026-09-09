# Zapply 1.13.11

This update repairs the extension supplied in zapply-v1_13_10-fixed-source(1).zip.

## Install the update

1. Extract this source ZIP. For Chrome or Edge, replace the files in the folder already loaded as your unpacked extension with `dist/chrome`, then click **Reload** on the browser's Extensions page. Keeping the existing extension entry preserves pairing and local pending answers. For Firefox, use the included `dist/firefox` package with your existing signing/installation process.
2. Refresh any application tabs that were open before the extension reload.
3. Open the extension, select the intended profile, and click **Sync now**. Confirm that the saved-answer count updates. If the extension requests pairing, pair it with your own portal URL.
4. Deploy the updated portal source through your existing deployment process. The server changes prevent AI-generated immigration answers and preserve imported school-name aliases. This ZIP does not deploy your portal or modify your live MongoDB data.
5. Click **Auto fill** on the application. Review the form before submitting.

The packaged default API remains `https://zapply.vercel.app`; an already-paired installation retains its configured URL. For a different release default, build with `ZAPPLY_API_BASE=https://your-portal.example npm run ext:build`.

## Behavior changes

- Disability/self-identification dates use the current local calendar date at each fill. Native date inputs receive `YYYY-MM-DD`; text controls follow explicit formats including `MM-DD-YYYY`, `MM/DD/YYYY`, and `DD/MM/YYYY`. Workday date segments and month dropdowns are supported. Manual edits remain protected, and employment/education/birth dates are excluded from this rule.
- Referral-source choices prefer an actual LinkedIn option. Custom source menus search and inspect nested parent/child categories before falling back to an available **Social Media/Social Network**, then **Job Board/Job Site**, option. The extension does not invent an option or choose Company Website, Referral, or Other as a LinkedIn substitute. An immediate “Please specify” source follow-up receives the same policy.
- Authorization and sponsorship use explicit profile answers, including boolean values and British/American spelling. Questions about working **without** sponsorship use the correct direction and require the relevant explicit facts. When the profile cannot answer, only a saved answer to the exact question can fill the field. Nationality/status keywords and AI do not supply immigration answers.
- Application consent/agree controls are included in scanning. Positive consent options are distinguished from negative options, and separate consent checkboxes remain separate even inside one fieldset. Explicit saved answers and manual edits remain respected. Marketing/newsletter/cookie controls and separate drug/background-check questions retain their own behavior.
- School names use the matching education row from the selected profile before saved-answer fallback. Imported institution aliases are recognized. Search prompts wait for results, support Enter to search/commit, and distinguish a selected school from leftover query text. Only an exact normalized school option is selected; an unavailable school remains for review rather than being replaced with a different institution.
- **Save** keeps an answer in the browser and makes it reusable locally. **Sync now** uploads pending/captured answers shown in the popup, then fetches the portal's saved answers. There are no automatic answer uploads from capture or background refresh.
- Sync divides large queues into batches of at most 100, clears only confirmed revisions, preserves newer edits made during uploads, and shares one operation across simultaneous Sync clicks. Rejected answers stay pending. A failed refresh is shown as incomplete instead of being reported as successful from stale cache. The selected profile survives refresh.

## Validation

Passed eight local suites: self-identification/EEO, Workday field/date writing, held answers, background sync, date regressions, row indexing, existing source-level UI regressions, and the new requested-fixes event/DOM fixtures.

The new fixture cases cover exact date formats, negative/inverted eligibility questions, profile-versus-saved-answer precedence, missing and disabled choices, multiple nested source branches, delayed LinkedIn search, delayed school results, Enter-only school commitment, independent consent boxes, and unknown-school cleanup. Sync cases cover 235 answers, partial rejection, refresh failure, concurrent clicks, an answer edited during upload, and selected-profile retention.

Run the focused checks with `npm run test:requested-fixes`. The complete existing browser suite remains available with `npm test` once project dependencies and Chromium are installed (set `CHROMIUM_PATH` to its executable).

Live Workday tenant pages, an authenticated portal/MongoDB sync, and a production Next.js build were not verified in this environment. Browser policy blocked local fixture pages, and the uploaded archive did not include project dependencies. The fixture tests execute the actual matcher, planner, and service-worker code with simulated DOM/events and API responses; they are not a substitute for live ATS testing. Source-tree exploration is bounded to five levels and 30 parent nodes.

Only the source ZIP was attached in this turn; no separate screenshots were available to inspect.
