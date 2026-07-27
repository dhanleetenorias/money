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
const {
  newMonthFromSettings,
  computeSweep,
  monthsToClose,
  vaultBalance,
  maxWithdrawable,
} = await import("../js/budget.js");

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

/* ------------------------------------------------------------------ *
 * Reopen-and-edit income (main.js saveIncome)
 *
 * saveIncome itself needs a DOM (it reads an input and calls confirm), so
 * these tests exercise the STORE SEQUENCE it performs rather than the handler.
 * That is where the bug actually lived: the handler set a local `reopening`
 * flag and went straight to upsertMonth, which by design refuses every write
 * to a closed month and returns the stored record — so the user confirmed,
 * typed a new income, the sheet closed, and nothing changed.
 * ------------------------------------------------------------------ */

test("R1 upserting a closed month WITHOUT reopening is a silent no-op", () => {
  // The reported bug, pinned so it cannot come back.
  const m = freshMonth("2026-06");
  store.upsertMonth(m);
  store.closeMonth("2026-06", computeSweep(m, []));

  const edited = freshMonth("2026-06", 5000000);
  const returned = store.upsertMonth(edited);

  assert.equal(store.getMonth("2026-06").incomeCent, INCOME, "income moved");
  assert.equal(returned.incomeCent, INCOME, "upsert returned the new record");
  assert.ok(store.getMonth("2026-06").closedAt, "month silently stayed closed");
});

test("R2 reopenMonth THEN upsert is what actually edits a closed month", () => {
  const m = freshMonth("2026-06");
  store.upsertMonth(m);
  store.closeMonth("2026-06", computeSweep(m, []));

  const res = store.reopenMonth("2026-06");
  assert.equal(res.ok, true);
  assert.equal(store.getMonth("2026-06").closedAt, null);
  assert.equal(store.getMonth("2026-06").sweep, null, "old sweep not cleared");

  store.upsertMonth(freshMonth("2026-06", 5000000));
  assert.equal(store.getMonth("2026-06").incomeCent, 5000000);
});

test("R3 reopening REVERSES the original sweep — the vault must not bank it twice", () => {
  // reopenMonth puts the month back in the close queue. If the first sweep
  // were still on the record (or its money still in the vault) the re-close
  // would deposit the same leftovers a second time.
  const m = freshMonth("2026-06");
  store.upsertMonth(m);
  const txns = [
    {
      id: "x1",
      monthKey: "2026-06",
      ts: 0,
      cent: 300000,
      categoryId: "food",
      kind: "expense",
      deleted: 0,
    },
  ];
  const first = computeSweep(store.getMonth("2026-06"), txns);
  store.closeMonth("2026-06", first);

  const vaultAlloc = m.alloc
    .filter((a) => a.vault)
    .reduce((s, a) => s + a.allocCent, 0);
  const closedBalance = vaultBalance(store.getMonths(), txns).balanceCent;
  assert.equal(closedBalance, vaultAlloc + first.fromCent);

  // Reopen: the swept money leaves the vault again immediately.
  store.reopenMonth("2026-06");
  assert.equal(
    vaultBalance(store.getMonths(), txns).balanceCent,
    vaultAlloc,
    "the reopened month still banks its old sweep",
  );

  // Re-close on the SAME numbers: back to exactly one sweep, never two.
  const second = computeSweep(store.getMonth("2026-06"), txns);
  store.closeMonth("2026-06", second);
  assert.equal(second.fromCent, first.fromCent);
  assert.equal(
    vaultBalance(store.getMonths(), txns).balanceCent,
    closedBalance,
    "re-closing banked the leftovers twice",
  );

  // And it is back in the close queue between the two, as reopenMonth promises.
  assert.deepEqual(monthsToClose({ "2026-06": { key: "2026-06" } }, null), [
    "2026-06",
  ]);
});

test("R4 the sweep TXN row must be reversed on reopen, or the sheet double-counts", async () => {
  // budget.js ignores kind:'sweep' rows, so leaving one behind changes no
  // local number — but it is a real row in the Google Sheet, and the re-close
  // appends a SECOND one with a fresh uid (a fresh idempotency key the server
  // cannot dedupe). main.js reverses it via undoTxn; this pins the mechanics.
  const sweepRow = {
    id: "sweep-1",
    monthKey: "2026-06",
    ts: 1,
    cent: 1075000,
    categoryId: "save",
    note: "Month close sweep",
    kind: "sweep",
    synced: 0,
    deleted: 0,
  };
  await idb.addTxn(sweepRow);
  assert.equal((await idb.getTxns("2026-06")).length, 1);

  // Unsynced -> hard delete, and the outbox op goes with it.
  await idb.deleteTxn("sweep-1");
  const after = await idb.getTxns("2026-06");
  assert.equal(after.length, 0, "the sweep row survived reopen");

  // A SYNCED row must be voided instead, so the server gets a tombstone.
  await idb.addTxn({ ...sweepRow, id: "sweep-2", synced: 1 });
  await idb.voidTxn("sweep-2");
  assert.equal((await idb.getTxns("2026-06")).length, 0);
  const out = await idb.getOutbox();
  const op = out.find((r) => r.id === "sweep-2");
  assert.ok(op, "voiding a synced sweep row enqueued nothing");
  assert.equal(
    op.op,
    "void",
    "voiding a synced sweep row must enqueue a compensating op",
  );
  assert.equal(op.txn.deleted, 1, "the compensating op is not a tombstone");
});

/* ------------------------------------------------------------------ *
 * The vault card and the withdraw sheet must quote ONE number
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * E — editing an existing transaction (idb.updateTxn)
 *
 * The first write path that MUTATES data already committed to the sheet, so
 * these lean on the outbox invariants rather than just the stored values:
 * exactly one op per id, always, and never one that a stale ack can destroy.
 *
 * updateTxn REQUIRES an isClosed predicate — idb.js cannot import store.js, so
 * the caller supplies the closed-month guard. `open` is the everything-open
 * predicate; `closedGuard` is what main.js will actually pass.
 * ------------------------------------------------------------------ */

const open = { isClosed: () => false };
const closedGuard = { isClosed: (k) => !!store.getMonth(k)?.closedAt };

/** Read the raw fallback blob — the same trick the F2 tests use. */
const rawFb = () =>
  JSON.parse(localStorage.getItem("mn.idbfallback.v1") || "null");

async function seed(over = {}) {
  return idb.addTxn({
    id: "u1",
    monthKey: "2026-07",
    ts: manila(2026, 7, 10).getTime(),
    cent: 18000,
    categoryId: "coffee",
    note: "kape",
    kind: "expense",
    ...over,
  });
}

test("E1 an update rewrites the values and queues exactly ONE update op", async () => {
  await seed();
  const res = await idb.updateTxn("u1", { cent: 25000 }, open);
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);
  assert.equal(res.txn.cent, 25000);

  const stored = (await idb.getTxns("2026-07")).find((t) => t.id === "u1");
  assert.equal(stored.cent, 25000, "the stored row kept the old amount");

  const out = await idb.getOutbox();
  assert.equal(out.length, 1, "an edit added a SECOND outbox row");
  assert.equal(out[0].op, "update");
  assert.equal(out[0].id, "u1");
  assert.equal(out[0].txn.cent, 25000, "the op carries the pre-edit amount");
  // The op must carry the txn's CURRENT values under its EXISTING id.
  assert.equal(out[0].txn.categoryId, "coffee");
  assert.equal(out[0].txn.kind, "expense");
});

test("E2 amount, category, note and date each edit correctly", async () => {
  await seed();
  assert.equal(
    (await idb.updateTxn("u1", { cent: "31500" }, open)).txn.cent,
    31500,
  );
  assert.equal(
    (await idb.updateTxn("u1", { categoryId: "food" }, open)).txn.categoryId,
    "food",
  );
  assert.equal(
    (await idb.updateTxn("u1", { note: "lunch" }, open)).txn.note,
    "lunch",
  );

  // A date move WITHIN the month keeps the key.
  const sameMonth = manila(2026, 7, 22).getTime();
  const a = await idb.updateTxn("u1", { ts: sameMonth }, open);
  assert.equal(a.txn.ts, sameMonth);
  assert.equal(a.txn.monthKey, "2026-07");

  // A date move ACROSS a month boundary must move the month key too, or the
  // txn keeps spending an envelope it no longer belongs to.
  const nextMonth = manila(2026, 8, 3).getTime();
  const b = await idb.updateTxn("u1", { ts: nextMonth }, open);
  assert.equal(
    b.txn.monthKey,
    "2026-08",
    "the month key did not follow the date",
  );
  assert.equal((await idb.getTxns("2026-07")).length, 0);
  assert.equal((await idb.getTxns("2026-08")).length, 1);

  // All four edits still collapsed to one op.
  const out = await idb.getOutbox();
  assert.equal(out.length, 1);
  assert.equal(out[0].txn.cent, 31500);
  assert.equal(out[0].txn.categoryId, "food");
  assert.equal(out[0].txn.note, "lunch");
  assert.equal(out[0].txn.monthKey, "2026-08");

  // Junk is refused rather than written — an edit has an original to keep.
  assert.equal(
    (await idb.updateTxn("u1", { cent: "abc" }, open)).error,
    "amount",
  );
  assert.equal((await idb.updateTxn("u1", { ts: {} }, open)).error, "date");
  assert.equal(
    (await idb.getTxns("2026-08"))[0].cent,
    31500,
    "a rejected amount still overwrote the row",
  );
});

test("E3 kind cannot be changed — an expense never becomes a withdrawal", async () => {
  await seed();
  const res = await idb.updateTxn(
    "u1",
    { cent: 50000, kind: "withdrawal" },
    open,
  );
  assert.equal(res.ok, false, "kind was allowed to move money to the vault");
  assert.equal(res.error, "kind");

  // REFUSED means nothing was applied — not "kind dropped, rest applied".
  const stored = (await idb.getTxns("2026-07"))[0];
  assert.equal(stored.kind, "expense");
  assert.equal(
    stored.cent,
    18000,
    "the amount was applied despite the refusal",
  );
  // The pending append from seed() is untouched — no update was queued on top.
  const box = await idb.getOutbox();
  assert.equal(box.length, 1, "a refused edit queued an extra op");
  assert.equal(box[0].op, "put", "a refused edit rewrote the pending append");
  assert.equal(box[0].txn.cent, 18000);

  // Restating the CURRENT kind is fine — the natural "whole txn back" idiom.
  const ok = await idb.updateTxn("u1", { cent: 50000, kind: "expense" }, open);
  assert.equal(ok.ok, true);
  assert.equal(ok.txn.kind, "expense");
  assert.equal(ok.txn.cent, 50000);

  // Every other kind is equally locked.
  for (const k of ["income", "sweep", "expense"]) {
    await idb.addTxn({ id: `k-${k}`, monthKey: "2026-07", cent: 1, kind: k });
    const bad = k === "expense" ? "income" : "expense";
    assert.equal(
      (await idb.updateTxn(`k-${k}`, { kind: bad }, open)).error,
      "kind",
    );
    assert.equal(
      (await idb.getAllTxns()).find((t) => t.id === `k-${k}`).kind,
      k,
    );
  }
});

test("E4 editing an UNSYNCED txn leaves one op, never two conflicting ones", async () => {
  await seed();
  const before = await idb.getOutbox();
  assert.equal(before.length, 1);
  assert.equal(before[0].op, "put", "precondition: a pending append");

  await idb.updateTxn("u1", { cent: 99900, note: "fixed" }, open);

  const out = await idb.getOutbox();
  assert.equal(out.length, 1, "the outbox holds BOTH an append and an update");
  // The pending append was AMENDED in place: same id, one row, final values.
  assert.equal(out[0].id, "u1");
  assert.equal(out[0].txn.cent, 99900);
  assert.equal(out[0].txn.note, "fixed");
  // And it superseded the append — the seq moved, which is what makes a stale
  // ack for the append mismatch (E6).
  assert.ok(
    out[0].seq > before[0].seq,
    "the op was replaced without bumping seq",
  );

  // Belt and braces: the raw store has exactly one row for this id.
  assert.equal(rawFb().outbox.filter((o) => o.id === "u1").length, 1);
  assert.equal(rawFb().txns.filter((t) => t.id === "u1").length, 1);
});

test("E5 editing a SYNCED txn queues an update — the sheet must learn about it", async () => {
  await seed();
  await idb.getOutbox();
  await idb.markSynced(["u1"]);
  await idb.clearOutbox(["u1"]);
  assert.deepEqual(await idb.getOutbox(), [], "precondition: fully synced");
  assert.equal((await idb.getAllTxns()).find((t) => t.id === "u1").synced, 1);

  const res = await idb.updateTxn("u1", { cent: 42000 }, open);
  assert.equal(res.ok, true);

  const out = await idb.getOutbox();
  assert.equal(out.length, 1, "an edit to a synced row queued nothing");
  assert.equal(out[0].op, "update");
  assert.equal(out[0].txn.cent, 42000);
  // The local copy no longer matches the sheet, so it must not read as synced
  // — a synced flag left at 1 lets the row be filtered out of a re-push.
  assert.equal(
    (await idb.getAllTxns()).find((t) => t.id === "u1").synced,
    0,
    "the edited row still claims to be in sync with the sheet",
  );
});

test("E6 THE STALE-ACK RACE: an ack for the pushed append must not destroy the edit", async () => {
  await seed();

  // Pusher takes the append and sends it.
  const sent = await idb.getOutbox();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].op, "put");

  // While that request is in flight the user edits the amount. No getOutbox()
  // in between — that is exactly what a pusher does when it takes rows.
  await idb.markSynced(["u1"]);
  await idb.updateTxn("u1", { cent: 77700, note: "corrected" }, open);

  // Now the ack for the ORIGINAL append lands.
  await idb.markSynced(["u1"]);
  await idb.clearOutbox(["u1"]);

  const after = await idb.getOutbox();
  assert.equal(after.length, 1, "the update was destroyed by a stale ack");
  assert.equal(after[0].op, "update");
  assert.equal(after[0].txn.cent, 77700, "the surviving op has stale values");

  // And the row must not be flagged synced by that stale ack, or the edit
  // would sit unsent forever.
  const row = rawFb().txns.find((t) => t.id === "u1");
  assert.equal(row.cent, 77700);
  assert.equal(row.synced, 0, "a stale ack marked the edited row synced");

  // The edit does clear once ITS OWN ack arrives.
  await idb.getOutbox();
  await idb.markSynced(["u1"]);
  await idb.clearOutbox(["u1"]);
  assert.deepEqual(await idb.getOutbox(), []);
  assert.equal(rawFb().txns.find((t) => t.id === "u1").synced, 1);
});

test("E7 two rapid edits collapse to ONE queued op carrying the final values", async () => {
  await seed();
  await idb.getOutbox();
  await idb.markSynced(["u1"]);
  await idb.clearOutbox(["u1"]);

  const a = await idb.updateTxn("u1", { cent: 20000 }, open);
  const seqA = (await idb.getOutbox())[0].seq;
  await idb.updateTxn("u1", { cent: 30000 }, open);
  await idb.updateTxn("u1", { cent: 35000, note: "final" }, open);
  assert.equal(a.ok, true);

  const out = await idb.getOutbox();
  assert.equal(out.length, 1, "three edits queued more than one op");
  assert.equal(out[0].op, "update");
  assert.equal(out[0].txn.cent, 35000);
  assert.equal(out[0].txn.note, "final");
  // Each edit BUMPS seq rather than reusing it — that is what makes an ack for
  // any earlier one mismatch and get refused.
  assert.equal(out[0].seq, seqA + 2, "an edit reused the superseded seq");

  // A no-op edit must not dirty anything at all.
  await idb.getOutbox();
  await idb.markSynced(["u1"]);
  await idb.clearOutbox(["u1"]);
  const noop = await idb.updateTxn("u1", { cent: 35000, note: "final" }, open);
  assert.equal(noop.ok, true);
  assert.equal(noop.changed, false);
  assert.deepEqual(await idb.getOutbox(), [], "a no-op edit queued an op");
  assert.equal(
    rawFb().txns.find((t) => t.id === "u1").synced,
    1,
    "a no-op edit un-synced the row",
  );
});

test("E8 an edit in a CLOSED month is refused at the data layer", async () => {
  const txn = await seed();
  // Get it fully synced first, so an outbox row later can only have come from
  // the edit under test.
  await idb.getOutbox();
  await idb.markSynced(["u1"]);
  await idb.clearOutbox(["u1"]);
  assert.deepEqual(await idb.getOutbox(), []);

  // The sweep BANKED a figure computed from this month's transactions — which
  // is exactly why one of them may not move afterwards.
  const m = freshMonth("2026-07");
  store.upsertMonth(m);
  store.closeMonth("2026-07", computeSweep(m, [txn]));
  assert.ok(store.getMonth("2026-07").closedAt, "precondition: closed");

  const res = await idb.updateTxn("u1", { cent: 999999 }, closedGuard);
  assert.equal(
    res.ok,
    false,
    "a closed month accepted an edit — vault desynced",
  );
  assert.equal(res.error, "closed");
  assert.equal(res.monthKey, "2026-07");

  // Nothing was written: not the value, not an outbox op.
  assert.equal(
    (await idb.getTxns("2026-07")).find((t) => t.id === "u1").cent,
    18000,
  );
  assert.deepEqual(await idb.getOutbox(), []);

  // Moving a txn INTO a closed month is refused too — a date edit can carry a
  // row across the boundary, and the destination sweep is just as banked.
  await idb.addTxn({
    id: "u2",
    monthKey: "2026-08",
    ts: manila(2026, 8, 4).getTime(),
    cent: 5000,
    categoryId: "food",
  });
  const into = await idb.updateTxn(
    "u2",
    { ts: manila(2026, 7, 4).getTime() },
    closedGuard,
  );
  assert.equal(into.ok, false, "a txn was moved into a closed month");
  assert.equal(into.error, "closed");
  assert.equal(into.monthKey, "2026-07");
  assert.equal(
    (await idb.getAllTxns()).find((t) => t.id === "u2").monthKey,
    "2026-08",
  );

  // reopenMonth is the deliberate, separate action that unblocks the edit.
  assert.equal(store.reopenMonth("2026-07").ok, true);
  const after = await idb.updateTxn("u1", { cent: 999999 }, closedGuard);
  assert.equal(after.ok, true, "reopening did not unblock the edit");
  const op = (await idb.getOutbox()).find((o) => o.id === "u1");
  assert.equal(op.op, "update");
  assert.equal(op.txn.cent, 999999);
});

test("E9 the guard is mandatory, and the other refusals write nothing", async () => {
  await seed();

  // No predicate = refused. Fail-open would corrupt the vault silently.
  assert.equal((await idb.updateTxn("u1", { cent: 1 })).error, "guard");
  assert.equal((await idb.updateTxn("u1", { cent: 1 }, {})).error, "guard");
  assert.equal(
    (await idb.updateTxn("u1", { cent: 1 }, { isClosed: 1 })).error,
    "guard",
  );
  // A THROWING guard reads as closed: a refused edit costs one retry, an
  // allowed one desyncs the vault.
  assert.equal(
    (
      await idb.updateTxn(
        "u1",
        { cent: 1 },
        {
          isClosed: () => {
            throw new Error("boom");
          },
        },
      )
    ).error,
    "closed",
  );

  assert.equal(
    (await idb.updateTxn("nope", { cent: 1 }, open)).error,
    "notfound",
  );
  assert.equal((await idb.updateTxn("", { cent: 1 }, open)).error, "notfound");
  assert.equal(
    (await idb.updateTxn(null, { cent: 1 }, open)).error,
    "notfound",
  );

  // A tombstoned row is not editable — the server was already told to reverse
  // it, and an edit would resurrect money the user removed.
  await idb.addTxn({ id: "u3", monthKey: "2026-07", cent: 100, synced: 1 });
  await idb.voidTxn("u3");
  assert.equal(
    (await idb.updateTxn("u3", { cent: 900 }, open)).error,
    "deleted",
  );
  assert.equal((await idb.getOutbox()).find((o) => o.id === "u3").op, "void");

  // None of the above disturbed the original.
  assert.equal(
    (await idb.getTxns("2026-07")).find((t) => t.id === "u1").cent,
    18000,
  );

  // An empty / absent patch is a legal no-op, not a crash.
  assert.equal((await idb.updateTxn("u1", {}, open)).changed, false);
  assert.equal((await idb.updateTxn("u1", null, open)).changed, false);
  assert.equal((await idb.updateTxn("u1", undefined, open)).ok, true);
});

test("R5 the home vault card reads the CUMULATIVE balance, not one month", () => {
  // The card used to render vaultState().totalCent — this month's own
  // contribution, floored at 0 — while the withdraw sheet correctly quoted the
  // cumulative maxWithdrawable. With months banked, a legal withdrawal drove
  // the card to ₱0 while most of the balance was still there and spendable.
  const keys = [
    "2026-02",
    "2026-03",
    "2026-04",
    "2026-05",
    "2026-06",
    "2026-07",
  ];
  for (const k of keys) {
    const m = freshMonth(k, INCOME);
    store.upsertMonth(m);
  }
  const vaultPerMonth = 1125000; // 45% of ₱25,000
  const expected = vaultPerMonth * keys.length;
  assert.equal(vaultBalance(store.getMonths(), []).balanceCent, expected);

  const w = [
    {
      id: "w1",
      monthKey: "2026-07",
      ts: 0,
      cent: 5000000, // ₱50,000 — larger than any single month's 45%
      categoryId: "save",
      note: "gift",
      kind: "withdrawal",
      deleted: 0,
    },
  ];

  // What the card used to show: this month alone, floored at 0.
  const perMonthFloored = Math.max(0, vaultPerMonth - 5000000);
  assert.equal(perMonthFloored, 0, "the old card would read ₱0");

  // What both surfaces now show.
  const balance = vaultBalance(store.getMonths(), w, "2026-07").balanceCent;
  assert.equal(balance, expected - 5000000);
  assert.ok(balance > 0, "money is still there and still withdrawable");

  // THE INVARIANT: card and sheet are the same call, so they cannot disagree.
  assert.equal(balance, maxWithdrawable(store.getMonths(), w, "2026-07"));
});
