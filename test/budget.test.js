import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  newMonthFromSettings,
  envelopeState,
  allEnvelopes,
  vaultState,
  spendablePool,
  safeToSpendToday,
  paceDelta,
  envelopePaceTick,
  computeSweep,
  monthsToClose,
  vaultBalance,
  maxWithdrawable,
  planWithdrawal,
} from "../js/budget.js";

const CATS = [
  { id: "save", name: "Save/Invest", pct: 45, vault: true },
  { id: "food", name: "Food", pct: 30, vault: false },
  { id: "gas", name: "Gas", pct: 9, vault: false },
  { id: "coffee", name: "Coffee", pct: 8, vault: false },
  { id: "buffer", name: "Buffer", pct: 5, vault: false },
  { id: "misc", name: "Misc", pct: 3, vault: false },
];

const SETTINGS = { categories: CATS };
const INCOME = 2500000; // ₱25,000

// Manila wall-clock helper: Manila is UTC+8 with no DST, so subtracting 8h
// from the intended local time gives the instant.
function manila(y, m, d, hh = 12, mm = 0) {
  return new Date(Date.UTC(y, m - 1, d, hh - 8, mm, 0));
}

// Opened at midnight on the 1st so the pace window is the whole month —
// pace measures from openedAt, and a 9am open would shave 9 hours off every
// expectation in here. Mid-month opens are covered by their own tests.
function july(income = INCOME) {
  return newMonthFromSettings(
    SETTINGS,
    "2026-07",
    income,
    manila(2026, 7, 1, 0).getTime(),
  );
}

let seq = 0;
function tx(monthKey, categoryId, cent, extra = {}) {
  return {
    id: `t${++seq}`,
    monthKey,
    ts: manila(2026, 7, 5).getTime(),
    cent,
    categoryId,
    note: "",
    kind: "expense",
    synced: 0,
    deleted: 0,
    ...extra,
  };
}

// ---- the invariant a reviewer greps for ------------------------------------

test("a live Settings edit cannot reach a snapshotted month (behavioural)", async () => {
  // The real invariant, tested through behaviour rather than a source-text
  // regex — a regex misses a dynamic import() or a transitive one. We mutate
  // the actual store (which budget.js would have to consult to be wrong) and
  // assert the already-derived numbers do not move.
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    clear: () => mem.clear(),
  };
  const store = await import("../js/store.js");

  const month = newMonthFromSettings(
    { categories: store.getCategories() },
    "2026-07",
    INCOME,
    0,
  );
  const before = {
    coffee: envelopeState(month, [], "coffee").allocCent,
    pool: spendablePool(month, []).allocCent,
    vault: vaultState(month, []).allocCent,
    envs: allEnvelopes(month, [], manila(2026, 7, 10)).map((e) => e.allocCent),
  };

  // Rebalance hard in the live store: coffee 8% -> 1%, save 45% -> 52%.
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
  assert.equal(store.getCategories().find((c) => c.id === "coffee").pct, 1);

  assert.equal(envelopeState(month, [], "coffee").allocCent, before.coffee);
  assert.equal(spendablePool(month, []).allocCent, before.pool);
  assert.equal(vaultState(month, []).allocCent, before.vault);
  assert.deepEqual(
    allEnvelopes(month, [], manila(2026, 7, 10)).map((e) => e.allocCent),
    before.envs,
  );
  assert.equal(before.coffee, 200000);

  delete globalThis.localStorage;
});

test("budget.js declares no static dependency on the store module", () => {
  // Cheap belt-and-braces alongside the behavioural test above: check the
  // import statements only, so a mention in a comment doesn't fail the build.
  const src = readFileSync(new URL("../js/budget.js", import.meta.url), "utf8");
  const imports = [
    ...src.matchAll(/^\s*import[\s\S]*?from\s+["']([^"']+)["']/gm),
  ].map((m) => m[1]);
  assert.deepEqual(imports, ["./money.js"]);
  assert.ok(!/\bimport\s*\(/.test(src), "budget.js uses a dynamic import");
});

// ---- month construction ----------------------------------------------------

test("newMonthFromSettings snapshots an exact split", () => {
  const m = july();
  assert.equal(m.key, "2026-07");
  assert.equal(m.incomeCent, INCOME);
  assert.equal(m.closedAt, null);
  assert.equal(m.sweep, null);
  assert.deepEqual(
    m.alloc.map((a) => a.allocCent),
    [1125000, 750000, 225000, 200000, 125000, 75000],
  );
  assert.equal(
    m.alloc.reduce((s, a) => s + a.allocCent, 0),
    INCOME,
  );
  assert.equal(m.alloc[0].vault, true);
  assert.equal(m.alloc[1].vault, false);
});

test("a Settings percentage change never rewrites a snapshotted month", () => {
  const m = july();
  const before = JSON.parse(JSON.stringify(m.alloc));

  // The user rebalances hard: coffee gets cut, save takes it.
  const edited = CATS.map((c) =>
    c.id === "coffee"
      ? { ...c, pct: 1 }
      : c.id === "save"
        ? { ...c, pct: 52 }
        : c,
  );
  const aug = newMonthFromSettings(
    { categories: edited },
    "2026-08",
    INCOME,
    0,
  );

  assert.deepEqual(m.alloc, before, "July alloc mutated by a Settings edit");
  assert.equal(m.alloc.find((a) => a.id === "coffee").allocCent, 200000);
  assert.equal(aug.alloc.find((a) => a.id === "coffee").allocCent, 25000);

  // And derived state still reads July's own numbers.
  const env = envelopeState(m, [], "coffee");
  assert.equal(env.allocCent, 200000);
  assert.equal(env.pct, 8);
});

test("zero-income month: no crash, all envelopes at 0, nothing to sweep", () => {
  const m = july(0);
  assert.deepEqual(
    m.alloc.map((a) => a.allocCent),
    [0, 0, 0, 0, 0, 0],
  );
  const envs = allEnvelopes(m, [], manila(2026, 7, 15));
  assert.equal(envs.length, 5);
  assert.ok(
    envs.every((e) => e.allocCent === 0 && e.leftCent === 0 && !e.over),
  );
  assert.deepEqual(spendablePool(m, []), {
    allocCent: 0,
    spentCent: 0,
    leftCent: 0,
  });
  const sweep = computeSweep(m, []);
  assert.equal(sweep.fromCent, 0);
  assert.equal(sweep.toVaultCent, 0);
  assert.deepEqual(sweep.byCat, {});
  const safe = safeToSpendToday(m, [], manila(2026, 7, 15));
  assert.equal(safe.cent, 0);
  assert.equal(safe.basis, "zero");
});

// ---- envelopes -------------------------------------------------------------

test("envelopeState: spend, left, over, ratio, state", () => {
  const m = july();
  const now = manila(2026, 7, 2); // early, so pace can't force caution

  const fresh = envelopeState(m, [], "food", now);
  assert.equal(fresh.spentCent, 0);
  assert.equal(fresh.leftCent, 750000);
  assert.equal(fresh.state, "safe");
  assert.equal(fresh.over, false);
  assert.equal(fresh.overCent, 0);

  const spent = envelopeState(m, [tx("2026-07", "food", 600000)], "food", now);
  assert.equal(spent.spentCent, 600000);
  assert.equal(spent.leftCent, 150000);
  assert.equal(spent.ratio, 0.8);
  assert.equal(spent.state, "caution");

  const blown = envelopeState(m, [tx("2026-07", "food", 800000)], "food", now);
  assert.equal(blown.leftCent, -50000);
  assert.equal(blown.over, true);
  assert.equal(blown.overCent, 50000);
  assert.equal(blown.state, "over");

  assert.equal(envelopeState(m, [], "nope"), null);
});

test("envelopeState: an income row refunds the envelope", () => {
  const m = july();
  const txns = [
    tx("2026-07", "food", 100000),
    tx("2026-07", "food", 40000, { kind: "income" }),
  ];
  assert.equal(envelopeState(m, txns, "food").spentCent, 60000);
});

test("envelopeState: sweep rows and tombstones are not spending", () => {
  const m = july();
  const txns = [
    tx("2026-07", "food", 100000),
    tx("2026-07", "food", 500000, { kind: "sweep" }),
    tx("2026-07", "food", 900000, { deleted: 1 }),
    tx("2026-06", "food", 700000), // different month
  ];
  assert.equal(envelopeState(m, txns, "food").spentCent, 100000);
});

test("allEnvelopes: spendable only, in snapshot order", () => {
  const m = july();
  const envs = allEnvelopes(m, [], manila(2026, 7, 3));
  assert.deepEqual(
    envs.map((e) => e.id),
    ["food", "gas", "coffee", "buffer", "misc"],
  );
});

test("envelope goes to caution when it is running ahead of the month", () => {
  const m = july();
  const early = manila(2026, 7, 2);
  // 40% of the food envelope gone on day 2 — under 0.8, but way past pace.
  const txns = [tx("2026-07", "food", 300000)];
  assert.equal(envelopeState(m, txns, "food", early).state, "caution");
  // Same spend judged with no `now` (history view) is just safe.
  assert.equal(envelopeState(m, txns, "food").state, "safe");
});

// ---- vault + pool ----------------------------------------------------------

test("vaultState: allocation plus what was swept in", () => {
  const m = july();
  const v = vaultState(m, []);
  assert.equal(v.allocCent, 1125000);
  assert.equal(v.pct, 45);
  assert.equal(v.sweptInCent, 0);
  assert.equal(v.totalCent, 1125000);

  m.sweep = { doneAt: 1, fromCent: 50000, byCat: { food: 50000 } };
  assert.equal(vaultState(m, []).totalCent, 1175000);
});

test("spendablePool excludes the vault", () => {
  const m = july();
  const pool = spendablePool(m, []);
  assert.equal(pool.allocCent, INCOME - 1125000);
  assert.equal(pool.leftCent, pool.allocCent);

  const withSpend = spendablePool(m, [
    tx("2026-07", "food", 200000),
    tx("2026-07", "gas", 50000),
    tx("2026-07", "save", 900000), // vault spend must not touch the pool
  ]);
  assert.equal(withSpend.spentCent, 250000);
  assert.equal(withSpend.leftCent, INCOME - 1125000 - 250000);
});

test("spendablePool counts spend against a deleted category", () => {
  const m = july();
  const pool = spendablePool(m, [tx("2026-07", "ghost", 30000)]);
  assert.equal(pool.spentCent, 30000);
});

// ---- safe to spend ---------------------------------------------------------

test("safeToSpendToday: even split over remaining days, inclusive of today", () => {
  const m = july();
  const now = manila(2026, 7, 21); // 11 days left including the 21st
  const safe = safeToSpendToday(m, [], now);
  assert.equal(safe.daysLeft, 11);
  assert.equal(safe.basis, "even");
  assert.equal(safe.cent, Math.floor((INCOME - 1125000) / 11));
});

test("safeToSpendToday: never negative; basis 'zero' when the pool is spent", () => {
  const m = july();
  const now = manila(2026, 7, 10);
  const blown = [tx("2026-07", "food", 2000000)]; // more than the whole pool
  const safe = safeToSpendToday(m, blown, now);
  assert.equal(safe.cent, 0);
  assert.equal(safe.basis, "zero");
  assert.ok(safe.cent >= 0);

  const exact = safeToSpendToday(
    m,
    [tx("2026-07", "food", INCOME - 1125000)],
    now,
  );
  assert.equal(exact.cent, 0);
  assert.equal(exact.basis, "zero");
});

test("safeToSpendToday: a past month divides by the whole month, not a stale today", () => {
  const june = newMonthFromSettings(SETTINGS, "2026-06", INCOME, 0);
  const now = manila(2026, 7, 21);
  const safe = safeToSpendToday(june, [], now);
  assert.equal(safe.daysLeft, 30);
  assert.equal(safe.cent, Math.floor((INCOME - 1125000) / 30));
});

test("safeToSpendToday: exact value across a fuzz of days and spend levels", () => {
  const m = july();
  const poolAlloc = INCOME - 1125000; // 1,375,000
  for (let day = 1; day <= 31; day++) {
    for (const spend of [0, 1, 500000, 1374999, 1375000, 1375001, 9999999]) {
      const s = safeToSpendToday(
        m,
        [tx("2026-07", "food", spend)],
        manila(2026, 7, day),
      );
      const left = poolAlloc - spend;
      const daysLeft = 31 - day + 1;
      // Assert the ACTUAL number, not merely that it isn't negative — the old
      // version of this test would have passed on a function returning 0.
      assert.equal(s.daysLeft, daysLeft, `daysLeft at day ${day}`);
      if (left <= 0) {
        assert.equal(s.cent, 0, `day ${day} spend ${spend}`);
        assert.equal(s.basis, "zero");
      } else {
        // Note floor(): 1c left across 31 days is legitimately 0, but the
        // basis stays 'even' because the pool is not actually exhausted.
        assert.equal(
          s.cent,
          Math.floor(left / daysLeft),
          `day ${day} spend ${spend}`,
        );
        assert.equal(s.basis, "even");
      }
    }
  }
});

// ---- pace ------------------------------------------------------------------

test("paceDelta: ahead / on / over", () => {
  const m = july();
  const poolAlloc = INCOME - 1125000;
  const mid = manila(2026, 7, 17, 0); // 16/31 elapsed

  assert.equal(paceDelta(m, [], mid).state, "ahead");

  const expected = Math.round(poolAlloc * (16 / 31));
  const on = paceDelta(m, [tx("2026-07", "food", expected)], mid);
  assert.equal(on.state, "on");
  assert.equal(on.expectedCent, expected);
  assert.equal(on.actualCent, expected);
  assert.equal(on.deltaCent, 0);

  const over = paceDelta(m, [tx("2026-07", "food", expected + 200000)], mid);
  assert.equal(over.state, "over");
  assert.ok(over.deltaCent > 0);
});

test("envelopePaceTick: 0..1, past months full, future months empty", () => {
  const m = july();
  assert.equal(envelopePaceTick(m, manila(2026, 6, 30, 16)), 0); // July not started
  assert.ok(
    Math.abs(envelopePaceTick(m, manila(2026, 7, 17, 0)) - 16 / 31) < 1e-9,
  );
  assert.equal(envelopePaceTick(m, manila(2026, 8, 5)), 1);
});

// ---- sweep -----------------------------------------------------------------

test("computeSweep: non-vault leftovers only; overspend contributes 0", () => {
  const m = july();
  const txns = [
    tx("2026-07", "food", 700000), // 50,000 left
    tx("2026-07", "gas", 300000), // over by 75,000
    tx("2026-07", "save", 100000), // vault — irrelevant
  ];
  const sweep = computeSweep(m, txns);
  assert.equal(sweep.byCat.food, 50000);
  assert.equal(
    sweep.byCat.gas,
    undefined,
    "an overspent envelope must not go negative",
  );
  assert.equal(sweep.byCat.coffee, 200000);
  assert.equal(sweep.byCat.buffer, 125000);
  assert.equal(sweep.byCat.misc, 75000);
  assert.equal(sweep.fromCent, 50000 + 200000 + 125000 + 75000);
  assert.equal(sweep.toVaultCent, sweep.fromCent);
  assert.ok(!("save" in sweep.byCat));
});

test("computeSweep is idempotent on a closed month", () => {
  const m = july();
  const txns = [tx("2026-07", "food", 700000)];
  const first = computeSweep(m, txns);

  // Close it the way store.closeMonth would.
  m.closedAt = Date.now();
  m.sweep = {
    doneAt: Date.now(),
    fromCent: first.fromCent,
    byCat: first.byCat,
  };

  const second = computeSweep(m, txns);
  assert.deepEqual(second, first, "second sweep differs from the recorded one");

  const third = computeSweep(m, txns);
  assert.deepEqual(third, first);

  // Even if a sweep txn was written into the log, it isn't re-counted.
  const withSweepTxn = computeSweep(m, [
    ...txns,
    tx("2026-07", "save", first.fromCent, { kind: "sweep" }),
  ]);
  assert.equal(withSweepTxn.fromCent, first.fromCent);

  // And the vault reads the swept amount exactly once.
  assert.equal(vaultState(m, txns).totalCent, 1125000 + first.fromCent);
});

test("computeSweep: fully spent month sweeps nothing", () => {
  const m = july();
  const txns = m.alloc
    .filter((a) => !a.vault)
    .map((a) => tx("2026-07", a.id, a.allocCent));
  const sweep = computeSweep(m, txns);
  assert.equal(sweep.fromCent, 0);
  assert.deepEqual(sweep.byCat, {});
});

// ---- close queue -----------------------------------------------------------

test("monthsToClose: a 2-month gap returns both, oldest first", () => {
  const months = {
    "2026-07": newMonthFromSettings(SETTINGS, "2026-07", INCOME, 0),
    "2026-05": newMonthFromSettings(SETTINGS, "2026-05", INCOME, 0),
    "2026-06": newMonthFromSettings(SETTINGS, "2026-06", INCOME, 0),
  };
  assert.deepEqual(monthsToClose(months, manila(2026, 7, 3)), [
    "2026-05",
    "2026-06",
  ]);
});

test("monthsToClose: skips closed months and the current one", () => {
  const may = newMonthFromSettings(SETTINGS, "2026-05", INCOME, 0);
  may.closedAt = 1;
  const months = {
    "2026-05": may,
    "2026-06": newMonthFromSettings(SETTINGS, "2026-06", INCOME, 0),
    "2026-07": newMonthFromSettings(SETTINGS, "2026-07", INCOME, 0),
  };
  assert.deepEqual(monthsToClose(months, manila(2026, 7, 3)), ["2026-06"]);
  assert.deepEqual(monthsToClose({}, manila(2026, 7, 3)), []);
});

test("monthsToClose: crosses a year boundary and accepts an array", () => {
  const list = [
    newMonthFromSettings(SETTINGS, "2026-01", INCOME, 0),
    newMonthFromSettings(SETTINGS, "2025-12", INCOME, 0),
  ];
  assert.deepEqual(monthsToClose(list, manila(2026, 2, 1)), [
    "2025-12",
    "2026-01",
  ]);
});

test("monthsToClose: a month opened near the Manila month boundary is not closed early", () => {
  const months = {
    "2026-07": newMonthFromSettings(SETTINGS, "2026-07", INCOME, 0),
  };
  // 2026-07-31 23:30 Manila — still July, nothing to close.
  assert.deepEqual(monthsToClose(months, new Date("2026-07-31T15:30:00Z")), []);
  // 2026-08-01 00:30 Manila — July is now closeable.
  assert.deepEqual(monthsToClose(months, new Date("2026-07-31T16:30:00Z")), [
    "2026-07",
  ]);
});

// ---- vault withdrawals -----------------------------------------------------

/** A withdrawal: vault category, required reason in `note`. */
function withdraw(monthKey, cent, note = "birthday gift") {
  return tx(monthKey, "save", cent, { kind: "withdrawal", note });
}

test("a withdrawal reduces vaultState().totalCent by exactly its amount", () => {
  const m = july();
  const base = vaultState(m, []);
  assert.equal(base.allocCent, 1125000);
  assert.equal(base.withdrawnCent, 0);
  assert.equal(base.totalCent, 1125000);

  const one = vaultState(m, [withdraw("2026-07", 200000)]);
  assert.equal(one.withdrawnCent, 200000);
  assert.equal(one.totalCent, 1125000 - 200000);
  assert.equal(one.allocCent, 1125000, "allocation itself must not move");

  const two = vaultState(m, [
    withdraw("2026-07", 200000),
    withdraw("2026-07", 50000),
  ]);
  assert.equal(two.withdrawnCent, 250000);
  assert.equal(two.totalCent, 1125000 - 250000);
});

test("vaultState.totalCent floors at 0 and ignores other months' withdrawals", () => {
  const m = july();
  assert.equal(vaultState(m, [withdraw("2026-07", 99999999)]).totalCent, 0);
  assert.equal(vaultState(m, [withdraw("2026-06", 200000)]).withdrawnCent, 0);
  // A tombstoned withdrawal doesn't count.
  assert.equal(
    vaultState(m, [
      tx("2026-07", "save", 200000, { kind: "withdrawal", deleted: 1 }),
    ]).withdrawnCent,
    0,
  );
});

test("a withdrawal changes NOTHING about the spendable side", () => {
  const m = july();
  const now = manila(2026, 7, 17, 0);
  const spend = [tx("2026-07", "food", 300000), tx("2026-07", "gas", 40000)];
  const withWithdrawal = [...spend, withdraw("2026-07", 500000)];

  // This is the whole product requirement: the daily number must not move.
  assert.deepEqual(
    safeToSpendToday(m, withWithdrawal, now),
    safeToSpendToday(m, spend, now),
  );
  assert.deepEqual(spendablePool(m, withWithdrawal), spendablePool(m, spend));
  assert.deepEqual(
    allEnvelopes(m, withWithdrawal, now),
    allEnvelopes(m, spend, now),
  );
  assert.deepEqual(paceDelta(m, withWithdrawal, now), paceDelta(m, spend, now));
  assert.deepEqual(
    envelopeState(m, withWithdrawal, "food", now),
    envelopeState(m, spend, "food", now),
  );

  // And the vault DID move, so the assertions above aren't vacuous.
  assert.notEqual(
    vaultState(m, withWithdrawal).totalCent,
    vaultState(m, spend).totalCent,
  );
});

test("a withdrawal is not absorbed even when the vault id is absent from alloc", () => {
  // The likeliest leak: excluded by CATEGORY rather than by KIND, so a
  // withdrawal whose categoryId isn't in the snapshot falls through to
  // `otherSpent` and quietly shrinks safeToSpendToday.
  const noVault = newMonthFromSettings(
    {
      categories: CATS.filter((c) => !c.vault).map((c) => ({
        ...c,
        pct: c.pct * 2,
      })),
    },
    "2026-07",
    INCOME,
    0,
  );
  const now = manila(2026, 7, 10);
  const before = safeToSpendToday(noVault, [], now);
  const after = safeToSpendToday(noVault, [withdraw("2026-07", 400000)], now);
  assert.deepEqual(after, before, "withdrawal leaked into the spendable pool");
  assert.equal(
    spendablePool(noVault, [withdraw("2026-07", 400000)]).spentCent,
    0,
  );
});

test("multi-month: a withdrawal draws on the balance built since January", () => {
  // Vault built over 3 months, spent in the 3rd — the birthday-in-August case.
  const months = ["2026-01", "2026-02", "2026-03"].map((k) =>
    newMonthFromSettings(SETTINGS, k, INCOME, 0),
  );
  const perMonth = 1125000;
  assert.equal(vaultBalance(months, []).balanceCent, perMonth * 3);
  assert.equal(vaultBalance(months, []).months, 3);

  // ₱20,000 is more than one month's 45% (₱11,250) — the per-month view would
  // wrongly refuse it. Against the accumulated balance it is fine.
  const big = 2000000;
  assert.ok(big > perMonth);
  assert.equal(maxWithdrawable(months, []), perMonth * 3);

  const txns = [withdraw("2026-03", big)];
  assert.equal(vaultBalance(months, txns).balanceCent, perMonth * 3 - big);
  assert.equal(maxWithdrawable(months, txns), perMonth * 3 - big);

  // upToKey excludes later months from the balance.
  assert.equal(vaultBalance(months, [], "2026-01").balanceCent, perMonth);
  assert.equal(vaultBalance(months, [], "2026-02").balanceCent, perMonth * 2);

  // Swept-in leftovers add to the balance.
  const withSweep = months.map((m) =>
    m.key === "2026-01"
      ? { ...m, sweep: { doneAt: 1, fromCent: 300000, byCat: {} } }
      : m,
  );
  assert.equal(vaultBalance(withSweep, []).balanceCent, perMonth * 3 + 300000);

  // A duplicated record must not pay into the balance twice.
  assert.equal(
    vaultBalance([...months, months[0]], []).balanceCent,
    perMonth * 3,
  );
});

test("the vault cannot go negative: withdrawals are capped", () => {
  const months = [newMonthFromSettings(SETTINGS, "2026-07", INCOME, 0)];
  const avail = maxWithdrawable(months, []);
  assert.equal(avail, 1125000);

  const ok = planWithdrawal(months, [], 200000);
  assert.deepEqual(ok, { cent: 200000, capped: false, availableCent: avail });

  const tooBig = planWithdrawal(months, [], 5000000);
  assert.equal(tooBig.cent, avail);
  assert.equal(tooBig.capped, true);

  // Once drained, the max is 0 and never negative.
  const drained = [withdraw("2026-07", avail)];
  assert.equal(maxWithdrawable(months, drained), 0);
  assert.equal(planWithdrawal(months, drained, 100).cent, 0);
  assert.equal(vaultBalance(months, drained).balanceCent, 0);

  // Over-withdrawal already on record still floors at 0.
  assert.equal(maxWithdrawable(months, [withdraw("2026-07", avail * 2)]), 0);
  assert.equal(planWithdrawal(months, [], -500).cent, 0);
  assert.equal(planWithdrawal(months, [], NaN).cent, 0);
});

test("maxWithdrawable accepts a single MonthRec as well as a collection", () => {
  const m = july();
  assert.equal(maxWithdrawable(m, []), 1125000);
  assert.equal(maxWithdrawable({ "2026-07": m }, []), 1125000);
  assert.equal(maxWithdrawable([m], []), 1125000);
  assert.equal(maxWithdrawable(m, [withdraw("2026-07", 125000)]), 1000000);
});

test("a withdrawal during the closing month does not distort computeSweep", () => {
  const m = july();
  const spend = [tx("2026-07", "food", 700000)];
  const expected = computeSweep(m, spend);

  const withDraw = computeSweep(m, [...spend, withdraw("2026-07", 400000)]);
  assert.deepEqual(withDraw, expected, "withdrawal changed the sweep figure");
  assert.ok(!("save" in withDraw.byCat), "vault must never sweep into itself");

  // Close on the withdrawal-inclusive figure, then confirm idempotency holds
  // and the vault counts alloc + sweep − withdrawal exactly once.
  m.closedAt = Date.now();
  m.sweep = {
    doneAt: Date.now(),
    fromCent: withDraw.fromCent,
    byCat: withDraw.byCat,
  };
  assert.deepEqual(
    computeSweep(m, [...spend, withdraw("2026-07", 400000)]),
    expected,
  );

  const v = vaultState(m, [...spend, withdraw("2026-07", 400000)]);
  assert.equal(v.sweptInCent, expected.fromCent);
  assert.equal(v.withdrawnCent, 400000);
  assert.equal(v.totalCent, 1125000 + expected.fromCent - 400000);
});

// ---- transaction filing across the month boundary --------------------------

test("a txn near midnight on the 31st files to the right month's envelope", () => {
  const jul = july();
  const aug = newMonthFromSettings(SETTINGS, "2026-08", INCOME, 0);
  const txns = [
    tx("2026-07", "coffee", 18000, {
      ts: new Date("2026-07-31T15:30:00Z").getTime(),
    }),
    tx("2026-08", "coffee", 25000, {
      ts: new Date("2026-07-31T16:30:00Z").getTime(),
    }),
  ];
  assert.equal(envelopeState(jul, txns, "coffee").spentCent, 18000);
  assert.equal(envelopeState(aug, txns, "coffee").spentCent, 25000);
});

// ---- robustness ------------------------------------------------------------

test("F3 derived reads survive a MISSING or corrupt month key", () => {
  const now = manila(2026, 7, 5);
  // The previous version of this test used {key:"2026-07"} — a VALID key —
  // so it never exercised the path that actually threw. These are the shapes
  // importJSON used to let through.
  const shapes = [
    {},
    { alloc: [] },
    { key: null, alloc: [] },
    { key: "", alloc: [] },
    { key: "2026-13", alloc: [] },
    { key: "2026-7", alloc: [] },
    { key: 202607, alloc: [] },
    { key: "garbage", alloc: [{ id: "food", pct: 30, allocCent: 750000 }] },
    null,
    undefined,
  ];
  for (const bad of shapes) {
    const label = JSON.stringify(bad);
    assert.doesNotThrow(
      () => safeToSpendToday(bad, [], now),
      `safeToSpendToday ${label}`,
    );
    assert.doesNotThrow(
      () => allEnvelopes(bad, [], now),
      `allEnvelopes ${label}`,
    );
    assert.doesNotThrow(() => spendablePool(bad, []), `spendablePool ${label}`);
    assert.doesNotThrow(() => paceDelta(bad, [], now), `paceDelta ${label}`);
    assert.doesNotThrow(() => vaultState(bad, []), `vaultState ${label}`);
    assert.doesNotThrow(() => computeSweep(bad, []), `computeSweep ${label}`);
    assert.doesNotThrow(
      () => envelopePaceTick(bad, now),
      `envelopePaceTick ${label}`,
    );
    assert.doesNotThrow(
      () => envelopeState(bad, [], "food", now),
      `envelopeState ${label}`,
    );
    assert.doesNotThrow(
      () => maxWithdrawable(bad, []),
      `maxWithdrawable ${label}`,
    );

    const s = safeToSpendToday(bad, [], now);
    assert.ok(s.cent >= 0 && s.daysLeft >= 1, `sane result for ${label}`);
  }

  // The exact repro from the review.
  assert.doesNotThrow(() => safeToSpendToday({ alloc: [] }, [], new Date()));

  // A corrupt key must not enter the close queue, where the close would throw.
  assert.deepEqual(
    monthsToClose([{ key: "2026-13" }, { key: "bad" }], now),
    [],
  );
  assert.doesNotThrow(() =>
    monthsToClose([{ key: "2026-13" }], new Date("nope")),
  );
});

test("derived reads survive junk txns and an empty alloc", () => {
  const junk = { key: "2026-07", alloc: [] };
  assert.deepEqual(allEnvelopes(junk, null, manila(2026, 7, 5)), []);
  assert.deepEqual(spendablePool(junk, undefined), {
    allocCent: 0,
    spentCent: 0,
    leftCent: 0,
  });
  assert.equal(safeToSpendToday(junk, [], manila(2026, 7, 5)).basis, "zero");
  assert.equal(computeSweep(junk, []).fromCent, 0);
  assert.equal(vaultState(junk, []).totalCent, 0);
  assert.equal(paceDelta(junk, [], manila(2026, 7, 5)).deltaCent, 0);

  const m = july();
  const nonsense = [null, undefined, {}, { cent: "x" }, { kind: "withdrawal" }];
  assert.doesNotThrow(() => vaultState(m, nonsense));
  assert.equal(vaultState(m, nonsense).withdrawnCent, 0);
});

test("pace measures from openedAt, not from the 1st", () => {
  // Opening a month mid-month means the budget covers that day onward.
  // Pacing from the 1st would credit the untracked days as savings and
  // report a wild ahead-of-pace on day one.
  const late = newMonthFromSettings(
    SETTINGS,
    "2026-08",
    INCOME,
    manila(2026, 8, 10, 9).getTime(),
  );

  // Day one of a mid-month start: nothing is expected yet.
  assert.equal(paceDelta(late, [], manila(2026, 8, 10, 9)).expectedCent, 0);
  assert.equal(paceDelta(late, [], manila(2026, 8, 10, 9)).state, "on");

  // The window still reaches ~the full spendable pool by month end.
  const pool = spendablePool(late, []).allocCent;
  const end = paceDelta(late, [], manila(2026, 8, 31, 23, 59)).expectedCent;
  assert.ok(
    Math.abs(end - pool) < pool * 0.01,
    `expected ~${pool} by month end, got ${end}`,
  );

  // Halfway through the REMAINING window is roughly half the pool.
  const mid = paceDelta(late, [], manila(2026, 8, 21, 0)).expectedCent;
  assert.ok(
    Math.abs(mid - pool / 2) < pool * 0.05,
    `expected ~${pool / 2} halfway, got ${mid}`,
  );
});

test("a month opened on the 1st paces across the whole month", () => {
  const onTime = newMonthFromSettings(
    SETTINGS,
    "2026-08",
    INCOME,
    manila(2026, 8, 1, 0).getTime(),
  );
  const pool = spendablePool(onTime, []).allocCent;
  const half = paceDelta(onTime, [], manila(2026, 8, 16, 12)).expectedCent;
  assert.equal(half, Math.round(pool / 2));
});

test("pace degrades when openedAt is missing or foreign", () => {
  // Records predating openedAt, and imported ones whose timestamp belongs to
  // another month, fall back to the whole-month window rather than throwing.
  const base = newMonthFromSettings(
    SETTINGS,
    "2026-08",
    INCOME,
    manila(2026, 8, 1, 0).getTime(),
  );
  const pool = spendablePool(base, []).allocCent;
  const expectHalf = Math.round(pool / 2);

  for (const openedAt of [
    undefined,
    null,
    0,
    NaN,
    "junk",
    manila(2026, 3, 4).getTime(),
  ]) {
    const m = { ...base, openedAt };
    assert.doesNotThrow(() => paceDelta(m, [], manila(2026, 8, 16, 12)));
    assert.equal(
      paceDelta(m, [], manila(2026, 8, 16, 12)).expectedCent,
      expectHalf,
      `openedAt=${String(openedAt)} should use the whole month`,
    );
  }
});
