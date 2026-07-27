/**
 * MONEY — offline-first outbox sync to a Google Apps Script Web App.
 *
 * WHY A WEB APP AND NOT THE SHEETS API
 * A static site has no secrets: anything the browser can read, a visitor can
 * read. So the service-account key never comes near this file. Instead an
 * Apps Script Web App is bound to the sheet, deployed "execute as me / anyone
 * with the link", and gated by a shared token that the user types once on the
 * device. The token lives in localStorage here and in Script Properties there.
 * It is never in the repo, never in a URL, never logged.
 *
 * LOCAL-FIRST
 * Every write has ALREADY landed in IndexedDB (idb.addTxn) before this module
 * hears about it. Sync only drains the outbox opportunistically. A failing or
 * unconfigured sync must never block the UI and must never lose a row — so
 * nothing here throws at the call site and nothing rejects unhandled.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CORS — READ BEFORE "FIXING" THE CONTENT-TYPE
 * Apps Script Web Apps do NOT answer a CORS preflight. A POST with
 * `Content-Type: application/json` is a preflighted request, the OPTIONS gets
 * no Access-Control-Allow-* headers back, and the fetch fails before the
 * script ever runs. `text/plain;charset=utf-8` makes it a *simple* request —
 * no preflight — and `e.postData.contents` on the server still receives the
 * exact JSON string. Do not "clean this up" to application/json.
 *
 * Apps Script also 302s from script.google.com to script.googleusercontent.com.
 * fetch follows that redirect by default and the final response carries
 * `Access-Control-Allow-Origin: *`, so it works — but only with credentials
 * omitted, which is why we pass credentials:'omit'.
 *
 * mode:'no-cors' is deliberately NOT used: it would make the response opaque,
 * we could never read `accepted`, and we would have to guess whether the write
 * landed. Guessing breaks idempotency.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * REQUEST  (POST, body is a JSON string sent as text/plain)
 *   {
 *     v: 1,
 *     token: "<shared secret>",
 *     ops: [{
 *       id:         "uuid",                 // idempotency key = the txn id
 *       op:         "append" | "void" | "update",
 *       ts:         1753600000000,          // epoch ms; server formats in Manila
 *       monthKey:   "2026-07",
 *       kind:       "expense"|"income"|"sweep"|"withdrawal",
 *       categoryId: "food",
 *       category:   "Food",                 // display name, best effort
 *       cent:       -18000,                 // SIGNED centavos, see signedCent()
 *       note:       "kape"
 *     }]
 *   }
 *
 * RESPONSE
 *   { ok:true, accepted:[ids], duplicates:[ids], rejected:[{id,err}], rows:N }
 *   { ok:false, err:"auth"|"badjson"|"badops"|"toolarge"|"busy"|"unconfigured" }
 *
 * `accepted` is authoritative and INCLUDES ids the server already had (a
 * duplicate is a success from the client's point of view — the row is in the
 * sheet). We only ever clear ids the SERVER named, never the ids we sent.
 *
 * `update` is the one op that is NOT append-only: the server finds the row by
 * TxnId and rewrites it in place, falling back to an append when the id is
 * absent (a phone can edit a txn whose original append never landed). It
 * therefore carries the txn's CURRENT values under its EXISTING id — the same
 * shape as an append, only the verb differs. It is never sent as `append`,
 * because the server dedupes appends by id and a landed original would keep
 * the stale numbers.
 */

import { getOutbox, markSynced, clearOutbox } from "./idb.js";
import {
  getToken,
  setToken,
  getSyncUrl,
  setSyncUrl,
  getCategories,
} from "./store.js";

/** Ops per HTTP request. Apps Script is slow per-call; one setValues per batch. */
/** Kinds that may reach the sheet verbatim. Anything else lands as "expense". */
const WIRE_KINDS = new Set(["income", "sweep", "withdrawal"]);

const BATCH = 50;

/** Batches per drain (50 × 20 = 1000 ops) — a hard stop against a spin loop. */
const MAX_LOOPS = 20;

/** Collapse a burst of entries into one request. */
const DEBOUNCE_MS = 400;

/** Backoff: 5s → 10 → 20 → 40 → 80 → 160 → 320 → 640 → 900s, ±25% jitter. */
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CEIL_MS = 15 * 60 * 1000;

/** Apps Script cold starts are slow; 30s before we call it a timeout. */
const REQUEST_TIMEOUT_MS = 30_000;

// ---- state -----------------------------------------------------------------

let inFlight = false; // single-flight guard — two drains = duplicate rows
let failCount = 0;
let pending = 0;
let lastOkAt = null;
let lastErr = null;
let nextRetryAt = null;

let debounceTimer = null;
let retryTimer = null;
let listenersBound = false;

const listeners = new Set();

// ---- helpers ---------------------------------------------------------------

function isOnline() {
  try {
    // Absent navigator (tests/workers) is treated as online: better to try and
    // fail than to sit on a full outbox forever.
    return typeof navigator === "undefined" || navigator.onLine !== false;
  } catch {
    return true;
  }
}

function configured() {
  return !!(getSyncUrl() && getToken());
}

function emit() {
  const snap = status();
  for (const cb of [...listeners]) {
    try {
      cb(snap);
    } catch {
      // A broken subscriber must never take the sync loop down.
    }
  }
}

function clearTimer(t) {
  if (t) {
    try {
      clearTimeout(t);
    } catch {
      /* ignore */
    }
  }
  return null;
}

function backoffMs(fails) {
  const n = Math.max(1, fails);
  // Clamp the exponent before it overflows into Infinity.
  const raw = Math.min(
    BACKOFF_CEIL_MS,
    BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 20),
  );
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.round(raw * jitter);
}

function scheduleRetry() {
  const wait = backoffMs(failCount);
  nextRetryAt = Date.now() + wait;
  retryTimer = clearTimer(retryTimer);
  try {
    retryTimer = setTimeout(() => {
      retryTimer = null;
      nextRetryAt = null;
      void drain();
    }, wait);
    // Don't hold a node process open in tests/tooling.
    retryTimer?.unref?.();
  } catch {
    retryTimer = null;
  }
}

/**
 * Signed centavos for the sheet. The app stores magnitudes plus a `kind`;
 * a spreadsheet wants something you can SUM.
 *   expense → negative, income → positive, sweep → positive (into savings)
 *   void    → the exact negation of the row it compensates
 *   update  → the same sign rule as an append: it REPLACES the row rather
 *             than compensating it, so it must not be negated.
 */
function signedCent(txn, wireOp) {
  const cent = Number.isFinite(txn?.cent) ? Math.round(txn.cent) : 0;
  const mag = Math.abs(cent);
  const base = txn?.kind === "expense" ? -mag : mag;
  return wireOp === "void" ? -base : base;
}

function categoryName(id) {
  try {
    const hit = getCategories().find((c) => c.id === id);
    return hit?.name || id || "";
  } catch {
    return id || "";
  }
}

/**
 * Local outbox verb → wire verb. The local vocabulary is 'put'|'void'|
 * 'update'; the wire is 'append'|'void'|'update'. Anything unrecognised
 * degrades to 'append', which the server dedupes by id — a safe default,
 * because at worst it re-sends a row that is already there.
 *
 * A Map, not an object literal: a plain object would resolve 'constructor' or
 * 'toString' off Object.prototype and put a FUNCTION in the `op` field.
 */
const WIRE_OPS = new Map([
  ["void", "void"],
  ["update", "update"],
]);

/** outbox record {id, op:'put'|'void'|'update', ts, txn} → wire op. */
function toWire(rec) {
  const txn = rec?.txn || {};
  const wireOp = WIRE_OPS.get(rec?.op) || "append";
  return {
    id: String(rec?.id ?? ""),
    op: wireOp,
    ts: Number.isFinite(txn.ts)
      ? txn.ts
      : Number.isFinite(rec?.ts)
        ? rec.ts
        : Date.now(),
    monthKey: String(txn.monthKey ?? ""),
    // Whitelist, so a new kind can't silently reach the sheet as "expense".
    // A withdrawal mislabelled as spending would double-count against the
    // envelopes in any spreadsheet analysis.
    kind: WIRE_KINDS.has(txn.kind) ? txn.kind : "expense",
    categoryId: String(txn.categoryId ?? ""),
    category: categoryName(String(txn.categoryId ?? "")),
    cent: signedCent(txn, wireOp),
    note: typeof txn.note === "string" ? txn.note : "",
  };
}

function idList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v ?? "")).filter(Boolean);
}

// ---- transport -------------------------------------------------------------

/**
 * POST one batch. Resolves — never rejects.
 * @returns {Promise<{ok:true, accepted:string[]}|{ok:false, err:string}>}
 */
async function postBatch(ops) {
  const url = getSyncUrl();
  const token = getToken();
  if (!url || !token) return { ok: false, err: "not configured" };

  const body = JSON.stringify({ v: 1, token, ops });

  let ctrl = null;
  let timer = null;
  try {
    ctrl = typeof AbortController === "function" ? new AbortController() : null;
    if (ctrl) {
      timer = setTimeout(() => {
        try {
          ctrl.abort();
        } catch {
          /* ignore */
        }
      }, REQUEST_TIMEOUT_MS);
      timer?.unref?.();
    }

    const res = await fetch(url, {
      method: "POST",
      // See the CORS note at the top of this file. NOT application/json.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body,
      redirect: "follow", // script.google.com → script.googleusercontent.com
      credentials: "omit", // the redirect target rejects credentialed CORS
      cache: "no-store",
      signal: ctrl?.signal,
    });

    if (!res || res.ok === false) {
      // A 401/403 here usually means the deployment is not "anyone with the
      // link", not that the token is wrong — the script never ran.
      return { ok: false, err: `http ${res?.status ?? "?"}` };
    }

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // Apps Script serves an HTML login page when the deployment access is
      // wrong. That's the single most common misconfiguration.
      return { ok: false, err: "bad response (check deployment access)" };
    }

    if (!data || data.ok !== true) {
      const err = String(data?.err || "server error");
      return { ok: false, err: err === "auth" ? "auth (token rejected)" : err };
    }

    // Union of accepted + duplicates, both clearable. Defensive: the server
    // already folds duplicates into `accepted`.
    const acked = new Set([
      ...idList(data.accepted),
      ...idList(data.duplicates),
    ]);
    return { ok: true, accepted: [...acked] };
  } catch (e) {
    const name = e?.name === "AbortError" ? "timeout" : "network";
    return { ok: false, err: name };
  } finally {
    clearTimer(timer);
  }
}

// ---- drain -----------------------------------------------------------------

async function refreshPending() {
  try {
    const rows = await getOutbox();
    pending = rows.length;
  } catch {
    /* keep the last known count */
  }
}

/**
 * Drain the outbox. Single-flight: a second call while one is running is a
 * no-op, because two concurrent drains would send the same ops twice.
 * Never throws.
 */
async function drain() {
  if (inFlight) return;

  if (!configured() || !isOnline()) {
    await refreshPending();
    emit();
    return;
  }

  inFlight = true;
  try {
    for (let loop = 0; loop < MAX_LOOPS; loop++) {
      let outbox = [];
      try {
        outbox = await getOutbox();
      } catch {
        outbox = [];
      }
      pending = outbox.length;
      if (!outbox.length) {
        failCount = 0;
        lastErr = null;
        nextRetryAt = null;
        retryTimer = clearTimer(retryTimer);
        break;
      }

      const batch = outbox.slice(0, BATCH);
      const sent = new Set(batch.map((r) => String(r.id)));
      const res = await postBatch(batch.map(toWire));

      if (!res.ok) {
        failCount += 1;
        lastErr = res.err;
        scheduleRetry();
        break;
      }

      // Only clear what the SERVER named, and only if we actually sent it —
      // a confused server must not be able to delete unrelated queued ops.
      const acked = res.accepted.filter((id) => sent.has(id));

      if (acked.length) {
        await markSynced(acked);
        await clearOutbox(acked);
        pending = Math.max(0, pending - acked.length);
        lastOkAt = Date.now();
        lastErr = null;
        failCount = 0;
        nextRetryAt = null;
        retryTimer = clearTimer(retryTimer);
      }

      if (acked.length < batch.length) {
        // Partial ack: the un-acked ops stay queued. If NONE were acked the
        // head of the queue is stuck, so back off instead of hot-looping.
        if (!acked.length) {
          failCount += 1;
          lastErr = "rejected by server";
          scheduleRetry();
        } else {
          // Some progress — the stragglers retry on the next kick.
          lastErr = `${batch.length - acked.length} not accepted`;
        }
        break;
      }

      emit(); // let the pill tick down between batches
    }
  } catch (e) {
    // Belt and braces: nothing above should throw, but a drain that threw
    // would leave inFlight stuck true and kill sync for the whole session.
    failCount += 1;
    lastErr = String(e?.message || e || "sync failed");
    scheduleRetry();
  } finally {
    inFlight = false;
  }

  await refreshPending();
  emit();
}

// ---- triggers --------------------------------------------------------------

function bindListeners() {
  if (listenersBound) return;
  listenersBound = true;
  try {
    // Deliberately NOT force:true. A flapping connection fires `online`
    // repeatedly and a user tabbing in and out fires `visibilitychange`
    // repeatedly; forcing on either would reset the backoff every time and
    // turn a failing server into a retry storm. Only an explicit "Sync now"
    // tap should force.
    if (typeof globalThis.addEventListener === "function") {
      globalThis.addEventListener("online", () => kick());
    }
    if (typeof document !== "undefined" && document?.addEventListener) {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") kick();
      });
    }
  } catch {
    // Non-browser host — kick() still works when called directly.
  }
}

// ---- public API ------------------------------------------------------------

/**
 * Ask for a drain. Debounced, so calling it after every addTxn in a burst of
 * entries produces ONE request. Safe to call as often as you like, safe when
 * offline, safe when unconfigured. Never throws, never returns a rejection.
 *
 * @param {{force?:boolean}} [opts] force:true clears the backoff timer — use
 *        it for an explicit user action ("Sync now"), not for automatic calls.
 */
export function kick(opts = {}) {
  bindListeners();

  if (opts.force) {
    failCount = 0;
    nextRetryAt = null;
    retryTimer = clearTimer(retryTimer);
  } else if (nextRetryAt && Date.now() < nextRetryAt) {
    // In backoff — the scheduled retry owns the next attempt.
    return;
  }

  if (debounceTimer) return;
  try {
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void drain();
    }, DEBOUNCE_MS);
    debounceTimer?.unref?.();
  } catch {
    debounceTimer = null;
    void drain();
  }
}

/**
 * Snapshot for the sync pill.
 * @returns {{pending:number, lastOkAt:number|null, lastErr:string|null,
 *            configured:boolean, online:boolean, syncing:boolean,
 *            nextRetryAt:number|null}}
 */
export function status() {
  return {
    pending,
    lastOkAt,
    lastErr,
    configured: configured(),
    online: isOnline(),
    syncing: inFlight,
    nextRetryAt,
  };
}

/**
 * Persist the Web App /exec URL + shared token, then try immediately so the
 * user finds out in Settings whether it works.
 *
 * @returns {{ok:true}|{ok:false, error:string}} — validation only; the network
 *          result arrives via onChange/status.
 */
export function configure(url, token) {
  const u = typeof url === "string" ? url.trim() : "";
  const t = typeof token === "string" ? token.trim() : "";

  if (!u) return { ok: false, error: "Paste the Web App /exec URL" };
  if (!/^https:\/\//i.test(u)) return { ok: false, error: "URL must be https" };
  if (u.includes("?") || u.includes("#")) {
    // A token in a query string ends up in logs, history and Referer headers.
    return { ok: false, error: "URL must not contain a query string" };
  }
  if (!/\/exec$/i.test(u)) {
    return { ok: false, error: "URL should end in /exec (not /dev)" };
  }
  if (!t) return { ok: false, error: "Paste the token" };

  setSyncUrl(u);
  setToken(t);

  failCount = 0;
  lastErr = null;
  nextRetryAt = null;
  retryTimer = clearTimer(retryTimer);
  kick({ force: true });
  return { ok: true };
}

/**
 * Subscribe to status changes (for the sync pill).
 * @param {(s:ReturnType<typeof status>)=>void} cb
 * @returns {() => void} unsubscribe
 */
export function onChange(cb) {
  if (typeof cb !== "function") return () => {};
  bindListeners();
  listeners.add(cb);
  try {
    cb(status());
  } catch {
    /* ignore */
  }
  return () => listeners.delete(cb);
}

/**
 * One-shot connection check for a Settings "Test" button. Sends zero ops, so
 * it can never write a row. Never throws.
 * @returns {Promise<{ok:true}|{ok:false, error:string}>}
 */
export async function testConnection() {
  if (!configured()) return { ok: false, error: "Not configured" };
  const res = await postBatch([]);
  if (res.ok) {
    lastErr = null;
    lastOkAt = Date.now();
    emit();
    return { ok: true };
  }
  lastErr = res.err;
  emit();
  return { ok: false, error: res.err };
}

// Bind triggers and take a first pending count on import, so a pill rendered
// before the first kick() still shows the truth.
bindListeners();
void refreshPending().then(emit);
