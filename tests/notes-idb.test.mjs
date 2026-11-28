import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTES_IDB_NAME,
  NOTES_STORE_ENTRIES,
  NOTES_STORE_META,
  NOTES_STORE_PROJECTS,
  NOTES_INDEX_BY_STORE,
  isNotesIdbAvailable,
  normalizeNotesIdbError,
  NotesIdbBackend,
} from '../js/platform/notes-idb.js';

/**
 * In-memory IndexedDB mock supporting:
 * - open / onupgradeneeded / onsuccess / onerror
 * - createObjectStore / createIndex / objectStoreNames / indexNames
 * - transaction (readonly/readwrite) / oncomplete / onerror / onabort
 * - get / put / delete / index().getAll()
 * - QuotaExceededError and generic IDB error injection
 * - transaction counter & active-overlap detection (to verify single-writer serialization)
 */
function createMockIndexedDB({ failQuotaOnPut = false, failErrorOnOpen = null, failPutAfter = Infinity } = {}) {
  const databases = new Map();
  const stats = {
    txCount: 0,
    writeTxCount: 0,
    activeWriteTxs: 0,
    maxConcurrentWriteTxs: 0,
    puts: 0,
    deletes: 0,
    failQuotaOnPut,
    failErrorOnOpen,
    failPutAfter,
  };

  function keyToString(keyPath, recordOrKey) {
    if (Array.isArray(keyPath)) {
      const tuple = Array.isArray(recordOrKey)
        ? recordOrKey
        : keyPath.map((k) => recordOrKey[k]);
      return JSON.stringify(tuple);
    }
    if (recordOrKey && typeof recordOrKey === 'object' && keyPath in recordOrKey) {
      return String(recordOrKey[keyPath]);
    }
    return String(recordOrKey);
  }

  function cloneValue(val) {
    if (val == null || typeof val !== 'object') return val;
    return structuredClone(val);
  }

  class MockDOMStringList {
    constructor(set) { this._set = set; }
    contains(name) { return this._set.has(name); }
    get length() { return this._set.size; }
  }

  class MockObjectStoreDef {
    constructor(name, keyPath) {
      this.name = name;
      this.keyPath = keyPath;
      this.records = new Map();
      this.indexes = new Map();
    }
  }

  class MockRequest {
    constructor() {
      this.result = undefined;
      this.error = null;
      this.onsuccess = null;
      this.onerror = null;
    }
  }

  function makeQuotaError() {
    const err = new Error('The quota has been exceeded.');
    err.name = 'QuotaExceededError';
    err.code = 22;
    return err;
  }

  function createDatabaseWrapper(dbState) {
    const db = {
      name: dbState.name,
      version: dbState.version,
      onversionchange: null,
      get objectStoreNames() {
        return new MockDOMStringList(new Set(dbState.stores.keys()));
      },
      createObjectStore(name, { keyPath }) {
        const def = new MockObjectStoreDef(name, keyPath);
        dbState.stores.set(name, def);
        return {
          get indexNames() { return new MockDOMStringList(new Set(def.indexes.keys())); },
          createIndex(indexName, indexKeyPath) {
            def.indexes.set(indexName, indexKeyPath);
          },
        };
      },
      transaction(storeNames, mode = 'readonly') {
        const names = Array.isArray(storeNames) ? storeNames : [storeNames];
        stats.txCount++;
        const isWrite = mode === 'readwrite';
        if (isWrite) {
          stats.writeTxCount++;
          stats.activeWriteTxs++;
          if (stats.activeWriteTxs > stats.maxConcurrentWriteTxs) {
            stats.maxConcurrentWriteTxs = stats.activeWriteTxs;
          }
        }

        // Take a rollback snapshot for write transactions so abort restores state cleanly.
        const rollbackSnapshots = new Map();
        if (isWrite) {
          for (const n of names) {
            const def = dbState.stores.get(n);
            if (def) {
              rollbackSnapshots.set(n, new Map([...def.records.entries()].map(([k, v]) => [k, cloneValue(v)])));
            }
          }
        }

        let pendingOps = 0;
        let finished = false;
        let failedError = null;
        let scheduledFinalize = false;

        const tx = {
          mode,
          error: null,
          oncomplete: null,
          onerror: null,
          onabort: null,
          objectStore(name) {
            const def = dbState.stores.get(name);
            if (!def) throw new Error(`ObjectStore not found: ${name}`);
            return {
              get indexNames() { return new MockDOMStringList(new Set(def.indexes.keys())); },
              get(key) {
                const req = new MockRequest();
                enqueueOp(() => {
                  const k = keyToString(def.keyPath, key);
                  const val = def.records.has(k) ? cloneValue(def.records.get(k)) : undefined;
                  return { req, result: val };
                });
                return req;
              },
              put(value) {
                const req = new MockRequest();
                enqueueOp(() => {
                  if (!isWrite) throw new Error('ReadOnlyError');
                  if (stats.failQuotaOnPut || stats.puts >= stats.failPutAfter) {
                    throw makeQuotaError();
                  }
                  stats.puts++;
                  const k = keyToString(def.keyPath, value);
                  def.records.set(k, cloneValue(value));
                  return { req, result: value };
                });
                return req;
              },
              delete(key) {
                const req = new MockRequest();
                enqueueOp(() => {
                  if (!isWrite) throw new Error('ReadOnlyError');
                  stats.deletes++;
                  const k = keyToString(def.keyPath, key);
                  def.records.delete(k);
                  return { req, result: undefined };
                });
                return req;
              },
              index(indexName) {
                const idxKeyPath = def.indexes.get(indexName);
                if (!idxKeyPath) throw new Error(`Index not found: ${indexName}`);
                return {
                  getAll(query) {
                    const req = new MockRequest();
                    enqueueOp(() => {
                      const out = [];
                      for (const rec of def.records.values()) {
                        if (query === undefined || rec[idxKeyPath] === query) {
                          out.push(cloneValue(rec));
                        }
                      }
                      return { req, result: out };
                    });
                    return req;
                  },
                };
              },
            };
          },
        };

        function finishTx() {
          if (finished) return;
          finished = true;
          if (isWrite) stats.activeWriteTxs--;
          if (failedError) {
            if (isWrite) {
              for (const [n, snap] of rollbackSnapshots.entries()) {
                const def = dbState.stores.get(n);
                if (def) def.records = snap;
              }
            }
            tx.error = failedError;
            if (typeof tx.onerror === 'function') tx.onerror({ target: tx });
            else if (typeof tx.onabort === 'function') tx.onabort({ target: tx });
          } else {
            if (typeof tx.oncomplete === 'function') tx.oncomplete({ target: tx });
          }
        }

        function scheduleCheck() {
          if (scheduledFinalize) return;
          scheduledFinalize = true;
          queueMicrotask(() => {
            scheduledFinalize = false;
            if (pendingOps === 0 && !finished) finishTx();
          });
        }

        function enqueueOp(fn) {
          pendingOps++;
          queueMicrotask(() => {
            try {
              if (failedError) {
                pendingOps--;
                scheduleCheck();
                return;
              }
              const { req, result } = fn();
              req.result = result;
              if (typeof req.onsuccess === 'function') req.onsuccess({ target: req });
            } catch (err) {
              failedError = err;
              // req.error may be attached when available
            } finally {
              pendingOps--;
              if (failedError && !finished) {
                finishTx();
              } else {
                scheduleCheck();
              }
            }
          });
        }

        // Also allow empty transactions to complete.
        scheduleCheck();
        return tx;
      },
      close() {
        dbState.closedCount++;
      },
    };
    return db;
  }

  const factory = {
    open(name, version = 1) {
      const req = new MockRequest();
      req.onupgradeneeded = null;
      req.onblocked = null;
      queueMicrotask(() => {
        if (stats.failErrorOnOpen) {
          req.error = stats.failErrorOnOpen;
          if (typeof req.onerror === 'function') req.onerror({ target: req });
          return;
        }
        let dbState = databases.get(name);
        const needsUpgrade = !dbState || dbState.version < version;
        if (!dbState) {
          dbState = { name, version, stores: new Map(), closedCount: 0 };
          databases.set(name, dbState);
        } else if (needsUpgrade) {
          dbState.version = version;
        }
        const wrapper = createDatabaseWrapper(dbState);
        req.result = wrapper;
        if (needsUpgrade && typeof req.onupgradeneeded === 'function') {
          req.onupgradeneeded({ target: req });
        }
        if (typeof req.onsuccess === 'function') req.onsuccess({ target: req });
      });
      return req;
    },
  };

  return { factory, stats, databases };
}

test('isNotesIdbAvailable detects unavailable, origin=null, and available environments', () => {
  assert.equal(isNotesIdbAvailable(null), false);
  assert.equal(isNotesIdbAvailable({}), false);
  assert.equal(isNotesIdbAvailable({ indexedDB: {} }), false);
  assert.equal(isNotesIdbAvailable({ indexedDB: { open() {} }, location: { origin: 'null' } }), false);
  assert.equal(isNotesIdbAvailable({ indexedDB: { open() {} }, location: { origin: 'https://hex.example' } }), true);
  assert.equal(isNotesIdbAvailable({ indexedDB: { open() {} } }), true);
});

test('open() creates hex-notes-v1 schema with entries/meta/projects stores and byStore index', async () => {
  const { factory, databases } = createMockIndexedDB();
  const backend = new NotesIdbBackend({ indexedDB: factory });
  const db = await backend.open();
  assert.equal(db.name, NOTES_IDB_NAME);
  assert.equal(db.objectStoreNames.contains(NOTES_STORE_ENTRIES), true);
  assert.equal(db.objectStoreNames.contains(NOTES_STORE_META), true);
  assert.equal(db.objectStoreNames.contains(NOTES_STORE_PROJECTS), true);

  const rawEntriesStore = databases.get(NOTES_IDB_NAME).stores.get(NOTES_STORE_ENTRIES);
  assert.deepEqual(rawEntriesStore.keyPath, ['storeId', 'kind', 'key']);
  assert.equal(rawEntriesStore.indexes.get(NOTES_INDEX_BY_STORE), 'storeId');

  // Calling open() concurrently returns the same handle.
  const db2 = await backend.open();
  assert.equal(db2, db);
  await backend.close();
});

test('putDelta writes O(1) entries and tombstones, and loadStore reconstructs Maps + tombstones', async () => {
  const { factory } = createMockIndexedDB();
  const backend = new NotesIdbBackend({ indexedDB: factory });

  const empty = await backend.loadStore('bin-1');
  assert.equal(empty.found, false);
  assert.equal(empty.entries.names.size, 0);

  const r1 = await backend.putDelta('bin-1', 'names', '0x1000', 'initGame', { generation: 'g1', updatedAt: 100 });
  const r2 = await backend.putDelta('bin-1', 'comments', '0x1000', 'entry point', { generation: 'g1', updatedAt: 101 });
  const r3 = await backend.putDelta('bin-1', 'vars', '0x1000:x0', 'ctx', { generation: 'g1', updatedAt: 102 });
  const r4 = await backend.putDelta('bin-1', 'types', '0x1000:x0', 'GameCtx*', { generation: 'g1', updatedAt: 103 });
  assert.deepEqual([r1.revision, r2.revision, r3.revision, r4.revision], [1, 2, 3, 4]);

  // Delete creates a tombstone instead of physically removing.
  const r5 = await backend.putDelta('bin-1', 'names', '0x1000', null, { generation: 'g1', updatedAt: 104 });
  assert.equal(r5.revision, 5);

  const loaded = await backend.loadStore('bin-1');
  assert.equal(loaded.found, true);
  assert.equal(loaded.entries.names.has('0x1000'), false);
  assert.equal(loaded.tombstones.has('names:0x1000'), true);
  assert.equal(loaded.tombstones.get('names:0x1000').rev, 5);
  assert.equal(loaded.entries.comments.get('0x1000'), 'entry point');
  assert.equal(loaded.entries.vars.get('0x1000:x0'), 'ctx');
  assert.equal(loaded.entries.types.get('0x1000:x0'), 'GameCtx*');
  assert.equal(loaded.meta.revision, 5);
  assert.equal(loaded.meta.generation, 'g1');

  await backend.close();
});

test('single-writer queue serializes concurrent putDelta calls with monotonic revisions', async () => {
  const { factory, stats } = createMockIndexedDB();
  const backend = new NotesIdbBackend({ indexedDB: factory });

  const promises = [];
  for (let i = 0; i < 25; i++) {
    promises.push(backend.putDelta('bin-serial', 'names', `0x${i.toString(16)}`, `fn_${i}`));
  }
  const results = await Promise.all(promises);
  await backend.flush();

  assert.equal(stats.maxConcurrentWriteTxs, 1, 'write transactions must never overlap');
  assert.deepEqual(results.map((r) => r.revision), Array.from({ length: 25 }, (_, i) => i + 1));

  const loaded = await backend.loadStore('bin-serial');
  assert.equal(loaded.entries.names.size, 25);
  await backend.close();
});

test('replaceStore with replace: false performs OCC merge preserving other tab edits and tombstones', async () => {
  const { factory } = createMockIndexedDB();
  const backend = new NotesIdbBackend({ indexedDB: factory });

  // Initial state at rev 2.
  await backend.putDelta('bin-occ', 'names', '0x1000', 'shared_fn', { updatedAt: 100 });
  await backend.putDelta('bin-occ', 'names', '0x2000', 'to_delete', { updatedAt: 101 });

  // Tab B concurrently adds 0x3000 and updates 0x1000 at rev 3, 4.
  await backend.putDelta('bin-occ', 'names', '0x3000', 'tabB_added', { updatedAt: 200 });
  await backend.putDelta('bin-occ', 'names', '0x1000', 'tabB_renamed', { updatedAt: 201 });

  // Tab A (whose baseRevision was 2) saves its own edit (0x4000 added, 0x2000 deleted) via replace: false.
  const localDirty = new Map([
    ['names:0x4000', { value: 'tabA_added', deleted: false, updatedAt: 205 }],
    ['names:0x2000', { value: null, deleted: true, updatedAt: 206 }],
  ]);
  const res = await backend.replaceStore('bin-occ', {
    baseRevision: 2,
    names: new Map([
      ['0x1000', 'shared_fn'], // stale value from Tab A
      ['0x4000', 'tabA_added'],
    ]),
    localDirty,
    structs: [{ name: 'Player' }],
  }, { replace: false });

  assert.equal(res.revision, 5);
  const loaded = await backend.loadStore('bin-occ');
  assert.equal(loaded.entries.names.get('0x1000'), 'tabB_renamed', 'newer remote edit must not be clobbered');
  assert.equal(loaded.entries.names.get('0x3000'), 'tabB_added', 'concurrent remote addition must be preserved');
  assert.equal(loaded.entries.names.get('0x4000'), 'tabA_added', 'local dirty addition must be persisted');
  assert.equal(loaded.entries.names.has('0x2000'), false, 'local dirty deletion must take effect');
  assert.equal(loaded.tombstones.has('names:0x2000'), true, 'deletion must leave a tombstone');
  assert.deepEqual(loaded.meta.structs, [{ name: 'Player' }]);

  await backend.close();
});

test('replaceStore with replace: true chunks 12,500 entries across multiple transactions and removes stale keys', async () => {
  const { factory, stats } = createMockIndexedDB();
  const backend = new NotesIdbBackend({ indexedDB: factory });

  await backend.putDelta('bin-big', 'names', '0xdead', 'stale_old_name');
  const writeTxBefore = stats.writeTxCount;

  const bigNames = new Map();
  for (let i = 0; i < 12_500; i++) {
    bigNames.set(`0x${i.toString(16)}`, `sub_${i}`);
  }
  const res = await backend.replaceStore('bin-big', {
    names: bigNames,
    generation: 'gen-big',
    migratedFromLocalStorage: true,
  }, { chunkSize: 2000, replace: true });

  assert.equal(res.revision, 2);
  // 1 delete tx (stale) + ceil(12500 / 2000) = 7 put txs + 1 meta tx = 9 write txs.
  const writeTxsUsed = stats.writeTxCount - writeTxBefore;
  assert.ok(writeTxsUsed >= 8, `expected chunked write transactions, got ${writeTxsUsed}`);

  const loaded = await backend.loadStore('bin-big');
  assert.equal(loaded.found, true);
  assert.equal(loaded.entries.names.size, 12_500);
  assert.equal(loaded.entries.names.has('0xdead'), false, 'stale key must be removed on replace: true');
  assert.equal(loaded.entries.names.get('0x0'), 'sub_0');
  assert.equal(loaded.entries.names.get('0x30d3'), 'sub_12499');
  assert.equal(loaded.meta.migratedFromLocalStorage, true);

  await backend.close();
});

test('clearStore removes all entries for storeId and sets meta.cleared = true without affecting other stores', async () => {
  const { factory } = createMockIndexedDB();
  const backend = new NotesIdbBackend({ indexedDB: factory });

  await backend.putDelta('bin-a', 'names', '0x10', 'alpha');
  await backend.putDelta('bin-b', 'names', '0x20', 'beta');

  const cleared = await backend.clearStore('bin-a', { generation: 'g-clear' });
  assert.equal(cleared.revision, 2);

  const loadedA = await backend.loadStore('bin-a');
  assert.equal(loadedA.found, true);
  assert.equal(loadedA.entries.names.size, 0);
  assert.equal(loadedA.meta.cleared, true);

  const loadedB = await backend.loadStore('bin-b');
  assert.equal(loadedB.entries.names.get('0x20'), 'beta');

  await backend.close();
});

test('saveProject and loadProject round-trip compact project JSON with monotonic revision', async () => {
  const { factory } = createMockIndexedDB();
  const backend = new NotesIdbBackend({ indexedDB: factory });

  assert.equal(await backend.loadProject('proj:missing'), null);

  await backend.saveProject('proj:1', '{"format":"hexproj","version":2}');
  const p1 = await backend.loadProject('proj:1');
  assert.equal(p1.payload, '{"format":"hexproj","version":2}');
  assert.equal(p1.revision, 1);
  assert.equal(typeof p1.updatedAt, 'number');

  await backend.saveProject('proj:1', '{"format":"hexproj","version":2,"updated":true}', { revision: 5 });
  const p2 = await backend.loadProject('proj:1');
  assert.equal(p2.payload, '{"format":"hexproj","version":2,"updated":true}');
  assert.equal(p2.revision, 5);

  await backend.close();
});

test('QuotaExceededError and generic IDB failures are normalized and do not poison the write queue', async () => {
  const { factory, stats } = createMockIndexedDB({ failQuotaOnPut: true });
  const backend = new NotesIdbBackend({ indexedDB: factory });

  await assert.rejects(
    () => backend.putDelta('bin-q', 'names', '0x1', 'foo'),
    (err) => {
      assert.equal(err.code, 'QUOTA_EXCEEDED');
      assert.ok(err.cause);
      assert.equal(typeof err.message, 'string');
      return true;
    },
  );

  // Subsequent write succeeds once quota pressure clears (queue is not poisoned).
  stats.failQuotaOnPut = false;
  const ok = await backend.putDelta('bin-q', 'names', '0x1', 'recovered');
  assert.equal(ok.revision, 1);

  // Generic open error normalizes to IDB_ERROR.
  const openFail = createMockIndexedDB({ failErrorOnOpen: new Error('disk offline') });
  const broken = new NotesIdbBackend({ indexedDB: openFail.factory });
  await assert.rejects(
    () => broken.open(),
    (err) => {
      assert.equal(err.code, 'IDB_ERROR');
      assert.match(err.message, /disk offline/);
      return true;
    },
  );

  const normalized = normalizeNotesIdbError({ name: 'QuotaExceededError', message: 'full' });
  assert.equal(normalized.code, 'QUOTA_EXCEEDED');

  await backend.close();
});
