/**
 * apps-script/Code.gs — the server half, run against a fake Sheet.
 *
 * WHY THIS EXISTS
 * Code.gs is pasted by hand into the Apps Script editor and only ever executes
 * against the real spreadsheet, so until now nothing could test it and every
 * change was verified by eye. That was tolerable while the script was strictly
 * append-only: the worst case was a duplicate row. `op:"update"` REWRITES a
 * row in place, and the failure modes are silent and destructive — writing to
 * the wrong row number overwrites a real transaction, and skipping an
 * unmatched id loses one.
 *
 * So this file evaluates Code.gs in a `vm` sandbox with stand-ins for the
 * Apps Script globals it touches, and drives the real `writeOps`. It exercises
 * the ROW ARITHMETIC, which is where the damage lives; it cannot check the
 * things only Google can answer (LockService contention, Utilities.formatDate's
 * true Manila output, execution limits). Those are noted in the deploy README.
 *
 * Code.gs is ES5 and is NOT a module — it is read as text, not imported.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(
  new URL("../apps-script/Code.gs", import.meta.url),
  "utf8",
);

const HEADERS = [
  "Date",
  "Time",
  "Type",
  "Category",
  "Amount",
  "Note",
  "Month",
  "CategoryId",
  "TxnId",
  "SyncedAt",
];

/** Minimal Sheet stand-in: a 2-D array plus the range API Code.gs calls. */
function fakeSheet() {
  const grid = [HEADERS.slice()];
  return {
    grid,
    getLastRow: () => grid.length,
    getMaxRows: () => Math.max(1000, grid.length),
    setFrozenRows() {},
    getRange(r, c, nr = 1, nc = 1) {
      return {
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = grid[r - 1 + i] || [];
            const seg = [];
            for (let j = 0; j < nc; j++) seg.push(row[c - 1 + j] ?? "");
            out.push(seg);
          }
          return out;
        },
        setValues(vals) {
          for (let i = 0; i < vals.length; i++) {
            const ri = r - 1 + i;
            while (grid.length <= ri) grid.push([]);
            for (let j = 0; j < vals[i].length; j++) {
              grid[ri][c - 1 + j] = vals[i][j];
            }
          }
        },
        setNumberFormat() {},
        setFontWeight() {},
      };
    },
  };
}

/** Load Code.gs against a fresh sheet. @returns {{sheet, writeOps}} */
function load() {
  const sheet = fakeSheet();
  const pad = (n) => String(n).padStart(2, "0");
  const sandbox = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: () => sheet,
        insertSheet: () => sheet,
      }),
      flush() {},
    },
    Utilities: {
      // Manila is UTC+8 with no DST, so a fixed offset is faithful here.
      formatDate(d, _tz, fmt) {
        const t = new Date(d.getTime() + 8 * 3600 * 1000);
        const date = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
        const time = `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
        if (fmt === "yyyy-MM-dd") return date;
        if (fmt === "HH:mm") return time;
        return `${date} ${time}:${pad(t.getUTCSeconds())}`;
      },
    },
    ContentService: {
      MimeType: { JSON: "json" },
      createTextOutput: (s) => ({ setMimeType: () => s }),
    },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: () => "tok" }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;this.__writeOps = writeOps;`, sandbox);
  return { sheet, writeOps: sandbox.__writeOps };
}

/** A wire op, as js/sync.js toWire() would build it. */
const op = (id, over = {}) => ({
  id,
  op: "append",
  ts: 1783656000000,
  monthKey: "2026-07",
  kind: "expense",
  categoryId: "coffee",
  category: "Coffee",
  cent: -18000,
  note: "kape",
  ...over,
});

/** Every row in the fake sheet carrying this TxnId (column I). */
const rowsFor = (sheet, id) => sheet.grid.filter((r) => r[8] === id);

/**
 * Copy an array out of the vm realm. Arrays built inside the sandbox have that
 * realm's Array.prototype, so deepStrictEqual refuses them even when the
 * contents match.
 */
const ids = (arr) => Array.from(arr || []);

test("G1 an update REWRITES its row in place and appends nothing", () => {
  const { sheet, writeOps } = load();
  writeOps([op("a1"), op("a2", { cent: -5000 })]);
  assert.equal(sheet.grid.length, 3, "header + 2 appended rows");

  const res = writeOps([
    op("a1", {
      op: "update",
      cent: -99900,
      note: "edited",
      category: "Food",
      categoryId: "food",
    }),
  ]);

  assert.equal(res.rows, 0, "an update appended a row");
  assert.equal(res.updated, 1);
  assert.deepEqual(
    ids(res.accepted),
    ["a1"],
    "the client would never clear this op",
  );
  // An update is NEVER a duplicate — rewriting the matched row is the point.
  assert.deepEqual(ids(res.duplicates), []);
  assert.equal(sheet.grid.length, 3, "the sheet grew — the row was duplicated");

  // Row 2 in sheet terms = grid[1]. Asserted by INDEX, not by lookup: an
  // off-by-one in the id->row map would rewrite the header or a neighbour,
  // and a search-by-id would happily find the row wherever it landed.
  assert.deepEqual(sheet.grid[0], HEADERS, "the header row was overwritten");
  const row = sheet.grid[1];
  assert.equal(row[8], "a1", "the update wrote to the wrong row number");
  assert.equal(row[4], -999, "column E must be signed PESOS, not centavos");
  assert.equal(row[5], "edited");
  assert.equal(row[3], "Food");
  assert.equal(row[7], "food");
  assert.equal(rowsFor(sheet, "a1").length, 1);
  assert.equal(sheet.grid[2][8], "a2", "an unrelated row moved");
  assert.equal(sheet.grid[2][5], "kape", "an unrelated row was overwritten");
});

test("G2 an id that is NOT in the sheet is APPENDED, never silently dropped", () => {
  const { sheet, writeOps } = load();
  writeOps([op("a1")]);

  // The phone edited a txn whose original append never landed — created
  // offline, edited before the first successful sync. Doing nothing here
  // would lose that transaction permanently.
  const res = writeOps([
    op("ghost", { op: "update", cent: -1234, note: "never landed" }),
  ]);

  assert.equal(res.rows, 1, "a not-found update wrote nothing at all");
  assert.equal(res.updated, 0);
  assert.deepEqual(ids(res.accepted), ["ghost"]);
  const [row] = rowsFor(sheet, "ghost");
  assert.ok(row, "the unmatched row never reached the sheet");
  assert.equal(row[4], -12.34);
  assert.equal(row[5], "never landed");
});

test("G3 append idempotency is untouched, and a dedupe cannot clobber an edit", () => {
  const { sheet, writeOps } = load();
  writeOps([op("a1")]);
  writeOps([op("a1", { op: "update", note: "edited", cent: -99900 })]);

  // A retry of the ORIGINAL append arrives late (the phone never saw the ack).
  const res = writeOps([op("a1")]);
  assert.equal(res.rows, 0, "the retry doubled the row");
  assert.deepEqual(ids(res.duplicates), ["a1"]);
  assert.deepEqual(
    ids(res.accepted),
    ["a1"],
    "a duplicate must still be clearable",
  );
  assert.equal(
    rowsFor(sheet, "a1")[0][5],
    "edited",
    "a late append retry overwrote the edit with stale values",
  );
});

test("G4 an append and an update of the same id in ONE batch yield one row", () => {
  const { sheet, writeOps } = load();
  // The row number for the pending append has to be tracked in-loop: the
  // append batch has not been written yet when the update is processed.
  const res = writeOps([
    op("b1", { cent: -100 }),
    op("b1", { op: "update", cent: -777, note: "same-batch edit" }),
  ]);
  assert.equal(res.rows, 1);
  assert.equal(res.updated, 1);

  const rows = rowsFor(sheet, "b1");
  assert.equal(rows.length, 1, "one id produced two rows in a single batch");
  assert.equal(rows[0][4], -7.77, "the update did not win");
  assert.equal(rows[0][5], "same-batch edit");
});

test("G5 voids stay append-only, and kind still reaches column C", () => {
  const { sheet, writeOps } = load();
  writeOps([op("v9", { op: "void", cent: 18000 })]);
  const [v] = rowsFor(sheet, "v9");
  assert.equal(v[2], "void", "a void must be typed void, not expense");
  assert.equal(v[5], "VOID — kape");

  // A withdrawal keeps its kind through an update — the client cannot change
  // kind, but column C is rewritten from the op, so it must carry through.
  writeOps([op("w1", { kind: "withdrawal", cent: 500000, category: "Save" })]);
  writeOps([
    op("w1", {
      op: "update",
      kind: "withdrawal",
      cent: 400000,
      category: "Save",
    }),
  ]);
  const w = rowsFor(sheet, "w1");
  assert.equal(w.length, 1);
  assert.equal(w[0][2], "withdrawal", "an update flattened the kind");
  assert.equal(w[0][4], 4000);
});

test("G6 a malformed update is rejected and leaves the row alone", () => {
  const { sheet, writeOps } = load();
  writeOps([op("a1")]);
  writeOps([op("a1", { op: "update", note: "good", cent: -99900 })]);
  const before = sheet.grid.length;

  const res = writeOps([
    { op: "update", cent: 1 }, // no id
    op("a1", { op: "update", cent: "abc" }), // unusable amount
  ]);
  assert.equal(res.rejected.length, 2);
  assert.equal(res.rows, 0);
  assert.equal(res.updated, 0);
  assert.equal(sheet.grid.length, before, "a rejected op still wrote a row");
  assert.equal(
    rowsFor(sheet, "a1")[0][5],
    "good",
    "a rejected update overwrote a real transaction",
  );
});

test("G7 the header contract the row arithmetic depends on", () => {
  // readIdRows() reads a single column and returns row numbers; if TxnId ever
  // moves, every update would rewrite the wrong row. Pin the two constants and
  // the column order together.
  assert.match(SRC, /var ID_COL = 9;/, "TxnId is no longer column I");
  assert.match(SRC, /var NUM_COLS = 10;/);
  assert.equal(HEADERS[8], "TxnId");
  assert.equal(HEADERS.length, 10);

  // The lock must wrap the write path — this is the first op that can destroy
  // data, so two concurrent executions must not interleave.
  assert.match(SRC, /LockService\.getScriptLock\(\)/);
  assert.match(SRC, /return json\(writeOps\(ops\)\);/);
});
