/**
 * store.js + idb.js regressions.
 *
 * These modules are browser-facing, so the suite installs a localStorage shim
 * and deletes globalThis.indexedDB before importing them — which also exercises
 * idb.js's localStorage fallback path (iOS private mode) for free.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};
delete globalThis.indexedDB;

const store = await import("../js/store.js");
const idb = await import("../js/idb.js");
const { newMonthFromSettings, computeSweep, monthsToClose, vaultBalance } =
  await import("../js/budget.js");

const INCOME = 2500000;
const manila = (y, m, d, hh = 12) =>
  new Date(Date.UTC(y, m - 1, d, hh - 8, 0, 0));

function freshMonth(key = "2026-07", income = INCOME) {
  return newMonthFromSettings(
    { categories: store.getCategories() },
    key,
    income,
    0,
  );
}

beforeEach(() => {
  mem.clear();
});

// ---- F1: upsertMonth must not resurrect a closed month ---------------------

test("F1 upsertMonth refuses to overwrite a CLOSED month", () => {
  store.upsertMonth(freshMonth());
  const sweep = computeSweep(store.getMonth("2026-07"), []);
  const closed = store.closeMonth("2026-07", sweep);
  assert.ok(closed.closedAt);
  assert.equal(
    store.getMonth("2026-07").alloc.find((a) => a.id === "coffee").allocCent,
    200000,
  );

  // The exact reported path: Settings edit, then a routine upsert of a
  // freshly-built month over the closed one.
  const edited = store
    .getCategories()
    .map((c) =>
      c.id === "coffee"
        ? { ...c, pct: 1 }
        : c.id === "save"
          ? { ...c, pct: 52 }
          : c,
    );
  assert.equal(store.setCategories(edited).ok, true);
  const rebuilt = freshMonth();
  assert.equal(rebuilt.alloc.find((a) => a.id === "coffee").allocCent, 25000);

  const result = store.upsertMonth(rebuilt);

  const after = store.getMonth("2026-07");
  assert.ok(after.closedAt, "closedAt was cleared — month would re-close");
  assert.ok(
    after.sweep,
    "sweep record was cleared — leftovers would sweep twice",
  );
  assert.equal(after.sweep.fromCent, sweep.fromCent);
  assert.equal(
    after.alloc.find((a) => a.id === "coffee").allocCent,
    200000,
    "the alloc snapshot was rewritten by a Settings edit",
  );
  assert.equal(
    result.closedAt,
    after.closedAt,
    "should return the stored record",
  );

  // And the close queue must not offer it again.
  assert.deepEqual(monthsToClose(store.getMonths(), manila(2026, 8, 5)), []);
});

test("F1 a double close cannot sweep the same leftovers into the vault twice", () => {
  store.upsertMonth(freshMonth());
  const sweep = computeSweep(store.getMonth("2026-07"), []);
  store.closeMonth("2026-07", sweep);

  const aug = freshMonth("2026-08");
  store.upsertMonth(aug);
  const balanceOnce = vaultBalance(store.getMonths(), []).balanceCent;

  // Try every route back in: re-upsert, re-close, upsert again.
  store.upsertMonth(freshMonth());
  store.closeMonth("2026-07", { fromCent: 999999, byCat: {} });
  store.upsertMonth(freshMonth());

  assert.equal(vaultBalance(store.getMonths(), []).balanceCent, balanceOnce);
  assert.equal(store.getMonth("2026-07").sweep.fromCent, sweep.fromCent);
});

test("F1 upsertMonth still updates an OPEN month, and reopenMonth is deliberate", () => {
  store.upsertMonth(freshMonth());
  const bumped = freshMonth("2026-07", 3000000);
  assert.equal(store.upsertMonth(bumped).incomeCent, 3000000);
  assert.equal(store.getMonth("2026-07").incomeCent, 3000000);

  store.closeMonth("2026-07", computeSweep(store.getMonth("2026-07"), []));
  assert.equal(store.upsertMonth(freshMonth("2026-07", 9)).incomeCent, 3000000);

  const re = store.reopenMonth("2026-07");
  assert.equal(re.ok, true);
  assert.equal(store.getMonth("2026-07").closedAt, null);
  assert.equal(store.getMonth("2026-07").sweep, null);
  assert.equal(store.upsertMonth(freshMonth("2026-07", 9)).incomeCent, 9);

  assert.equal(store.reopenMonth("nope").ok, false);
  assert.equal(store.reopenMonth("2026-13").ok, false);
  assert.equal(store.upsertMonth({ key: "bad" }), null);
  assert.equal(store.upsertMonth(null), null);
});

// ---- F5: import must obey the same 100% rule -------------------------------

test("F5 importJSON rejects categories that do not total 100", () => {
  const bad = JSON.stringify({
    settings: {
      categories: [
        { id: "a", name: "A", pct: 10 },
        { id: "b", name: "B", pct: 10 },
      ],
    },
    months: {},
  });
  const res = store.importJSON(bad);
  assert.equal(res.ok, false, "a 20%-total backup was accepted");
  assert.match(res.error, /categories/i);
  // Nothing was written.
  assert.equal(store.getCategories().length, 6);
  assert.equal(
    store.getCategories().reduce((s, c) => s + c.pct, 0),
    100,
  );
});

test("F5 importJSON accepts a valid backup and round-trips months", () => {
  store.upsertMonth(freshMonth());
  store.setToken("secret-xyz");
  const dump = store.exportJSON();
  assert.ok(!dump.includes("secret-xyz"));

  mem.clear();
  const res = store.importJSON(dump);
  assert.equal(res.ok, true, res.error);
  assert.equal(store.getMonth("2026-07").incomeCent, INCOME);
  assert.equal(
    store.getCategories().reduce((s, c) => s + c.pct, 0),
    100,
  );
});

// ---- F3 (store half): a month record must carry a usable key ---------------

test("F3 importJSON rejects a month record with a missing or bad key", () => {
  const cats = store.getCategories();
  const cases = [
    { "2026-07": { alloc: [] } },
    { "2026-07": { key: null, alloc: [] } },
    { "2026-07": { key: "2026-13", alloc: [] } },
    { "2026-07": { key: "2026-08", alloc: [] } },
    { "bad-key": { key: "bad-key", alloc: [] } },
  ];
  for (const months of cases) {
    const res = store.importJSON(
      JSON.stringify({ settings: { categories: cats }, months }),
    );
    assert.equal(res.ok, false, `accepted ${JSON.stringify(months)}`);
  }
  const good = { "2026-07": { key: "2026-07", alloc: [], incomeCent: 0 } };
  assert.equal(
    store.importJSON(
      JSON.stringify({ settings: { categories: cats }, months: good }),
    ).ok,
    true,
  );
});

// ---- F4: a numeric-string amount must not become ₱0 ------------------------

test("F4 normalize coerces a string amount instead of recording zero", async () => {
  const rec = await idb.addTxn({
    id: "s1",
    monthKey: "2026-07",
    cent: "18000",
    categoryId: "coffee",
    kind: "expense",
  });
  assert.equal(rec.cent, 18000, "a string amount was silently recorded as 0");

  assert.equal(
    (
      await idb.addTxn({
        id: "s2",
        monthKey: "2026-07",
        cent: "1234.6",
        categoryId: "x",
      })
    ).cent,
    1235,
  );
  assert.equal(
    (
      await idb.addTxn({
        id: "s3",
        monthKey: "2026-07",
        cent: 500,
        categoryId: "x",
      })
    ).cent,
    500,
  );
  // Genuine junk still lands on 0 rather than NaN reaching storage.
  for (const [id, bad] of [
    ["s4", "abc"],
    ["s5", null],
    ["s6", undefined],
    ["s7", {}],
    ["s8", NaN],
  ]) {
    assert.equal(
      (
        await idb.addTxn({
          id,
          monthKey: "2026-07",
          cent: bad,
          categoryId: "x",
        })
      ).cent,
      0,
    );
  }
  // ts gets the same treatment.
  assert.equal(
    (
      await idb.addTxn({
        id: "s9",
        monthKey: "2026-07",
        cent: 1,
        ts: "1700000000000",
        categoryId: "x",
      })
    ).ts,
    1700000000000,
  );
});

test("F4 the withdrawal kind survives normalisation", async () => {
  const w = await idb.addTxn({
    id: "w1",
    monthKey: "2026-07",
    cent: 200000,
    categoryId: "save",
    kind: "withdrawal",
    note: "birthday gift",
  });
  assert.equal(w.kind, "withdrawal");
  assert.equal(w.note, "birthday gift");
  assert.equal((await idb.getTxns("2026-07"))[0].kind, "withdrawal");
  // An unknown kind still falls back to expense.
  assert.equal(
    (
      await idb.addTxn({
        id: "w2",
        monthKey: "2026-07",
        cent: 1,
        kind: "nonsense",
      })
    ).kind,
    "expense",
  );
});

// ---- F2: an ack for a superseded op must not destroy the void --------------

test("F2 clearOutbox must not delete a void queued after the push", async () => {
  await idb.addTxn({
    id: "v1",
    monthKey: "2026-07",
    cent: 18000,
    categoryId: "coffee",
  });

  // Pusher reads the outbox and sends the append.
  const sent = await idb.getOutbox();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].op, "put");

  // While that request is in flight the user deletes the (already synced) txn.
  // NOTE: no getOutbox() call in between — that is what a pusher does when it
  // takes rows, and calling it here would legitimately re-arm the tracking.
  await idb.markSynced(["v1"]);
  await idb.voidTxn("v1");

  // Now the ack for the ORIGINAL append lands.
  await idb.clearOutbox(["v1"]);

  const after = await idb.getOutbox();
  assert.equal(after.length, 1, "the void op was destroyed by a stale ack");
  assert.equal(after[0].op, "void");
  assert.equal(
    (await idb.getAllTxns()).find((t) => t.id === "v1"),
    undefined,
  );
});

test("F2 markSynced must not re-flag a txn that was voided after the push", async () => {
  await idb.addTxn({
    id: "v2",
    monthKey: "2026-07",
    cent: 5000,
    categoryId: "gas",
  });
  await idb.getOutbox(); // pusher takes the append
  await idb.voidTxn("v2");

  // Stale ack for the append.
  await idb.markSynced(["v2"]);

  const raw = JSON.parse(localStorage.getItem("mn.idbfallback.v1"));
  const row = raw.txns.find((t) => t.id === "v2");
  assert.equal(row.deleted, 1);
  assert.equal(
    row.synced,
    0,
    "voided row was marked synced — the void would never push",
  );
  assert.equal((await idb.getOutbox())[0].op, "void");
});

test("F2 the normal path still clears: push, ack, empty outbox", async () => {
  await idb.addTxn({
    id: "n1",
    monthKey: "2026-07",
    cent: 9000,
    categoryId: "food",
  });
  const sent = await idb.getOutbox();
  assert.equal(sent.length, 1);
  await idb.markSynced(["n1"]);
  await idb.clearOutbox(["n1"]);
  assert.deepEqual(await idb.getOutbox(), []);
  assert.equal((await idb.getAllTxns()).find((t) => t.id === "n1").synced, 1);

  // A void then acked in its own right clears too.
  await idb.voidTxn("n1");
  await idb.getOutbox();
  await idb.clearOutbox(["n1"]);
  assert.deepEqual(await idb.getOutbox(), []);
});

test("F2 an explicit expectation map overrides the tracked seq", async () => {
  await idb.addTxn({
    id: "e1",
    monthKey: "2026-07",
    cent: 100,
    categoryId: "misc",
  });
  const sent = await idb.getOutbox();
  await idb.voidTxn("e1");
  // Caller passes what it actually pushed; the stored row is newer, so it stays.
  await idb.clearOutbox(["e1"], { e1: sent[0].seq });
  assert.equal((await idb.getOutbox())[0].op, "void");
  // Passing the current seq does clear it.
  const now = await idb.getOutbox();
  await idb.clearOutbox(["e1"], { e1: now[0].seq });
  assert.deepEqual(await idb.getOutbox(), []);
});
