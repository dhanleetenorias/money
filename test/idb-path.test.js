/**
 * idb.js against a REAL IndexedDB-shaped store.
 *
 * WHY THIS FILE EXISTS
 * Every other suite deletes globalThis.indexedDB, so they all exercise the
 * localStorage fallback — the iOS-private-mode path. That left the branch that
 * runs on every real device with ZERO coverage, and it is the harder branch:
 * the fallback is synchronous read-modify-write, while this one is a request
 * graph where callbacks enqueue further requests inside a live transaction,
 * and awaiting in the wrong place lets the transaction auto-commit before the
 * write lands. That failure mode cannot occur in the fallback at all.
 *
 * The project has no dependencies by design (see package.json), so rather than
 * pull in fake-indexeddb this installs a small shim below. It models the parts
 * idb.js actually uses, and — the load-bearing part — the transaction
 * lifetime rule: a transaction stays open while its request callbacks keep
 * queueing more requests, and completes when the queue finally drains.
 *
 * What it does NOT model: real durability, versionchange blocking, quota
 * errors, or cross-tab concurrency. Those still need a browser.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---- IndexedDB shim --------------------------------------------------------

function makeRequest(tx, run) {
  const req = { onsuccess: null, onerror: null, result: undefined };
  tx._queue.push(() => {
    try {
      req.result = run();
      req.onsuccess?.({ target: req });
    } catch (e) {
      req.error = e;
      req.onerror?.({ target: req });
      throw e;
    }
  });
  tx._schedule();
  return req;
}

function makeStore(tx, name, data, keyPath) {
  const api = {
    put: (value) => makeRequest(tx, () => void data.set(value[keyPath], value)),
    get: (key) => makeRequest(tx, () => data.get(key)),
    delete: (key) => makeRequest(tx, () => void data.delete(key)),
    getAll: () => makeRequest(tx, () => [...data.values()]),
    index: (prop) => ({
      getAll: (key) =>
        makeRequest(tx, () =>
          [...data.values()].filter((v) => v[prop] === key),
        ),
    }),
    createIndex() {},
    name,
  };
  return api;
}

function makeDB(stores) {
  return {
    objectStoreNames: { contains: (n) => stores.has(n) },
    createObjectStore(name, opts) {
      stores.set(name, { data: new Map(), keyPath: opts.keyPath });
      return { createIndex() {} };
    },
    transaction(names) {
      const tx = {
        _queue: [],
        _scheduled: false,
        _done: false,
        oncomplete: null,
        onerror: null,
        onabort: null,
        error: null,
      };
      tx._schedule = () => {
        if (tx._scheduled || tx._done) return;
        tx._scheduled = true;
        queueMicrotask(() => {
          tx._scheduled = false;
          try {
            // Drain in order. A callback may push MORE requests; the
            // transaction stays open until nothing is left, which is the rule
            // idb.js's callback-style writes depend on.
            while (tx._queue.length) tx._queue.shift()();
          } catch (e) {
            tx._done = true;
            tx.error = e;
            tx.onerror?.({ target: tx });
            return;
          }
          if (!tx._queue.length && !tx._done) {
            tx._done = true;
            tx.oncomplete?.({ target: tx });
          }
        });
      };
      tx.objectStore = (name) => {
        if (!(Array.isArray(names) ? names : [names]).includes(name)) {
          throw new Error(`store ${name} not in transaction scope`);
        }
        const s = stores.get(name);
        return makeStore(tx, name, s.data, s.keyPath);
      };
      return tx;
    },
  };
}

const stores = new Map();
globalThis.indexedDB = {
  open() {
    const req = {
      onupgradeneeded: null,
      onsuccess: null,
      onerror: null,
      onblocked: null,
      result: null,
    };
    const db = makeDB(stores);
    req.result = db;
    queueMicrotask(() => {
      if (!stores.size) req.onupgradeneeded?.({ target: req });
      req.onsuccess?.({ target: req });
    });
    return req;
  },
};

// idb.js still reads localStorage for nothing here, but store.js does.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};

const idb = await import("../js/idb.js");

const open = {
  isClosed: () => false,
  monthExists: () => true,
  vaultIds: [],
  maxWithdrawableFor: () => Number.MAX_SAFE_INTEGER,
};

/** Raw rows straight out of the shim, bypassing idb.js's own readers. */
const rawTxns = () => [...(stores.get("txns")?.data.values() ?? [])];
const rawOutbox = () => [...(stores.get("outbox")?.data.values() ?? [])];

beforeEach(() => {
  for (const s of stores.values()) s.data.clear();
  mem.clear();
});

const seed = (over = {}) =>
  idb.addTxn({
    id: "i1",
    monthKey: "2026-07",
    ts: 1783656000000,
    cent: 18000,
    categoryId: "coffee",
    note: "kape",
    kind: "expense",
    ...over,
  });

test("I0 the suite really is on the IndexedDB path, not the fallback", async () => {
  await seed();
  assert.equal(
    idb.isFallback(),
    false,
    "idb.js fell back — I1..I6 prove nothing",
  );
  assert.equal(rawTxns().length, 1, "the write did not reach the object store");
  assert.equal(mem.size, 0, "something was written to localStorage instead");
});

test("I1 an edit writes the txn AND its outbox op in one transaction", async () => {
  await seed();
  const res = await idb.updateTxn("i1", { cent: 25000, note: "fixed" }, open);
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);

  // Read the stores directly: the point is that BOTH halves committed. A txn
  // with no outbox row never syncs; an outbox row with no txn is a phantom.
  const [row] = rawTxns();
  assert.equal(row.cent, 25000);
  assert.equal(row.note, "fixed");
  assert.equal(row.synced, 0);

  const box = rawOutbox();
  assert.equal(box.length, 1, "the outbox op was lost to an early auto-commit");
  assert.equal(box[0].op, "update");
  assert.equal(box[0].txn.cent, 25000);
  assert.equal(box[0].seq, 2, "the pending append was not superseded");
});

test("I2 every refusal is enforced identically on this path", async () => {
  await seed();
  const cases = [
    [{ kind: "withdrawal" }, "kind", open],
    [{ cent: "abc" }, "amount", open],
    [{ ts: -1 }, "date", open],
    [{ categoryId: "save" }, "vault", { ...open, vaultIds: ["save"] }],
    [{ cent: 1 }, "closed", { ...open, isClosed: () => true }],
    [
      { ts: Date.UTC(2026, 8, 2) },
      "nomonth",
      { ...open, monthExists: () => false },
    ],
    [{ cent: 1 }, "guard", {}],
  ];
  for (const [patch, err, guards] of cases) {
    const res = await idb.updateTxn("i1", patch, guards);
    assert.equal(res.ok, false, `${err}: accepted ${JSON.stringify(patch)}`);
    assert.equal(res.error, err);
  }
  // Nothing was written by any of them.
  assert.equal(rawTxns()[0].cent, 18000);
  assert.equal(rawTxns()[0].categoryId, "coffee");
  assert.equal(rawOutbox().filter((o) => o.op === "update").length, 0);

  assert.equal(
    (await idb.updateTxn("ghost", { cent: 1 }, open)).error,
    "notfound",
  );
});

test("I3 a sweep is locked and a no-op edit writes nothing", async () => {
  await idb.addTxn({
    id: "sw",
    monthKey: "2026-06",
    ts: 1783656000000,
    cent: 1075000,
    categoryId: "save",
    kind: "sweep",
  });
  assert.equal(
    (await idb.updateTxn("sw", { cent: 1 }, open)).error,
    "kindlocked",
  );

  await seed();
  await idb.getOutbox();
  await idb.markSynced(["i1"]);
  await idb.clearOutbox(["i1"]);
  assert.equal(rawTxns().find((t) => t.id === "i1").synced, 1);

  const noop = await idb.updateTxn("i1", { cent: 18000, note: "kape" }, open);
  assert.equal(noop.changed, false);
  assert.equal(
    rawTxns().find((t) => t.id === "i1").synced,
    1,
    "a no-op edit un-synced the row",
  );
  assert.equal(rawOutbox().filter((o) => o.id === "i1").length, 0);
});

test("I4 the stale-ack race behaves the same as on the fallback", async () => {
  await seed();
  const sent = await idb.getOutbox();
  assert.equal(sent[0].op, "put");

  // The append is in flight; the user edits.
  await idb.markSynced(["i1"]);
  await idb.updateTxn("i1", { cent: 77700 }, open);

  // The ack for the ORIGINAL append lands.
  await idb.markSynced(["i1"]);
  await idb.clearOutbox(["i1"]);

  const box = rawOutbox();
  assert.equal(box.length, 1, "a stale ack destroyed the edit");
  assert.equal(box[0].op, "update");
  assert.equal(box[0].txn.cent, 77700);
  assert.equal(
    rawTxns()[0].synced,
    0,
    "a stale ack marked the edited row synced — the edit would never push",
  );

  // Its own ack does clear it.
  await idb.getOutbox();
  await idb.markSynced(["i1"]);
  await idb.clearOutbox(["i1"]);
  assert.deepEqual(rawOutbox(), []);
  assert.equal(rawTxns()[0].synced, 1);
});

test("I5 a date move rewrites monthKey and stays queryable by month", async () => {
  await seed();
  const aug = Date.UTC(2026, 7, 3, 4); // 2026-08-03 12:00 Manila
  const res = await idb.updateTxn("i1", { ts: aug }, open);
  assert.equal(res.ok, true);
  assert.equal(res.txn.monthKey, "2026-08");

  // getTxns reads the monthKey INDEX, so a stale index entry would show up
  // here and nowhere else.
  assert.equal(
    (await idb.getTxns("2026-07")).length,
    0,
    "still in the old month",
  );
  const aug2 = await idb.getTxns("2026-08");
  assert.equal(aug2.length, 1);
  assert.equal(aug2[0].id, "i1");
});

test("I6 concurrent edits serialise here too, and both fields survive", async () => {
  await seed({ cent: 1000, note: "orig" });
  const [a, b] = await Promise.all([
    idb.updateTxn("i1", { cent: 5000 }, open),
    idb.updateTxn("i1", { note: "edited" }, open),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);

  const row = rawTxns().find((t) => t.id === "i1");
  assert.equal(row.cent, 5000, "the amount edit was lost");
  assert.equal(row.note, "edited", "the note edit was lost");
  assert.equal(rawOutbox().filter((o) => o.id === "i1").length, 1);
});
