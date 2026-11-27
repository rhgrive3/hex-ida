import assert from 'node:assert/strict';

import {
  HexDbWal,
  WAL_OP_PUT,
  WAL_OP_DEL,
  WAL_OP_CHECKPOINT,
  crc32,
  crc32c,
  encodeWalFrame,
  decodeWalStream,
  buildWalOverlayIndex,
} from '../js/cache/hexdb/hexdb-wal.js';

import {
  HexDbMemoryBackend,
  HEXDB_SHARD_HEADER_SIZE,
  HEXDB_SHARD_NAMES,
  encodeShardHeader64,
  decodeShardHeader64,
} from '../js/cache/hexdb/hexdb-memory.js';

import {
  HexDbOpfsBackend,
  OPFS_CHECKPOINT_SLOT_SIZE,
  OPFS_CHECKPOINT_FILENAME,
  OPFS_WAL_FILENAME,
} from '../js/cache/hexdb/hexdb-opfs.js';

import { HexDbIdbBackend } from '../js/cache/hexdb/hexdb-idb.js';

import {
  HexDbConverger,
  CONVERGER_STATE,
  CONVERGER_PRIORITY,
} from '../js/cache/hexdb/hexdb-converger.js';

import { HexDbWorkerHost, HEXDB_RPC_CANCEL } from '../js/cache/hexdb/hexdb-worker.js';
import { HexDbClient } from '../js/cache/hexdb/hexdb-client.js';

import {
  PROFILE_ID_MOBILE_256M,
  PROFILE_ID_DESKTOP_HIGH,
  HEX_FIXED_SLOTS_TOTAL_BYTES,
  CPP_HEX_RUNTIME_LIMITS_BYTE_LENGTH,
  HEX_RUNTIME_LIMITS_BYTE_LENGTH,
  MOBILE_CPP_RUNTIME_LIMITS,
  DESKTOP_CPP_RUNTIME_LIMITS,
  MOBILE_HEX_RUNTIME_LIMITS,
  DESKTOP_HEX_RUNTIME_LIMITS,
  detectRuntimeProfile,
  getRuntimeProfile,
  packCppHexRuntimeLimits,
  unpackCppHexRuntimeLimits,
  packHexRuntimeLimits,
  unpackHexRuntimeLimits,
} from '../js/core/budgets/runtime-profile.js';

import {
  MemoryBudget,
  PRESSURE_NORMAL,
  PRESSURE_SOFT,
  PRESSURE_HARD,
  PRESSURE_EMERGENCY,
  MEMORY_CATEGORY_WASM,
  MEMORY_CATEGORY_JS_CACHE,
  MEMORY_CATEGORY_HEXDB,
} from '../js/core/budgets/memory-budget.js';

const ENC = new TextEncoder();
const DEC = new TextDecoder();

// ---------------------------------------------------------------------------
// Minimal deterministic mocks for OPFS and IndexedDB
// ---------------------------------------------------------------------------

function createMockOpfsRoot({ onOp = null, failQuotaOnWrite = false } = {}) {
  const dirs = new Map();
  let syncOpenCount = 0;

  function makeDir(path) {
    if (dirs.has(path)) return dirs.get(path);
    const files = new Map();
    const subdirs = new Map();

    const dirHandle = {
      name: path,
      files,
      subdirs,
      get syncOpenCount() {
        return syncOpenCount;
      },
      async getDirectoryHandle(name, { create = false } = {}) {
        if (subdirs.has(name)) return subdirs.get(name);
        if (!create) throw new Error(`NotFoundError: ${name}`);
        const sub = makeDir(`${path}/${name}`);
        subdirs.set(name, sub);
        return sub;
      },
      async getFileHandle(name, { create = false } = {}) {
        if (!files.has(name)) {
          if (!create) throw new Error(`NotFoundError: ${name}`);
          files.set(name, { data: new Uint8Array(0) });
        }
        const entry = files.get(name);
        return {
          name,
          async createSyncAccessHandle() {
            syncOpenCount += 1;
            let closed = false;
            return {
              getSize() {
                if (closed) throw new Error('InvalidStateError: handle closed');
                return entry.data.byteLength;
              },
              read(buf, { at = 0 } = {}) {
                if (closed) throw new Error('InvalidStateError: handle closed');
                const view = buf instanceof Uint8Array
                  ? buf
                  : new Uint8Array(buf.buffer ?? buf, buf.byteOffset ?? 0, buf.byteLength);
                const avail = Math.max(0, entry.data.byteLength - at);
                const len = Math.min(view.byteLength, avail);
                view.set(entry.data.subarray(at, at + len), 0);
                return len;
              },
              write(buf, { at = 0 } = {}) {
                if (closed) throw new Error('InvalidStateError: handle closed');
                onOp?.({ op: 'write', file: name, at, len: buf.byteLength });
                if (failQuotaOnWrite && name === OPFS_WAL_FILENAME) {
                  const err = new Error('Disk full');
                  err.name = 'QuotaExceededError';
                  throw err;
                }
                const view = buf instanceof Uint8Array
                  ? buf
                  : new Uint8Array(buf.buffer ?? buf, buf.byteOffset ?? 0, buf.byteLength);
                const needed = at + view.byteLength;
                if (needed > entry.data.byteLength) {
                  const next = new Uint8Array(needed);
                  next.set(entry.data, 0);
                  entry.data = next;
                }
                entry.data.set(view, at);
                return view.byteLength;
              },
              truncate(size) {
                if (closed) throw new Error('InvalidStateError: handle closed');
                onOp?.({ op: 'truncate', file: name, size });
                if (size === 0) {
                  entry.data = new Uint8Array(0);
                } else if (size < entry.data.byteLength) {
                  entry.data = entry.data.slice(0, size);
                } else if (size > entry.data.byteLength) {
                  const next = new Uint8Array(size);
                  next.set(entry.data, 0);
                  entry.data = next;
                }
              },
              flush() {
                if (closed) throw new Error('InvalidStateError: handle closed');
                onOp?.({ op: 'flush', file: name });
              },
              close() {
                closed = true;
              },
            };
          },
        };
      },
    };
    dirs.set(path, dirHandle);
    return dirHandle;
  }

  return makeDir('');
}

function createMockIndexedDB({ failQuotaCount = 0, failOnStore = null } = {}) {
  const databases = new Map();
  let quotaRemainingFailures = failQuotaCount;
  let activeFailStore = failOnStore;

  function makeReq(executor) {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
    queueMicrotask(() => {
      try {
        executor(req);
      } catch (err) {
        req.error = err;
        req.onerror?.({ target: req });
      }
    });
    return req;
  }

  const factory = {
    setFailOnStore(storeName) {
      activeFailStore = storeName;
    },
    setQuotaFailures(n) {
      quotaRemainingFailures = n;
    },
    open(name, version = 1) {
      return makeReq((req) => {
        let dbState = databases.get(name);
        let needsUpgrade = false;
        if (!dbState) {
          dbState = { name, version, stores: new Map() };
          databases.set(name, dbState);
          needsUpgrade = true;
        }
        const db = {
          name,
          version: dbState.version,
          objectStoreNames: {
            contains: (s) => dbState.stores.has(s),
          },
          createObjectStore(storeName, opts = {}) {
            if (!dbState.stores.has(storeName)) {
              dbState.stores.set(storeName, { keyPath: opts.keyPath || 'id', data: new Map() });
            }
            return dbState.stores.get(storeName);
          },
          transaction(storeNames, mode = 'readonly') {
            const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
            let failed = false;
            const pendingWrites = [];
            const failTx = (err) => {
              if (failed) return;
              failed = true;
              tx.error = err;
              queueMicrotask(() => tx.onerror?.({ target: tx }));
            };

            queueMicrotask(() => {
              if (!failed) {
                for (const fn of pendingWrites) fn();
                tx.oncomplete?.({ target: tx });
              }
            });

            tx.objectStore = (storeName) => {
              const st = dbState.stores.get(storeName);
              if (!st) throw new Error(`NotFoundError: store ${storeName}`);
              return {
                put(record) {
                  if (mode === 'readwrite' && activeFailStore === storeName) {
                    const err = new Error(`Simulated tx failure on ${storeName}`);
                    err.name = 'AbortError';
                    failTx(err);
                    return { onsuccess: null, onerror: null };
                  }
                  if (mode === 'readwrite' && quotaRemainingFailures > 0) {
                    quotaRemainingFailures -= 1;
                    const err = new Error('Simulated QuotaExceededError');
                    err.name = 'QuotaExceededError';
                    failTx(err);
                    return { onsuccess: null, onerror: null };
                  }
                  const key = record[st.keyPath];
                  const cloned = structuredClone(record);
                  pendingWrites.push(() => st.data.set(key, cloned));
                  return makeReq((r) => {
                    r.result = key;
                    r.onsuccess?.({ target: r });
                  });
                },
                delete(key) {
                  pendingWrites.push(() => st.data.delete(key));
                  return makeReq((r) => {
                    r.result = undefined;
                    r.onsuccess?.({ target: r });
                  });
                },
                get(key) {
                  return makeReq((r) => {
                    const val = st.data.get(key);
                    r.result = val !== undefined ? structuredClone(val) : undefined;
                    r.onsuccess?.({ target: r });
                  });
                },
                getAll() {
                  return makeReq((r) => {
                    r.result = [...st.data.values()].map((v) => structuredClone(v));
                    r.onsuccess?.({ target: r });
                  });
                },
              };
            };
            return tx;
          },
          close() {},
        };

        req.result = db;
        if (needsUpgrade && req.onupgradeneeded) {
          req.onupgradeneeded({ target: req });
        }
        req.onsuccess?.({ target: req });
      });
    },
  };
  return factory;
}

function createMockWorkerPair(host, { delayMs = 0 } = {}) {
  const listeners = new Map([
    ['message', new Set()],
    ['error', new Set()],
    ['messageerror', new Set()],
  ]);
  let terminated = false;

  const worker = {
    get terminated() {
      return terminated;
    },
    get listenerCounts() {
      return {
        message: listeners.get('message').size,
        error: listeners.get('error').size,
        messageerror: listeners.get('messageerror').size,
      };
    },
    emitMessageError() {
      for (const fn of listeners.get('messageerror')) {
        fn({ type: 'messageerror' });
      }
    },
    addEventListener(type, fn) {
      listeners.get(type)?.add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    postMessage(msg) {
      if (terminated) throw new Error('Worker terminated');
      const cloned = structuredClone(msg);
      const deliver = () => {
        if (terminated) return;
        void host.handleMessage(cloned, (response) => {
          if (terminated) return;
          const respClone = structuredClone(response);
          for (const fn of listeners.get('message')) {
            fn({ data: respClone });
          }
        });
      };
      if (delayMs > 0) {
        setTimeout(deliver, delayMs);
      } else {
        queueMicrotask(deliver);
      }
    },
    terminate() {
      terminated = true;
    },
  };
  return worker;
}

// ---------------------------------------------------------------------------
// Test Runner
// ---------------------------------------------------------------------------

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ===========================================================================
// 1. WAL Tests
// ===========================================================================

test('WAL: CRC32 and CRC32C match standard IEEE/Castagnoli check vectors', () => {
  const check = ENC.encode('123456789');
  assert.equal(crc32(check), 0xcbf43926);
  assert.equal(crc32c(check), 0xe3069283);
});

test('WAL: monotonic LSN append, replay, Merge-on-Read overlay, and tombstones', () => {
  const wal = new HexDbWal();
  const r1 = wal.appendPut('func_table', '0x1000', ENC.encode('alpha'));
  const r2 = wal.appendPut('func_table', '0x2000', ENC.encode('beta'));
  const r3 = wal.appendPut('func_table', '0x1000', ENC.encode('alpha-v2'));
  const r4 = wal.appendDel('func_table', '0x2000');

  assert.equal(r1.lsn, 1);
  assert.equal(r2.lsn, 2);
  assert.equal(r3.lsn, 3);
  assert.equal(r4.lsn, 4);
  assert.equal(wal.lastLsn, 4);
  assert.equal(wal.nextLsn, 5);

  const raw = wal.exportBytes();
  const decoded = decodeWalStream(raw);
  assert.equal(decoded.corruptFrames, 0);
  assert.equal(decoded.truncatedTail, false);
  assert.equal(decoded.entries.length, 4);
  assert.equal(decoded.lastValidLsn, 4);

  const overlay = buildWalOverlayIndex(decoded.entries);
  const shard = overlay.get('func_table');
  assert.equal(DEC.decode(shard.get('0x1000').value), 'alpha-v2');
  assert.equal(shard.get('0x2000').op, WAL_OP_DEL);
  assert.equal(shard.get('0x2000').value, null);
});

test('WAL: corrupt-frame CRC32 mismatch and torn-tail crash recovery', () => {
  const wal = new HexDbWal();
  wal.appendPut('xref_code', 'k1', ENC.encode('val1'));
  wal.appendPut('xref_code', 'k2', ENC.encode('val2'));
  const validBytes = wal.exportBytes();

  const frame3 = encodeWalFrame({ lsn: 3, op: WAL_OP_PUT, shard: 'xref_code', key: 'k3', value: ENC.encode('val3') });
  frame3[frame3.byteLength - 6] ^= 0xff;
  const combinedCorrupt = new Uint8Array(validBytes.byteLength + frame3.byteLength);
  combinedCorrupt.set(validBytes, 0);
  combinedCorrupt.set(frame3, validBytes.byteLength);

  const walRecoverA = new HexDbWal();
  const resA = walRecoverA.replay(combinedCorrupt);
  assert.equal(resA.entries.length, 2);
  assert.equal(resA.lastValidLsn, 2);
  assert.equal(resA.corruptFrames, 1);
  assert.equal(resA.stopReason, 'crc32-mismatch');
  assert.equal(walRecoverA.byteLength, validBytes.byteLength);
  assert.equal(walRecoverA.nextLsn, 3);

  const frame3Valid = encodeWalFrame({ lsn: 3, op: WAL_OP_PUT, shard: 'xref_code', key: 'k3', value: ENC.encode('val3') });
  const torn = new Uint8Array(validBytes.byteLength + 12);
  torn.set(validBytes, 0);
  torn.set(frame3Valid.subarray(0, 12), validBytes.byteLength);

  const walRecoverB = new HexDbWal();
  const resB = walRecoverB.replay(torn);
  assert.equal(resB.entries.length, 2);
  assert.equal(resB.truncatedTail, true);
  assert.equal(resB.corruptFrames, 1);
  assert.equal(walRecoverB.byteLength, validBytes.byteLength);
});

test('WAL: checkpoint compaction builds single buffer before writing and preserves monotonic LSN', () => {
  const ops = [];
  let storage = new Uint8Array(0);
  const sink = {
    append(frame) {
      ops.push('append');
      const next = new Uint8Array(storage.byteLength + frame.byteLength);
      next.set(storage, 0);
      next.set(frame, storage.byteLength);
      storage = next;
    },
    readAll: () => storage,
    truncate(len) {
      ops.push(`truncate:${len}`);
      storage = storage.slice(0, len);
    },
    replace(buf) {
      ops.push(`replace:${buf.byteLength}`);
      storage = buf.slice();
    },
  };

  const wal = new HexDbWal({ maxBytes: 256, sink });
  for (let i = 0; i < 10; i++) {
    wal.appendPut('func_sig', `fn_${i}`, ENC.encode(`signature_payload_${i}`));
  }
  assert.equal(wal.needsCompaction(), true);
  const preBytes = wal.byteLength;
  const preLsn = wal.lastLsn;
  ops.length = 0;

  const compactRes = wal.compact({
    writeCheckpointMarker: true,
    retainEntries: [{ op: WAL_OP_PUT, shard: 'func_sig', key: 'retained', value: ENC.encode('keep') }],
  });
  // Must have called single-buffer `replace` and NEVER `truncate:0` first!
  assert.equal(ops.length, 1);
  assert.ok(ops[0].startsWith('replace:'));
  assert.equal(compactRes.compactedFromBytes, preBytes);
  assert.ok(compactRes.newBytes < preBytes);
  assert.equal(compactRes.checkpointLsn, preLsn + 1);
  assert.equal(wal.lastLsn, preLsn + 2);

  const replay = decodeWalStream(wal.exportBytes());
  assert.equal(replay.entries.length, 2);
  assert.equal(replay.entries[0].op, WAL_OP_CHECKPOINT);
  assert.equal(replay.entries[1].op, WAL_OP_PUT);
  assert.equal(replay.entries[1].key, 'retained');
});

// ===========================================================================
// 2. Memory Backend & Shard Header Tests
// ===========================================================================

test('MemoryBackend: HDB1 64B shard header round-trip and CRC32C tamper detection', () => {
  assert.equal(HEXDB_SHARD_NAMES.length, 9);
  const hdr = encodeShardHeader64({
    shardId: 3,
    entryCount: 42,
    dataBytes: 8192,
    dataCrc32c: 0x12345678,
    lsn: 99,
    sha256Prefix: 'deadbeef',
  });
  assert.equal(hdr.byteLength, HEXDB_SHARD_HEADER_SIZE);
  const decoded = decodeShardHeader64(hdr);
  assert.ok(decoded);
  assert.equal(decoded.shardId, 3);
  assert.equal(decoded.entryCount, 42);
  assert.equal(decoded.dataBytes, 8192);
  assert.equal(decoded.lsn, 99);

  hdr[10] ^= 0x01;
  assert.equal(decodeShardHeader64(hdr), null);
});

test('MemoryBackend: CRUD, batch, checkpoint, LRU eviction, degraded flag, and close', async () => {
  const store = new HexDbMemoryBackend({ maxBytes: 100 });
  await store.open({ binaryKey: 'sha256_abc|0|arm64' });

  await store.put('func_table', 'a', new Uint8Array(40).fill(1));
  await store.put('func_table', 'b', new Uint8Array(40).fill(2));
  const gotA = await store.get('func_table', 'a');
  assert.equal(gotA.byteLength, 40);

  const putC = await store.put('func_table', 'c', new Uint8Array(40).fill(3));
  assert.equal(putC.degraded, true);
  assert.equal(await store.get('func_table', 'b'), null);
  assert.ok(await store.get('func_table', 'a'));
  assert.ok(await store.get('func_table', 'c'));

  const batchRes = await store.batch([
    { op: 'del', shard: 'func_table', key: 'a' },
    { op: 'put', shard: 'callgraph', key: 'cg1', value: ENC.encode('edge') },
  ]);
  assert.equal(batchRes.applied, 2);
  assert.equal(await store.get('func_table', 'a'), null);
  assert.equal(DEC.decode(await store.get('callgraph', 'cg1')), 'edge');

  const ckpt = await store.checkpoint();
  assert.equal(ckpt.checkpointCount, 1);

  const st = await store.stats();
  assert.equal(st.tier, 'memory');
  assert.equal(st.degraded, true);
  assert.equal(st.complete, false);
  assert.ok(st.evictedCount >= 1);

  await store.close();
  await assert.rejects(() => store.get('callgraph', 'cg1'), /HEXDB_NOT_OPEN/);
});

// ===========================================================================
// 3. IDB-Mock Backend Tests + Round 1 Regression Tests
// ===========================================================================

test('IdbBackend: CRUD, WAL crash recovery, checkpoint, and QuotaExceededError protected-key LRU fallback', async () => {
  const mockIdb = createMockIndexedDB();
  const binaryKey = 'bin_idb_test|0|arm64';

  const idb1 = new HexDbIdbBackend({ indexedDB: mockIdb, binaryKey });
  await idb1.open();
  await idb1.put('func_sig', 'f1', ENC.encode('int f1(void)'));
  await idb1.batch([
    { op: 'put', shard: 'func_sig', key: 'f2', value: ENC.encode('void f2(int)') },
    { op: 'put', shard: 'xref_data', key: 'd1', value: ENC.encode('0x4000') },
  ]);
  await idb1.close();

  const idb2 = new HexDbIdbBackend({ indexedDB: mockIdb, binaryKey });
  const openRes = await idb2.open();
  assert.equal(openRes.tier, 'idb');
  assert.equal(openRes.recoveredEntries, 3);
  assert.equal(DEC.decode(await idb2.get('func_sig', 'f1')), 'int f1(void)');
  assert.equal(DEC.decode(await idb2.get('func_sig', 'f2')), 'void f2(int)');
  assert.equal(DEC.decode(await idb2.get('xref_data', 'd1')), '0x4000');

  const ckpt = await idb2.checkpoint();
  assert.equal(ckpt.checkpointCount, 1);
  await idb2.close();

  const idb3 = new HexDbIdbBackend({ indexedDB: mockIdb, binaryKey });
  const openRes3 = await idb3.open();
  assert.equal(openRes3.recoveredEntries, 0);
  assert.equal(DEC.decode(await idb3.get('func_sig', 'f1')), 'int f1(void)');
  await idb3.close();

  // QuotaExceededError recovery: evicts 'old' while protecting newly written 'new'.
  const failingFactory = createMockIndexedDB({ failQuotaCount: 1 });
  const qStore = new HexDbIdbBackend({ indexedDB: failingFactory, binaryKey: 'quota_test2' });
  await qStore.open();
  qStore._shards.set('hexsig', new Map([['old', ENC.encode('old_payload')]]));
  qStore._touchLru('hexsig', 'old', 11);
  qStore._totalBytes = 11;

  const putRes = await qStore.put('hexsig', 'new', ENC.encode('new_payload'));
  assert.equal(putRes.degraded, true);
  assert.equal(await qStore.get('hexsig', 'old'), null);
  assert.equal(DEC.decode(await qStore.get('hexsig', 'new')), 'new_payload');
  await qStore.close();
});

test('IdbBackend Regression: tx failure preserves WAL/dirtyKeys, 4MiB pre-check, and unrecoverable quota rollback', async () => {
  const mockIdb = createMockIndexedDB();
  const store = new HexDbIdbBackend({ indexedDB: mockIdb, binaryKey: 'idb_reg', shardMaxBytes: 128 });
  await store.open();

  // 1. 4 MiB (configured 128B) pre-check rejects BEFORE WAL append
  await assert.rejects(
    () => store.put('func_table', 'oversized', new Uint8Array(200)),
    (err) => err.code === 'HEXDB_SHARD_OVERFLOW'
  );
  assert.equal((await store.stats()).walLsn, 0);
  assert.equal(await store.get('func_table', 'oversized'), null);

  // Valid small put succeeds
  await store.put('func_table', 'k1', ENC.encode('v1'));
  const preWalBytes = (await store.stats()).walBytes;
  const preWalLsn = (await store.stats()).walLsn;

  // 2. Simulate checkpoint tx failure on 'meta' store -> WAL, checkpointCount, and dirtyKeys must remain untouched!
  mockIdb.setFailOnStore('meta');
  await assert.rejects(() => store.checkpoint(), /Simulated tx failure/);
  const afterFailStats = await store.stats();
  assert.equal(afterFailStats.checkpointCount, 0);
  assert.equal(afterFailStats.walBytes, preWalBytes);
  assert.equal(afterFailStats.walLsn, preWalLsn);
  assert.equal(store._dirtyKeys.size, 1);

  // Clear failure -> retry checkpoint succeeds cleanly
  mockIdb.setFailOnStore(null);
  const ck = await store.checkpoint();
  assert.equal(ck.checkpointCount, 1);
  assert.equal(store._dirtyKeys.size, 0);

  // 3. Unrecoverable QuotaExceededError (fails both initial + retry) rolls back memory + WAL!
  const beforeRollbackLsn = (await store.stats()).walLsn;
  mockIdb.setQuotaFailures(5);
  await assert.rejects(() => store.put('func_table', 'k2', ENC.encode('v2')), /QuotaExceededError/);
  assert.equal(await store.get('func_table', 'k2'), null);
  assert.equal((await store.stats()).walLsn, beforeRollbackLsn);
  mockIdb.setQuotaFailures(0);
  await store.close();
});

// ===========================================================================
// 4. OPFS-Mock Backend Tests + Round 1 Regression Tests
// ===========================================================================

test('OpfsBackend: crash-safe checkpoint ordering (shard -> checkpoint -> WAL replace) & replay LSN skip', async () => {
  const opLog = [];
  const rootDir = createMockOpfsRoot({ onOp: (ev) => opLog.push(ev) });
  const binaryKey = 'bin_opfs_order|0|arm64';

  const opfs1 = new HexDbOpfsBackend({ rootDir, binaryKey });
  await opfs1.open();
  await opfs1.put('func_table', '0x100', ENC.encode('main'));
  await opfs1.put('callgraph', '0x100->0x200', ENC.encode('call'));

  opLog.length = 0;
  const ck1 = await opfs1.checkpoint();
  assert.equal(ck1.checkpointGeneration, 1);
  assert.equal(ck1.checkpointLsn, 2);

  // Verify strict ordering: shard flush < checkpoint.bin flush < delta_wal.hdb write
  const shardFlushIdx = opLog.findIndex((e) => e.op === 'flush' && e.file === 'func_table.hdb');
  const ckptFlushIdx = opLog.findIndex((e) => e.op === 'flush' && e.file === OPFS_CHECKPOINT_FILENAME);
  const walWriteIdx = opLog.findIndex((e) => e.op === 'write' && e.file === OPFS_WAL_FILENAME);
  assert.ok(shardFlushIdx >= 0, 'shard must be flushed');
  assert.ok(ckptFlushIdx > shardFlushIdx, 'checkpoint slot must be flushed AFTER shards');
  assert.ok(walWriteIdx > ckptFlushIdx, 'WAL compaction must occur AFTER checkpoint slot flush');

  // Verify WAL was NEVER truncated to 0 before writing the new checkpoint marker
  const walTruncateZero = opLog.find((e) => e.op === 'truncate' && e.file === OPFS_WAL_FILENAME && e.size === 0);
  assert.equal(walTruncateZero, undefined);

  // Simulate crash right after step (2) before step (3): stale WAL still has LSN 1..2 (<= checkpointLsn 2)
  // plus a new uncommitted LSN 3 (> checkpointLsn 2).
  const walStale = new HexDbWal();
  walStale.appendPut('func_table', '0x100', ENC.encode('STALE_SHOULD_BE_SKIPPED')); // LSN 1 <= 2
  walStale.appendPut('callgraph', '0x100->0x200', ENC.encode('STALE_CG'));         // LSN 2 <= 2
  walStale.appendPut('func_table', '0x300', ENC.encode('fresh_after_ckpt'));       // LSN 3 > 2
  const storeDir = rootDir.subdirs.get('hex-db-v1').subdirs.get('bin_opfs_order_0_arm64');
  storeDir.files.get(OPFS_WAL_FILENAME).data = walStale.exportBytes();
  await opfs1.close();

  const opfs2 = new HexDbOpfsBackend({ rootDir, binaryKey });
  const open2 = await opfs2.open();
  assert.equal(open2.checkpointLsn, 2);
  assert.equal(open2.recoveredEntries, 1); // Only LSN 3 replayed; LSN 1..2 skipped!
  assert.equal(DEC.decode(await opfs2.get('func_table', '0x100')), 'main');
  assert.equal(DEC.decode(await opfs2.get('func_table', '0x300')), 'fresh_after_ckpt');
  await opfs2.close();
});

test('OpfsBackend Regression: A/B fallback, 4MiB pre-check before WAL append, and QuotaExceededError', async () => {
  const rootDir = createMockOpfsRoot();
  const binaryKey = 'bin_opfs_reg|0|arm64';

  const opfs1 = new HexDbOpfsBackend({ rootDir, binaryKey });
  await opfs1.open();
  await opfs1.put('func_table', '0x100', ENC.encode('main'));
  await opfs1.checkpoint(); // gen 1 (slot B)
  await opfs1.put('func_table', '0x200', ENC.encode('helper'));
  await opfs1.checkpoint(); // gen 2 (slot A)
  await opfs1.close();

  // Corrupt slot A -> falls back cleanly to slot B (gen 1)
  const storeDir = rootDir.subdirs.get('hex-db-v1').subdirs.get('bin_opfs_reg_0_arm64');
  storeDir.files.get(OPFS_CHECKPOINT_FILENAME).data[8] ^= 0xff;
  storeDir.files.get(OPFS_WAL_FILENAME).data = new Uint8Array(0);
  const opfs2 = new HexDbOpfsBackend({ rootDir, binaryKey });
  const open2 = await opfs2.open();
  assert.equal(open2.checkpointGeneration, 1);
  assert.equal(DEC.decode(await opfs2.get('func_table', '0x100')), 'main');
  await opfs2.close();

  // 4 MiB (configured 128B) pre-check in put() and batch() BEFORE WAL append -> no deadlock!
  const opfsSmall = new HexDbOpfsBackend({ rootDir, binaryKey: 'small_cap', shardMaxBytes: 128 });
  await opfsSmall.open();
  await assert.rejects(
    () => opfsSmall.put('func_table', 'huge', new Uint8Array(200).fill(7)),
    (err) => err.code === 'HEXDB_SHARD_OVERFLOW'
  );
  assert.equal((await opfsSmall.stats()).walLsn, 0);
  await assert.rejects(
    () => opfsSmall.batch([
      { op: 'put', shard: 'func_table', key: 'a', value: new Uint8Array(40) },
      { op: 'put', shard: 'func_table', key: 'b', value: new Uint8Array(40) },
    ]),
    (err) => err.code === 'HEXDB_SHARD_OVERFLOW'
  );
  assert.equal((await opfsSmall.stats()).walLsn, 0);
  // Store remains completely healthy after rejected overflow!
  await opfsSmall.put('func_table', 'ok', ENC.encode('fit'));
  await opfsSmall.checkpoint();
  assert.equal(DEC.decode(await opfsSmall.get('func_table', 'ok')), 'fit');
  await opfsSmall.close();

  // QuotaExceededError on OPFS write returns typed HEXDB_QUOTA_EXCEEDED
  const quotaRoot = createMockOpfsRoot({ failQuotaOnWrite: true });
  const opfsQuota = new HexDbOpfsBackend({ rootDir: quotaRoot, binaryKey: 'quota_opfs' });
  await opfsQuota.open();
  await assert.rejects(
    () => opfsQuota.put('func_table', 'k', ENC.encode('val')),
    (err) => err.code === 'HEXDB_QUOTA_EXCEEDED'
  );
  await opfsQuota.close();
});

// ===========================================================================
// 5. Worker RPC Host & Client Tests + Round 1 Regression Tests
// ===========================================================================

test('Worker RPC & Client: automatic tier selection, non-enumerable prototype navigator, and opaque origin fallback', async () => {
  // 1. Non-enumerable prototype `navigator` getter (real browser DedicatedWorkerGlobalScope pattern)
  const protoOpfsRoot = createMockOpfsRoot();
  const workerProto = {};
  Object.defineProperty(workerProto, 'navigator', {
    enumerable: false,
    get() {
      return {
        storage: {
          async getDirectory() {
            return protoOpfsRoot;
          },
        },
      };
    },
  });
  const workerEnv = Object.create(workerProto);
  const hostProtoOpfs = new HexDbWorkerHost({ env: workerEnv });
  const resProto = await hostProtoOpfs.dispatch('open', { binaryKey: 'proto_nav' });
  assert.equal(resProto.tier, 'opfs');
  await hostProtoOpfs.dispose();

  // 2. Opaque origin (`location.origin === 'null'`) immediately skips OPFS & IDB -> degrades to 'memory'
  const opaqueEnv = Object.create(workerProto);
  opaqueEnv.location = { origin: 'null' };
  const hostOpaque = new HexDbWorkerHost({
    env: opaqueEnv,
    opfsRoot: createMockOpfsRoot(),
    indexedDB: createMockIndexedDB(),
  });
  const resOpaque = await hostOpaque.dispatch('open', { binaryKey: 'opaque_sandbox' });
  assert.equal(resOpaque.tier, 'memory');
  await hostOpaque.dispose();

  // 3. Standard fallback chain: IDB when no OPFS, Memory when neither
  const hostIdb = new HexDbWorkerHost({ indexedDB: createMockIndexedDB(), env: {} });
  assert.equal((await hostIdb.dispatch('open', { binaryKey: 'tier_b' })).tier, 'idb');
  await hostIdb.dispose();

  const hostMem = new HexDbWorkerHost({ env: {} });
  assert.equal((await hostMem.dispatch('open', { binaryKey: 'tier_c' })).tier, 'memory');
  // Re-open and close must cleanly unregister evictor (no leak / duplicate registrations)
  assert.equal(hostMem.memoryBudget._evictors.size, 1);
  await hostMem.dispatch('open', { binaryKey: 'tier_c_2' });
  assert.equal(hostMem.memoryBudget._evictors.size, 1);
  await hostMem.dispatch('close');
  assert.equal(hostMem.memoryBudget._evictors.size, 0);
  // Cancel for unknown ID must not leak into _cancelledIds
  await hostMem.handleMessage({ type: HEXDB_RPC_CANCEL, id: 9999 });
  assert.equal(hostMem._cancelledIds.size, 0);
  await hostMem.dispose();
});

test('Worker RPC & Client: concurrent put + checkpoint serialization, AbortSignal, messageerror, and dispose race', async () => {
  const opfsRoot = createMockOpfsRoot();
  const host = new HexDbWorkerHost({ opfsRoot });
  const worker = createMockWorkerPair(host, { delayMs: 2 });
  const client = new HexDbClient({ workerFactory: () => worker, defaultTimeoutMs: 2000 });

  await client.open({ binaryKey: 'concurrent_rpc' });

  // Fire 20 concurrent puts interleaved with 2 checkpoints -> single-writer queue prevents lost writes!
  const ops = [];
  for (let i = 0; i < 10; i++) {
    ops.push(client.put('func_sig', `k_${i}`, ENC.encode(`val_${i}`)));
  }
  ops.push(client.checkpoint());
  for (let i = 10; i < 20; i++) {
    ops.push(client.put('func_sig', `k_${i}`, ENC.encode(`val_${i}`)));
  }
  ops.push(client.checkpoint());
  await Promise.all(ops);

  for (let i = 0; i < 20; i++) {
    assert.equal(DEC.decode(await client.get('func_sig', `k_${i}`)), `val_${i}`);
  }
  // Verify _getSyncHandle deduped concurrent opens cleanly
  assert.ok(opfsRoot.syncOpenCount <= 4);

  // AbortSignal cancellation
  const ac = new AbortController();
  const cancelledPromise = client.get('func_sig', 'k_0', { signal: ac.signal });
  ac.abort('user-navigated');
  await assert.rejects(cancelledPromise, (err) => err.code === 'HEXDB_CANCELLED' && err.name === 'AbortError');

  // Worker `messageerror` listener rejects pending request cleanly
  const msgErrPending = client.get('func_sig', 'k_1');
  worker.emitMessageError();
  await assert.rejects(msgErrPending, (err) => err.code === 'HEXDB_MESSAGE_ERROR');

  // Timeout test
  const slowWorker = createMockWorkerPair(host, { delayMs: 80 });
  const slowClient = new HexDbClient({ worker: slowWorker, defaultTimeoutMs: 15 });
  await assert.rejects(
    slowClient.call('ping', {}, { timeoutMs: 15 }),
    (err) => err.code === 'HEXDB_TIMEOUT'
  );
  await slowClient.dispose();

  // Dispose removes all 3 listeners (message, error, messageerror) and terminates owned worker
  await client.dispose();
  assert.equal(worker.terminated, true);
  assert.deepEqual(worker.listenerCounts, { message: 0, error: 0, messageerror: 0 });

  // In-process client dispose() race must NOT trigger an unhandled rejection
  let unhandledCount = 0;
  const onUnhandled = () => { unhandledCount += 1; };
  process.on('unhandledRejection', onUnhandled);
  try {
    const localClient = new HexDbClient({ hostOptions: { env: {} } });
    const p = localClient.open({ binaryKey: 'race_dispose' });
    await localClient.dispose();
    await assert.rejects(p, (err) => err.code === 'HEXDB_DISPOSED');
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(unhandledCount, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

// ===========================================================================
// 6. Converger Tests + Round 1 Regression Tests
// ===========================================================================

test('Converger: priority, foreground timer cancel, re-entrancy guard, and gated checkpointing', async () => {
  const executed = [];
  let fakeTime = 0;
  let checkpointCalls = 0;

  const converger = new HexDbConverger({
    sliceBudgetMs: 8,
    checkpointEveryBatches: 1,
    now: () => fakeTime,
    onCheckpoint: () => {
      checkpointCalls += 1;
    },
    handlers: {
      'dirty-cone': (p) => { executed.push(`dirty-cone:${p}`); fakeTime += 2; },
      'sig-prop': (p) => { executed.push(`sig-prop:${p}`); fakeTime += 3; },
      'struct-recovery': (p) => { executed.push(`struct:${p}`); fakeTime += 3; },
      'hexsig': (p) => { executed.push(`hexsig:${p}`); fakeTime += 3; },
    },
  });

  // 1. Re-entrancy guard: calling runSlice() while a slice is already running returns reason='reentrant'
  let reentrantResult = null;
  converger.enqueue({
    kind: 'dirty-cone',
    payload: 'reentrant-check',
    run: async () => {
      reentrantResult = await converger.runSlice(10);
      executed.push('dirty-cone:reentrant-check');
    },
  });
  await converger.runSlice(10);
  assert.equal(reentrantResult.yielded, true);
  assert.equal(reentrantResult.reason, 'reentrant');
  assert.equal(reentrantResult.processed, 0);

  // 2. Priority ordering & foreground start cancels scheduled timer and skips checkpoint!
  checkpointCalls = 0;
  converger.enqueue({ kind: 'hexsig', payload: 'h1' });
  converger.enqueue({ kind: 'struct-recovery', payload: 's1' });
  converger.enqueue({ kind: 'sig-prop', payload: 'p1' });
  converger.enqueue({
    kind: 'dirty-cone',
    priority: CONVERGER_PRIORITY.FOREGROUND_DIRTY_CONE,
    payload: 'd-fg',
    run: () => {
      executed.push('dirty-cone:d-fg');
      converger.notifyForegroundStart();
    },
  });

  // Start background timer, then immediately assert notifyForegroundStart clears it
  converger.start();
  assert.ok(converger._timerId !== null);
  converger.notifyForegroundStart();
  assert.equal(converger._timerId, null);
  converger.notifyForegroundEnd();
  converger.stop();

  // Mid-slice foreground start must NOT run _triggerCheckpoint()!
  const midSlice = await converger.runSlice(50);
  assert.equal(midSlice.processed, 1);
  assert.equal(midSlice.reason, 'foreground');
  assert.equal(converger.state, CONVERGER_STATE.PAUSED_FOREGROUND);
  assert.equal(checkpointCalls, 0);
  converger.notifyForegroundEnd();

  // Pressure pause/resume
  converger.pauseForPressure();
  assert.equal(converger.state, CONVERGER_STATE.PAUSED_PRESSURE);
  assert.equal((await converger.runSlice(50)).reason, 'pressure');
  converger.resumeFromPressure();

  // Finish remaining work -> transitions to CONVERGED and checkpoints
  const finalSlice = await converger.runSlice(50);
  assert.equal(finalSlice.processed, 3);
  assert.equal(finalSlice.remaining, 0);
  assert.equal(converger.state, CONVERGER_STATE.CONVERGED);
  assert.equal(checkpointCalls, 1);
  assert.deepEqual(executed, [
    'dirty-cone:reentrant-check',
    'dirty-cone:d-fg',
    'sig-prop:p1',
    'struct:s1',
    'hexsig:h1',
  ]);
  converger.dispose();
  assert.equal(converger.state, CONVERGER_STATE.DISPOSED);
});

// ===========================================================================
// 7. RuntimeProfile Parity Tests
// ===========================================================================

test('RuntimeProfile: Mobile vs Desktop detection and C++ hex_runtime_profile.hpp 32B & 64B POD parity', () => {
  const forcedMobile = detectRuntimeProfile({ override: 'mobile', deviceMemory: 16 });
  assert.equal(forcedMobile.tier, 'mobile');
  assert.equal(forcedMobile.profileId, PROFILE_ID_MOBILE_256M);
  assert.equal(forcedMobile.reason, 'explicit-override');

  const forcedDesktop = detectRuntimeProfile({
    override: 'desktop',
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)',
  });
  assert.equal(forcedDesktop.tier, 'desktop');
  assert.equal(forcedDesktop.profileId, PROFILE_ID_DESKTOP_HIGH);

  const ipad = detectRuntimeProfile({ platform: 'MacIntel', maxTouchPoints: 5, deviceMemory: 8 });
  assert.equal(ipad.tier, 'mobile');
  assert.equal(ipad.reason, 'ipados-touch');

  const safariNoMem = detectRuntimeProfile({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    deviceMemory: undefined,
  });
  assert.equal(safariNoMem.tier, 'mobile');
  assert.equal(safariNoMem.reason, 'safari-no-device-memory');

  assert.equal(detectRuntimeProfile({ deviceMemory: 4 }).tier, 'mobile');
  assert.equal(detectRuntimeProfile({ deviceMemory: 8 }).tier, 'desktop');
  assert.equal(detectRuntimeProfile({ jsHeapSizeLimit: 512 * 1024 * 1024 }).tier, 'mobile');
  assert.equal(
    detectRuntimeProfile({ jsHeapSizeLimit: 2 * 1024 * 1024 * 1024, hardwareConcurrency: 8 }).tier,
    'desktop'
  );
  assert.equal(detectRuntimeProfile({ env: {} }).tier, 'desktop');

  const mob = getRuntimeProfile('mobile');
  const desk = getRuntimeProfile('desktop');
  assert.equal(
    HEX_FIXED_SLOTS_TOTAL_BYTES +
      mob.cppLimits.slot5a_bytes +
      mob.cppLimits.slot5b_bytes +
      mob.cppLimits.volatile_a_bytes +
      mob.cppLimits.volatile_b_bytes,
    mob.cppLimits.type_arena_max_bytes
  );
  assert.equal(
    HEX_FIXED_SLOTS_TOTAL_BYTES +
      desk.cppLimits.slot5a_bytes +
      desk.cppLimits.slot5b_bytes +
      desk.cppLimits.volatile_a_bytes +
      desk.cppLimits.volatile_b_bytes,
    desk.cppLimits.type_arena_max_bytes
  );

  const packedCppMob = packCppHexRuntimeLimits(MOBILE_CPP_RUNTIME_LIMITS);
  const packedCppDesk = packCppHexRuntimeLimits(DESKTOP_CPP_RUNTIME_LIMITS);
  assert.equal(packedCppMob.byteLength, CPP_HEX_RUNTIME_LIMITS_BYTE_LENGTH);
  assert.equal(packedCppDesk.byteLength, CPP_HEX_RUNTIME_LIMITS_BYTE_LENGTH);
  assert.deepEqual(unpackCppHexRuntimeLimits(packedCppMob), MOBILE_CPP_RUNTIME_LIMITS);
  assert.deepEqual(unpackCppHexRuntimeLimits(packedCppDesk), DESKTOP_CPP_RUNTIME_LIMITS);

  assert.equal(mob.limits.type_arena_max_bytes, 8 * 1024 * 1024);
  assert.equal(desk.limits.type_arena_max_bytes, 48 * 1024 * 1024);
  assert.equal(mob.workerHeap.softCapBytes, 192 * 1024 * 1024);
  assert.equal(mob.workerHeap.maxCapBytes, 256 * 1024 * 1024);
  assert.equal(desk.workerHeap.softCapBytes, 768 * 1024 * 1024);
  assert.equal(desk.workerHeap.maxCapBytes, 1024 * 1024 * 1024);
  assert.equal(mob.hexdb.shardMaxBytes, 4 * 1024 * 1024);
  assert.equal(mob.converger.sliceBudgetMs, 8);

  const packedMob = packHexRuntimeLimits(MOBILE_HEX_RUNTIME_LIMITS);
  const packedDesk = packHexRuntimeLimits(DESKTOP_HEX_RUNTIME_LIMITS);
  assert.equal(packedMob.byteLength, HEX_RUNTIME_LIMITS_BYTE_LENGTH);
  assert.equal(packedDesk.byteLength, HEX_RUNTIME_LIMITS_BYTE_LENGTH);
  assert.deepEqual(unpackHexRuntimeLimits(packedMob), MOBILE_HEX_RUNTIME_LIMITS);
  assert.deepEqual(unpackHexRuntimeLimits(packedDesk), DESKTOP_HEX_RUNTIME_LIMITS);
});

// ===========================================================================
// 8. MemoryBudget Tracker & Pressure Eviction Tests
// ===========================================================================

test('MemoryBudget: tracks WASM/JS/HEX-DB usage, triggers priority LRU eviction on soft/hard/emergency caps', () => {
  const MIB = 1024 * 1024;
  const budget = new MemoryBudget({ profile: 'mobile' });
  const events = [];
  const unsub = budget.onPressureChange((e) => events.push(e));

  let hexdbCacheBytes = 40 * MIB;
  let jsCacheBytes = 30 * MIB;
  const evictOrder = [];

  budget.registerEvictor('hexdb-lru', {
    category: MEMORY_CATEGORY_HEXDB,
    priority: 0,
    evict(needed) {
      evictOrder.push('hexdb-lru');
      const freed = Math.min(hexdbCacheBytes, needed);
      hexdbCacheBytes -= freed;
      return freed;
    },
  });

  budget.registerEvictor('js-cache-lru', {
    category: MEMORY_CATEGORY_JS_CACHE,
    priority: 10,
    evict(needed) {
      evictOrder.push('js-cache-lru');
      const freed = Math.min(jsCacheBytes, needed);
      jsCacheBytes -= freed;
      return freed;
    },
  });

  budget.setUsage(MEMORY_CATEGORY_WASM, 130 * MIB);
  budget.setUsage(MEMORY_CATEGORY_JS_CACHE, jsCacheBytes);
  assert.equal(budget.level, PRESSURE_NORMAL);
  assert.equal(budget.recommendedHexDbCacheBytes(), 8 * MIB);

  const snapAfterSoft = budget.setUsage(MEMORY_CATEGORY_HEXDB, hexdbCacheBytes);
  assert.equal(snapAfterSoft.level, PRESSURE_NORMAL);
  assert.ok(snapAfterSoft.bytesEvicted > 36 * MIB);
  assert.equal(evictOrder[0], 'hexdb-lru');
  assert.ok(snapAfterSoft.totalBytes <= Math.floor(192 * MIB * 0.85) + 1);

  budget.setUsage(MEMORY_CATEGORY_WASM, 225 * MIB);
  assert.equal(budget.level, PRESSURE_HARD);
  assert.equal(budget.getSnapshot().pauseBackground, true);
  assert.equal(budget.recommendedHexDbCacheBytes(), 1 * MIB);

  budget.setUsage(MEMORY_CATEGORY_WASM, 242 * MIB);
  assert.equal(budget.level, PRESSURE_EMERGENCY);
  assert.equal(budget.recommendedHexDbCacheBytes(), 0);

  const snapDesk = budget.setProfile('desktop');
  assert.equal(snapDesk.tier, 'desktop');
  assert.equal(snapDesk.level, PRESSURE_NORMAL);
  assert.equal(snapDesk.pauseBackground, false);
  assert.equal(snapDesk.recommendedHexDbCacheBytes, 32 * MIB);
  assert.ok(events.length >= 3);

  unsub();
});

// ---------------------------------------------------------------------------
// Execute all tests
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL  ${name}`);
    console.error(err);
  }
}

console.log(`\nTrack 9 HEX-DB & Budgets Tests: ${passed}/${tests.length} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
}
