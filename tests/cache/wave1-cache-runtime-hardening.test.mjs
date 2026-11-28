import assert from 'node:assert/strict';
import test from 'node:test';

import { Backend } from '../../js/backend.js';
import { AnalysisResumeStore } from '../../js/cache/analysis-resume.js';
import { DeltaSessionStore } from '../../js/cache/delta-session.js';
import {
  HexDbOpfsBackend,
  OPFS_CHECKPOINT_SLOT_SIZE,
  encodeCheckpointSlot,
} from '../../js/cache/hexdb/hexdb-opfs.js';
import {
  HexDbIdbBackend,
  IDB_DB_VERSION,
  IDB_STORE_META,
  IDB_STORE_SHARDS,
  IDB_STORE_WAL,
} from '../../js/cache/hexdb/hexdb-idb.js';
import { HexDbWorkerHost } from '../../js/cache/hexdb/hexdb-worker.js';
import { MemoryBudget, MEMORY_CATEGORY_HEXDB } from '../../js/core/budgets/memory-budget.js';
import { KnowledgeDB } from '../../js/knowledge/index.js';
import { RemoteCanonicalHttpTransport } from '../../js/collaboration/remote-transport.js';
import {
  createManagedCallSiteId,
  queryManagedRuntimeProvider,
  queryManagedSymbolicVerification,
} from '../../js/managed/index.js';
import { FakeSolverBackend } from '../../js/symbolic/solver/fake-backend.js';

// ---------------------------------------------------------------------------
// Helpers: In-memory SyncAccessHandle / OPFS & IndexedDB mocks
// ---------------------------------------------------------------------------

function createMockOpfsDir({ failOnWrite = null } = {}) {
  const files = new Map();
  const makeSyncHandle = (name) => {
    if (!files.has(name)) files.set(name, new Uint8Array(0));
    let closed = false;
    return {
      getSize() {
        return files.get(name).byteLength;
      },
      read(buf, { at = 0 } = {}) {
        const cur = files.get(name);
        const avail = Math.max(0, Math.min(buf.byteLength, cur.byteLength - at));
        if (avail > 0) buf.set(cur.subarray(at, at + avail), 0);
        return avail;
      },
      write(data, { at = 0 } = {}) {
        if (typeof failOnWrite === 'function') failOnWrite(name, data, at);
        const bytes = data instanceof Uint8Array
          ? data
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const cur = files.get(name);
        const needed = at + bytes.byteLength;
        let next = cur;
        if (needed > cur.byteLength) {
          next = new Uint8Array(needed);
          next.set(cur, 0);
        }
        next.set(bytes, at);
        files.set(name, next);
        return bytes.byteLength;
      },
      truncate(size) {
        const cur = files.get(name);
        if (size <= cur.byteLength) {
          files.set(name, cur.slice(0, size));
        } else {
          const next = new Uint8Array(size);
          next.set(cur, 0);
          files.set(name, next);
        }
      },
      flush() {},
      close() {
        closed = true;
      },
      get closed() {
        return closed;
      },
    };
  };

  const makeDir = (prefix = '') => ({
    async getDirectoryHandle(name) {
      return makeDir(`${prefix}${name}/`);
    },
    async getFileHandle(name) {
      const key = `${prefix}${name}`;
      return {
        async createSyncAccessHandle() {
          return makeSyncHandle(key);
        },
      };
    },
  });

  return { root: makeDir(''), files };
}

function createMockIndexedDB({ supportIndex = true, initialVersion = 0, prefillShards = [] } = {}) {
  const stores = new Map();
  const indexes = new Map();
  let currentVersion = initialVersion;
  const openDbs = [];
  let indexGetAllCalls = 0;
  let storeGetAllCalls = 0;

  if (initialVersion >= 1) {
    stores.set(IDB_STORE_SHARDS, new Map(prefillShards.map((r) => [r.id, r])));
    stores.set(IDB_STORE_WAL, new Map());
    stores.set(IDB_STORE_META, new Map());
    indexes.set(IDB_STORE_SHARDS, new Set());
  }

  function makeReq(executor) {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
    queueMicrotask(() => executor(req));
    return req;
  }

  function makeStoreHandle(name) {
    const map = stores.get(name) || new Map();
    const idxSet = indexes.get(name) || new Set();
    const handle = {
      indexNames: {
        contains: (idxName) => idxSet.has(idxName),
      },
      createIndex: supportIndex
        ? (idxName) => {
            idxSet.add(idxName);
            indexes.set(name, idxSet);
          }
        : undefined,
      get: (key) => makeReq((r) => { r.result = map.get(key); r.onsuccess?.(); }),
      put: (val) => makeReq((r) => {
        const key = val.id ?? val.binaryKey ?? val.deltaKey;
        map.set(key, structuredClone(val));
        r.result = key;
        r.onsuccess?.();
      }),
      delete: (key) => makeReq((r) => { map.delete(key); r.onsuccess?.(); }),
      getAll: () => makeReq((r) => {
        storeGetAllCalls += 1;
        r.result = [...map.values()].map((v) => structuredClone(v));
        r.onsuccess?.();
      }),
    };
    if (supportIndex) {
      handle.index = (idxName) => {
        if (!idxSet.has(idxName)) throw new Error(`Missing index: ${idxName}`);
        return {
          getAll: (query) => makeReq((r) => {
            indexGetAllCalls += 1;
            r.result = [...map.values()]
              .filter((v) => v[idxName] === query)
              .map((v) => structuredClone(v));
            r.onsuccess?.();
          }),
        };
      };
    }
    return handle;
  }

  const factory = {
    open(_name, version) {
      const req = { result: null, error: null, transaction: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      queueMicrotask(() => {
        const db = {
          closed: false,
          onversionchange: null,
          objectStoreNames: { contains: (s) => stores.has(s) },
          createObjectStore(s) {
            if (!stores.has(s)) stores.set(s, new Map());
            if (!indexes.has(s)) indexes.set(s, new Set());
            return makeStoreHandle(s);
          },
          transaction() {
            const tx = {
              oncomplete: null,
              onerror: null,
              onabort: null,
              objectStore: (s) => makeStoreHandle(s),
            };
            queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
            return tx;
          },
          close() {
            this.closed = true;
          },
        };
        if (version > currentVersion) {
          for (const prev of openDbs) {
            if (!prev.closed) prev.onversionchange?.();
          }
          req.result = db;
          req.transaction = { objectStore: (s) => makeStoreHandle(s) };
          req.onupgradeneeded?.();
          currentVersion = version;
        } else {
          req.result = db;
        }
        openDbs.push(db);
        req.onsuccess?.();
      });
      return req;
    },
  };

  return {
    factory,
    openDbs,
    stores,
    indexes,
    stats: () => ({ indexGetAllCalls, storeGetAllCalls }),
  };
}

// ---------------------------------------------------------------------------
// 1. js/backend.js — Worker crash identity guard, handler detach, respawn
// ---------------------------------------------------------------------------

test('backend: crashed worker detaches handlers, terminates, clears ref, and ignores stale worker errors', () => {
  const backend = new Backend();
  const fatals = [];
  backend.onFatal = (msg) => fatals.push(msg);

  const makeFakeWorker = () => ({
    terminated: 0,
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage() {},
    terminate() { this.terminated += 1; },
  });

  const w1 = makeFakeWorker();
  const w2 = makeFakeWorker();
  backend.legacyWorker = w1;
  const staleHandler = w1.onerror;

  // Replace with newer worker before stale worker fires error
  backend.legacyWorker = w2;
  staleHandler({ message: 'stale crash' });
  assert.equal(w1.terminated, 0, 'stale worker error must not terminate anything');
  assert.equal(backend.legacyWorker, w2, 'stale worker error must not clear active worker');
  assert.equal(fatals.length, 0, 'stale worker error must not trigger onFatal');

  // Active worker crashes
  w2.onerror({ message: 'active crash' });
  assert.equal(w2.terminated, 1);
  assert.equal(w2.onmessage, null);
  assert.equal(w2.onerror, null);
  assert.equal(w2.onmessageerror, null);
  assert.equal(backend.legacyWorker, null);
  assert.equal(fatals.length, 1);

  // Platform worker crash behaves identically
  const pw = makeFakeWorker();
  backend.platformWorker = pw;
  pw.onmessageerror({ message: 'platform messageerror' });
  assert.equal(pw.terminated, 1);
  assert.equal(pw.onmessage, null);
  assert.equal(pw.onerror, null);
  assert.equal(pw.onmessageerror, null);
  assert.equal(backend.platformWorker, null);
  assert.equal(fatals.length, 2);
});

// ---------------------------------------------------------------------------
// 2. js/cache/analysis-resume.js — saveLastFile cleans up superseded sessions only on success
// ---------------------------------------------------------------------------

test('analysis-resume: saveLastFile deletes superseded binary sessions only when saved with explicit binaryId', async () => {
  const store = new AnalysisResumeStore();
  const kv = new Map();
  const deleted = [];
  let allowSave = true;

  store.get = async (k) => kv.get(k) ?? null;
  store.putMany = async (entries) => {
    if (!allowSave) return false;
    for (const [k, v] of entries) kv.set(k, v);
    return true;
  };
  store.requestPersistentStorage = async () => true;
  store.deleteSessionsForBinary = async (id) => {
    deleted.push(id);
    return true;
  };

  const fakeFile = { name: 'a.bin', size: 4, type: 'application/octet-stream', lastModified: 1, slice: () => new Uint8Array([1, 2, 3, 4]) };
  await store.saveLastFile(fakeFile, { binaryId: 'bin-old' });
  assert.deepEqual(deleted, []);

  // Failed save must NOT delete superseded binary sessions
  allowSave = false;
  const failRes = await store.saveLastFile(fakeFile, { binaryId: 'bin-new' });
  assert.equal(failRes, false);
  assert.deepEqual(deleted, []);

  // Successful save with new binaryId cleans up bin-old
  allowSave = true;
  const okRes = await store.saveLastFile(fakeFile, { binaryId: 'bin-new' });
  assert.equal(okRes, true);
  assert.deepEqual(deleted, ['bin-old']);
});

// ---------------------------------------------------------------------------
// 3. js/cache/delta-session.js — IDB save & prune clear stale localStorage entries
// ---------------------------------------------------------------------------

test('delta-session: _saveIndexedDB clears stale localStorage entry and pruned keys', async () => {
  const lsMap = new Map();
  const localStorage = {
    getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
    setItem: (k, v) => lsMap.set(k, String(v)),
    removeItem: (k) => lsMap.delete(k),
  };

  // Start without IDB so save lands in localStorage
  const store = new DeltaSessionStore({ indexedDB: null, localStorage, maxRecents: 2 });
  const mkPayload = (name, updatedAt) => ({
    updatedAt,
    fingerprint: { name, size: 16, format: 'Mach-O', architecture: 'arm64' },
    renames: { '0x1000': name },
  });

  await store.save('k1', mkPayload('old_ls', 1000));
  assert.ok(lsMap.has(store._lsKey('k1')), 'k1 must exist in localStorage fallback');

  // Now attach mock IDB and save newer k1, then k2, k3 to trigger prune of k1
  const idb = createMockIndexedDB({ supportIndex: true });
  store.indexedDB = idb.factory;
  store._db = null;
  store._dbPromise = null;

  await store.save('k1', mkPayload('new_idb', 2000));
  assert.equal(lsMap.has(store._lsKey('k1')), false, 'IDB save must remove stale localStorage key');
  const loaded = await store.load('k1');
  assert.equal(loaded.fingerprint.name, 'new_idb');

  // Put stale k2 in localStorage and prune k1/k2 via maxRecents = 2
  lsMap.set(store._lsKey('k2'), JSON.stringify({ format: 'hex-delta-session', version: 1, updatedAt: 1500, renames: {} }));
  await store.save('k2', mkPayload('fn2', 2100));
  await store.save('k3', mkPayload('fn3', 2200));
  await store.save('k4', mkPayload('fn4', 2300));
  assert.equal(lsMap.has(store._lsKey('k2')), false, 'pruned key must not survive in localStorage');
});

// ---------------------------------------------------------------------------
// 4. js/cache/hexdb/hexdb-opfs.js — meta overflow, atomic WAL+memory rollback, no rollback on checkpoint failure
// ---------------------------------------------------------------------------

test('hexdb-opfs: encodeCheckpointSlot throws HEXDB_CHECKPOINT_META_OVERFLOW instead of truncating', () => {
  const hugeShards = Array.from({ length: 400 }, (_, i) => `shard_with_very_long_name_${i}_abcdefghij`);
  assert.throws(
    () => encodeCheckpointSlot({ generation: 1, checkpointLsn: 1, shardNames: hugeShards, binaryKey: 'bin' }),
    (err) => err?.code === 'HEXDB_CHECKPOINT_META_OVERFLOW' && /HEXDB_CHECKPOINT_META_OVERFLOW/.test(err.message),
  );
  assert.ok(OPFS_CHECKPOINT_SLOT_SIZE === 4096);
});

test('hexdb-opfs: _checkpointUnlocked fails closed on meta overflow before flushing shards', async () => {
  const opfs = createMockOpfsDir();
  const backend = new HexDbOpfsBackend({
    rootDir: opfs.root,
    binaryKey: 'b'.repeat(4080),
    walMaxBytes: 1024 * 1024,
  });
  await backend.open();
  await backend.put('s1', 'k1', new Uint8Array([1, 2, 3]));
  assert.equal(opfs.files.has('hexdb/b'.slice(0, 1)), false);
  await assert.rejects(
    () => backend.checkpoint(),
    (err) => err?.code === 'HEXDB_CHECKPOINT_META_OVERFLOW',
  );
  // Dirty shard file must not have been written to disk
  const shardFiles = [...opfs.files.keys()].filter((k) => k.endsWith('/s1.hdb'));
  assert.equal(shardFiles.length, 0, 'no shard file should be flushed when checkpoint metadata overflows');
  await backend.close();
});

test('hexdb-opfs: batch rolls back memory and WAL atomically on mid-batch WAL write failure', async () => {
  let walWrites = 0;
  let failNextWal = false;
  const opfs = createMockOpfsDir({
    failOnWrite(name) {
      if (name.endsWith('delta_wal.hdb')) {
        walWrites += 1;
        if (failNextWal) throw new Error('INJECTED_WAL_IO_ERROR');
      }
    },
  });
  const backend = new HexDbOpfsBackend({
    rootDir: opfs.root,
    binaryKey: 'rollback-test',
    walMaxBytes: 1024 * 1024,
  });
  await backend.open();
  await backend.put('s1', 'existing', new Uint8Array([9, 9]));
  const walBefore = opfs.files.get('hex-db-v1/rollback-test/delta_wal.hdb').byteLength;
  const statsBefore = await backend.stats();

  let calls = 0;
  const origAppendPut = backend._wal.appendPut.bind(backend._wal);
  backend._wal.appendPut = (...args) => {
    calls += 1;
    if (calls === 2) {
      failNextWal = true;
    }
    return origAppendPut(...args);
  };

  await assert.rejects(
    () => backend.batch([
      { op: 'put', shard: 's1', key: 'k1', value: new Uint8Array([1, 2, 3]) },
      { op: 'put', shard: 's2', key: 'k2', value: new Uint8Array([4, 5, 6]) },
    ]),
    /INJECTED_WAL_IO_ERROR/,
  );
  failNextWal = false;

  assert.equal(await backend.get('s1', 'k1'), null, 'rolled-back key k1 must not exist in memory');
  assert.equal(await backend.get('s2', 'k2'), null, 'rolled-back shard s2 must not exist in memory');
  assert.deepEqual(await backend.get('s1', 'existing'), new Uint8Array([9, 9]));
  const statsAfter = await backend.stats();
  assert.equal(statsAfter.totalBytes, statsBefore.totalBytes);
  assert.equal(opfs.files.get('hex-db-v1/rollback-test/delta_wal.hdb').byteLength, walBefore);
  assert.ok(walWrites >= 2);
  await backend.close();
});

test('hexdb-opfs: checkpoint failure after put does NOT roll back committed WAL/memory mutation', async () => {
  const opfs = createMockOpfsDir();
  const backend = new HexDbOpfsBackend({
    rootDir: opfs.root,
    binaryKey: 'cp-fail-test',
    walMaxBytes: 16, // force compaction on first put
  });
  await backend.open();
  backend._checkpointUnlocked = async () => {
    throw new Error('INJECTED_CHECKPOINT_FAILURE');
  };

  await assert.rejects(
    () => backend.put('s1', 'committed', new Uint8Array([7, 8, 9])),
    /INJECTED_CHECKPOINT_FAILURE/,
  );
  // Mutation was already appended to WAL and applied to memory before checkpoint ran
  assert.deepEqual(await backend.get('s1', 'committed'), new Uint8Array([7, 8, 9]));
  await backend.close();
});

// ---------------------------------------------------------------------------
// 5. js/cache/hexdb/hexdb-idb.js — v1->v2 migration, index query, fallback, onblocked/onversionchange
// ---------------------------------------------------------------------------

test('hexdb-idb: v1->v2 migration creates binaryKey index, uses it on open, and handles onversionchange', async () => {
  assert.equal(IDB_DB_VERSION, 2);
  const mock = createMockIndexedDB({
    supportIndex: true,
    initialVersion: 1,
    prefillShards: [
      { id: 'binA::s1::k1', binaryKey: 'binA', shard: 's1', key: 'k1', value: new Uint8Array([1, 2]) },
      { id: 'binB::s1::k1', binaryKey: 'binB', shard: 's1', key: 'k1', value: new Uint8Array([3, 4]) },
    ],
  });

  const backend = new HexDbIdbBackend({ indexedDB: mock.factory, binaryKey: 'binA' });
  await backend.open();
  assert.ok(mock.indexes.get(IDB_STORE_SHARDS).has('binaryKey'), 'v2 upgrade must create binaryKey index');
  assert.equal(mock.stats().indexGetAllCalls, 1, 'open() must query via binaryKey index when available');
  assert.deepEqual(await backend.get('s1', 'k1'), new Uint8Array([1, 2]));
  assert.equal(typeof mock.openDbs[0].onversionchange, 'function');
  mock.openDbs[0].onversionchange();
  assert.equal(mock.openDbs[0].closed, true);
});

test('hexdb-idb: falls back to full getAll on mock IDB without index support and rejects onblocked', async () => {
  const mock = createMockIndexedDB({
    supportIndex: false,
    initialVersion: 1,
    prefillShards: [
      { id: 'binA::s1::k1', binaryKey: 'binA', shard: 's1', key: 'k1', value: new Uint8Array([5]) },
    ],
  });
  const backend = new HexDbIdbBackend({ indexedDB: mock.factory, binaryKey: 'binA' });
  await backend.open();
  assert.equal(mock.stats().storeGetAllCalls, 1);
  assert.deepEqual(await backend.get('s1', 'k1'), new Uint8Array([5]));

  const blockedFactory = {
    open() {
      const req = { onblocked: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => req.onblocked?.());
      return req;
    },
  };
  const blockedBackend = new HexDbIdbBackend({ indexedDB: blockedFactory, binaryKey: 'binA' });
  await assert.rejects(() => blockedBackend.open(), /HEXDB_IDB_OPEN_BLOCKED/);
});

// ---------------------------------------------------------------------------
// 6. js/cache/hexdb/hexdb-worker.js — close() and dispose() reset memory budget
// ---------------------------------------------------------------------------

test('hexdb-worker: close() and dispose() reset MEMORY_CATEGORY_HEXDB usage to 0', async () => {
  const budget = new MemoryBudget({ totalCapBytes: 64 * 1024 * 1024 });
  const host = new HexDbWorkerHost({ memoryBudget: budget });

  budget.setUsage(MEMORY_CATEGORY_HEXDB, 4096);
  assert.equal(budget.getSnapshot().categories[MEMORY_CATEGORY_HEXDB], 4096);
  await host.dispatch('close', {});
  assert.equal(budget.getSnapshot().categories[MEMORY_CATEGORY_HEXDB], 0);

  budget.setUsage(MEMORY_CATEGORY_HEXDB, 8192);
  await host.dispose();
  assert.equal(budget.getSnapshot().categories[MEMORY_CATEGORY_HEXDB], 0);
});

// ---------------------------------------------------------------------------
// 7. js/knowledge/index.js — onblocked & onversionchange handling
// ---------------------------------------------------------------------------

test('knowledge: #dbOpen handles onblocked (clears promise & rejects) and onversionchange (closes & resets)', async () => {
  let attempt = 0;
  let openedDb = null;
  const fakeIdb = {
    open() {
      attempt += 1;
      const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      queueMicrotask(() => {
        if (attempt === 1) {
          req.onblocked?.();
          return;
        }
        openedDb = {
          closed: false,
          onversionchange: null,
          close() { this.closed = true; },
          transaction() {
            const tx = {
              oncomplete: null,
              onerror: null,
              onabort: null,
              objectStore: () => ({
                put: () => {
                  const r = { onsuccess: null, onerror: null };
                  queueMicrotask(() => r.onsuccess?.());
                  return r;
                },
              }),
            };
            queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
            return tx;
          },
        };
        req.result = openedDb;
        req.onsuccess?.();
      });
      return req;
    },
  };

  const kdb = new KnowledgeDB({ indexedDB: fakeIdb });
  await assert.rejects(() => kdb.remember({ name: 'foo', address: 0x1000 }), /blocked/i);
  assert.equal(kdb._dbOpenPromise, null, 'onblocked must clear _dbOpenPromise so subsequent calls can retry');

  await kdb.remember({ name: 'foo', address: 0x1000 });
  assert.ok(openedDb && typeof openedDb.onversionchange === 'function');
  openedDb.onversionchange();
  assert.equal(openedDb.closed, true);
  assert.equal(kdb._db, null);
  assert.equal(kdb._dbOpenPromise, null);
});

// ---------------------------------------------------------------------------
// 8. js/collaboration/remote-transport.js — reader.releaseLock() always runs
// ---------------------------------------------------------------------------

test('collaboration: RemoteCanonicalHttpTransport releases response reader lock on budget overflow', async () => {
  let released = 0;
  let cancelled = 0;
  const oversizedChunk = new Uint8Array(64).fill(65);
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() { return { done: false, value: oversizedChunk }; },
          async cancel() { cancelled += 1; },
          releaseLock() { released += 1; },
        };
      },
    },
  });

  const ed25519 = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const transport = new RemoteCanonicalHttpTransport({
    endpoint: 'https://collab.example.test/v1/sync',
    serverVerificationKey: ed25519.publicKey,
    sessionEncryptionKey: aesKey,
    serverKeyId: 'srv-key-1',
    fetchImpl,
    maxResponseBytes: 32,
  });

  await assert.rejects(
    () => transport.authorizeEnvelope({
      schemaVersion: 'hex-remote-collaboration-envelope/v1',
      projectIdentity: 'proj-1',
      binaryIdentity: 'bin-1',
      sessionIdentity: 'sess-1',
      actorIdentity: 'actor-1',
      deviceIdentity: 'dev-1',
      messageId: 'msg-1',
      sequence: 1,
      egress: { derivedDataOnly: true, userAuthorized: true, rawBinaryBytes: false },
      operations: [{ targetEntityId: 'fn:1', factKind: 'name', action: 'set', payload: 'renamed_fn' }],
    }),
    /remote-transport-response-budget-exceeded/,
  );
  assert.equal(cancelled, 1);
  assert.equal(released, 1, 'reader.releaseLock() must be called in finally');
});

// ---------------------------------------------------------------------------
// 9. js/managed/shared/bridge.js & js/managed/index.js — shallow freeze & createManagedCallSiteId
// ---------------------------------------------------------------------------

test('managed: connected wrappers are shallow-frozen so session.dispose() works, and createManagedCallSiteId is exported', () => {
  assert.equal(typeof createManagedCallSiteId, 'function');
  const callSiteId = createManagedCallSiteId('method_1', 12);
  assert.ok(typeof callSiteId === 'string' && callSiteId.length > 0);

  const backend = new FakeSolverBackend();
  const symRes = queryManagedSymbolicVerification('method_1', { backend, formulas: ['x > 0'] });
  assert.equal(symRes.status, 'connected');
  assert.equal(Object.isFrozen(symRes), true, 'connected wrapper itself must be frozen');
  assert.equal(Object.isFrozen(symRes.session), false, 'live session must not be deep-frozen');
  assert.doesNotThrow(() => symRes.session.dispose());

  const liveProvider = { id: 'prov-1', state: 'open', close() { this.state = 'closed'; } };
  const rtRes = queryManagedRuntimeProvider('method_1', {
    provider: liveProvider,
    moduleEvidence: { id: 'ev-1' },
  });
  assert.equal(rtRes.status, 'connected');
  assert.equal(Object.isFrozen(rtRes), true);
  assert.equal(Object.isFrozen(rtRes.provider), false);
  rtRes.provider.close();
  assert.equal(liveProvider.state, 'closed');
});

// ---------------------------------------------------------------------------
// Gate 2 hardening regressions: pure worker getters, IDB settled/versionchange,
// OPFS rollback error preservation, and worker close() budget reset on failure
// ---------------------------------------------------------------------------
test('backend: getter does not auto-respawn worker after crash even when global Worker exists', async () => {
  const prevWorker = globalThis.Worker;
  let constructed = 0;
  class FakeWorker {
    constructor() {
      constructed++;
      this.terminated = false;
      this.onmessage = null;
      this.onerror = null;
      this.onmessageerror = null;
    }
    postMessage() {}
    terminate() { this.terminated = true; }
  }
  globalThis.Worker = FakeWorker;
  try {
    const b = new Backend();
    const first = b._worker('legacy');
    assert.equal(constructed, 1);
    first.onerror({ message: 'boom' });
    assert.equal(first.terminated, true);
    // Pure getter must return null and MUST NOT spawn a new Worker
    assert.equal(b.legacyWorker, null);
    assert.equal(constructed, 1);
    // Explicit _worker('legacy') respawns cleanly
    const second = b._worker('legacy');
    assert.equal(constructed, 2);
    assert.notEqual(second, first);
    b.dispose();
  } finally {
    if (prevWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = prevWorker;
  }
});

test('hexdb-idb: onversionchange resets _db/_open to fail closed, and late onsuccess after onblocked closes db', async () => {
  let lateClosed = false;
  let lateReq = null;
  const blockedFactory = {
    open() {
      const req = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      lateReq = req;
      queueMicrotask(() => req.onblocked?.());
      return req;
    },
  };
  const b1 = new HexDbIdbBackend({ indexedDB: blockedFactory, binaryKey: 'bin-late' });
  await assert.rejects(() => b1.open(), /HEXDB_IDB_OPEN_BLOCKED/);
  // Late onsuccess fires after onblocked: must close db immediately
  lateReq.result = { close() { lateClosed = true; } };
  lateReq.onsuccess();
  assert.equal(lateClosed, true);

  // onversionchange closes db AND resets _db/_open so subsequent put() fails closed with HEXDB_NOT_OPEN
  let versionClosed = false;
  let capturedDb = null;
  const okFactory = {
    open() {
      const req = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => {
        const store = {
          indexNames: { contains: () => false },
          getAll: () => {
            const r = { result: [], onsuccess: null, onerror: null };
            queueMicrotask(() => r.onsuccess?.());
            return r;
          },
          get: () => {
            const r = { result: null, onsuccess: null, onerror: null };
            queueMicrotask(() => r.onsuccess?.());
            return r;
          },
        };
        const db = {
          objectStoreNames: { contains: () => true },
          onversionchange: null,
          close() { versionClosed = true; },
          transaction() { return { objectStore: () => store, oncomplete: null, onerror: null, onabort: null }; },
        };
        capturedDb = db;
        req.result = db;
        req.onsuccess?.();
      });
      return req;
    },
  };
  const b2 = new HexDbIdbBackend({ indexedDB: okFactory, binaryKey: 'bin-vc' });
  await b2.open();
  capturedDb.onversionchange();
  assert.equal(versionClosed, true);
  assert.equal(b2._db, null);
  assert.equal(b2._open, false);
  await assert.rejects(() => b2.put('s', 'k', new Uint8Array([1])), /HEXDB_NOT_OPEN/);
});

test('hexdb-opfs: _rollbackMutation preserves original write error even if WAL restoreState throws', async () => {
  const opfs = new HexDbOpfsBackend('bin-opfs-err');
  opfs._open = true;
  opfs._shards = new Map();
  opfs._totalBytes = 0;
  opfs._dirtyShards = new Set();
  opfs._walHandle = { flush() {} };
  opfs._wal = {
    snapshotState() { return { byteLength: 0, chunkCount: 0, frameCount: 0, lastLsn: 0, lastCheckpointLsn: 0 }; },
    appendPut() { throw new Error('ORIGINAL_WRITE_ERROR'); },
    restoreState() { throw new Error('SECONDARY_TRUNCATE_ERROR'); },
    needsCompaction() { return false; },
  };
  await assert.rejects(() => opfs.put('s1', 'k1', new Uint8Array([1, 2, 3])), /ORIGINAL_WRITE_ERROR/);
});

test('hexdb-worker: close() and dispose() still reset MEMORY_CATEGORY_HEXDB to 0 when backend.close() rejects', async () => {
  const budget = new MemoryBudget({ softCapBytes: 1024 * 1024, hardCapBytes: 2 * 1024 * 1024, emergencyCapBytes: 3 * 1024 * 1024 });
  const worker = new HexDbWorkerHost({ memoryBudget: budget });
  budget.setUsage(MEMORY_CATEGORY_HEXDB, 4096);
  worker._backend = { async close() { throw new Error('CLOSE_BOOM'); } };
  await assert.rejects(() => worker.dispatch('close', {}), /CLOSE_BOOM/);
  assert.equal(worker._backend, null);
  assert.equal(budget.getSnapshot().categories[MEMORY_CATEGORY_HEXDB], 0);

  budget.setUsage(MEMORY_CATEGORY_HEXDB, 8192);
  worker._backend = { async close() { throw new Error('DISPOSE_BOOM'); } };
  await assert.rejects(() => worker.dispose(), /DISPOSE_BOOM/);
  assert.equal(worker._backend, null);
  assert.equal(budget.getSnapshot().categories[MEMORY_CATEGORY_HEXDB], 0);
});

test('knowledge: late onsuccess after onblocked closes leaked db without clobbering _db', async () => {
  let leakedClosed = false;
  let capturedReq = null;
  const fakeIDB = {
    open() {
      const req = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      capturedReq = req;
      queueMicrotask(() => req.onblocked?.());
      return req;
    },
  };
  const kdb = new KnowledgeDB({ indexedDB: fakeIDB, dbName: 'test-late-onsuccess' });
  await assert.rejects(() => kdb.remember({ name: 'foo', address: 0x1000 }), /blocked/i);
  capturedReq.result = { close() { leakedClosed = true; } };
  capturedReq.onsuccess();
  assert.equal(leakedClosed, true);
  assert.equal(kdb._db, null);
});
