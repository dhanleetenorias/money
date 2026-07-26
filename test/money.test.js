import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CENT_PER_PESO,
  parseAmount,
  fmt,
  fmtSigned,
  splitByPct,
  pctOf,
  clamp,
  ym,
  ymPrev,
  ymNext,
  daysInMonth,
  dayOfMonth,
  daysLeftInMonth,
  monthProgress,
  isMonthKey,
  uid,
} from "../js/money.js";

const DEFAULT_PCTS = [45, 30, 9, 8, 5, 3];

/** Seeded LCG (glibc constants) — deterministic, so a failure is reproducible. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 2 ** 32;
  };
}

const sum = (a) => a.reduce((x, y) => x + y, 0);

// ---- parseAmount -----------------------------------------------------------

test("parseAmount: accepts real-world input shapes", () => {
  assert.equal(parseAmount("180"), 18000);
  assert.equal(parseAmount("₱180"), 18000);
  assert.equal(parseAmount("1,234.5"), 123450);
  assert.equal(parseAmount("1,234.50"), 123450);
  assert.equal(parseAmount(".5"), 50);
  assert.equal(parseAmount("0"), 0);
  assert.equal(parseAmount("0.01"), 1);
  assert.equal(parseAmount(" ₱ 25,000 "), 2500000);
  assert.equal(parseAmount("25000."), 2500000);
});

test("parseAmount: rejects junk", () => {
  for (const bad of [
    "",
    "   ",
    "abc",
    "-5",
    "1e99",
    "12.345",
    "1.2.3",
    "₱",
    "12a",
    "--1",
    "NaN",
    "Infinity",
    null,
    undefined,
    {},
    NaN,
    -1,
  ]) {
    assert.equal(
      parseAmount(bad),
      null,
      `should reject ${JSON.stringify(bad)}`,
    );
  }
});

test("F6 parseAmount: number input obeys the same rules as string input", () => {
  // RULING: a number with more than 2 decimals is REJECTED, exactly as the
  // string "12.345" is. Previously these went down a separate branch that did
  // Math.round(x * 100) — and 1.005 is stored as 1.00499999999999989, so it
  // silently rounded DOWN to ₱1.00, losing a centavo with no error.
  assert.equal(parseAmount(1.005), null);
  assert.equal(parseAmount(8.615), null);
  assert.equal(parseAmount(180.555), null);
  assert.equal(parseAmount("180.555"), null);

  // Legitimate values still work, and the binary representation of a value
  // with <=2 real decimals must not leak into the result.
  assert.equal(parseAmount(180), 18000);
  assert.equal(parseAmount(1234.5), 123450);
  assert.equal(parseAmount(0.07), 7);
  assert.equal(parseAmount(0.1 + 0.2), 30); // 0.30000000000000004
  assert.equal(parseAmount(1e9), 1e11);
  assert.equal(parseAmount(0), 0);
});

test("parseAmount: rejects absurd magnitudes but keeps the ceiling", () => {
  assert.equal(parseAmount("1000000000"), 1e11);
  assert.equal(parseAmount("1000000001"), null);
});

test("parseAmount: round-trips through fmt", () => {
  const rnd = lcg(7);
  for (let i = 0; i < 500; i++) {
    const cent = Math.floor(rnd() * 5_000_00);
    const text = fmt(cent);
    assert.equal(parseAmount(text), cent, `round-trip failed on ${cent}`);
  }
});

// ---- fmt -------------------------------------------------------------------

test("fmt: peso formatting", () => {
  assert.equal(CENT_PER_PESO, 100);
  assert.equal(fmt(123400), "₱1,234.00");
  assert.equal(fmt(0), "₱0.00");
  assert.equal(fmt(50), "₱0.50");
  assert.equal(fmt(123400, { noSymbol: true }), "1,234.00");
  assert.match(fmt(123456700, { compact: true }), /^₱1\.2M$/);
});

test("fmt: negatives use U+2212, never a hyphen", () => {
  const out = fmt(-42000);
  assert.equal(out, "−₱420.00");
  assert.ok(!out.includes("-"));
});

test("fmtSigned", () => {
  assert.equal(fmtSigned(42000), "+₱420.00");
  assert.equal(fmtSigned(-42000), "−₱420.00");
  assert.equal(fmtSigned(0), "₱0.00");
});

test("fmt: non-finite input degrades to zero rather than 'NaN'", () => {
  assert.equal(fmt(NaN), "₱0.00");
  assert.equal(fmt(undefined), "₱0.00");
});

// ---- splitByPct ------------------------------------------------------------

test("splitByPct: default 6 categories at ₱25,000 hit the exact seed figures", () => {
  const parts = splitByPct(2500000, DEFAULT_PCTS);
  assert.deepEqual(parts, [1125000, 750000, 225000, 200000, 125000, 75000]);
  assert.equal(sum(parts), 2500000);
});

test("splitByPct: sums exactly across 10,000 pseudo-random incomes", () => {
  const rnd = lcg(20260727);
  for (let i = 0; i < 10000; i++) {
    const income = Math.floor(rnd() * 50_000_000);
    const parts = splitByPct(income, DEFAULT_PCTS);
    assert.equal(sum(parts), income, `sum drift at income ${income}`);
    assert.ok(
      parts.every((p) => Number.isInteger(p) && p >= 0),
      `non-integer allocation at income ${income}`,
    );
  }
});

test("splitByPct: sums exactly across random percentage sets too", () => {
  const rnd = lcg(99);
  for (let i = 0; i < 2000; i++) {
    const n = 1 + Math.floor(rnd() * 8);
    const pcts = Array.from(
      { length: n },
      () => Math.round(rnd() * 10000) / 100,
    );
    const income = Math.floor(rnd() * 10_000_000);
    const parts = splitByPct(income, pcts);
    assert.equal(parts.length, n);
    assert.equal(sum(parts), income, `drift at ${income} / ${pcts.join(",")}`);
  }
});

test("splitByPct: edge incomes", () => {
  for (const income of [0, 1, 7, 99, 100, 33333, 1e9]) {
    const parts = splitByPct(income, DEFAULT_PCTS);
    assert.equal(sum(parts), income, `edge income ${income}`);
  }
  assert.deepEqual(splitByPct(0, DEFAULT_PCTS), [0, 0, 0, 0, 0, 0]);
  // 1 centavo goes to the single largest share, not spread or lost.
  assert.deepEqual(splitByPct(1, DEFAULT_PCTS), [1, 0, 0, 0, 0, 0]);
});

test("splitByPct: deterministic tie-break — higher pct, then lower index", () => {
  // Literal expectations, not a comparison against another call: asserting
  // f(x) === f(x) is a tautology that passes for ANY implementation.
  // 100c in three equal thirds: 33/33/33 + a remainder centavo to index 0.
  assert.deepEqual(
    splitByPct(100, [33.333333, 33.333333, 33.333333]),
    [34, 33, 33],
  );

  // Equal remainders, unequal pcts: the bigger envelope wins the centavo.
  assert.deepEqual(splitByPct(7, [50, 50]), [4, 3]);
  assert.deepEqual(splitByPct(10, [25, 75]), [2, 8]);

  // Two centavos over three equal shares go to the two lowest indices.
  assert.deepEqual(
    splitByPct(101, [33.333333, 33.333333, 33.333333]),
    [34, 34, 33],
  );

  // Order of the pcts drives the result — the same multiset reversed puts the
  // remainder somewhere else, which pins that it isn't index-agnostic.
  assert.deepEqual(splitByPct(1, [1, 99]), [0, 1]);
  assert.deepEqual(splitByPct(1, [99, 1]), [1, 0]);
});

test("splitByPct: degenerate inputs never lose money", () => {
  assert.deepEqual(splitByPct(1000, []), []);
  assert.deepEqual(splitByPct(-500, DEFAULT_PCTS), [0, 0, 0, 0, 0, 0]);
  // All-zero percentages still have to account for every centavo.
  const z = splitByPct(10, [0, 0, 0]);
  assert.equal(sum(z), 10);
});

test("splitByPct: survives amounts that would overflow 2^53 naively", () => {
  const big = 1e11; // ₱1B in centavos
  const parts = splitByPct(big, DEFAULT_PCTS);
  assert.equal(sum(parts), big);
});

// ---- small helpers ---------------------------------------------------------

test("pctOf + clamp", () => {
  assert.equal(pctOf(2500000, 45), 1125000);
  assert.equal(pctOf(101, 50), 51);
  assert.equal(pctOf(0, 45), 0);
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(clamp(0.4, 0, 1), 0.4);
  assert.equal(clamp(NaN, 0, 1), 0);
});

test("uid: unique and non-empty", () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const id = uid();
    assert.equal(typeof id, "string");
    assert.ok(id.length > 8);
    assert.ok(!seen.has(id));
    seen.add(id);
  }
});

// ---- calendar --------------------------------------------------------------

test("ym: month boundary is Manila, not UTC", () => {
  // 2026-07-31 23:30 Manila == 15:30 UTC — a UTC key would say "2026-07" here
  // by luck, but the 00:30 case below is where toISOString() breaks.
  assert.equal(ym(new Date("2026-07-31T15:30:00Z")), "2026-07");
  // 2026-08-01 00:30 Manila == 2026-07-31 16:30 UTC.
  assert.equal(ym(new Date("2026-07-31T16:30:00Z")), "2026-08");
  // Same instants, the other direction: last second of July, first of August.
  assert.equal(ym(new Date("2026-07-31T15:59:59Z")), "2026-07");
  assert.equal(ym(new Date("2026-07-31T16:00:00Z")), "2026-08");
});

test("ym: accepts epoch ms as well as Date", () => {
  const d = new Date("2026-07-31T16:30:00Z");
  assert.equal(ym(d.getTime()), "2026-08");
});

test("ym: throws on an invalid date rather than mis-filing money", () => {
  assert.throws(() => ym(new Date("nope")));
  assert.throws(() => ym("not a date"));
});

test("isMonthKey guards every stored key", () => {
  for (const good of ["2026-07", "2026-01", "2026-12", "1999-05"]) {
    assert.equal(isMonthKey(good), true, good);
  }
  for (const bad of [
    "2026-13",
    "2026-00",
    "2026-7",
    "26-07",
    "2026/07",
    "2026-07-15",
    "",
    " 2026-07",
    null,
    undefined,
    202607,
    {},
  ]) {
    assert.equal(isMonthKey(bad), false, JSON.stringify(bad));
  }
});

test("ymPrev / ymNext wrap years", () => {
  assert.equal(ymPrev("2026-07"), "2026-06");
  assert.equal(ymPrev("2026-01"), "2025-12");
  assert.equal(ymNext("2026-07"), "2026-08");
  assert.equal(ymNext("2026-12"), "2027-01");
  assert.throws(() => ymNext("2026-13"));
  assert.throws(() => ymPrev("garbage"));
});

test("daysInMonth including leap years", () => {
  assert.equal(daysInMonth("2026-01"), 31);
  assert.equal(daysInMonth("2026-02"), 28);
  assert.equal(daysInMonth("2028-02"), 29);
  assert.equal(daysInMonth("2000-02"), 29);
  assert.equal(daysInMonth("1900-02"), 28);
  assert.equal(daysInMonth("2026-04"), 30);
});

test("dayOfMonth / daysLeftInMonth are inclusive of today, in Manila", () => {
  const jul1Manila = new Date("2026-06-30T16:00:00Z");
  assert.equal(dayOfMonth(jul1Manila), 1);
  assert.equal(daysLeftInMonth(jul1Manila), 31);

  const jul31Manila = new Date("2026-07-31T15:30:00Z");
  assert.equal(dayOfMonth(jul31Manila), 31);
  assert.equal(daysLeftInMonth(jul31Manila), 1);

  const jul15Manila = new Date("2026-07-15T04:00:00Z");
  assert.equal(daysLeftInMonth(jul15Manila), 17);
});

test("monthProgress runs 0..1 across the month", () => {
  const start = new Date("2026-06-30T16:00:00Z"); // Jul 1 00:00 Manila
  assert.equal(monthProgress(start), 0);

  const end = new Date("2026-07-31T15:59:59Z"); // Jul 31 23:59:59 Manila
  const p = monthProgress(end);
  assert.ok(p > 0.99 && p < 1, `expected ~1, got ${p}`);

  const mid = new Date("2026-07-16T16:00:00Z"); // Jul 17 00:00 Manila
  assert.ok(Math.abs(monthProgress(mid) - 16 / 31) < 1e-9);
});
