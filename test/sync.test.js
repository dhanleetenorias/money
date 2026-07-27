/**
 * The WIRE CONTRACT between idb.js's outbox and Code.gs.
 *
 * store.test.js proves the right op lands in the outbox; this proves the right
 * JSON leaves the phone. Nothing else covers that seam, and it is easy to break
 * silently: toWire() maps the LOCAL verb ('put'|'void'|'update') to the WIRE
 * verb ('append'|'void'|'update'), and an unmapped verb degrades to 'append' —
 * which the server dedupes by id, so a mis-mapped update would be accepted,
 * cleared from the outbox, and change nothing in the sheet. No error anywhere.
 *
 * Same shims as store.test.js: a localStorage stand-in and no indexedDB, so
 * idb.js runs its fallback path. fetch is stubbed, so nothing leaves the box.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};
delete globalThis.indexedDB;

/** Every request sync.js made, already JSON-parsed. */
const sent = [];
let reply = (body) => ({
  ok: true,
  accepted: body.ops.map((o) => o.id),
  duplicates: [],
  rejected: [],
  rows: body.ops.length,
});

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  sent.push({ body, init });
  const payload = reply(body);
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
};

const store = await import("../js/store.js");
const idb = await import("../js/idb.js");
const sync = await import("../js/sync.js");

sync.configure("https://script.google.com/macros/s/TEST/exec", "tok");

/** kick() is debounced by 400ms; give the drain room to run to completion. */
const settle = () => new Promise((r) => setTimeout(r, 900));

/** All ops the phone has sent, flattened across batches. */
const opsFor = (id) =>
  sent.flatMap((r) => r.body.ops).filter((o) => o.id === id);

const open = { isClosed: () => false };

test("W1 an edit reaches the wire as op:'update' with the CURRENT values", async () => {
  await idb.addTxn({
    id: "w-1",
    monthKey: "2026-07",
    ts: 1783656000000,
    cent: 18000,
    categoryId: "coffee",
    note: "kape",
    kind: "expense",
  });
  const res = await idb.updateTxn(
    "w-1",
    { cent: 25000, note: "kape + pandesal" },
    open,
  );
  assert.equal(res.ok, true);

  sync.kick({ force: true });
  await settle();

  const ops = opsFor("w-1");
  assert.equal(ops.length, 1, "the edit was sent as more than one op");
  const op = ops[0];

  assert.equal(op.op, "update", "an edit went out as an append — a no-op edit");
  assert.equal(op.id, "w-1", "an update must reuse the EXISTING txn id");
  // An update REPLACES the row, so it carries the append's sign rule, not the
  // void's negation. Getting this wrong flips an expense into income.
  assert.equal(op.cent, -25000, "expense must reach the sheet negative");
  assert.equal(op.note, "kape + pandesal");
  assert.equal(op.kind, "expense");
  assert.equal(op.monthKey, "2026-07");
  assert.equal(op.categoryId, "coffee");

  // The outbox drained — the server named the id, so it was cleared.
  assert.deepEqual(await idb.getOutbox(), []);
});

test("W2 append and void still map as before, and the kind whitelist holds", async () => {
  await idb.addTxn({
    id: "w-2",
    monthKey: "2026-07",
    ts: 1783656000000,
    cent: 500000,
    categoryId: "save",
    note: "gift",
    kind: "withdrawal",
  });
  sync.kick({ force: true });
  await settle();

  const appended = opsFor("w-2").at(-1);
  assert.equal(appended.op, "append");
  assert.equal(
    appended.kind,
    "withdrawal",
    "the kind whitelist dropped a kind",
  );
  assert.equal(appended.cent, 500000, "only an expense is negated");

  // Edit it, then void it: three different verbs off the same id.
  await idb.updateTxn("w-2", { cent: 400000 }, open);
  sync.kick({ force: true });
  await settle();
  assert.equal(opsFor("w-2").at(-1).op, "update");
  assert.equal(opsFor("w-2").at(-1).cent, 400000);

  await idb.voidTxn("w-2");
  sync.kick({ force: true });
  await settle();
  const voided = opsFor("w-2").at(-1);
  assert.equal(voided.op, "void");
  assert.equal(voided.cent, -400000, "a void must negate the CURRENT amount");

  // An unknown kind still lands as expense rather than reaching the sheet raw.
  await idb.addTxn({
    id: "w-3",
    monthKey: "2026-07",
    cent: 100,
    kind: "nonsense",
  });
  sync.kick({ force: true });
  await settle();
  assert.equal(opsFor("w-3").at(-1).kind, "expense");
});

test("W3 the transport rails the CORS note depends on are unchanged", async () => {
  const { init } = sent.at(-1);
  assert.equal(init.method, "POST");
  // text/plain keeps this a SIMPLE request. application/json triggers a
  // preflight that Apps Script cannot answer, and the fetch fails before the
  // script ever runs. See the block comment at the top of js/sync.js.
  assert.equal(init.headers["Content-Type"], "text/plain;charset=utf-8");
  assert.equal(init.credentials, "omit");
  assert.equal(init.redirect, "follow");
  assert.equal(sent.at(-1).body.v, 1);
});

test("W4 a junk outbox verb degrades to 'append', never to a function", async () => {
  // The verb map is keyed by a value that reached storage, so 'constructor'
  // and friends must not resolve off Object.prototype and put a FUNCTION in
  // the op field. Corrupt the fallback blob directly to force the case.
  const KEY = "mn.idbfallback.v1";
  const blob = JSON.parse(localStorage.getItem(KEY));
  blob.txns.push({
    id: "w-x",
    monthKey: "2026-07",
    ts: 1783656000000,
    cent: 100,
    categoryId: "food",
    note: "",
    kind: "expense",
    synced: 0,
    deleted: 0,
  });
  for (const bad of [
    "constructor",
    "toString",
    "__proto__",
    "hasOwnProperty",
  ]) {
    blob.outbox.push({
      id: `w-x-${bad}`,
      op: bad,
      ts: Date.now(),
      seq: 1,
      txn: { ...blob.txns.at(-1), id: `w-x-${bad}` },
    });
  }
  localStorage.setItem(KEY, JSON.stringify(blob));

  reply = (body) => ({
    ok: true,
    accepted: body.ops.map((o) => o.id),
    duplicates: [],
    rejected: [],
    rows: body.ops.length,
  });
  sync.kick({ force: true });
  await settle();

  for (const bad of [
    "constructor",
    "toString",
    "__proto__",
    "hasOwnProperty",
  ]) {
    const op = opsFor(`w-x-${bad}`).at(-1);
    assert.ok(op, `${bad} was never sent`);
    assert.equal(typeof op.op, "string", `${bad} put a non-string in op`);
    assert.equal(op.op, "append", `${bad} did not degrade to append`);
  }
});

test("W5 an op the server did NOT name stays queued", async () => {
  await idb.addTxn({
    id: "w-4",
    monthKey: "2026-07",
    cent: 700,
    categoryId: "food",
  });
  await idb.updateTxn("w-4", { cent: 800 }, open);

  reply = () => ({
    ok: true,
    accepted: [],
    duplicates: [],
    rejected: [],
    rows: 0,
  });
  sync.kick({ force: true });
  await settle();

  const out = await idb.getOutbox();
  const row = out.find((o) => o.id === "w-4");
  assert.ok(row, "an un-acked update was cleared from the outbox");
  assert.equal(row.op, "update");
  assert.equal(row.txn.cent, 800);
});
