/**
 * ZAPPLY CONTENT SCRIPT
 * ---------------------
 * Runs on every page. Decides whether the page is a job application, fills it,
 * captures whatever the user answers by hand, and reports the result.
 *
 * Flow:
 *   detect ATS -> collect fields -> plan every value -> write once
 *   -> reconcile what genuinely failed -> watch for submit -> sync to the API
 *
 * One click is one pass. Earlier builds looped: a first fill, two rescans, an
 * AI pass, a retry pass and a validation pass, each of which called the setter
 * twice per field. On a Workday or SuccessFactors form that meant the same
 * dropdown was opened four or five times, which is what the user saw as
 * flickering — and while several menus were on screen at once, options from
 * one row's list were being scored against the next row's field. Now every
 * value is decided before anything is written, each control is written once,
 * and a dropdown is never opened while another one is still open.
 */

(() => {
  if (window.__zapplyLoaded) return;
  window.__zapplyLoaded = true;

  const M = window.ZAPPLY_MATCHER;
  const RULES = window.ZAPPLY_FIELD_MAP;
  const ATS = window.ZAPPLY_ATS;
  if (!M || !RULES || !ATS) return;

  const state = {
    session: null,      // { profile, settings, responses, premium }
    adapter: null,
    lastRun: null,
    unmatched: [],      // fields we couldn't answer — watched for manual input
    captured: new Map(),// question -> answer typed by the user
    filling: false,
    profile: null,      // the profile actually used (Premium may pick a different one)
    scoring: null,      // { score, reason, label } from Premium profile scoring
    drafted: new Set(), // elements filled by AI — the user must review these
    duplicate: null,    // a prior application for this posting, if any
    allFields: [],      // everything scanned on the last run
    stopRequested: false,
    manualSessionActive: false,
    completedRun: false,
    runId: 0,           // bumped per click; scopes "already written" to one pass
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ================================================================== */
  /*  Messaging                                                          */
  /* ================================================================== */

  const send = (message) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
          resolve(res ?? { ok: false });
        });
      } catch {
        resolve({ ok: false });
      }
    });

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg?.type?.startsWith("ZAPPLY_PENDING")) {
      if (handlePendingCommand(msg, respond)) return true;
    }
    if (msg?.type === "ZAPPLY_RUN") {
      if (window.top !== window) return respond({ ok: true, data: { child: true } });
      relayToChildFrames("ZAPPLY_RUN");
      run({ manual: true }).then((r) => respond(r));
      return true;
    }
    if (msg?.type === "ZAPPLY_STOP") {
      relayToChildFrames("ZAPPLY_STOP");
      state.stopRequested = true;
      state.manualSessionActive = false;
      return respond({ ok: true });
    }
    if (msg?.type === "ZAPPLY_STATUS") {
      respond({
        ok: true,
        isApplication: isApplicationPage(),
        ats: state.adapter?.label ?? null,
        lastRun: state.lastRun,
        duplicate: state.duplicate,
        profileLabel: state.profile?.label ?? null,
      });
      return true;
    }
    return false;
  });

  /* ================================================================== */
  /*  Page classification                                                */
  /* ================================================================== */

  function isApplicationPage() {
    const urlHit = /apply|application|careers?|job|candidate|opening|position|requisition/i.test(location.href);
    const inputs = document.querySelectorAll(
      'input[type="text"], input[type="email"], input[type="tel"], input:not([type]), textarea'
    );
    const formHit = inputs.length >= 3;
    const fileHit = Boolean(document.querySelector('input[type="file"]'));
    const eeoHit = /gender|veteran|disability|ethnicity|race/i.test(document.body?.innerText?.slice(0, 30000) || "");
    return [urlHit, formHit, fileHit, eeoHit].filter(Boolean).length >= 2;
  }

  function isExcluded(settings) {
    const list = settings?.excludedDomains ?? [];
    return list.some((d) => d && location.hostname.includes(d.trim()));
  }

  /* ================================================================== */
  /*  Field collection                                                   */
  /* ================================================================== */

  function collectSearchRoots() {
    const roots = [document];
    const seen = new Set(roots);
    const visit = (root) => {
      try {
        root.querySelectorAll("*").forEach((el) => {
          if (el.shadowRoot && !seen.has(el.shadowRoot)) {
            seen.add(el.shadowRoot);
            roots.push(el.shadowRoot);
            visit(el.shadowRoot);
          }
        });
      } catch {}
    };
    visit(document);
    return roots;
  }

  /**
   * Is this hidden control sitting inside a field the applicant can see?
   *
   * A select that a widget has replaced is invisible itself but lives in a
   * visible field wrapper. A select inside a collapsed step or an inactive tab
   * has nothing visible above it either — and filling that would put answers
   * into a part of the form nobody is looking at.
   */
  function hasVisibleHost(el) {
    let node = el.parentElement;
    for (let d = 0; node && d < 6; d++, node = node.parentElement) {
      if (node === document.body || node === document.documentElement) break;
      const style = getComputedStyle(node);
      // An ancestor that is switched off takes the whole region with it. The
      // visible page further up does not make this control reachable.
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return true;
    }
    return false;
  }

  /** Rule keys that belong to a repeated Work Experience / Education block. */
  const EXPERIENCE_KEYS = new Set([
    "currentCompany", "currentTitle", "employmentType", "experienceLocation",
    "experienceLocationType", "responsibilities", "experienceStartDate",
    "experienceEndDate", "experienceStartMonth", "experienceStartYear",
    "experienceEndMonth", "experienceEndYear", "experienceDatePart", "currentJob",
  ]);
  const EDUCATION_KEYS = new Set([
    "school", "degree", "fieldOfStudy", "educationLocation", "gpa",
    "graduationDate", "educationStartMonth", "educationStartYear",
    "educationEndMonth", "educationEndYear", "educationDatePart",
  ]);

  /**
   * Works out which repeated block each field belongs to.
   *
   * A numbered section heading is authoritative when the page provides one
   * ("Work Experience 2", "Professional Experience (1)"). Greenhouse and Oracle
   * provide nothing, so the rows are instead derived from the anchor field —
   * the Company or School box, which appears exactly once per entry — and every
   * other field is indexed by which anchor's container encloses it.
   *
   * Counting each rule key's occurrences, as the previous build did, silently
   * mis-numbered any form where the fields were not in a tidy repeating order,
   * which is why the wrong employer and the wrong dates were showing up.
   */
  function assignRowIndexes(fields, keys, anchorPreference) {
    const family = fields.filter((f) => keys.has(f.rule?.key));
    if (!family.length) return;

    // 1. Headings win outright.
    let anyHeading = false;
    for (const field of family) {
      const fromHeading = M.sectionContext?.(field.el)?.index;
      if (Number.isInteger(fromHeading)) { field.index = fromHeading; anyHeading = true; }
    }
    const unresolved = family.filter((f) => !Number.isInteger(f.index));
    if (!unresolved.length) { reconcileRows(family); return; }

    // 2. Otherwise fall back to repeated containers around the anchor field.
    const counts = new Map();
    family.forEach((f) => counts.set(f.rule.key, (counts.get(f.rule.key) || 0) + 1));
    const anchorKey =
      anchorPreference.find((k) => (counts.get(k) || 0) > 1) ||
      [...counts.entries()].sort((a, b) => b[1] - a[1]).filter(([, n]) => n > 1)[0]?.[0];
    if (!anchorKey) {
      unresolved.forEach((f) => { if (!Number.isInteger(f.index)) f.index = 0; });
      reconcileRows(family);
      return;
    }

    const anchors = family.filter((f) => f.rule.key === anchorKey).map((f) => f.el);
    const rows = M.rowsFromAnchors(anchors);
    if (rows.length < 2) {
      unresolved.forEach((f) => { if (!Number.isInteger(f.index)) f.index = 0; });
      reconcileRows(family);
      return;
    }

    unresolved.forEach((field) => {
      const i = rows.findIndex((row) => row.contains(field.el));
      field.index = i >= 0 ? i : 0;
    });

    reconcileRows(family);
  }

  /**
   * Every field in one row must carry the same index.
   *
   * Indexes are worked out per field, from whichever numbered heading each one
   * happens to resolve to. Two boxes sitting in the same row can resolve
   * differently — a heading nested one level deeper, a wrapper that breaks the
   * ancestor walk — and then one field reads row 2 of the profile while the box
   * beside it reads row 3. Where row 3 does not exist the lookup returns nothing
   * and that single box is left blank, which is the Job Title empty beside a
   * Company that filled from the same entry.
   *
   * The fields are grouped by the container they actually share and the row is
   * given one index: the one most of its fields agree on, falling back to the
   * row's position on the page. Disagreement inside a row is always a
   * resolution error, never a real difference — a row describes one job.
   */
  function reconcileRows(family) {
    const groups = new Map();
    for (const field of family) {
      const row = rowContainerOf(field.el, family);
      if (!row) continue;
      if (!groups.has(row)) groups.set(row, []);
      groups.get(row).push(field);
    }
    if (groups.size < 2) return;

    // Page order decides the fallback numbering.
    const ordered = [...groups.entries()].sort((a, b) => {
      const pos = a[0].compareDocumentPosition(b[0]);
      return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : pos & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
    });

    ordered.forEach(([, members], ordinal) => {
      const votes = new Map();
      members.forEach((f) => {
        if (!Number.isInteger(f.index)) return;
        votes.set(f.index, (votes.get(f.index) || 0) + 1);
      });
      let agreed = ordinal;
      let best = 0;
      for (const [value, count] of votes) {
        if (count > best) { best = count; agreed = value; }
      }
      members.forEach((f) => { f.index = agreed; });
    });
  }

  /** The smallest ancestor that holds this field and no other row's fields. */
  function rowContainerOf(el, family) {
    let node = el.parentElement;
    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      const inside = family.filter((f) => node.contains(f.el));
      // A row holds several of the row's own fields but not all of them.
      if (inside.length >= 2 && inside.length < family.length) return node;
    }
    return null;
  }

  /** Controls a person could actually answer — used to size up a candidate root. */
  const ANSWERABLE_PROBE =
    'input:not([type="hidden"]):not([type="submit"]):not([type="reset"]):not([type="button"]), ' +
    'textarea, select, [role="combobox"], [role="radio"], [role="checkbox"], [contenteditable="true"]';

  /**
   * Regions that are never the application itself: the site's own search box,
   * a newsletter signup, a cookie banner, a login widget. These are excluded
   * from the scan so widening it never means answering the page's furniture.
   */
  const PAGE_CHROME_RE =
    /(^|[\s\-_])(site-?search|searchform|search-?form|newsletter|subscribe|cookie|consent|gdpr|login|log-?in|sign-?in|signin|locale|language|currency|promo-?code|coupon|chat|livechat|support-?widget)([\s\-_]|$)/i;

  /** A button that changes the form rather than answering a question. */
  const ACTION_BUTTON_RE =
    /^(add|remove|delete|save|next|back|previous|continue|submit|upload|browse|attach|edit|cancel|close|clear|reset|sign\s*in|log\s*in|apply|search|skip|done|finish)\b/i;

  function isActionButton(el) {
    try {
      const name = (M.visibleText?.(el) || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
      return name ? ACTION_BUTTON_RE.test(name) : false;
    } catch {
      return false;
    }
  }

  function looksLikePageChrome(root) {
    if (!root || root === document || root.nodeType === 11) return false;
    if (root.getAttribute?.("role") === "search") return true;
    const hint = [
      root.getAttribute?.("id"), root.getAttribute?.("name"), root.getAttribute?.("class"),
      root.getAttribute?.("aria-label"), root.getAttribute?.("action"), root.getAttribute?.("data-testid"),
    ].filter(Boolean).join(" ");
    return hint ? PAGE_CHROME_RE.test(hint) : false;
  }

  /** Is this individual control part of the page furniture rather than the form? */
  function inPageChrome(el) {
    try {
      if (el.closest?.('[role="search"]')) return true;
      const form = el.closest?.("form");
      if (form && looksLikePageChrome(form)) return true;
      const self = [
        el.getAttribute?.("name"), el.id, el.getAttribute?.("aria-label"),
        el.getAttribute?.("placeholder"),
      ].filter(Boolean).join(" ");
      return self ? PAGE_CHROME_RE.test(self) : false;
    } catch {
      return false;
    }
  }

  function countAnswerable(root) {
    let n = 0;
    try {
      root.querySelectorAll(ANSWERABLE_PROBE).forEach((el) => {
        if (el.disabled || el.type === "hidden") return;
        if (inPageChrome(el)) return;
        if (M.isFillable(el) || (el.tagName === "SELECT" && hasVisibleHost(el))) n++;
      });
    } catch {}
    return n;
  }

  /**
   * Where to look for the application.
   *
   * The adapter's `formSelector` used to win outright: whatever it matched
   * became the entire search area, and the whole document was consulted only
   * when it matched nothing at all. On a portal that renders its application
   * outside any <form> — most React and Vue career sites — the one <form> on
   * the page is usually the header search box, so the scan found a single
   * search input and the profile went completely unused. That is the "profile
   * data isn't used on some applications" report.
   *
   * The matched forms are now checked against the rest of the page before they
   * are trusted: they are used as the scope only when they actually hold the
   * bulk of what a person has to answer. Otherwise the scan widens to the full
   * document, minus the site's own widgets.
   */
  function chooseScanRoots(adapter, searchRoots) {
    const matched = [];
    for (const root of searchRoots) {
      try {
        root.querySelectorAll(adapter.formSelector || "form").forEach((form) => {
          if (!looksLikePageChrome(form)) matched.push(form);
        });
      } catch {}
    }
    if (!matched.length) return searchRoots;

    const inside = matched.reduce((n, root) => n + countAnswerable(root), 0);
    const onPage = searchRoots.reduce((n, root) => n + countAnswerable(root), 0);

    // The matched forms hold most of the answerable controls, so they are the
    // application. Scoping to them keeps unrelated widgets out of the results.
    if (inside >= 3 && inside >= onPage * 0.6) return matched;

    // Most of the form lives outside what matched. Widen rather than fill
    // nothing — a few extra highlighted fields beat an untouched application.
    return searchRoots;
  }

  /**
   * Put back anything the page threw away after the fill.
   *
   * Portals that hydrate after first paint re-render their sections from their
   * own model, which is still empty, and every value written before that
   * finished is wiped. The fill has already reported success by then and never
   * looks again, so the applicant reaches Next and is told the fields are
   * required — first and last name most often, because they are at the top and
   * therefore filled earliest.
   *
   * Two short passes are enough for the frameworks in play. A field is only
   * restored while it is genuinely empty, never after the applicant has touched
   * it, and never more than twice — so this cannot turn into the fill
   * repeatedly rewriting the form.
   */
  const SETTLE_DELAYS = [900, 2200];
  const MAX_SETTLE_FIXES = 2;

  /**
   * Repair a value the page is rejecting, whenever it starts rejecting it.
   *
   * The settle passes above run 900ms and 2200ms after a fill. Workday does not
   * validate then — it validates when Save & Continue is pressed, which may be
   * several minutes later, and only then renders "The field First Name is
   * required and must have a value" under a box plainly containing "Pradeep".
   * By that point nothing was watching, so the value was never committed and
   * the applicant had to retype it by hand.
   *
   * This watches for error markup appearing at any time and re-commits only the
   * fields Zapply wrote, only while they still hold what Zapply wrote, and at
   * most three times each. It cannot touch a field the applicant has edited and
   * it never fills anything that was not already filled, so it stays a repair
   * and never becomes a second autofill.
   */
  const MAX_REPAIRS = 3;
  let repairTimer = null;

  function repairFlaggedFields() {
    if (state.filling || state.stopRequested) return;
    for (const [el, record] of Array.from(state.applied ?? new Map())) {
      try {
        if (!document.contains(el)) { state.applied.delete(el); continue; }
        if (el.__zapplyUserEdited) continue;
        if ((el.__zapplyRepairs ?? 0) >= MAX_REPAIRS) continue;
        if (!M.flaggedInvalid?.(el)) continue;
        // Only if the box still holds what we put there. Anything else is the
        // applicant's, or the page's, and is not ours to overwrite.
        if (!M.hasValue(el) || !matchesWritten(el, String(readValue(record.field) ?? ""))) continue;

        el.__zapplyRepairs = (el.__zapplyRepairs ?? 0) + 1;
        M.retypeValue(el, record.value);
      } catch {}
    }
  }

  function watchValidation() {
    const ping = () => {
      clearTimeout(repairTimer);
      repairTimer = setTimeout(repairFlaggedFields, 400);
    };
    try {
      new MutationObserver((records) => {
        for (const r of records) {
          // Only wake up for something that looks like a validation message.
          const touched = [...(r.addedNodes ?? [])];
          if (r.type === "attributes" && r.attributeName === "aria-invalid") return ping();
          for (const node of touched) {
            const text = node.textContent || "";
            if (/\b(is required|must have a value|invalid|cannot be blank)\b/i.test(text)) return ping();
          }
        }
      }).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["aria-invalid"],
      });
    } catch {}
  }

  function scheduleSettleCheck() {
    if (state.settleScheduled) return;
    state.settleScheduled = true;
    SETTLE_DELAYS.forEach((delay) => setTimeout(() => { settlePass(); }, delay));
  }

  async function settlePass() {
    if (state.filling || state.stopRequested) return;
    const entries = Array.from(state.applied ?? new Map());
    if (!entries.length) return;

    let restored = 0;
    for (const [el, record] of entries) {
      if (state.stopRequested) break;
      if (!document.contains(el)) { state.applied.delete(el); continue; }
      if (el.__zapplyUserEdited) continue;
      if (!record.readable) continue;
      if (el.__zapplyNoMatch) continue;
      if ((el.__zapplySettleFixes ?? 0) >= MAX_SETTLE_FIXES) continue;

      let holds = true;
      try { holds = M.hasValue(el); } catch {}

      // The value is still in the box, but the page has flagged the field as
      // required or invalid anyway — it took the text and never registered it.
      // That is the "Address Line 1 is required" seen with the address plainly
      // in the box. Writing it again through a clear-then-set transition is
      // what gets it into the page's own model.
      if (holds) {
        if (!M.flaggedInvalid?.(el)) continue;
        el.__zapplySettleFixes = (el.__zapplySettleFixes ?? 0) + 1;
        try { if (M.retypeValue(el, record.value)) restored++; } catch {}
        continue;
      }

      el.__zapplySettleFixes = (el.__zapplySettleFixes ?? 0) + 1;
      // The element was cleared by a re-render, so the guards that stop a field
      // being written twice in one pass have to be released for this one write.
      el.__zapplyWrittenRun = null;
      try {
        state.filling = true;
        if (await applyValue(record.field, record.value, record.rule)) restored++;
      } catch {
      } finally {
        state.filling = false;
      }
    }

    if (restored) {
      state.lastRun = { ...(state.lastRun ?? {}), restored: (state.lastRun?.restored ?? 0) + restored };
      if ((state.session?.settings ?? {}).showOverlay !== false) {
        try {
          overlay.show({
            tone: "partial",
            title: `Restored ${restored} field${restored === 1 ? "" : "s"}`,
            body: "The page cleared them while it finished loading. Check them before submitting.",
          });
        } catch {}
      }
    }
  }

  /**
   * Workday account settings. Passwords are intentionally read from the
   * dashboard Saved Answers list only; the extension has no separate password
   * input or browser-local password fallback.
   */
  async function getAccountSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(["zapplyAutoSubmitAccount"], (r) => resolve(r || {}));
      } catch {
        resolve({});
      }
    });
  }

  /** Every visible, fillable password box on the page — one for sign-in, two for create-account. */
  function passwordFields() {
    return Array.from(document.querySelectorAll('input[type="password"]')).filter((el) => M.isFillable(el));
  }

  /**
   * Looks the page's own password field(s) up in the saved-answers list —
   * exactly the mechanism every other field uses (findSavedAnswer below), so
   * a response saved under a question like "Password" is reused here the same
   * way a saved "Phone number" is reused on any other form. Only a field the
   * page itself is asking is checked, in whichever order they appear, so a
   * "Confirm password" box has the same chance to match as "Password" does.
   */
  function resolveSavedPassword() {
    for (const el of passwordFields()) {
      const field = { el, label: M.deriveLabel(el), kind: "text" };
      const hit = findSavedAnswer(field);
      if (hit?.answer) return hit.answer;
    }
    return null;
  }

  function fillAccountPasswordFields(password) {
    let filled = 0;
    for (const el of passwordFields()) {
      if (el.__zapplyUserEdited || M.hasValue(el)) continue;
      try {
        if (M.setTextValue(el, password)) filled++;
      } catch {}
    }
    return filled;
  }

  /**
   * The button that actually submits the sign-in or create-account form.
   * Workday tags these with data-automation-id; everything else falls back to
   * matching the button's own text, scoped to the form the password lives in
   * so a "Forgot password?" or "Back" link is never mistaken for it.
   */
  function findAccountSubmitButton() {
    const scope = passwordFields()[0]?.closest("form, [role='main'], [data-automation-id='shellRootRouterOutlet'], body") || document;
    const candidates = Array.from(
      scope.querySelectorAll(
        "button[data-automation-id='createAccountSubmitButton'], button[data-automation-id='signInSubmitButton'], " +
        "button[data-automation-id*='submit'], button[type='submit'], input[type='submit'], [role='button']"
      )
    );
    return candidates.find((el) => {
      if (!M.isFillable(el) || el.disabled || el.getAttribute("aria-disabled") === "true") return false;
      const t = (el.textContent || el.value || el.getAttribute("aria-label") || "").trim().toLowerCase();
      return /create account|sign in|log in|continue|submit|next/.test(t);
    }) || null;
  }

  /**
   * Workday can render the password immediately while its React state is still
   * one tick behind. Clicking the submit button at that exact moment makes the
   * UI look filled but the server receives an empty credential. Wait briefly
   * for every visible password control to contain the saved value and for the
   * submit control to become enabled. This is a bounded readiness check, not a
   * second autofill pass.
   */
  async function submitAccountWhenReady() {
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && !state.stopRequested) {
      const fields = passwordFields();
      const readyPasswords = fields.length > 0 && fields.every((el) => String(el.value ?? "").trim().length > 0);
      const btn = findAccountSubmitButton();
      if (readyPasswords && btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
        // Let controlled-field onChange/state updates flush before the click.
        await sleep(80);
        const latest = findAccountSubmitButton();
        if (latest && !latest.disabled && latest.getAttribute("aria-disabled") !== "true") {
          latest.click();
          return true;
        }
      }
      await sleep(100);
    }
    return false;
  }

  /**
   * Is this the sign-in or create-account step rather than the application?
   *
   * Workday's apply flow opens on one of these, and filling it half way — an
   * email address and nothing else, because a password is not something to
   * invent — looks like the fill worked when nothing has happened. The account
   * step belongs to the applicant; the fill starts once they are through it.
   */
  function authPageReason() {
    if (!document.querySelector('input[type="password"]')) return null;

    const hay = [
      location.pathname, location.search, document.title,
      M.visibleText?.(document.querySelector("h1, h2")) || "",
      Array.from(document.querySelectorAll("[data-automation-id]"))
        .slice(0, 40).map((n) => n.getAttribute("data-automation-id")).join(" "),
    ].join(" ").toLowerCase();

    if (/create\s*account|createaccount|register|sign\s*up|signup/.test(hay)) return "createAccount";
    if (/sign\s*in|signin|log\s*in|login|forgot|reset\s*password/.test(hay)) return "signIn";

    // A password box on a page with no resume upload is an account form
    // whatever it calls itself. With one, it's an application that happens to
    // ask the applicant to choose a password, and that is left to them too.
    return document.querySelector('input[type="file"]') ? null : "signIn";
  }

  function collectFields(adapter) {
    const searchRoots = collectSearchRoots();
    const roots = chooseScanRoots(adapter, searchRoots);

    const seen = new Set();
    const fields = [];

    roots.forEach((root) => {
      try {
        root
          .querySelectorAll(
            'input, textarea, select, ' +
            '[role="combobox"], [role="textbox"][contenteditable="true"], ' +
            '[aria-haspopup="listbox"], [aria-haspopup="menu"], ' +
            'button[data-automation-id*="Dropdown"], button[data-automation-id*="Prompt"], ' +
            // Plain buttons are scanned so segmented Yes/No controls are found.
            // Everything that is not a choice group or a menu trigger is
            // rejected a few lines below, so this widens detection only.
            'button, [role="button"], ' +
            'div[role="button"][aria-expanded], ' +
            '[role="checkbox"], [role="radio"], ' +
            '[data-qa], [data-testid], [data-test-id], [contenteditable="true"]'
          )
          .forEach((el) => {
            if (seen.has(el)) return;
            seen.add(el);
            // The scan may cover the whole page, so the site's own furniture is
            // filtered out here rather than being answered or flagged.
            if (inPageChrome(el)) return;
            // A dropdown that a library has replaced with its own markup keeps
            // its real <select> in the page but hides it. That select is the
            // value the form submits, so it is collected even though it cannot
            // be seen — otherwise a widget with no ARIA of its own (iCIMS's
            // "— Make a Selection —" country picker) is never even attempted.
            const hiddenButBacking =
              el.tagName === "SELECT" && !el.disabled && (el.options?.length ?? 0) > 1 &&
              hasVisibleHost(el);
            if (!M.isFillable(el) && !hiddenButBacking) return;
            if (["submit", "reset", "image"].includes(el.type)) return;
            // Never treat an option inside an open menu as a form field.
            if (el.closest?.('[role="listbox"], [role="menu"], [role="option"]')) return;

            // A segmented choice control — two or more plain buttons acting as
            // one question. Collected as a single radio-style field, so the
            // group is answered once and reported once.
            const segments = M.choiceButtonGroup?.(el);
            if (segments?.length) {
              const container = segments[0].parentElement;
              if (container && !container.dataset.zapplyChoiceKey) {
                container.dataset.zapplyChoiceKey = `c${Math.random().toString(36).slice(2)}`;
              }
              const groupKey = `choice|${container?.dataset?.zapplyChoiceKey || `single-${fields.length}`}`;
              if (fields.some((f) => f._groupKey === groupKey)) return;
              // Always anchor on the first segment so the derived label and the
              // row index don't depend on which button the scan reached first.
              const anchor = segments[0];
              seen.add(anchor);
              const segLabel = M.deriveLabel(anchor);
              fields.push({
                el: anchor,
                label: segLabel,
                kind: "radio",
                rule: M.matchRule(anchor, segLabel, RULES),
                _groupKey: groupKey,
              });
              return;
            }

            if (el.tagName === "BUTTON" || el.getAttribute("role") === "button") {
              const popup = el.getAttribute("aria-haspopup");
              const opensMenu =
                el.getAttribute("role") === "combobox" ||
                popup === "listbox" || popup === "menu" || popup === "true" ||
                /dropdown|select|prompt/i.test(el.getAttribute("data-automation-id") || "") ||
                // Workday renders most of its selects as a <button> carrying
                // nothing but `aria-expanded` — no aria-haspopup, no telling
                // automation id — so this has to stay. Excluding it made every
                // one of those dropdowns invisible to the fill, which is what
                // stopped Workday working.
                el.getAttribute("aria-expanded") !== null;
              if (!opensMenu) return;
              // The name is what separates a dropdown from a control that
              // changes the form: clicking "Add" or "Delete" is what opened
              // education section after education section. That check, not the
              // aria-expanded one above, is the guard that matters.
              if (isActionButton(el)) return;
            } else if (el.type === "button") return;

            if (el.type === "radio" || el.type === "checkbox" ||
                el.getAttribute("role") === "radio" || el.getAttribute("role") === "checkbox") {
              const role = el.getAttribute("role") || el.type;
              const name = el.getAttribute("name");
              const container = el.closest("fieldset, [role='radiogroup'], [role='group']");
              if (container && !container.dataset.zapplyGroupKey) {
                container.dataset.zapplyGroupKey = `g${Math.random().toString(36).slice(2)}`;
              }
              const groupKey = `${role}|${name || container?.dataset?.zapplyGroupKey || `single-${fields.length}`}`;
              if (fields.some((f) => f._groupKey === groupKey && f.el !== el)) return;
              el.dataset.zapplyGroup = el.dataset.zapplyGroup || (name || container?.dataset?.zapplyGroupKey || `g${fields.length}`);
              const label = M.deriveLabel(el);
              fields.push({ el, label, kind: M.fieldKind(el), rule: M.matchRule(el, label, RULES), _groupKey: groupKey });
              return;
            }

            const label = M.deriveLabel(el);
            fields.push({ el, label, kind: M.fieldKind(el), rule: M.matchRule(el, label, RULES) });
          });
      } catch {}
    });

    // A decorated dropdown can be picked up twice — once as the visible widget
    // and once as the hidden select behind it. They are one question, so keep
    // whichever carries the better label and drop the other.
    const byControl = new Map();
    const deduped = [];
    for (const field of fields) {
      const key = M.backingSelect?.(field.el) ?? field.el;
      const existing = byControl.get(key);
      if (!existing) {
        byControl.set(key, field);
        deduped.push(field);
        continue;
      }
      if ((field.rule && !existing.rule) || (field.label?.length ?? 0) > (existing.label?.length ?? 0)) {
        deduped[deduped.indexOf(existing)] = field;
        byControl.set(key, field);
      }
    }

    assignRowIndexes(deduped, EXPERIENCE_KEYS, ["currentCompany", "currentTitle", "responsibilities"]);
    assignRowIndexes(deduped, EDUCATION_KEYS, ["school", "degree", "fieldOfStudy"]);
    deduped.forEach((f) => { if (!Number.isInteger(f.index)) f.index = 0; });
    return deduped;
  }

  /**
   * A choice field that has nothing to offer yet.
   *
   * "State/Province" reads "Please select a country" until Country is answered,
   * and iCIMS's "Please specify" stays empty until "How did you hear about us?"
   * is. Attempting these in page order fills neither, so they are set aside and
   * retried once everything else has been answered.
   */
  function isAwaitingParent(field) {
    const el = field.el;
    if (el.disabled || el.getAttribute?.("aria-disabled") === "true") return true;
    if (field.kind !== "select") return false;
    return !M.hasRealOptions(el);
  }

  /**
   * Workday often starts with one blank Work Experience row. If the saved
   * profile contains more roles, create the missing rows before filling so the
   * nth role from the profile lands in the nth ATS row.
   */
  async function ensureProfileRows(profile, adapter, kinds = ["experience", "education"]) {
    const experienceCount = kinds.includes("experience") && Array.isArray(profile?.experience) ? profile.experience.length : 0;
    const educationCount = kinds.includes("education") && Array.isArray(profile?.education) ? profile.education.length : 0;
    if (experienceCount <= 1 && educationCount <= 1) return;

    const sectionRe = (kind) => kind === "experience"
      ? /work\s+experience|employment|work\s+history|job\s+history|professional\s+experience/i
      : /education|school|university|college/i;

    const countRows = (kind) => {
      const keys = kind === "experience" ? EXPERIENCE_KEYS : EDUCATION_KEYS;
      const fields = collectFields(adapter).filter((f) => keys.has(f.rule?.key));
      if (!fields.length) return 0;
      const indices = fields.map((f) => f.index).filter(Number.isInteger);
      return indices.length ? Math.max(...indices) + 1 : 1;
    };

    /**
     * How many rows this pass may create.
     *
     * The old ceiling was eight, and the only stop condition was countRows()
     * reporting enough rows. When an ATS renders its new sections in markup the
     * row indexer can't read, countRows never moves, the guard never fires, and
     * every one of those eight clicks lands — which is the reported "more than
     * seven education tabs". A row that never gets filled is an empty block the
     * applicant has to delete by hand, so the ceiling is now low and progress is
     * verified after every click.
     */
    const MAX_ADDED_ROWS = { experience: 5, education: 3 };

    const answerableCount = () => {
      try { return document.querySelectorAll(ANSWERABLE_PROBE).length; } catch { return 0; }
    };

    const clickAdds = async (kind, targetCount) => {
      if (targetCount <= 1) return;
      const re = sectionRe(kind);
      const limit = Math.min(MAX_ADDED_ROWS[kind] ?? 3, targetCount - 1);
      let rowsSeen = countRows(kind);
      let controlsSeen = answerableCount();

      for (let attempt = 0; attempt < limit; attempt++) {
        if (state.stopRequested) return;
        if (countRows(kind) >= targetCount) return;

        const add = Array.from(document.querySelectorAll('button, [role="button"], a, [data-automation-id]'))
          .filter((el) => M.isFillable(el))
          .find((el) => {
            const text = M.visibleText(el) || el.getAttribute("aria-label") || el.getAttribute("data-automation-id") || "";
            if (!/^add(?:\s+|$)|add\s+(another|new|work|experience|education|school|job)/i.test(text.trim())) return false;
            const parentText = M.visibleText(el.parentElement?.parentElement) || "";
            return re.test(`${text} ${parentText}`);
          });

        if (!add) return;
        M.ensureVisible(add);
        add.click?.();
        await sleep(320);

        // Neither the row count nor the number of answerable controls moved, so
        // that click achieved nothing. Repeating it would only stack up empty
        // sections, so the pass stops here rather than spending its whole
        // allowance discovering the same thing.
        const rowsNow = countRows(kind);
        const controlsNow = answerableCount();
        if (rowsNow <= rowsSeen && controlsNow <= controlsSeen) return;
        rowsSeen = rowsNow;
        controlsSeen = controlsNow;
      }
    };

    await clickAdds("experience", experienceCount);
    await clickAdds("education", educationCount);
  }

  /* ================================================================== */
  /*  Saved answers                                                      */
  /* ================================================================== */

  /**
   * Looks a question up in the user's saved answers.
   *
   * The derived label is several descriptions joined by " | ", so each one is
   * tried separately — matching the whole joined string diluted the score badly
   * enough that saved answers routinely failed to apply.
   */
  function findSavedAnswer(field) {
    const responses = state.session?.responses ?? [];
    if (!responses.length) return null;

    const el = field?.el;
    const candidates = [];
    const addCandidate = (value) => {
      const text = String(value ?? "").trim();
      if (!text) return;
      const parts = text.split(" | ").map((x) => x.trim()).filter(Boolean);
      for (const part of parts) {
        if (part.length >= 4 && !candidates.includes(part)) candidates.push(part);
      }
    };

    // Choice controls are commonly labelled with the *selected option* rather
    // than the question. The answer was previously saved under the real
    // question heading, so using only field.label made synced radio/checkbox
    // answers impossible to find on the next application.
    if (field) {
      try { addCandidate(primaryQuestion(field)); } catch {}
      try { addCandidate(questionHeadingNear(el)); } catch {}
      try { addCandidate(field.question); } catch {}
      addCandidate(field.label);
    }

    if (el) {
      ["aria-label", "data-qa", "data-testid", "name", "id"].forEach((attr) => {
        const v = el.getAttribute?.(attr);
        if (v && v.trim()) addCandidate(M.humanize(v.trim()) || v.trim());
      });

      const labelledBy = el.getAttribute?.("aria-labelledby");
      if (labelledBy) {
        for (const id of labelledBy.split(/\s+/)) {
          const node = document.getElementById(id);
          if (node) addCandidate(M.visibleText?.(node) || node.textContent);
        }
      }
    }

    let best = null;
    for (const question of candidates.slice(0, 8)) {
      if (question.length < 4) continue;
      const hit = M.findSavedAnswer(question, responses);
      if (hit && (!best || (hit.confidence ?? 0) > (best.confidence ?? 0))) best = hit;
    }
    if (!best) return null;

    // Saved answers that identify an application question exactly (including an
    // alias captured on another ATS) are always eligible to replay. This is
    // deliberately checked before profile-derived values in planField so an
    // explicit Saved Answer remains the user's chosen answer.
    //
    // Fuzzy matches stay available, but only at a stronger threshold than the
    // general matcher default. This prevents an unrelated saved response from
    // winning just because two short labels share a few words.
    if ((best.confidence ?? 0) < 0.82) return null;

    // An exact match means the applicant answered this very question before,
    // by its normalized text or one of its recorded aliases. That outranks a
    // value derived from the profile; a merely similar question does not.
    best.exact = (best.confidence ?? 0) >= 0.999;

    /**
     * A saved answer is not allowed to override an identity or voluntary
     * disclosure field.
     *
     * These are the fields with one correct answer that already lives in the
     * profile, and they are the ones the queue was poisoned with: a generated
     * "Yes" captured off a CC-305 Name box came back as a saved answer and was
     * replayed onto every later application, which is the loop the user
     * described — correcting it by hand only banked the correction against the
     * wrong question. The profile is authoritative here; the queue is not.
     */
    if (field?.rule?.blank) return null;
    if (field?.rule?.identity && !field.rule.eeo) return null;

    /**
     * Never into a contact or identity box, rule or no rule.
     *
     * The guard above only fires when a rule matched. When one did not — which
     * is exactly what happened to Workday's Phone Number box — the field was
     * open to any saved answer whose question looked similar, and it collected
     * the email address. These boxes have one source: the profile.
     */
    if (/\b(e-?mail|phone|mobile|telephone|country\s*code|area\s*code|extension|first\s*name|last\s*name|middle\s*name|full\s*name|date\s*of\s*birth|address\s*line|postal|zip\s*code)\b/i
        .test(String(field?.label ?? "").split("|")[0])) {
      return null;
    }

    /**
     * For a disclosure question the saved answer has to reduce to a real
     * branch of that same question. "Yes" saved against "Name" does not, and a
     * saved answer from a differently-worded portal that lands on another
     * branch must not be carried across either.
     */
    if (field?.rule?.eeo) {
      const savedId = M.eeoId(best.answer, field.label);
      if (!savedId) return null;
      const profileId = M.eeoId(field.rule.value?.(state.profile) ?? "", field.label);
      if (profileId && profileId !== savedId) return null;
    }

    // A saved answer only helps if this control can actually hold it. For a
    // choice field, insist the answer resembles one of the offered options —
    // otherwise the write fails and the field is reported filled when it isn't.
    // A control still waiting on its parent has no options to compare against
    // yet, so it is judged later, when it has some.
    if (field && (field.kind === "select" || field.kind === "radio") &&
        field.el?.tagName === "SELECT" && M.hasRealOptions(field.el)) {
      const options = Array.from(field.el.options || []).map((o) => M.normalizeChoiceText(o.textContent));
      const answer = M.normalizeChoiceText(best.answer);
      const usable = options.some((o) => o && (o === answer || o.includes(answer) || answer.includes(o)));
      if (!usable) return null;
    }
    return best;
  }

  /* ================================================================== */
  /*  Writing a value                                                    */
  /* ================================================================== */

  /** Marks a control as ours so the capture listeners don't call it a user edit. */
  function beginProgrammatic(el) {
    el.__zapplyProgrammatic = true;
    el.__zapplyProgrammaticUntil = Date.now() + 1500;
  }
  function endProgrammatic(el) {
    el.__zapplyProgrammatic = false;
  }
  function isProgrammatic(el) {
    return Boolean(el.__zapplyProgrammatic) || (el.__zapplyProgrammaticUntil ?? 0) > Date.now();
  }

  /**
   * Did the site actually accept the value? This is what stops Zapply saying
   * "filled" while the ATS still shows "This field is required".
   */
  function verifyField(field, expected) {
    const el = field.el;
    if (field.kind === "file") return Boolean(el.files?.length);
    if (M.valuesEquivalent(el, expected, field.label)) return true;

    // Text controls reformat as you type (phone masks, date pickers), so an
    // exact match is too strict here — containment either way is enough.
    if (["text", "textarea", "email", "tel", "url", "number", "date", "month"].includes(field.kind)) {
      const actual = M.norm(el.value ?? el.textContent ?? "");
      const want = M.norm(expected);
      if (!actual || !want) return false;
      if (actual === want) return true;
      const digitsOnly = (s) => s.replace(/\D+/g, "");
      if (digitsOnly(want).length >= 4 && digitsOnly(actual) === digitsOnly(want)) return true;
      return want.length >= 3 && (actual.includes(want) || want.includes(actual));
    }
    return false;
  }

  /**
   * Has this control already been written during the pass now running?
   *
   * The rest of the engine decides "is this done?" by reading the value back,
   * which works right up until a widget renders its answer somewhere nothing
   * can read — and then a finished field looks blank and gets filled, retried
   * and re-answered. This is the backstop for that whole class of widget: once
   * a setter reports it committed something, this pass is finished with the
   * control, whatever reading it back suggests. It is scoped to one run, so a
   * deliberate second click can still have another go at a field that really
   * did stay empty.
   */
  function writtenThisRun(el) {
    return el.__zapplyWrittenRun === state.runId;
  }

  /**
   * Writes one value into one control, once.
   *
   * The only retry here is for plain text inputs, where a second write costs
   * nothing and controlled React inputs occasionally swallow the first. Custom
   * dropdowns are deliberately never retried at this level — setComboboxValue
   * already searches, filters and drills inside a single opening, and calling
   * it twice is exactly what produced the visible open/close flicker.
   */
  async function applyValue(field, value, rule) {
    const el = field.el;

    // Preserve a user-owned value, but allow an explicitly cleared control to
    // be populated again on the next manual Autofill pass.
    if (el.__zapplyUserEdited && M.hasValue(el)) return false;
    if (el.__zapplyUserEdited && !M.hasValue(el)) {
      el.__zapplyUserEdited = false;
      el.__zapplyProgrammatic = false;
      el.__zapplyProgrammaticUntil = 0;
    }
    if (!document.contains(el)) return false;
    // Already answered by this pass. Opening the same dropdown again cannot
    // improve the answer and is precisely what the user sees as autofill
    // "going back and editing the fields it just completed".
    if (writtenThisRun(el)) return true;

    beginProgrammatic(el);
    const quirks = state.adapter?.quirks ?? {};
    let ok = false;

    try {
      if (field.kind === "select") {
        ok = el.tagName === "SELECT"
          ? M.setSelectValue(el, value, rule?.options, field.label)
          : await M.setComboboxValue(el, value, quirks.dropdownDelay ?? 900, rule?.options, field.label);
      } else if (field.kind === "radio") {
        ok = M.setRadioValue(el, value, rule?.options, field.label);
      } else if (field.kind === "checkbox") {
        ok = M.setCheckboxValue(el, value, rule?.options, field.label);
      } else if (field.kind === "file") {
        /**
         * An attachment is only ever set through DataTransfer, and only when
         * the applicant has switched attachments on. The file dialog is never
         * opened — a résumé chooser appearing over the form during a fill is
         * not something the applicant asked for.
         */
        ok = state.session?.settings?.autoAttachResume === true && M.setFileValue(el, value);
      } else {
        ok = M.setTextValue(el, String(value));
        if (!ok) { await sleep(60); ok = M.setTextValue(el, String(value)); }
      }
    } catch {
      ok = false;
    }

    await sleep(40);
    // The setter reported that it committed a value. Even if we cannot read it
    // back, the control has been interacted with and must not be touched again
    // in this pass.
    if (ok) {
      el.__zapplyWrittenRun = state.runId;
      // Kept so the settle pass can put the value back if the page throws it
      // away while finishing its own rendering.
      try {
        // `readable` records whether the value could be read back straight after
        // the write. A widget we cannot read is indistinguishable from one the
        // page cleared, so restoring it would just re-open the same dropdown on
        // every settle pass — visible flicker for a result that cannot change.
        let readable = false;
        try { readable = M.hasValue(el); } catch {}
        (state.applied ??= new Map()).set(el, { field, value, rule, readable });
      } catch {}
      // Remembered so the answer sweep can tell our own writing apart from the
      // applicant's. Without it, every field Zapply filled would be queued as
      // though they had answered it by hand.
      el.__zapplyWrittenValue = typeof value === "object" ? null : String(value);
      el.__zapplyWasFilled = true;
      el.__zapplyUserEdited = false;
    }

    // Each setter self-verifies; verifyField is an independent second opinion.
    // A field counts as filled when the strict check passes, or when the setter
    // succeeded and the control now visibly holds something.
    const verified = verifyField(field, value);
    const filled = verified || (ok && M.hasValue(el));
    setTimeout(() => endProgrammatic(el), 0);
    return Boolean(filled);
  }

  function collectRequiredErrors() {
    const nodes = Array.from(document.querySelectorAll(
      '[aria-invalid="true"], .error, .field-error, [class*="error"], [data-automation-id*="error"], [role="alert"]'
    ));
    return nodes.filter((n) => {
      const text = (n.textContent || "").trim();
      return text && /required|please select|please enter|invalid|must be/i.test(text) && n.getBoundingClientRect().height > 0;
    }).map((n) => (n.textContent || "").trim()).slice(0, 30);
  }

  /* ================================================================== */
  /*  Planning — decide every value before touching the page             */
  /* ================================================================== */

  /**
   * Returns what this field should contain, and where the answer came from,
   * without writing anything. Doing the whole form's thinking first is what
   * lets the write phase be a single uninterrupted sweep.
   */
  function planField(field, profile, settings) {
    const { el, label, kind } = field;

    // A non-empty field that the applicant edited is theirs and must never be
    // overwritten on a later Fill click. If they explicitly cleared it, however,
    // the field is empty again and should be eligible for Autofill on that next
    // explicit click.
    if (el.__zapplyUserEdited && M.hasValue(el)) return { status: "skipped" };
    if (el.__zapplyUserEdited && !M.hasValue(el)) {
      el.__zapplyUserEdited = false;
      el.__zapplyProgrammatic = false;
      el.__zapplyProgrammaticUntil = 0;
    }

    // Written a moment ago by this same pass. Nothing that happens later in the
    // run — a re-scan, a reconcile, the AI pass — may plan it a second time.
    if (writtenThisRun(el)) return { status: "already", key: field.rule?.key ?? null };

    // An answered question is finished. Zapply does not second-guess a value
    // that is already in the form — whether the applicant typed it, the portal
    // prefilled it, or an earlier run put it there. Running autofill again
    // therefore only ever fills what is still blank.
    if (kind !== "file" && M.hasValue(el) && settings?.overwriteExisting !== true) {
      return { status: "already", key: field.rule?.key ?? null };
    }

    const rule = field.rule;
    const canReuse = settings?.reuseSavedResponses !== false && kind !== "file";

    // A field the rule table says has no answer for an applicant — "Employee ID
    // (if applicable)" is the standing example. Returning early keeps it away
    // from saved answers and the AI pass as well as from the profile, which is
    // the only way it stays genuinely blank.
    if (rule?.blank) return { status: "skipped", key: rule.key };

    /**
     * A saved answer to *this exact question* normally outranks a derived one —
     * it is the applicant's own wording. But not when the profile already
     * answers the field.
     *
     * The queue is the part of the system that gets poisoned. A corrupted
     * Suffix banked off an Oracle form came back on every later application and
     * beat the profile every time, so correcting the profile changed nothing and
     * the applicant had no way to win. Where the profile has a value it is the
     * answer; saved answers cover the questions the profile does not know about.
     */
    const saved = canReuse ? findSavedAnswer(field) : null;
    let profileValue;
    if (rule) {
      try { profileValue = rule.value(profile, el, label, field.index ?? 0); } catch { profileValue = null; }
    }
    const profileAnswers = Boolean(profileValue) && profileValue !== "__RESUME__" && profileValue !== "__COVER_LETTER__";

    // An explicit Saved Answer is the applicant's stored decision for this
    // question. It must win over a generic/profile-derived default (for example,
    // a saved "8" years of experience should not be replaced by a calculated
    // profile value). Identity/contact/profile-only fields remain protected below.
    const profileOnly = Boolean(rule?.profileOnly);
    const protectedIdentity =
      Boolean(rule?.identity && !rule?.eeo) ||
      /\b(e-?mail|phone|mobile|telephone|country\s*code|area\s*code|extension|first\s*name|last\s*name|middle\s*name|full\s*name|date\s*of\s*birth|address\s*line|postal|zip\s*code)\b/i
        .test(String(field?.label ?? "").split("|")[0]);

    if (saved?.answer && !profileOnly && !protectedIdentity) {
      return { status: "fill", key: "saved-answer", value: saved.answer, rule, source: "saved" };
    }

    if (rule) {
      const value = profileValue;

      if (value === "__RESUME__" || value === "__COVER_LETTER__") {
        // Documents are attached only when the applicant has asked for that.
        // Silently pushing a résumé into whatever file input a page exposes is
        // not something an autofill should decide on its own.
        if (kind !== "file") return { status: "skipped", key: rule.key };
        // "unmatched" here used to mean the same thing it means everywhere
        // else: dashed-outline the field and count it in the on-page "N
        // fields need your answer" pill. For a resume/cover-letter field with
        // the toggle off that isn't a gap to flag — it's the applicant's
        // standing choice not to have Zapply touch attachments — so with the
        // toggle off this is now a silent "skipped" like any other field
        // Zapply deliberately leaves alone. It only becomes "unmatched" (and
        // worth surfacing) once the toggle is on and there is genuinely no
        // document to attach.
        if (settings?.autoAttachResume !== true) return { status: "skipped", key: rule.key };
        const wantKind = value === "__RESUME__" ? "resume" : "coverLetter";
        const docs = profile.documents ?? [];
        const doc = docs.find((d) => d.kind === wantKind && d.isDefault) || docs.find((d) => d.kind === wantKind);
        if (!doc) return { status: "unmatched", key: rule.key };
        return { status: "fill", key: rule.key, value: doc, rule, source: "profile" };
      }

      if (value) return { status: "fill", key: rule.key, value, rule, source: "profile" };

      /**
       * A field whose only legitimate source is the profile. If the profile
       * does not have it, it stays empty — no saved answer from a different
       * application, no generated sentence. See `experienceLocation`.
       */
      if (rule.profileOnly) return { status: "skipped", key: rule.key };

      // No profile value: a close saved answer is the next best source.
      if (saved?.answer) {
        return { status: "fill", key: "saved-answer", value: saved.answer, rule, source: "saved" };
      }

      // Voluntary self-identification. Declining is a permitted answer, but it
      // is still an answer the applicant did not give, so it is opt-in and off
      // by default. Without it the question is left blank for them.
      if (rule.eeo && rule.decline && settings?.eeoFallbackDecline === true) {
        return { status: "fill", key: rule.key, value: rule.decline, rule, source: "decline" };
      }

      return { status: "unmatched", key: rule.key };
    }

    if (saved?.answer) {
      return { status: "fill", key: "saved-answer", value: saved.answer, rule: null, source: "saved" };
    }

    // Nothing known. The field stays empty — a guess on a real application is
    // worse than a blank the applicant can see and fill in.
    return { status: "unmatched" };
  }

  /* ================================================================== */
  /*  Premium                                                            */
  /* ================================================================== */

  async function pickProfile(session, meta) {
    const profiles = session.profiles ?? [];
    if (!session.premium || profiles.length < 2) return { profile: session.profile, scoring: null };

    const res = await send({
      type: "ZAPPLY_SCORE",
      payload: { jobTitle: meta.jobTitle, company: meta.company, jobDescription: meta.description },
    });
    if (!res?.ok || !res.data?.best) return { profile: session.profile, scoring: null };

    const best = profiles.find((p) => p._id === res.data.best.profileId);
    if (!best) return { profile: session.profile, scoring: null };

    return {
      profile: best,
      scoring: { score: res.data.best.score, reason: res.data.best.reason, label: best.label },
    };
  }

  /**
   * Premium — answers everything the profile and saved answers couldn't cover.
   *
   * Returns why it did nothing as well as how much it drafted. Silence was the
   * problem before: with the setting off, or on a free plan, or with the API
   * key missing, the pass returned 0 and the applicant was told only that some
   * fields "need you" — with no hint that the feature existed or why it had not
   * run. The reason is reported so the popup can say which of those it was.
   */
  /**
   * Questions the model must never be asked.
   *
   * A voluntary self-identification block is the worst possible place for a
   * generated answer: every field in it is a factual declaration on a federal
   * form, and the model has the disability question sitting in its context when
   * it reads the neighbouring "Name" box. That is exactly what happened — the
   * Name field came back "Yes" and Employee ID came back with the applicant's
   * name. Both are now unreachable, three ways over:
   *
   *   - any rule marked `identity` (names, contact details, dates, all EEO);
   *   - any field whose label mentions self-identification, whatever it matched;
   *   - any choice control inside a self-identification section.
   *
   * These questions are answerable from the profile or not at all.
   */
  const SELF_ID_LABEL_RE =
    /(voluntary\s+self[-\s]?identification|self[-\s]?identification\s+of\s+disability|form\s*cc-?305|cc-?305|section\s*503|omb\s*control\s*number\s*1250|voluntary\s+disclosure|equal\s+employment\s+opportunity|eeo)/i;

  function offLimitsToAi(field) {
    if (field.rule?.identity || field.rule?.eeo || field.rule?.blank) return true;
    if (SELF_ID_LABEL_RE.test(field.label || "")) return true;
    try {
      const section = M.visibleText(field.el.closest("fieldset, section, [role='group']"));
      if (section && SELF_ID_LABEL_RE.test(section)) return true;
    } catch {}
    return false;
  }

  async function answerRemaining(session, meta, settings) {
    if (settings.aiAnswers !== true) return { drafted: 0, skipped: "off" };
    if (!session.premium) return { drafted: 0, skipped: "premium" };

    const targets = state.unmatched
      .filter((f) =>
        f.kind !== "file" &&
        !M.hasValue(f.el) &&
        !f.el.__zapplyUserEdited &&
        // Never let the model rewrite a question this pass has already
        // answered from the profile or the applicant's own saved answers.
        !writtenThisRun(f.el) &&
        !offLimitsToAi(f) &&
        document.contains(f.el))
      .filter((f) => {
        if (f.kind === "select" || f.kind === "radio" || f.kind === "checkbox") return true;
        const q = f.label.split(" | ")[0].trim();
        // A keyword list used to decide this, so a genuinely open question the
        // list happened not to name — "Tell me about a time…", "Please provide
        // a brief summary" — was skipped by the one pass meant to catch it.
        // Any labelled question is now attempted; the model is instructed to
        // answer only from the profile, and returns nothing when it can't.
        if (q.length < 4 || q.length > 300) return false;
        return true;
      })
      .slice(0, 60);

    if (!targets.length) return { drafted: 0, skipped: null };

    let done = 0;
    let failed = 0;
    let error = null;
    /**
     * Ask for several answers at once.
     *
     * Every question used to wait for the one before it to come back, so a form
     * with eight of them spent eight round trips end to end — most of the wait
     * was the network sitting idle. The requests now overlap in small groups
     * while the writing stays strictly in page order, which is what keeps one
     * answer from landing in the wrong box.
     *
     * Kept small deliberately: a wide fan-out would race the answer service's
     * own rate limits and turn a slow fill into a failed one.
     */
    const AI_BATCH = 4;
    const prefetch = new Map();

    const requestFor = (field) => {
      if (prefetch.has(field)) return prefetch.get(field);
      const promise = (async () => {
        const options = await optionsFor(field);
        return {
          options,
          res: await send({
            type: "ZAPPLY_ANSWER",
            payload: {
              question: field.label,
              options,
              jobTitle: meta.jobTitle,
              company: meta.company,
              jobDescription: meta.description?.slice(0, 3000),
              profileId: state.profile?._id,
              maxWords: field.kind === "textarea" ? 130 : 40,
              fieldType: field.kind,
              multiple: field.kind === "checkbox" && options.length > 1,
            },
          }),
        };
      })();
      prefetch.set(field, promise);
      return promise;
    };

    for (let i = 0; i < targets.length; i++) {
      const field = targets[i];
      if (state.stopRequested) break;

      // Keep the next few requests in flight while this one is being written.
      for (let ahead = i; ahead < Math.min(targets.length, i + AI_BATCH); ahead++) {
        const next = targets[ahead];
        if (!writtenThisRun(next.el) && !next.el.__zapplyUserEdited) requestFor(next);
      }

      // Re-checked here, not just when the list was built: answering an earlier
      // question can cascade a value into a later one.
      if (writtenThisRun(field.el) || M.hasValue(field.el) || field.el.__zapplyUserEdited) continue;

      const { res } = await requestFor(field);
      if (!res?.ok) {
        // A refused key, an expired plan or a rate limit fails identically for
        // every remaining question, so stop rather than spend the rest of the
        // form rediscovering it — and keep the reason to show the applicant.
        failed++;
        error = res?.error || "The answer service didn't respond.";
        if (failed >= 3) break;
        continue;
      }
      if (!res.data?.answer) continue;

      let answer = res.data.answer;
      if (field.kind !== "checkbox") answer = String(answer).trim();
      else if (typeof answer === "string") {
        try { answer = JSON.parse(answer); } catch { /* comma-separated fallback */ }
      }

      // On a menu, a drafted answer is only usable if it is one of the choices
      // actually on offer. Anything else gets fuzzily matched onto whichever
      // option scores best, which is how a question ends up confidently
      // answered with something the applicant never would have picked. A blank
      // they can see and fill in is the better outcome.
      if (!answerFitsOptions(field, answer) || !answerFitsFormat(field, answer)) {
        state.unmatched.includes(field) || state.unmatched.push(field);
        mark(field.el);
        continue;
      }

      const ok = await applyValue(field, answer, null);

      if (ok) {
        done++;
        state.drafted.add(field.el);
        field.el.classList.remove("zapply-needs-you");
        field.el.classList.add("zapply-drafted");
        flash(field.el);
      }
      await M.waitForMenusClosed(400);
    }
    return { drafted: done, skipped: done ? null : (error ? "error" : null), error };
  }

  /* ================================================================== */
  /*  The run                                                            */
  /* ================================================================== */

  async function run({ manual = false } = {}) {
    /**
     * Autofill has exactly one entry point: a person pressing Fill. There is no
     * longer an `auto` path — see `boot()` — so anything reaching here without
     * a click, including a page mutation or a reload, is refused.
     */
    if (!manual) return { ok: false, error: "manual-start-required" };
    if (state.filling) return { ok: false, error: "Already filling." };

    state.stopRequested = false;
    state.manualSessionActive = true;
    state.completedRun = false;
    // A fresh pass. Anything written by the previous one is fair game again if
    // it somehow ended up empty, but nothing written by *this* one will be.
    state.runId++;

    /**
     * A manual Fill click is an explicit request for the latest profile/settings/
     * Saved Answers state. Never start from a stale cached response list: a user
     * can press Sync in the popup and immediately press Fill on the application,
     * and that click must see the newly synced answers.
     */
    let session = await loadSession(true);
    if (session) state.session = session;
    if (session?.profile) {
      state.profile = null;
      state.scoring = null;
    }
    if (!session?.profile) {
      overlay.show({ tone: "warn", title: "Not connected", body: "Open the Zapply popup and pair with your dashboard." });
      return { ok: false, error: "not-connected" };
    }
    if (isExcluded(session.settings)) return { ok: false, error: "excluded" };

    state.filling = true;
    watchOnFocus();
    document.documentElement.classList.add("zapply-running");
    const started = performance.now();

    const result = { filled: 0, failed: 0, unmatched: 0, detected: 0, keys: [] };

    try {
      const adapter = state.adapter ?? (state.adapter = ATS.detect());
      const settings = session.settings ?? {};
      const meta = ATS.readJobMeta(adapter);

      // The account step is not the application. Passwords are never invented
      // and are only restored from the Saved Answers entry named "Password".
      const authPage = authPageReason();

      if (!state.profile) {
        const picked = await pickProfile(session, meta);
        state.profile = picked.profile;
        state.scoring = picked.scoring;
      }
      const profile = state.profile ?? session.profile;

      if (authPage) {
        // Only the email/username and the user's saved "Password" answer are
        // restored here. There is no separate password field or local fallback.
        M.beginFillSession();
        const emailField = collectFields(adapter).find((f) => f.rule?.key === "email");
        if (emailField && !M.hasValue(emailField.el)) {
          const plan = planField(emailField, profile, session.settings ?? {});
          if (plan.status === "fill") {
            try {
              if (await applyValue(emailField, plan.value, plan.rule)) {
                result.filled = 1;
                result.keys.push("email");
              }
            } catch {}
          }
        }

        // Passwords come only from the user's Saved Answers entry named
        // "Password". There is deliberately no separate browser-local fallback.
        const savedPassword = resolveSavedPassword();
        const accountSettings = await getAccountSettings();
        if (savedPassword) {
          const pwFilled = fillAccountPasswordFields(savedPassword);
          if (pwFilled) {
            result.filled += pwFilled;
            result.keys.push("password");

            if (accountSettings.zapplyAutoSubmitAccount !== false) {
              result.autoSubmitted = await submitAccountWhenReady();
              if (!result.autoSubmitted) {
                result.accountSubmitBlocked = true;
              }
            }
          }
        }

        result.skipped = authPage;
        result.detected = 0;
      }

      // A tiny pause between writes keeps controlled components in sync without
      // being visible. Dropdowns supply their own, longer, settle time.
      const delay = Math.min(120, Math.max(0, Number(settings.fillDelayMs ?? 45)));
      let fields = [];

      if (!authPage) {
      // Remember what the page already shows that merely looks like an open
      // menu, so the engine never waits on — or tries to close — the site's own
      // navigation or styled lists.
      M.beginFillSession();

      await M.closeOpenMenu();

      fields = collectFields(adapter);
      state.allFields = fields;
      state.unmatched = [];
      result.detected = fields.length;

      /* ---- Phase 1: plan everything, write nothing ---- */
      const plans = new Map();
      const pending = [];      // dependent controls — decided after their parent
      for (const field of fields) {
        // A control with no real choices yet cannot be planned: its options
        // arrive only once the field it depends on has been answered.
        if (isAwaitingParent(field)) { pending.push(field); continue; }
        const plan = planField(field, profile, settings);
        plans.set(field, plan);
        if (plan.status === "unmatched") {
          state.unmatched.push(field);
          mark(field.el);
        }
      }

      /* ---- Phase 2: one write per field ----
         Simple controls go first so the form visibly fills straight away, then
         the dropdowns are worked through strictly one at a time. */
      const queue = fields.filter((f) => plans.get(f)?.status === "fill");
      const simple = queue.filter((f) => !isMenuField(f));
      const menus = queue.filter((f) => isMenuField(f));
      const failed = [];
      const waiting = [];

      const write = async (field, { allowDefer = true } = {}) => {
        const plan = plans.get(field);
        if (!plan || plan.status !== "fill") return;
        if (!document.contains(field.el)) return;

        // Hold back a dropdown whose parent has not been answered yet.
        if (allowDefer && isAwaitingParent(field)) { waiting.push(field); return; }

        // Never start a dropdown while another menu is still on screen.
        if (isMenuField(field)) await M.waitForMenusClosed(600);

        let ok = false;
        try { ok = await applyValue(field, plan.value, plan.rule); } catch { ok = false; }

        if (ok) {
          result.filled++;
          if (plan.key) result.keys.push(plan.key);
          field.el.classList.remove("zapply-needs-you");
          flash(field.el);
          if (plan.source === "decline") field.el.classList.add("zapply-drafted");
        } else if (!failed.includes(field)) {
          failed.push(field);
        }
        if (delay) await sleep(delay);
      };

      for (const field of [...simple, ...menus]) {
        if (state.stopRequested) break;
        await write(field);
      }

      // Dependent controls now have their real choices: a State list exists
      // because Country was answered a moment ago, and "Please specify" has a
      // source list because "How did you hear about us?" does. Plan them now,
      // against the options they actually offer.
      const dependents = [...pending, ...waiting];
      if (dependents.length && !state.stopRequested) {
        await sleep(280);
        for (const field of dependents) {
          if (state.stopRequested) break;
          if (!document.contains(field.el)) continue;
          const plan = planField(field, profile, settings);
          plans.set(field, plan);
          if (plan.status === "fill") {
            await write(field, { allowDefer: false });
          } else if (plan.status === "unmatched" && !state.unmatched.includes(field)) {
            state.unmatched.push(field);
            mark(field.el);
          }
        }
      }

      await M.closeOpenMenu();

      /* ---- Extra rows, only for sections that actually answered ----
         These used to be created before anything was written, from the number
         of entries in the profile alone. On a Greenhouse form whose School,
         Degree and Discipline pickers can't be driven, that produced block after
         block of empty "Select..." rows — added, never filled, and left for the
         applicant to delete. A row is now created only after the first one of
         its kind has actually been answered, so a section that cannot be filled
         never grows beyond the one row the page came with. The new rows are
         picked up as fresh fields by the reconcile pass below. */
      if (!state.stopRequested) {
        const answered = new Set(result.keys);
        const kinds = [];
        if ([...EXPERIENCE_KEYS].some((k) => answered.has(k))) kinds.push("experience");
        if ([...EDUCATION_KEYS].some((k) => answered.has(k))) kinds.push("education");
        if (kinds.length) {
          await ensureProfileRows(profile, adapter, kinds);
          await M.closeOpenMenu();
        }
      }

      /* ---- Phase 3: one reconcile pass ----
         Dependent controls (State after Country, questionnaires that unhide on
         an earlier answer) only exist now, and a handful of writes genuinely
         lose a race with a re-render. Both get exactly one more attempt. */
      if (!state.stopRequested) {
        await sleep(220);
        const known = new Set(fields.map((f) => f.el));
        const fresh = collectFields(adapter).filter((f) => !known.has(f.el));
        if (fresh.length) {
          fields.push(...fresh);
          state.allFields = fields;
          result.detected = fields.length;
        }

        const retry = [
          ...fresh.filter((f) => {
            const plan = planField(f, profile, settings);
            plans.set(f, plan);
            if (plan.status === "unmatched") { state.unmatched.push(f); mark(f.el); }
            return plan.status === "fill";
          }),
          ...failed.filter((f) =>
            document.contains(f.el) &&
            !M.hasValue(f.el) &&
            !f.el.__zapplyUserEdited &&
            // The setter already committed something here; we simply cannot
            // read this widget back. Trying again would re-edit a finished
            // field rather than fix anything.
            !writtenThisRun(f.el) &&
            // A dropdown that opened and offered nothing usable is not worth
            // opening again — that second opening is pure visible flicker for
            // a result that cannot change.
            !f.el.__zapplyNoMatch
          ),
        ];

        for (const field of retry) {
          if (state.stopRequested) break;
          const plan = plans.get(field);
          if (!plan || plan.status !== "fill") continue;
          if (isMenuField(field)) await M.waitForMenusClosed(600);

          let ok = false;
          try { ok = await applyValue(field, plan.value, plan.rule); } catch { ok = false; }

          if (ok) {
            result.filled++;
            if (plan.key) result.keys.push(plan.key);
            field.el.classList.remove("zapply-needs-you");
            flash(field.el);
          } else if (!state.unmatched.includes(field)) {
            result.failed++;
            state.unmatched.push(field);
            mark(field.el);
          }
          if (delay) await sleep(delay);
        }

        // Anything that failed twice is the user's to answer, not a silent loss.
        for (const field of failed) {
          if (!state.unmatched.includes(field) && document.contains(field.el) && !M.hasValue(field.el)) {
            state.unmatched.push(field);
            mark(field.el);
          }
        }
      }

      await M.closeOpenMenu();
      state.unmatched = Array.from(new Set(state.unmatched)).filter((f) => document.contains(f.el) && !M.hasValue(f.el));
      result.unmatched = state.unmatched.length;

      if (state.stopRequested) {
        result.stopped = true;
        overlay.show({
          tone: "warn",
          title: `Stopped — ${result.filled} fields filled`,
          body: "Autofill stopped. You can review the form and edit fields manually.",
        });
      } else {
        /* ---- Phase 4: Premium drafts what is left ---- */
        const ai = await answerRemaining(session, meta, settings);
        result.drafted = ai.drafted;
        result.aiSkipped = ai.skipped;
        result.aiError = ai.error ?? null;
        if (result.drafted) {
          result.filled += result.drafted;
          state.unmatched = state.unmatched.filter((f) => !M.hasValue(f.el));
          result.unmatched = state.unmatched.length;
        }

        await sleep(180);
        result.validationErrors = collectRequiredErrors();
        // A validation message means something on this page still needs an
        // answer, so surface the empty fields — but only the empty ones. The
        // old build re-queued every field on the page, which is why the count
        // in the pill was always alarming and mostly wrong.
        if (result.validationErrors.length) {
          for (const field of fields) {
            if (field.kind === "file") continue;
            if (!document.contains(field.el)) continue;
            if (!M.hasValue(field.el) && !state.unmatched.includes(field)) {
              state.unmatched.push(field);
              mark(field.el);
            }
          }
          result.unmatched = state.unmatched.length;
        }
      }
      } // end if (!authPage)
    } finally {
      await M.closeOpenMenu();
      document.documentElement.classList.remove("zapply-running");
      state.filling = false;
      state.manualSessionActive = false;
      state.completedRun = true;
    }

    result.durationMs = Math.round(performance.now() - started);
    result.profileLabel = state.profile?.label ?? null;
    result.matchScore = state.scoring?.score ?? null;
    state.lastRun = result;

    watchUnmatched();
    queueAnswersFromForm();
    scheduleSettleCheck();

    const settings = state.session?.settings ?? {};
    if (settings.showOverlay !== false && result.unmatched && !result.stopped) {
      const scoreLine = state.scoring ? `Profile match: ${state.scoring.score}%. ` : "";
      overlay.show({
        tone: "partial",
        title: `${result.unmatched} field${result.unmatched === 1 ? "" : "s"} need your answer`,
        body:
          scoreLine +
          `${result.validationErrors?.length ? `${result.validationErrors.length} validation message${result.validationErrors.length === 1 ? "" : "s"} detected. ` : ""}` +
          "The highlighted questions were not safely answered.",
        // Three seconds, then out of the way. It used to stay until dismissed,
        // which parked it over the bottom of the form — exactly where the
        // remaining questions are. The fields themselves stay highlighted, so
        // nothing is lost when the pill goes.
        autoHide: 3000,
      });
    } else if (!result.stopped) {
      overlay.hide();
    }

    // One explicit click = one complete fill pass. Never click Save/Next and
    // never start another run from DOM mutations.
    return { ok: true, data: result };
  }

  /** Does filling this control involve opening a popup menu? */
  function isMenuField(field) {
    return field.kind === "select" && field.el.tagName !== "SELECT";
  }

  /* ================================================================== */
  /*  Capturing what the user answers by hand                            */
  /* ================================================================== */

  const pending = new Map();

  function queueAnswer(entry) {
    if (!entry.question || !String(entry.answer ?? "").trim()) return;
    const key = String(entry.question).trim();
    // One question, one queued answer. Several paths can legitimately report the
    // same edit — the control's own change event, a sibling in the same choice
    // group, and the sweep that re-reads everything afterwards — so the queue is
    // made idempotent here rather than relying on each of them to notice.
    // A genuinely different answer still supersedes the old one.
    const previous = pending.get(key);
    if (previous && previous.answer === entry.answer) return;
    pending.set(key, entry);
    state.captured.set(key, entry);
    // Saved Responses are not written to the database here — the user controls
    // persistence with Sync. The background worker keeps a durable local queue.
    send({ type: "ZAPPLY_QUEUE_RESPONSES", responses: [entry] });
  }

  async function flushAnswers() {
    return true;
  }

  /** Reads whatever the user has put in a field, in a comparable form. */
  function readValue(field) {
    const el = field.el;
    if (el.type === "checkbox" || el.getAttribute("role") === "checkbox") {
      const role = el.getAttribute("role");
      const name = el.getAttribute("name");
      const group = role === "checkbox"
        ? (name ? Array.from(document.querySelectorAll(`[role="checkbox"][name="${CSS.escape(name)}"]`)) : Array.from(el.closest("fieldset, [role='group']")?.querySelectorAll('[role="checkbox"]') || [el]))
        : (name ? Array.from(document.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(name)}"]`)) : [el]);
      const checked = group.filter((cb) => role === "checkbox" ? cb.getAttribute("aria-checked") === "true" : cb.checked);
      if (!checked.length) return "No";
      if (group.length === 1) return "Yes";
      return checked.map((cb) => M.radioOptionText(cb)).filter(Boolean).join(", ");
    }
    if (el.type === "radio" || el.getAttribute("role") === "radio") {
      const custom = el.getAttribute("role") === "radio";
      const name = el.getAttribute("name");
      const group = custom
        ? (name
            ? Array.from(document.querySelectorAll(`[role="radio"][name="${CSS.escape(name)}"]`))
            : Array.from(el.closest("fieldset, [role='radiogroup']")?.querySelectorAll('[role="radio"]') || [el]))
        : (name
            ? Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`))
            : [el]);
      const picked = group.find((r) => custom ? r.getAttribute("aria-checked") === "true" : r.checked);
      return picked ? M.radioOptionText(picked) : "";
    }
    if (el.tagName === "SELECT") {
      const opt = el.options[el.selectedIndex];
      return opt && opt.value ? (opt.textContent || "").trim() : "";
    }
    if (el.tagName === "BUTTON" || el.getAttribute("role") === "button" || el.getAttribute("role") === "combobox") {
      return M.comboboxDisplayValue(el);
    }
    return el.value ?? "";
  }

  /**
   * The choices a field offers. Custom dropdowns have to be opened to be read,
   * which is done through the menu registry so the menu is closed again before
   * anything else runs.
   */
  async function optionsFor(field) {
    const el = field.el;
    if (el.tagName === "SELECT") {
      return Array.from(el.options || [])
        .map((o) => (o.textContent || "").trim())
        .filter(Boolean)
        .filter((x) => !/^(select|choose|please select|--)/i.test(x))
        .slice(0, 60);
    }
    if (el.type === "radio" || el.type === "checkbox" ||
        el.getAttribute("role") === "radio" || el.getAttribute("role") === "checkbox") {
      return M.optionTextsFor(el);
    }
    if (field.kind === "select") {
      try { return await M.readComboboxOptions(el, state.adapter?.quirks?.dropdownDelay ?? 800); }
      catch { return []; }
    }
    return [];
  }

  /**
   * The question as a person would read it.
   *
   * `field.label` is several descriptions joined with " | ", ending with the
   * humanized name attribute — so answers were being stored under headings like
   * "Why are you interested in this role? | q why", which is what the dashboard
   * then displayed. The first description is the visible label, and it is also
   * the first candidate findSavedAnswer looks up, so storing it keeps the round
   * trip exact as well as readable.
   */
  /**
   * The question heading that sits above a group of choices.
   *
   * A radio or checkbox is usually wrapped in a <label> holding its *option*
   * text, so the derived label starts with "Referral" or "Evenings" — and those
   * were being stored as the question. The real question is the nearest heading
   * in the group container that isn't itself an option.
   */
  function questionHeadingNear(el) {
    let node = el.parentElement;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      if (node === document.body || node === document.documentElement) break;
      let candidates;
      try {
        candidates = node.querySelectorAll(
          'legend, p, h2, h3, h4, h5, [class*="question"], [class*="Question"], label, span, div'
        );
      } catch { break; }
      for (const cand of candidates) {
        if (cand.contains(el)) continue;
        // A node wrapping a control is an option label, not the question.
        if (cand.querySelector("input, select, textarea, button, [role='radio'], [role='checkbox']")) continue;
        const text = (cand.textContent || "").trim().replace(/\s+/g, " ");
        if (text.length >= 8 && text.length <= 300) return text;
      }
    }
    return "";
  }

  /**
   * The question as a person would read it.
   *
   * `field.label` is several descriptions joined with " | ", ending with the
   * humanized name attribute. The first description is normally the visible
   * label — except on choice groups, where it is the option the person picked.
   */
  function primaryQuestion(field) {
    const parts = String(field?.label ?? "").split("|").map((x) => x.trim()).filter(Boolean);
    const isChoice = field?.kind === "radio" || field?.kind === "checkbox";

    const looksMachineGenerated = (text) => {
      const s = String(text ?? "").trim();
      if (!s) return true;
      if (/^(?:data[-_]|test[-_]|qa[-_]|automation[-_]|field[-_]|question[-_]|input[-_])/i.test(s)) return true;
      if (/\b(?:gh|greenhouse|lever|ashby)\b.*\b(?:quest|question|checkbox|radio)\b/i.test(s) && /[0-9a-f]{8,}/i.test(s)) return true;
      if (/[0-9a-f]{8}(?:[- ]+[0-9a-f]{4}){1,3}[- ]*[0-9a-f]{0,12}/i.test(s) && /\b(?:quest|question|checkbox|radio|field)\b/i.test(s)) return true;
      return false;
    };

    if (isChoice) {
      // Choice controls often expose an option label as their first derived
      // description. Prefer the human-visible question heading before any
      // machine id (Workday/Greenhouse test ids were being stored as the
      // question, making Pending/Saved Answers unreadable).
      const heading = questionHeadingNear(field.el);
      if (heading && !looksMachineGenerated(heading)) return heading;

      let options = [];
      try { options = (M.optionTextsFor(field.el) || []).map((o) => o.toLowerCase()); } catch {}
      const notAnOption = parts.find(
        (p) => !options.includes(p.toLowerCase()) && (p.length > 12 || /\?$/.test(p)) && !looksMachineGenerated(p)
      );
      if (notAnOption) return notAnOption;
    }

    const visible = parts.find((p) => !looksMachineGenerated(p));
    return visible || parts[0] || "";
  }

  /** Every control that answers the same question as this one. */
  function groupMembersOf(el) {
    try {
      const segments = M.choiceButtonGroup?.(el);
      if (segments?.length) return segments;
      const type = (el.type || "").toLowerCase();
      const role = el.getAttribute?.("role");
      if (type === "radio" || role === "radio") return M.radioGroup(el);
      if (type === "checkbox" || role === "checkbox") {
        const name = el.getAttribute("name");
        if (name) {
          const sel = role === "checkbox"
            ? `[role="checkbox"][name="${CSS.escape(name)}"]`
            : `input[type="checkbox"][name="${CSS.escape(name)}"]`;
          return Array.from(document.querySelectorAll(sel));
        }
        const box = el.closest("fieldset, [role='group']");
        if (box) return Array.from(box.querySelectorAll('input[type="checkbox"], [role="checkbox"]'));
      }
    } catch {}
    return [el];
  }

  /** Is the value in this control simply the one Zapply put there? */
  function matchesWritten(el, answer) {
    const written = el.__zapplyWrittenValue;
    if (written == null) return false;
    try {
      const a = M.normalizeChoiceText(String(answer));
      const b = M.normalizeChoiceText(String(written));
      if (!a || !b) return false;
      return a === b || a.includes(b) || b.includes(a);
    } catch {
      return String(answer) === String(written);
    }
  }

  /**
   * Queue whatever this control currently holds, if it is the applicant's.
   *
   * `userDriven` means an event proved a person did it. The sweep has no such
   * proof, so it additionally refuses anything that still matches what Zapply
   * wrote — otherwise re-running a fill would bank the whole form as answers.
   */
  /**
   * An answer the applicant typed is held, not banked.
   *
   * Every edit used to go straight into the sync queue. That is how a wrong
   * value became a permanent one: the AI put "Yes" in a Name box, the applicant
   * corrected it, and *both* the correction and the original were captured
   * against questions they had never knowingly saved — so the next application
   * was filled from the same bad queue. Worse, there was no moment at which
   * they were told any of it was being kept.
   *
   * An edit now lands here and stays visible as an unsaved answer until it is
   * explicitly saved. Nothing reaches Saved Answers without a click.
   */
  const pendingSave = new Map();   // question -> { entry, field }

  function holdAnswer(field, entry) {
    pendingSave.set(entry.question, { entry, field });
    try { field.el.classList.add("zapply-unsaved"); } catch {}
    /**
     * Held in extension storage, not in this Map.
     *
     * The Map is kept only to know which control on *this* page to outline and
     * to clear the outline when the answer is saved. It cannot be the record:
     * a Workday application navigates on every step, each navigation tears this
     * content script down, and the Map went with it — so an answer edited on
     * step 2 was gone before the applicant reached the popup. That is why
     * saving answers looked like it did nothing.
     *
     * Storage survives navigation, reload and closing the tab, and the popup
     * reads it from there, so it works even on a page where this script never
     * loaded.
     */
    send({ type: "ZAPPLY_HOLD_ANSWERS", items: [entry] });
    publishPending();
  }

  /** Nudge any open popup to re-read the held list. */
  function publishPending() {
    const items = Array.from(pendingSave.values()).map(({ entry }) => ({
      question: entry.question,
      answer: entry.answer,
      inputType: entry.inputType,
      options: entry.options,
      ats: entry.ats,
      domain: entry.domain,
    }));
    try {
      chrome.runtime.sendMessage({ type: "ZAPPLY_PENDING", items, url: location.href });
    } catch {}
  }

  function commitPendingAnswers() {
    const held = Array.from(pendingSave.values());
    for (const { field } of held) {
      try {
        field.el.classList.remove("zapply-unsaved");
        field.el.classList.add("zapply-saved");
      } catch {}
    }
    pendingSave.clear();
    // Saving is done against storage, so it covers answers held on earlier
    // steps of this application as well as the ones still on screen.
    send({ type: "ZAPPLY_SAVE_HELD" });
    publishPending();
    return held.length;
  }

  function discardPendingAnswers() {
    for (const { field } of pendingSave.values()) {
      try { field.el.classList.remove("zapply-unsaved"); } catch {}
    }
    pendingSave.clear();
    publishPending();
  }

  /**
   * Saving and discarding are now driven from the extension popup, which is
   * where the applicant can see a pending answer beside the saved ones it would
   * join. Nothing about the hold model changed: an edit is still held, and still
   * reaches Saved Answers only on an explicit action.
   */
  function handlePendingCommand(msg, respond) {
    if (msg.type === "ZAPPLY_PENDING_LIST") {
      respond({
        ok: true,
        items: Array.from(pendingSave.values()).map(({ entry }) => ({
          question: entry.question,
          answer: entry.answer,
          inputType: entry.inputType,
          domain: entry.domain,
        })),
      });
      return true;
    }
    if (msg.type === "ZAPPLY_PENDING_SAVE") {
      const saved = msg.question ? commitOne(msg.question) : commitPendingAnswers();
      respond({ ok: true, saved });
      return true;
    }
    if (msg.type === "ZAPPLY_PENDING_DISCARD") {
      if (msg.question) {
        const held = pendingSave.get(msg.question);
        if (held) { try { held.field.el.classList.remove("zapply-unsaved"); } catch {} }
        pendingSave.delete(msg.question);
        send({ type: "ZAPPLY_DISCARD_HELD", questions: [msg.question] });
        publishPending();
      } else {
        discardPendingAnswers();
        send({ type: "ZAPPLY_DISCARD_HELD" });
      }
      respond({ ok: true });
      return true;
    }
    return false;
  }

  function commitOne(question) {
    const held = pendingSave.get(question);
    if (held) {
      try {
        held.field.el.classList.remove("zapply-unsaved");
        held.field.el.classList.add("zapply-saved");
      } catch {}
      pendingSave.delete(question);
    }
    send({ type: "ZAPPLY_SAVE_HELD", questions: [question] });
    publishPending();
    return 1;
  }

  function worthSaving(field, answer) {
    const el = field.el;
    const text = String(answer ?? "");
    if (!text) return false;

    const cap = Number(el?.getAttribute?.("maxlength") ?? el?.maxLength ?? 0);
    if (cap > 0 && text.length > cap) return false;

    // The page's own verdict. If it is showing an error for this field, its
    // current contents are by definition not an answer worth reusing.
    try {
      if (el.getAttribute?.("aria-invalid") === "true") return false;
      const described = el.getAttribute?.("aria-describedby");
      if (described) {
        for (const id of described.split(/\s+/)) {
          const node = document.getElementById(id);
          const msg = node && M.visibleText(node);
          if (msg && /\b(enter a maximum|maximum of \d+|too long|invalid|must be|required)\b/i.test(msg)) return false;
        }
      }
    } catch {}

    // A short structured box holding a sentence is a box something got wrong.
    const structured = /suffix|prefix|title|initial|city|state|county|district|zip|postal|country|line\s*\d/i;
    if (structured.test(field.label || "") && (text.length > 100 || /\.\s+\S/.test(text))) return false;

    // The same fragment repeated back to back is the accumulation signature.
    if (/(\b[A-Za-z]{4,}\b)\1/.test(text.replace(/\s+/g, ""))) return false;

    return true;
  }

  function recordAnswer(field, { userDriven }) {
    const el = field.el;
    if (!document.contains(el)) return false;

    // The background sync queue is a review queue for answers the applicant
    // supplied, not a dump of everything Zapply filled. A sweep is only allowed
    // to capture a field after a trusted user interaction marked it edited.
    // This is especially important after dropdown/radio/checkbox fills, whose
    // own trailing change/click events can fire after the programmatic flag has
    // expired and previously caused the whole filled form to appear as pending.
    if (!userDriven && !el.__zapplyUserEdited) return false;

    const answer = String(readValue(field) ?? "").trim();
    if (!answer) return false;
    if (/^(select|choose|please select|--)/i.test(answer)) return false;
    if (el.__zapplyLastCaptured === answer) return false;
    if (!userDriven && !el.__zapplyUserEdited && matchesWritten(el, answer)) return false;

    // readValue reports an empty checkbox group as "No". That is the right
    // reading for a single "I agree" box the person deliberately left clear,
    // but for a group nobody has touched yet it is not an answer at all.
    if (field.kind === "checkbox") {
      const members = groupMembersOf(el);
      const anyTicked = members.some((m) => m.checked === true || m.getAttribute?.("aria-checked") === "true");
      // An unchecked checkbox group is an empty field, not a reusable "No"
      // answer. Never save that empty state back into Saved Answers.
      if (!anyTicked) return false;
    }

    const question = primaryQuestion(field);
    if (question.length < 5 || question.length > 300) return false;

    el.__zapplyLastCaptured = answer;
    if (!worthSaving(field, answer)) return false;
    holdAnswer(field, {
      question,
      answer,
      inputType: field.kind,
      options:
        field.el.tagName === "SELECT" || field.kind === "radio" || field.kind === "checkbox"
          ? M.optionTextsFor(field.el)
          : [],
      ats: state.adapter?.key,
      domain: location.hostname,
      source: "user",
    });
    el.classList.remove("zapply-needs-you");
    return true;
  }

  /**
   * Every control being watched, re-read after anything the person does.
   *
   * Listeners alone only ever caught typing. A native <select> fires `change`
   * on itself, but a custom dropdown paints its answer into a button while the
   * click lands on an option in a portal somewhere else in the document, and a
   * radio group fires on whichever member was clicked rather than the one the
   * field was anchored to. All of those went unrecorded, which is why picking a
   * dropdown or radio answer never produced anything to sync.
   */
  const watched = new Map();
  let sweepTimer = null;

  function sweepWatched() {
    for (const [el, field] of watched) {
      if (!document.contains(el)) { watched.delete(el); continue; }
      // Still inside the window that marks this control as ours — but only
      // while it still holds what we wrote. A value that has changed since was
      // changed by someone, and that someone is not us, so an edit made
      // straight after a fill is recorded rather than swallowed.
      if (isProgrammatic(el)) {
        const current = String(readValue(field) ?? "").trim();
        if (!current || matchesWritten(el, current)) continue;
      }
      // For a field the profile owns, only a proven edit counts. The sweep has
      // no proof, so it leaves those alone rather than re-banking the value the
      // profile just supplied.
      if (field.rule && PROFILE_OWNED_KEYS.has(field.rule.key) && !el.__zapplyUserEdited) continue;
      try { recordAnswer(field, { userDriven: false }); } catch {}
    }
  }

  function scheduleSweep() {
    clearTimeout(sweepTimer);
    // Long enough for a menu to close and the widget to paint its choice.
    sweepTimer = setTimeout(sweepWatched, 350);
  }

  let sweepStarted = false;
  function startSweep() {
    if (sweepStarted) return;
    sweepStarted = true;
    ["click", "change", "keyup", "focusout"].forEach((type) =>
      document.addEventListener(type, scheduleSweep, true)
    );
  }

  function captureOn(field) {
    if (field.el.__zapplyWatched || field.el.__zapplyGroupWatched) return;
    field.el.__zapplyWatched = true;
    // The whole group answers one question, so no other member may be watched
    // separately — otherwise focusing a second radio queued the same answer
    // twice, once against each element's own bookkeeping.
    groupMembersOf(field.el).forEach((m) => { m.__zapplyGroupWatched = true; });
    watched.set(field.el, field);
    startSweep();

    const capture = () => {
      if (!isProgrammatic(field.el)) {
        // Once the user edits a field it is user-owned for this session.
        field.el.__zapplyUserEdited = true;
      } else {
        return;
      }
      recordAnswer(field, { userDriven: true });
    };

    // A setter marks a control as ours for up to 1.5s so the widget's own
    // trailing events aren't mistaken for typing. A real key press or click is
    // proof the person has taken over, so it ends that window immediately —
    // otherwise an edit made straight after a fill was silently discarded.
    const releaseToUser = (e) => {
      if (!e.isTrusted) return;
      field.el.__zapplyProgrammatic = false;
      field.el.__zapplyProgrammaticUntil = 0;
    };
    // Any of these can only come from a real person: the browser marks events
    // it synthesises for page scripts as untrusted. A trusted `input` is the
    // one that matters most — typing over an AI draft produces it, and without
    // it that edit was dropped for the first second and a half after a fill.
    ["keydown", "pointerdown", "beforeinput", "input", "paste", "cut"].forEach((type) =>
      field.el.addEventListener(type, releaseToUser, true)
    );

    field.el.addEventListener("input", () => {
      if (!isProgrammatic(field.el)) field.el.__zapplyUserEdited = true;
    }, true);
    field.el.addEventListener("blur", capture, true);
    field.el.addEventListener("change", capture);

    // A segmented control answers on a click, and the person may well click the
    // segment that isn't the one we anchored the field to.
    const segments = M.choiceButtonGroup?.(field.el);
    if (segments?.length) {
      segments.forEach((seg) => {
        seg.addEventListener("pointerdown", releaseToUser, true);
        seg.addEventListener("click", () => setTimeout(capture, 250));
      });
    } else if (field.el.tagName === "BUTTON") {
      field.el.addEventListener("click", () => setTimeout(capture, 700));
    }

    // Native radio and checkbox groups fire on whichever member was clicked,
    // not on the one this field is anchored to.
    if (field.kind === "radio" || field.kind === "checkbox") {
      try {
        M.radioGroup?.(field.el)?.forEach((member) => {
          if (member === field.el) return;
          member.addEventListener("pointerdown", releaseToUser, true);
          member.addEventListener("change", capture);
        });
      } catch {}
    }
  }

  /**
   * Rule keys whose answer belongs to the profile rather than to Saved Answers.
   *
   * Everything else is watched, which is the fix for "I corrected the answer and
   * it never saved". The old rule was `if (field.rule) return` — any field a
   * rule had matched was excluded from capture entirely, so changing a notice
   * period from "2 weeks" to "30 days", or a work-authorisation answer from Yes
   * to No, was never recorded and the stale answer stayed in the dashboard.
   *
   * Identity, contact, history and voluntary-disclosure fields stay out: they
   * are edited in the profile, and copying a name or an EEO answer into a
   * question bank would be both noise and a privacy problem.
   */
  const PROFILE_OWNED_KEYS = new Set([
    "firstName", "lastName", "middleName", "preferredName", "fullName", "signature",
    "dateOfBirth", "email", "emailConfirm",
    "phone", "phoneCountryCode", "phoneType",
    "address", "addressLine2", "city", "state", "zip", "location",
    "linkedin", "github", "portfolio", "twitter",
    "resume", "coverLetter",
    // Repeated history rows are positional — "Company (row 2)" means nothing on
    // the next site — so they are answered from the profile, never banked.
    "currentCompany", "currentTitle", "experienceLocation", "responsibilities",
    "experienceStartDate", "experienceEndDate", "experienceDatePart",
    "experienceStartMonth", "experienceStartYear", "experienceEndMonth", "experienceEndYear",
    "school", "educationLocation", "graduationDate", "educationDatePart",
    "educationStartMonth", "educationStartYear", "educationEndMonth", "educationEndYear",
  ]);

  function watchUnmatched() {
    state.unmatched.forEach(captureOn);
    state.drafted.forEach((el) => {
      const field = state.allFields?.find((f) => f.el === el);
      if (field) captureOn(field);
    });
    (state.allFields ?? []).forEach((field) => {
      if (field.kind === "file") return;
      if (field.rule && PROFILE_OWNED_KEYS.has(field.rule.key)) return;
      captureOn(field);
    });
  }

  /**
   * Does a drafted answer have the shape this field will accept?
   *
   * Asked for a LinkedIn profile it has no URL for, the model answers in
   * sentences — "I do not have a LinkedIn profile or social network account" —
   * which is a perfectly sensible reply and completely unusable. Workday
   * rejects it as an invalid URL and the applicant is left holding a validation
   * error they did nothing to cause. A blank is what they wanted anyway.
   */
  function answerFitsFormat(field, answer) {
    const el = field.el;
    const text = String(Array.isArray(answer) ? answer.join(", ") : answer ?? "").trim();
    if (!text) return false;
    const type = (el.getAttribute?.("type") || "").toLowerCase();
    const label = String(field.label ?? "");

    const wantsUrl =
      type === "url" ||
      /\b(url|link|linked-?in|git-?hub|portfolio|website|web\s*site|profile\s*(link|url))\b/i.test(label);
    if (wantsUrl) {
      return /^(https?:\/\/|www\.)\S+$/i.test(text) || /^[\w-]+(\.[\w-]+)+\/\S*$/i.test(text);
    }

    if (type === "email" || /\be-?mail\b/i.test(label)) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
    }

    if (type === "tel" || /\b(phone|mobile|telephone)\b/i.test(label)) {
      return (text.match(/\d/g) || []).length >= 7;
    }

    return true;
  }

  /**
   * Is a drafted answer one of the choices this control actually offers?
   *
   * Free-text fields have nothing to check against, so they always pass.
   */
  function answerFitsOptions(field, answer) {
    const isChoice = field.kind === "select" || field.kind === "radio" || field.kind === "checkbox";
    if (!isChoice) return true;

    let choices = [];
    try { choices = M.optionTextsFor(field.el) || []; } catch {}
    // A remote menu that has not loaded yet offers nothing to compare against;
    // the setter opens it and does its own matching from there.
    if (!choices.length) return true;

    const norm = (x) => {
      try { return M.normalizeChoiceText(String(x)); } catch { return String(x).toLowerCase().trim(); }
    };
    const wanted = Array.isArray(answer) ? answer : [answer];
    const normalised = choices.map(norm).filter(Boolean);

    return wanted.every((one) => {
      const a = norm(one);
      if (!a) return false;
      return normalised.some((b) => a === b || a.includes(b) || b.includes(a));
    });
  }

  /**
   * Offer every answer now in the form for saving.
   *
   * Capture used to record only what the applicant typed, on the reasoning that
   * Zapply already knew everything else. But the queue is the review step before
   * anything reaches the dashboard, and an answer is worth keeping whoever
   * produced it — the profile, a saved answer, the model, or the applicant. A
   * dropdown and a radio group are answers too, which is why this walks the
   * fields rather than listening for typing.
   *
   * Identity and contact details are still left out: a name or a phone number is
   * profile data, not an answer to a question, and banking it would mean the
   * next form fills it from a stale copy. Empty fields queue nothing, because
   * there is no answer yet to save.
   */
  function queueAnswersFromForm() {
    for (const field of state.allFields ?? []) {
      try {
        if (field.kind === "file") continue;
        if (field.rule && PROFILE_OWNED_KEYS.has(field.rule.key)) continue;
        if (!document.contains(field.el)) continue;

        const answer = String(readValue(field) ?? "").trim();
        if (!answer) continue;

        // Already saved with exactly this answer — re-queueing it would just be
        // noise in a list meant for reviewing what changed.
        const saved = findSavedAnswer(field);
        if (saved?.exact && String(saved.answer).trim() === answer) continue;

        recordAnswer(field, { userDriven: true });
      } catch {}
    }
  }

  /**
   * Attach the capture listeners without filling anything.
   *
   * These used to be attached only at the end of a fill, so a person who opened
   * an application and simply typed their answers — never pressing Fill — had
   * nothing recorded at all.
   */
  function watchPage() {
    try {
      const adapter = state.adapter ?? (state.adapter = ATS.detect());
      const fields = collectFields(adapter);
      if (!state.allFields?.length) state.allFields = fields;
      else {
        const known = new Set(state.allFields.map((f) => f.el));
        state.allFields.push(...fields.filter((f) => !known.has(f.el)));
      }
      watchUnmatched();
    } catch {}
  }

  /**
   * Anything the person focuses is watched from that moment on. A single scan
   * can't see fields a step hasn't rendered yet, and focus is the cheapest
   * possible signal that a control is about to be answered.
   */
  function watchOnFocus() {
    document.addEventListener("focusin", (event) => {
      const el = event.target;
      try {
        if (!el || el.__zapplyWatched || el.__zapplyGroupWatched || el.__zapplyIgnored) return;
        if (!M.isFillable(el)) return;
        if (["submit", "reset", "button", "image", "file"].includes(el.type)) return;
        if (inPageChrome(el)) { el.__zapplyIgnored = true; return; }
        const label = M.deriveLabel(el);
        const rule = M.matchRule(el, label, RULES);
        /**
         * Profile-owned fields are not banked as answers. This was opened up in
         * 1.8.0 so hand-corrections could be saved, and that was a mistake: an
         * email address captured off one form is an *answer* to a question whose
         * wording resembles half the contact boxes on the next one, so it came
         * back in the phone field. Contact details and identity belong in the
         * profile, which is the only place they can be stored once and used
         * everywhere without being matched by question text.
         */
        if (rule && PROFILE_OWNED_KEYS.has(rule.key)) { el.__zapplyIgnored = true; return; }
        captureOn({ el, label, kind: M.fieldKind(el), rule });
      } catch {}
    }, true);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAnswers();
  });
  window.addEventListener("pagehide", flushAnswers);

  /* ================================================================== */
  /*  Submit detection + sync                                            */
  /* ================================================================== */

  function watchSubmit() {
    const report = () => {
      const settings = state.session?.settings ?? {};
      const meta = ATS.readJobMeta(state.adapter ?? ATS.detect());
      const responses = Array.from(state.captured.values());

      flushAnswers();
      const payload = { responses };
      if (settings.trackAutomatically !== false && state.lastRun) {
        payload.application = {
          jobTitle: meta.jobTitle,
          company: meta.company,
          companyDomain: meta.companyDomain,
          location: meta.location,
          url: meta.url,
          ats: meta.ats,
          autofill: {
            fieldsDetected: state.lastRun.detected,
            fieldsFilled: state.lastRun.filled,
            durationMs: state.lastRun.durationMs,
          },
        };
      }
      if (payload.application || responses.length) send({ type: "ZAPPLY_SYNC", payload });
      state.captured.clear();
    };

    document.addEventListener("submit", () => setTimeout(report, 300), true);

    document.addEventListener(
      "click",
      (e) => {
        const btn = e.target?.closest?.('button, input[type="submit"], a[role="button"]');
        if (!btn) return;
        const text = (btn.textContent || btn.value || "").trim().toLowerCase();
        if (/^(submit|submit application|apply|send application|finish|complete)/.test(text)) {
          setTimeout(report, 700);
        }
      },
      true
    );
  }

  /* ================================================================== */
  /*  Visual feedback                                                    */
  /* ================================================================== */

  function flash(el) {
    el.classList.add("zapply-filled");
    setTimeout(() => el.classList.remove("zapply-filled"), 1200);
  }
  function mark(el) {
    el.classList.add("zapply-needs-you");
  }

  const overlay = {
    node: null,
    timer: null,
    ensure() {
      if (this.node?.isConnected) return this.node;
      const el = document.createElement("div");
      el.className = "zapply-pill";
      el.innerHTML = `
        <span class="zapply-pill__dot"></span>
        <span class="zapply-pill__text">
          <span class="zapply-pill__title"></span>
          <span class="zapply-pill__body"></span>
        </span>
        <button class="zapply-pill__stop" type="button">Stop</button>
        <button class="zapply-pill__close" aria-label="Dismiss">&times;</button>`;
      el.querySelector(".zapply-pill__close").addEventListener("click", () => this.hide());
      el.querySelector(".zapply-pill__stop").addEventListener("click", async () => {
        state.stopRequested = true;
        state.manualSessionActive = false;
        await send({ type: "ZAPPLY_STOP" });
        el.querySelector(".zapply-pill__stop").disabled = true;
        el.querySelector(".zapply-pill__stop").textContent = "Stopping…";
      });
      (document.body || document.documentElement).appendChild(el);
      this.node = el;
      return el;
    },
    show({ tone = "busy", title, body, autoHide = false }) {
      const el = this.ensure();
      el.dataset.tone = tone;
      el.querySelector(".zapply-pill__title").textContent = title;
      el.querySelector(".zapply-pill__body").textContent = body ?? "";
      const stop = el.querySelector(".zapply-pill__stop");
      stop.disabled = !state.filling;
      stop.textContent = "Stop";
      stop.hidden = !state.filling;
      el.classList.add("zapply-pill--visible");
      clearTimeout(this.timer);
      // `autoHide` may be a duration in milliseconds or just `true` for the
      // default. It was previously a flag with one hard-coded delay, so a
      // caller asking for three seconds silently got four and a half.
      const delay = typeof autoHide === "number" ? autoHide : autoHide ? 4500 : 0;
      if (delay > 0) this.timer = setTimeout(() => this.hide(), delay);
    },
    hide() {
      this.node?.classList.remove("zapply-pill--visible");
    },
  };

  /* Cross-origin iframe support: many enterprise ATSs embed the application
   * inside a same-page iframe. The content script already runs in all frames;
   * this relay lets the top frame's toolbar command reach child frames. */
  function relayToChildFrames(type) {
    if (window.top !== window) return;
    document.querySelectorAll("iframe, frame").forEach((frame) => {
      try { frame.contentWindow?.postMessage({ source: "zapply", type }, "*"); } catch {}
    });
  }

  window.addEventListener("message", (event) => {
    if (event?.data?.source !== "zapply") return;
    if (event.data.type === "ZAPPLY_RUN" && window.top !== window) run({ manual: true });
    if (event.data.type === "ZAPPLY_STOP") {
      state.stopRequested = true;
      state.manualSessionActive = false;
    }
  });

  /* ================================================================== */
  /*  Boot                                                               */
  /* ================================================================== */

  async function loadSession(force = false) {
    const res = await send({ type: "ZAPPLY_GET_SESSION", force });
    if (res?.ok) state.session = res.data;
    return state.session;
  }

  async function boot() {
    if (!isApplicationPage()) return;
    state.adapter = ATS.detect();

    const session = await loadSession();
    if (!session?.profile) return;
    if (isExcluded(session.settings)) return;

    watchSubmit();

    // Answers typed by hand are recorded from now on, whether or not a fill is
    // ever run on this page, and whether or not this posting turns out to be a
    // duplicate below.
    watchOnFocus();
    watchPage();
    watchValidation();
    startSweep();

    const meta = ATS.readJobMeta(state.adapter);
    const dupe = await send({
      type: "ZAPPLY_CHECK",
      payload: { url: meta.url, jobTitle: meta.jobTitle, company: meta.company },
    });

    if (dupe?.ok && dupe.data?.duplicate) {
      state.duplicate = dupe.data.application;
      const when = new Date(state.duplicate.appliedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      overlay.show({
        tone: "warn",
        title: "You already applied to this",
        body: `Sent ${when} — currently "${state.duplicate.stage}". Click the Zapply icon to fill it anyway.`,
      });
      return; // manual fill still works via the popup
    }

    /**
     * Nothing is filled here. Ever.
     *
     * `boot()` used to honour a "Fill as soon as a form loads" setting with one
     * pass. One pass per load is still one pass per *reload* — and a Workday
     * application reloads itself constantly: a validation error, a step change,
     * a tab switched back to. Every one of those restarted a fill over answers
     * the applicant had already corrected by hand, which is the behaviour
     * reported as "when we refresh the tab it fills the form again".
     *
     * The setting is ignored rather than merely defaulted off, so an account
     * that switched it on in the past does not keep the old behaviour. Filling
     * now has exactly one trigger: the Fill button (or its keyboard shortcut).
     */
    if (state.duplicate) return;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // Test hook. Only ever attached when a harness sets the flag before the
  // content script loads, so nothing is exposed to real pages.
  if (window.__ZAPPLY_TEST === true) {
    window.__zapply = { run, collectFields, planField, state, M, RULES };
  }
})();
