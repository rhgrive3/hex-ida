/**
 * HEX-DB Tier A OPFS (Origin Private File System) Sharded Storage Backend
 *
 * Uses Dedicated Worker FileSystemSyncAccessHandle for synchronous 4 KiB-aligned
 * reads/writes, 4 MiB shard files with 64-byte HDB1 headers (CRC32C protected),
 * an append-only CRC32 WAL (`delta_wal.hdb`), and A/B double-buffered atomic
 * checkpoints (`checkpoint.bin`, 4 KiB x 2 slots).
 *
 * Crash-safe checkpoint ordering:
 *   1. Flush all dirty shard files (`<shard>.hdb`)
 *   2. Write & flush alternating A/B checkpoint slot (`checkpoint.bin`) with `checkpointLsn`
 *   3. Atomically compact WAL (`delta_wal.hdb`) via single-buffer write-then-truncate
 *
 * Supports injecting a custom/mock `rootDir` (FileSystemDirectoryHandle-like)
 * for deterministic Node unit testing without browser OPFS globals.
 */

import { HexDbWal, WAL_DEFAULT_MAX_BYTES, WAL_OP_PUT, WAL_OP_DEL, crc32c } from './hexdb-wal.js';
import {
  HEXDB_SHARD_HEADER_SIZE,
  HEXDB_DEFAULT_SHARD_MAX_BYTES,
  encodeShardHeader64,
  decodeShardHeader64,
  normalizeValueBytes,
} from './hexdb-memory.js';

export const OPFS_PAGE_SIZE = 4096;
export const OPFS_CHECKPOINT_SLOT_SIZE = 4096;
export const OPFS_CHECKPOINT_MAGIC = 0x504b4348; // 'HCKP' in LE
export const OPFS_WAL_FILENAME = 'delta_wal.hdb';
export const OPFS_CHECKPOINT_FILENAME = 'checkpoint.bin';

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

function isQuotaError(err) {
  if (!err) return false;
  return err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014 || err.code === 'HEXDB_QUOTA_EXCEEDED';
}

function makeQuotaError(cause) {
  const err = new Error(`HEXDB_QUOTA_EXCEEDED: ${cause?.message || 'OPFS storage quota exceeded'}`);
  err.name = 'QuotaExceededError';
  err.code = 'HEXDB_QUOTA_EXCEEDED';
  return err;
}

/**
 * Graceful feature detection for OPFS SyncAccessHandle availability.
 * Never spreads `env` so non-enumerable prototype getters (like `navigator` on
 * DedicatedWorkerGlobalScope) are preserved intact.
 */
export async function isOpfsSyncAvailable(env = globalThis, { rootDir = null } = {}) {
  try {
    const candidateRoot = rootDir ?? env?.rootDir ?? null;
    if (candidateRoot && typeof candidateRoot.getFileHandle === 'function') {
      return true;
    }
    if (env?.location?.origin === 'null') {
      return false;
    }
    const storage = env?.navigator?.storage;
    if (!storage || typeof storage.getDirectory !== 'function') return false;
    const proto = env?.FileSystemFileHandle?.prototype;
    if (proto && typeof proto.createSyncAccessHandle !== 'function') {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function sanitizeSegment(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'default';
}

function computeSerializedShardBytes(shardMap) {
  let total = HEXDB_SHARD_HEADER_SIZE + 4; // 64B header + uint32 entryCount
  if (shardMap) {
    for (const [k, v] of shardMap) {
      total += 8 + TEXT_ENCODER.encode(k).byteLength + v.byteLength;
    }
  }
  return total;
}

function encodeShardPayload(shardMap) {
  const encodedEntries = [];
  let totalBytes = 4; // uint32 entryCount
  for (const [k, v] of shardMap) {
    const kb = TEXT_ENCODER.encode(k);
    totalBytes += 4 + 4 + kb.byteLength + v.byteLength;
    encodedEntries.push({ kb, v });
  }
  const buf = new Uint8Array(totalBytes);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setUint32(0, encodedEntries.length >>> 0, true);
  let pos = 4;
  for (let i = 0; i < encodedEntries.length; i++) {
    const { kb, v } = encodedEntries[i];
    view.setUint32(pos, kb.byteLength >>> 0, true);
    view.setUint32(pos + 4, v.byteLength >>> 0, true);
    pos += 8;
    buf.set(kb, pos);
    pos += kb.byteLength;
    buf.set(v, pos);
    pos += v.byteLength;
  }
  return buf;
}

function decodeShardPayload(payloadBytes) {
  const map = new Map();
  if (!payloadBytes || payloadBytes.byteLength < 4) return map;
  const view = new DataView(payloadBytes.buffer, payloadBytes.byteOffset, payloadBytes.byteLength);
  const count = view.getUint32(0, true);
  let pos = 4;
  for (let i = 0; i < count; i++) {
    if (pos + 8 > payloadBytes.byteLength) break;
    const keyLen = view.getUint32(pos, true);
    const valLen = view.getUint32(pos + 4, true);
    pos += 8;
    if (pos + keyLen + valLen > payloadBytes.byteLength) break;
    const key = TEXT_DECODER.decode(payloadBytes.subarray(pos, pos + keyLen));
    pos += keyLen;
    const val = payloadBytes.slice(pos, pos + valLen);
    pos += valLen;
    map.set(key, val);
  }
  return map;
}

/**
 * Encode an A/B checkpoint record (128-byte logical header inside 4 KiB slot, CRC32C protected).
 */
export function encodeCheckpointSlot({ generation, checkpointLsn, shardNames = [], binaryKey = '' }) {
  const slot = new Uint8Array(OPFS_CHECKPOINT_SLOT_SIZE);
  const view = new DataView(slot.buffer, slot.byteOffset, slot.byteLength);
  const metaJson = TEXT_ENCODER.encode(JSON.stringify({ shardNames, binaryKey }));
  const maxMeta = OPFS_CHECKPOINT_SLOT_SIZE - 32 - 4;
  if (metaJson.byteLength > maxMeta) {
    const err = new Error(
      `HEXDB_CHECKPOINT_META_OVERFLOW: checkpoint metadata (${metaJson.byteLength} bytes) exceeds slot limit (${maxMeta} bytes)`,
    );
    err.code = 'HEXDB_CHECKPOINT_META_OVERFLOW';
    throw err;
  }
  const metaLen = metaJson.byteLength;

  view.setUint32(0x00, OPFS_CHECKPOINT_MAGIC, true);
  view.setUint32(0x04, 1, true);
  view.setUint32(0x08, generation >>> 0, true);
  view.setUint32(0x0c, checkpointLsn >>> 0, true);
  view.setUint32(0x10, Math.floor(checkpointLsn / 0x100000000) >>> 0, true);
  view.setUint32(0x14, metaLen >>> 0, true);
  slot.set(metaJson.subarray(0, metaLen), 0x20);

  const crc = crc32c(slot, 0, OPFS_CHECKPOINT_SLOT_SIZE - 4);
  view.setUint32(OPFS_CHECKPOINT_SLOT_SIZE - 4, crc, true);
  return slot;
}

/**
 * Decode and verify a single 4 KiB checkpoint slot. Returns null if corrupt/empty.
 */
export function decodeCheckpointSlot(slot) {
  if (!slot || slot.byteLength < OPFS_CHECKPOINT_SLOT_SIZE) return null;
  const view = new DataView(slot.buffer, slot.byteOffset, OPFS_CHECKPOINT_SLOT_SIZE);
  if (view.getUint32(0x00, true) !== OPFS_CHECKPOINT_MAGIC) return null;
  const expectedCrc = view.getUint32(OPFS_CHECKPOINT_SLOT_SIZE - 4, true);
  if (crc32c(slot, 0, OPFS_CHECKPOINT_SLOT_SIZE - 4) !== expectedCrc) return null;

  const generation = view.getUint32(0x08, true);
  const checkpointLsn = view.getUint32(0x10, true) * 0x100000000 + view.getUint32(0x0c, true);
  const metaLen = view.getUint32(0x14, true);
  let meta = { shardNames: [], binaryKey: '' };
  if (metaLen > 0 && 0x20 + metaLen <= OPFS_CHECKPOINT_SLOT_SIZE - 4) {
    try {
      meta = JSON.parse(TEXT_DECODER.decode(slot.subarray(0x20, 0x20 + metaLen)));
    } catch {
      return null;
    }
  }
  return {
    generation,
    checkpointLsn,
    shardNames: Array.isArray(meta.shardNames) ? meta.shardNames : [],
    binaryKey: meta.binaryKey || '',
  };
}

export class HexDbOpfsBackend {
  constructor(options = {}) {
    this.tier = 'opfs';
    this._rootDir = options.rootDir ?? null;
    this._binaryKey = options.binaryKey ?? 'default';
    this._shardMaxBytes = options.shardMaxBytes ?? HEXDB_DEFAULT_SHARD_MAX_BYTES;
    this._walMaxBytes = options.walMaxBytes ?? WAL_DEFAULT_MAX_BYTES;
    this._open = false;
    this._storeDir = null;
    this._handles = new Map();        // filename -> FileSystemSyncAccessHandle
    this._handlePromises = new Map(); // filename -> Promise<FileSystemSyncAccessHandle>
    this._shards = new Map();         // shardName -> Map<key, Uint8Array>
    this._dirtyShards = new Set();
    this._totalBytes = 0;
    this._checkpointGeneration = 0;
    this._checkpointCount = 0;
    this._lastCheckpointLsn = 0;
    this._wal = null;
    this._walHandle = null;
    this._checkpointHandle = null;
    this._writeQueue = Promise.resolve();
  }

  _assertOpen() {
    if (!this._open) {
      throw new Error('HEXDB_NOT_OPEN: OPFS backend is not open');
    }
  }

  _enqueueWrite(fn) {
    const next = this._writeQueue.then(fn, fn);
    this._writeQueue = next.then(() => {}, () => {});
    return next;
  }

  async _getSyncHandle(filename) {
    if (this._handles.has(filename)) {
      return this._handles.get(filename);
    }
    if (this._handlePromises.has(filename)) {
      return this._handlePromises.get(filename);
    }
    const promise = (async () => {
      const fileHandle = await this._storeDir.getFileHandle(filename, { create: true });
      if (typeof fileHandle.createSyncAccessHandle !== 'function') {
        throw new Error('HEXDB_OPFS_UNAVAILABLE: createSyncAccessHandle is not supported');
      }
      const syncHandle = await fileHandle.createSyncAccessHandle();
      this._handles.set(filename, syncHandle);
      return syncHandle;
    })();
    this._handlePromises.set(filename, promise);
    try {
      return await promise;
    } finally {
      this._handlePromises.delete(filename);
    }
  }

  _readAllFromHandle(handle) {
    const size = handle.getSize();
    if (size <= 0) return new Uint8Array(0);
    const buf = new Uint8Array(size);
    handle.read(buf, { at: 0 });
    return buf;
  }

  _safeSyncWrite(handle, bytes, at) {
    try {
      handle.write(bytes, { at });
    } catch (err) {
      if (isQuotaError(err)) throw makeQuotaError(err);
      throw err;
    }
  }

  _safeSyncTruncate(handle, size) {
    try {
      handle.truncate(size);
    } catch (err) {
      if (isQuotaError(err)) throw makeQuotaError(err);
      throw err;
    }
  }

  _safeSyncFlush(handle) {
    try {
      handle.flush();
    } catch (err) {
      if (isQuotaError(err)) throw makeQuotaError(err);
      throw err;
    }
  }

  /**
   * Write full bytes BEFORE truncating tail to avoid an empty-file crash window.
   */
  _writeFullHandle(handle, bytes) {
    if (bytes.byteLength > 0) {
      this._safeSyncWrite(handle, bytes, 0);
    }
    if (handle.getSize() !== bytes.byteLength) {
      this._safeSyncTruncate(handle, bytes.byteLength);
    }
    this._safeSyncFlush(handle);
  }

  _readLatestCheckpoint() {
    const size = this._checkpointHandle.getSize();
    if (size < OPFS_CHECKPOINT_SLOT_SIZE) return null;
    const buf = new Uint8Array(Math.min(size, OPFS_CHECKPOINT_SLOT_SIZE * 2));
    this._checkpointHandle.read(buf, { at: 0 });

    const slotA = decodeCheckpointSlot(buf.subarray(0, OPFS_CHECKPOINT_SLOT_SIZE));
    const slotB = buf.byteLength >= OPFS_CHECKPOINT_SLOT_SIZE * 2
      ? decodeCheckpointSlot(buf.subarray(OPFS_CHECKPOINT_SLOT_SIZE, OPFS_CHECKPOINT_SLOT_SIZE * 2))
      : null;

    if (slotA && slotB) {
      return slotB.generation >= slotA.generation ? slotB : slotA;
    }
    return slotA || slotB || null;
  }

  _writeCheckpointSlot(checkpointLsn, prebuiltSlotBytes = null) {
    const nextGen = this._checkpointGeneration + 1;
    const slotIndex = nextGen % 2;
    const slotBytes = prebuiltSlotBytes || encodeCheckpointSlot({
      generation: nextGen,
      checkpointLsn,
      shardNames: [...this._shards.keys()],
      binaryKey: this._binaryKey,
    });
    this._safeSyncWrite(this._checkpointHandle, slotBytes, slotIndex * OPFS_CHECKPOINT_SLOT_SIZE);
    this._safeSyncFlush(this._checkpointHandle);
    this._checkpointGeneration = nextGen;
    this._lastCheckpointLsn = checkpointLsn;
  }

  async _loadShardFile(shardName) {
    const filename = `${sanitizeSegment(shardName)}.hdb`;
    const handle = await this._getSyncHandle(filename);
    const raw = this._readAllFromHandle(handle);
    if (raw.byteLength < HEXDB_SHARD_HEADER_SIZE) {
      return new Map();
    }
    const header = decodeShardHeader64(raw);
    if (!header) return new Map();
    const payloadEnd = HEXDB_SHARD_HEADER_SIZE + header.dataBytes;
    if (payloadEnd > raw.byteLength) return new Map();
    const payload = raw.subarray(HEXDB_SHARD_HEADER_SIZE, payloadEnd);
    if (crc32c(payload) !== header.dataCrc32c) return new Map();
    return decodeShardPayload(payload);
  }

  async _flushShardFile(shardName) {
    const filename = `${sanitizeSegment(shardName)}.hdb`;
    const handle = await this._getSyncHandle(filename);
    const map = this._shards.get(shardName) || new Map();
    const payload = encodeShardPayload(map);
    const totalSize = HEXDB_SHARD_HEADER_SIZE + payload.byteLength;
    if (totalSize > this._shardMaxBytes) {
      const err = new Error(`HEXDB_SHARD_OVERFLOW: shard '${shardName}' exceeds ${this._shardMaxBytes} bytes (${totalSize})`);
      err.code = 'HEXDB_SHARD_OVERFLOW';
      throw err;
    }
    const header = encodeShardHeader64({
      entryCount: map.size,
      dataBytes: payload.byteLength,
      dataCrc32c: crc32c(payload),
      lsn: this._wal.lastLsn,
      sha256Prefix: this._binaryKey,
    });
    const combined = new Uint8Array(totalSize);
    combined.set(header, 0);
    combined.set(payload, HEXDB_SHARD_HEADER_SIZE);
    this._writeFullHandle(handle, combined);
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
    const simulated = new Map(); // shard -> Map<key, Uint8Array>
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

  _recomputeTotalBytes() {
    let total = 0;
    for (const map of this._shards.values()) {
      for (const v of map.values()) total += v.byteLength;
    }
    this._totalBytes = total;
  }

  async open(options = {}) {
    return this._enqueueWrite(async () => {
      if (options.rootDir != null) this._rootDir = options.rootDir;
      if (options.binaryKey != null) this._binaryKey = String(options.binaryKey);
      if (options.shardMaxBytes != null) this._shardMaxBytes = options.shardMaxBytes;
      if (options.walMaxBytes != null) this._walMaxBytes = options.walMaxBytes;

      let root = this._rootDir;
      if (!root) {
        if (!globalThis.navigator?.storage?.getDirectory) {
          throw new Error('HEXDB_OPFS_UNAVAILABLE: navigator.storage.getDirectory is unavailable');
        }
        root = await globalThis.navigator.storage.getDirectory();
      }

      const baseDir = await root.getDirectoryHandle('hex-db-v1', { create: true });
      this._storeDir = await baseDir.getDirectoryHandle(sanitizeSegment(this._binaryKey), { create: true });

      this._checkpointHandle = await this._getSyncHandle(OPFS_CHECKPOINT_FILENAME);
      this._walHandle = await this._getSyncHandle(OPFS_WAL_FILENAME);

      // 1. Recover latest valid A/B checkpoint.
      const latestCkpt = this._readLatestCheckpoint();
      const checkpointLsn = latestCkpt ? latestCkpt.checkpointLsn : 0;
      this._lastCheckpointLsn = checkpointLsn;
      this._shards.clear();
      this._dirtyShards.clear();
      if (latestCkpt) {
        this._checkpointGeneration = latestCkpt.generation;
        for (const shardName of latestCkpt.shardNames) {
          const map = await this._loadShardFile(shardName);
          if (map.size > 0) {
            this._shards.set(shardName, map);
          }
        }
      }

      // 2. Attach WAL sink (with atomic write-before-truncate `replace`) and replay entries > checkpointLsn.
      const walSink = {
        append: (frame) => {
          const at = this._walHandle.getSize();
          this._safeSyncWrite(this._walHandle, frame, at);
          this._safeSyncFlush(this._walHandle);
        },
        readAll: () => this._readAllFromHandle(this._walHandle),
        truncate: (len) => {
          this._safeSyncTruncate(this._walHandle, len);
          this._safeSyncFlush(this._walHandle);
        },
        replace: (fullBuf) => {
          this._writeFullHandle(this._walHandle, fullBuf);
        },
      };
      this._wal = new HexDbWal({
        maxBytes: this._walMaxBytes,
        sink: walSink,
        initialLsn: checkpointLsn,
      });

      const replay = this._wal.replay();
      let replayedMutations = 0;
      for (let i = 0; i < replay.entries.length; i++) {
        const entry = replay.entries[i];
        if (entry.lsn <= checkpointLsn) continue;
        if (entry.op === WAL_OP_PUT) {
          let map = this._shards.get(entry.shard);
          if (!map) {
            map = new Map();
            this._shards.set(entry.shard, map);
          }
          map.set(entry.key, entry.value);
          this._dirtyShards.add(entry.shard);
          replayedMutations += 1;
        } else if (entry.op === WAL_OP_DEL) {
          const map = this._shards.get(entry.shard);
          if (map) {
            map.delete(entry.key);
            if (map.size === 0) this._shards.delete(entry.shard);
          }
          this._dirtyShards.add(entry.shard);
          replayedMutations += 1;
        }
      }

      this._recomputeTotalBytes();
      this._open = true;

      return {
        tier: this.tier,
        binaryKey: this._binaryKey,
        checkpointGeneration: this._checkpointGeneration,
        checkpointLsn,
        recoveredEntries: replayedMutations,
        corruptWalFrames: replay.corruptFrames,
        lastLsn: this._wal.lastLsn,
      };
    });
  }

  async get(shard, key) {
    this._assertOpen();
    const map = this._shards.get(String(shard));
    if (!map) return null;
    const val = map.get(String(key));
    return val ? val.slice() : null;
  }

  async _checkpointUnlocked() {
    // Pre-build & validate checkpoint slot metadata BEFORE touching any shard file on disk.
    const durableLsn = this._wal.lastLsn;
    const prebuiltSlotBytes = encodeCheckpointSlot({
      generation: this._checkpointGeneration + 1,
      checkpointLsn: durableLsn,
      shardNames: [...this._shards.keys()],
      binaryKey: this._binaryKey,
    });

    // Crash-safe 3-step order:
    // (1) Flush all dirty shard files
    for (const shardName of this._dirtyShards) {
      await this._flushShardFile(shardName);
    }
    this._dirtyShards.clear();

    // (2) Write & flush alternating A/B checkpoint slot BEFORE compacting WAL
    this._writeCheckpointSlot(durableLsn, prebuiltSlotBytes);

    // (3) Compact WAL atomically via single-buffer write-before-truncate
    const compactRes = this._wal.compact({ writeCheckpointMarker: true });
    this._checkpointCount += 1;

    return {
      checkpointCount: this._checkpointCount,
      checkpointGeneration: this._checkpointGeneration,
      checkpointLsn: durableLsn,
      walMarkerLsn: compactRes.checkpointLsn,
      compactedFromBytes: compactRes.compactedFromBytes,
      walBytes: compactRes.newBytes,
    };
  }

  _snapshotMutation(shardNames) {
    const savedShards = new Map();
    for (const name of shardNames) {
      if (savedShards.has(name)) continue;
      const existing = this._shards.get(name);
      savedShards.set(name, existing ? new Map(existing) : null);
    }
    return {
      walSnap: this._wal.snapshotState(),
      savedShards,
      prevTotalBytes: this._totalBytes,
      prevDirty: new Set(this._dirtyShards),
    };
  }

  _rollbackMutation(snap) {
    for (const [name, prevMap] of snap.savedShards.entries()) {
      if (prevMap === null) {
        this._shards.delete(name);
      } else {
        this._shards.set(name, prevMap);
      }
    }
    this._totalBytes = snap.prevTotalBytes;
    this._dirtyShards = snap.prevDirty;
    try {
      this._wal.restoreState(snap.walSnap);
    } catch { /* best-effort WAL rollback; preserve original write error */ }
    try {
      this._walHandle?.flush?.();
    } catch { /* best-effort WAL flush after rollback */ }
  }

  async put(shard, key, value) {
    return this._enqueueWrite(async () => {
      this._assertOpen();
      const s = String(shard);
      const k = String(key);
      const bytes = normalizeValueBytes(value);

      // Pre-check 4 MiB shard boundary BEFORE appending to WAL
      this._assertShardFitsPut(s, k, bytes);

      const snap = this._snapshotMutation([s]);
      let lsn;
      try {
        ({ lsn } = this._wal.appendPut(s, k, bytes));
        let map = this._shards.get(s);
        if (!map) {
          map = new Map();
          this._shards.set(s, map);
        }
        const prev = map.get(k);
        if (prev) this._totalBytes -= prev.byteLength;
        map.set(k, bytes);
        this._totalBytes += bytes.byteLength;
        this._dirtyShards.add(s);
      } catch (err) {
        this._rollbackMutation(snap);
        throw err;
      }

      if (this._wal.needsCompaction()) {
        await this._checkpointUnlocked();
      }
      return { lsn, bytes: bytes.byteLength };
    });
  }

  async del(shard, key) {
    return this._enqueueWrite(async () => {
      this._assertOpen();
      const s = String(shard);
      const k = String(key);
      const snap = this._snapshotMutation([s]);
      let lsn;
      let deleted = false;
      try {
        ({ lsn } = this._wal.appendDel(s, k));
        const map = this._shards.get(s);
        if (map && map.has(k)) {
          const prev = map.get(k);
          this._totalBytes -= prev.byteLength;
          map.delete(k);
          if (map.size === 0) this._shards.delete(s);
          deleted = true;
        }
        this._dirtyShards.add(s);
      } catch (err) {
        this._rollbackMutation(snap);
        throw err;
      }

      if (this._wal.needsCompaction()) {
        await this._checkpointUnlocked();
      }
      return { lsn, deleted };
    });
  }

  async batch(ops) {
    return this._enqueueWrite(async () => {
      this._assertOpen();
      if (!Array.isArray(ops)) {
        throw new TypeError('HEXDB_BATCH_INVALID: ops must be an array');
      }
      // Validate & normalize all ops first
      const normalized = [];
      for (let i = 0; i < ops.length; i++) {
        const item = ops[i];
        const s = String(item.shard);
        const k = String(item.key);
        if (item.op === 'put' || item.op === WAL_OP_PUT) {
          normalized.push({ op: 'put', shard: s, key: k, bytes: normalizeValueBytes(item.value) });
        } else if (item.op === 'del' || item.op === WAL_OP_DEL) {
          normalized.push({ op: 'del', shard: s, key: k });
        } else {
          throw new TypeError(`HEXDB_BATCH_UNKNOWN_OP: ${item.op}`);
        }
      }

      // Pre-check 4 MiB shard cap across all affected shards BEFORE any WAL append
      this._assertBatchFitsShards(normalized);

      const snap = this._snapshotMutation(normalized.map((item) => item.shard));
      let applied = 0;
      try {
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
            this._dirtyShards.add(item.shard);
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
            this._dirtyShards.add(item.shard);
            applied += 1;
          }
        }
      } catch (err) {
        this._rollbackMutation(snap);
        throw err;
      }

      if (this._wal.needsCompaction()) {
        await this._checkpointUnlocked();
      }
      return { applied, lsn: this._wal.lastLsn };
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
      dirtyShardCount: this._dirtyShards.size,
      walBytes: this._wal ? this._wal.byteLength : 0,
      walLsn: this._wal ? this._wal.lastLsn : 0,
      checkpointGeneration: this._checkpointGeneration,
      checkpointLsn: this._lastCheckpointLsn,
      checkpointCount: this._checkpointCount,
      degraded: false,
      complete: true,
      shards,
    };
  }

  async close() {
    return this._enqueueWrite(async () => {
      if (!this._open) return { closed: true };
      for (const handle of this._handles.values()) {
        try {
          handle.flush();
          handle.close();
        } catch {
          // Best-effort close
        }
      }
      this._handles.clear();
      this._handlePromises.clear();
      this._walHandle = null;
      this._checkpointHandle = null;
      this._open = false;
      return { closed: true };
    });
  }
}
