/**
 * MONEY — derived budget state. Pure functions only: no DOM, no storage.
 *
 * HARD RULE: this module must never import store.js or read live settings.
 * Everything is derived from `month.alloc`, the snapshot taken when the month
 * was opened. That is what stops an edit in Settings from silently rewriting
 * a month that has already been lived through.
 *
 * `now` is always an explicit parameter — no ambient Date.now() in here.
 *
 * MonthRec = {
 *   key, incomeCent, openedAt, closedAt|null,
 *   alloc: [{id, name, pct, allocCent, vault}],
 *   sweep: {doneAt, fromCent, byCat}|null
 * }
 */

import {
  splitByPct,
  ym,
  isMonthKey,
  daysInMonth,
  daysLeftInMonth,
  monthProgress,
  clamp,
} from "./money.js";

/** Envelope is "caution" once this much of its allocation is gone. */
const CAUTION_RATIO = 0.8;

/** Pace is "on" while spend is within this fraction of allocation of target. */
const PACE_TOLERANCE = 0.02;

// ---- month construction ----------------------------------------------------

/**
 * Snapshot the current categories into a new month record. The percentages
 * and names are COPIED, never referenced, so later Settings edits can't
 * reach back into this month.
 *
 * @param {{categories:{id,name,pct,vault?}[]}} settings
 * @param {string} monthKey "2026-07"
 * @param {number} incomeCent
 * @param {number} openedAt epoch ms
 * @returns {object} MonthRec
 */
export function newMonthFromSettings(settings, monthKey, incomeCent, openedAt) {
  const cats = Array.isArray(settings?.categories) ? settings.categories : [];
  const income = Number.isFinite(incomeCent)
    ? Math.max(0, Math.round(incomeCent))
    : 0;
  const parts = splitByPct(
    income,
    cats.map((c) => Number(c?.pct) || 0),
  );
  return {
    key: monthKey,
    incomeCent: income,
    openedAt: Number.isFinite(openedAt) ? openedAt : 0,
    closedAt: null,
    alloc: cats.map((c, i) => ({
      id: c.id,
      name: c.name,
      pct: Number(c.pct) || 0,
      allocCent: parts[i] ?? 0,
      vault: !!c.vault,
    })),
    sweep: null,
  };
}

// ---- internals -------------------------------------------------------------

function allocOf(month) {
  return Array.isArray(month?.alloc) ? month.alloc : [];
}

/** True for rows that are bookkeeping or vault draw-downs, never envelope spend. */
function isNonSpend(kind) {
  return kind === "sweep" || kind === "withdrawal";
}

/**
 * Live transactions for this month, keyed by category.
 * 'income' rows subtract (a refund gives budget back); 'sweep' rows are
 * bookkeeping for month close and must not read as spending, or closing a
 * month would look like the whole month was spent twice.
 *
 * Withdrawals are excluded BY KIND, not by category. Excluding them by
 * category id would leak: a withdrawal whose categoryId isn't in this month's
 * alloc snapshot (vault renamed, or an older month) falls through to
 * `otherSpent` and silently shrinks safeToSpendToday. Kind is the only
 * property a withdrawal is guaranteed to carry.
 *
 * @returns {{byCat:Map<string,number>, vaultSpent:number, otherSpent:number}}
 */
function spendIndex(month, txns) {
  const key = typeof month?.key === "string" ? month.key : null;
  const vaultIds = new Set(
    allocOf(month)
      .filter((a) => a.vault)
      .map((a) => a.id),
  );
  const known = new Set(allocOf(month).map((a) => a.id));
  const byCat = new Map();
  let vaultSpent = 0;
  let otherSpent = 0;

  for (const t of Array.isArray(txns) ? txns : []) {
    if (!t || t.deleted) continue;
    if (key && typeof t.monthKey === "string" && t.monthKey !== key) continue;
    if (isNonSpend(t.kind)) continue;
    const cent = Number.isFinite(t.cent) ? Math.round(t.cent) : 0;
    if (cent === 0) continue;
    const signed = t.kind === "income" ? -cent : cent;
    const id = t.categoryId;
    byCat.set(id, (byCat.get(id) || 0) + signed);
    if (vaultIds.has(id)) vaultSpent += signed;
    else if (!known.has(id)) otherSpent += signed;
  }
  return { byCat, vaultSpent, otherSpent };
}

/**
 * Sum live withdrawals whose month key passes `accept`.
 * A withdrawal with no month key is always counted: it left the vault
 * regardless, and over-counting only makes the withdrawal cap safer.
 */
function sumWithdrawals(txns, accept) {
  let total = 0;
  for (const t of Array.isArray(txns) ? txns : []) {
    if (!t || t.deleted || t.kind !== "withdrawal") continue;
    const key = typeof t.monthKey === "string" ? t.monthKey : "";
    if (!accept(key)) continue;
    const cent = Number.isFinite(t.cent) ? Math.round(t.cent) : 0;
    if (cent > 0) total += cent;
  }
  return total;
}

/**
 * How far through `month` we are, from the perspective of `now`.
 * Past months are complete (1), future months haven't started (0).
 * A month with an unusable key is treated as complete rather than throwing —
 * corrupt stored data must degrade, not white-screen the dashboard.
 *
 * The window starts at `openedAt`, NOT at the 1st. Open a month on the 10th
 * and the budget covers the 10th onward, so pace must too — measuring from
 * the 1st would credit nine untracked days of "savings" and report a wild
 * ahead-of-pace on day one. This also keeps pace consistent with
 * safeToSpendToday, which already divides by REMAINING days.
 * A month opened on the 1st is unaffected: the window is the whole month.
 */
function progressFor(month, now) {
  if (!isMonthKey(month?.key) || now == null) return 1;
  let cur;
  try {
    cur = ym(now);
  } catch {
    return 1; // unusable clock — assume the month is done
  }
  if (month.key !== cur) return month.key < cur ? 1 : 0;

  const full = monthProgress(now);
  const start = startProgress(month);
  if (start <= 0) return full;
  if (start >= 1) return 1; // opened on the last instant — nothing left to pace
  return clamp((full - start) / (1 - start), 0, 1);
}

/**
 * Elapsed fraction of the month at the moment it was opened, or 0 if that
 * can't be established (older records predate openedAt; a corrupt value must
 * degrade to the whole-month window rather than throw).
 */
function startProgress(month) {
  const at = Number(month?.openedAt);
  if (!Number.isFinite(at) || at <= 0) return 0;
  try {
    // An openedAt from another month means the record was edited or imported;
    // trust the month key over the timestamp.
    if (ym(at) !== month.key) return 0;
    return monthProgress(at);
  } catch {
    return 0;
  }
}

/**
 * Days remaining to divide the pool by. The current month uses the real
 * remainder; any other month uses its full length so browsing history doesn't
 * divide by a stale "today". A month whose key is missing or corrupt falls
 * back to 30 rather than throwing — this is reachable from a hand-edited
 * backup, and a crash here white-screens the dashboard.
 */
function remainingDays(month, now) {
  if (!isMonthKey(month?.key)) return 30;
  try {
    if (now != null && month.key === ym(now)) return daysLeftInMonth(now);
    return daysInMonth(month.key);
  } catch {
    return 30;
  }
}

function envFrom(entry, spentCent, now, month) {
  const allocCent = Number.isFinite(entry.allocCent) ? entry.allocCent : 0;
  const leftCent = allocCent - spentCent;
  const over = leftCent < 0;
  const ratio = allocCent > 0 ? spentCent / allocCent : spentCent > 0 ? 1 : 0;
  const behindPace =
    now != null &&
    allocCent > 0 &&
    ratio > progressFor(month, now) + PACE_TOLERANCE;
  return {
    id: entry.id,
    name: entry.name,
    pct: entry.pct,
    allocCent,
    spentCent,
    leftCent,
    over,
    overCent: over ? -leftCent : 0,
    ratio: clamp(ratio, 0, 99),
    state: over
      ? "over"
      : ratio >= CAUTION_RATIO || behindPace
        ? "caution"
        : "safe",
  };
}

// ---- envelopes -------------------------------------------------------------

/**
 * @param {object} month MonthRec
 * @param {object[]} txns
 * @param {string} catId
 * @param {number|Date} [now] optional — enables the "behind pace" caution
 * @returns {object|null} EnvState, or null if the month has no such category
 */
export function envelopeState(month, txns, catId, now) {
  const entry = allocOf(month).find((a) => a.id === catId);
  if (!entry) return null;
  const { byCat } = spendIndex(month, txns);
  return envFrom(entry, byCat.get(catId) || 0, now, month);
}

/** @returns {object[]} spendable (non-vault) envelopes, in snapshot order. */
export function allEnvelopes(month, txns, now) {
  const { byCat } = spendIndex(month, txns);
  return allocOf(month)
    .filter((a) => !a.vault)
    .map((a) => envFrom(a, byCat.get(a.id) || 0, now, month));
}

/**
 * This month's contribution to the vault, and what left it this month.
 *
 * SCOPE: per-month. `totalCent` is what THIS month added, net of this month's
 * withdrawals — it is not the balance you can spend from. For that, and for
 * anything gating a withdraw button, use vaultBalance()/maxWithdrawable().
 *
 * `sweptInCent` comes from the recorded sweep, not from txns, so it can't
 * drift if a sweep transaction is edited or replayed.
 *
 * @returns {{allocCent, sweptInCent, withdrawnCent, totalCent, pct, spentCent}}
 */
export function vaultState(month, txns) {
  const entries = allocOf(month).filter((a) => a.vault);
  const { vaultSpent } = spendIndex(month, txns);
  const allocCent = entries.reduce((s, a) => s + (a.allocCent || 0), 0);
  const pct = entries.reduce((s, a) => s + (Number(a.pct) || 0), 0);
  const sweptInCent = Number.isFinite(month?.sweep?.fromCent)
    ? month.sweep.fromCent
    : 0;
  const key = isMonthKey(month?.key) ? month.key : null;
  const withdrawnCent = sumWithdrawals(txns, (k) => (key ? k === key : true));
  return {
    allocCent,
    sweptInCent,
    withdrawnCent,
    spentCent: vaultSpent,
    // Floored at 0: a month's own line can't read as negative even if someone
    // withdrew against a balance that earlier months provided.
    totalCent: Math.max(
      0,
      allocCent + sweptInCent - vaultSpent - withdrawnCent,
    ),
    pct,
  };
}

/**
 * The REAL, spendable vault balance: cumulative across every month up to and
 * including `upToKey`.
 *
 * WHY CUMULATIVE. The vault is a savings account, not a monthly envelope. A
 * birthday in August is paid out of savings built since January, so the only
 * correct balance is the running total. Capping a withdrawal at one month's
 * 45% would refuse a ₱2,000 gift against a ₱40,000 balance — wrong, and the
 * exact failure the per-month view would produce.
 *
 * Each month contributes its own allocation plus what its close swept in;
 * every withdrawal ever made is subtracted. `sweptInCent` is NOT double
 * counted: a sweep moves money that was allocated to a SPENDABLE envelope, so
 * it is new to the vault and appears in exactly one month's record.
 *
 * @param {object[]|Object<string,object>} months
 * @param {object[]} txns all txns (any month)
 * @param {string} [upToKey] inclusive ceiling; omit for the whole history
 * @returns {{balanceCent, inCent, withdrawnCent, months:number}}
 */
export function vaultBalance(months, txns, upToKey) {
  const list = Array.isArray(months) ? months : Object.values(months || {});
  const ceiling = isMonthKey(upToKey) ? upToKey : null;
  const counted = new Set();
  let inCent = 0;

  for (const m of list) {
    if (!m || !isMonthKey(m.key)) continue;
    if (ceiling && m.key > ceiling) continue;
    if (counted.has(m.key)) continue; // a duplicated record must not pay twice
    counted.add(m.key);
    const entries = allocOf(m).filter((a) => a.vault);
    inCent += entries.reduce((s, a) => s + (a.allocCent || 0), 0);
    if (Number.isFinite(m.sweep?.fromCent)) inCent += m.sweep.fromCent;
    // Vault-category expenses are legacy/manual spend; treat like a withdrawal.
    const { vaultSpent } = spendIndex(m, txns);
    inCent -= vaultSpent;
  }

  const withdrawnCent = sumWithdrawals(txns, (k) =>
    ceiling ? !k || k <= ceiling : true,
  );

  return {
    balanceCent: Math.max(0, inCent - withdrawnCent),
    inCent,
    withdrawnCent,
    months: counted.size,
  };
}

/**
 * Ceiling for a withdraw form. The vault may NOT go negative: it represents
 * money that actually exists, and a negative balance would be a fiction the
 * sweep would then compound.
 *
 * Pass the whole months collection — a single MonthRec is accepted too, but
 * then the cap is only that month's contribution, which will be too low.
 *
 * @param {object[]|Object<string,object>} months
 * @param {object[]} txns
 * @param {string} [upToKey]
 * @returns {number} centavos, never negative
 */
export function maxWithdrawable(months, txns, upToKey) {
  const one = months && !Array.isArray(months) && isMonthKey(months.key);
  if (one)
    return vaultBalance([months], txns, upToKey ?? months.key).balanceCent;
  return vaultBalance(months, txns, upToKey).balanceCent;
}

/**
 * Clamp a requested withdrawal to the available balance.
 * @returns {{cent:number, capped:boolean, availableCent:number}}
 */
export function planWithdrawal(months, txns, requestCent, upToKey) {
  const availableCent = maxWithdrawable(months, txns, upToKey);
  const want = Number.isFinite(requestCent)
    ? Math.max(0, Math.round(requestCent))
    : 0;
  const cent = Math.min(want, availableCent);
  return { cent, capped: cent < want, availableCent };
}

/**
 * Everything outside the vault: what the month is actually allowed to spend.
 * Spend against a category that no longer exists in the snapshot still counts
 * here — the money left the account regardless.
 */
export function spendablePool(month, txns) {
  const entries = allocOf(month).filter((a) => !a.vault);
  const { byCat, otherSpent } = spendIndex(month, txns);
  const allocCent = entries.reduce((s, a) => s + (a.allocCent || 0), 0);
  const spentCent =
    entries.reduce((s, a) => s + (byCat.get(a.id) || 0), 0) + otherSpent;
  return { allocCent, spentCent, leftCent: allocCent - spentCent };
}

/**
 * Even-split of what's left over the days remaining. Never negative.
 * A month that isn't the current one divides by its whole length rather than
 * by a stale "today", so browsing history doesn't produce nonsense.
 * @returns {{cent:number, daysLeft:number, basis:'even'|'zero'}}
 */
export function safeToSpendToday(month, txns, now) {
  const pool = spendablePool(month, txns);
  const daysLeft = remainingDays(month, now);
  if (pool.leftCent <= 0) return { cent: 0, daysLeft, basis: "zero" };
  return {
    cent: Math.floor(pool.leftCent / daysLeft),
    daysLeft,
    basis: "even",
  };
}

/**
 * Spend so far vs. spend the month "should" be at by now.
 * @returns {{expectedCent, actualCent, deltaCent, state:'ahead'|'on'|'over'}}
 */
export function paceDelta(month, txns, now) {
  const pool = spendablePool(month, txns);
  const expectedCent = Math.round(pool.allocCent * progressFor(month, now));
  const actualCent = pool.spentCent;
  const deltaCent = actualCent - expectedCent;
  const tol = Math.round(pool.allocCent * PACE_TOLERANCE);
  const state = deltaCent > tol ? "over" : deltaCent < -tol ? "ahead" : "on";
  return { expectedCent, actualCent, deltaCent, state };
}

/** @returns {number} 0..1 — where to draw the pace marker on an envelope bar. */
export function envelopePaceTick(month, now) {
  return clamp(progressFor(month, now), 0, 1);
}

// ---- close -----------------------------------------------------------------

/**
 * What a month close would move into the vault: every non-vault leftover.
 * Overspent envelopes contribute 0, never a negative — one blown envelope
 * must not quietly eat another envelope's leftover.
 *
 * Idempotent: once a sweep is recorded on the month, this replays that record
 * instead of recomputing, so closing twice can never double-count.
 *
 * Two things it is deliberately blind to: the vault never appears in `byCat`
 * (it cannot sweep into itself and inflate its own balance), and withdrawals
 * are dropped upstream by kind — a birthday paid from savings during the
 * closing month must not shrink that month's leftovers.
 *
 * THE CAP. Flooring each envelope at 0 is right per-envelope but wrong in
 * aggregate: with Food ₱30,000 overspent to ₱35,000, the untouched envelopes
 * still show their full leftovers while ₱5,000 of that money is already gone.
 * Summing the floored leftovers would move money into the vault that does not
 * exist — and the vault is withdrawable, so the fiction becomes spendable.
 * The total is therefore capped at what the whole spendable pool actually has
 * left (which nets the overspend, and nets ghost spend against categories the
 * snapshot no longer knows).
 *
 * RULING ON byCat: when the cap bites, byCat is scaled DOWN proportionally
 * (largest-remainder, via splitByPct) so it sums to `fromCent` exactly. The
 * alternative — capping the total and leaving byCat at its raw values — would
 * print ₱25,000 of line items under a ₱20,000 total in History, which is the
 * same lie in a smaller font. Proportional attribution is the honest reading:
 * the overspend was funded out of the pool, so every surviving envelope
 * contributed to covering it. In the normal case (nothing overspent, no ghost
 * spend) the cap never binds and byCat is untouched.
 *
 * @returns {{fromCent:number, byCat:Object<string,number>, toVaultCent:number}}
 */
export function computeSweep(month, txns) {
  const done = month?.sweep;
  if (done && Number.isFinite(done.fromCent)) {
    return {
      fromCent: done.fromCent,
      byCat: { ...(done.byCat || {}) },
      toVaultCent: done.fromCent,
    };
  }
  const { byCat: spent } = spendIndex(month, txns);
  const rows = [];
  let rawCent = 0;
  for (const a of allocOf(month)) {
    if (a.vault) continue;
    const left = (a.allocCent || 0) - (spent.get(a.id) || 0);
    if (left > 0) {
      rows.push({ id: a.id, left });
      rawCent += left;
    }
  }

  // Never move more than the pool actually holds, and never a negative.
  const capCent = Math.max(0, spendablePool(month, txns).leftCent);
  const fromCent = Math.min(rawCent, capCent);

  const byCat = {};
  if (fromCent === rawCent) {
    for (const r of rows) byCat[r.id] = r.left;
  } else {
    // splitByPct distributes `fromCent` across the leftovers by weight and
    // hands out the remainder cent-by-cent, so the parts sum to fromCent
    // exactly — byCat can never total more than the money that moved.
    const parts = splitByPct(
      fromCent,
      rows.map((r) => r.left),
    );
    rows.forEach((r, i) => {
      const part = parts[i] ?? 0;
      if (part > 0) byCat[r.id] = part;
    });
  }

  return { fromCent, byCat, toVaultCent: fromCent };
}

/**
 * Months that are over but still open, oldest first — the close queue.
 * Accepts either the store's keyed map or a plain array of MonthRecs.
 * @returns {string[]} month keys
 */
export function monthsToClose(months, now) {
  const list = Array.isArray(months) ? months : Object.values(months || {});
  let cur = null;
  if (now != null) {
    try {
      cur = ym(now);
    } catch {
      // Unusable clock: close nothing rather than sweeping on a guess.
      return [];
    }
  }
  // isMonthKey, not typeof string: a corrupt key would sort into the queue and
  // then throw in daysInMonth() the moment the close ran.
  return list
    .filter((m) => m && isMonthKey(m.key) && !m.closedAt)
    .filter((m) => cur == null || m.key < cur)
    .map((m) => m.key)
    .sort();
}
