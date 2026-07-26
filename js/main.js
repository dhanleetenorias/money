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
import * as sync from "./sync.js";
import { fmt, parseAmount, uid, ym } from "./money.js";
import * as R from "./render.js";
import { initToast, showToast } from "./toast.js";
import { registerSW, checkForUpdate } from "./sw-register.js";

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

/**
 * @type {{screen:'home'|'settings'|'history',
 *         sheet:'add'|'income'|'withdraw'|null,
 *         openMonth:string|null,
 *         syncOff:(()=>void)|null}}
 * `syncOff` is the sync.onChange unsubscribe. It is ONLY ever non-null while
 * the settings screen is mounted — leaving the screen must drop it, or every
 * visit adds another live subscriber holding a reference to a detached DOM.
 */
const ui = {
  screen: "home",
  sheet: null,
  openMonth: null,
  syncOff: null,
  /** Cumulative vault balance, read once when the withdraw sheet opens. */
  withdrawMaxCent: 0,
};

/* ------------------------------------------------------------------ *
 * Re-entrancy guard for money-writing handlers
 * ------------------------------------------------------------------ */

/** Action names currently mid-commit. See guarded(). */
const inFlight = new Set();

/**
 * Run a commit handler at most once at a time.
 *
 * INVARIANT: no handler that writes a transaction or a month may run twice
 * concurrently. Every commit path awaits IDB before it writes (a balance read,
 * a category lookup), and two taps inside that window both read the PRE-write
 * state and both pass the cap — ₱45,000 withdrawn twice against a ₱45,000
 * vault, with the balance display floored back to ₱0 so nothing looks wrong.
 *
 * Two layers, because either alone has a hole: the `disabled` flag stops the
 * taps the browser would deliver, and the in-flight set stops anything the DOM
 * can't (a synthetic click, a key repeat, a button that isn't there).
 *
 * Every button carrying `name` is disabled, not just the one tapped — the add
 * sheet has one chip per category, and a second tap on a DIFFERENT chip books
 * exactly the same double expense.
 *
 * @param {string} name the data-action value
 * @param {() => Promise<void>|void} fn
 */
async function guarded(name, fn) {
  if (inFlight.has(name)) return;
  inFlight.add(name);
  const btns = [...app.querySelectorAll(`[data-action="${name}"]`)];
  const wasDisabled = btns.map((b) => !!b.disabled);
  for (const b of btns) b.disabled = true;
  try {
    await fn();
  } finally {
    inFlight.delete(name);
    // Only restore nodes still in the document: a successful commit closes the
    // sheet and re-renders, so these are usually detached by now.
    btns.forEach((b, i) => {
      if (b.isConnected) b.disabled = wasDisabled[i];
    });
    // The withdraw button's enabled state is owned by the reason field, not by
    // us — re-derive it rather than assume. No-op unless that sheet is open.
    if (ui.sheet === "withdraw") {
      R.syncWithdrawEnabled(app.querySelector(".sheet-panel"));
    }
  }
}

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
  // The card must quote the CUMULATIVE balance, from the same function the
  // withdraw sheet's ceiling comes from (withdrawableCent -> maxWithdrawable
  // -> vaultBalance). vaultState().totalCent is this month's contribution,
  // floored at 0: with six months banked, a legal ₱50,000 withdrawal drove the
  // card to ₱0 while ₱595,000 was still there and still withdrawable.
  // INVARIANT: the card and the withdraw sheet read one number, so they cannot
  // disagree. `vault` keeps vaultState's shape (pct comes from the snapshot)
  // with only the displayed total swapped for the real balance.
  const perMonth = B.vaultState(month, txns);
  const allTxns = await idb.getAllTxns();
  const balanceCent = B.vaultBalance(
    store.getMonths(),
    allTxns,
    key,
  ).balanceCent;
  return {
    hasIncome: true,
    monthLabel: label,
    incomeCent: month.incomeCent,
    vaultLabel: "Vault",
    vault: { ...perMonth, totalCent: balanceCent },
    hero: B.safeToSpendToday(month, txns, now),
    poolLeftCent: B.spendablePool(month, txns).leftCent,
    pace: B.paceDelta(month, txns, now),
    paceTick: B.envelopePaceTick(month, now),
    envelopes: B.allEnvelopes(month, txns, now),
  };
}

/** Pending inline messages for the next settings render, then cleared. */
const settingsMsg = {
  catError: "",
  syncError: "",
  syncNotice: "",
  backupError: "",
};

function settingsVM() {
  const cats = store.getCategories();
  return {
    categories: cats,
    totalPct: cats.reduce((s, c) => s + (Number(c.pct) || 0), 0),
    syncUrl: store.getSyncUrl(),
    // The token is a secret: it goes into the password input's value and
    // NOWHERE else. It is never logged, never put in a URL, never exported.
    token: store.getToken(),
    status: sync.status(),
    fallback: idb.isFallback(),
    catError: settingsMsg.catError,
    syncError: settingsMsg.syncError,
    syncNotice: settingsMsg.syncNotice,
    backupError: settingsMsg.backupError,
  };
}

async function historyVM() {
  const months = Object.values(store.getMonths())
    .filter((m) => m && typeof m.key === "string")
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));

  const openKey = ui.openMonth;
  let txns = [];
  if (openKey) {
    // Names come from the month's OWN alloc snapshot, not from live settings —
    // a category renamed in Settings must not retitle history.
    const open = months.find((m) => m.key === openKey);
    const names = new Map((open?.alloc ?? []).map((a) => [a.id, a.name]));
    txns = (await idb.getTxns(openKey))
      .slice()
      .sort((a, b) => b.ts - a.ts)
      .map((t) => ({
        ...t,
        categoryName: names.get(t.categoryId) ?? t.categoryId,
      }));
  }

  return {
    openKey,
    months: months.map((m) => ({
      key: m.key,
      label: `${monthLabel(m.key)} ${String(m.key).slice(0, 4)}`,
      incomeCent: m.incomeCent || 0,
      closed: !!m.closedAt,
      sweptCent: Number.isFinite(m.sweep?.fromCent) ? m.sweep.fromCent : 0,
      txns: m.key === openKey ? txns : null,
    })),
  };
}

async function renderFull() {
  // Leaving settings drops the sync subscription. Doing this before the
  // innerHTML swap means the callback can never fire against a detached node.
  if (ui.screen !== "settings" && ui.syncOff) {
    ui.syncOff();
    ui.syncOff = null;
  }

  if (ui.screen === "settings") {
    app.innerHTML = R.renderSettingsScreen(settingsVM());
    settingsMsg.catError = "";
    settingsMsg.syncError = "";
    settingsMsg.syncNotice = "";
    settingsMsg.backupError = "";
    bindSyncStatus();
  } else if (ui.screen === "history") {
    app.innerHTML = R.renderHistoryScreen(await historyVM());
  } else {
    app.innerHTML = R.renderHome(await homeVM());
  }
  app.scrollTop = 0;
  if (ui.sheet) renderSheet();
}

/** (Re)subscribe the settings sync block. One subscriber at a time, always. */
function bindSyncStatus() {
  if (ui.syncOff) {
    ui.syncOff();
    ui.syncOff = null;
  }
  ui.syncOff = sync.onChange((s) => {
    // Guard: a late callback after navigating away must not paint.
    if (ui.screen !== "settings") return;
    R.patchSyncStatus(app.querySelector(".screen-settings"), s);
  });
}

function spendableCategories() {
  return store.getCategories().filter((c) => !c.vault);
}

/**
 * The vault category id for a month, taken from THAT MONTH'S alloc snapshot.
 *
 * Same rule the sweep row follows (see runRollover): settings can be edited or
 * the vault renamed at any time, so the live category list is the wrong source
 * for a row being filed against a specific month. Falls back to the settings
 * vault, then to "save", so a corrupt snapshot still books the withdrawal
 * rather than dropping it.
 */
function vaultIdFor(month) {
  const fromSnapshot = (month?.alloc ?? []).find((a) => a.vault)?.id;
  if (fromSnapshot) return fromSnapshot;
  return store.getCategories().find((c) => c.vault)?.id ?? "save";
}

/** Cumulative vault balance — the real ceiling for a withdrawal. */
async function withdrawableCent(monthKey) {
  const all = await idb.getAllTxns();
  return B.maxWithdrawable(store.getMonths(), all, monthKey);
}

function renderSheet() {
  // Sheets are appended after #app's innerHTML is already set by renderFull,
  // OR replace an existing sheet node — never nested inside the screen div,
  // so a home re-render underneath never touches a focused sheet input.
  const prev = document.querySelector(".sheet");
  let html;
  if (ui.sheet === "add") {
    html = R.renderAddSheet({ categories: spendableCategories() });
  } else if (ui.sheet === "withdraw") {
    html = R.renderWithdrawSheet({ availableCent: ui.withdrawMaxCent ?? 0 });
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

/** The vault balance has to be read before the sheet can quote it. */
async function openWithdrawSheet() {
  ui.withdrawMaxCent = await withdrawableCent(ym(Date.now()));
  openSheet("withdraw");
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
  // Expenses are the common case and were the ONE commit path not kicking
  // sync — they sat in the outbox until some other write happened to drain
  // them. The 3s undo still wins: it deletes the txn and its outbox row, and
  // a delete that lands after the push is sent as a compensating void.
  sync.kick();
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

/* ------------------------------------------------------------------ *
 * Withdraw — access with friction
 * ------------------------------------------------------------------ */

/**
 * Book a withdrawal from the vault.
 *
 * Three gates, all inline (a confirm() dialog would be one tap of muscle
 * memory and teach nothing):
 *   1. a usable amount
 *   2. a NON-EMPTY reason — the friction, and the only record of why
 *   3. it fits inside the cumulative vault balance
 *
 * kind:'withdrawal' is what keeps this honest: budget.js drops withdrawals
 * from spendIndex BY KIND, so the vault total falls while safeToSpendToday
 * does not move a centavo. That is the entire point of the feature.
 */
async function commitWithdrawal() {
  const panel = app.querySelector(".sheet-panel");
  const amountInput = panel?.querySelector(".amount-input");
  const noteInput = panel?.querySelector(".note-input");

  const note = (noteInput?.value ?? "").trim();
  if (!note) {
    R.showReasonError(panel, "Add a reason before you withdraw");
    noteInput?.focus();
    return;
  }

  const cent = parseAmount(amountInput?.value ?? "");
  if (cent == null || cent <= 0) {
    R.showAmountError(panel, "Enter an amount first");
    amountInput?.focus();
    return;
  }

  const key = ym(Date.now());
  // Re-read rather than trusting the value captured when the sheet opened:
  // another tab or a rollover could have moved the balance since.
  const availableCent = await withdrawableCent(key);
  if (cent > availableCent) {
    R.showAmountError(panel, `Only ${fmt(availableCent)} available`);
    amountInput?.focus();
    return;
  }
  R.clearAmountError(panel);
  R.showReasonError(panel, "");

  const txn = {
    id: uid(),
    monthKey: key,
    ts: Date.now(),
    cent,
    categoryId: vaultIdFor(store.getMonth(key)),
    note,
    kind: "withdrawal",
    synced: 0,
    deleted: 0,
  };
  await idb.addTxn(txn);
  sync.kick();
  closeSheet();
  await renderFull();

  showToast(`${fmt(cent)} withdrawn`, {
    actionLabel: "Undo",
    duration: 3000,
    onAction: async () => {
      // Inside the 3s window the row is almost certainly still unsynced, but
      // check rather than assume — a hard delete of a synced row strands it in
      // the sheet forever. undoTxn picks delete-vs-void off the stored flag.
      await undoTxn(txn.id);
      renderFull();
    },
  });
}

/**
 * Remove a txn using the correct primitive for its sync state.
 *
 * deleteTxn is a HARD delete and only safe while the row has never been
 * pushed; it drops the outbox op too. Once `synced` is 1 the server has the
 * row, so the reversal has to be a voidTxn tombstone that enqueues a
 * compensating op — otherwise the row lives in the sheet forever. Getting
 * this backwards the other way (voiding an unsynced row) leaves a tombstone
 * for a row the server never saw.
 */
async function undoTxn(id) {
  const all = await idb.getAllTxns();
  const rec = all.find((t) => t.id === id);
  if (!rec) return false;
  if (rec.synced === 1) {
    await idb.voidTxn(id);
    sync.kick();
  } else {
    await idb.deleteTxn(id);
  }
  return true;
}

/**
 * Reverse a month's close so it can be edited again.
 *
 * store.reopenMonth clears `closedAt` AND `sweep`, which puts the month back
 * in the close queue — so per its JSDoc the caller must have reversed the
 * ORIGINAL sweep first, or those same leftovers get swept into the vault a
 * second time when the month closes again.
 *
 * Two halves to that reversal, and both are required:
 *   - the month's `sweep` record, which is what vaultBalance actually adds up.
 *     reopenMonth clears it, so the vault stops counting it the moment we
 *     return.
 *   - the kind:'sweep' TXN row. budget.js ignores sweep rows so it changes no
 *     local number, but it is a real row in the Google Sheet. Leave it and the
 *     re-close appends a second one, and SUM(E:E) counts the sweep twice —
 *     the same defect as the rollover double-write, arrived at from the other
 *     direction. undoTxn picks void-vs-delete off the synced flag, so a row
 *     the server already has gets a compensating tombstone rather than
 *     vanishing locally and living forever remotely.
 *
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function reopenMonthForEdit(key) {
  const res = store.reopenMonth(key);
  if (!res.ok) return res;
  const rows = await idb.getTxns(key);
  for (const t of rows) {
    if (t?.kind === "sweep") await undoTxn(t.id);
  }
  return { ok: true };
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
  let reopening = false;
  if (existing?.closedAt) {
    if (
      !confirm(
        `${monthLabel(key)} is already closed. Reopen and edit income?\n\n` +
          `This reverses the month-close sweep — those leftovers go back to ` +
          `their envelopes and out of the vault.`,
      )
    ) {
      return;
    }
    // upsertMonth REFUSES every write to a closed month and returns the stored
    // record, so this has to happen before the write or the whole edit is a
    // silent no-op: the user confirms, types a number, the sheet closes, and
    // nothing changed.
    const res = await reopenMonthForEdit(key);
    if (!res.ok) {
      R.showAmountError(panel, res.error || "Could not reopen that month");
      amountInput?.focus();
      return;
    }
    reopening = true;
  }
  // Editing an open month re-snapshots alloc from current settings — same
  // path as opening a fresh one, per budget.js's newMonthFromSettings contract.
  // Reopening drops the old sweep/closedAt: that sweep was computed against
  // the alloc being replaced here, so keeping it would let a later close
  // replay stale numbers against a fresh allocation.
  const settings = store.getSettings();
  const openedAt = existing?.openedAt ?? Date.now();
  const rec = B.newMonthFromSettings(settings, key, cent, openedAt);
  if (existing?.sweep && !reopening) rec.sweep = existing.sweep;
  if (existing?.closedAt && !reopening) rec.closedAt = existing.closedAt;
  store.upsertMonth(rec);
  if (reopening) sync.kick();

  closeSheet();
  await renderFull();
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

/**
 * Write the percentage rows back.
 *
 * setCategories is the single 100%-total gate and it RETURNS {ok:false,error}
 * instead of throwing, so the message goes inline. The Save button is already
 * disabled off-100, but this still checks: an inline error is what explains a
 * duplicate id or a negative, which the total alone can't catch.
 *
 * Values are read here, on the tap — never on `input` (RULE 2).
 */
function saveCategories() {
  const screen = app.querySelector(".screen-settings");
  // Matched by reading each input's own data-cat-id rather than building a
  // selector from the id: an id restored from a backup is arbitrary text and
  // would need escaping to be safe inside an attribute selector.
  const byId = new Map(
    [...(screen?.querySelectorAll(".cat-row-pct") ?? [])].map((el) => [
      el.getAttribute("data-cat-id"),
      el,
    ]),
  );
  const next = store.getCategories().map((c) => {
    const n = Number(byId.get(c.id)?.value);
    return { ...c, pct: Number.isFinite(n) ? n : 0 };
  });

  const res = store.setCategories(next);
  if (!res.ok) {
    R.showSettingsError(screen?.querySelector(".settings-section"), res.error);
    return;
  }
  showToast("Percentages saved — they apply from next month");
  renderFull();
}

function saveSync() {
  const screen = app.querySelector(".screen-settings");
  const url = screen?.querySelector(".sync-url-input")?.value ?? "";
  // Read straight into configure(). The token is never copied into a log, a
  // URL, a toast or a template — only into store.setToken via configure.
  const token = screen?.querySelector(".sync-token-input")?.value ?? "";
  const res = sync.configure(url, token);
  if (!res.ok) {
    settingsMsg.syncError = res.error;
  } else {
    settingsMsg.syncNotice = "Saved. Syncing…";
  }
  renderFull();
}

async function testSync() {
  const res = await sync.testConnection();
  if (res.ok) {
    settingsMsg.syncNotice = "Connection OK";
  } else {
    settingsMsg.syncError = res.error;
  }
  renderFull();
}

function exportBackup() {
  try {
    const blob = new Blob([store.exportJSON()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    // Manila date, not toISOString() — a backup taken at 22:00 must not be
    // filed under tomorrow.
    a.download = `money-backup-${ym(Date.now())}-${new Date().getDate()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    showToast("Export failed");
  }
}

async function importBackup(file) {
  if (!file) return;
  if (
    !confirm(
      "Import replaces ALL settings and months on this device. Continue?",
    )
  ) {
    return;
  }
  let text = "";
  try {
    text = await file.text();
  } catch {
    settingsMsg.backupError = "Could not read that file";
    renderFull();
    return;
  }
  const res = store.importJSON(text);
  if (!res.ok) {
    settingsMsg.backupError = res.error || "Import failed";
  } else {
    showToast("Backup imported");
  }
  await renderFull();
}

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

async function deleteFromHistory(id) {
  if (!id) return;
  if (!confirm("Delete this transaction? This cannot be undone.")) return;
  const ok = await undoTxn(id);
  if (ok) showToast("Transaction deleted");
  await renderFull();
}

/* ------------------------------------------------------------------ *
 * Month rollover — idempotent, safe to call repeatedly
 * ------------------------------------------------------------------ */

/** True while runRollover is mid-flight. See the re-entrancy note below. */
let rolloverRunning = false;

async function runRollover() {
  // RE-ENTRANCY. This runs on boot AND on every visibilitychange, and it
  // awaits IDB inside the loop. Two overlapping passes both see the month as
  // open, and while store.closeMonth is idempotent it RETURNS the already-
  // closed record — truthy — so a `if (!closed)` check waves the second pass
  // through and a second kind:'sweep' row gets appended with a fresh uid().
  // A fresh uid is a fresh idempotency key, so the server cannot dedupe it and
  // the sheet's SUM(E:E) double-counts the sweep. budget.js ignores sweep rows
  // so the app itself stays right, which is exactly why this would go unseen.
  if (rolloverRunning) return;
  rolloverRunning = true;
  try {
    const months = store.getMonths();
    const keys = B.monthsToClose(months, Date.now());
    let closedAny = false;
    for (const key of keys) {
      const month = store.getMonth(key);
      if (!month) continue;
      // Re-read INSIDE the loop, after the await: the state that mattered was
      // captured before we yielded. If it is already closed, someone else did
      // it and the sweep row is already theirs to write.
      if (month.closedAt) continue;
      const txns = await idb.getTxns(key);
      const fresh = store.getMonth(key);
      if (!fresh || fresh.closedAt) continue;
      const sweep = B.computeSweep(fresh, txns);
      const closed = store.closeMonth(key, sweep);
      // closeMonth returns the record whether WE closed it or it was already
      // closed. The sweep row may only be written for a real transition, so
      // gate on closedAt having been absent immediately before the call.
      if (!closed) continue;
      closedAny = true;
      // kind:'sweep' rows are excluded from all spend math regardless of
      // categoryId (see budget.js spendIndex) — this is bookkeeping/display
      // only, so tag it with whichever category is the vault in this month's
      // own snapshot rather than assuming the default settings id "save".
      const vaultId = closed.alloc.find((a) => a.vault)?.id ?? "save";
      await idb.addTxn({
        id: uid(),
        monthKey: key,
        ts: Date.now(),
        cent: sweep.toVaultCent,
        categoryId: vaultId,
        note: "Month close sweep",
        kind: "sweep",
        synced: 0,
        deleted: 0,
      });
    }
    if (closedAny && ui.screen === "home" && !ui.sheet) await renderFull();
  } finally {
    rolloverRunning = false;
  }
}

/* ------------------------------------------------------------------ *
 * Delegated events — ONE listener
 * ------------------------------------------------------------------ */

app.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const a = el.getAttribute("data-action");

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
    // The three money-writing paths. Each is wrapped so a double-tap inside
    // the await window can't book the same row twice — see guarded().
    case "add-expense": {
      const catId = el.getAttribute("data-cat-id");
      guarded(a, () => commitExpense(catId));
      break;
    }
    case "save-income":
      guarded(a, saveIncome);
      break;
    case "open-withdraw":
      openWithdrawSheet();
      break;
    case "commit-withdraw":
      guarded(a, commitWithdrawal);
      break;
    case "save-categories":
      saveCategories();
      break;
    case "save-sync":
      saveSync();
      break;
    case "test-sync":
      testSync();
      break;
    case "export-json":
      exportBackup();
      break;
    case "import-json":
      app.querySelector(".import-file")?.click();
      break;
    case "toggle-month":
      ui.openMonth =
        ui.openMonth === el.getAttribute("data-id")
          ? null
          : el.getAttribute("data-id");
      renderFull();
      break;
    case "delete-txn":
      deleteFromHistory(el.getAttribute("data-id"));
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
      ui.openMonth = null;
      renderFull();
      break;
    default:
      break;
  }
});

// The hidden file input can't be delegated by data-action — it fires `change`.
app.addEventListener("change", (e) => {
  if (!e.target.matches?.(".import-file")) return;
  const file = e.target.files?.[0];
  e.target.value = ""; // let the same file be picked twice
  importBackup(file);
});

// Escape closes the open sheet — same affordance as a backdrop tap.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && ui.sheet) closeSheet();
});

// Amount inputs are free-typed on 'input' for live display, but nothing
// commits until 'change'/'blur' — RULE 2. Everything below is DISPLAY ONLY:
// each branch clears a message, flips a `disabled` flag, or rewrites a total
// that is not the focused node. No branch may re-render, or the iOS keyboard
// drops on the first character typed (RULE 1).
app.addEventListener(
  "input",
  (e) => {
    const t = e.target;
    if (t.matches?.(".amount-input")) {
      R.clearAmountError(app.querySelector(".sheet-panel"));
      return;
    }
    if (t.matches?.(".note-input") && ui.sheet === "withdraw") {
      // The required-reason gate: enable/disable only.
      const panel = app.querySelector(".sheet-panel");
      R.syncWithdrawEnabled(panel);
      if (t.value.trim()) R.showReasonError(panel, "");
      return;
    }
    if (t.matches?.(".cat-row-pct")) {
      R.patchPctTotal(app.querySelector(".screen-settings"));
    }
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
    if (document.visibilityState !== "visible") return;
    runRollover();
    // An installed home-screen PWA is resumed, not cold-started, so without
    // this a deploy can sit in the `waiting` state for days. checkForUpdate
    // re-checks and tells any waiting worker to skipWaiting; it swallows all
    // errors and is a no-op when no SW is registered.
    checkForUpdate();
  });

  store.requestPersist();
  registerSW();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
