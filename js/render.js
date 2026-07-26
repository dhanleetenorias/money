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

import { fmt, TZ } from "./money.js";

/* ---- date/time display -------------------------------------------------- */

const dtfCache = new Map();
function dtf(kind) {
  let f = dtfCache.get(kind);
  if (f) return f;
  const base = { timeZone: TZ };
  f = new Intl.DateTimeFormat(
    "en-PH",
    kind === "day"
      ? { ...base, month: "short", day: "numeric" }
      : {
          ...base,
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        },
  );
  dtfCache.set(kind, f);
  return f;
}

/** "Jul 27" in Manila time — never toISOString(), which is 8h behind. */
function shortDate(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return "";
  try {
    return dtf("day").format(new Date(n));
  } catch {
    return "";
  }
}

function shortStamp(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return "";
  try {
    return dtf("stamp").format(new Date(n));
  } catch {
    return "";
  }
}

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

/**
 * Coerce to a finite number inside [lo,hi]. Used for anything that lands in a
 * style/width attribute: a non-number must become 0, never reach the markup as
 * text. This is the numeric sibling of esc() — between the two, EVERY `${}` in
 * an attribute context in this file is either esc()'d or forced numeric.
 */
function num(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

function daysWord(n) {
  const c = Number(n);
  const safe = Number.isFinite(c) ? c : 0;
  return `${safe} day${safe === 1 ? "" : "s"}`;
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
  return `<p class="pace ${esc(line.cls)}">${esc(line.text)}</p>`;
}

/** One envelope row: name, bar with pace tick, % micro-label, ₱ left. */
function renderEnvRow(env, paceTick) {
  // Numeric coercion is itself an escape: a non-number lands as 0 rather than
  // reaching the style attribute as text.
  const fillRatio = num(env.ratio, 0, 1);
  // The micro-label is the envelope's ALLOCATION share ("30%"), which is fixed
  // and identifies the envelope. Using env.ratio here showed spend-so-far, so
  // every row read "0%" on a fresh month.
  const pctLabel = Math.round(Number(env.pct) || 0);
  const tickPct = (num(paceTick, 0, 1) * 100).toFixed(2);
  const overLine = env.over
    ? `<span class="env-over">Over by ${fmt(env.overCent)}</span>`
    : "";
  return `<div class="env env--${esc(env.state)}" data-id="${esc(env.id)}">
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
      <button class="vault-withdraw btn btn-ghost" type="button"
        data-action="open-withdraw">Withdraw</button>
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

/**
 * Withdraw sheet — money leaving the vault.
 *
 * ACCESS WITH FRICTION, not a locked box. The vault is excluded from
 * "safe to spend today" so the daily number stays honest, but real birthdays
 * and gifts get paid out of it a few times a year. The friction is a REQUIRED
 * reason, not a confirm dialog: the reason is the thing you read back in
 * History six months later, and a confirm teaches nothing.
 *
 * The submit button ships disabled and main.js enables it on the note's
 * input event (that listener only flips `disabled` — it never re-renders, so
 * RULE 1 holds and the keyboard stays up).
 *
 * @param {{availableCent:number}} vm  from budget.maxWithdrawable()
 * @returns {string}
 */
export function renderWithdrawSheet(vm) {
  const availableCent = Number.isFinite(vm?.availableCent)
    ? vm.availableCent
    : 0;
  return `<div class="sheet screen-withdraw" role="dialog" aria-modal="true" aria-label="Withdraw from vault">
    <div class="sheet-backdrop" data-action="close-sheet"></div>
    <div class="sheet-panel">
      <h2 class="sheet-title">Withdraw from vault</h2>
      <p class="withdraw-available">${fmt(availableCent)} available</p>
      <input class="amount-input amt" type="text" inputmode="decimal" placeholder="₱0"
        autocomplete="off" aria-label="Amount to withdraw">
      <p class="amount-error" hidden></p>
      <div class="withdraw-reason">
        <label class="withdraw-reason-label" for="withdraw-note">What is this for?</label>
        <input class="note-input" id="withdraw-note" type="text" required
          placeholder="Required &mdash; e.g. Mom's birthday gift" aria-label="Reason">
        <p class="withdraw-hint">A reason is required. It's the only record of why this money left.</p>
      </div>
      <button class="btn btn-primary" type="button" data-action="commit-withdraw"
        disabled>Withdraw</button>
    </div>
  </div>`;
}

/* -------------------------------------------------------------------- */
/* Settings                                                             */
/* -------------------------------------------------------------------- */

/**
 * One editable percentage row. The input commits on change/blur only
 * (RULE 2) — main.js reads every row's value when Save is tapped, so a
 * half-typed field can never be written.
 */
function renderPctRow(cat) {
  const vaultTag = cat.vault ? ` <span class="cat-row-tag">Vault</span>` : "";
  return `<div class="cat-row" data-cat-id="${esc(cat.id)}">
    <span class="cat-row-name">${esc(cat.name)}${vaultTag}</span>
    <input class="cat-row-pct num" type="number" inputmode="decimal"
      min="0" max="100" step="0.01" value="${esc(String(cat.pct))}"
      data-cat-id="${esc(cat.id)}"
      aria-label="${esc(cat.name)} percent">
    <span class="cat-row-unit" aria-hidden="true">%</span>
  </div>`;
}

/**
 * The sync status block. ONE node, always present (even unconfigured), so
 * patchSyncStatus can swap its innerHTML without ever restructuring the
 * screen around a focused input.
 */
function syncStatusInner(status) {
  const s = status || {};
  const bits = [
    s.configured
      ? `<span class="sync-stat">Configured</span>`
      : `<span class="sync-stat sync-stat--off">Not configured</span>`,
    `<span class="sync-stat">${Number(s.pending) || 0} pending</span>`,
    s.lastOkAt
      ? `<span class="sync-stat">Last sync ${esc(shortStamp(s.lastOkAt))}</span>`
      : `<span class="sync-stat">Never synced</span>`,
  ];
  if (s.syncing) bits.push(`<span class="sync-stat">Syncing&hellip;</span>`);
  const err = s.lastErr
    ? `<span class="sync-error">${esc(s.lastErr)}</span>`
    : "";
  return bits.join("") + err;
}

function renderSyncStatus(status) {
  return `<div class="sync-status">${syncStatusInner(status)}</div>`;
}

/**
 * Settings screen.
 *
 * The token input carries the secret. It is `type="password"`, it is never
 * logged, and it is never interpolated anywhere except this one `value`
 * attribute — nothing else on this screen may read it back out.
 *
 * @param {{categories:{id,name,pct,vault}[], totalPct:number,
 *          syncUrl:string, token:string, status:object,
 *          fallback:boolean, catError?:string, syncError?:string,
 *          syncNotice?:string}} vm
 * @returns {string}
 */
export function renderSettingsScreen(vm) {
  const cats = Array.isArray(vm?.categories) ? vm.categories : [];
  const total = Number.isFinite(vm?.totalPct) ? vm.totalPct : 0;
  // Compared the way store.validateCategories compares, so the button state
  // and the actual write agree exactly — 33.33+33.33+33.34 must read as 100.
  const balanced = Math.round(total * 1e6) === 100 * 1e6;
  const totalText = Number.isInteger(total) ? String(total) : total.toFixed(2);

  const catError = vm?.catError
    ? `<p class="settings-error">${esc(vm.catError)}</p>`
    : "";
  const backupError = vm?.backupError
    ? `<p class="settings-error">${esc(vm.backupError)}</p>`
    : "";
  const syncError = vm?.syncError
    ? `<p class="settings-error">${esc(vm.syncError)}</p>`
    : "";
  const syncNotice = vm?.syncNotice
    ? `<p class="settings-notice">${esc(vm.syncNotice)}</p>`
    : "";
  const fallbackNote = vm?.fallback
    ? `<p class="settings-note">Local-only storage &mdash; this browser refused IndexedDB, so transactions live in localStorage. Export a backup regularly.</p>`
    : "";

  return `<div class="screen screen-settings">
    <header class="topbar">
      <button class="btn btn-ghost" type="button" data-action="go-home" aria-label="Back">&lsaquo;</button>
      <h1>Settings</h1>
    </header>

    <section class="settings-section">
      <h2 class="settings-title">Percentages</h2>
      <div class="cat-rows">${cats.map(renderPctRow).join("")}</div>
      <div class="cat-total ${balanced ? "cat-total--ok" : "cat-total--bad"}">
        <span class="cat-total-label">Total</span>
        <span class="cat-total-value num">${esc(totalText)}%</span>
      </div>
      ${catError}
      <p class="settings-note">Changes apply to FUTURE months. This month's split was
        snapshotted when you set its income and stays frozen on purpose.</p>
      <button class="btn btn-primary" type="button" data-action="save-categories"
        ${balanced ? "" : "disabled"}>Save percentages</button>
    </section>

    <section class="settings-section">
      <h2 class="settings-title">Sync</h2>
      <label class="field">
        <span class="field-label">Apps Script /exec URL</span>
        <input class="sync-url-input" type="url" inputmode="url" autocomplete="off"
          autocapitalize="off" spellcheck="false"
          placeholder="https://script.google.com/&hellip;/exec"
          value="${esc(vm?.syncUrl ?? "")}">
      </label>
      <label class="field">
        <span class="field-label">Token</span>
        <input class="sync-token-input" type="password" autocomplete="off"
          autocapitalize="off" spellcheck="false" placeholder="Shared secret"
          value="${esc(vm?.token ?? "")}">
      </label>
      ${syncError}
      ${syncNotice}
      <div class="settings-actions">
        <button class="btn btn-primary" type="button" data-action="save-sync">Save</button>
        <button class="btn btn-ghost" type="button" data-action="test-sync">Test connection</button>
      </div>
      ${renderSyncStatus(vm?.status)}
    </section>

    <section class="settings-section">
      <h2 class="settings-title">Backup</h2>
      <div class="settings-actions">
        <button class="btn btn-ghost" type="button" data-action="export-json">Export JSON</button>
        <button class="btn btn-ghost" type="button" data-action="import-json">Import JSON</button>
      </div>
      <p class="settings-note">The export never contains your sync token.</p>
      ${backupError}
      <input class="import-file" type="file" accept="application/json,.json" hidden>
      ${fallbackNote}
    </section>
  </div>`;
}

/* -------------------------------------------------------------------- */
/* History                                                              */
/* -------------------------------------------------------------------- */

/** Non-spend rows get a WORD, not just a colour — colour alone isn't a label. */
function kindTag(kind) {
  if (kind === "withdrawal")
    return `<span class="txn-tag txn-tag--withdrawal">Withdrawal</span>`;
  if (kind === "sweep")
    return `<span class="txn-tag txn-tag--sweep">Swept</span>`;
  if (kind === "income")
    return `<span class="txn-tag txn-tag--income">Refund</span>`;
  return "";
}

function renderTxnRow(t) {
  const note = t.note ? ` &middot; ${esc(t.note)}` : "";
  return `<li class="list-row txn-row txn-row--${esc(t.kind || "expense")}" data-id="${esc(t.id)}">
    <span class="list-row-main">
      <span class="txn-date">${esc(shortDate(t.ts))}</span>
      <span class="txn-cat">${esc(t.categoryName || t.categoryId || "")}</span>
      ${kindTag(t.kind)}
      <span class="txn-note">${note}</span>
    </span>
    <span class="list-row-amt amt">${fmt(t.cent)}</span>
    <button class="btn btn-danger txn-delete" type="button" data-action="delete-txn"
      data-id="${esc(t.id)}" aria-label="Delete transaction">&times;</button>
  </li>`;
}

function renderMonthRow(m, openKey) {
  const open = m.key === openKey;
  const swept =
    m.closed && Number.isFinite(m.sweptCent)
      ? `<span class="month-swept">${fmt(m.sweptCent)} swept</span>`
      : "";
  const state = m.closed
    ? `<span class="month-state month-state--closed">Closed</span>`
    : `<span class="month-state month-state--open">Open</span>`;
  const body = open
    ? (m.txns || []).length
      ? `<ul class="list txn-list">${(m.txns || []).map(renderTxnRow).join("")}</ul>`
      : `<p class="empty-title txn-empty">No transactions in ${esc(m.label)}.</p>`
    : "";
  return `<li class="month-item ${open ? "month-item--open" : ""}" data-id="${esc(m.key)}">
    <button class="month-head list-row" type="button" data-action="toggle-month"
      data-id="${esc(m.key)}" aria-expanded="${open ? "true" : "false"}">
      <span class="list-row-main">
        <span class="month-name">${esc(m.label)}</span>
        ${state}
        ${swept}
      </span>
      <span class="list-row-amt amt">${fmt(m.incomeCent)}</span>
    </button>
    ${body}
  </li>`;
}

/**
 * History screen — months newest-first, one expandable at a time.
 * @param {{months:object[], openKey:string|null}} vm
 * @returns {string}
 */
export function renderHistoryScreen(vm) {
  const months = Array.isArray(vm?.months) ? vm.months : [];
  const head = `<header class="topbar">
      <button class="btn btn-ghost" type="button" data-action="go-home" aria-label="Back">&lsaquo;</button>
      <h1>History</h1>
    </header>`;

  if (!months.length) {
    return `<div class="screen screen-history">
      ${head}
      <div class="empty">
        <p class="empty-title">Nothing here yet. Set an income and log an expense &mdash; months land here as they close.</p>
      </div>
    </div>`;
  }

  const rows = months.map((m) => renderMonthRow(m, vm?.openKey)).join("");
  return `<div class="screen screen-history">
    ${head}
    <ul class="list month-list">${rows}</ul>
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

/**
 * Enable/disable the withdraw submit from the note's current contents.
 *
 * This is the whole friction mechanism, and it runs on every keystroke — so it
 * must never touch anything but the button's `disabled` flag. Re-rendering the
 * sheet here would drop the iOS keyboard on the first character typed
 * (RULE 1), which is exactly the input we're watching.
 *
 * @param {Element} panel  the `.sheet-panel` currently in the DOM
 * @returns {boolean} whether a reason is present
 */
export function syncWithdrawEnabled(panel) {
  const note = panel?.querySelector(".note-input");
  const btn = panel?.querySelector('[data-action="commit-withdraw"]');
  const ok = !!note && note.value.trim().length > 0;
  if (btn) btn.disabled = !ok;
  return ok;
}

/**
 * Show/clear the withdraw sheet's reason message in place.
 * Separate from showAmountError so the message sits under the field it's
 * actually about.
 */
export function showReasonError(panel, message) {
  const el = panel?.querySelector(".withdraw-hint");
  if (!el) return;
  el.textContent =
    message ||
    "A reason is required. It's the only record of why this money left.";
  el.classList.toggle("withdraw-hint--error", !!message);
}

/**
 * Repaint the sync status block from a sync.status() snapshot.
 * Driven by sync.onChange, which can fire while a percentage input is
 * focused — so this replaces ONLY the status region, never the screen.
 */
export function patchSyncStatus(root, status) {
  const host = root?.querySelector(".sync-status");
  if (!host) return;
  host.innerHTML = syncStatusInner(status);
}

/**
 * Recompute the Settings percentage total in place and re-gate Save.
 *
 * Called on `input` for live feedback — but it only writes textContent, a
 * class and a `disabled` flag on nodes that are NOT the focused field, so the
 * caret survives. Nothing here commits: Save reads the rows itself (RULE 2).
 *
 * @param {Element} root  the `.screen-settings` element
 * @returns {number} the current total
 */
export function patchPctTotal(root) {
  const inputs = [...(root?.querySelectorAll(".cat-row-pct") ?? [])];
  let scaled = 0;
  for (const el of inputs) {
    const n = Number(el.value);
    scaled += Math.round((Number.isFinite(n) ? n : 0) * 1e6);
  }
  const total = scaled / 1e6;
  const balanced = scaled === 100 * 1e6;

  const value = root?.querySelector(".cat-total-value");
  if (value) {
    value.textContent = `${Number.isInteger(total) ? total : total.toFixed(2)}%`;
  }
  const box = root?.querySelector(".cat-total");
  if (box) {
    box.classList.toggle("cat-total--ok", balanced);
    box.classList.toggle("cat-total--bad", !balanced);
  }
  const save = root?.querySelector('[data-action="save-categories"]');
  if (save) save.disabled = !balanced;
  return total;
}

/** Replace an inline settings error message without re-rendering the screen. */
export function showSettingsError(section, message) {
  if (!section) return;
  let el = section.querySelector(".settings-error");
  if (!el) {
    el = document.createElement("p");
    el.className = "settings-error";
    section.appendChild(el);
  }
  el.textContent = message || "";
  el.hidden = !message;
}
