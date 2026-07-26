/**
 * MONEY — render.js
 *
 * Pure HTML-string builders + a small set of imperative DOM patchers.
 * No event listeners live here. main.js owns all interaction via a single
 * delegated listener on #app that reads `data-action` (+ `data-cat-id` /
 * `data-id`) attributes emitted by the functions below.
 *
 * CRITICAL: toggleNoteRow / showAmountError / clearAmountError must touch
 * ONLY the specific nodes named. Re-rendering the add-expense sheet while
 * the amount/note <input> has focus kills the iOS keyboard and caret
 * mid-entry — main.js calls these patchers instead of a full re-render for
 * anything that happens while that sheet is open.
 *
 * ---- Shapes this module reads (owned by budget.js / money.js) ----
 *
 * @typedef {Object} HomeVM
 * @property {boolean} hasIncome
 * @property {string} monthLabel        "July"
 * @property {number} [incomeCent]
 * @property {Object} [vault]           budget.vaultState() result
 * @property {Object} [hero]            budget.safeToSpendToday() result
 * @property {number} [poolLeftCent]    budget.spendablePool().leftCent
 * @property {Object} [pace]            budget.paceDelta() result
 * @property {number} [paceTick]        budget.envelopePaceTick() result, 0..1
 * @property {Object[]} [envelopes]     budget.allEnvelopes() result
 */

import { fmt } from "./money.js";

/**
 * Escape a string for safe interpolation into HTML text/attribute content.
 * Apply this to every piece of user- or settings-derived text (category
 * names, notes, month labels) before it lands in a template string.
 * @param {string} str
 * @returns {string}
 */
export function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function daysWord(n) {
  return `${n} day${n === 1 ? "" : "s"}`;
}

/** One sentence from a budget.paceDelta() result. */
function paceLine(pace) {
  // Nothing spent yet: "you're ₱11,664 ahead of pace" is arithmetically true
  // but meaningless — on the 27th of an untouched month it just reads as
  // noise. Say nothing until there's something to compare against.
  if (!pace.actualCent) return null;
  if (pace.state === "ahead") {
    return {
      cls: "pace-ahead",
      text: `you're ${fmt(Math.abs(pace.deltaCent))} ahead of pace`,
    };
  }
  if (pace.state === "over") {
    return { cls: "pace-over", text: `${fmt(pace.deltaCent)} over pace` };
  }
  return { cls: "pace-on", text: "on pace" };
}

function renderPace(pace) {
  const line = paceLine(pace);
  if (!line) return "";
  return `<p class="pace ${line.cls}">${esc(line.text)}</p>`;
}

/** One envelope row: name, bar with pace tick, % micro-label, ₱ left. */
function renderEnvRow(env, paceTick) {
  const fillRatio = Math.max(0, Math.min(1, env.ratio));
  // The micro-label is the envelope's ALLOCATION share ("30%"), which is fixed
  // and identifies the envelope. Using env.ratio here showed spend-so-far, so
  // every row read "0%" on a fresh month.
  const pctLabel = Math.round(Number(env.pct) || 0);
  const tickPct = (Math.max(0, Math.min(1, paceTick)) * 100).toFixed(2);
  const overLine = env.over
    ? `<span class="env-over">Over by ${fmt(env.overCent)}</span>`
    : "";
  return `<div class="env env--${env.state}" data-id="${esc(env.id)}">
    <span class="env-name">${esc(env.name)}</span>
    <div class="env-bar">
      <div class="env-fill" style="transform:scaleX(${fillRatio})"></div>
      <div class="env-tick" style="left:${tickPct}%"></div>
    </div>
    <span class="env-pct">${pctLabel}%</span>
    <span class="env-amt amt">${fmt(env.leftCent)}</span>
    ${overLine}
  </div>`;
}

function renderEnvelopes(envelopes, paceTick) {
  if (!envelopes || !envelopes.length) return "";
  const rows = envelopes.map((e) => renderEnvRow(e, paceTick)).join("");
  return `<section class="envelopes">${rows}</section>`;
}

/**
 * Home screen — the hero. See HomeVM above for the shape main.js builds.
 * @param {HomeVM} vm
 * @returns {string}
 */
export function renderHome(vm) {
  const nav = `<button class="btn btn-ghost" type="button" data-action="go-history"
      aria-label="History">&#128337;</button>
    <button class="btn btn-ghost" type="button" data-action="go-settings"
      aria-label="Settings">&#9881;</button>`;

  if (!vm.hasIncome) {
    return `<div class="screen screen-home">
      <header class="topbar">
        <span class="month-chip">${esc(vm.monthLabel)}</span>
        ${nav}
      </header>
      <div class="empty">
        <p class="empty-title">Set your income for ${esc(vm.monthLabel)} to get started</p>
        <button class="empty-cta btn btn-primary" type="button" data-action="open-income">Set income</button>
      </div>
    </div>`;
  }

  return `<div class="screen screen-home">
    <header class="topbar">
      <button class="month-chip" type="button" data-action="open-income">${esc(vm.monthLabel)}</button>
      <span aria-hidden="true">&middot;</span>
      <button class="income-chip amt" type="button" data-action="open-income">${fmt(vm.incomeCent)}</button>
      ${nav}
    </header>

    <section class="vault">
      <span class="vault-label">${esc(vm.vaultLabel)}</span>
      <span class="vault-amt amt">${fmt(vm.vault.totalCent)}</span>
      <span class="vault-pct">${Math.round(vm.vault.pct)}%</span>
      <span class="vault-lock" aria-hidden="true">&#128274;</span>
    </section>

    <section class="hero">
      <span class="hero-label">Safe to spend today</span>
      <span class="hero-amt amt">${fmt(vm.hero.cent)}</span>
      <span class="hero-sub">${fmt(vm.poolLeftCent)} left &middot; ${daysWord(vm.hero.daysLeft)}</span>
    </section>

    ${renderPace(vm.pace)}
    ${renderEnvelopes(vm.envelopes, vm.paceTick)}

    <button class="fab" type="button" data-action="open-add" aria-label="Add expense">+</button>
  </div>`;
}

/**
 * Add-expense bottom sheet. Amount input opens already focused (main.js
 * calls .focus() after mount — autofocus alone is not reliable on iOS).
 * @param {{categories:{id:string,name:string}[]}} vm  spendable categories only
 * @returns {string}
 */
export function renderAddSheet(vm) {
  const chips = (vm.categories || [])
    .map(
      (c) => `<button class="chip" type="button" data-action="add-expense"
        data-cat-id="${esc(c.id)}">${esc(c.name)}</button>`,
    )
    .join("");

  return `<div class="sheet screen-add" role="dialog" aria-modal="true" aria-label="Add expense">
    <div class="sheet-backdrop" data-action="close-sheet"></div>
    <div class="sheet-panel">
      <h2 class="sheet-title">Add expense</h2>
      <input class="amount-input amt" type="text" inputmode="decimal" placeholder="₱0"
        autocomplete="off" aria-label="Amount">
      <p class="amount-error" hidden></p>
      <div class="chips">${chips}</div>
      <button class="btn btn-ghost" type="button" data-action="toggle-note">Add note</button>
      <div class="note-row" hidden>
        <input class="note-input" type="text" placeholder="Note (optional)" aria-label="Note">
      </div>
    </div>
  </div>`;
}

/**
 * Income sheet — used both for a fresh month and for editing an already-open
 * one (re-snapshots alloc on save; main.js gates closed months behind a
 * confirm before this ever renders with hasExisting+closed).
 * @param {{monthLabel:string, hasExisting:boolean, prefill:string}} vm
 * @returns {string}
 */
export function renderIncomeSheet(vm) {
  const title = vm.hasExisting ? "Edit income" : "Set income";
  return `<div class="sheet screen-income" role="dialog" aria-modal="true" aria-label="${title}">
    <div class="sheet-backdrop" data-action="close-sheet"></div>
    <div class="sheet-panel">
      <h2 class="sheet-title">${title} &mdash; ${esc(vm.monthLabel)}</h2>
      <input class="amount-input amt" type="text" inputmode="decimal" placeholder="₱0"
        autocomplete="off" aria-label="Monthly income" value="${esc(vm.prefill)}">
      <p class="amount-error" hidden></p>
      <button class="btn btn-primary" type="button" data-action="save-income">Save</button>
    </div>
  </div>`;
}

/** P4 stub — placeholder only, wired for navigation. */
export function renderSettingsScreen() {
  return `<div class="screen screen-settings">
    <header class="topbar">
      <button class="btn btn-ghost" type="button" data-action="go-home" aria-label="Back">&lsaquo;</button>
      <h1>Settings</h1>
    </header>
    <div class="empty">
      <p class="empty-title">Settings are coming in a later update.</p>
    </div>
  </div>`;
}

/** P4 stub — placeholder only, wired for navigation. */
export function renderHistoryScreen() {
  return `<div class="screen screen-history">
    <header class="topbar">
      <button class="btn btn-ghost" type="button" data-action="go-home" aria-label="Back">&lsaquo;</button>
      <h1>History</h1>
    </header>
    <div class="empty">
      <p class="empty-title">Transaction history is coming in a later update.</p>
    </div>
  </div>`;
}

/* -------------------------------------------------------------------- */
/* Imperative patchers — DOM surgery only, never full re-render.         */
/* -------------------------------------------------------------------- */

/**
 * Reveal (or hide) the optional note field without touching the amount
 * input's focus/caret — RULE 1.
 * @param {Element} panel   the `.sheet-panel` currently in the DOM
 * @returns {void}
 */
export function toggleNoteRow(panel) {
  const row = panel?.querySelector(".note-row");
  if (!row) return;
  const wasHidden = row.hasAttribute("hidden");
  if (wasHidden) {
    row.removeAttribute("hidden");
    row.querySelector(".note-input")?.focus();
  } else {
    row.setAttribute("hidden", "");
  }
}

/** Show an inline validation message under the sheet's amount input. */
export function showAmountError(panel, message) {
  const el = panel?.querySelector(".amount-error");
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

/** Clear the sheet's amount-input validation message, if any. */
export function clearAmountError(panel) {
  const el = panel?.querySelector(".amount-error");
  if (!el) return;
  el.hidden = true;
  el.textContent = "";
}
