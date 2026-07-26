/**
 * MONEY — localStorage persistence.
 *
 * Two independent keys so writing a month never rewrites settings:
 *   mn.settings.v1  { v:1, categories, token, syncUrl, ... }
 *   mn.months.v1    { v:1, months: { "2026-07": MonthRec, ... } }
 *
 * Transactions live in idb.js, not here — this key must stay small enough
 * that a quota failure is essentially impossible.
 *
 * Every exported read is guaranteed not to throw: all storage access and JSON
 * parsing is wrapped in try/catch with safe defaults.
 *
 * `settings.token` is a SECRET. It is never logged and never leaves via
 * exportJSON — see stripSecrets().
 */

const SETTINGS_KEY = "mn.settings.v1";
const MONTHS_KEY = "mn.months.v1";

/** Oldest months dropped first if we ever hit quota. */
const MAX_MONTHS = 120;

/** Seed envelopes. Order matters — it's the display order. */
export const DEFAULT_CATEGORIES = [
  { id: "save", name: "Save/Invest", pct: 45, vault: true },
  { id: "food", name: "Food", pct: 30, vault: false },
  { id: "gas", name: "Gas", pct: 9, vault: false },
  { id: "coffee", name: "Coffee", pct: 8, vault: false },
  { id: "buffer", name: "Buffer", pct: 5, vault: false },
  { id: "misc", name: "Misc", pct: 3, vault: false },
];

function defaultSettings() {
  return {
    v: 1,
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    token: "",
    syncUrl: "",
    lastMonthKey: null,
    onboarded: false,
  };
}

function defaultMonths() {
  return { v: 1, months: {} };
}

function defaultsFor(kind) {
  return kind === "months" ? defaultMonths() : defaultSettings();
}

/**
 * Version migration seam. Given the parsed payload for a kind
 * ("settings" | "months"), return a payload shaped like the current version.
 * Only v1 exists, so anything not tagged v:1 is treated as unreadable and
 * replaced wholesale — a half-migrated ledger is worse than a fresh one.
 */
function migrate(kind, data) {
  if (!data || typeof data !== "object" || data.v !== 1)
    return defaultsFor(kind);
  if (kind === "months") {
    const months =
      data.months && typeof data.months === "object" ? data.months : {};
    return { v: 1, months };
  }
  const base = defaultSettings();
  const cats = normalizeCategories(data.categories);
  return {
    ...base,
    ...data,
    v: 1,
    categories: cats.length ? cats : base.categories,
  };
}

function normalizeCategories(cats) {
  if (!Array.isArray(cats)) return [];
  return cats
    .filter((c) => c && typeof c.id === "string" && c.id)
    .map((c) => ({
      id: c.id,
      name: typeof c.name === "string" && c.name ? c.name : c.id,
      pct: Number.isFinite(Number(c.pct)) ? Number(c.pct) : 0,
      vault: !!c.vault,
    }));
}

function safeGet(key, kind) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return defaultsFor(kind);
    return migrate(kind, JSON.parse(raw));
  } catch {
    return defaultsFor(kind);
  }
}

function safeSet(key, obj) {
  try {
    localStorage.setItem(key, JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

function safeSetMonths(payload) {
  if (safeSet(MONTHS_KEY, payload)) return true;
  // Likely quota exceeded — drop the oldest months and retry once.
  try {
    const keys = Object.keys(payload.months).sort();
    const keep = keys.slice(-MAX_MONTHS);
    const months = {};
    for (const k of keep) months[k] = payload.months[k];
    return safeSet(MONTHS_KEY, { v: 1, months });
  } catch {
    return false;
  }
}

// ---- settings --------------------------------------------------------------

/** @returns {{settings:object, months:object}} Never throws. */
export function loadAll() {
  return {
    settings: safeGet(SETTINGS_KEY, "settings"),
    months: safeGet(MONTHS_KEY, "months").months,
  };
}

/** @returns {object} current settings (always v1-shaped). */
export function getSettings() {
  return safeGet(SETTINGS_KEY, "settings");
}

/** Shallow-merge `patch` onto settings and persist. @returns {object} new settings */
export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch, v: 1 };
  next.categories = normalizeCategories(next.categories);
  if (!next.categories.length) next.categories = defaultSettings().categories;
  safeSet(SETTINGS_KEY, next);
  return next;
}

export function getCategories() {
  return getSettings().categories;
}

/**
 * Replace the category set.
 *
 * CONTRACT: returns {ok:true, categories} or {ok:false, error} — it never
 * throws, so a Settings screen can show the message inline. Percentages must
 * total EXACTLY 100 (compared at 1e-6 scale, so 33.33/33.33/33.34 is fine);
 * a set that doesn't is rejected and nothing is written.
 *
 * @param {{id,name,pct,vault?}[]} cats
 * @returns {{ok:true, categories:object[]}|{ok:false, error:string}}
 */
export function setCategories(cats) {
  const clean = normalizeCategories(cats);
  if (!clean.length)
    return { ok: false, error: "At least one category is required" };
  if (clean.some((c) => c.pct < 0)) {
    return { ok: false, error: "Percentages cannot be negative" };
  }
  const ids = new Set(clean.map((c) => c.id));
  if (ids.size !== clean.length)
    return { ok: false, error: "Duplicate category id" };

  // Integer comparison: 45.5 + 54.5 must not fail on binary float slop.
  const total = clean.reduce((s, c) => s + Math.round(c.pct * 1e6), 0);
  if (total !== 100 * 1e6) {
    return {
      ok: false,
      error: `Percentages must total 100 (currently ${total / 1e6})`,
    };
  }

  const next = { ...getSettings(), categories: clean, v: 1 };
  if (!safeSet(SETTINGS_KEY, next)) {
    return { ok: false, error: "Failed to write to storage" };
  }
  return { ok: true, categories: clean };
}

// ---- months ----------------------------------------------------------------

/** @returns {Object<string, object>} keyed by month key. Never throws. */
export function getMonths() {
  return safeGet(MONTHS_KEY, "months").months;
}

/** @returns {object|null} */
export function getMonth(key) {
  return getMonths()[key] ?? null;
}

/** Insert or replace a month record. @returns {object|null} the stored record */
export function upsertMonth(rec) {
  if (!rec || typeof rec.key !== "string" || !rec.key) return null;
  const payload = safeGet(MONTHS_KEY, "months");
  payload.months[rec.key] = rec;
  safeSetMonths(payload);
  return rec;
}

/**
 * Stamp a month closed with its sweep result. No-op if the month is missing
 * or already closed, so a retried close can't overwrite the first sweep.
 * @returns {object|null} the closed record
 */
export function closeMonth(key, sweep) {
  const payload = safeGet(MONTHS_KEY, "months");
  const rec = payload.months[key];
  if (!rec) return null;
  if (rec.closedAt) return rec;
  const now = Date.now();
  rec.closedAt = now;
  rec.sweep = {
    doneAt: now,
    fromCent: Number.isFinite(sweep?.fromCent) ? sweep.fromCent : 0,
    byCat: sweep?.byCat ? { ...sweep.byCat } : {},
  };
  payload.months[key] = rec;
  safeSetMonths(payload);
  return rec;
}

// ---- sync config -----------------------------------------------------------

/** @returns {string} the sync token. SECRET — never log this value. */
export function getToken() {
  return getSettings().token || "";
}

export function setToken(t) {
  return saveSettings({ token: typeof t === "string" ? t.trim() : "" });
}

export function getSyncUrl() {
  return getSettings().syncUrl || "";
}

export function setSyncUrl(u) {
  return saveSettings({ syncUrl: typeof u === "string" ? u.trim() : "" });
}

// ---- import / export -------------------------------------------------------

function stripSecrets(settings) {
  const { token, ...rest } = settings;
  return rest;
}

/**
 * @returns {string} pretty-printed JSON backup of settings + months.
 * The sync token is deliberately omitted — backups get mailed to yourself.
 */
export function exportJSON() {
  const { settings, months } = loadAll();
  return JSON.stringify(
    {
      app: "money",
      v: 1,
      exportedAt: Date.now(),
      settings: stripSecrets(settings),
      months,
    },
    null,
    2,
  );
}

/**
 * Validate and replace settings + months from a backup string. The existing
 * token is preserved, since exports never carry one.
 * @param {string} str
 * @returns {{ok:boolean, error?:string}}
 */
export function importJSON(str) {
  let parsed;
  try {
    parsed = JSON.parse(str);
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }
  const { settings, months } = parsed || {};
  if (!settings || typeof settings !== "object") {
    return { ok: false, error: "Missing or invalid settings" };
  }
  if (!months || typeof months !== "object" || Array.isArray(months)) {
    return { ok: false, error: "Missing or invalid months" };
  }
  for (const [key, rec] of Object.entries(months)) {
    if (!rec || typeof rec !== "object" || !Array.isArray(rec.alloc)) {
      return { ok: false, error: `Invalid month record "${key}"` };
    }
  }

  const cats = normalizeCategories(settings.categories);
  const merged = {
    ...defaultSettings(),
    ...settings,
    categories: cats.length ? cats : defaultSettings().categories,
    token: getToken(),
    v: 1,
  };
  const okSettings = safeSet(SETTINGS_KEY, merged);
  const okMonths = safeSetMonths({ v: 1, months });
  if (!okSettings || !okMonths) {
    return { ok: false, error: "Failed to write to storage" };
  }
  return { ok: true };
}

/** Request persistent storage from the browser, if supported. Never throws. */
export function requestPersist() {
  try {
    navigator.storage?.persist?.().catch(() => {});
  } catch {
    // best effort only
  }
}
