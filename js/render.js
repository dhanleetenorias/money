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
  if (kind === "input") {
    // en-CA formats as YYYY-MM-DD, which is exactly what <input type="date">
    // wants — and it is Manila's civil date, not UTC's.
    f = new Intl.DateTimeFormat("en-CA", {
      ...base,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } else {
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
  }
  dtfCache.set(kind, f);
  return f;
}

/**
 * "2026-07-27" in Manila time — the value `<input type="date">` wants.
 * toISOString() would be 8h behind and files an evening txn under yesterday.
 * @param {number} ts
 * @returns {string} "" when the timestamp is unusable
 */
export function dateInputValue(ts) {
  // Number(null) and Number("") are both 0 — a finite number that formats as
  // "1970-01-01" and lands in the input as a value OUTSIDE the min the field
  // declares, which reads as a broken prefill rather than a missing one.
  // Absent is not the epoch: return "" and let the field show empty.
  if (ts == null || ts === "") return "";
  const n = Number(ts);
  if (!Number.isFinite(n)) return "";
  try {
    return dtf("input").format(new Date(n));
  } catch {
    return "";
  }
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
  // A <button>, not a div: the row opens the category screen, so it must be
  // keyboard-reachable and announce what it does. The visible children already
  // read as "Food · 30% · ₱6,500" to a screen reader, so the aria-label only
  // has to add the verb.
  return `<button class="env env--${esc(env.state)}" type="button"
    data-action="open-category" data-cat-id="${esc(env.id)}" data-id="${esc(env.id)}"
    aria-label="${esc(env.name)}, ${fmt(env.leftCent)} left">
    <span class="env-name">${esc(env.name)}</span>
    <div class="env-bar">
      <div class="env-fill" style="transform:scaleX(${fillRatio})"></div>
      <div class="env-tick" style="left:${tickPct}%"></div>
    </div>
    <span class="env-pct">${pctLabel}%</span>
    <span class="env-amt amt">${fmt(env.leftCent)}</span>
    ${overLine}
  </button>`;
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
        <span class="empty-glyph" aria-hidden="true">&#8369;</span>
        <p class="empty-title">Set your income for ${esc(vm.monthLabel)}</p>
        <p class="empty-sub">One number starts the month &mdash; your split, your
          vault and today&#39;s safe-to-spend all come from it.</p>
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
  const cats = vm.categories || [];
  // `presetId` arrives from the category screen's add button: the category is
  // already decided, so the sheet collapses to amount -> one tap. The chips
  // stay (changing your mind must not need a back-out) with the preset marked
  // — but a dedicated primary button means the common case never has to hunt
  // for the right chip among six.
  const preset = vm.presetId
    ? cats.find((c) => String(c.id) === String(vm.presetId))
    : null;

  const chips = cats
    .map(
      (c) => `<button class="chip${
        preset && c.id === preset.id ? " chip--active" : ""
      }" type="button" data-action="add-expense"
        data-cat-id="${esc(c.id)}">${esc(c.name)}</button>`,
    )
    .join("");

  const title = preset ? `Add to ${esc(preset.name)}` : "Add expense";
  const hint = preset
    ? `Type the amount, then tap <b>Add to ${esc(preset.name)}</b> &mdash; or pick another category.`
    : "Type the amount, then tap a category &mdash; that logs it.";
  // DOM order puts the primary commit directly under the amount field, above
  // the chips: with a preset the chips are the escape hatch, not the path.
  const commit = preset
    ? `<button class="btn btn-primary sheet-commit" type="button" data-action="add-expense"
        data-cat-id="${esc(preset.id)}">Add to ${esc(preset.name)}</button>`
    : "";

  return `<div class="sheet screen-add" role="dialog" aria-modal="true" aria-label="Add expense">
    <div class="sheet-backdrop" data-action="close-sheet"></div>
    <div class="sheet-panel">
      <h2 class="sheet-title">${title}</h2>
      <input class="amount-input amt" type="text" inputmode="decimal" placeholder="₱0"
        autocomplete="off" aria-label="Amount">
      <p class="amount-error" hidden></p>
      <p class="sheet-hint">${hint}</p>
      ${commit}
      <div class="chips">${chips}</div>
      <button class="btn btn-ghost" type="button" data-action="toggle-note">Add note</button>
      <div class="note-row" hidden>
        <input class="note-input" type="text" placeholder="Note (optional)" aria-label="Note">
      </div>
    </div>
  </div>`;
}

/**
 * Edit sheet — amount, category, note, date, plus Delete.
 *
 * `kind` is NOT offered: idb.updateTxn refuses a kind change outright (an
 * expense cannot become a withdrawal), so putting it on screen would only
 * teach the user to expect something the data layer will always refuse. The
 * kind is stated as a read-only pill instead, using History's own vocabulary.
 *
 * NOTHING here commits on `input` (RULE 2). The amount and note are read off
 * the DOM when Save is tapped; the category chips only toggle .chip--active
 * through patchEditCategory, which touches two class lists and no more.
 *
 * @param {{id:string, kind:string, cent:number, categoryId:string,
 *          note:string, ts:number, categories:{id:string,name:string}[],
 *          dateMin?:string, dateMax?:string}} vm
 * @returns {string}
 */
export function renderEditSheet(vm) {
  const cats = Array.isArray(vm?.categories) ? vm.categories : [];
  const currentId = String(vm?.categoryId ?? "");
  const chips = cats
    .map(
      (c) => `<button class="chip${
        String(c.id) === currentId ? " chip--active" : ""
      }" type="button" data-action="edit-pick-cat"
        data-cat-id="${esc(c.id)}" aria-pressed="${String(c.id) === currentId ? "true" : "false"}">${esc(c.name)}</button>`,
    )
    .join("");

  // A withdrawal reads "Edit withdrawal", so the sheet never claims to be
  // editing something it isn't. The tag repeats History's worded mark.
  const kind = String(vm?.kind || "expense");
  const kindWord =
    kind === "withdrawal"
      ? "withdrawal"
      : kind === "income"
        ? "refund"
        : "expense";

  return `<div class="sheet screen-edit" role="dialog" aria-modal="true" aria-label="Edit transaction">
    <div class="sheet-backdrop" data-action="close-sheet"></div>
    <div class="sheet-panel" data-id="${esc(vm?.id ?? "")}">
      <h2 class="sheet-title">Edit ${esc(kindWord)} ${kindTag(kind)}</h2>
      <input class="amount-input amt" type="text" inputmode="decimal" placeholder="₱0"
        autocomplete="off" aria-label="Amount" value="${esc(vm?.amountText ?? "")}">
      <p class="amount-error" hidden></p>

      <div class="chips">${chips}</div>

      <div class="note-row">
        <input class="note-input" type="text" placeholder="Note (optional)"
          aria-label="Note" value="${esc(vm?.note ?? "")}">
      </div>

      <label class="field edit-date-field">
        <span class="field-label">Date</span>
        <input class="edit-date" type="date" aria-label="Date"
          min="${esc(vm?.dateMin ?? "")}" max="${esc(vm?.dateMax ?? "")}"
          value="${esc(dateInputValue(vm?.ts))}">
      </label>

      <div class="edit-actions">
        <button class="btn btn-primary" type="button" data-action="save-edit">Save changes</button>
        <button class="btn btn-danger edit-delete" type="button" data-action="delete-txn"
          data-id="${esc(vm?.id ?? "")}">Delete</button>
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
 * Shared arithmetic for the 100% gate — used by the initial render AND by
 * patchPctTotal, so the live-typed state and the fresh render can never
 * disagree. `scaled` is the total in millionths of a percent (the same
 * integer space store.validateCategories compares in).
 *
 * The delta line is what makes the state read instantly: not just "97%" in
 * red, but "3% left to place" / "2.5% over" — the number tells you which way
 * to move, and the words carry the state without colour.
 */
function pctTotalParts(scaled) {
  const total = scaled / 1e6;
  const balanced = scaled === 100 * 1e6;
  const totalText = Number.isInteger(total) ? String(total) : total.toFixed(2);
  let deltaText = "adds up";
  if (!balanced) {
    const diff = Math.abs(100 * 1e6 - scaled) / 1e6;
    const diffText = Number.isInteger(diff) ? String(diff) : diff.toFixed(2);
    deltaText =
      scaled < 100 * 1e6 ? `${diffText}% left to place` : `${diffText}% over`;
  }
  return { total, balanced, totalText, deltaText };
}

/**
 * The sync status block. ONE node, always present (even unconfigured), so
 * patchSyncStatus can swap its innerHTML without ever restructuring the
 * screen around a focused input.
 */
function syncStatusInner(status) {
  const s = status || {};
  const pending = Number(s.pending) || 0;

  // One dot + one word lead the line; the dot never carries meaning alone.
  // Quiet when healthy (dim facts), legible when not (the error breaks onto
  // its own line in over + weight, and the dot goes red beside the words).
  // While a push is in flight the dot pulses — the only live "loading" state
  // this screen needs, driven by sync.onChange via patchSyncStatus.
  let dot = "sync-dot--idle";
  let lead = "";
  if (!s.configured) {
    lead = `<span class="sync-stat sync-stat--off">Not configured</span>`;
  } else if (s.syncing) {
    dot = "sync-dot--busy";
    lead = `<span class="sync-stat">Syncing&hellip;</span>`;
  } else if (s.lastErr) {
    dot = "sync-dot--err";
    lead = `<span class="sync-stat sync-stat--bad">Sync failing</span>`;
  } else {
    dot = "sync-dot--ok";
    lead = `<span class="sync-stat">Connected</span>`;
  }

  const bits = [
    `<span class="sync-dot ${esc(dot)}" aria-hidden="true"></span>`,
    lead,
  ];
  if (s.configured) {
    if (pending > 0)
      bits.push(
        `<span class="sync-stat">${num(pending, 0, 1e9)} pending</span>`,
      );
    bits.push(
      s.lastOkAt
        ? `<span class="sync-stat">Last sync ${esc(shortStamp(s.lastOkAt))}</span>`
        : `<span class="sync-stat">Never synced</span>`,
    );
  }
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
  const parts = pctTotalParts(Math.round(total * 1e6));
  const balanced = parts.balanced;
  const totalText = parts.totalText;

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
        <span class="cat-total-delta">${esc(parts.deltaText)}</span>
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

/**
 * Non-spend rows get a WORD, not just a colour — colour alone isn't a label.
 * "Drawn" rather than "Withdrawal": at 390px the longer word forced the row
 * to overflow, and shrinking the category to fit rendered "Save/Invest" as
 * "S.". The pill has to stay (it's the non-colour signal), so the word gives.
 */
function kindTag(kind) {
  if (kind === "withdrawal")
    return `<span class="txn-tag txn-tag--withdrawal">Drawn</span>`;
  if (kind === "sweep")
    return `<span class="txn-tag txn-tag--sweep">Swept</span>`;
  if (kind === "income")
    return `<span class="txn-tag txn-tag--income">Refund</span>`;
  return "";
}

/**
 * One transaction row — History's vocabulary, reused verbatim by the category
 * screen. ONE builder, so the two lists can never drift into two dialects.
 *
 * `showCat:false` drops `.txn-cat` for the category screen, where every row is
 * the same category and the name would be six identical words down the column.
 * The note takes the space back (it becomes the row's only free text), which
 * is the whole reason to drop it.
 *
 * The row body is a real <button>: the tap opens the edit sheet, so it has to
 * be reachable by keyboard and announce itself. The delete × stays a sibling —
 * `closest("[data-action]")` resolves to whichever is nearer, so a tap on ×
 * never opens the sheet.
 *
 * @param {object} t
 * @param {{showCat?:boolean}} [opts]
 */
function renderTxnRow(t, opts = {}) {
  const showCat = opts.showCat !== false;
  const noteText = t.note ? String(t.note) : "";
  // With the category column gone the note stops being a trailing aside and
  // becomes the row's label, so it drops the " · " lead-in that separated it
  // from the name.
  const note = noteText
    ? showCat
      ? ` &middot; ${esc(noteText)}`
      : esc(noteText)
    : "";
  const cat = showCat
    ? `<span class="txn-cat">${esc(t.categoryName || t.categoryId || "")}</span>`
    : "";
  // Escaped at the interpolation site below, not here: the label is assembled
  // from raw text, so esc() has to be the LAST thing that touches it —
  // escaping the note first would leave a literal "&amp;" in the label.
  const label = `Edit ${fmt(t.cent)}${noteText ? ` — ${noteText}` : ""}`;
  return `<li class="list-row txn-row txn-row--${esc(t.kind || "expense")}" data-id="${esc(t.id)}">
    <button class="txn-open" type="button" data-action="open-edit"
      data-id="${esc(t.id)}" aria-label="${esc(label)}">
      <span class="list-row-main">
        <span class="txn-date">${esc(shortDate(t.ts))}</span>
        ${cat}
        ${kindTag(t.kind)}
        <span class="txn-note">${note}</span>
      </span>
      <span class="list-row-amt amt">${fmt(t.cent)}</span>
    </button>
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
  return `<li class="month-item ${open ? "month-item--open" : ""} ${m.closed ? "month-item--closed" : ""}" data-id="${esc(m.key)}">
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
        <span class="empty-glyph" aria-hidden="true">&#128337;</span>
        <p class="empty-title">No months yet</p>
        <p class="empty-sub">Set an income and log an expense &mdash; every month
          lands here with its full transaction record as it closes.</p>
        <button class="empty-cta btn btn-primary" type="button" data-action="go-home">Back to this month</button>
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
/* Category detail                                                      */
/* -------------------------------------------------------------------- */

/**
 * One category's month: the same envelope reading Home gives, plus the rows
 * behind it.
 *
 * The header deliberately re-uses Home's bar vocabulary — `.env-bar`,
 * `.env-fill`, `.env-tick`, the `env--state` modifier and the "Over by ₱x"
 * pill — rather than inventing a second way to draw the same fact. Tapping an
 * envelope on Home and landing on a chart that reads differently would make
 * you re-learn the instrument on arrival.
 *
 * Allocated / spent / left are stated as three labelled figures because the
 * bar alone answers "how far along", not "how much". This is the screen you
 * open when the glance was not enough.
 *
 * @param {{id:string, name:string, monthLabel:string, pct:number,
 *          allocCent:number, spentCent:number, leftCent:number, ratio:number,
 *          state:string, over:boolean, overCent:number, paceTick:number,
 *          txns:object[], closed?:boolean, canAdd?:boolean}} vm
 * @returns {string}
 */
export function renderCategoryScreen(vm) {
  // Kept RAW and esc()'d at each interpolation site, text and attribute
  // alike — one rule, visible at every use, rather than a pre-escaped local
  // the reader has to trace back to be sure of.
  const name = String(vm?.name ?? "");
  const fillRatio = num(vm?.ratio, 0, 1);
  const tickPct = (num(vm?.paceTick, 0, 1) * 100).toFixed(2);
  const pctLabel = Math.round(Number(vm?.pct) || 0);
  const state = esc(vm?.state || "safe");
  const txns = Array.isArray(vm?.txns) ? vm.txns : [];

  const overLine = vm?.over
    ? `<span class="env-over cat-over">Over by ${fmt(vm.overCent)}</span>`
    : "";

  // A closed month can't take a new row, and the data layer will refuse an
  // edit anyway — so say so once, here, instead of letting every tap fail.
  const closedNote = vm?.closed
    ? `<p class="cat-closed-note">${esc(vm.monthLabel ?? "")} is closed &mdash; these
        rows are the final record and can no longer be edited.</p>`
    : "";

  const addBtn = vm?.closed
    ? ""
    : `<button class="fab" type="button" data-action="open-add-for-cat"
        data-cat-id="${esc(vm?.id ?? "")}" aria-label="Add to ${esc(name)}">+</button>`;

  const body = txns.length
    ? `<ul class="list txn-list cat-txn-list">${txns
        .map((t) => renderTxnRow(t, { showCat: false }))
        .join("")}</ul>`
    : `<div class="empty cat-empty">
        <span class="empty-glyph" aria-hidden="true">&#8369;</span>
        <p class="empty-title">Nothing in ${esc(name)} yet</p>
        <p class="empty-sub">${fmt(vm?.allocCent)} is allocated for
          ${esc(vm?.monthLabel ?? "this month")} and none of it is spent.
          Every ${esc(name)} expense you log lands here.</p>
        ${
          vm?.closed
            ? ""
            : `<button class="empty-cta btn btn-primary" type="button"
                data-action="open-add-for-cat" data-cat-id="${esc(vm?.id ?? "")}">Add to ${esc(name)}</button>`
        }
      </div>`;

  return `<div class="screen screen-category env--${esc(state)}">
    <header class="topbar">
      <button class="btn btn-ghost" type="button" data-action="go-home" aria-label="Back">&lsaquo;</button>
      <h1 class="cat-title">${esc(name)}</h1>
      <span class="cat-pct">${pctLabel}%</span>
    </header>

    <section class="cat-head">
      <span class="cat-head-label">${esc(vm?.monthLabel ?? "")} &middot; left to spend</span>
      <span class="cat-head-amt amt">${fmt(vm?.leftCent)}</span>
      <div class="env-bar cat-bar">
        <div class="env-fill" style="transform:scaleX(${fillRatio})"></div>
        <div class="env-tick" style="left:${tickPct}%"></div>
      </div>
      ${overLine}
      <dl class="cat-figures">
        <div class="cat-figure">
          <dt class="cat-figure-label">Allocated</dt>
          <dd class="cat-figure-amt amt">${fmt(vm?.allocCent)}</dd>
        </div>
        <div class="cat-figure">
          <dt class="cat-figure-label">Spent</dt>
          <dd class="cat-figure-amt amt">${fmt(vm?.spentCent)}</dd>
        </div>
        <div class="cat-figure">
          <dt class="cat-figure-label">Left</dt>
          <dd class="cat-figure-amt amt">${fmt(vm?.leftCent)}</dd>
        </div>
      </dl>
    </section>
    ${closedNote}

    <h2 class="cat-list-title">${esc(vm?.monthLabel ?? "")} transactions</h2>
    ${body}
    ${addBtn}
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
  const parts = pctTotalParts(scaled);

  const value = root?.querySelector(".cat-total-value");
  if (value) value.textContent = `${parts.totalText}%`;
  const delta = root?.querySelector(".cat-total-delta");
  if (delta) delta.textContent = parts.deltaText;
  const box = root?.querySelector(".cat-total");
  if (box) {
    box.classList.toggle("cat-total--ok", parts.balanced);
    box.classList.toggle("cat-total--bad", !parts.balanced);
  }
  const save = root?.querySelector('[data-action="save-categories"]');
  if (save) save.disabled = !parts.balanced;
  return parts.total;
}

/**
 * Move the edit sheet's category selection to `catId`.
 *
 * The chosen category has to be visible before Save is tapped, and the ONLY
 * honest place to keep it is the DOM — re-rendering the sheet to show a tick
 * would blow away the half-typed amount and drop the keyboard (RULE 1). This
 * touches two class lists and two aria-pressed flags, nothing else.
 *
 * @param {Element} panel  the `.sheet-panel` currently in the DOM
 * @param {string} catId
 * @returns {string|null} the id now selected
 */
export function patchEditCategory(panel, catId) {
  const chips = [...(panel?.querySelectorAll(".chip") ?? [])];
  if (!chips.length) return null;
  const want = String(catId ?? "");
  let picked = null;
  for (const chip of chips) {
    const on = chip.getAttribute("data-cat-id") === want;
    chip.classList.toggle("chip--active", on);
    chip.setAttribute("aria-pressed", on ? "true" : "false");
    if (on) picked = want;
  }
  return picked;
}

/**
 * Read the edit sheet's currently selected category off the DOM.
 * Same reason as above: the selection lives in the markup, so this is the one
 * source of truth when Save is tapped (RULE 2 — read on commit, not on input).
 */
export function readEditCategory(panel) {
  return (
    panel?.querySelector(".chip--active")?.getAttribute("data-cat-id") ?? null
  );
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
