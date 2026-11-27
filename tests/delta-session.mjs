import assert from 'node:assert/strict';
import {
  BookmarkStore,
  DeltaSessionStore,
  DELTA_SESSION_FORMAT,
  DELTA_SESSION_VERSION,
  MAX_BOOKMARKS,
  MAX_DELTA_ENTRY_BYTES,
  makeDeltaKey,
  countDeltaItems,
  serializeDeltaJson,
  parseDeltaJson,
} from '../js/cache/delta-session.js';
import { NoteStore } from '../js/names.js';

/* ── Mock Storage Helpers ────────────────────────────────────── */

function createMemoryLocalStorage({ quotaBytes = Infinity } = {}) {
  const map = new Map();
  const byteSize = () => {
    let total = 0;
    for (const [k, v] of map) total += Buffer.byteLength(k, 'utf8') + Buffer.byteLength(v, 'utf8');
    return total;
  };
  return {
    get length() { return map.size; },
    key(index) { return Array.from(map.keys())[index] ?? null; },
    getItem(k) { return map.has(String(k)) ? map.get(String(k)) : null; },
    setItem(k, v) {
      const key = String(k);
      const val = String(v);
      const prev = map.has(key) ? Buffer.byteLength(key, 'utf8') + Buffer.byteLength(map.get(key), 'utf8') : 0;
      const next = Buffer.byteLength(key, 'utf8') + Buffer.byteLength(val, 'utf8');
      if (byteSize() - prev + next > quotaBytes) {
        const err = new Error('QuotaExceededError');
        err.name = 'QuotaExceededError';
        throw err;
      }
      map.set(key, val);
    },
    removeItem(k) { map.delete(String(k)); },
    clear() { map.clear(); },
    _map: map,
  };
}

function createMockIndexedDB() {
  const stores = new Map(); // storeName -> { keyPath, indexes: Map, data: Map }
  const clone = (val) => (val === undefined ? undefined : JSON.parse(JSON.stringify(val)));

  const makeReq = (fn) => {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      try {
        req.result = fn();
        req.onsuccess?.({ target: req });
      } catch (err) {
        req.error = err;
        req.onerror?.({ target: req });
      }
    });
    return req;
  };

  const db = {
    objectStoreNames: {
      contains(name) { return stores.has(name); },
    },
    createObjectStore(name, opts = {}) {
      const meta = { keyPath: opts.keyPath || null, indexes: new Map(), data: new Map() };
      stores.set(name, meta);
      return {
        createIndex(idxName, keyPath, idxOpts) {
          meta.indexes.set(idxName, { keyPath, opts: idxOpts });
        },
      };
    },
    transaction(storeNames, _mode) {
      const tx = { oncomplete: null, onabort: null, onerror: null, error: null };
      const names = Array.isArray(storeNames) ? storeNames : [storeNames];
      for (const n of names) {
        if (!stores.has(n)) throw new Error(`missing-store:${n}`);
      }
      let scheduled = false;
      const scheduleComplete = () => {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => { tx.oncomplete?.(); }, 0);
      };
      scheduleComplete();
      tx.objectStore = (name) => {
        const meta = stores.get(name);
        return {
          put(value) {
            const key = meta.keyPath ? value[meta.keyPath] : undefined;
            return makeReq(() => {
              meta.data.set(String(key), clone(value));
              return key;
            });
          },
          get(key) {
            return makeReq(() => clone(meta.data.get(String(key))));
          },
          getAll() {
            return makeReq(() => Array.from(meta.data.values(), clone));
          },
          delete(key) {
            return makeReq(() => {
              meta.data.delete(String(key));
              return undefined;
            });
          },
          clear() {
            return makeReq(() => {
              meta.data.clear();
              return undefined;
            });
          },
        };
      };
      return tx;
    },
    close() {},
  };

  return {
    _stores: stores,
    open(_name, _version) {
      const req = { result: db, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => {
        if (stores.size === 0) req.onupgradeneeded?.({ target: req });
        req.onsuccess?.({ target: req });
      });
      return req;
    },
  };
}

/* ── 1. BookmarkStore Tests ──────────────────────────────────── */
{
  const events = [];
  const onChangeEvents = [];
  const bm = new BookmarkStore({ onChange: (e) => onChangeEvents.push(e) });
  const unsub = bm.subscribe((e) => events.push(e));

  // BigInt addresses > 2^53 must not collide!
  const hiA = 0x1000000000000101n; // > 2^53
  const hiB = 0x1000000000000102n; // > 2^53, distinct only in low bit

  assert.equal(bm.count, 0);
  assert.equal(bm.toggle(hiA, { name: 'fn_high_a', note: 'entry', tag: 'crypto' }), true);
  assert.equal(bm.toggle(hiB, { name: 'fn_high_b' }), true);
  assert.equal(bm.count, 2);
  assert.equal(bm.has(hiA), true);
  assert.equal(bm.has(hiB), true);
  assert.equal(bm.has(hiA.toString()), true);
  assert.equal(bm.get(hiA).addr, hiA);
  assert.equal(bm.get(hiB).addr, hiB);
  assert.equal(bm.get(hiA).name, 'fn_high_a');
  assert.equal(bm.get(hiA).note, 'entry');
  assert.equal(bm.get(hiA).tag, 'crypto');

  // setNote updates existing and creates missing
  const updated = bm.setNote(hiA, { note: 'updated note', tag: 'auth' });
  assert.equal(updated.note, 'updated note');
  assert.equal(updated.tag, 'auth');
  assert.equal(bm.get(hiA).note, 'updated note');

  const hiC = 0x2000000000000005n;
  bm.setNote(hiC, { note: 'auto-created', tag: 'net' });
  assert.equal(bm.has(hiC), true);
  assert.equal(bm.count, 3);

  // toggle removes existing
  assert.equal(bm.toggle(hiB), false);
  assert.equal(bm.has(hiB), false);
  assert.equal(bm.count, 2);

  // remove
  assert.equal(bm.remove(hiC), true);
  assert.equal(bm.remove(hiC), false);
  assert.equal(bm.count, 1);

  // list() & restore()
  const exported = bm.list();
  assert.equal(exported.length, 1);
  assert.equal(exported[0].addr, hiA);

  bm.clear();
  assert.equal(bm.count, 0);
  bm.restore(exported);
  assert.equal(bm.count, 1);
  assert.equal(bm.get(hiA).note, 'updated note');

  // subscribers & onChange fired
  assert.ok(events.length >= 6);
  assert.equal(onChangeEvents.length, events.length);
  unsub();
  const prevLen = events.length;
  bm.toggle(0x1000n);
  assert.equal(events.length, prevLen, 'unsubscribed listener must not fire');

  // 500-entry cap enforcement
  const capped = new BookmarkStore();
  for (let i = 0; i < MAX_BOOKMARKS + 25; i++) {
    capped.toggle(BigInt(0x1000 + i * 4), { name: `fn_${i}` });
  }
  assert.equal(capped.count, MAX_BOOKMARKS);
  assert.equal(capped.has(0x1000n), false, 'oldest bookmark should be evicted past 500 cap');
  assert.equal(capped.has(BigInt(0x1000 + (MAX_BOOKMARKS + 24) * 4)), true);
}

/* ── 2. makeDeltaKey & countDeltaItems ───────────────────────── */
{
  const k1 = makeDeltaKey({ sha256: 'AABBCCDD', sliceIndex: 0, architecture: 'arm64' });
  const k2 = makeDeltaKey({ sha256: 'aabbccdd', sliceIndex: 0, architecture: 'ARM64' });
  const k3 = makeDeltaKey({ sha256: 'aabbccdd', sliceIndex: 1, architecture: 'x86_64' });
  assert.equal(k1, k2, 'makeDeltaKey must normalize case');
  assert.notEqual(k1, k3, 'different slices must produce distinct deltaKeys');
  assert.equal(makeDeltaKey({}), null);

  const count = countDeltaItems({
    names: { '4096': 'main', '4100': 'helper' },
    comments: { '4096': 'entry' },
    vars: { '4096:v0': 'hp' },
    types: { '4096:ret': 'int' },
    structs: [{ name: 'Player', fields: [] }],
    bookmarks: [{ addr: 4096n }],
    patches: [{ offset: 16n, before: [0], after: [1] }],
    projectAnnotations: [{ id: 'a1' }],
  });
  assert.equal(count, 9);
}

/* ── 3. serializeDeltaJson / parseDeltaJson & Zero-Bloat ─────── */
{
  const bigAddr1 = 0x1000000000000123n; // > 2^53
  const bigAddr2 = 0x1000000000000125n; // > 2^53
  const payloadWithBloat = {
    format: DELTA_SESSION_FORMAT,
    version: DELTA_SESSION_VERSION,
    fingerprint: {
      sha256: 'deadbeef0123456789abcdef',
      name: 'GameApp',
      size: 12345678,
      format: 'macho',
      sliceIndex: 0,
      uuid: 'UUID-1',
      architecture: 'arm64',
    },
    updatedAt: 1700000000000,
    // Banned bloat fields that MUST be stripped:
    rawBytes: new Uint8Array([1, 2, 3, 4]),
    blob: { size: 9999999 },
    symbols: { funcs: [1, 2, 3] },
    programScan: { calls: [] },
    stringIndex: [{ text: 'secret' }],
    autoReport: { confirmed: [] },
    delta: {
      names: { [bigAddr1.toString()]: 'Player::takeDamage' },
      comments: { [bigAddr2.toString()]: 'checks shield' },
      vars: { [`${bigAddr1}:x0`]: 'self' },
      types: { [`${bigAddr1}:ret`]: 'void' },
      structs: [{ name: 'Player', size: 64 }],
      bookmarks: [{ addr: bigAddr1, name: 'Player::takeDamage', note: 'important', tag: 'combat', createdAt: 1700000000000 }],
      patches: [{ offset: bigAddr2, before: [0x1f, 0x20, 0x03, 0xd5], after: [0xc0, 0x03, 0x5f, 0xd6], addr: bigAddr2, label: 'ret', reason: 'bypass' }],
      projectAnnotations: [{ id: 'ann-1', text: 'verified' }],
    },
    resume: {
      lastAddress: bigAddr1,
      lastFunction: bigAddr1,
      lastRegionId: '__text',
      displayMode: 'asm',
      routePath: '/code',
      history: [{ key: '__text:1:asm', regionId: '__text', addr: bigAddr2, mode: 'asm', label: 'shield' }],
      historyIndex: 0,
      lastGoal: { text: 'find damage' },
    },
  };

  const json = serializeDeltaJson(payloadWithBloat);
  const rawObj = JSON.parse(json);

  // Zero-bloat assertion
  assert.equal('rawBytes' in rawObj, false);
  assert.equal('blob' in rawObj, false);
  assert.equal('symbols' in rawObj, false);
  assert.equal('programScan' in rawObj, false);
  assert.equal('stringIndex' in rawObj, false);
  assert.equal('autoReport' in rawObj, false);
  assert.deepEqual(
    Object.keys(rawObj).sort(),
    ['delta', 'fingerprint', 'format', 'resume', 'savedCount', 'updatedAt', 'version'],
  );

  // Exact decimal string serialization in JSON
  assert.equal(rawObj.resume.lastAddress, bigAddr1.toString());
  assert.equal(rawObj.delta.bookmarks[0].addr, bigAddr1.toString());
  assert.equal(rawObj.delta.patches[0].offset, bigAddr2.toString());

  // parseDeltaJson matching hash
  const parsedOk = parseDeltaJson(json, 'DEADBEEF0123456789ABCDEF');
  assert.equal(parsedOk.ok, true);
  assert.equal(parsedOk.hashMismatch, false);
  assert.equal(parsedOk.error, null);
  assert.equal(parsedOk.record.resume.lastAddress, bigAddr1);
  assert.equal(parsedOk.record.delta.bookmarks[0].addr, bigAddr1);
  assert.equal(parsedOk.record.delta.patches[0].offset, bigAddr2);
  assert.equal(parsedOk.record.resume.history[0].addr, bigAddr2);
  assert.equal(parsedOk.record.savedCount, 8);

  // parseDeltaJson hashMismatch detection
  const parsedMismatch = parseDeltaJson(json, '000000000000000000000000');
  assert.equal(parsedMismatch.ok, true);
  assert.equal(parsedMismatch.hashMismatch, true);

  // parseDeltaJson invalid inputs
  assert.equal(parseDeltaJson('{bad json').ok, false);
  assert.equal(parseDeltaJson(JSON.stringify({ format: 'wrong', version: 1, delta: {} })).ok, false);
  assert.equal(parseDeltaJson(JSON.stringify({ format: DELTA_SESSION_FORMAT, version: 99, delta: {} })).ok, false);
  assert.equal(parseDeltaJson('x'.repeat(MAX_DELTA_ENTRY_BYTES + 10)).ok, false);
}

/* ── 4. DeltaSessionStore (localStorage fallback + guards + LRU) */
{
  const ls = createMemoryLocalStorage();
  ls.setItem('unrelated.app.key', 'keep-me');
  const store = new DeltaSessionStore({ indexedDB: null, localStorage: ls });

  const bigAddr = 0x3000000000000077n; // > 2^53
  const fp1 = { sha256: 'hash_a', name: 'Alpha.bin', size: 1000, format: 'elf', sliceIndex: 0, architecture: 'arm64' };
  const key1 = makeDeltaKey(fp1);

  const ok = await store.save(key1, {
    fingerprint: fp1,
    updatedAt: 1000,
    rawBytes: new Uint8Array(64),
    delta: {
      names: { [bigAddr.toString()]: 'alpha_main' },
      bookmarks: [{ addr: bigAddr, name: 'alpha_main', note: 'start', tag: 'entry', createdAt: 1000 }],
    },
    resume: {
      lastAddress: bigAddr,
      displayMode: 'asm',
      routePath: '/functions',
    },
  });
  assert.equal(ok, true);

  // Verify raw localStorage has zero bloat
  const rawStored = JSON.parse(ls.getItem(`hex.delta.v1.${key1}`));
  assert.equal('rawBytes' in rawStored, false);
  assert.equal(rawStored.resume.lastAddress, bigAddr.toString());

  // Load back & verify BigInt > 2^53 round-trip
  const loaded = await store.load(key1);
  assert.ok(loaded);
  assert.equal(loaded.resume.lastAddress, bigAddr);
  assert.equal(loaded.delta.bookmarks[0].addr, bigAddr);
  assert.equal(loaded.delta.names[bigAddr.toString()], 'alpha_main');
  assert.equal(loaded.savedCount, 2);

  // 512 KiB per-binary size guard
  const hugeComments = {};
  for (let i = 0; i < 1500; i++) {
    hugeComments[String(0x1000 + i * 4)] = 'A'.repeat(450);
  }
  const tooBigOk = await store.save('huge_key', {
    fingerprint: { sha256: 'huge', name: 'Huge.bin', size: 10 },
    delta: { comments: hugeComments },
  });
  assert.equal(tooBigOk, false);
  assert.equal(store.lastError?.code, 'ENTRY_TOO_LARGE');

  // listRecent sorting & onlyWithDelta filter
  const fp2 = { sha256: 'hash_b', name: 'Beta.bin', size: 2000, format: 'macho', sliceIndex: 0, architecture: 'arm64' };
  const fp3 = { sha256: 'hash_c', name: 'Gamma.bin', size: 3000, format: 'pe', sliceIndex: 0, architecture: 'x86_64' };
  const key2 = makeDeltaKey(fp2);
  const key3 = makeDeltaKey(fp3);

  await store.save(key2, { fingerprint: fp2, updatedAt: 3000, delta: {} }); // savedCount = 0
  await store.save(key3, { fingerprint: fp3, updatedAt: 2000, delta: { names: { '4096': 'gamma' } } });

  const allRecents = await store.listRecent({ onlyWithDelta: false, limit: 10 });
  assert.deepEqual(allRecents.map((r) => r.name), ['Beta.bin', 'Gamma.bin', 'Alpha.bin']);

  const withDeltaOnly = await store.listRecent({ onlyWithDelta: true, limit: 10 });
  assert.deepEqual(withDeltaOnly.map((r) => r.name), ['Gamma.bin', 'Alpha.bin']);

  // remove()
  await store.remove(key3);
  assert.equal(await store.load(key3), null);
  const afterRemove = await store.listRecent({ onlyWithDelta: false, limit: 10 });
  assert.deepEqual(afterRemove.map((r) => r.name), ['Beta.bin', 'Alpha.bin']);

  // LRU eviction when total budget is approached
  const smallBudgetStore = new DeltaSessionStore({
    indexedDB: null,
    localStorage: createMemoryLocalStorage(),
    maxEntryBytes: 10 * 1024,
    maxTotalBytes: 12 * 1024,
  });
  const makeChunkDelta = (label, ts) => {
    const comments = {};
    for (let i = 0; i < 12; i++) comments[String(0x1000 + i * 4)] = `${label}-${'X'.repeat(300)}`;
    return {
      fingerprint: { sha256: `sha_${label}`, name: `${label}.bin`, size: 100 },
      updatedAt: ts,
      delta: { comments },
    };
  };
  assert.equal(await smallBudgetStore.save('lru_1', makeChunkDelta('one', 100)), true);
  assert.equal(await smallBudgetStore.save('lru_2', makeChunkDelta('two', 200)), true);
  assert.equal(await smallBudgetStore.save('lru_3', makeChunkDelta('three', 300)), true);
  // Oldest ('lru_1') must have been evicted to stay within maxTotalBytes
  assert.equal(await smallBudgetStore.load('lru_1'), null, 'oldest entry must be LRU-evicted');
  assert.ok(await smallBudgetStore.load('lru_3'), 'newest entry must remain');

  // clearAll preserves unrelated localStorage keys
  await store.clearAll();
  assert.equal(await store.load(key1), null);
  assert.equal(ls.getItem('unrelated.app.key'), 'keep-me');
}

/* ── 5. DeltaSessionStore (Mock IndexedDB + 25-recent cap) ───── */
{
  const mockIdb = createMockIndexedDB();
  const ls = createMemoryLocalStorage();
  const store = new DeltaSessionStore({ indexedDB: mockIdb, localStorage: ls });

  const bigAddr = 0x7ffffffffffff123n; // > 2^53
  const fp = { sha256: 'idb_hash_1', name: 'IdbApp', size: 4096, format: 'macho', sliceIndex: 0, architecture: 'arm64' };
  const key = makeDeltaKey(fp);

  assert.equal(await store.save(key, {
    fingerprint: fp,
    updatedAt: 5000,
    delta: {
      names: { [bigAddr.toString()]: 'idb_fn' },
      bookmarks: [{ addr: bigAddr, name: 'idb_fn', note: 'idb note', tag: 'idb', createdAt: 5000 }],
    },
    resume: { lastAddress: bigAddr, routePath: '/code' },
  }), true);

  // Verify it wrote to IndexedDB, NOT localStorage
  assert.equal(ls.getItem(`hex.delta.v1.${key}`), null);
  const loaded = await store.load(key);
  assert.ok(loaded);
  assert.equal(loaded.resume.lastAddress, bigAddr);
  assert.equal(loaded.delta.bookmarks[0].addr, bigAddr);

  // Verify 25 recent cap pruning in IDB
  for (let i = 0; i < 30; i++) {
    const k = `idb_cap_${i}`;
    await store.save(k, {
      fingerprint: { sha256: k, name: `App_${i}`, size: 100 + i },
      updatedAt: 10000 + i,
      delta: { names: { '4096': `fn_${i}` } },
    });
  }
  const recents = await store.listRecent({ onlyWithDelta: true, limit: 50 });
  assert.equal(recents.length, 25, 'IDB recents must be capped at 25');
  assert.equal(recents[0].name, 'App_29', 'newest binary must be first');
  assert.equal(recents[24].name, 'App_5', 'oldest kept binary must be App_5');
  assert.equal(await store.load('idb_cap_0'), null, 'pruned binary session must be deleted');

  // remove & clearAll in IDB
  await store.remove('idb_cap_29');
  assert.equal(await store.load('idb_cap_29'), null);
  await store.clearAll();
  assert.deepEqual(await store.listRecent({ onlyWithDelta: false, limit: 10 }), []);
}

/* ── 6. NoteStore.onChange hook (js/names.js) ────────────────── */
{
  const prevLS = globalThis.localStorage;
  globalThis.localStorage = createMemoryLocalStorage();
  try {
    const notes = new NoteStore('delta-onchange-test');
    const seen = [];
    notes.setOnChange((ev) => seen.push(ev.kind));
    notes.setName(0x1000n, 'myFunc');
    notes.setComment(0x1000n, 'note here');
    notes.setVarName(0x1000n, 'x0', 'ctx');
    notes.setType(0x1000n, 'ret', 'int');
    notes.save();
    notes.clear();
    assert.ok(seen.includes('name'));
    assert.ok(seen.includes('comment'));
    assert.ok(seen.includes('var'));
    assert.ok(seen.includes('type'));
    assert.ok(seen.includes('save'));
    assert.ok(seen.includes('clear'));
  } finally {
    globalThis.localStorage = prevLS;
  }
}

/* ── 7. C1: _saveLocalStorage evict-then-fail prunes recents ── */
{
  // (a1) Evict existing entries then fail with TOTAL_QUOTA_EXCEEDED
  const ls1 = createMemoryLocalStorage();
  const store1 = new DeltaSessionStore({
    indexedDB: null,
    localStorage: ls1,
    maxEntryBytes: 10 * 1024,
    maxTotalBytes: 2 * 1024,
  });
  const ok1 = await store1.save('evict_fail_old', {
    fingerprint: { sha256: 'sha_old', name: 'Old.bin', size: 100 },
    updatedAt: 100,
    delta: { names: { '4096': 'old_fn' } },
  });
  assert.equal(ok1, true);
  assert.equal((await store1.listRecent({ onlyWithDelta: false, limit: 10 })).length, 1);

  // Entry larger than maxTotalBytes (2 KiB) but smaller than maxEntryBytes (10 KiB)
  const bigComments = {};
  for (let i = 0; i < 10; i++) bigComments[String(0x1000 + i * 4)] = 'Z'.repeat(300);
  const ok2 = await store1.save('evict_fail_big', {
    fingerprint: { sha256: 'sha_big', name: 'Big.bin', size: 200 },
    updatedAt: 200,
    delta: { comments: bigComments },
  });
  assert.equal(ok2, false);
  assert.equal(store1.lastError?.code, 'TOTAL_QUOTA_EXCEEDED');
  assert.equal(await store1.load('evict_fail_old'), null, 'victim entry should be evicted');
  const recentsAfterTotalFail = await store1.listRecent({ onlyWithDelta: false, limit: 10 });
  assert.deepEqual(recentsAfterTotalFail, [], 'evicted entry must be pruned from listRecent() after TOTAL_QUOTA_EXCEEDED');

  // (a2) Evict existing entries then fail with QuotaExceededError (evictable.length === 0)
  const ls2 = createMemoryLocalStorage({ quotaBytes: 2200 });
  const store2 = new DeltaSessionStore({
    indexedDB: null,
    localStorage: ls2,
    maxEntryBytes: 10 * 1024,
    maxTotalBytes: 10 * 1024,
  });
  assert.equal(await store2.save('quota_old', {
    fingerprint: { sha256: 'sha_q_old', name: 'QuotaOld.bin', size: 100 },
    updatedAt: 100,
    delta: { names: { '4096': 'q_old' } },
  }), true);
  assert.equal((await store2.listRecent({ onlyWithDelta: false, limit: 10 })).length, 1);

  const okQuota = await store2.save('quota_new', {
    fingerprint: { sha256: 'sha_q_new', name: 'QuotaNew.bin', size: 200 },
    updatedAt: 200,
    delta: { comments: bigComments },
  });
  assert.equal(okQuota, false);
  assert.equal(store2.lastError?.code, 'QuotaExceededError');
  assert.equal(await store2.load('quota_old'), null, 'victim entry should be evicted during quota retry');
  const recentsAfterQuotaFail = await store2.listRecent({ onlyWithDelta: false, limit: 10 });
  assert.deepEqual(recentsAfterQuotaFail, [], 'evicted entry must be pruned from listRecent() after QuotaExceededError');
}

/* ── 8. C3: resume UI fields round-trip & invalid rejection ─── */
{
  const ls = createMemoryLocalStorage();
  const store = new DeltaSessionStore({ indexedDB: null, localStorage: ls });
  const fp = { sha256: 'ui_resume_hash', name: 'UiResume.bin', size: 512 };
  const key = makeDeltaKey(fp);

  // Valid values round-trip via DeltaSessionStore + JSON serialize/parse
  const payload = {
    fingerprint: fp,
    updatedAt: 7000,
    delta: { names: { '4096': 'fn_ui' } },
    resume: {
      explorerFilter: 'saved',
      explorerSort: 'priority',
      lastFunctionTab: 'pseudocode',
    },
  };
  assert.equal(await store.save(key, payload), true);
  const loaded = await store.load(key);
  assert.equal(loaded.version, DELTA_SESSION_VERSION);
  assert.equal(loaded.resume.explorerFilter, 'saved');
  assert.equal(loaded.resume.explorerSort, 'priority');
  assert.equal(loaded.resume.lastFunctionTab, 'pseudocode');

  const parsed = parseDeltaJson(serializeDeltaJson(payload));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.record.resume.explorerFilter, 'saved');
  assert.equal(parsed.record.resume.explorerSort, 'priority');
  assert.equal(parsed.record.resume.lastFunctionTab, 'pseudocode');

  // Invalid values rejected -> normalized to defaults
  const badPayload = {
    fingerprint: fp,
    updatedAt: 7001,
    delta: {},
    resume: {
      explorerFilter: 'invalid_filter',
      explorerSort: 'random_sort',
      lastFunctionTab: 'unknown_tab',
    },
  };
  const parsedBad = parseDeltaJson(serializeDeltaJson(badPayload));
  assert.equal(parsedBad.ok, true);
  assert.equal(parsedBad.record.resume.explorerFilter, 'all');
  assert.equal(parsedBad.record.resume.explorerSort, 'address');
  assert.equal(parsedBad.record.resume.lastFunctionTab, null);

  // Legacy v1 JSON without UI fields defaults cleanly
  const legacyJson = JSON.stringify({
    format: DELTA_SESSION_FORMAT,
    version: DELTA_SESSION_VERSION,
    fingerprint: fp,
    delta: {},
    resume: { displayMode: 'asm' },
  });
  const parsedLegacy = parseDeltaJson(legacyJson);
  assert.equal(parsedLegacy.ok, true);
  assert.equal(parsedLegacy.record.resume.explorerFilter, 'all');
  assert.equal(parsedLegacy.record.resume.explorerSort, 'address');
  assert.equal(parsedLegacy.record.resume.lastFunctionTab, null);
}

/* ── 9. C2: NoteStore.subscribe coexists with onChange ──────── */
{
  const prevLS = globalThis.localStorage;
  globalThis.localStorage = createMemoryLocalStorage();
  try {
    const notes = new NoteStore('delta-subscribe-test');
    const onChangeKinds = [];
    const sub1Kinds = [];
    const sub2Kinds = [];

    notes.setOnChange((ev) => onChangeKinds.push(ev.kind));
    const unsub1 = notes.subscribe((ev) => sub1Kinds.push(ev.kind));
    // Throwing subscriber must be isolated and not block other subscribers
    const unsubThrow = notes.subscribe(() => { throw new Error('boom'); });
    const unsub2 = notes.subscribe((ev) => sub2Kinds.push(ev.kind));

    notes.setName(0x2000n, 'alpha');
    notes.setComment(0x2000n, 'note');
    assert.deepEqual(onChangeKinds, ['save', 'name', 'comment']);
    assert.deepEqual(sub1Kinds, ['save', 'name', 'comment']);
    assert.deepEqual(sub2Kinds, ['save', 'name', 'comment']);

    // Unsubscribe sub1; onChange and sub2 still fire
    unsub1();
    unsubThrow();
    notes.setVarName(0x2000n, 'x0', 'self');
    assert.deepEqual(sub1Kinds, ['save', 'name', 'comment']);
    assert.deepEqual(onChangeKinds, ['save', 'name', 'comment', 'var']);
    assert.deepEqual(sub2Kinds, ['save', 'name', 'comment', 'var']);

    // Works even when onChange is null
    notes.setOnChange(null);
    notes.setType(0x2000n, 'ret', 'void');
    assert.deepEqual(sub2Kinds, ['save', 'name', 'comment', 'var', 'type']);
    unsub2();
  } finally {
    globalThis.localStorage = prevLS;
  }
}

console.log('delta-session tests: PASS');
