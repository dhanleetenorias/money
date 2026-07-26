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

/**
 * Live transactions for this month, keyed by category.
 * 'income' rows subtract (a refund gives budget back); 'sweep' rows are
 * bookkeeping for month close and must not read as spending, or closing a
 * month would look like the whole month was spent twice.
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
    if (t.kind === "sweep") continue;
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
 * How far through `month` we are, from the perspective of `now`.
 * Past months are complete (1), future months haven't started (0).
 */
function progressFor(month, now) {
  if (!month?.key || now == null) return 1;
  const cur = ym(now);
  if (month.key === cur) return monthProgress(now);
  return month.key < cur ? 1 : 0;
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
 * @returns {{allocCent, sweptInCent, totalCent, pct, spentCent}} the vault.
 * `sweptInCent` comes from the recorded sweep, not from txns, so it can't
 * drift if a sweep transaction is edited or replayed.
 */
export function vaultState(month, txns) {
  const entries = allocOf(month).filter((a) => a.vault);
  const { vaultSpent } = spendIndex(month, txns);
  const allocCent = entries.reduce((s, a) => s + (a.allocCent || 0), 0);
  const pct = entries.reduce((s, a) => s + (Number(a.pct) || 0), 0);
  const sweptInCent = Number.isFinite(month?.sweep?.fromCent)
    ? month.sweep.fromCent
    : 0;
  return {
    allocCent,
    sweptInCent,
    spentCent: vaultSpent,
    totalCent: allocCent + sweptInCent - vaultSpent,
    pct,
  };
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
  const isCurrent = month?.key && now != null && month.key === ym(now);
  const daysLeft = isCurrent ? daysLeftInMonth(now) : daysInMonth(month.key);
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
  const byCat = {};
  let fromCent = 0;
  for (const a of allocOf(month)) {
    if (a.vault) continue;
    const left = (a.allocCent || 0) - (spent.get(a.id) || 0);
    if (left > 0) {
      byCat[a.id] = left;
      fromCent += left;
    }
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
  const cur = now == null ? null : ym(now);
  return list
    .filter((m) => m && typeof m.key === "string" && !m.closedAt)
    .filter((m) => cur == null || m.key < cur)
    .map((m) => m.key)
    .sort();
}
