/**
 * HEX-DB Tier B IndexedDB Fallback Sharded Backend
 *
 * Used when OPFS FileSystemSyncAccessHandle is unavailable (e.g. Safari main
 * thread or restricted worker contexts). Implements the unified HEX-DB storage
 * adapter interface: open, get, put, del, batch, checkpoint, stats, close.
 *
 * Hardening:
 * - Single-writer Promise serialization queue (`_enqueueWrite`) preventing
 *   concurrent write interleaving or lost updates.
 * - Pre-check `_shardMaxBytes` (4 MiB) before WAL append / mutation.
 * - Transactional `checkpoint()`: commits `this._wal.compact()`, `_checkpointCount`,
 *   and `_dirtyKeys.clear()` ONLY AFTER `await txDone(tx)` succeeds.
 * - `QuotaExceededError` LRU eviction protects the current write's key(s) and
 *   rolls back both in-memory state and WAL if recovery fails.
 */

import { HexDbWal, WAL_DEFAULT_MAX_BYTES, WAL_OP_PUT, WAL_OP_DEL } from './hexdb-wal.js';
import {
  HEXDB_SHARD_HEADER_SIZE,
  HEXDB_DEFAULT_SHARD_MAX_BYTES,
  normalizeValueBytes,
} from './hexdb-memory.js';

export const IDB_DEFAULT_DB_NAME = 'hex-db-v1';
export const IDB_DB_VERSION = 1;
export const IDB_STORE_SHARDS = 'shards';
export const IDB_STORE_WAL = 'wal';
export const IDB_STORE_META = 'meta';

const TEXT_ENCODER = new TextEncoder();

export function isIdbAvailable(env = globalThis) {
  try {
    if (env?.location?.origin === 'null') return false;
    return Boolean(env?.indexedDB && typeof env.indexedDB.open === 'function');
  } catch {
    return false;
  }
}

function idbRequestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('HEXDB_IDB_REQUEST_FAILED'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('HEXDB_IDB_TX_FAILED'));
    tx.onabort = () => reject(tx.error || new Error('HEXDB_IDB_TX_ABORTED'));
  });
}

function isQuotaError(err) {
  if (!err) return false;
  return err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014;
}

function computeSerializedShardBytes(shardMap) {
  let total = HEXDB_SHARD_HEADER_SIZE + 4;
  if (shardMap) {
    for (const [k, v] of shardMap) {
      total += 8 + TEXT_ENCODER.encode(k).byteLength + v.byteLength;
    }
  }
  return total;
}

export class HexDbIdbBackend {
  constructor(options = {}) {
    this.tier = 'idb';
    this._idbFactory = options.indexedDB ?? null;
    this._dbName = options.dbName ?? IDB_DEFAULT_DB_NAME;
    this._binaryKey = options.binaryKey ?? 'default';
    this._shardMaxBytes = options.shardMaxBytes ?? HEXDB_DEFAULT_SHARD_MAX_BYTES;
    this._walMaxBytes = options.walMaxBytes ?? WAL_DEFAULT_MAX_BYTES;
    this._db = null;
    this._open = false;
    this._shards = new Map();
    this._lru = new Map();
    this._dirtyKeys = new Map();
    this._totalBytes = 0;
    this._evictedCount = 0;
    this._degraded = false;
    this._checkpointCount = 0;
    this._lastCheckpointLsn = 0;
    this._wal = null;
    this._writeQueue = Promise.resolve();
  }

  _assertOpen() {
    if (!this._open || !this._db) {
      throw new Error('HEXDB_NOT_OPEN: IDB backend is not open');
    }
  }

  _enqueueWrite(fn) {
    const next = this._writeQueue.then(fn, fn);
    this._writeQueue = next.then(() => {}, () => {});
    return next;
  }

  _recordKey(shard, key) {
    return `${this._binaryKey}::${shard}::${key}`;
  }

  _compositeKey(shard, key) {
    return `${shard}\u0000${key}`;
  }

  _touchLru(shard, key, bytes) {
    const ck = this._compositeKey(shard, key);
    if (this._lru.has(ck)) this._lru.delete(ck);
    this._lru.set(ck, { shard, key, bytes });
  }

  _removeLru(shard, key) {
    this._lru.delete(this._compositeKey(shard, key));
  }

  _snapshotMemoryState() {
    const shardsCopy = new Map();
    for (const [s, m] of this._shards) {
      shardsCopy.set(s, new Map(m));
    }
    return {
      shards: shardsCopy,
      lru: new Map(this._lru),
      dirtyKeys: new Map(this._dirtyKeys),
      totalBytes: this._totalBytes,
      evictedCount: this._evictedCount,
      degraded: this._degraded,
      wal: this._wal.snapshotState(),
    };
  }

  _restoreMemoryState(snap) {
    this._shards = snap.shards;
    this._lru = snap.lru;
    this._dirtyKeys = snap.dirtyKeys;
    this._totalBytes = snap.totalBytes;
    this._evictedCount = snap.evictedCount;
    this._degraded = snap.degraded;
    this._wal.restoreState(snap.wal);
  }

  _assertShardFitsPut(shard, key, valueBytes) {
    const existingMap = this._shards.get(shard);
    const baseSize = computeSerializedShardBytes(existingMap);
    const prev = existingMap?.get(key);
    const keyByteLen = TEXT_ENCODER.encode(key).byteLength;
    const projectedSize = prev
      ? baseSize - prev.byteLength + valueBytes.byteLength
      : baseSize + 8 + keyByteLen + valueBytes.byteLength;
    if (projectedSize > this._shardMaxBytes) {
      const err = new Error(`HEXDB_SHARD_OVERFLOW: shard '${shard}' would exceed ${this._shardMaxBytes} bytes (${projectedSize})`);
      err.code = 'HEXDB_SHARD_OVERFLOW';
      throw err;
    }
  }

  _assertBatchFitsShards(normalizedOps) {
    const simulated = new Map();
    for (let i = 0; i < normalizedOps.length; i++) {
      const item = normalizedOps[i];
      let map = simulated.get(item.shard);
      if (!map) {
        const existing = this._shards.get(item.shard);
        map = existing ? new Map(existing) : new Map();
        simulated.set(item.shard, map);
      }
      if (item.op === 'put') {
        map.set(item.key, item.bytes);
      } else {
        map.delete(item.key);
      }
    }
    for (const [shard, map] of simulated) {
      const projectedSize = computeSerializedShardBytes(map);
      if (projectedSize > this._shardMaxBytes) {
        const err = new Error(`HEXDB_SHARD_OVERFLOW: shard '${shard}' would exceed ${this._shardMaxBytes} bytes (${projectedSize})`);
        err.code = 'HEXDB_SHARD_OVERFLOW';
        throw err;
      }
    }
  }

  _openDatabase(factory) {
    return new Promise((resolve, reject) => {
      const req = factory.open(this._dbName, IDB_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE_SHARDS)) {
          db.createObjectStore(IDB_STORE_SHARDS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(IDB_STORE_WAL)) {
          db.createObjectStore(IDB_STORE_WAL, { keyPath: 'binaryKey' });
        }
        if (!db.objectStoreNames.contains(IDB_STORE_META)) {
          db.createObjectStore(IDB_STORE_META, { keyPath: 'binaryKey' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('HEXDB_IDB_OPEN_FAILED'));
    });
  }

  async _persistWalBytes() {
    const walBytes = this._wal.exportBytes();
    const tx = this._db.transaction([IDB_STORE_WAL], 'readwrite');
    tx.objectStore(IDB_STORE_WAL).put({
      binaryKey: this._binaryKey,
      bytes: walBytes,
      lastLsn: this._wal.lastLsn,
      updatedAt: Date.now(),
    });
    await txDone(tx);
  }

  async _evictOldestEntries(count = 16, protectedCompositeKeys = null) {
    let evicted = 0;
    const toDelete = [];
    for (const [ck, entry] of this._lru) {
      if (evicted >= count) break;
      if (protectedCompositeKeys && protectedCompositeKeys.has(ck)) continue;
      const map = this._shards.get(entry.shard);
      if (map && map.has(entry.key)) {
        const val = map.get(entry.key);
        this._totalBytes -= val.byteLength;
        map.delete(entry.key);
        if (map.size === 0) this._shards.delete(entry.shard);
      }
      this._lru.delete(ck);
      this._dirtyKeys.delete(ck);
      toDelete.push(this._recordKey(entry.shard, entry.key));
      this._evictedCount += 1;
      this._degraded = true;
      evicted += 1;
    }
    if (toDelete.length > 0 && this._db) {
      const tx = this._db.transaction([IDB_STORE_SHARDS], 'readwrite');
      const store = tx.objectStore(IDB_STORE_SHARDS);
      for (const id of toDelete) {
        store.delete(id);
      }
      await txDone(tx);
    }
    return evicted;
  }

  async _withQuotaRetry(fn, protectedCompositeKeys = null) {
    try {
      return await fn();
    } catch (err) {
      if (!isQuotaError(err)) throw err;
      const evictBatch = Math.max(1, Math.ceil(this._lru.size * 0.25));
      const evicted = await this._evictOldestEntries(evictBatch, protectedCompositeKeys);
      if (evicted === 0) throw err;
      return await fn();
    }
  }

  async open(options = {}) {
    return this._enqueueWrite(async () => {
      if (options.indexedDB != null) this._idbFactory = options.indexedDB;
      if (options.dbName != null) this._dbName = options.dbName;
      if (options.binaryKey != null) this._binaryKey = String(options.binaryKey);
      if (options.shardMaxBytes != null) this._shardMaxBytes = options.shardMaxBytes;
      if (options.walMaxBytes != null) this._walMaxBytes = options.walMaxBytes;

      const factory = this._idbFactory ?? globalThis.indexedDB;
      if (!factory || typeof factory.open !== 'function') {
        throw new Error('HEXDB_IDB_UNAVAILABLE: indexedDB is unavailable');
      }

      this._db = await this._openDatabase(factory);
      this._shards.clear();
      this._lru.clear();
      this._dirtyKeys.clear();
      this._totalBytes = 0;

      const readTx = this._db.transaction([IDB_STORE_SHARDS, IDB_STORE_WAL, IDB_STORE_META], 'readonly');
      const allShards = await idbRequestToPromise(readTx.objectStore(IDB_STORE_SHARDS).getAll());
      const walRec = await idbRequestToPromise(readTx.objectStore(IDB_STORE_WAL).get(this._binaryKey));
      const metaRec = await idbRequestToPromise(readTx.objectStore(IDB_STORE_META).get(this._binaryKey));

      for (let i = 0; i < allShards.length; i++) {
        const rec = allShards[i];
        if (!rec || rec.binaryKey !== this._binaryKey) continue;
        let map = this._shards.get(rec.shard);
        if (!map) {
          map = new Map();
          this._shards.set(rec.shard, map);
        }
        const bytes = normalizeValueBytes(rec.value);
        map.set(rec.key, bytes);
        this._totalBytes += bytes.byteLength;
        this._touchLru(rec.shard, rec.key, bytes.byteLength);
      }

      const checkpointLsn = metaRec?.checkpointLsn ?? 0;
      this._lastCheckpointLsn = checkpointLsn;
      this._checkpointCount = metaRec?.checkpointCount ?? 0;
      this._wal = new HexDbWal({ maxBytes: this._walMaxBytes, initialLsn: checkpointLsn });

      let replayedMutations = 0;
      let corruptWalFrames = 0;
      if (walRec?.bytes && walRec.bytes.byteLength > 0) {
        const replay = this._wal.replay(walRec.bytes);
        corruptWalFrames = replay.corruptFrames;
        for (let i = 0; i < replay.entries.length; i++) {
          const entry = replay.entries[i];
          if (entry.lsn <= checkpointLsn) continue;
          if (entry.op === WAL_OP_PUT) {
            let map = this._shards.get(entry.shard);
            if (!map) {
              map = new Map();
              this._shards.set(entry.shard, map);
            }
            const prev = map.get(entry.key);
            if (prev) this._totalBytes -= prev.byteLength;
            map.set(entry.key, entry.value);
            this._totalBytes += entry.value.byteLength;
            this._touchLru(entry.shard, entry.key, entry.value.byteLength);
            this._dirtyKeys.set(this._compositeKey(entry.shard, entry.key), {
              op: 'put',
              shard: entry.shard,
              key: entry.key,
              value: entry.value,
            });
            replayedMutations += 1;
          } else if (entry.op === WAL_OP_DEL) {
            const map = this._shards.get(entry.shard);
            if (map && map.has(entry.key)) {
              const prev = map.get(entry.key);
              this._totalBytes -= prev.byteLength;
              map.delete(entry.key);
              if (map.size === 0) this._shards.delete(entry.shard);
            }
            this._removeLru(entry.shard, entry.key);
            this._dirtyKeys.set(this._compositeKey(entry.shard, entry.key), {
              op: 'del',
              shard: entry.shard,
              key: entry.key,
            });
            replayedMutations += 1;
          }
        }
      }

      this._open = true;
      return {
        tier: this.tier,
        binaryKey: this._binaryKey,
        checkpointLsn,
        recoveredEntries: replayedMutations,
        corruptWalFrames,
        lastLsn: this._wal.lastLsn,
      };
    });
  }

  async get(shard, key) {
    this._assertOpen();
    const s = String(shard);
    const k = String(key);
    const map = this._shards.get(s);
    if (!map || !map.has(k)) return null;
    const val = map.get(k);
    this._touchLru(s, k, val.byteLength);
    return val.slice();
  }

  async _checkpointUnlocked() {
    const dirtySnapshot = [...this._dirtyKeys.values()];
    const durableLsn = this._wal.lastLsn;
    // Build compacted WAL buffer BEFORE touching this._wal state
    const builtWal = this._wal.buildCompactedBuffer({ writeCheckpointMarker: true });
    const nextCheckpointCount = this._checkpointCount + 1;

    await this._withQuotaRetry(async () => {
      const tx = this._db.transaction([IDB_STORE_SHARDS, IDB_STORE_WAL, IDB_STORE_META], 'readwrite');
      const shardStore = tx.objectStore(IDB_STORE_SHARDS);
      for (let i = 0; i < dirtySnapshot.length; i++) {
        const entry = dirtySnapshot[i];
        const id = this._recordKey(entry.shard, entry.key);
        if (entry.op === 'put') {
          shardStore.put({
            id,
            binaryKey: this._binaryKey,
            shard: entry.shard,
            key: entry.key,
            value: entry.value,
          });
        } else {
          shardStore.delete(id);
        }
      }
      tx.objectStore(IDB_STORE_WAL).put({
        binaryKey: this._binaryKey,
        bytes: builtWal.buffer,
        lastLsn: builtWal.lastLsn,
        updatedAt: Date.now(),
      });
      tx.objectStore(IDB_STORE_META).put({
        binaryKey: this._binaryKey,
        checkpointLsn: durableLsn,
        checkpointCount: nextCheckpointCount,
        updatedAt: Date.now(),
      });
      await txDone(tx);
    });

    // Commit in-memory WAL compaction, checkpoint counter, and dirtyKeys ONLY AFTER txDone succeeds!
    const compactRes = this._wal.applyCompactedBuffer(builtWal);
    this._checkpointCount = nextCheckpointCount;
    this._lastCheckpointLsn = durableLsn;
    this._dirtyKeys.clear();

    return {
      checkpointCount: this._checkpointCount,
      checkpointLsn: durableLsn,
      walMarkerLsn: compactRes.checkpointLsn,
      compactedFromBytes: compactRes.compactedFromBytes,
      walBytes: compactRes.newBytes,
    };
  }

  async put(shard, key, value) {
    return this._enqueueWrite(async () => {
      this._assertOpen();
      const s = String(shard);
      const k = String(key);
      const bytes = normalizeValueBytes(value);

      // Pre-check 4 MiB shard boundary BEFORE WAL append
      this._assertShardFitsPut(s, k, bytes);

      const snap = this._snapshotMemoryState();
      const protectedKeys = new Set([this._compositeKey(s, k)]);

      try {
        const { lsn } = this._wal.appendPut(s, k, bytes);
        let map = this._shards.get(s);
        if (!map) {
          map = new Map();
          this._shards.set(s, map);
        }
        const prev = map.get(k);
        if (prev) this._totalBytes -= prev.byteLength;
        map.set(k, bytes);
        this._totalBytes += bytes.byteLength;
        this._touchLru(s, k, bytes.byteLength);
        this._dirtyKeys.set(this._compositeKey(s, k), { op: 'put', shard: s, key: k, value: bytes });

        await this._withQuotaRetry(() => this._persistWalBytes(), protectedKeys);

        if (this._wal.needsCompaction()) {
          await this._checkpointUnlocked();
        }
        return { lsn, bytes: bytes.byteLength, degraded: this._degraded };
      } catch (err) {
        this._restoreMemoryState(snap);
        throw err;
      }
    });
  }

  async del(shard, key) {
    return this._enqueueWrite(async () => {
      this._assertOpen();
      const s = String(shard);
      const k = String(key);
      const snap = this._snapshotMemoryState();

      try {
        const { lsn } = this._wal.appendDel(s, k);
        const map = this._shards.get(s);
        let deleted = false;
        if (map && map.has(k)) {
          const prev = map.get(k);
          this._totalBytes -= prev.byteLength;
          map.delete(k);
          if (map.size === 0) this._shards.delete(s);
          deleted = true;
        }
        this._removeLru(s, k);
        this._dirtyKeys.set(this._compositeKey(s, k), { op: 'del', shard: s, key: k });

        await this._withQuotaRetry(() => this._persistWalBytes());

        if (this._wal.needsCompaction()) {
          await this._checkpointUnlocked();
        }
        return { lsn, deleted };
      } catch (err) {
        this._restoreMemoryState(snap);
        throw err;
      }
    });
  }

  async batch(ops) {
    return this._enqueueWrite(async () => {
      this._assertOpen();
      if (!Array.isArray(ops)) {
        throw new TypeError('HEXDB_BATCH_INVALID: ops must be an array');
      }
      const normalized = [];
      const protectedKeys = new Set();
      for (let i = 0; i < ops.length; i++) {
        const item = ops[i];
        const s = String(item.shard);
        const k = String(item.key);
        if (item.op === 'put' || item.op === WAL_OP_PUT) {
          normalized.push({ op: 'put', shard: s, key: k, bytes: normalizeValueBytes(item.value) });
          protectedKeys.add(this._compositeKey(s, k));
        } else if (item.op === 'del' || item.op === WAL_OP_DEL) {
          normalized.push({ op: 'del', shard: s, key: k });
        } else {
          throw new TypeError(`HEXDB_BATCH_UNKNOWN_OP: ${item.op}`);
        }
      }

      // Pre-check 4 MiB shard cap across all affected shards BEFORE WAL append
      this._assertBatchFitsShards(normalized);

      const snap = this._snapshotMemoryState();
      try {
        let applied = 0;
        for (let i = 0; i < normalized.length; i++) {
          const item = normalized[i];
          if (item.op === 'put') {
            this._wal.appendPut(item.shard, item.key, item.bytes);
            let map = this._shards.get(item.shard);
            if (!map) {
              map = new Map();
              this._shards.set(item.shard, map);
            }
            const prev = map.get(item.key);
            if (prev) this._totalBytes -= prev.byteLength;
            map.set(item.key, item.bytes);
            this._totalBytes += item.bytes.byteLength;
            this._touchLru(item.shard, item.key, item.bytes.byteLength);
            this._dirtyKeys.set(this._compositeKey(item.shard, item.key), {
              op: 'put',
              shard: item.shard,
              key: item.key,
              value: item.bytes,
            });
            applied += 1;
          } else {
            this._wal.appendDel(item.shard, item.key);
            const map = this._shards.get(item.shard);
            if (map && map.has(item.key)) {
              const prev = map.get(item.key);
              this._totalBytes -= prev.byteLength;
              map.delete(item.key);
              if (map.size === 0) this._shards.delete(item.shard);
            }
            this._removeLru(item.shard, item.key);
            this._dirtyKeys.set(this._compositeKey(item.shard, item.key), {
              op: 'del',
              shard: item.shard,
              key: item.key,
            });
            applied += 1;
          }
        }

        await this._withQuotaRetry(() => this._persistWalBytes(), protectedKeys);

        if (this._wal.needsCompaction()) {
          await this._checkpointUnlocked();
        }
        return { applied, lsn: this._wal.lastLsn, degraded: this._degraded };
      } catch (err) {
        this._restoreMemoryState(snap);
        throw err;
      }
    });
  }

  async checkpoint() {
    return this._enqueueWrite(async () => {
      this._assertOpen();
      return await this._checkpointUnlocked();
    });
  }

  async listKeys(shard) {
    this._assertOpen();
    const map = this._shards.get(String(shard));
    return map ? [...map.keys()] : [];
  }

  async stats() {
    const shards = {};
    let entryCount = 0;
    for (const [name, map] of this._shards) {
      let bytes = 0;
      for (const v of map.values()) bytes += v.byteLength;
      shards[name] = { entries: map.size, bytes };
      entryCount += map.size;
    }
    return {
      tier: this.tier,
      open: this._open,
      binaryKey: this._binaryKey,
      totalBytes: this._totalBytes,
      shardMaxBytes: this._shardMaxBytes,
      shardCount: this._shards.size,
      entryCount,
      walBytes: this._wal ? this._wal.byteLength : 0,
      walLsn: this._wal ? this._wal.lastLsn : 0,
      checkpointLsn: this._lastCheckpointLsn,
      checkpointCount: this._checkpointCount,
      evictedCount: this._evictedCount,
      degraded: this._degraded,
      complete: !this._degraded,
      shards,
    };
  }

  async close() {
    return this._enqueueWrite(async () => {
      if (!this._open) return { closed: true };
      if (this._db && typeof this._db.close === 'function') {
        this._db.close();
      }
      this._db = null;
      this._open = false;
      return { closed: true };
    });
  }
}
