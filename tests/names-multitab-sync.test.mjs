import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NoteStore,
  MAX_NOTES_BYTES,
  MAX_NAME_LENGTH,
  MAX_COMMENT_LENGTH,
  MAX_TYPE_LENGTH,
  cleanName,
  findLegacyV3NoteKey,
} from '../js/names.js';
import { MAX_PROJECT_BYTES } from '../js/project/limits.js';
import { NotesIdbBackend } from '../js/platform/notes-idb.js';

class MockStorage {
  constructor() {
    this.map = new Map();
    this.setCalls = [];
    this.removeCalls = [];
  }
  getItem(k) {
    const key = String(k);
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(k, v) {
    const key = String(k);
    const val = String(v);
    this.setCalls.push({ key, value: val });
    this.map.set(key, val);
  }
  removeItem(k) {
    const key = String(k);
    this.removeCalls.push(key);
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
  get length() {
    return this.map.size;
  }
  key(index) {
    return [...this.map.keys()][index] ?? null;
  }
}

class MockWindow {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }
  dispatchStorage(key, newValue, oldValue = null) {
    const event = { key, newValue, oldValue };
    for (const fn of this.listeners.get('storage') || []) fn(event);
  }
  listenerCount(type) {
    return this.listeners.get(type)?.size || 0;
  }
}

class MockBroadcastBus {
  constructor() {
    this.channels = new Set();
  }
  createChannel() {
    const bus = this;
    const ch = {
      listeners: new Set(),
      closed: false,
      addEventListener(type, fn) {
        if (type === 'message') this.listeners.add(fn);
      },
      removeEventListener(type, fn) {
        if (type === 'message') this.listeners.delete(fn);
      },
      postMessage(data) {
        if (this.closed) return;
        for (const peer of bus.channels) {
          if (peer === this || peer.closed) continue;
          for (const fn of peer.listeners) fn({ data: structuredClone(data) });
        }
      },
      close() {
        this.closed = true;
        bus.channels.delete(this);
      },
    };
    this.channels.add(ch);
    return ch;
  }
}

class MockNotesIdb {
  constructor() {
    this.stores = new Map();
    this.putDeltaCalls = [];
    this.replaceStoreCalls = [];
    this.clearStoreCalls = [];
    this.failNext = null;
  }
  _ensure(storeId) {
    if (!this.stores.has(storeId)) {
      this.stores.set(storeId, {
        entries: {
          names: new Map(),
          comments: new Map(),
          vars: new Map(),
          types: new Map(),
        },
        tombstones: new Map(),
        meta: null,
      });
    }
    return this.stores.get(storeId);
  }
  async loadStore(storeId) {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    const rec = this.stores.get(storeId);
    if (!rec) {
      return {
        found: false,
        entries: { names: new Map(), comments: new Map(), vars: new Map(), types: new Map() },
        tombstones: new Map(),
        meta: null,
      };
    }
    return {
      found: true,
      entries: {
        names: new Map(rec.entries.names),
        comments: new Map(rec.entries.comments),
        vars: new Map(rec.entries.vars),
        types: new Map(rec.entries.types),
      },
      tombstones: new Map(rec.tombstones),
      meta: rec.meta ? { ...rec.meta } : null,
    };
  }
  async putDelta(storeId, kind, key, value, meta = {}) {
    this.putDeltaCalls.push({ storeId, kind, key, value, meta });
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    const rec = this._ensure(storeId);
    if (value == null) {
      rec.entries[kind].delete(key);
      rec.tombstones.set(`${kind}:${key}`, { rev: meta.rev || 1, updatedAt: meta.updatedAt || Date.now() });
    } else {
      rec.entries[kind].set(key, String(value));
      rec.tombstones.delete(`${kind}:${key}`);
    }
    rec.meta = {
      ...(rec.meta || {}),
      storeId,
      generation: meta.generation || rec.meta?.generation || 'g1',
      cleared: false,
      revision: (rec.meta?.revision || 0) + 1,
    };
    return { revision: rec.meta.revision };
  }
  async replaceStore(storeId, snapshot, { replace = false } = {}) {
    this.replaceStoreCalls.push({ storeId, snapshot, replace });
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    const rec = this._ensure(storeId);
    for (const kind of ['names', 'comments', 'vars', 'types']) {
      if (replace) rec.entries[kind].clear();
      for (const [k, v] of Object.entries(snapshot[kind] || {})) {
        rec.entries[kind].set(k, String(v));
        rec.tombstones.delete(`${kind}:${k}`);
      }
    }
    rec.meta = {
      storeId,
      generation: snapshot.generation,
      structs: Array.isArray(snapshot.structs) ? snapshot.structs.slice() : [],
      cleared: false,
      revision: (rec.meta?.revision || 0) + 1,
    };
    return { revision: rec.meta.revision };
  }
  async clearStore(storeId, meta = {}) {
    this.clearStoreCalls.push({ storeId, meta });
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    const rec = this._ensure(storeId);
    for (const kind of ['names', 'comments', 'vars', 'types']) rec.entries[kind].clear();
    rec.tombstones.clear();
    rec.meta = { storeId, generation: meta.generation || 'cleared', cleared: true, structs: [], revision: (rec.meta?.revision || 0) + 1 };
    return { revision: rec.meta.revision };
  }
  async flush() {}
}

test('constants align with js/project/limits.js (16 MiB and length limits)', () => {
  assert.equal(MAX_NOTES_BYTES, MAX_PROJECT_BYTES);
  assert.equal(MAX_NOTES_BYTES, 16 * 1024 * 1024);
  assert.equal(MAX_NAME_LENGTH, 256);
  assert.equal(MAX_COMMENT_LENGTH, 2000);
  assert.equal(MAX_TYPE_LENGTH, 128);

  const storage = new MockStorage();
  const notes = new NoteStore('limits-test', [], { storage, enableSync: false });
  assert.equal(cleanName('a'.repeat(500)).length, 256);
  notes.setName(0x1000n, 'n'.repeat(400));
  assert.equal(notes.nameOf(0x1000n).length, 256);
  notes.setComment(0x1000n, 'c'.repeat(3000));
  assert.equal(notes.comment(0x1000n).length, 2000);
  notes.setType(0x1000n, 'arg0', 't'.repeat(300));
  assert.equal(notes.typeOf(0x1000n, 'arg0').length, 128);

  // fromJSON applies the same unified limits (256 / 2000 / 128)
  const imported = new NoteStore('limits-import', [], { storage, enableSync: false });
  imported.fromJSON(JSON.stringify({
    names: { '4096': 'x'.repeat(500) },
    comments: { '4096': 'y'.repeat(3000) },
    types: { '4096:r0': 'z'.repeat(300) },
  }));
  assert.equal(imported.nameOf(0x1000n).length, 256);
  assert.equal(imported.comment(0x1000n).length, 2000);
  assert.equal(imported.typeOf(0x1000n, 'r0').length, 128);
});

test('2-tab concurrent edits in localStorage mode: OCC merge preserves other tab edits even without storage events', () => {
  const storage = new MockStorage();
  const tabA = new NoteStore('occ-file', [], { storage, enableSync: false });
  assert.equal(tabA.setName(0x1000n, 'shared_base'), true);

  const tabB = new NoteStore('occ-file', [], { storage, enableSync: false });
  assert.equal(tabB.nameOf(0x1000n), 'shared_base');

  // Tab B edits 0x2000 and commits a new generation snapshot (Tab A misses the event)
  assert.equal(tabB.setName(0x2000n, 'from_tab_b'), true);
  assert.equal(tabB.save(), true);

  // Tab A edits 0x3000 and deletes 0x1000, then saves without having seen Tab B's event
  assert.equal(tabA.setName(0x3000n, 'from_tab_a', { save: false }), true);
  assert.equal(tabA.setName(0x1000n, '', { save: false }), true);
  assert.equal(tabA.save(), true);

  // Both Tab B's addition (0x2000) and Tab A's addition (0x3000) + deletion (0x1000) must survive!
  const reopened = new NoteStore('occ-file', [], { storage, enableSync: false });
  assert.equal(reopened.nameOf(0x2000n), 'from_tab_b', 'Tab B edit must not be silently overwritten');
  assert.equal(reopened.nameOf(0x3000n), 'from_tab_a', 'Tab A edit must be preserved');
  assert.equal(reopened.nameOf(0x1000n), null, 'Tab A deletion tombstone must win over stale remote value');
});

test('2-tab realtime sync via BroadcastChannel and storage event with remote: true flag and dispose() cleanup', () => {
  const storage = new MockStorage();
  const winA = new MockWindow();
  const winB = new MockWindow();
  const bus = new MockBroadcastBus();
  const chA = bus.createChannel();
  const chB = bus.createChannel();

  const tabA = new NoteStore('sync-file', [], { storage, windowObj: winA, broadcastChannel: chA });
  const tabB = new NoteStore('sync-file', [], { storage, windowObj: winB, broadcastChannel: chB });
  assert.equal(winA.listenerCount('storage'), 1);
  assert.equal(winB.listenerCount('storage'), 1);

  const eventsB = [];
  tabB.setOnChange((ev) => eventsB.push(ev));

  assert.equal(tabA.setName(0x1000n, 'alpha'), true);
  assert.equal(tabB.nameOf(0x1000n), 'alpha', 'BroadcastChannel syncs delta immediately');
  assert.equal(eventsB.at(-1)?.kind, 'remote-sync');
  assert.equal(eventsB.at(-1)?.remote, true);

  // Local edit on Tab B emits remote: false
  assert.equal(tabB.setComment(0x2000n, 'beta_note'), true);
  assert.equal(eventsB.at(-1)?.remote, false);
  assert.equal(tabA.comment(0x2000n), 'beta_note');

  // Storage event path (when BroadcastChannel is unavailable)
  const winC = new MockWindow();
  const tabC = new NoteStore('sync-file', [], { storage, windowObj: winC, broadcastChannel: null, enableSync: true });
  const eventsC = [];
  tabC.setOnChange((ev) => eventsC.push(ev));
  const deltaKey = 'hex.notes.sync-file.delta.names.12288';
  const gen = JSON.parse(storage.getItem('hex.notes.sync-file')).generation;
  const deltaPayload = JSON.stringify({ kind: 'names', key: '12288', deleted: false, generation: gen, value: 'via_storage_event' });
  storage.setItem(deltaKey, deltaPayload);
  winC.dispatchStorage(deltaKey, deltaPayload);
  assert.equal(tabC.nameOf(0x3000n), 'via_storage_event');
  assert.equal(eventsC.at(-1)?.remote, true);

  // dispose() removes storage and BroadcastChannel listeners idempotently
  tabA.dispose();
  tabA.dispose();
  tabB.dispose();
  tabC.dispose();
  assert.equal(winA.listenerCount('storage'), 0);
  assert.equal(winB.listenerCount('storage'), 0);
  assert.equal(winC.listenerCount('storage'), 0);
  assert.equal(chA.listeners.size, 0);
  assert.equal(chB.listeners.size, 0);
});

test('IDB mode skips localStorage snapshot/delta writes, uses putDelta/replaceStore/clearStore, migrates legacy data, and reports errors', async () => {
  const storage = new MockStorage();
  const idb = new MockNotesIdb();
  const bus = new MockBroadcastBus();
  const winA = new MockWindow();
  const winB = new MockWindow();

  // Seed legacy localStorage data for auto-migration test
  storage.setItem('hex.notes.idb-file', JSON.stringify({
    v: 2,
    generation: 'legacy-g1',
    names: { '4096': 'migrated_name' },
    comments: {},
    vars: {},
    types: {},
    structs: [],
  }));
  storage.setItem('hex.notes.idb-file.delta.comments.4096', JSON.stringify({
    kind: 'comments',
    key: '4096',
    deleted: false,
    generation: 'legacy-g1',
    value: 'migrated_comment',
  }));
  storage.setCalls.length = 0;

  const errors = [];
  let successes = 0;
  const tabA = new NoteStore('idb-file', [], {
    storage,
    idb,
    windowObj: winA,
    broadcastChannel: bus.createChannel(),
    onSaveError: (err) => errors.push(err),
    onSaveSuccess: () => { successes++; },
  });

  const mig = await tabA.hydrateFromIdb();
  assert.equal(mig.migrated, true);
  assert.equal(idb.replaceStoreCalls.length, 1);
  assert.equal(storage.getItem('hex.notes.idb-file.delta.comments.4096'), null, 'delta keys cleaned up after migration');

  // Single edit in IDB mode writes putDelta + lightweight ping ONLY (no snapshot/delta in localStorage)
  storage.setCalls.length = 0;
  assert.equal(tabA.setName(0x2000n, 'idb_edit'), true);
  await tabA.flush();
  assert.equal(idb.putDeltaCalls.length, 1);
  assert.equal(storage.setCalls.every((c) => c.key === 'hex.notes.ping.idb-file' && c.value.length < 150), true);
  assert.ok(successes >= 1);

  // Tab B hydrates from IDB and sees both migrated + new edits
  const tabB = new NoteStore('idb-file', [], {
    storage: new MockStorage(),
    idb,
    windowObj: winB,
    broadcastChannel: bus.createChannel(),
  });
  const hyd = await tabB.hydrateFromIdb();
  assert.equal(hyd.found, true);
  assert.equal(tabB.nameOf(0x1000n), 'migrated_name');
  assert.equal(tabB.comment(0x1000n), 'migrated_comment');
  assert.equal(tabB.nameOf(0x2000n), 'idb_edit');

  // replaceAll uses replace: true
  assert.equal(tabA.replaceAll({ names: [['16384', 'replaced_fn']] }), true);
  await tabA.flush();
  assert.equal(idb.replaceStoreCalls.at(-1)?.replace, true);
  assert.equal(tabA.nameOf(0x4000n), 'replaced_fn');
  assert.equal(tabA.nameOf(0x1000n), null);

  // QuotaExceededError propagates to onSaveError and marks dirty
  const quotaErr = Object.assign(new Error('quota'), { code: 'QUOTA_EXCEEDED' });
  idb.failNext = quotaErr;
  assert.equal(tabA.setName(0x5000n, 'will_fail'), true);
  await tabA.flush();
  assert.equal(tabA.dirty, true);
  assert.equal(tabA.lastMutationSaved, false);
  assert.equal(tabA.lastSaveError?.code, 'QUOTA_EXCEEDED');
  assert.equal(errors.at(-1)?.code, 'QUOTA_EXCEEDED');

  // saveAsync retries and resolves true on success
  assert.equal(await tabA.saveAsync(), true);
  assert.equal(tabA.lastSaveError, null);

  // clear() calls clearStore in IDB mode
  assert.equal(tabA.clear(), true);
  await tabA.flush();
  assert.equal(idb.clearStoreCalls.length, 1);

  tabA.dispose();
  tabB.dispose();
});

/**
 * Minimal in-memory IndexedDB factory for real NotesIdbBackend + NoteStore
 * integration tests.
 */
function createInMemoryIdbFactory() {
  const databases = new Map();
  let failNextPutError = null;

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

  class StringList {
    constructor(set) { this._set = set; }
    contains(name) { return this._set.has(name); }
  }

  class Req {
    constructor() { this.result = undefined; this.error = null; this.onsuccess = null; this.onerror = null; }
  }

  function wrapDb(dbState) {
    return {
      name: dbState.name,
      version: dbState.version,
      onversionchange: null,
      get objectStoreNames() { return new StringList(new Set(dbState.stores.keys())); },
      createObjectStore(name, { keyPath }) {
        const def = { name, keyPath, records: new Map(), indexes: new Map() };
        dbState.stores.set(name, def);
        return {
          get indexNames() { return new StringList(new Set(def.indexes.keys())); },
          createIndex(idxName, idxKeyPath) { def.indexes.set(idxName, idxKeyPath); },
        };
      },
      transaction(storeNames, mode = 'readonly') {
        const names = Array.isArray(storeNames) ? storeNames : [storeNames];
        const isWrite = mode === 'readwrite';
        const rollback = new Map();
        if (isWrite) {
          for (const n of names) {
            const def = dbState.stores.get(n);
            if (def) rollback.set(n, new Map([...def.records.entries()].map(([k, v]) => [k, structuredClone(v)])));
          }
        }
        let pending = 0;
        let finished = false;
        let failed = null;
        let scheduled = false;

        const tx = {
          mode,
          error: null,
          oncomplete: null,
          onerror: null,
          onabort: null,
          objectStore(name) {
            const def = dbState.stores.get(name);
            return {
              get(key) {
                const req = new Req();
                runOp(() => ({ req, result: def.records.has(keyToString(def.keyPath, key)) ? structuredClone(def.records.get(keyToString(def.keyPath, key))) : undefined }));
                return req;
              },
              put(value) {
                const req = new Req();
                runOp(() => {
                  if (failNextPutError) {
                    const err = failNextPutError;
                    failNextPutError = null;
                    throw err;
                  }
                  def.records.set(keyToString(def.keyPath, value), structuredClone(value));
                  return { req, result: value };
                });
                return req;
              },
              delete(key) {
                const req = new Req();
                runOp(() => {
                  def.records.delete(keyToString(def.keyPath, key));
                  return { req, result: undefined };
                });
                return req;
              },
              index(idxName) {
                const idxKeyPath = def.indexes.get(idxName);
                return {
                  getAll(query) {
                    const req = new Req();
                    runOp(() => {
                      const out = [];
                      for (const rec of def.records.values()) {
                        if (query === undefined || rec[idxKeyPath] === query) out.push(structuredClone(rec));
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

        function finish() {
          if (finished) return;
          finished = true;
          if (failed) {
            if (isWrite) {
              for (const [n, snap] of rollback.entries()) dbState.stores.get(n).records = snap;
            }
            tx.error = failed;
            if (typeof tx.onerror === 'function') tx.onerror({ target: tx });
            else if (typeof tx.onabort === 'function') tx.onabort({ target: tx });
          } else if (typeof tx.oncomplete === 'function') {
            tx.oncomplete({ target: tx });
          }
        }

        function checkDone() {
          if (scheduled) return;
          scheduled = true;
          queueMicrotask(() => {
            scheduled = false;
            if (pending === 0 && !finished) finish();
          });
        }

        function runOp(fn) {
          pending++;
          queueMicrotask(() => {
            try {
              if (failed) return;
              const { req, result } = fn();
              req.result = result;
              if (typeof req.onsuccess === 'function') req.onsuccess({ target: req });
            } catch (err) {
              failed = err;
            } finally {
              pending--;
              if (failed && !finished) finish();
              else checkDone();
            }
          });
        }

        checkDone();
        return tx;
      },
      close() {},
    };
  }

  return {
    setFailNextPut(err) { failNextPutError = err; },
    factory: {
      open(name, version = 1) {
        const req = new Req();
        req.onupgradeneeded = null;
        queueMicrotask(() => {
          let dbState = databases.get(name);
          const upgrade = !dbState || dbState.version < version;
          if (!dbState) {
            dbState = { name, version, stores: new Map() };
            databases.set(name, dbState);
          }
          req.result = wrapDb(dbState);
          if (upgrade && typeof req.onupgradeneeded === 'function') req.onupgradeneeded({ target: req });
          if (typeof req.onsuccess === 'function') req.onsuccess({ target: req });
        });
        return req;
      },
    },
  };
}

test('localStorage OCC merge preserves remote deletions when another tab deletes a key and saves', () => {
  const storage = new MockStorage();
  const tabA = new NoteStore('occ-delete-file', [], { storage, enableSync: false });
  tabA.setName(0x1000n, 'will_be_deleted_by_b');
  tabA.setName(0x2000n, 'stays');
  tabA.save();

  const tabB = new NoteStore('occ-delete-file', [], { storage, enableSync: false });
  assert.equal(tabB.nameOf(0x1000n), 'will_be_deleted_by_b');

  // Tab B deletes 0x1000 and saves a new generation snapshot (Tab A misses the event)
  tabB.setName(0x1000n, '');
  tabB.save();

  // Tab A edits an unrelated key 0x3000 and saves
  tabA.setName(0x3000n, 'added_by_a', { save: false });
  assert.equal(tabA.save(), true);

  const reopened = new NoteStore('occ-delete-file', [], { storage, enableSync: false });
  assert.equal(reopened.nameOf(0x1000n), null, 'Tab B deletion must not be resurrected by Tab A save()');
  assert.equal(reopened.nameOf(0x2000n), 'stays');
  assert.equal(reopened.nameOf(0x3000n), 'added_by_a');
});

test('real NotesIdbBackend + NoteStore integration: 2-tab IDB OCC merge, replaceAll ghost pruning, migration flag, and error recovery', async () => {
  const env = createInMemoryIdbFactory();
  const idb = new NotesIdbBackend({ indexedDB: env.factory });

  // (b-1) Auto-migration sets meta.migratedFromLocalStorage = true
  const legacyStorage = new MockStorage();
  legacyStorage.setItem('hex.notes.real-idb-file', JSON.stringify({
    v: 2,
    generation: 'legacy-gen-1',
    names: { '4096': 'shared_fn', '8192': 'to_delete_in_a' },
    comments: {},
    vars: {},
    types: {},
    structs: [{ name: 'OldStruct' }],
  }));

  const errorsA = [];
  let successesA = 0;
  const tabA = new NoteStore('real-idb-file', [], {
    storage: legacyStorage,
    idb,
    enableSync: false,
    onSaveError: (e) => errorsA.push(e),
    onSaveSuccess: () => { successesA++; },
  });
  const mig = await tabA.hydrateFromIdb();
  assert.equal(mig.migrated, true);
  const afterMig = await idb.loadStore('real-idb-file');
  assert.equal(afterMig.meta.migratedFromLocalStorage, true, 'migration must persist migratedFromLocalStorage: true');

  // Tab B opens and hydrates from the same real NotesIdbBackend
  const tabB = new NoteStore('real-idb-file', [], {
    storage: new MockStorage(),
    idb,
    enableSync: false,
  });
  await tabB.hydrateFromIdb();
  assert.equal(tabB.nameOf(0x1000n), 'shared_fn');
  assert.equal(tabB.nameOf(0x2000n), 'to_delete_in_a');

  // (a) 2-tab IDB OCC merge without BroadcastChannel:
  // Tab B renames 0x1000 and adds 0x3000
  tabB.setName(0x1000n, 'renamed_by_b');
  tabB.setName(0x3000n, 'added_by_b');
  await tabB.flush();

  // Tab A (still on older _idbRevision) deletes 0x2000 and adds 0x4000, then calls save({ replace: false })
  tabA.setName(0x2000n, '', { save: false });
  tabA.setName(0x4000n, 'added_by_a', { save: false });
  assert.equal(await tabA.saveAsync({ replace: false }), true);

  const merged = await idb.loadStore('real-idb-file');
  assert.equal(merged.entries.names.get('4096'), 'renamed_by_b', 'Tab B rename must survive Tab A save()');
  assert.equal(merged.entries.names.get('12288'), 'added_by_b', 'Tab B addition must survive Tab A save()');
  assert.equal(merged.entries.names.get('16384'), 'added_by_a', 'Tab A addition must be persisted');
  assert.equal(merged.entries.names.has('8192'), false, 'Tab A deletion must remove entry');
  assert.equal(merged.tombstones.has('names:8192'), true, 'Tab A deletion must persist tombstone');

  // (b-2) replaceAll() on Tab A followed by hydrateFromIdb() on Tab B prunes ghost keys and syncs structs
  assert.equal(tabA.replaceAll({
    names: [['20480', 'only_new_fn']],
    structs: [{ name: 'NewStruct' }],
  }), true);
  await tabA.flush();

  await tabB.hydrateFromIdb();
  assert.equal(tabB.nameOf(0x5000n), 'only_new_fn');
  assert.equal(tabB.nameOf(0x1000n), null, 'ghost key from prior state must be pruned after remote replaceAll');
  assert.equal(tabB.nameOf(0x3000n), null, 'ghost key added earlier in Tab B must be pruned');
  assert.deepEqual(tabB.structs, [{ name: 'NewStruct' }], 'structs must sync when local tab is not dirty');

  // (d) Transient IDB failure followed by queued write success clears error and invokes onSaveSuccess
  const quotaErr = Object.assign(new Error('quota full'), { name: 'QuotaExceededError', code: 22 });
  env.setFailNextPut(quotaErr);
  const successesBefore = successesA;
  tabA.setName(0x6000n, 'fails_first');
  tabA.setName(0x7000n, 'succeeds_next');
  await tabA.flush();
  assert.equal(errorsA.at(-1)?.code, 'QUOTA_EXCEEDED');
  assert.equal(tabA.lastSaveError, null, 'subsequent successful queued write must clear lastSaveError');
  assert.ok(successesA > successesBefore, 'onSaveSuccess must fire after recovery write succeeds');

  tabA.dispose();
  tabB.dispose();
  await idb.close();
});

test('storage-denied environment (localStorage getter throws SecurityError) does not throw in NoteStore or findLegacyV3NoteKey', () => {
  const originalDesc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      const err = new Error('Access is denied for this document.');
      err.name = 'SecurityError';
      throw err;
    },
  });
  try {
    const file = new Uint8Array([1, 2, 3, 4]);
    assert.equal(findLegacyV3NoteKey(file, null, 0), null);
    const notes = new NoteStore('origin-null-file', [], { enableSync: false });
    assert.equal(notes.count, 0);
    notes.dispose();
  } finally {
    if (originalDesc) Object.defineProperty(globalThis, 'localStorage', originalDesc);
    else delete globalThis.localStorage;
  }
});

test('localStorage _persistDelta clears _localDirty on success to avoid leak and stale overwrite in 2-tab OCC save', () => {
  const storage = new MockStorage();
  const tabA = new NoteStore('ls-dirty-clear', [], { storage, enableSync: false });
  assert.equal(tabA.setName(0x1000n, 'v0'), true);
  // Second mutation uses _persistDelta path (snapshot is now SNAPSHOT_VALID).
  assert.equal(tabA.setName(0x1000n, 'v1_from_a'), true);
  assert.equal(tabA._localDirty.has('names:4096'), false, '_localDirty must be cleared after localStorage _persistDelta succeeds');

  // Tab B loads and updates 0x1000 -> v2_from_b and commits a new snapshot.
  const tabB = new NoteStore('ls-dirty-clear', [], { storage, enableSync: false });
  assert.equal(tabB.nameOf(0x1000n), 'v1_from_a');
  assert.equal(tabB.setName(0x1000n, 'v2_from_b'), true);
  assert.equal(tabB.save(), true);

  // Tab A edits an unrelated key 0x2000 and calls save() -> must NOT clobber Tab B's v2_from_b with stale v1_from_a.
  assert.equal(tabA.setName(0x2000n, 'added_a', { save: false }), true);
  assert.equal(tabA.save(), true);

  const reopened = new NoteStore('ls-dirty-clear', [], { storage, enableSync: false });
  assert.equal(reopened.nameOf(0x1000n), 'v2_from_b', 'stale value from earlier _persistDelta must not overwrite newer Tab B edit');
  assert.equal(reopened.nameOf(0x2000n), 'added_a');
});

test('hydrateFromIdb discards out-of-order/stale snapshots and skips rewind during pending writes; BroadcastChannel delta updates _idbRevision to skip redundant ping hydrate', async () => {
  const storage = new MockStorage();
  const bus = new MockBroadcastBus();
  const winA = new MockWindow();
  const winB = new MockWindow();
  const idb = new MockNotesIdb();

  // Track loadStore calls on Tab B.
  let loadCalls = 0;
  const origLoadStore = idb.loadStore.bind(idb);
  idb.loadStore = async (storeId) => {
    loadCalls++;
    return origLoadStore(storeId);
  };

  const tabA = new NoteStore('idb-sync-opt', [], {
    storage,
    idb,
    windowObj: winA,
    broadcastChannel: bus.createChannel(),
  });
  const tabB = new NoteStore('idb-sync-opt', [], {
    storage,
    idb,
    windowObj: winB,
    broadcastChannel: bus.createChannel(),
  });

  // Tab A writes a delta -> BroadcastChannel delivers delta with idbRev=1 to Tab B, then storage ping arrives with idbRev=1.
  assert.equal(tabA.setName(0x1000n, 'synced_fast'), true);
  await tabA.flush();
  assert.equal(tabB.nameOf(0x1000n), 'synced_fast');
  assert.equal(tabB._idbRevision, 1, 'BroadcastChannel delta must advance receiver _idbRevision');

  const pingRaw = storage.getItem('hex.notes.ping.idb-sync-opt');
  assert.ok(pingRaw);
  assert.equal(JSON.parse(pingRaw).idbRev, 1);

  loadCalls = 0;
  winB.dispatchStorage('hex.notes.ping.idb-sync-opt', pingRaw);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(loadCalls, 0, 'ping with idbRev <= _idbRevision must skip hydrateFromIdb()');

  // Out-of-order hydrateFromIdb: slow first load (rev 1) resolves AFTER fast second load (rev 2).
  let releaseSlowLoad;
  const slowLoadPromise = new Promise((resolve) => { releaseSlowLoad = resolve; });
  let callIndex = 0;
  idb.loadStore = async () => {
    callIndex++;
    if (callIndex === 1) {
      await slowLoadPromise;
      return {
        found: true,
        entries: { names: new Map([['4096', 'stale_rev_1']]), comments: new Map(), vars: new Map(), types: new Map() },
        tombstones: new Map(),
        meta: { revision: 1, generation: 'g1', cleared: false, structs: [] },
      };
    }
    return {
      found: true,
      entries: { names: new Map([['4096', 'fresh_rev_2']]), comments: new Map(), vars: new Map(), types: new Map() },
      tombstones: new Map(),
      meta: { revision: 2, generation: 'g2', cleared: false, structs: [] },
    };
  };

  const pSlow = tabB.hydrateFromIdb();
  const pFast = tabB.hydrateFromIdb();
  await pFast;
  assert.equal(tabB.nameOf(0x1000n), 'fresh_rev_2');
  assert.equal(tabB._idbRevision, 2);

  releaseSlowLoad();
  await pSlow;
  assert.equal(tabB.nameOf(0x1000n), 'fresh_rev_2', 'out-of-order older hydrateFromIdb must be discarded');

  // Also reject a newer call that returns revision < _idbRevision.
  idb.loadStore = async () => ({
    found: true,
    entries: { names: new Map([['4096', 'older_than_idb_rev']]), comments: new Map(), vars: new Map(), types: new Map() },
    tombstones: new Map(),
    meta: { revision: 1, generation: 'g1', cleared: false, structs: [] },
  });
  await tabB.hydrateFromIdb();
  assert.equal(tabB.nameOf(0x1000n), 'fresh_rev_2', 'loaded.meta.revision < _idbRevision must be discarded');

  // While a local IDB write is in-flight (_idbPendingWrites > 0), hydrateFromIdb must not rewind in-memory state.
  let releasePut;
  const putGate = new Promise((resolve) => { releasePut = resolve; });
  const origPutDelta = idb.putDelta.bind(idb);
  idb.putDelta = async (...args) => {
    await putGate;
    return origPutDelta(...args);
  };
  idb.loadStore = async () => ({
    found: true,
    entries: { names: new Map([['4096', 'remote_before_clear']]), comments: new Map(), vars: new Map(), types: new Map() },
    tombstones: new Map(),
    meta: { revision: 3, generation: 'g3', cleared: false, structs: [] },
  });
  tabB.setName(0x2000n, 'pending_local');
  assert.ok(tabB._idbPendingWrites > 0);
  await tabB.hydrateFromIdb();
  assert.equal(tabB.nameOf(0x1000n), 'fresh_rev_2', 'hydrateFromIdb must not apply snapshot while local IDB write is pending');
  assert.equal(tabB.nameOf(0x2000n), 'pending_local');
  releasePut();
  await tabB.flush();

  tabA.dispose();
  tabB.dispose();
});

test('NoteStore.dispose() lets already-queued IDB writes finish while suppressing callbacks', async () => {
  const idb = new MockNotesIdb();
  let releasePut;
  const gate = new Promise((resolve) => { releasePut = resolve; });
  const origPutDelta = idb.putDelta.bind(idb);
  idb.putDelta = async (...args) => {
    await gate;
    return origPutDelta(...args);
  };

  let saveSuccessCount = 0;
  let saveErrorCount = 0;
  const notes = new NoteStore('dispose-flush-file', [], {
    storage: new MockStorage(),
    idb,
    enableSync: false,
    onSaveSuccess: () => { saveSuccessCount++; },
    onSaveError: () => { saveErrorCount++; },
  });

  assert.equal(notes.setName(0x1000n, 'must_not_be_lost'), true);
  // Immediately dispose (simulating file switch) before queued write finishes.
  notes.dispose();
  releasePut();
  await notes.flush();

  const persisted = await idb.loadStore('dispose-flush-file');
  assert.equal(persisted.entries.names.get('4096'), 'must_not_be_lost', 'queued IDB write must complete even after dispose()');
  assert.equal(saveSuccessCount, 0, 'onSaveSuccess must be suppressed after dispose()');
  assert.equal(saveErrorCount, 0, 'onSaveError must be suppressed after dispose()');
});
