/**
 * MONEY — transaction log + sync outbox (IndexedDB, localStorage fallback).
 *
 *   txns    keyPath "id", indexes: monthKey, synced
 *   outbox  keyPath "id"  — SAME id as the txn it describes, so re-enqueueing
 *                           an op is idempotent instead of piling up duplicates
 *
 * Every write touches txns and outbox inside ONE transaction: a log entry with
 * no outbox row would never sync, and an outbox row with no log entry would
 * push a phantom expense.
 *
 * iOS private mode and locked-down browsers can refuse IndexedDB entirely.
 * When that happens we transparently swap to a localStorage-backed array with
 * the same async API — a call site must never see a throw, because the
 * alternative is losing an expense the user already believes is recorded.
 *
 * txn = {id, monthKey, ts, cent, categoryId, note,
 *        kind:'expense'|'income'|'sweep', synced:0|1, deleted:0}
 */

const DB_NAME = "money";
const DB_VERSION = 1;
const TXNS = "txns";
const OUTBOX = "outbox";
const FALLBACK_KEY = "mn.idbfallback.v1";

let dbPromise = null;
let useFallback = false;

/**
 * id -> `seq` of the outbox row most recently handed to a pusher by
 * getOutbox(). This is what lets clearOutbox() tell "the server acked the row
 * I sent" apart from "the server acked an OLDER row that has since been
 * replaced by a void".
 *
 * Enqueueing (addTxn/voidTxn) DELETES the entry, so a row that was written
 * after a push is never mistaken for the row that was pushed. The match is
 * exact — a stale entry can only ever cause a re-push, which is idempotent by
 * id, whereas a wrong delete loses a real deletion permanently.
 *
 * In memory only: after a reload nothing is in flight, so every row is
 * legitimately re-pushable.
 */
const handedOut = new Map();

// ---- connection ------------------------------------------------------------

function openDB() {
  if (useFallback) return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    let req;
    try {
      if (!globalThis.indexedDB) return resolve(null);
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null);
    }
    // Safari in private mode can leave open() hanging forever instead of
    // firing onerror. Don't let the first expense of the session hang on it.
    const timer = setTimeout(() => resolve(null), 3000);
    const done = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TXNS)) {
        const s = db.createObjectStore(TXNS, { keyPath: "id" });
        s.createIndex("monthKey", "monthKey", { unique: false });
        s.createIndex("synced", "synced", { unique: false });
      }
      if (!db.objectStoreNames.contains(OUTBOX)) {
        db.createObjectStore(OUTBOX, { keyPath: "id" });
      }
    };
    req.onsuccess = () => done(req.result);
    req.onerror = () => done(null);
    req.onblocked = () => done(null);
  }).then((db) => {
    if (!db) useFallback = true;
    return db;
  });

  return dbPromise;
}

/** Resolves when the whole transaction COMMITS, not merely when a request fires. */
function txDone(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error || new Error("idb: transaction failed"));
    t.onabort = () => reject(t.error || new Error("idb: transaction aborted"));
  });
}

function reqDone(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---- localStorage fallback -------------------------------------------------

function emptyFb() {
  return { v: 1, txns: [], outbox: [] };
}

function fbRead() {
  try {
    const raw = localStorage.getItem(FALLBACK_KEY);
    if (!raw) return emptyFb();
    const p = JSON.parse(raw);
    if (!p || p.v !== 1) return emptyFb();
    return {
      v: 1,
      txns: Array.isArray(p.txns) ? p.txns : [],
      outbox: Array.isArray(p.outbox) ? p.outbox : [],
    };
  } catch {
    return emptyFb();
  }
}

function fbWrite(data) {
  try {
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

// ---- normalisation ---------------------------------------------------------

const KINDS = new Set(["expense", "income", "sweep", "withdrawal"]);

/**
 * Coerce THEN validate. `Number.isFinite("18000")` is false, so testing before
 * coercing turned a numeric string amount into a silent ₱0 record.
 * @returns {number|null} rounded integer, or null if genuinely unusable
 */
function toInt(value) {
  if (typeof value === "number" || typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.round(n);
  }
  return null;
}

function normalize(txn) {
  const cent = toInt(txn?.cent);
  const ts = toInt(txn?.ts);
  return {
    id: String(txn?.id ?? ""),
    monthKey: String(txn?.monthKey ?? ""),
    ts: ts === null ? Date.now() : ts,
    cent: cent === null ? 0 : cent,
    categoryId: String(txn?.categoryId ?? ""),
    note: typeof txn?.note === "string" ? txn.note : "",
    // 'withdrawal' = money leaving the vault (categoryId is the vault id).
    // The required reason lives in `note`; the UI enforces that, since an
    // empty note is a product concern rather than a storage one.
    kind: KINDS.has(txn?.kind) ? txn.kind : "expense",
    synced: txn?.synced === 1 ? 1 : 0,
    deleted: txn?.deleted === 1 ? 1 : 0,
  };
}

/**
 * An outbox row. `seq` increments on every enqueue for a given id, so an ack
 * for an earlier enqueue can be told apart from the row that replaced it.
 * See clearOutbox().
 */
function opFor(txn, op, prevSeq = 0) {
  return {
    id: txn.id,
    op,
    ts: Date.now(),
    seq: (Number.isFinite(prevSeq) ? prevSeq : 0) + 1,
    txn: { ...txn },
  };
}

function fbPut(rec, op) {
  const data = fbRead();
  const prev = data.outbox.find((o) => o.id === rec.id);
  data.txns = data.txns.filter((t) => t.id !== rec.id).concat(rec);
  data.outbox = data.outbox
    .filter((o) => o.id !== rec.id)
    .concat(opFor(rec, op, prev?.seq));
  fbWrite(data);
  // The handed-out mark is intentionally NOT cleared here: a re-enqueue
  // supersedes whatever a pusher is holding, and leaving the old seq in place
  // is what makes the stale ack mismatch. Only clearOutbox()/deleteTxn() end
  // a push cycle.
}

// ---- API -------------------------------------------------------------------

/**
 * Append a transaction and its outbox op atomically.
 * @param {object} txn
 * @returns {Promise<object>} the stored txn (normalized). Never rejects.
 */
export async function addTxn(txn) {
  const rec = normalize(txn);
  if (!rec.id) return rec;
  const db = await openDB();
  if (!db) {
    fbPut(rec, "put");
    return rec;
  }
  try {
    const t = db.transaction([TXNS, OUTBOX], "readwrite");
    t.objectStore(TXNS).put(rec);
    const box = t.objectStore(OUTBOX);
    const prev = box.get(rec.id);
    prev.onsuccess = () => box.put(opFor(rec, "put", prev.result?.seq));
    await txDone(t);
  } catch {
    // Storage refused mid-session — keep the money, drop to the fallback.
    useFallback = true;
    fbPut(rec, "put");
  }
  return rec;
}

/**
 * Hard-delete a txn and drop its pending op. Only safe BEFORE the row has
 * synced — that's the 3s undo window. After that, use voidTxn.
 * @returns {Promise<boolean>}
 */
export async function deleteTxn(id) {
  const key = String(id ?? "");
  if (!key) return false;
  const db = await openDB();
  if (!db) {
    const data = fbRead();
    const before = data.txns.length;
    data.txns = data.txns.filter((t) => t.id !== key);
    data.outbox = data.outbox.filter((o) => o.id !== key);
    fbWrite(data);
    forgetHandedOut(key);
    return data.txns.length < before;
  }
  try {
    const t = db.transaction([TXNS, OUTBOX], "readwrite");
    t.objectStore(TXNS).delete(key);
    t.objectStore(OUTBOX).delete(key);
    await txDone(t);
    forgetHandedOut(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Tombstone an already-synced txn and enqueue the compensating op, so the
 * server learns about the reversal instead of quietly keeping the row.
 * @returns {Promise<object|null>} the tombstoned txn
 */
export async function voidTxn(id) {
  const key = String(id ?? "");
  if (!key) return null;
  const db = await openDB();
  if (!db) {
    const data = fbRead();
    const rec = data.txns.find((t) => t.id === key);
    if (!rec) return null;
    rec.deleted = 1;
    rec.synced = 0;
    const prev = data.outbox.find((o) => o.id === key);
    data.outbox = data.outbox
      .filter((o) => o.id !== key)
      .concat(opFor(rec, "void", prev?.seq));
    fbWrite(data);
    // Deliberately does NOT forget the handed-out seq: leaving the OLD seq in
    // place is exactly what makes a late ack for the original append mismatch
    // and get refused, instead of destroying this void.
    return rec;
  }
  try {
    const t = db.transaction([TXNS, OUTBOX], "readwrite");
    const store = t.objectStore(TXNS);
    // Callback style rather than await between the get and the put: awaiting
    // mid-transaction can let the transaction auto-commit before the write.
    const out = { rec: null };
    const box = t.objectStore(OUTBOX);
    const get = store.get(key);
    get.onsuccess = () => {
      const rec = get.result;
      if (!rec) return;
      rec.deleted = 1;
      rec.synced = 0;
      store.put(rec);
      const prev = box.get(key);
      prev.onsuccess = () => box.put(opFor(rec, "void", prev.result?.seq));
      out.rec = rec;
    };
    await txDone(t);
    // See the fallback branch — the mark is intentionally left in place.
    return out.rec;
  } catch {
    return null;
  }
}

/** @returns {Promise<object[]>} live txns for a month, oldest first. */
export async function getTxns(monthKey) {
  const key = String(monthKey ?? "");
  const db = await openDB();
  if (!db) {
    return fbRead()
      .txns.filter((t) => t && t.deleted !== 1 && t.monthKey === key)
      .sort((a, b) => a.ts - b.ts);
  }
  try {
    const t = db.transaction([TXNS], "readonly");
    const rows = await reqDone(
      t.objectStore(TXNS).index("monthKey").getAll(key),
    );
    return (rows || [])
      .filter((r) => r && r.deleted !== 1)
      .sort((a, b) => a.ts - b.ts);
  } catch {
    return [];
  }
}

/** @returns {Promise<object[]>} all live (non-tombstoned) txns, oldest first. */
export async function getAllTxns() {
  const db = await openDB();
  if (!db) {
    return fbRead()
      .txns.filter((t) => t && t.deleted !== 1)
      .sort((a, b) => a.ts - b.ts);
  }
  try {
    const t = db.transaction([TXNS], "readonly");
    const rows = await reqDone(t.objectStore(TXNS).getAll());
    return (rows || [])
      .filter((r) => r && r.deleted !== 1)
      .sort((a, b) => a.ts - b.ts);
  } catch {
    return [];
  }
}

/** Remember the exact rows a pusher is about to send. See clearOutbox(). */
function noteHandedOut(rows) {
  for (const r of rows) {
    if (r && r.id) handedOut.set(String(r.id), Number(r.seq) || 0);
  }
  return rows;
}

/**
 * Forget the mark once a push cycle is genuinely over (the row was cleared or
 * hard-deleted). NOT called when a row is superseded: leaving the old seq in
 * place is precisely what makes the next ack mismatch and be refused.
 */
function forgetHandedOut(id) {
  handedOut.delete(String(id));
}

/** @returns {Promise<object[]>} pending sync ops, oldest first. */
export async function getOutbox() {
  const db = await openDB();
  if (!db)
    return noteHandedOut(
      fbRead()
        .outbox.slice()
        .sort((a, b) => a.ts - b.ts),
    );
  try {
    const t = db.transaction([OUTBOX], "readonly");
    const rows = await reqDone(t.objectStore(OUTBOX).getAll());
    return noteHandedOut((rows || []).sort((a, b) => a.ts - b.ts));
  } catch {
    return [];
  }
}

/**
 * True when the stored outbox row is still the one the pusher sent. A `seq`
 * higher than what we handed out means the row was replaced after the push
 * left — almost always by a void — and the ack does not apply to it.
 */
function ackApplies(row, id) {
  if (!row) return false;
  const sent = handedOut.get(id);
  if (sent === undefined) return true; // never went through getOutbox()
  return (Number(row.seq) || 0) === sent;
}

/**
 * Flag txns as synced. Silently skips ids that no longer exist.
 *
 * Skips any row whose outbox entry was superseded after the push: voidTxn()
 * deliberately sets synced back to 0, and a late ack for the ORIGINAL append
 * would flip it to 1 and strand the void, unsent, forever.
 */
export async function markSynced(ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter(
    Boolean,
  );
  if (!list.length) return;
  const db = await openDB();
  if (!db) {
    const data = fbRead();
    const set = new Set(
      list.filter((id) =>
        ackApplies(
          data.outbox.find((o) => o.id === id),
          id,
        ),
      ),
    );
    for (const t of data.txns) if (set.has(t.id)) t.synced = 1;
    fbWrite(data);
    // Deliberately does NOT forget the handed-out seq: sync.js calls
    // markSynced() and then clearOutbox() for the same ids, and clearOutbox
    // still needs to know which row was actually pushed.
    return;
  }
  try {
    const t = db.transaction([TXNS, OUTBOX], "readwrite");
    const store = t.objectStore(TXNS);
    const box = t.objectStore(OUTBOX);
    for (const id of list) {
      const cur = box.get(id);
      cur.onsuccess = () => {
        if (!ackApplies(cur.result, id)) return;
        const get = store.get(id);
        get.onsuccess = () => {
          const rec = get.result;
          if (!rec) return;
          rec.synced = 1;
          store.put(rec);
        };
      };
    }
    await txDone(t);
    // See the fallback branch: clearOutbox() owns forgetting the seq.
  } catch {
    // leave them unsynced — the next push retries
  }
}

/**
 * Drop ops the server has accepted.
 *
 * Deletes by id ONLY while the stored row is still the one that was pushed.
 * The race this closes: push an append → user voids the txn (the outbox row
 * for that id is REPLACED with op:"void") → the ack for the original append
 * arrives → a blind delete destroys the void, so the row is gone locally and
 * lives on the server forever. A real deletion silently lost.
 *
 * `sync.js` calls this as clearOutbox(ids) and must keep working, so the
 * guard uses the seq recorded by getOutbox() rather than a new argument.
 * `expected` is optional and only for callers that tracked rows themselves.
 *
 * @param {string[]} ids
 * @param {Map<string,number>|Object<string,number>} [expected] id -> seq
 */
export async function clearOutbox(ids, expected) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter(
    Boolean,
  );
  if (!list.length) return;

  const want =
    expected instanceof Map
      ? expected
      : expected && typeof expected === "object"
        ? new Map(Object.entries(expected).map(([k, v]) => [k, Number(v) || 0]))
        : null;
  const applies = (row, id) =>
    want
      ? row && (Number(row.seq) || 0) <= (want.get(id) ?? -1)
      : ackApplies(row, id);

  const db = await openDB();
  if (!db) {
    const data = fbRead();
    const kill = new Set(
      list.filter((id) =>
        applies(
          data.outbox.find((o) => o.id === id),
          id,
        ),
      ),
    );
    data.outbox = data.outbox.filter((o) => !kill.has(o.id));
    fbWrite(data);
    for (const id of kill) handedOut.delete(id);
    return;
  }
  try {
    const t = db.transaction([OUTBOX], "readwrite");
    const store = t.objectStore(OUTBOX);
    for (const id of list) {
      const cur = store.get(id);
      cur.onsuccess = () => {
        if (applies(cur.result, id)) store.delete(id);
      };
    }
    await txDone(t);
    for (const id of list) handedOut.delete(id);
  } catch {
    // ops stay queued; re-push is idempotent by id
  }
}

/** @returns {boolean} true when running on the localStorage fallback. */
export function isFallback() {
  return useFallback;
}
