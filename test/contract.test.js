/**
 * The DOM contract between render.js, main.js, and app.css.
 *
 * render.js builds HTML as strings, then a set of PATCHER functions reach back
 * into that HTML with querySelector and mutate one node — that is what keeps
 * the iOS keyboard alive instead of re-rendering a focused input away.
 *
 * Nothing links those two halves. Rename a class in the markup and the
 * selector simply stops matching: no throw, no console error, the UI just
 * quietly stops updating. The behavioural suites can't see it either, because
 * they assert on returned HTML, never on whether a patcher can still find its
 * target.
 *
 * So this file DERIVES the contract instead of restating it: it reads the two
 * source files, extracts every selector and class they actually use, and
 * asserts the rendered markup still provides each one. Add a patcher tomorrow
 * and it is covered without touching this file.
 *
 * It also enforces the rails that are cheap to state and expensive to notice
 * you've broken — the perf ones (a transition on `width` costs frames on a
 * phone in a way desktop never shows you) and the iOS ones (an input under
 * 16px makes Safari zoom on focus).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  renderHome,
  renderAddSheet,
  renderIncomeSheet,
  renderWithdrawSheet,
  renderSettingsScreen,
  renderHistoryScreen,
} from "../js/render.js";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const RENDER_SRC = read("../js/render.js");
const MAIN_SRC = read("../js/main.js");
const TOAST_SRC = read("../js/toast.js");
const CSS_SRC = read("../app.css");

/* ---- the markup every screen can produce ------------------------------- */

const CATS = [
  { id: "save", name: "Save/Invest", pct: 45, vault: true },
  { id: "food", name: "Food", pct: 30 },
  { id: "gas", name: "Gas", pct: 9 },
  { id: "coffee", name: "Coffee", pct: 8 },
  { id: "buffer", name: "Buffer", pct: 5 },
  { id: "misc", name: "Misc", pct: 3 },
];

const env = (id, name, pct, allocCent, spentCent, state) => ({
  id,
  name,
  pct,
  allocCent,
  spentCent,
  leftCent: allocCent - spentCent,
  ratio: spentCent / allocCent,
  over: spentCent > allocCent,
  overCent: Math.max(0, spentCent - allocCent),
  state,
});

/**
 * Every branch of every screen, concatenated. Coverage matters more than
 * realism here: a class that only appears in the over-budget or error branch
 * still has to be found by its patcher.
 */
function allMarkup() {
  const spendable = [
    env("food", "Food", 30, 750000, 100000, "safe"),
    env("gas", "Gas", 9, 225000, 200000, "caution"),
    env("coffee", "Coffee", 8, 200000, 320000, "over"),
  ];

  return [
    renderHome({ hasIncome: false, monthLabel: "August" }),
    renderHome({
      hasIncome: true,
      monthLabel: "August",
      incomeCent: 2500000,
      vault: { totalCent: 1125000, pct: 45 },
      vaultLabel: "Vault",
      hero: { cent: 85937, daysLeft: 16, basis: "even" },
      poolLeftCent: 1375000,
      pace: { state: "ahead", deltaCent: -42000, actualCent: 18000 },
      paceTick: 0.5,
      envelopes: spendable,
    }),
    renderAddSheet({ categories: CATS.filter((c) => !c.vault) }),
    renderIncomeSheet({
      monthLabel: "August",
      hasExisting: false,
      prefill: "",
    }),
    renderIncomeSheet({
      monthLabel: "August",
      hasExisting: true,
      prefill: "25000",
    }),
    renderWithdrawSheet({ availableCent: 1125000, monthLabel: "August" }),
    renderSettingsScreen({
      categories: CATS,
      totalPct: 100,
      syncUrl: "",
      token: "",
      status: {
        configured: false,
        pending: 0,
        lastOkAt: null,
        lastErr: null,
        online: true,
        syncing: false,
      },
    }),
    renderSettingsScreen({
      categories: CATS,
      totalPct: 97,
      syncUrl: "https://example.com/exec",
      token: "x",
      // All three error slots at once — each renders `.settings-error`, and
      // the patcher that reuses that node has to find it in any of them.
      catError: "must total 100%",
      backupError: "could not read that file",
      syncError: "auth",
      status: {
        configured: true,
        pending: 3,
        lastOkAt: Date.now(),
        lastErr: "auth",
        online: false,
        syncing: true,
      },
    }),
    renderHistoryScreen({ months: [] }),
    renderHistoryScreen({
      // `openKey` expands a month — the transaction rows, and the delete
      // button on each, only exist in that branch.
      openKey: "2026-08",
      months: [
        {
          key: "2026-08",
          label: "August",
          incomeCent: 2500000,
          closed: false,
          sweptCent: 0,
          txns: [
            {
              id: "a",
              ts: Date.now(),
              cent: 18000,
              categoryId: "coffee",
              categoryName: "Coffee",
              note: "n",
              kind: "expense",
            },
            {
              id: "b",
              ts: Date.now(),
              cent: 200000,
              categoryId: "save",
              categoryName: "Save",
              note: "gift",
              kind: "withdrawal",
            },
            {
              id: "c",
              ts: Date.now(),
              cent: 5000,
              categoryId: "food",
              categoryName: "Food",
              note: "",
              kind: "sweep",
            },
            {
              id: "d",
              ts: Date.now(),
              cent: 5000,
              categoryId: "food",
              categoryName: "Food",
              note: "",
              kind: "income",
            },
          ],
        },
        {
          key: "2026-07",
          label: "July",
          incomeCent: 2500000,
          closed: true,
          sweptCent: 120000,
          txns: [],
        },
      ],
    }),
  ].join("\n");
}

/* ---- extract the contract from source ---------------------------------- */

/** Class names the JS looks up. These MUST exist in rendered markup. */
function selectorClasses(src) {
  const out = new Set();
  // querySelector(".foo") / closest(".foo") / matches(".foo")
  for (const m of src.matchAll(
    /(?:querySelector(?:All)?|closest|matches)\(\s*["'`]([^"'`]+)["'`]/g,
  )) {
    for (const cls of m[1].matchAll(/\.([a-zA-Z][\w-]*)/g)) out.add(cls[1]);
  }
  return out;
}

/** Classes the JS toggles. These are STATES — CSS must style them. */
function toggledClasses(src) {
  const out = new Set();
  for (const m of src.matchAll(
    /classList\.(?:add|remove|toggle)\(\s*["'`]([^"'`]+)["'`]/g,
  )) {
    out.add(m[1]);
  }
  return out;
}

/* ---- the tests ---------------------------------------------------------- */

test("every class the JS looks up still exists in rendered markup", () => {
  const html = allMarkup();
  const wanted = new Set([
    ...selectorClasses(RENDER_SRC),
    ...selectorClasses(MAIN_SRC),
  ]);

  // toast.js builds its own DOM with innerHTML rather than via render.js.
  const toastMarkup = TOAST_SRC;

  // Collect the class TOKENS that actually appear, rather than substring-
  // matching. `\b` treats a hyphen as a word boundary, so a naive
  // /\bsync-status\b/ happily matches `class="sync-status-panel"` — which is
  // precisely the rename this test exists to catch. Verified: with the naive
  // regex, renaming .sync-status → .sync-status-panel passed.
  const present = new Set();
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    for (const token of m[1].split(/\s+/)) if (token) present.add(token);
  }
  for (const m of toastMarkup.matchAll(/class="([^"]*)"/g)) {
    for (const token of m[1].split(/\s+/)) if (token) present.add(token);
  }

  const missing = [...wanted].filter((cls) => !present.has(cls));

  assert.deepEqual(
    missing,
    [],
    `these classes are queried by JS but no longer rendered — the patcher ` +
      `that targets them will silently stop working: ${missing.join(", ")}`,
  );
});

test("classes the JS toggles are styled in app.css", () => {
  // A state the JS sets but CSS never styles is a feature that looks broken:
  // the flag flips and nothing on screen changes.
  const toggled = new Set([
    ...toggledClasses(RENDER_SRC),
    ...toggledClasses(MAIN_SRC),
    ...toggledClasses(TOAST_SRC),
  ]);

  const unstyled = [...toggled].filter(
    (cls) => !new RegExp(`\\.${cls}\\b`).test(CSS_SRC),
  );

  assert.deepEqual(
    unstyled,
    [],
    `toggled by JS but unstyled in app.css: ${unstyled.join(", ")}`,
  );
});

test("the two JS-driven style hooks survive", () => {
  // main.js/render.js drive these inline. If markup drops the inline style, or
  // CSS starts fighting it, the bars stop moving — and nothing errors.
  const html = allMarkup();
  assert.match(
    html,
    /class="env-fill"[^>]*style="transform:\s*scaleX\(/,
    "`.env-fill` must carry an inline transform:scaleX() — the bar fill",
  );
  assert.match(
    html,
    /class="env-tick"[^>]*style="left:/,
    "`.env-tick` must carry an inline left:% — the pace marker",
  );
});

test("every data-action rendered has a handler, and vice versa", () => {
  const rendered = new Set(
    [...allMarkup().matchAll(/data-action="([a-z-]+)"/g)].map((m) => m[1]),
  );
  // toast.js owns its own action and routes it internally.
  rendered.delete("toast-action");

  const handled = new Set(
    [...MAIN_SRC.matchAll(/case\s+"([a-z-]+)":/g)].map((m) => m[1]),
  );

  const orphanButtons = [...rendered].filter((a) => !handled.has(a));
  assert.deepEqual(
    orphanButtons,
    [],
    `rendered but no handler — tapping these does nothing: ${orphanButtons.join(", ")}`,
  );

  const deadHandlers = [...handled].filter((a) => !rendered.has(a));
  assert.deepEqual(
    deadHandlers,
    [],
    `handled but never rendered — dead code or a renamed button: ${deadHandlers.join(", ")}`,
  );
});

test("app.css animates only compositor-friendly properties", () => {
  // Animating width/height/top/left forces layout every frame; filter and
  // box-shadow force paint. Both are survivable on a desktop and visibly
  // janky on a phone, which is the machine that matters here.
  const banned =
    /\b(width|height|top|left|right|bottom|margin|padding|filter|box-shadow|background-position)\b/;
  const offenders = [];

  for (const [i, line] of CSS_SRC.split("\n").entries()) {
    const decl = /^\s*(transition|animation)(-property)?\s*:\s*([^;]+);/.exec(
      line,
    );
    if (decl && banned.test(decl[3])) {
      offenders.push(`app.css:${i + 1} → ${line.trim()}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `animate transform/opacity instead:\n${offenders.join("\n")}`,
  );
});

test("app.css uses dvh, never vh", () => {
  // 100vh is wrong on iOS: it counts the area behind the browser chrome, so
  // the bottom of the app sits under the home indicator.
  const offenders = CSS_SRC.split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /\b\d+vh\b/.test(line))
    .map(([n, line]) => `app.css:${n} → ${line.trim()}`);

  assert.deepEqual(offenders, [], `use dvh:\n${offenders.join("\n")}`);
});

test("no input is styled below 16px", () => {
  // Safari zooms the whole page when you focus an input smaller than 16px,
  // and never zooms back out. It reads as the app breaking.
  // Strip comments first: several rules are DOCUMENTED as sitting under an
  // input ("inline validation message under the amount input"), and matching
  // the prose instead of the selector reports rules that style a <p>.
  const css = CSS_SRC.replace(/\/\*[\s\S]*?\*\//g, "");

  const offenders = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, selector, body] = m;
    // A real input rule names the element, or a class that IS the input.
    const targetsInput = selector
      .split(",")
      .some((s) => /(^|[\s>+~.])(input|textarea|select)\b|-input\b/.test(s));
    if (!targetsInput) continue;
    const size = /font-size\s*:\s*([\d.]+)px/.exec(body);
    if (size && parseFloat(size[1]) < 16) {
      offenders.push(`${selector.trim()} → font-size:${size[1]}px`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `iOS zooms on focus below 16px:\n${offenders.join("\n")}`,
  );
});

test("index.html ships one palette too", () => {
  // The boot-splash <style> in index.html is UNLAYERED, so it beats every
  // @layer rule in app.css regardless of specificity. A light override
  // survived there after the light palette was deleted from app.css and
  // repainted the whole page white under text still tuned for dark — the app
  // looked broken while every CSS token was correct.
  // Only the <style> block matters. The `theme-color` <meta> tags legitimately
  // branch on colour scheme — they tint the iOS status bar, they don't paint
  // the page.
  const style = /<style>([\s\S]*?)<\/style>/.exec(read("../index.html"))?.[1];
  assert.ok(style, "index.html should still carry its boot-splash <style>");
  assert.doesNotMatch(
    style,
    /prefers-color-scheme:\s*light/,
    "the boot <style> carries a light override — it outranks app.css's layers",
  );
});

test("app.css ships one palette", () => {
  // Dark-only was a deliberate call: one palette tuned hard beats two tuned
  // adequately. A stray light block would go unverified and drift.
  assert.doesNotMatch(
    CSS_SRC,
    /prefers-color-scheme:\s*light/,
    "light palette found — this app is dark-only by decision",
  );
});
