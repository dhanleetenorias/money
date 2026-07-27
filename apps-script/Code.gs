/**
 * MONEY — Apps Script Web App sync endpoint.  REFERENCE COPY.
 *
 * This file is NOT deployed from the repo. It is pasted by hand into the Apps
 * Script editor bound to the spreadsheet. See apps-script/README.md.
 *
 * DESIGN RULES (do not relax these):
 *   1. NEVER touch the `Expense Log` tab. Its columns G/H/I hold live formulas
 *      (Running Cash, Starting Cash, Total Income, Total Spent, Cash Left) and
 *      column K holds an older category dropdown with a different taxonomy.
 *      Appending app rows there corrupts both. We own `App Log` and nothing else.
 *   2. APPEND-ONLY, WITH ONE EXCEPTION. A void is a compensating negative row,
 *      never an edit or a delete — that keeps the sheet reconstructible. The
 *      exception is op:"update", which rewrites one row in place; see below.
 *   3. IDEMPOTENT by txn id. A phone that retries after a flaky response must
 *      not double a row. Ids already present are skipped but still returned in
 *      `accepted`, so the client clears them from its outbox.
 *   4. ONE setValues() per request for appends. Per-row appendRow() is ~1s each
 *      and times out the execution on a real backlog. Updates are per-row
 *      writes by necessity (they target scattered rows), which is why the
 *      client only ever sends a handful.
 *
 * THE `update` OP — the only non-append-only path
 *   The user edited an amount / category / note / date on a row that is
 *   already in the sheet. A compensating pair (void + re-append) was the
 *   append-only alternative and it was rejected: it doubles the row count for
 *   an ordinary typo fix and makes the log unreadable to a human, which is the
 *   point of the log.
 *
 *   `kind` is NOT editable client-side, so an update can never move money
 *   between the vault and the spendable pool — it only ever restates the same
 *   kind. Column C is rewritten from the op anyway, for consistency.
 *
 *   NOT FOUND FALLS BACK TO APPEND. A phone can edit a txn whose original
 *   append never landed (offline when it was created, edited before the first
 *   successful sync). Silently doing nothing would lose that row forever, so
 *   an unmatched id is appended as a normal row.
 *
 *   Updates take the same LockService lock as appends. Two executions each
 *   reading the row map before the other wrote would otherwise let one
 *   overwrite the other's row, or let an append land at a row number a
 *   concurrent update had just claimed.
 *
 * REQUEST (POST body is a JSON string, sent as text/plain to dodge the CORS
 * preflight that Apps Script cannot answer — see js/sync.js):
 *   {
 *     v: 2,
 *     token: "<shared secret>",
 *     ops: [{
 *       id, op:"append"|"void"|"update", ts, monthKey, kind, categoryId,
 *       category, cent, note
 *     }]
 *   }
 *
 * RESPONSE:
 *   { ok:true, v:2, accepted:[id], duplicates:[id], rejected:[{id,err}],
 *     rows:N, updated:M }
 *   { ok:false, err:"auth"|"badjson"|"badops"|"toolarge"|"busy"|"unconfigured" }
 *
 * `v` and `updated` are present on EVERY success, including a zero-op
 * connection test. Their absence is how the client detects a stale (v1)
 * deployment and refuses to clear an `update` op that the old script silently
 * ignored — see the handshake note in js/sync.js. Do not make either
 * conditional.
 *
 * `accepted` is the union of newly-written, updated-in-place and
 * already-present ids: all are safe for the client to clear. `duplicates` is
 * informational only, and an `update` is NEVER reported as a duplicate — the
 * whole point is that it rewrites the row it matched. `rows` counts appended
 * rows, `updated` counts rows rewritten in place.
 */

var SHEET_NAME = "App Log";
var MAX_OPS = 200;
var TZ = "Asia/Manila";

/**
 * Protocol version this deployment speaks. Echoed on every success.
 *
 * v1 = append + void only. v2 adds `update` (rewrite in place) and fixes the
 * void dedupe. The client uses the presence of the `updated` FIELD — not this
 * number — as the version tell, because a v1 deployment predates both and can
 * only ever answer without it. See the handshake note in js/sync.js.
 */
var PROTOCOL_V = 2;

/**
 * App Log columns. Order is load-bearing — the header is written once and the
 * batch setValues() below assumes exactly this shape.
 *
 *   A Date        yyyy-MM-dd (Manila)      — what day the money moved
 *   B Time        HH:mm (Manila)
 *   C Type        expense | income | sweep | withdrawal | void
 *                 withdrawal = money taken back out of Save/Invest (a gift,
 *                 a one-off). NOT envelope spending — don't sum it with
 *                 expenses or you double-count.
 *   D Category    display name ("Food")
 *   E Amount      SIGNED pesos, 2dp — expenses negative, so a plain SUM works
 *   F Note        free text
 *   G Month       "2026-07" month key
 *   H CategoryId  stable id ("food") — survives a category rename
 *   I TxnId       IDEMPOTENCY KEY. Read back cheaply as a single column.
 *   J SyncedAt    server timestamp, ISO-ish Manila local
 */
var HEADERS = [
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

/** 1-based column index of TxnId within HEADERS. */
var ID_COL = 9;
/** 1-based column index of Type. Read alongside TxnId to spot void rows. */
var TYPE_COL = 3;
var NUM_COLS = 10;

// ---- entry point -----------------------------------------------------------

function doPost(e) {
  try {
    var expected = PropertiesService.getScriptProperties().getProperty("TOKEN");
    if (!expected) return json({ ok: false, err: "unconfigured" });

    var body = e && e.postData ? e.postData.contents : "";
    var payload;
    try {
      payload = JSON.parse(body);
    } catch (err) {
      return json({ ok: false, err: "badjson" });
    }
    if (!payload || typeof payload !== "object") {
      return json({ ok: false, err: "badjson" });
    }

    // Constant-ish time compare, and never echo the expected value anywhere.
    if (!safeEquals(String(payload.token || ""), String(expected))) {
      return json({ ok: false, err: "auth" });
    }

    var ops = payload.ops;
    if (!ops || Object.prototype.toString.call(ops) !== "[object Array]") {
      return json({ ok: false, err: "badops" });
    }
    if (ops.length > MAX_OPS) return json({ ok: false, err: "toolarge" });

    // A zero-op request is the client's connection test. Answer without
    // taking the lock or touching the sheet. It carries `updated` and `v` like
    // every other success, so Settings can tell an up-to-date deployment from
    // a stale one BEFORE the user discovers it by losing an edit.
    if (ops.length === 0) {
      return json({
        ok: true,
        v: PROTOCOL_V,
        accepted: [],
        duplicates: [],
        rejected: [],
        rows: 0,
        updated: 0,
      });
    }

    // Serialise concurrent executions: two phones flushing at once could each
    // read the id set before the other wrote, and both would append.
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(25000);
    } catch (err) {
      return json({ ok: false, err: "busy" });
    }

    try {
      return json(writeOps(ops));
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    // Never let a raw stack (which can contain payload fragments) escape.
    return json({ ok: false, err: "server" });
  }
}

/**
 * GET exists only so opening the /exec URL in a browser gives a clear signal
 * that the deployment is live. It reveals nothing and writes nothing.
 */
function doGet() {
  return json({ ok: true, service: "money-sync", v: PROTOCOL_V });
}

// ---- core ------------------------------------------------------------------

function writeOps(ops) {
  var sheet = getLogSheet();
  // id -> 1-based row number. Presence in this map is the "already in the
  // sheet" test that readIdSet used to answer, so one read serves both.
  var rowById = readIdRows(sheet);

  var rows = []; // appended in one batch at the end
  var updates = []; // {row, values} — rewritten in place
  var accepted = [];
  var duplicates = [];
  var rejected = [];

  // rowById doubles as the within-batch dedupe: a row appended by THIS batch
  // is registered in it immediately, so the same id twice in one payload
  // produces one row, not two — and a later update in the payload finds that
  // row number. One map, so the dedupe and the update target can never
  // disagree about which row owns an id.
  // Voids dedupe on a COMPOUND key (id + a NUL + "void"), never on the bare id:
  // a void carries the same id as the row it compensates, so deduping it by id
  // would swallow every void whose original had landed — which is every void
  // that matters. Keyed separately, a RETRIED void is still deduped.
  var voidsInSheet = readVoidSet(sheet);
  var now = new Date();
  var syncedAt = Utilities.formatDate(now, TZ, "yyyy-MM-dd HH:mm:ss");

  // Where the next appended row will land. Tracked rather than re-read so an
  // update that follows an append in the SAME batch can find that append's
  // row number. getLastRow() is read inside the lock, so it cannot race.
  var appendStart = sheet.getLastRow() + 1;
  var nextRow = appendStart;

  for (var i = 0; i < ops.length; i++) {
    var op = ops[i] || {};
    var id = String(op.id == null ? "" : op.id);
    var isUpdate = String(op.op) === "update";
    var isVoid = String(op.op) === "void";

    if (!id) {
      rejected.push({ id: "", err: "noid" });
      continue;
    }

    // DEDUPE, by verb:
    //   append — by id. A retry must not double the row.
    //   update — NEVER. Rewriting the row it matched is the whole point.
    //   void   — by the COMPOUND key only. A void carries the SAME id as the
    //            row it compensates, so deduping it by bare id swallowed every
    //            void whose original had landed, i.e. every void that matters:
    //            the txn vanished locally and lived in the sheet forever.
    if (isVoid) {
      if (voidsInSheet[id] === true) {
        duplicates.push(id);
        accepted.push(id);
        continue;
      }
    } else if (!isUpdate && rowById[id] != null) {
      // Already in the sheet (or earlier in this payload). Report it as
      // accepted so the phone stops resending it — this is the retry-safety.
      duplicates.push(id);
      accepted.push(id);
      continue;
    }

    var cent = Number(op.cent);
    if (!isFinite(cent)) {
      rejected.push({ id: id, err: "badamount" });
      continue;
    }
    cent = Math.round(cent);

    var ts = Number(op.ts);
    if (!isFinite(ts) || ts <= 0) ts = now.getTime();
    var when = new Date(ts);

    var kind = String(op.kind || "expense");
    if (
      kind !== "income" &&
      kind !== "sweep" &&
      kind !== "withdrawal" &&
      kind !== "expense"
    ) {
      kind = "expense";
    }

    var note = String(op.note == null ? "" : op.note);
    if (isVoid) note = note ? "VOID — " + note : "VOID";

    var values = [
      Utilities.formatDate(when, TZ, "yyyy-MM-dd"),
      Utilities.formatDate(when, TZ, "HH:mm"),
      isVoid ? "void" : kind,
      String(op.category == null ? "" : op.category),
      cent / 100, // signed pesos — SUM(E:E) is the net movement
      note,
      String(op.monthKey == null ? "" : op.monthKey),
      String(op.categoryId == null ? "" : op.categoryId),
      id,
      syncedAt,
    ];

    if (isUpdate) {
      // rowById alone is the target lookup, and that is sufficient BY
      // CONSTRUCTION: an append only proceeds when rowById has no entry for
      // the id, and it then writes the same row number into rowById and seen.
      // So `seen[id]`, when set, always equals `rowById[id]` — consulting it
      // as a fallback was a dead branch. This covers the same-batch case too
      // (G4): the append registers its row number before the update is read.
      var target = rowById[id];
      if (target != null) {
        updates.push({ row: target, values: values });
        accepted.push(id);
        continue;
      }
      // NOT FOUND → fall through and APPEND. The original append never
      // landed; doing nothing here would lose the row permanently.
    }

    rows.push(values);
    if (isVoid) {
      // A void APPENDS a compensating row that carries the same id. It must
      // NOT claim the id's row slot: rowById/seen point at the row an update
      // would rewrite, and that is the ORIGINAL, never the tombstone.
      voidsInSheet[id] = true;
    } else {
      rowById[id] = nextRow;
    }
    nextRow += 1;
    accepted.push(id);
  }

  if (rows.length) {
    // ONE write for the whole append batch, at the row number the loop already
    // handed out — re-reading getLastRow() here would disagree with the row
    // numbers recorded in `seen`.
    sheet.getRange(appendStart, 1, rows.length, NUM_COLS).setValues(rows);
  }

  // Updates target scattered rows, so they cannot share a setValues(). The
  // client sends edits one at a time, so this loop is short in practice.
  for (var u = 0; u < updates.length; u++) {
    sheet
      .getRange(updates[u].row, 1, 1, NUM_COLS)
      .setValues([updates[u].values]);
  }

  return {
    ok: true,
    // `v` and `updated` are the version tell. `updated` must be present on
    // EVERY success, including zero — its absence is what tells the client it
    // is talking to a v1 deployment that would silently drop an edit.
    v: PROTOCOL_V,
    accepted: accepted,
    duplicates: duplicates,
    rejected: rejected,
    rows: rows.length,
    updated: updates.length,
  };
}

/** Create `App Log` with its header row on first run. Never creates anything else. */
function getLogSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.getRange(1, 1, 1, NUM_COLS).setValues([HEADERS]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, NUM_COLS).setFontWeight("bold");
    // Plain number format on Amount. Deliberately NOT a formula, NOT a
    // dropdown — `Expense Log` owns that older taxonomy and we stay out of it.
    sheet.getRange(2, 5, sheet.getMaxRows() - 1, 1).setNumberFormat("#,##0.00");
    SpreadsheetApp.flush();
  } else if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, NUM_COLS).setValues([HEADERS]);
    sheet.setFrozenRows(1);
    SpreadsheetApp.flush();
  }
  return sheet;
}

/**
 * Non-void txn ids -> their 1-BASED ROW NUMBER. Reads TWO columns (Type and
 * TxnId) in one getValues, which is still far cheaper than pulling the grid.
 *
 * Returns row numbers rather than a presence flag so an `update` can rewrite
 * its row with a single getRange(row, 1, 1, NUM_COLS).setValues([...]). A
 * non-null entry still answers "is this id already in the sheet", which is all
 * the append path needs.
 *
 * VOID ROWS ARE SKIPPED. A void appends a compensating row carrying the SAME
 * id as the row it reverses, so an id can legitimately appear twice — and an
 * update must always target the ORIGINAL, never the tombstone. Rewriting a
 * tombstone would turn a reversal back into a live charge.
 *
 * Among non-void rows the map keeps the FIRST occurrence. Appends dedupe by
 * id against this map, so the first row is the canonical one every later
 * append was checked against; a second non-void row for one id can only be
 * pre-existing corruption or a hand edit. Targeting the canonical row keeps
 * the append and update paths agreeing on which row owns an id.
 */
function readIdRows(sheet) {
  var map = {};
  var last = sheet.getLastRow();
  if (last < 2) return map;
  // Columns C..I in one read: [0] = Type, [ID_COL - TYPE_COL] = TxnId.
  var span = ID_COL - TYPE_COL + 1;
  var values = sheet.getRange(2, TYPE_COL, last - 1, span).getValues();
  for (var i = 0; i < values.length; i++) {
    var id = values[i][span - 1];
    if (id === "" || id == null) continue;
    if (String(values[i][0]) === "void") continue; // tombstone, never a target
    var k = String(id);
    if (map[k] == null) map[k] = i + 2; // +2: header row + 0-based index
  }
  return map;
}

/**
 * Ids that already have a VOID row in the sheet. Voids are keyed separately
 * from appends precisely because they share an id with the row they reverse —
 * see the dedupe block in writeOps(). This is what still makes a RETRIED void
 * idempotent without swallowing the first one.
 */
function readVoidSet(sheet) {
  var set = {};
  var last = sheet.getLastRow();
  if (last < 2) return set;
  var span = ID_COL - TYPE_COL + 1;
  var values = sheet.getRange(2, TYPE_COL, last - 1, span).getValues();
  for (var i = 0; i < values.length; i++) {
    var id = values[i][span - 1];
    if (id === "" || id == null) continue;
    if (String(values[i][0]) === "void") set[String(id)] = true;
  }
  return set;
}

/**
 * Back-compat shim: the presence set the append path used before row numbers
 * were needed. Kept so a hand-run of an older helper in the editor still works.
 */
function readIdSet(sheet) {
  var rows = readIdRows(sheet);
  var set = {};
  for (var id in rows) {
    if (Object.prototype.hasOwnProperty.call(rows, id)) set[id] = true;
  }
  return set;
}

// ---- utils -----------------------------------------------------------------

/** Length-independent-ish compare. Avoids leaking the token via timing. */
function safeEquals(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
