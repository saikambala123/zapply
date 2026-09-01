/**
 * ZAPPLY BACKGROUND SERVICE WORKER
 * --------------------------------
 * Owns the bearer token and the cached session. Content scripts never talk to
 * the API directly — they ask the worker, which keeps credentials out of pages
 * and lets one fetch serve every tab.
 */

/**
 * The deployment this extension talks to.
 *
 * This used to default to http://localhost:3000, which meant a published build
 * pointed every fresh install at a server on the user's own machine: pairing
 * failed with "Can't reach Zapply" until they found the API field in the popup
 * and retyped the URL. `npm run ext:build` rewrites this line from
 * NEXT_PUBLIC_APP_URL, and the popup can still override it for local dev.
 */
const DEFAULT_API = "https://zapply.vercel.app"; /* build:api-base */
// Short, because this is how long a settings change in the dashboard takes to
// reach the extension. Anything longer and toggles look broken.
const CACHE_TTL_MS = 60 * 1000;
// Beyond this we block on the network rather than serve a stale profile.
const STALE_MAX_MS = 30 * 60 * 1000;
// Floor between background refreshes triggered by tab activity.
const REFRESH_THROTTLE_MS = 60 * 1000;
let refreshing = null;
let lastRefreshAt = 0;

/* ------------------------------------------------------------------ */
/*  Storage helpers                                                    */
/* ------------------------------------------------------------------ */

const store = {
  get: (keys) => new Promise((r) => chrome.storage.local.get(keys, r)),
  set: (obj) => new Promise((r) => chrome.storage.local.set(obj, r)),
  remove: (keys) => new Promise((r) => chrome.storage.local.remove(keys, r)),
};

async function apiBase() {
  const { apiBase } = await store.get("apiBase");
  return (apiBase || DEFAULT_API).replace(/\/+$/, "");
}

async function authHeaders() {
  const { token } = await store.get("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/* ------------------------------------------------------------------ */
/*  API                                                                */
/* ------------------------------------------------------------------ */

async function api(path, options = {}) {
  const base = await apiBase();
  const headers = {
    "Content-Type": "application/json",
    ...(await authHeaders()),
    ...(options.headers ?? {}),
  };

  try {
    const res = await fetch(`${base}${path}`, { ...options, headers });
    const json = await res.json().catch(() => ({}));

    if (res.status === 401) {
      await store.remove(["token", "session", "sessionAt"]);
      setBadge("!", "#E5484D");
      return { ok: false, error: "Your Zapply session expired. Pair again from the dashboard." };
    }
    if (!res.ok) return { ok: false, error: json.error || `Request failed (${res.status})` };
    return { ok: true, data: json.data };
  } catch (err) {
    return { ok: false, error: "Can't reach Zapply. Check that the app is running." };
  }
}

/* ------------------------------------------------------------------ */
/*  Session cache                                                      */
/* ------------------------------------------------------------------ */

/** Bootstrap payload, cached so a burst of tabs costs one request. */
async function getSession({ force = false } = {}) {
  const { session, sessionAt, token } = await store.get(["session", "sessionAt", "token"]);
  if (!token) return null;

  const age = sessionAt ? Date.now() - sessionAt : Infinity;

  if (session && age < CACHE_TTL_MS && !force) return session;

  // Stale-while-revalidate: an autofill shouldn't wait on the network, but the
  // cache also shouldn't go stale for minutes. Serve what we have and refresh
  // behind it, so the next fill uses current settings and saved answers.
  if (session && age < STALE_MAX_MS && !force) {
    refreshSession();
    return session;
  }

  const res = await api("/api/extension/bootstrap");
  if (!res.ok) return session ?? null;

  const active =
    res.data.profiles.find((p) => p._id === res.data.activeProfileId) ??
    res.data.profiles.find((p) => p.isDefault) ??
    res.data.profiles[0] ??
    null;

  const next = {
    user: res.data.user,
    premium: res.data.user?.premium ?? false,
    settings: res.data.settings ?? {},
    profiles: res.data.profiles ?? [],
    profile: active,
    responses: res.data.responses ?? [],
    syncedAt: res.data.syncedAt,
  };

  await store.set({ session: next, sessionAt: Date.now() });
  setBadge(next.profile ? "" : "!", next.profile ? "#00C2A8" : "#FFB020");
  return next;
}

/** Background refresh, deduped so ten tabs don't trigger ten fetches. */
function refreshSession() {
  if (refreshing) return refreshing;
  refreshing = getSession({ force: true })
    .catch(() => null)
    .finally(() => { refreshing = null; lastRefreshAt = Date.now(); });
  return refreshing;
}

/**
 * Refresh triggered by browsing activity rather than by a user action.
 *
 * `tabs.onActivated` fires on every tab switch, and it called the unthrottled
 * refresh — so a normal session of flicking between tabs fired a bootstrap
 * request each time, hammering the API for a payload that changes rarely.
 */
function maybeRefreshSession() {
  if (refreshing) return;
  if (Date.now() - lastRefreshAt < REFRESH_THROTTLE_MS) return;
  refreshSession();
}

/**
 * The badge is the only thing that tells the applicant an answer is waiting.
 *
 * It counts both buckets: answers held after an edit and answers already queued
 * for sync. Without it, held answers sat in storage with nothing anywhere on
 * screen to say so — the applicant had to think to open the popup.
 */
async function refreshBadge() {
  try {
    const { heldAnswers, pendingResponses } = await store.get(["heldAnswers", "pendingResponses"]);
    const total = (heldAnswers?.length ?? 0) + (pendingResponses?.length ?? 0);
    setBadge(total ? String(Math.min(99, total)) : "", (heldAnswers?.length ?? 0) ? "#FFB020" : "#5B2AD6");
  } catch {}
}

function setBadge(text, color = "#5B2AD6") {
  chrome.action.setBadgeText({ text });
  if (text) chrome.action.setBadgeBackgroundColor({ color });
}

/**
 * The key two phrasings of the same question share.
 *
 * Deliberately identical to normalizeQuestion() on the server, so an answer that
 * will *replace* a saved one is queued once here and lands on that same record
 * when it syncs, rather than arriving as a second, competing entry.
 */
function queueKey(question) {
  return String(question ?? "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(please|kindly|the|a|an|your|you|us|our|this|that|is|are|do|does|did|of|to|for|in|on|at|we|and|or|if|will|would|can|could|may)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

/* ------------------------------------------------------------------ */
/*  Message router                                                     */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  (async () => {
    switch (msg?.type) {
      /* --- pairing --- */
      case "ZAPPLY_PAIR": {
        const base = (msg.apiBase || (await apiBase())).replace(/\/+$/, "");
        await store.set({ apiBase: base });
        try {
          const res = await fetch(`${base}/api/extension/pair`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: msg.code }),
          });
          const json = await res.json();
          if (!res.ok) return respond({ ok: false, error: json.error });

          await store.set({ token: json.data.token, user: json.data.user });
          const session = await getSession({ force: true });
          return respond({ ok: true, data: { user: json.data.user, session } });
        } catch {
          return respond({ ok: false, error: "Couldn't reach that Zapply URL." });
        }
      }

      case "ZAPPLY_UNPAIR": {
        await store.remove(["token", "user", "session", "sessionAt", "pendingResponses", "heldAnswers"]);
        setBadge("");
        return respond({ ok: true });
      }

      /* --- session --- */
      case "ZAPPLY_GET_SESSION": {
        const session = await getSession({ force: msg.force });
        return respond(session ? { ok: true, data: session } : { ok: false, error: "not-connected" });
      }

      case "ZAPPLY_SET_PROFILE": {
        const { session } = await store.get("session");
        if (!session) return respond({ ok: false, error: "not-connected" });
        const profile = session.profiles.find((p) => p._id === msg.profileId);
        if (profile) {
          session.profile = profile;
          await store.set({ session });
        }
        return respond({ ok: true, data: session });
      }

      /* --- pending saved answers: local until the user clicks Sync now --- */
      /**
       * --- held answers: edited on a page, not yet saved ---
       *
       * These used to live in a plain Map inside the content script. A Workday
       * application navigates on every step, and each navigation tears the
       * content script down and takes the Map with it — so by the time the
       * applicant opened the popup there was nothing left to offer them, which
       * is why saving an answer appeared to do nothing at all.
       *
       * They live here now, in the same storage as the sync queue, and survive
       * navigation, reload and closing the tab. Nothing is uploaded from here:
       * saving moves an answer into `pendingResponses`, which is still only
       * sent on an explicit Sync.
       */
      case "ZAPPLY_HOLD_ANSWERS": {
        const { heldAnswers } = await store.get("heldAnswers");
        const merged = new Map((heldAnswers ?? []).map((r) => [queueKey(r.question), r]));
        for (const r of (msg.items ?? [])) {
          if (!r?.question || !String(r.answer ?? "").trim()) continue;
          const key = queueKey(r.question);
          if (!key) continue;
          merged.set(key, { ...r, heldAt: Date.now() });
        }
        const held = Array.from(merged.values()).slice(-200);
        await store.set({ heldAnswers: held });
        await refreshBadge();
        return respond({ ok: true, held: held.length });
      }

      case "ZAPPLY_GET_HELD": {
        const { heldAnswers } = await store.get("heldAnswers");
        return respond({ ok: true, data: { held: heldAnswers ?? [] } });
      }

      /** Move held answers into the sync queue. `questions` omitted = all. */
      case "ZAPPLY_SAVE_HELD": {
        const { heldAnswers, pendingResponses } = await store.get(["heldAnswers", "pendingResponses"]);
        const wanted = msg.questions?.length
          ? new Set(msg.questions.map((q) => queueKey(q)))
          : null;
        const held = heldAnswers ?? [];
        const moving = held.filter((r) => !wanted || wanted.has(queueKey(r.question)));
        const keeping = held.filter((r) => wanted && !wanted.has(queueKey(r.question)));

        const merged = new Map((pendingResponses ?? []).map((r) => [queueKey(r.question), r]));
        for (const r of moving) merged.set(queueKey(r.question), { ...r, queuedAt: Date.now() });

        await store.set({
          heldAnswers: keeping,
          pendingResponses: Array.from(merged.values()).slice(-500),
        });
        await refreshBadge();
        return respond({ ok: true, saved: moving.length });
      }

      case "ZAPPLY_DISCARD_HELD": {
        const { heldAnswers } = await store.get("heldAnswers");
        const wanted = msg.questions?.length ? new Set(msg.questions.map((q) => queueKey(q))) : null;
        const keeping = wanted ? (heldAnswers ?? []).filter((r) => !wanted.has(queueKey(r.question))) : [];
        await store.set({ heldAnswers: keeping });
        await refreshBadge();
        return respond({ ok: true });
      }

      case "ZAPPLY_QUEUE_RESPONSES": {
        const { pendingResponses } = await store.get("pendingResponses");
        // Merged on the same normalisation the server uses, so re-answering one
        // question replaces its queued entry instead of adding a near-duplicate
        // that differs only by an asterisk or stray punctuation.
        const merged = new Map((pendingResponses ?? []).map((r) => [queueKey(r.question), r]));
        for (const r of (msg.responses ?? [])) {
          if (!r?.question || !String(r.answer ?? "").trim()) continue;
          const key = queueKey(r.question);
          if (!key) continue;
          merged.set(key, { ...r, queuedAt: Date.now() });
        }
        await store.set({ pendingResponses: Array.from(merged.values()).slice(-500) });
        await refreshBadge();
        return respond({ ok: true, pending: merged.size });
      }

      case "ZAPPLY_GET_PENDING": {
        const { pendingResponses } = await store.get("pendingResponses");
        return respond({ ok: true, data: { responses: pendingResponses ?? [] } });
      }

      /**
       * Discard the local queue without uploading it.
       *
       * The queue fills up with whatever was typed into a form, which includes
       * typos and answers that only ever made sense for one posting. Until now
       * the only way out of it was to sync — pushing all of that into the
       * dashboard's Saved Answers, where it would be reused on the next
       * application. This drops the queue and touches nothing on the server:
       * answers already saved in the dashboard are unaffected.
       */
      /**
       * Drop one queued answer, leaving the rest of the queue alone.
       *
       * Clear was all-or-nothing, so a single bad answer meant discarding
       * everything else waiting with it. Matched on the same normalisation the
       * queue is keyed by, so the entry removed is the one shown.
       */
      case "ZAPPLY_DELETE_PENDING": {
        const { pendingResponses } = await store.get("pendingResponses");
        const queue = pendingResponses ?? [];
        const target = queueKey(msg.question);
        const kept = queue.filter((r) => queueKey(r.question) !== target);
        await store.set({ pendingResponses: kept });
        const { session } = await store.get("session");
        setBadge(
          kept.length ? String(Math.min(99, kept.length)) : (session?.profile ? "" : "!"),
          kept.length ? "#FFB020" : (session?.profile ? "#00C2A8" : "#FFB020")
        );
        return respond({ ok: true, data: { removed: queue.length - kept.length, pending: kept.length } });
      }

      case "ZAPPLY_CLEAR_PENDING": {
        const { pendingResponses, session } = await store.get(["pendingResponses", "session"]);
        const cleared = pendingResponses?.length ?? 0;
        await store.remove(["pendingResponses"]);
        // The badge counts pending answers, so it goes back to the connection
        // state it would show with an empty queue.
        setBadge(session?.profile ? "" : "!", session?.profile ? "#00C2A8" : "#FFB020");
        return respond({ ok: true, data: { cleared } });
      }

      /**
       * Sync now is two-way, and the pull half is the half that matters most:
       * answers the user typed into the dashboard's Saved Answers tab only
       * reach the extension through a bootstrap fetch. The old version returned
       * early whenever the local queue happened to be empty, so a user who had
       * only *added* answers in the dashboard pressed Sync now and pulled
       * nothing. The refresh now always runs.
       */
      case "ZAPPLY_SYNC_PENDING": {
        const { pendingResponses } = await store.get("pendingResponses");
        const responses = pendingResponses ?? [];

        let pushed = { ok: true, data: { responsesSaved: 0 } };
        if (responses.length) {
          pushed = await api("/api/extension/sync", {
            method: "POST",
            body: JSON.stringify({ responses }),
          });
          if (pushed.ok) await store.remove(["pendingResponses"]);
        }

        const session = await getSession({ force: true });
        const pulled = session?.responses?.length ?? 0;

        if (pushed.ok && session) setBadge("", "#00C2A8");
        else setBadge("!", "#E5484D");

        if (!pushed.ok) return respond(pushed);
        if (!session) return respond({ ok: false, error: "Couldn't reach Zapply to load your saved answers." });

        return respond({
          ok: true,
          data: {
            responsesSaved: responses.length,
            savedAnswers: pulled,
            syncedAt: session.syncedAt ?? new Date().toISOString(),
          },
        });
      }

      /* --- application tracking sync (never receives saved-response auto flushes) --- */
      case "ZAPPLY_SYNC": {
        const payload = { ...(msg.payload ?? {}), responses: [] };
        const res = await api("/api/extension/sync", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        if (res.ok && msg.payload?.application) {
          const { stats } = await store.get("stats");
          const next = { ...(stats ?? { applications: 0 }) };
          next.applications = (next.applications ?? 0) + 1;
          await store.set({ stats: next });
        }
        return respond(res);
      }

      /* --- premium: profile scoring --- */
      case "ZAPPLY_SCORE": {
        return respond(await api("/api/ai/score", { method: "POST", body: JSON.stringify(msg.payload) }));
      }

      /* --- premium: generated answer --- */
      case "ZAPPLY_ANSWER": {
        return respond(await api("/api/ai/answer", { method: "POST", body: JSON.stringify(msg.payload) }));
      }

      /* --- duplicate detection --- */
      case "ZAPPLY_CHECK": {
        return respond(await api("/api/extension/check", { method: "POST", body: JSON.stringify(msg.payload) }));
      }

      /* --- the packaged default, so the popup doesn't hardcode localhost --- */
      case "ZAPPLY_GET_API_BASE": {
        return respond({ ok: true, data: { apiBase: await apiBase(), packagedDefault: DEFAULT_API } });
      }

      case "ZAPPLY_OPEN_DASHBOARD": {
        chrome.tabs.create({ url: `${await apiBase()}/dashboard` });
        return respond({ ok: true });
      }

      default:
        return respond({ ok: false, error: "Unknown message." });
    }
  })();

  return true; // keep the channel open for the async work above
});

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                          */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { apiBase: existing } = await store.get("apiBase");
  if (!existing) await store.set({ apiBase: DEFAULT_API });

  if (reason === "install") {
    chrome.tabs.create({ url: `${await apiBase()}/auth?mode=signup` });
    setBadge("1", "#FFB020");
  }
});

chrome.runtime.onStartup.addListener(() => getSession({ force: true }));

// Returning from the dashboard to a job page should pick up whatever changed —
// but at most once a minute, not on every tab switch.
chrome.tabs.onActivated.addListener(() => maybeRefreshSession());

/** Keyboard shortcut — fill the active tab on demand. */
chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== "run-autofill") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "ZAPPLY_RUN" });
});
