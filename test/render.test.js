/**
 * render.js — escaping.
 *
 * render.js builds HTML by string concatenation, so EVERY `${}` that carries
 * data has to be either esc()'d or forced numeric. The one that wasn't
 * (`class="env env--${env.state}"`) was unreachable from today's UI, which is
 * exactly why nothing caught it: `state` is computed internally today, but the
 * next feature that surfaces it — or a restored backup, or a synced row from
 * another device — makes it data. These tests treat every input as hostile
 * rather than asking which ones currently are.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  esc,
  renderHome,
  renderAddSheet,
  renderIncomeSheet,
  renderWithdrawSheet,
  renderSettingsScreen,
  renderHistoryScreen,
  renderCategoryScreen,
  renderEditSheet,
} from "../js/render.js";

/** The payloads. Each one breaks out of a different context. */
const HOSTILE = [
  `"><img src=x onerror=alert(1)>`,
  `'><img src=x onerror=alert(1)>`,
  `<script>alert(1)</script>`,
  `" onmouseover="alert(1)`,
  `' onfocus='alert(1)`,
  `</div><img src=x onerror=alert(1)><div>`,
  `javascript:alert(1)`,
  `\\"><svg onload=alert(1)>`,
  `&lt;img src=x onerror=alert(1)&gt;`,
  `--></style><img src=x onerror=alert(1)>`,
];

/**
 * Assert no executable markup survived into `html`.
 *
 * STRUCTURAL, not substring. A correctly escaped payload still CONTAINS the
 * text "onerror=alert(1)" — as inert text, because its `<` became `&lt;`. So
 * a plain substring search reports false alarms and teaches nothing. Instead
 * this pulls out everything the browser would parse as a TAG (`<...>`) and
 * asserts that set contains no injected element and no event handler. Escaped
 * text can never produce a tag, because esc() removes every `<`.
 */
function assertInert(html, label) {
  assert.equal(typeof html, "string", `${label}: not a string`);

  const tags = html.match(/<[^>]*>?/g) || [];
  for (const tag of tags) {
    const name = /^<\/?\s*([a-zA-Z][\w-]*)/.exec(tag)?.[1]?.toLowerCase() ?? "";
    assert.ok(
      !["img", "script", "svg", "iframe", "object", "embed"].includes(name),
      `${label}: an injected <${name}> survived → ${tag}`,
    );
    // Strip QUOTED attribute values before looking for handlers. esc() turns
    // every quote in the data into an entity, so anything still sitting inside
    // a pair of real quotes is inert by construction — `onerror=` in there is
    // a literal string the browser shows, not an attribute it binds. A payload
    // that actually broke OUT would terminate its value early and land in this
    // skeleton, which is precisely what we're looking for.
    const skeleton = tag.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
    assert.ok(
      !/\son[a-z]+\s*=/i.test(skeleton),
      `${label}: a live event handler survived → ${tag}`,
    );
    assert.ok(
      !/javascript:/i.test(skeleton),
      `${label}: a javascript: URL survived → ${tag}`,
    );
  }

  // Belt and braces: an unterminated tag would escape the loop above.
  const opens = (html.match(/</g) || []).length;
  const closes = (html.match(/>/g) || []).length;
  assert.equal(opens, closes, `${label}: unbalanced angle brackets`);
}

test("esc neutralises every hostile payload", () => {
  for (const p of HOSTILE) {
    const out = esc(p);
    assertInert(out, `esc(${p})`);
    assert.ok(!out.includes("<"), "a raw < survived esc()");
    assert.ok(!out.includes(">"), "a raw > survived esc()");
    assert.ok(!out.includes('"'), "a raw double quote survived esc()");
    assert.ok(!out.includes("'"), "a raw single quote survived esc()");
  }
  // Ampersand goes first or the other replacements get double-escaped.
  assert.equal(esc("&lt;"), "&amp;lt;");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(0), "0");
});

test("renderHome: hostile envelope state cannot break out of the class attribute", () => {
  // The exact reported payload, in the exact field that was unescaped.
  for (const p of HOSTILE) {
    const html = renderHome({
      hasIncome: true,
      monthLabel: p,
      incomeCent: 2500000,
      vaultLabel: p,
      vault: { totalCent: 1125000, pct: 45 },
      hero: { cent: 12000, daysLeft: 5, basis: "even" },
      poolLeftCent: 375000,
      pace: { state: "over", deltaCent: 5000, actualCent: 100000 },
      paceTick: 0.5,
      envelopes: [
        {
          id: p,
          name: p,
          pct: 30,
          allocCent: 750000,
          spentCent: 0,
          leftCent: 750000,
          over: false,
          overCent: 0,
          ratio: 0.4,
          state: p, // <- the bug
        },
      ],
    });
    assertInert(html, `renderHome state=${p}`);
  }
});

test("renderHome: hostile pace class cannot break out either", () => {
  for (const p of HOSTILE) {
    for (const state of ["ahead", "over", "on"]) {
      const html = renderHome({
        hasIncome: true,
        monthLabel: p,
        incomeCent: 100,
        vaultLabel: p,
        vault: { totalCent: 1, pct: 45 },
        hero: { cent: 1, daysLeft: 1, basis: "even" },
        poolLeftCent: 1,
        // paceLine() derives cls from state, so drive it through every branch.
        pace: { state, deltaCent: 5000, actualCent: 100000 },
        paceTick: 0.5,
        envelopes: [],
      });
      assertInert(html, `renderHome pace=${state}/${p}`);
    }
  }
});

test("renderHome: non-numeric ratio/paceTick cannot reach the style attribute", () => {
  // These land in `transform:scaleX(...)` and `left:...%` — attribute
  // contexts that esc() does not cover, so they must be forced numeric.
  const junk = [
    `1);"><img src=x onerror=alert(1)>`,
    NaN,
    Infinity,
    -Infinity,
    null,
    undefined,
    "abc",
    {},
    [],
  ];
  for (const j of junk) {
    const html = renderHome({
      hasIncome: true,
      monthLabel: "July",
      incomeCent: 100,
      vaultLabel: "Vault",
      vault: { totalCent: 1, pct: j },
      hero: { cent: 1, daysLeft: j, basis: "even" },
      poolLeftCent: 1,
      pace: { state: "on", deltaCent: 0, actualCent: 1 },
      paceTick: j,
      envelopes: [
        {
          id: "food",
          name: "Food",
          pct: j,
          allocCent: 1,
          spentCent: 0,
          leftCent: 1,
          over: false,
          overCent: 0,
          ratio: j,
          state: "safe",
        },
      ],
    });
    assertInert(html, `renderHome numeric=${String(j)}`);
    assert.ok(
      !/scaleX\([^)]*[<>"']/.test(html),
      `scaleX carried markup for ${String(j)}`,
    );
    assert.ok(
      !/left:[^%;"]*[<>"']/.test(html),
      `left carried markup for ${String(j)}`,
    );
  }
});

test("renderHome: the no-income empty state escapes its label", () => {
  for (const p of HOSTILE) {
    assertInert(
      renderHome({ hasIncome: false, monthLabel: p }),
      `renderHome empty ${p}`,
    );
  }
});

test("renderAddSheet: hostile category ids and names stay inert", () => {
  for (const p of HOSTILE) {
    assertInert(
      renderAddSheet({ categories: [{ id: p, name: p }] }),
      `renderAddSheet ${p}`,
    );
  }
  assertInert(renderAddSheet({}), "renderAddSheet empty");
  assertInert(renderAddSheet({ categories: null }), "renderAddSheet null");
});

test("renderIncomeSheet: hostile label and prefill stay inert", () => {
  for (const p of HOSTILE) {
    for (const hasExisting of [true, false]) {
      assertInert(
        renderIncomeSheet({ monthLabel: p, hasExisting, prefill: p }),
        `renderIncomeSheet ${p}`,
      );
    }
  }
});

test("renderWithdrawSheet: a non-numeric available amount stays inert", () => {
  for (const p of [...HOSTILE, NaN, null, undefined, Infinity]) {
    assertInert(
      renderWithdrawSheet({ availableCent: p }),
      `renderWithdrawSheet ${String(p)}`,
    );
  }
  assertInert(renderWithdrawSheet(), "renderWithdrawSheet undefined vm");
});

test("renderSettingsScreen: hostile categories, urls and errors stay inert", () => {
  for (const p of HOSTILE) {
    const html = renderSettingsScreen({
      categories: [
        { id: p, name: p, pct: p, vault: true },
        { id: p + "2", name: p, pct: 55, vault: false },
      ],
      totalPct: 100,
      syncUrl: p,
      token: p,
      status: {
        configured: true,
        pending: p,
        lastOkAt: Date.now(),
        syncing: true,
        lastErr: p,
      },
      fallback: true,
      catError: p,
      syncError: p,
      syncNotice: p,
      backupError: p,
    });
    assertInert(html, `renderSettingsScreen ${p}`);
  }
  assertInert(renderSettingsScreen({}), "renderSettingsScreen empty");
  assertInert(renderSettingsScreen(), "renderSettingsScreen undefined");
});

test("renderSettingsScreen: the token is not echoed anywhere but its own input", () => {
  const token = "s3cr3t-token-value";
  const html = renderSettingsScreen({
    categories: [],
    totalPct: 0,
    syncUrl: "https://example.com/exec",
    token,
    status: {},
  });
  const hits = html.split(token).length - 1;
  assert.equal(hits, 1, "the token appears more than once in the markup");
  assert.ok(
    html.includes(`class="sync-token-input" type="password"`),
    "the token input is not a password field",
  );
});

test("renderHistoryScreen: hostile months, notes and kinds stay inert", () => {
  for (const p of HOSTILE) {
    const html = renderHistoryScreen({
      openKey: p,
      months: [
        {
          key: p,
          label: p,
          incomeCent: 2500000,
          closed: true,
          sweptCent: 100,
          txns: [
            {
              id: p,
              ts: Date.now(),
              cent: 5000,
              categoryId: p,
              categoryName: p,
              note: p,
              kind: p,
            },
            {
              id: p,
              ts: Date.now(),
              cent: 5000,
              categoryId: p,
              categoryName: p,
              note: p,
              kind: "withdrawal",
            },
          ],
        },
        // A closed month with no txns exercises the empty-body branch.
        {
          key: p + "b",
          label: p,
          incomeCent: 0,
          closed: false,
          sweptCent: 0,
          txns: [],
        },
      ],
    });
    assertInert(html, `renderHistoryScreen ${p}`);
  }
  assertInert(renderHistoryScreen({ months: [] }), "renderHistoryScreen empty");
  assertInert(renderHistoryScreen(), "renderHistoryScreen undefined");
});

test("renderCategoryScreen: hostile names, ids, notes and states stay inert", () => {
  for (const p of HOSTILE) {
    const html = renderCategoryScreen({
      id: p,
      name: p,
      monthLabel: p,
      pct: p,
      allocCent: 200000,
      spentCent: 50000,
      leftCent: 150000,
      ratio: p, // straight into transform:scaleX()
      state: p, // straight into a class attribute
      over: true,
      overCent: 1000,
      paceTick: p, // straight into left:%
      closed: false,
      txns: [
        { id: p, ts: Date.now(), cent: 5000, categoryId: p, note: p, kind: p },
      ],
    });
    assertInert(html, `renderCategoryScreen ${p}`);
    assert.ok(
      !/scaleX\([^)]*[<>"']/.test(html),
      `scaleX carried markup for ${p}`,
    );
    assert.ok(!/left:[^%;"]*[<>"']/.test(html), `left carried markup for ${p}`);
  }
  // The empty branch renders different nodes — cover it with the same payloads.
  for (const p of HOSTILE) {
    assertInert(
      renderCategoryScreen({ id: p, name: p, monthLabel: p, txns: [] }),
      `renderCategoryScreen empty ${p}`,
    );
    assertInert(
      renderCategoryScreen({ id: p, name: p, monthLabel: p, closed: true }),
      `renderCategoryScreen closed ${p}`,
    );
  }
  assertInert(renderCategoryScreen(), "renderCategoryScreen undefined");
  assertInert(renderCategoryScreen({}), "renderCategoryScreen empty vm");
});

test("renderEditSheet: hostile values, notes and category ids stay inert", () => {
  for (const p of HOSTILE) {
    for (const kind of ["expense", "withdrawal", "income", p]) {
      const html = renderEditSheet({
        id: p,
        kind,
        cent: 5000,
        amountText: p,
        categoryId: p,
        note: p,
        ts: Date.now(),
        categories: [
          { id: p, name: p },
          { id: p + "2", name: p },
        ],
        dateMin: p,
        dateMax: p,
      });
      assertInert(html, `renderEditSheet ${kind}/${p}`);
    }
  }
  assertInert(renderEditSheet(), "renderEditSheet undefined");
  assertInert(renderEditSheet({}), "renderEditSheet empty vm");
});

test("renderAddSheet: a hostile preset id cannot break the prefilled branch", () => {
  // presetId is matched against the category list, so a payload that matches
  // reaches BOTH the title and a second data-cat-id attribute.
  for (const p of HOSTILE) {
    assertInert(
      renderAddSheet({ categories: [{ id: p, name: p }], presetId: p }),
      `renderAddSheet preset ${p}`,
    );
  }
  // A preset naming a category that isn't there must degrade to the plain
  // sheet, not render a commit button for a category the user can't see.
  const html = renderAddSheet({
    categories: [{ id: "food", name: "Food" }],
    presetId: "gone",
  });
  assert.ok(!html.includes("sheet-commit"), "a stale preset must not commit");
  assert.ok(!html.includes("chip--active"), "nothing should look selected");
});

test("every attribute interpolation in render.js is escaped or forced numeric", () => {
  // Source-level backstop for the class of bug this file exists for: an
  // attribute value with a bare `${...}` that is neither esc(...) nor num(...)
  // nor a literal ternary. The behavioural tests above cannot see a field that
  // no VM currently populates — this can.
  const src = readFileSync(new URL("../js/render.js", import.meta.url), "utf8");
  const offenders = [];
  // Match `attr="....${expr}...."` inside a template literal.
  const attrRe = /\s([a-zA-Z-]+)="([^"\n]*\$\{[^"\n]*)"/g;
  for (const m of src.matchAll(attrRe)) {
    const [, attr, value] = m;
    for (const expr of value.matchAll(/\$\{([^}]*)\}/g)) {
      const e = expr[1].trim();
      const safe =
        e.startsWith("esc(") ||
        e.startsWith("num(") ||
        e.startsWith("fmt(") ||
        // A literal ternary between two string constants carries no data.
        /^[\w.?]+\s*\?\s*"[^"]*"\s*:\s*"[^"]*"$/.test(e) ||
        // Numerics that are already coerced at their definition site.
        /^(fillRatio|tickPct|pctLabel|title|total|balanced)$/.test(e) ||
        /^Math\.(round|max|min|abs)\(/.test(e);
      if (!safe) offenders.push(`${attr}="…\${${e}}…"`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `unescaped attribute interpolation(s):\n  ${offenders.join("\n  ")}`,
  );
});
