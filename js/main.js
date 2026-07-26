/**
 * MONEY — boot, screen routing, delegated events.
 *
 * Integration layer. Owns:
 *   - the single delegated listener on #app (data-action attributes)
 *   - screen/sheet state and when to renderFull() vs a targeted patch
 *   - month rollover (monthsToClose -> computeSweep -> closeMonth) on boot
 *     and on visibilitychange
 *   - the add-expense sheet's 3-tap commit + 3s undo
 *
 * TWO RULES INHERITED FROM lift THAT MUST NOT BE BROKEN:
 *   1. Never re-render while an <input> in the open sheet has focus — it
 *      kills the iOS keyboard and caret mid-entry. Use the patch helpers in
 *      render.js (toggleNoteRow / showAmountError / clearAmountError).
 *   2. Commit input values on `change`/`blur`, NEVER on `input`.
 */

import * as store from "./store.js";
import * as idb from "./idb.js";
import * as B from "./budget.js";
import { fmt, parseAmount, uid, ym } from "./money.js";
import * as R from "./render.js";
import { initToast, showToast } from "./toast.js";
import { registerSW } from "./sw-register.js";

const app = document.getElementById("app");

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** @type {{screen:'home'|'settings'|'history', sheet:'add'|'income'|null}} */
const ui = { screen: "home", sheet: null };

/* ------------------------------------------------------------------ *
 * Month helpers
 * ------------------------------------------------------------------ */

function monthLabel(key) {
  const [, m] = String(key).split("-").map(Number);
  return MONTH_NAMES[(m || 1) - 1];
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

async function homeVM() {
  const key = ym(Date.now());
  const month = store.getMonth(key);
  const label = monthLabel(key);
  if (!month || !month.incomeCent) {
    return { hasIncome: false, monthLabel: label };
  }
  const txns = await idb.getTxns(key);
  const now = Date.now();
  return {
    hasIncome: true,
    monthLabel: label,
    incomeCent: month.incomeCent,
    vaultLabel: "Vault",
    vault: B.vaultState(month, txns),
    hero: B.safeToSpendToday(month, txns, now),
    poolLeftCent: B.spendablePool(month, txns).leftCent,
    pace: B.paceDelta(month, txns, now),
    paceTick: B.envelopePaceTick(month, now),
    envelopes: B.allEnvelopes(month, txns, now),
  };
}

async function renderFull() {
  if (ui.screen === "settings") {
    app.innerHTML = R.renderSettingsScreen();
  } else if (ui.screen === "history") {
    app.innerHTML = R.renderHistoryScreen();
  } else {
    app.innerHTML = R.renderHome(await homeVM());
  }
  app.scrollTop = 0;
  if (ui.sheet) renderSheet();
}

function spendableCategories() {
  return store.getCategories().filter((c) => !c.vault);
}

function renderSheet() {
  // Sheets are appended after #app's innerHTML is already set by renderFull,
  // OR replace an existing sheet node — never nested inside the screen div,
  // so a home re-render underneath never touches a focused sheet input.
  const prev = document.querySelector(".sheet");
  let html;
  if (ui.sheet === "add") {
    html = R.renderAddSheet({ categories: spendableCategories() });
  } else if (ui.sheet === "income") {
    const key = ym(Date.now());
    const month = store.getMonth(key);
    html = R.renderIncomeSheet({
      monthLabel: monthLabel(key),
      hasExisting: !!month,
      prefill: month?.incomeCent ? String(month.incomeCent / 100) : "",
    });
  } else {
    prev?.remove();
    return;
  }
  if (prev) prev.remove();
  app.insertAdjacentHTML("beforeend", html);
  const panel = app.querySelector(".sheet-panel");
  const amountInput = panel?.querySelector(".amount-input");
  // Sheet target: amount field focused on open — main.js does this rather
  // than relying on the `autofocus` attribute, which iOS Safari ignores for
  // elements injected via innerHTML.
  amountInput?.focus();
}

function openSheet(name) {
  ui.sheet = name;
  renderSheet();
}

function closeSheet() {
  ui.sheet = null;
  renderSheet();
}

/* ------------------------------------------------------------------ *
 * Add-expense: 3 taps, under 3 seconds
 * ------------------------------------------------------------------ */

async function commitExpense(catId) {
  const panel = app.querySelector(".sheet-panel");
  const amountInput = panel?.querySelector(".amount-input");
  const noteInput = panel?.querySelector(".note-input");
  const cent = parseAmount(amountInput?.value ?? "");
  if (cent == null || cent <= 0) {
    R.showAmountError(panel, "Enter an amount first");
    amountInput?.focus();
    return;
  }
  R.clearAmountError(panel);

  const txn = {
    id: uid(),
    monthKey: ym(Date.now()),
    ts: Date.now(),
    cent,
    categoryId: catId,
    note: noteInput?.value || "",
    kind: "expense",
    synced: 0,
    deleted: 0,
  };
  await idb.addTxn(txn);
  closeSheet();
  await renderFull();

  showToast(`${fmt(cent)} logged`, {
    actionLabel: "Undo",
    duration: 3000,
    onAction: async () => {
      await idb.deleteTxn(txn.id);
      renderFull();
    },
  });
}

async function saveIncome() {
  const panel = app.querySelector(".sheet-panel");
  const amountInput = panel?.querySelector(".amount-input");
  const cent = parseAmount(amountInput?.value ?? "");
  if (cent == null || cent < 0) {
    R.showAmountError(panel, "Enter a valid amount");
    amountInput?.focus();
    return;
  }
  R.clearAmountError(panel);

  const key = ym(Date.now());
  const existing = store.getMonth(key);
  if (existing?.closedAt) {
    if (
      !confirm(`${monthLabel(key)} is already closed. Reopen and edit income?`)
    ) {
      return;
    }
    existing.closedAt = null;
  }
  // Editing an open month re-snapshots alloc from current settings — same
  // path as opening a fresh one, per budget.js's newMonthFromSettings contract.
  const settings = store.getSettings();
  const openedAt = existing?.openedAt ?? Date.now();
  const rec = B.newMonthFromSettings(settings, key, cent, openedAt);
  if (existing?.sweep) rec.sweep = existing.sweep;
  if (existing?.closedAt) rec.closedAt = existing.closedAt;
  store.upsertMonth(rec);

  closeSheet();
  await renderFull();
}

/* ------------------------------------------------------------------ *
 * Month rollover — idempotent, safe to call repeatedly
 * ------------------------------------------------------------------ */

async function runRollover() {
  const months = store.getMonths();
  const keys = B.monthsToClose(months, Date.now());
  for (const key of keys) {
    const month = store.getMonth(key);
    if (!month) continue;
    const txns = await idb.getTxns(key);
    const sweep = B.computeSweep(month, txns);
    const closed = store.closeMonth(key, sweep);
    if (!closed) continue;
    await idb.addTxn({
      id: uid(),
      monthKey: key,
      ts: Date.now(),
      cent: sweep.toVaultCent,
      categoryId: "save",
      note: "Month close sweep",
      kind: "sweep",
      synced: 0,
      deleted: 0,
    });
  }
  if (keys.length && ui.screen === "home" && !ui.sheet) await renderFull();
}

/* ------------------------------------------------------------------ *
 * Delegated events — ONE listener
 * ------------------------------------------------------------------ */

app.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  const onBackdrop = e.target.classList?.contains("sheet-backdrop");
  if (!el && !onBackdrop) return;
  const a = onBackdrop ? "close-sheet" : el.getAttribute("data-action");

  switch (a) {
    case "open-add":
      openSheet("add");
      break;
    case "open-income":
      openSheet("income");
      break;
    case "close-sheet":
      closeSheet();
      break;
    case "toggle-note":
      R.toggleNoteRow(app.querySelector(".sheet-panel"));
      break;
    case "add-expense":
      commitExpense(el.getAttribute("data-cat-id"));
      break;
    case "save-income":
      saveIncome();
      break;
    case "go-settings":
      ui.screen = "settings";
      renderFull();
      break;
    case "go-history":
      ui.screen = "history";
      renderFull();
      break;
    case "go-home":
      ui.screen = "home";
      renderFull();
      break;
    default:
      break;
  }
});

// Escape closes the open sheet — same affordance as a backdrop tap.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && ui.sheet) closeSheet();
});

// Amount inputs are free-typed on 'input' for live display, but nothing
// commits until 'change'/'blur' — RULE 2. There's no derived UI to patch
// live here (unlike lift's plate calc), so 'input' needs no handler at all;
// this listener exists to make that contract explicit and to clear a
// stale validation message as soon as the user edits the value again.
app.addEventListener(
  "input",
  (e) => {
    if (!e.target.matches?.(".amount-input")) return;
    R.clearAmountError(app.querySelector(".sheet-panel"));
  },
  true,
);

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function boot() {
  initToast(document.body);

  await runRollover();
  await renderFull();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") runRollover();
  });

  store.requestPersist();
  registerSW();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
