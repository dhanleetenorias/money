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

test("G8 a void of a LANDED append must still write its compensating row", () => {
  // The bug this pins: a void carries the SAME id as the row it reverses, so
  // deduping it by bare id swallowed every void whose original had landed —
  // i.e. every void that matters. Deleting a synced transaction removed it
  // locally and left it in the sheet forever, and the client cleared the op
  // because the server said "accepted".
  const { sheet, writeOps } = load();
  writeOps([op("a1", { cent: -18000 })]);
  assert.equal(sheet.grid.length, 2, "header + the original");

  const res = writeOps([op("a1", { op: "void", cent: 18000 })]);
  assert.equal(res.rows, 1, "the void wrote no compensating row");
  assert.deepEqual(ids(res.duplicates), [], "the void was treated as a dupe");
  assert.deepEqual(ids(res.accepted), ["a1"]);

  const rows = rowsFor(sheet, "a1");
  assert.equal(rows.length, 2, "the id should now own two rows");
  assert.equal(rows[0][4], -180, "the original was altered");
  assert.equal(rows[1][2], "void");
  assert.equal(
    rows[1][4],
    180,
    "the compensating row must have the opposite sign",
  );
  // SUM(E:E) — the whole point of the compensating row — nets to zero.
  assert.equal(rows[0][4] + rows[1][4], 0);

  // A RETRIED void is still idempotent: same id, but keyed as a void.
  const again = writeOps([op("a1", { op: "void", cent: 18000 })]);
  assert.equal(again.rows, 0, "a retried void doubled the tombstone");
  assert.deepEqual(ids(again.duplicates), ["a1"]);
  assert.equal(rowsFor(sheet, "a1").length, 2);

  // And a void twice in ONE batch collapses to one row.
  const batch = writeOps([
    op("a2", { cent: -500 }),
    op("a2", { op: "void", cent: 500 }),
    op("a2", { op: "void", cent: 500 }),
  ]);
  assert.equal(batch.rows, 2, "append + one void, not two voids");
  assert.equal(rowsFor(sheet, "a2").length, 2);
});

test("G9 an update targets the ORIGINAL row, never a void tombstone", () => {
  // readIdRows must skip void rows. If a tombstone could be an update target,
  // an edit would rewrite the reversal back into a live charge.
  const { sheet, writeOps } = load();
  writeOps([op("a1", { cent: -18000 })]);
  writeOps([op("a1", { op: "void", cent: 18000 })]);
  assert.equal(rowsFor(sheet, "a1").length, 2, "precondition: original + void");

  writeOps([op("a1", { op: "update", cent: -25000, note: "edited" })]);

  const rows = rowsFor(sheet, "a1");
  assert.equal(rows.length, 2, "the update appended instead of rewriting");
  assert.equal(rows[0][4], -250, "the ORIGINAL row was not the target");
  assert.equal(rows[0][5], "edited");
  assert.equal(rows[1][2], "void", "the tombstone was overwritten");
  assert.equal(rows[1][4], 180, "the tombstone's amount changed");
});

test("G10 with one id on several rows, the map picks a stable row", () => {
  // Two non-void rows for one id can only be pre-existing corruption or a hand
  // edit, but the choice must still be deterministic and must agree with the
  // append path — which dedupes against this same map. Pinned because a
  // first-vs-last flip is invisible to every other test.
  const { sheet, writeOps } = load();
  writeOps([op("dup", { cent: -100, note: "first" })]);
  // Forge a second row for the same id, as a hand edit would.
  sheet.grid.push([
    "2026-07-12",
    "12:00",
    "expense",
    "Coffee",
    -2,
    "second",
    "2026-07",
    "coffee",
    "dup",
    "x",
  ]);
  assert.equal(rowsFor(sheet, "dup").length, 2);

  writeOps([op("dup", { op: "update", cent: -900, note: "edited" })]);

  const rows = rowsFor(sheet, "dup");
  assert.equal(rows.length, 2, "the update appended a third row");
  assert.equal(rows[0][5], "edited", "the FIRST occurrence must be the target");
  assert.equal(rows[0][4], -9);
  assert.equal(rows[1][5], "second", "the later row was rewritten instead");
});

test("G11 an id in the SHEET and appended in the same batch: the sheet row wins", () => {
  // Precedence between rowById (already in the sheet) and seen (appended
  // earlier in this very batch). Both can only be populated when the append
  // path did NOT dedupe — i.e. the sheet's only row for the id is a VOID
  // tombstone, which readIdRows skips as an update target but which does not
  // stop a fresh append. If `seen` won, the update would rewrite the
  // just-appended row and the ORIGINAL would keep its pre-edit values.
  const { sheet, writeOps } = load();
  writeOps([op("c1", { cent: -100, note: "original" })]);
  const originalRow = sheet.grid.findIndex((r) => r[8] === "c1");

  // One batch: a stale re-append of the same id, then the edit.
  const res = writeOps([
    op("c1", { cent: -100, note: "stale retry" }),
    op("c1", { op: "update", cent: -555, note: "edited" }),
  ]);
  assert.equal(res.rows, 0, "the stale retry was appended");
  assert.equal(res.updated, 1, "the update did not rewrite anything");

  assert.equal(rowsFor(sheet, "c1").length, 1, "one id ended up on two rows");
  assert.equal(
    sheet.grid[originalRow][5],
    "edited",
    "the row already in the SHEET was left holding stale values",
  );
  assert.equal(sheet.grid[originalRow][4], -5.55);
});

test("G14 an update must not rewrite a tombstone into a live charge", () => {
  // The case where skipping void rows in readIdRows is load-bearing: the id's
  // ONLY row in the sheet is a void. That happens whenever the original append
  // never landed but the void did — an offline create, voided, and only the
  // void reached the server.
  //
  // If a tombstone could be an update target, the edit would overwrite the
  // reversal with a positive expense row: the sheet would show money spent
  // that the user had already taken back, and SUM(E:E) would be wrong by twice
  // the amount. Skipping voids sends it down the not-found path, which appends
  // — leaving the tombstone intact.
  const { sheet, writeOps } = load();
  writeOps([op("t1", { op: "void", cent: 18000 })]);
  const voidRow = sheet.grid.findIndex((r) => r[8] === "t1");
  assert.equal(
    sheet.grid[voidRow][2],
    "void",
    "precondition: only a tombstone",
  );

  const res = writeOps([
    op("t1", { op: "update", cent: -25000, note: "edited" }),
  ]);

  assert.equal(res.updated, 0, "the update targeted the tombstone");
  assert.equal(res.rows, 1, "the update should have appended instead");
  assert.equal(
    sheet.grid[voidRow][2],
    "void",
    "the tombstone was rewritten into a live row",
  );
  assert.equal(sheet.grid[voidRow][4], 180, "the tombstone's amount changed");
  assert.equal(sheet.grid[voidRow][5], "VOID — kape");

  const rows = rowsFor(sheet, "t1");
  assert.equal(rows.length, 2, "the edit did not land as its own row");
  assert.equal(rows[1][4], -250);
  assert.equal(rows[1][5], "edited");
});

test("G13 an update after a void targets the ORIGINAL, not the row this batch added", () => {
  // The one payload where rowById and seen BOTH hold a row for the same id.
  // The sheet has original + tombstone; readIdRows points at the original and
  // skips the tombstone, so a fresh append in this batch is NOT deduped and
  // lands in `seen` too. Precedence and the void-skip are both load-bearing:
  //   - if `seen` won, the batch's new row would be edited and the original
  //     would keep the pre-edit amount;
  //   - if readIdRows did not skip voids, the TOMBSTONE would be rewritten
  //     into a live charge.
  const { sheet, writeOps } = load();
  writeOps([op("d1", { cent: -100, note: "original" })]);
  writeOps([op("d1", { op: "void", cent: 100 })]);
  const originalRow = sheet.grid.findIndex((r) => r[8] === "d1");
  const voidRow = sheet.grid.findIndex(
    (r, i) => r[8] === "d1" && i > originalRow,
  );
  assert.ok(voidRow > originalRow, "precondition: original then tombstone");

  writeOps([
    op("d1", { cent: -100, note: "re-append" }),
    op("d1", { op: "update", cent: -777, note: "edited" }),
  ]);

  assert.equal(
    sheet.grid[originalRow][5],
    "edited",
    "the update missed the original row",
  );
  assert.equal(sheet.grid[originalRow][4], -7.77);
  assert.equal(sheet.grid[voidRow][2], "void", "the tombstone was overwritten");
  assert.equal(sheet.grid[voidRow][4], 1, "the tombstone's amount changed");
  // The stale re-append was deduped against the original (the void does not
  // hide it), so the id still owns exactly two rows.
  assert.equal(rowsFor(sheet, "d1").length, 2, "the re-append added a row");
});

test("G12 every success carries `updated` — the client's version tell", () => {
  // A v1 deployment answers without this field, and the client uses its
  // ABSENCE to refuse to clear an update op. If a success ever omits it, every
  // edit queues forever against a perfectly good deployment.
  const { writeOps } = load();
  for (const ops of [
    [op("z1")],
    [op("z1")], // pure duplicate
    [op("z2", { op: "update", cent: -1 })], // not-found → append
    [{ op: "update", cent: 1 }], // all rejected
  ]) {
    const res = writeOps(ops);
    assert.equal(typeof res.updated, "number", "a success omitted `updated`");
    assert.equal(res.v, 2, "a success omitted the protocol version");
  }
  // The zero-op connection test is answered in doPost, not writeOps — pinned
  // by source, since driving doPost needs the whole event shape.
  assert.match(SRC, /if \(ops\.length === 0\)[\s\S]{0,220}updated: 0/);
  assert.match(SRC, /var PROTOCOL_V = 2;/);
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
