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

function july(income = INCOME) {
  return newMonthFromSettings(
    SETTINGS,
    "2026-07",
    income,
    manila(2026, 7, 1, 9).getTime(),
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

test("budget.js does not import store.js or settings", () => {
  const src = readFileSync(new URL("../js/budget.js", import.meta.url), "utf8");
  assert.ok(
    !/from\s+["'].*store(\.js)?["']/.test(src),
    "budget.js imports store.js",
  );
  assert.ok(
    !/getSettings|getCategories/.test(src),
    "budget.js reads live settings",
  );
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

test("safeToSpendToday: never negative across a fuzz of spend levels", () => {
  const m = july();
  for (let day = 1; day <= 31; day++) {
    for (const spend of [0, 1, 500000, 1374999, 1375000, 1375001, 9999999]) {
      const s = safeToSpendToday(
        m,
        [tx("2026-07", "food", spend)],
        manila(2026, 7, day),
      );
      assert.ok(s.cent >= 0, `negative at day ${day} spend ${spend}`);
      assert.ok(s.daysLeft >= 1);
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

test("derived reads survive junk input without throwing", () => {
  const junk = { key: "2026-07" };
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
});
