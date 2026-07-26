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

function normalize(txn) {
  return {
    id: String(txn?.id ?? ""),
    monthKey: String(txn?.monthKey ?? ""),
    ts: Number.isFinite(txn?.ts) ? txn.ts : Date.now(),
    cent: Number.isFinite(txn?.cent) ? Math.round(txn.cent) : 0,
    categoryId: String(txn?.categoryId ?? ""),
    note: typeof txn?.note === "string" ? txn.note : "",
    kind:
      txn?.kind === "income" || txn?.kind === "sweep" ? txn.kind : "expense",
    synced: txn?.synced === 1 ? 1 : 0,
    deleted: txn?.deleted === 1 ? 1 : 0,
  };
}

function opFor(txn, op) {
  return { id: txn.id, op, ts: Date.now(), txn: { ...txn } };
}

function fbPut(rec, op) {
  const data = fbRead();
  data.txns = data.txns.filter((t) => t.id !== rec.id).concat(rec);
  data.outbox = data.outbox
    .filter((o) => o.id !== rec.id)
    .concat(opFor(rec, op));
  fbWrite(data);
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
    t.objectStore(OUTBOX).put(opFor(rec, "put"));
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
    return data.txns.length < before;
  }
  try {
    const t = db.transaction([TXNS, OUTBOX], "readwrite");
    t.objectStore(TXNS).delete(key);
    t.objectStore(OUTBOX).delete(key);
    await txDone(t);
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
    data.outbox = data.outbox
      .filter((o) => o.id !== key)
      .concat(opFor(rec, "void"));
    fbWrite(data);
    return rec;
  }
  try {
    const t = db.transaction([TXNS, OUTBOX], "readwrite");
    const store = t.objectStore(TXNS);
    // Callback style rather than await between the get and the put: awaiting
    // mid-transaction can let the transaction auto-commit before the write.
    const out = { rec: null };
    const get = store.get(key);
    get.onsuccess = () => {
      const rec = get.result;
      if (!rec) return;
      rec.deleted = 1;
      rec.synced = 0;
      store.put(rec);
      t.objectStore(OUTBOX).put(opFor(rec, "void"));
      out.rec = rec;
    };
    await txDone(t);
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

/** @returns {Promise<object[]>} pending sync ops, oldest first. */
export async function getOutbox() {
  const db = await openDB();
  if (!db)
    return fbRead()
      .outbox.slice()
      .sort((a, b) => a.ts - b.ts);
  try {
    const t = db.transaction([OUTBOX], "readonly");
    const rows = await reqDone(t.objectStore(OUTBOX).getAll());
    return (rows || []).sort((a, b) => a.ts - b.ts);
  } catch {
    return [];
  }
}

/** Flag txns as synced. Silently skips ids that no longer exist. */
export async function markSynced(ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter(
    Boolean,
  );
  if (!list.length) return;
  const db = await openDB();
  if (!db) {
    const set = new Set(list);
    const data = fbRead();
    for (const t of data.txns) if (set.has(t.id)) t.synced = 1;
    fbWrite(data);
    return;
  }
  try {
    const t = db.transaction([TXNS], "readwrite");
    const store = t.objectStore(TXNS);
    for (const id of list) {
      const get = store.get(id);
      get.onsuccess = () => {
        const rec = get.result;
        if (!rec) return;
        rec.synced = 1;
        store.put(rec);
      };
    }
    await txDone(t);
  } catch {
    // leave them unsynced — the next push retries
  }
}

/** Drop ops the server has accepted. */
export async function clearOutbox(ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter(
    Boolean,
  );
  if (!list.length) return;
  const db = await openDB();
  if (!db) {
    const set = new Set(list);
    const data = fbRead();
    data.outbox = data.outbox.filter((o) => !set.has(o.id));
    fbWrite(data);
    return;
  }
  try {
    const t = db.transaction([OUTBOX], "readwrite");
    const store = t.objectStore(OUTBOX);
    for (const id of list) store.delete(id);
    await txDone(t);
  } catch {
    // ops stay queued; re-push is idempotent by id
  }
}

/** @returns {boolean} true when running on the localStorage fallback. */
export function isFallback() {
  return useFallback;
}
