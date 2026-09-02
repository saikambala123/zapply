/** Zapply popup: pairing, one-click fill, quick settings. */

const $ = (id) => document.getElementById(id);

const send = (message) =>
  new Promise((resolve) => chrome.runtime.sendMessage(message, (res) => resolve(res ?? { ok: false })));

/**
 * [key, label, defaultsOn]
 *
 * The three that default to off all write something the applicant did not
 * state — an overwrite of an answer already in the form, a résumé attachment,
 * or a "decline to self-identify" on a voluntary question. Each one is a
 * deliberate choice, so each one is opt-in.
 */
const TOGGLES = [
  ["showOverlay", "Show the status pill", true],
  ["trackAutomatically", "Track applications", true],
  ["reuseSavedResponses", "Reuse saved answers", true],
  // The dashboard has always had this switch and the popup never showed it, so
  // the one feature meant to handle questions the profile can't answer was
  // unreachable from the extension. It stays off by default: a generated answer
  // is a draft the applicant has to read before submitting.
  ["aiAnswers", "Answer unknown questions with AI", false],
  ["overwriteExisting", "Replace answers already in the form", false],
  ["autoAttachResume", "Attach my resume automatically", false],
  ["eeoFallbackDecline", "Answer EEO questions with “decline to self-identify”", false],
];

let session = null;

/* ------------------------------------------------------------------ */
/*  Pairing view                                                       */
/* ------------------------------------------------------------------ */

function showPairView() {
  $("view-pair").hidden = false;
  $("view-main").hidden = true;
  // Ask the worker for the packaged default rather than assuming localhost —
  // a released build points at the deployed app, not the user's own machine.
  chrome.storage.local.get("apiBase", ({ apiBase }) => {
    if (apiBase) { $("apiBase").value = apiBase; return; }
    send({ type: "ZAPPLY_GET_API_BASE" }).then((res) => {
      $("apiBase").value = res?.data?.apiBase || "http://localhost:3000";
    });
  });
}

$("code").addEventListener("input", (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  $("pair-error").hidden = true;
});

$("code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("pair-btn").click();
});

$("pair-btn").addEventListener("click", async () => {
  const code = $("code").value.trim();
  if (code.length !== 6) {
    $("pair-error").textContent = "Enter all six characters from your dashboard.";
    $("pair-error").hidden = false;
    return;
  }

  $("pair-btn").disabled = true;
  $("pair-btn").textContent = "Connecting…";

  const res = await send({ type: "ZAPPLY_PAIR", code, apiBase: $("apiBase").value.trim() });

  $("pair-btn").disabled = false;
  $("pair-btn").textContent = "Connect";

  if (!res.ok) {
    $("pair-error").textContent = res.error || "That code didn't work.";
    $("pair-error").hidden = false;
    return;
  }

  session = res.data.session;
  renderMain();
});

$("open-dashboard").addEventListener("click", () => send({ type: "ZAPPLY_OPEN_DASHBOARD" }));
$("open-dashboard-2").addEventListener("click", () => send({ type: "ZAPPLY_OPEN_DASHBOARD" }));

/* ------------------------------------------------------------------ */
/*  Main view                                                          */
/* ------------------------------------------------------------------ */

function renderMain() {
  $("view-pair").hidden = true;
  $("view-main").hidden = false;

  $("plan-badge").hidden = !session?.premium;

  // Profiles
  const select = $("profile-select");
  select.innerHTML = "";
  (session?.profiles ?? []).forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p._id;
    opt.textContent = p.label || "Profile";
    opt.selected = p._id === session.profile?._id;
    select.appendChild(opt);
  });
  select.disabled = (session?.profiles?.length ?? 0) < 2;

  // Stats
  refreshPending();
  chrome.storage.local.get("stats", ({ stats }) => {
    $("stat-apps").textContent = stats?.applications ?? 0;
  });

  // Toggles
  const wrap = $("toggles");
  wrap.innerHTML = "";
  TOGGLES.forEach(([key, label, defaultsOn]) => {
    const row = document.createElement("label");
    row.className = "toggle";
    row.innerHTML = `<span>${label}</span>`;
    const input = document.createElement("input");
    input.type = "checkbox";
    const stored = session?.settings?.[key];
    input.checked = stored === undefined ? Boolean(defaultsOn) : stored === true;
    input.addEventListener("change", () => saveSetting(key, input.checked));
    row.appendChild(input);
    wrap.appendChild(row);
  });

  refreshPageStatus();
  loadAccountCreds();
}

/* ------------------------------------------------------------------ */
/*  Workday account sign-in / create-account                           */
/* ------------------------------------------------------------------ */

/*
 * Passwords are intentionally NOT entered or stored from this popup. The
 * content script resolves the Saved Answers entry named "Password". This
 * toggle controls only whether a saved password is submitted automatically.
 * Remove the legacy local password key once so an older build cannot continue
 * to act as a fallback.
 */
function loadAccountCreds() {
  chrome.storage.local.get(["zapplyAutoSubmitAccount"], (r) => {
    $("account-autosubmit").checked = r.zapplyAutoSubmitAccount !== false;
  });
}

$("account-autosubmit").addEventListener("change", () => {
  chrome.storage.local.set({ zapplyAutoSubmitAccount: $("account-autosubmit").checked });
  try { chrome.storage.local.remove(["zapplyAccountPassword"]); } catch {}
});
try { chrome.storage.local.remove(["zapplyAccountPassword"]); } catch {}


/* ------------------------------------------------------------------ */
/*  Saved answers waiting to sync                                      */
/* ------------------------------------------------------------------ */

/**
 * Answers captured on a form live in a local queue until the user presses
 * "Sync now". Showing the count alone left no way to deal with a queue full of
 * typos or answers meant for one application only, so the count carries a Clear
 * button that empties the queue without uploading it.
 */
/**
 * Answers the applicant edited on the page but has not saved yet.
 *
 * These used to be announced by a bar floating over the application itself,
 * which asked for a decision about a question they were often still in the
 * middle of answering. They are listed here instead, next to the saved answers
 * they would join, where the decision can be made once and with the full list
 * in view.
 */
async function heldAnswers() {
  // Read from extension storage, not from the page. Asking the tab meant the
  // list was empty whenever the content script had not loaded there or had been
  // torn down by a step navigation — which on a Workday application is most of
  // the time, and is why edited answers never appeared here.
  const res = await send({ type: "ZAPPLY_GET_HELD" });
  return res?.data?.held ?? [];
}

async function heldCommand(type, question) {
  const questions = question ? [question] : undefined;
  await send({
    type: type === "ZAPPLY_PENDING_SAVE" ? "ZAPPLY_SAVE_HELD" : "ZAPPLY_DISCARD_HELD",
    questions,
  });
  // Clear the on-page outline too, when there is a page to clear it on.
  try {
    const tab = await activeTab();
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type, question }, () => void chrome.runtime.lastError);
  } catch {}
  await refreshPending();
}

async function refreshPending() {
  const saved = session?.responses?.length ?? 0;
  const res = await send({ type: "ZAPPLY_GET_PENDING" });
  const queued = res?.data?.responses ?? [];
  const held = await heldAnswers();
  const pending = queued.length + held.length;

  $("stat-answers").textContent = pending ? `${saved}+${pending}` : String(saved);

  const btn = $("clear-pending");
  btn.disabled = false;
  btn.dataset.armed = "";
  btn.textContent = "Clear";

  $("pending").hidden = pending === 0;
  $("pending-list").hidden = true;
  $("view-pending").textContent = "View";
  $("view-pending").setAttribute("aria-expanded", "false");

  if (pending) {
    // The buttons beside it say what the actions are; a third sentence
    // explaining them only pushed the list itself off the screen.
    const parts = [];
    if (held.length) parts.push(`${held.length} unsaved`);
    if (queued.length) parts.push(`${queued.length} waiting to sync`);
    $("pending-note").textContent = parts.join(" · ");

    // One click for the common case: several answers held across the steps of
    // one application.
    const saveAll = $("save-all-held");
    if (saveAll) {
      saveAll.hidden = held.length < 2;
      saveAll.textContent = `Save all ${held.length}`;
    }
    renderPendingList(queued, held);
  }
  return pending;
}

/**
 * What Sync now would actually upload.
 *
 * The count alone gave no way to tell a useful answer from a typo before
 * committing it to the dashboard — and no way to tell which questions are new
 * against which will overwrite an answer already saved.
 */
function renderPendingList(queued, held = []) {
  const list = $("pending-list");
  list.innerHTML = "";

  const savedKeys = new Set(
    (session?.responses ?? []).map((r) => normalizeQuestion(r.question || ""))
  );

  // Unsaved edits come first: they are the ones still awaiting a decision.
  held.forEach((entry) => {
    const question = String(entry.question || "").trim();
    const answer = String(entry.answer ?? "").trim();

    const li = document.createElement("li");
    li.className = "pending__item--held";

    const text = document.createElement("div");
    text.className = "pending__text";

    const q = document.createElement("span");
    q.className = "pending__q";
    q.textContent = question;
    const tag = document.createElement("span");
    tag.className = "pending__held";
    tag.textContent = " \u00b7 unsaved";
    q.appendChild(tag);

    const a = document.createElement("span");
    a.className = "pending__a";
    a.textContent = answer.length > 110 ? `${answer.slice(0, 110)}\u2026` : answer;

    text.append(q, a);

    const save = document.createElement("button");
    save.type = "button";
    save.className = "pending__save";
    save.textContent = "Save";
    save.title = "Keep this answer and reuse it on your next application";
    save.addEventListener("click", () => heldCommand("ZAPPLY_PENDING_SAVE", question));

    const drop = document.createElement("button");
    drop.type = "button";
    drop.className = "pending__x";
    drop.textContent = "\u00d7";
    drop.setAttribute("aria-label", `Discard unsaved answer for ${question}`);
    drop.addEventListener("click", () => heldCommand("ZAPPLY_PENDING_DISCARD", question));

    li.append(text, save, drop);
    list.appendChild(li);
  });

  queued.forEach((entry) => {
    const question = String(entry.question || "").trim();
    const answer = String(entry.answer ?? "").trim();
    const updates = savedKeys.has(normalizeQuestion(question));

    const li = document.createElement("li");
    const text = document.createElement("div");
    text.className = "pending__text";

    const q = document.createElement("span");
    q.className = "pending__q";
    q.textContent = question;
    if (!updates) {
      const tag = document.createElement("span");
      tag.className = "pending__new";
      tag.textContent = " · new";
      q.appendChild(tag);
    }

    const a = document.createElement("span");
    a.className = "pending__a";
    a.textContent = (updates ? "Replaces saved answer: " : "") + (answer.length > 110 ? `${answer.slice(0, 110)}…` : answer);

    text.append(q, a);

    // Removing one answer without discarding the whole queue.
    const x = document.createElement("button");
    x.type = "button";
    x.className = "pending__x";
    x.textContent = "\u00D7";
    x.title = "Remove this answer";
    x.setAttribute("aria-label", `Remove "${question}" from the sync queue`);
    x.addEventListener("click", async () => {
      x.disabled = true;
      const res = await send({ type: "ZAPPLY_DELETE_PENDING", question });
      if (!res.ok) {
        x.disabled = false;
        setStatus("warn", "Couldn't remove it", res.error || "Try again in a moment.");
        return;
      }
      const left = await refreshPending();
      // refreshPending collapses the list, so reopen it while there is more to
      // review — removing one answer shouldn't hide the rest.
      if (left) {
        $("pending-list").hidden = false;
        $("view-pending").textContent = "Hide";
        $("view-pending").setAttribute("aria-expanded", "true");
      }
    });

    li.append(text, x);
    list.appendChild(li);
  });
}

/** Mirrors the server's normalizeQuestion so "new" vs "replaces" is accurate. */
function normalizeQuestion(q) {
  return String(q)
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(please|kindly|the|a|an|your|you|us|our|this|that|is|are|do|does|did|of|to|for|in|on|at|we|and|or|if|will|would|can|could|may)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

$("view-pending").addEventListener("click", () => {
  const list = $("pending-list");
  const open = list.hidden;
  list.hidden = !open;
  $("view-pending").textContent = open ? "Hide" : "View";
  $("view-pending").setAttribute("aria-expanded", String(open));
});

/**
 * Save the form on screen as a test fixture.
 *
 * Downloaded rather than uploaded: the value of a fixture is that it can be
 * dropped into `test/fixtures/` and replayed by the suite, and a file on disk is
 * the shortest path to that. Nothing about it is sensitive — the capture records
 * the questions a form asks and never the answers given to it — so it can be
 * attached to a bug report as it stands.
 */
/** Reopen the pre-submit review for the page in the active tab. */
$("review-btn").addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "ZAPPLY_REVIEW" }, () => {
    void chrome.runtime.lastError;
    window.close();
  });
});

$("capture-btn").addEventListener("click", async () => {
  const btn = $("capture-btn");
  const original = btn.textContent;
  btn.textContent = "Capturing…";
  try {
    const tab = await activeTab();
    if (!tab?.id) throw new Error("No active tab.");

    const res = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: "ZAPPLY_CAPTURE_FORM" }, (r) => {
        void chrome.runtime.lastError;
        resolve(r);
      });
    });

    const fixture = res?.fixture;
    if (!fixture?.fields?.length) {
      btn.textContent = "No form found";
      setTimeout(() => { btn.textContent = original; }, 2200);
      return;
    }

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const name = `${fixture.ats || "unknown"}-${stamp}.json`;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(fixture, null, 2)], { type: "application/json" })
    );
    await chrome.downloads.download({ url, filename: `zapply-fixtures/${name}`, saveAs: false });
    setTimeout(() => URL.revokeObjectURL(url), 10000);

    btn.textContent = `Saved ${fixture.fieldCount} fields`;
  } catch (e) {
    btn.textContent = "Capture failed";
  }
  setTimeout(() => { btn.textContent = original; }, 2600);
});

$("save-all-held").addEventListener("click", async () => {
  await heldCommand("ZAPPLY_PENDING_SAVE");
});

$("clear-pending").addEventListener("click", async () => {
  const btn = $("clear-pending");
  // Two-step rather than a confirm() dialog: a popup loses focus when a modal
  // opens, which closes it and cancels the action.
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.textContent = "Sure?";
    setTimeout(() => {
      if (btn.dataset.armed !== "1") return;
      btn.dataset.armed = "";
      btn.textContent = "Clear";
    }, 3500);
    return;
  }

  btn.dataset.armed = "";
  btn.disabled = true;
  btn.textContent = "…";

  const res = await send({ type: "ZAPPLY_CLEAR_PENDING" });
  await refreshPending();

  if (res.ok) {
    const n = res.data?.cleared ?? 0;
    setStatus("ready", "Pending answers cleared", `${n} unsynced answer${n === 1 ? "" : "s"} discarded. Your dashboard is untouched.`);
  } else {
    setStatus("warn", "Couldn't clear them", res.error || "Try again in a moment.");
  }
});

async function saveSetting(key, value) {
  session.settings = { ...(session.settings ?? {}), [key]: value };
  chrome.storage.local.set({ session });

  const { apiBase, token } = await new Promise((r) =>
    chrome.storage.local.get(["apiBase", "token"], r)
  );
  fetch(`${apiBase}/api/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ [key]: value }),
  }).catch(() => {});
}

$("profile-select").addEventListener("change", async (e) => {
  const res = await send({ type: "ZAPPLY_SET_PROFILE", profileId: e.target.value });
  if (res.ok) session = res.data;
});

/* ------------------------------------------------------------------ */
/*  Page status + fill                                                 */
/* ------------------------------------------------------------------ */

/**
 * Why the questions the profile couldn't answer are still blank. Without this
 * the applicant sees "6 fields need you" and no indication that the feature
 * built to handle exactly those exists, is switched off, or failed.
 */
function aiHint(data) {
  if (!data?.unmatched) return null;
  switch (data.aiSkipped) {
    case "off": return "turn on “Answer unknown questions with AI” to draft these";
    case "premium": return "AI answers need Premium";
    case "error": return data.aiError || "AI answers unavailable";
    default: return null;
  }
}

function setStatus(tone, title, body = "") {
  $("status-dot").dataset.tone = tone;
  $("status-title").textContent = title;
  $("status-body").textContent = body;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refreshPageStatus() {
  const tab = await activeTab();
  if (!tab?.id || !/^https?:/.test(tab.url ?? "")) {
    setStatus("idle", "No page to fill", "Open a job application and try again.");
    $("fill-btn").disabled = true;
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: "ZAPPLY_STATUS" }, (res) => {
    if (chrome.runtime.lastError || !res) {
      setStatus("idle", "Zapply isn't running here", "Reload the page if you just installed the extension.");
      $("fill-btn").disabled = false;
      return;
    }

    if (res.duplicate) {
      const when = new Date(res.duplicate.appliedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      setStatus(
        "warn",
        "You already applied to this",
        `Sent ${when} · currently "${res.duplicate.stage}". Fill anyway below.`
      );
      $("fill-btn").disabled = false;
      $("fill-btn").textContent = "Fill it anyway";
      return;
    }

    if (res.lastRun) {
      $("stat-fields").textContent = res.lastRun.unmatched || res.lastRun.drafted ? String(res.lastRun.filled) : "—";
      const detail = [
        res.ats && `Detected: ${res.ats}`,
        res.lastRun.matchScore != null && `${res.lastRun.profileLabel} · ${res.lastRun.matchScore}% match`,
        res.lastRun.drafted && `${res.lastRun.drafted} drafted — read before submitting`,
      ]
        .filter(Boolean)
        .join(" · ");
      setStatus(
        res.lastRun.unmatched ? "warn" : "ready",
        res.lastRun.unmatched
          ? `${res.lastRun.unmatched} field${res.lastRun.unmatched === 1 ? "" : "s"} need you`
          : (res.lastRun.drafted ? "Review drafted answers" : "Ready to review"),
        res.lastRun.unmatched ? detail : (res.lastRun.drafted ? detail : "Profile and saved answers applied.")
      );
    } else if (res.isApplication) {
      setStatus("ready", "Application detected", res.ats ? `Detected: ${res.ats}` : "Ready to fill.");
    } else {
      setStatus("idle", "This doesn't look like an application", "You can still fill it manually.");
    }
    $("fill-btn").disabled = false;
  });
}

$("stop-btn").addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab?.id) return;
  await send({ type: "ZAPPLY_STOP" });
  $("stop-btn").hidden = true;
  $("fill-btn").hidden = false;
  $("fill-btn").disabled = false;
  $("fill-btn").textContent = "Fill this application";
  setStatus("warn", "Autofill stopped", "No more fields will be changed until you click Fill this application again.");
});

$("fill-btn").addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab?.id) return;

  $("fill-btn").disabled = true;
  $("fill-btn").textContent = "Filling…";
  $("stop-btn").hidden = false;
  $("stop-btn").disabled = false;

  chrome.tabs.sendMessage(tab.id, { type: "ZAPPLY_RUN" }, (res) => {
    $("fill-btn").disabled = false;
    $("fill-btn").textContent = "Fill this application";
    $("stop-btn").hidden = true;

    if (chrome.runtime.lastError || !res?.ok) {
      setStatus("warn", "Couldn't fill this page", "Reload it and try again.");
      return;
    }
    // A sign-in or create-account step is not a failure, and saying nothing
    // makes it look like one.
    if (res.data.skipped === "signIn" || res.data.skipped === "createAccount") {
      if (res.data.autoSubmitted) {
        setStatus(
          "ready",
          res.data.skipped === "createAccount" ? "Account form submitted" : "Signed in",
          "Zapply filled and submitted this step. Once the application loads, press Fill."
        );
      } else {
        setStatus(
          "warn",
          res.data.skipped === "createAccount" ? "Create your account first" : "Sign in first",
          res.data.keys?.includes("password")
            ? "Zapply filled your saved email and password, but couldn't find the submit button. Press it yourself, then press Fill."
            : "Zapply doesn't fill sign-in or account pages. Once you're through to the application, press Fill."
        );
      }
      $("fill-btn").disabled = false;
      $("fill-btn").textContent = "Fill this application";
      return;
    }

    $("stat-fields").textContent = res.data.unmatched || res.data.drafted ? String(res.data.filled) : "—";
    const needsReview = Boolean(res.data.unmatched || res.data.drafted);
    setStatus(
      res.data.unmatched ? "warn" : "ready",
      res.data.unmatched
        ? `${res.data.unmatched} field${res.data.unmatched === 1 ? "" : "s"} need you`
        : (res.data.drafted ? "Review drafted answers" : "Ready to review"),
      res.data.unmatched
        ? [
            `${res.data.detected} fields checked`,
            res.data.matchScore != null && `${res.data.matchScore}% match`,
            aiHint(res.data),
          ].filter(Boolean).join(" · ")
        : (res.data.drafted ? "AI drafted answers are marked on the form." : "Profile and saved answers applied.")
    );
    refreshPending();
    if (!needsReview) setTimeout(() => window.close(), 120);
  });
});

$("sync-btn").addEventListener("click", async () => {
  $("sync-btn").disabled = true;
  $("sync-btn").textContent = "Syncing…";

  // Pushes anything captured on a form, then pulls the dashboard's Saved
  // Answers back down so the next fill can use them.
  const saved = await send({ type: "ZAPPLY_SYNC_PENDING" });
  const res = await send({ type: "ZAPPLY_GET_SESSION", force: true });
  if (res.ok) {
    session = res.data;
    renderMain();
  }

  $("sync-btn").disabled = false;
  $("sync-btn").textContent = saved.ok ? "Sync now" : "Sync failed — retry";
  // A successful push empties the queue, so the count and the Clear button
  // have to be re-read here — including when the session pull above failed
  // and renderMain never ran.
  await refreshPending();
  if (saved.ok) {
    const pulled = saved.data?.savedAnswers ?? session?.responses?.length ?? 0;
    const pushed = saved.data?.responsesSaved ?? 0;
    setStatus(
      "ready",
      `${pulled} saved answer${pulled === 1 ? "" : "s"} ready`,
      pushed ? `${pushed} new answer${pushed === 1 ? "" : "s"} uploaded from this browser.` : "Pulled from your dashboard."
    );
  }
});

$("unpair-btn").addEventListener("click", async () => {
  await send({ type: "ZAPPLY_UNPAIR" });
  session = null;
  $("code").value = "";
  showPairView();
});

/* ------------------------------------------------------------------ */
/*  Boot                                                               */
/* ------------------------------------------------------------------ */

(async function init() {
  const res = await send({ type: "ZAPPLY_GET_SESSION" });
  if (res.ok && res.data?.profile) {
    session = res.data;
    renderMain();
  } else {
    showPairView();
  }
})();
