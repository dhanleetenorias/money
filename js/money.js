/**
 * MONEY — centavo math + formatting. Pure functions only: no DOM, no storage.
 *
 * Every amount in this app is an INTEGER of centavos. Floats never touch
 * storage or arithmetic; they only appear inside Intl at display time.
 *
 * Calendar helpers are Asia/Manila by default and NEVER use toISOString():
 * UTC is 8h behind Manila, so a UTC month key mis-files every transaction
 * made between 16:00 and 23:59 on the last day of a month.
 */

export const CENT_PER_PESO = 100;

export const TZ = "Asia/Manila";

/** Hard ceiling on a single parsed amount: ₱1,000,000,000. */
const MAX_CENT = 1e11;

// A bare trailing "." is allowed ("25000.") — that's mid-typing, not junk.
const AMOUNT_RE = /^\d*(?:\.\d{0,2})?$/;
const KEY_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

// ---- parsing ---------------------------------------------------------------

/**
 * Parse loose user input ("1,234.5", "₱180", ".5") into centavos.
 * Rejects junk, negatives, >2 decimal places and absurd magnitudes.
 * @param {string|number} input
 * @returns {number|null} centavos, or null if unparseable
 */
export function parseAmount(input) {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) return null;
    // NOT `Math.round(input * 100)`: 1.005 is stored as 1.00499999999999989,
    // so that rounds DOWN to ₱1.00 and quietly loses a centavo. Render the
    // number at 15 significant digits (which discards the binary artefact),
    // trim, and hand it to the string path — so a number with more than two
    // decimals is rejected exactly like the string "12.345" is.
    const decimal = input
      .toPrecision(15)
      .replace(/(\.\d*?)0+$/, "$1")
      .replace(/\.$/, "");
    return parseAmount(decimal);
  }
  if (typeof input !== "string") return null;

  // Strip currency chrome only. Anything else left over fails the regex,
  // which is how "-5", "1e99" and "12.345" get rejected.
  const s = input.replace(/[₱\s ,]/g, "");
  if (!s || !/\d/.test(s) || !AMOUNT_RE.test(s)) return null;

  const [intPart = "", fracPart = ""] = s.split(".");
  const pesos = intPart === "" ? 0 : Number(intPart);
  const frac = Number((fracPart + "00").slice(0, 2));
  if (!Number.isFinite(pesos) || !Number.isFinite(frac)) return null;

  const cent = pesos * CENT_PER_PESO + frac;
  if (!Number.isSafeInteger(cent) || cent < 0 || cent > MAX_CENT) return null;
  return cent;
}

// ---- formatting ------------------------------------------------------------

const fmtCache = new Map();

function formatter(kind) {
  let f = fmtCache.get(kind);
  if (f) return f;
  const money = { style: "currency", currency: "PHP" };
  const opts =
    kind === "plain"
      ? money
      : kind === "compact"
        ? { ...money, notation: "compact", maximumFractionDigits: 1 }
        : kind === "decimal"
          ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
          : { notation: "compact", maximumFractionDigits: 1 };
  f = new Intl.NumberFormat("en-PH", opts);
  fmtCache.set(kind, f);
  return f;
}

/**
 * @param {number} cent
 * @param {{sign?:boolean, compact?:boolean, noSymbol?:boolean}} [opts]
 * @returns {string} e.g. "₱1,234.00", "₱1.2M", "1,234.00"
 */
export function fmt(cent, opts = {}) {
  const c = Number.isFinite(cent) ? Math.round(cent) : 0;
  const abs = Math.abs(c) / CENT_PER_PESO;
  const kind = opts.noSymbol
    ? opts.compact
      ? "decimalCompact"
      : "decimal"
    : opts.compact
      ? "compact"
      : "plain";
  const body = formatter(kind).format(abs);
  if (c < 0) return "−" + body;
  if (opts.sign && c > 0) return "+" + body;
  return body;
}

/** Always-signed variant. Negatives use U+2212 MINUS, not a hyphen. */
export function fmtSigned(cent) {
  return fmt(cent, { sign: true });
}

// ---- allocation ------------------------------------------------------------

/**
 * Split `totalCent` across `pcts` by largest remainder, so the result sums
 * to EXACTLY totalCent — no centavo is created or lost. BigInt internally
 * because total * weight overflows 2^53 at realistic incomes.
 *
 * Ties on the remainder go to the higher percentage, then to the lower
 * original index, so identical inputs always produce an identical split.
 *
 * If the percentages sum to 0, every entry is weighted equally: the exact-sum
 * invariant must hold even for a degenerate category set.
 *
 * @param {number} totalCent
 * @param {number[]} pcts
 * @returns {number[]} centavos, same length and order as pcts
 */
export function splitByPct(totalCent, pcts) {
  const list = Array.isArray(pcts) ? pcts : [];
  const n = list.length;
  if (n === 0) return [];

  const total = Number.isFinite(totalCent) ? Math.round(totalCent) : 0;
  if (total <= 0) return new Array(n).fill(0);

  // Scale to integer weights so fractional percentages (12.5) stay exact.
  const clean = list.map((p) => (Number.isFinite(p) && p > 0 ? p : 0));
  let weights = clean.map((p) => BigInt(Math.round(p * 1e6)));
  let W = weights.reduce((a, b) => a + b, 0n);
  if (W === 0n) {
    weights = new Array(n).fill(1n);
    W = BigInt(n);
  }

  const T = BigInt(total);
  const out = new Array(n);
  const rows = new Array(n);
  let assigned = 0n;
  for (let i = 0; i < n; i++) {
    const num = T * weights[i];
    const base = num / W;
    out[i] = Number(base);
    assigned += base;
    rows[i] = { i, rem: num % W, pct: clean[i] };
  }

  const leftover = Number(T - assigned);
  if (leftover > 0) {
    rows.sort((a, b) => {
      if (a.rem !== b.rem) return a.rem > b.rem ? -1 : 1;
      if (a.pct !== b.pct) return b.pct - a.pct;
      return a.i - b.i;
    });
    for (let k = 0; k < leftover; k++) out[rows[k].i] += 1;
  }
  return out;
}

/** @returns {number} `pct` percent of `cent`, rounded to the nearest centavo. */
export function pctOf(cent, pct) {
  const c = Number.isFinite(cent) ? cent : 0;
  const p = Number.isFinite(pct) ? pct : 0;
  return Math.round((c * p) / 100);
}

export function clamp(n, lo, hi) {
  const v = Number.isFinite(n) ? n : lo;
  return v < lo ? lo : v > hi ? hi : v;
}

// ---- calendar (Asia/Manila) ------------------------------------------------

const partCache = new Map();

function partsFormatter(tz) {
  let f = partCache.get(tz);
  if (f) return f;
  f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  partCache.set(tz, f);
  return f;
}

function toDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) {
    // Defaulting here would silently file real money under the wrong month.
    throw new RangeError("money: invalid date");
  }
  return date;
}

/** Wall-clock parts in `tz`. @returns {{y,m,d,H,M,S}} all integers */
function zoned(date, tz = TZ) {
  const parts = partsFormatter(tz).formatToParts(toDate(date));
  const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return {
    y: get("year"),
    m: get("month"),
    d: get("day"),
    // Some ICU builds still emit hour 24 for midnight under h23.
    H: get("hour") % 24,
    M: get("minute"),
    S: get("second"),
  };
}

/** @returns {string} "2026-07" — the Manila month a moment belongs to. */
export function ym(date, tz = TZ) {
  const { y, m } = zoned(date, tz);
  return `${y}-${String(m).padStart(2, "0")}`;
}

/**
 * @returns {boolean} true for a well-formed "YYYY-MM".
 * Callers holding possibly-corrupt stored data should gate on this rather than
 * catching the RangeError the parsers throw.
 */
export function isMonthKey(key) {
  return typeof key === "string" && KEY_RE.test(key);
}

function parseKey(key) {
  const match = KEY_RE.exec(String(key ?? ""));
  if (!match) throw new RangeError(`money: invalid month key "${key}"`);
  return { y: Number(match[1]), m: Number(match[2]) };
}

function makeKey(y, m) {
  return `${y}-${String(m).padStart(2, "0")}`;
}

export function ymPrev(key) {
  const { y, m } = parseKey(key);
  return m === 1 ? makeKey(y - 1, 12) : makeKey(y, m - 1);
}

export function ymNext(key) {
  const { y, m } = parseKey(key);
  return m === 12 ? makeKey(y + 1, 1) : makeKey(y, m + 1);
}

/** @returns {number} 28..31. Pure civil-calendar arithmetic, no timezone. */
export function daysInMonth(key) {
  const { y, m } = parseKey(key);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function dayOfMonth(date, tz = TZ) {
  return zoned(date, tz).d;
}

/** @returns {number} days remaining including today (never below 1). */
export function daysLeftInMonth(date, tz = TZ) {
  const { d } = zoned(date, tz);
  return Math.max(1, daysInMonth(ym(date, tz)) - d + 1);
}

/** @returns {number} 0..1 elapsed fraction of the month, to the second. */
export function monthProgress(date, tz = TZ) {
  const { d, H, M, S } = zoned(date, tz);
  const total = daysInMonth(ym(date, tz));
  const elapsed = d - 1 + (H * 3600 + M * 60 + S) / 86400;
  return clamp(elapsed / total, 0, 1);
}

// ---- ids -------------------------------------------------------------------

/** @returns {string} unique id; falls back when crypto.randomUUID is absent. */
export function uid() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    // fall through
  }
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
