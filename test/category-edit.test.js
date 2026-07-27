/**
 * Category detail + edit sheet — the two screens that WRITE from a list.
 *
 * The escaping backstops live in render.test.js and the DOM contract in
 * contract.test.js; this file covers what neither can see:
 *
 *   - the category screen's own rules (rows newest-first, sweeps excluded,
 *     a closed month dropping its add affordances, a real empty state)
 *   - the edit sheet only ever offering categories the data layer will
 *     ACCEPT — idb.planUpdate refuses any move across the vault boundary,
 *     so a chip that would always be refused must not be on screen
 *   - the two patchers, against a DOM small enough to state exactly. They
 *     are the reason the edit sheet doesn't re-render on every chip tap, and
 *     a silent failure in one looks like "the app forgot which category I
 *     picked" — no throw, no error.
 *   - dateInputValue in Manila, where toISOString() is 8h wrong
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  renderCategoryScreen,
  renderEditSheet,
  patchEditCategory,
  readEditCategory,
  dateInputValue,
} from "../js/render.js";

const CATS = [
  { id: "food", name: "Food" },
  { id: "gas", name: "Gas" },
  { id: "coffee", name: "Coffee" },
];

const baseCat = (over = {}) => ({
  id: "coffee",
  name: "Coffee",
  monthLabel: "July",
  pct: 8,
  allocCent: 200000,
  spentCent: 50000,
  leftCent: 150000,
  ratio: 0.25,
  state: "safe",
  over: false,
  overCent: 0,
  paceTick: 0.5,
  closed: false,
  txns: [],
  ...over,
});

const txn = (
  id,
  cent,
  note,
  kind = "expense",
  ts = Date.UTC(2026, 6, 20, 4),
) => ({
  id,
  ts,
  cent,
  categoryId: "coffee",
  note,
  kind,
});

/* ---- category detail --------------------------------------------------- */

test("category screen states allocated, spent and left as separate figures", () => {
  const html = renderCategoryScreen(baseCat());
  // The bar answers "how far along"; these answer "how much" — the question
  // that made you open the screen.
  for (const label of ["Allocated", "Spent", "Left"]) {
    assert.ok(html.includes(label), `missing the ${label} figure`);
  }
  assert.ok(html.includes("₱2,000.00"), "allocated figure missing");
  assert.ok(html.includes("₱500.00"), "spent figure missing");
  assert.ok(html.includes("₱1,500.00"), "left figure missing");
});

test("category screen reuses Home's bar vocabulary, not a second chart", () => {
  const html = renderCategoryScreen(baseCat({ ratio: 0.25, paceTick: 0.4 }));
  assert.match(
    html,
    /class="env-fill" style="transform:scaleX\(0\.25\)"/,
    "the fill must be the same inline-scaleX bar Home draws",
  );
  assert.match(html, /class="env-tick" style="left:40\.00%"/);
  assert.ok(
    html.includes("env--safe"),
    "the screen must carry the env--state modifier so the hue rules apply",
  );
});

test("an overspent category says so in words, not only in colour", () => {
  const html = renderCategoryScreen(
    baseCat({
      state: "over",
      over: true,
      overCent: 120000,
      leftCent: -120000,
      ratio: 1,
    }),
  );
  assert.ok(html.includes("Over by ₱1,200.00"), "the over pill must be worded");
  assert.ok(html.includes("env--over"));
});

test("a non-numeric ratio or paceTick cannot reach the style attribute", () => {
  for (const j of [NaN, Infinity, null, undefined, "abc", {}, []]) {
    const html = renderCategoryScreen(baseCat({ ratio: j, paceTick: j }));
    assert.ok(
      !/scaleX\([^)]*[<>"'a-z]/.test(html),
      `scaleX carried non-numeric ${String(j)}`,
    );
    assert.ok(!/left:[^%;"]*[<>"'a-z]/.test(html), `left carried ${String(j)}`);
  }
});

test("transactions are newest first", () => {
  const html = renderCategoryScreen(
    baseCat({
      txns: [
        txn("new", 300, "newest", "expense", Date.UTC(2026, 6, 25)),
        txn("mid", 200, "middle", "expense", Date.UTC(2026, 6, 20)),
        txn("old", 100, "oldest", "expense", Date.UTC(2026, 6, 2)),
      ],
    }),
  );
  // The VM sorts; the renderer must preserve that order rather than regroup.
  const order = ["newest", "middle", "oldest"].map((n) => html.indexOf(n));
  assert.ok(order[0] < order[1] && order[1] < order[2], "rows were reordered");
});

test("rows drop the redundant category column but keep the rest of History's vocabulary", () => {
  const html = renderCategoryScreen(
    baseCat({ txns: [txn("a", 18000, "beans")] }),
  );
  // Every row on this screen IS this category — six identical words down a
  // column is noise, and the note takes the space back.
  assert.ok(
    !html.includes('class="txn-cat"'),
    "the category column is redundant here and must be dropped",
  );
  for (const cls of ["txn-row", "txn-date", "txn-note", "list-row-amt"]) {
    assert.ok(html.includes(cls), `${cls} must be reused, not reinvented`);
  }
  // With no category beside it the note is the row's label, so it loses the
  // " · " that separated it from the name in History.
  assert.ok(
    !/txn-note">\s*&middot;/.test(html),
    "the note should not keep History's separator once the name is gone",
  );
});

test("a withdrawal row still carries its worded tag on this screen", () => {
  const html = renderCategoryScreen(
    baseCat({ txns: [txn("w", 5000, "gift", "withdrawal")] }),
  );
  assert.ok(html.includes("txn-tag--withdrawal"), "kind pill lost");
  assert.ok(html.includes("Drawn"), "state must never be colour alone");
});

test("every row opens the edit sheet and carries its own delete", () => {
  const html = renderCategoryScreen(
    baseCat({ txns: [txn("a", 100, "x"), txn("b", 200, "y")] }),
  );
  const opens = [
    ...html.matchAll(/data-action="open-edit" *\n? *data-id="(\w+)"/g),
  ];
  assert.equal(opens.length, 2, "each row must open the edit sheet");
  assert.equal(
    [...html.matchAll(/data-action="delete-txn"/g)].length,
    2,
    "each row keeps its own delete",
  );
});

test("an empty category gets a real empty state, not a bare line", () => {
  const html = renderCategoryScreen(baseCat({ txns: [], allocCent: 200000 }));
  assert.ok(html.includes("empty-glyph"), "missing the glyph register");
  assert.ok(html.includes("Nothing in Coffee yet"), "missing the title");
  assert.ok(
    html.includes("₱2,000.00"),
    "the empty state should state the budget",
  );
  assert.ok(
    html.includes('data-action="open-add-for-cat"'),
    "the empty state must offer the next step",
  );
  assert.ok(
    !html.includes("txn-list"),
    "no list should be rendered when empty",
  );
});

test("a closed month drops every add affordance and explains why", () => {
  const open = renderCategoryScreen(baseCat({ closed: false }));
  const closed = renderCategoryScreen(baseCat({ closed: true }));

  assert.ok(
    open.includes('data-action="open-add-for-cat"'),
    "open month lost its +",
  );
  assert.ok(
    !closed.includes('data-action="open-add-for-cat"'),
    "a closed month cannot take a new row — the button must not be there",
  );
  assert.ok(!closed.includes('class="fab"'), "the FAB must go too");
  assert.ok(
    closed.includes("closed"),
    "say it once here rather than letting every tap fail",
  );
});

test("the screen always offers a way back", () => {
  for (const vm of [baseCat(), baseCat({ txns: [txn("a", 1, "")] })]) {
    assert.ok(
      renderCategoryScreen(vm).includes('data-action="go-home"'),
      "no way back to Home",
    );
  }
});

test("category screen survives a junk VM rather than throwing", () => {
  for (const vm of [undefined, {}, { txns: null }, { name: null, txns: "x" }]) {
    const html = renderCategoryScreen(vm);
    assert.equal(typeof html, "string");
    assert.ok(html.includes("screen-category"));
  }
});

/* ---- edit sheet -------------------------------------------------------- */

const baseEdit = (over = {}) => ({
  id: "a",
  kind: "expense",
  cent: 18000,
  amountText: "180",
  categoryId: "coffee",
  note: "beans",
  ts: Date.UTC(2026, 6, 20, 4),
  categories: CATS,
  dateMin: "2000-01-01",
  dateMax: "2099-12-31",
  ...over,
});

test("edit sheet reuses the existing sheet shell", () => {
  const html = renderEditSheet(baseEdit());
  for (const cls of [
    "sheet",
    "sheet-backdrop",
    "sheet-panel",
    "amount-input",
    "amount-error",
    "chips",
  ]) {
    assert.ok(html.includes(cls), `${cls} must be reused, not reinvented`);
  }
});

test("edit sheet prefills all four editable fields", () => {
  const html = renderEditSheet(baseEdit());
  assert.ok(html.includes('value="180"'), "amount not prefilled");
  assert.ok(html.includes('value="beans"'), "note not prefilled");
  assert.ok(html.includes('value="2026-07-20"'), "date not prefilled");
  assert.match(
    html,
    /class="chip chip--active"[\s\S]*?data-cat-id="coffee"/,
    "the current category must start selected",
  );
});

test("edit sheet never offers to change kind — the data layer always refuses it", () => {
  const html = renderEditSheet(baseEdit({ kind: "withdrawal" }));
  // updateTxn returns error:"kind" for any kind change, so a control for it
  // would only teach the user to expect something that can never work.
  assert.ok(
    !/data-action="[^"]*kind/.test(html),
    "no control may offer to change kind",
  );
  // It is still STATED, so the sheet never claims to edit something it isn't.
  assert.ok(html.includes("Edit withdrawal"), "the kind must still be named");
  assert.ok(html.includes("txn-tag--withdrawal"));
});

test("edit sheet offers Delete alongside Save", () => {
  const html = renderEditSheet(baseEdit());
  assert.ok(html.includes('data-action="save-edit"'));
  assert.ok(html.includes('data-action="delete-txn"'));
  assert.match(
    html,
    /data-action="delete-txn"\s*\n?\s*data-id="a"/,
    "delete must carry the id it deletes",
  );
});

test("the date field is bounded to the window idb.js accepts", () => {
  // idb.planUpdate refuses a ts outside 2000..2100 with error:"date". Handing
  // the native picker the same window prevents the mistake instead of
  // reporting it.
  const html = renderEditSheet(baseEdit());
  assert.ok(html.includes('min="2000-01-01"'));
  assert.ok(html.includes('max="2099-12-31"'));
});

test("chips carry aria-pressed so the selection isn't conveyed by style alone", () => {
  const html = renderEditSheet(baseEdit());
  assert.match(html, /data-cat-id="coffee" aria-pressed="true"/);
  assert.match(html, /data-cat-id="food" aria-pressed="false"/);
});

test("edit sheet survives a junk VM", () => {
  for (const vm of [undefined, {}, { categories: null }, { categories: "x" }]) {
    const html = renderEditSheet(vm);
    assert.equal(typeof html, "string");
    assert.ok(html.includes("sheet-panel"));
  }
});

/* ---- the patchers ------------------------------------------------------ */

/**
 * The smallest DOM that patchEditCategory actually touches: a panel holding
 * chips with a data-cat-id, a class list and an attribute bag. Modelling only
 * this keeps the test honest about the contract — if the patcher starts
 * needing more, this fails loudly rather than passing against a fake that
 * quietly grew to match.
 */
function fakePanel(ids, activeId) {
  const chips = ids.map((id) => {
    const classes = new Set(["chip"]);
    if (id === activeId) classes.add("chip--active");
    const attrs = { "data-cat-id": id };
    return {
      classList: {
        toggle(cls, on) {
          if (on) classes.add(cls);
          else classes.delete(cls);
        },
        contains: (cls) => classes.has(cls),
      },
      getAttribute: (k) => attrs[k] ?? null,
      setAttribute: (k, v) => {
        attrs[k] = v;
      },
      _classes: classes,
      _attrs: attrs,
    };
  });
  return {
    _chips: chips,
    querySelectorAll: (sel) => (sel === ".chip" ? chips : []),
    querySelector: (sel) =>
      sel === ".chip--active"
        ? (chips.find((c) => c._classes.has("chip--active")) ?? null)
        : null,
  };
}

test("patchEditCategory moves the selection to exactly one chip", () => {
  const panel = fakePanel(["food", "gas", "coffee"], "coffee");
  const picked = patchEditCategory(panel, "gas");

  assert.equal(picked, "gas");
  const active = panel._chips.filter((c) => c._classes.has("chip--active"));
  assert.equal(active.length, 1, "exactly one chip may be selected");
  assert.equal(active[0]._attrs["data-cat-id"], "gas");
  // The old selection must actually clear, not just be outranked visually.
  assert.equal(
    panel._chips.find((c) => c._attrs["data-cat-id"] === "coffee")._attrs[
      "aria-pressed"
    ],
    "false",
  );
  assert.equal(active[0]._attrs["aria-pressed"], "true");
});

test("patchEditCategory with an unknown id leaves nothing selected rather than guessing", () => {
  const panel = fakePanel(["food", "gas"], "food");
  assert.equal(patchEditCategory(panel, "nope"), null);
  assert.equal(
    panel._chips.filter((c) => c._classes.has("chip--active")).length,
    0,
  );
});

test("the patchers round-trip: what is patched in is what Save reads back", () => {
  // This pair IS the state. Nothing in `ui` holds the chosen category, because
  // re-rendering the sheet to show a tick would drop the iOS keyboard mid-
  // amount (RULE 1) — so a mismatch here means Save writes the wrong category.
  const panel = fakePanel(["food", "gas", "coffee"], "coffee");
  patchEditCategory(panel, "food");
  assert.equal(readEditCategory(panel), "food");
  patchEditCategory(panel, "gas");
  assert.equal(readEditCategory(panel), "gas");
});

test("the patchers never throw on a missing panel or empty sheet", () => {
  for (const p of [null, undefined, fakePanel([], null)]) {
    assert.equal(patchEditCategory(p, "food"), null);
    assert.equal(readEditCategory(p), null);
  }
});

/* ---- dates ------------------------------------------------------------- */

test("dateInputValue reads the MANILA civil date, not UTC's", () => {
  // 2026-07-20 22:00 Manila is 14:00 UTC the same day — but 2026-07-20 01:00
  // Manila is 2026-07-19 17:00 UTC. toISOString() would file the second under
  // the 19th, which is the whole reason this helper exists.
  assert.equal(dateInputValue(Date.UTC(2026, 6, 20, 14)), "2026-07-20");
  assert.equal(dateInputValue(Date.UTC(2026, 6, 19, 17)), "2026-07-20");
  // Month boundary — the case where being 8h out changes the month key too.
  assert.equal(dateInputValue(Date.UTC(2026, 6, 31, 16)), "2026-08-01");
});

test("dateInputValue returns '' for an unusable timestamp rather than throwing", () => {
  for (const j of [NaN, Infinity, -Infinity, null, undefined, "abc", {}]) {
    assert.equal(dateInputValue(j), "", `threw or guessed on ${String(j)}`);
  }
});
