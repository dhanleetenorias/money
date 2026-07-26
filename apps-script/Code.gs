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
 *   2. APPEND-ONLY. A void is a compensating negative row, never an edit or a
 *      delete. That keeps the sheet an audit log you can reconstruct.
 *   3. IDEMPOTENT by txn id. A phone that retries after a flaky response must
 *      not double a row. Ids already present are skipped but still returned in
 *      `accepted`, so the client clears them from its outbox.
 *   4. ONE setValues() per request. Per-row appendRow() is ~1s each and times
 *      out the execution on a real backlog.
 *
 * REQUEST (POST body is a JSON string, sent as text/plain to dodge the CORS
 * preflight that Apps Script cannot answer — see js/sync.js):
 *   {
 *     v: 1,
 *     token: "<shared secret>",
 *     ops: [{
 *       id, op:"append"|"void", ts, monthKey, kind, categoryId,
 *       category, cent, note
 *     }]
 *   }
 *
 * RESPONSE:
 *   { ok:true, accepted:[id], duplicates:[id], rejected:[{id,err}], rows:N }
 *   { ok:false, err:"auth"|"badjson"|"badops"|"toolarge"|"busy"|"unconfigured" }
 *
 * `accepted` is the union of newly-written and already-present ids: both are
 * safe for the client to clear. `duplicates` is informational only.
 */

var SHEET_NAME = "App Log";
var MAX_OPS = 200;
var TZ = "Asia/Manila";

/**
 * App Log columns. Order is load-bearing — the header is written once and the
 * batch setValues() below assumes exactly this shape.
 *
 *   A Date        yyyy-MM-dd (Manila)      — what day the money moved
 *   B Time        HH:mm (Manila)
 *   C Type        expense | income | sweep | void
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
    // taking the lock or touching the sheet.
    if (ops.length === 0) {
      return json({
        ok: true,
        accepted: [],
        duplicates: [],
        rejected: [],
        rows: 0,
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
  return json({ ok: true, service: "money-sync", v: 1 });
}

// ---- core ------------------------------------------------------------------

function writeOps(ops) {
  var sheet = getLogSheet();
  var existing = readIdSet(sheet);

  var rows = [];
  var accepted = [];
  var duplicates = [];
  var rejected = [];

  // Within-batch duplicates matter too: the same id twice in one payload must
  // produce one row, not two.
  var seen = {};
  var now = new Date();
  var syncedAt = Utilities.formatDate(now, TZ, "yyyy-MM-dd HH:mm:ss");

  for (var i = 0; i < ops.length; i++) {
    var op = ops[i] || {};
    var id = String(op.id == null ? "" : op.id);

    if (!id) {
      rejected.push({ id: "", err: "noid" });
      continue;
    }
    if (existing[id] === true || seen[id] === true) {
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

    var isVoid = String(op.op) === "void";
    var kind = String(op.kind || "expense");
    if (kind !== "income" && kind !== "sweep" && kind !== "expense") {
      kind = "expense";
    }

    var note = String(op.note == null ? "" : op.note);
    if (isVoid) note = note ? "VOID — " + note : "VOID";

    rows.push([
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
    ]);

    seen[id] = true;
    accepted.push(id);
  }

  if (rows.length) {
    // ONE write for the whole batch. getLastRow() is read inside the lock, so
    // it cannot race another execution.
    var start = sheet.getLastRow() + 1;
    sheet.getRange(start, 1, rows.length, NUM_COLS).setValues(rows);
  }

  return {
    ok: true,
    accepted: accepted,
    duplicates: duplicates,
    rejected: rejected,
    rows: rows.length,
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
 * Existing txn ids as a lookup map. Reads ONE column, which is why the id
 * lives in its own column — pulling the whole grid would be far slower.
 */
function readIdSet(sheet) {
  var set = {};
  var last = sheet.getLastRow();
  if (last < 2) return set;
  var values = sheet.getRange(2, ID_COL, last - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    var id = values[i][0];
    if (id !== "" && id != null) set[String(id)] = true;
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
