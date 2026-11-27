/**
 * HEX-DB Tier C In-Memory Sharded Backend
 *
 * Fallback for Node unit tests, opaque origins, private browsing, and
 * constrained environments. Implements the unified HEX-DB storage adapter
 * interface: open, get, put, del, batch, checkpoint, stats, close.
 *
 * Also exports shared HDB1 shard metadata helpers (64B HexDbShardHeader64)
 * used across OPFS, IDB, and Memory backends.
 */

import { HexDbWal, WAL_DEFAULT_MAX_BYTES, WAL_OP_PUT, WAL_OP_DEL, crc32c } from './hexdb-wal.js';

export const HEXDB_SHARD_MAGIC = 0x31424448; // 'HDB1' in LE
export const HEXDB_SHARD_HEADER_SIZE = 64;
export const HEXDB_SHARD_VERSION = 1;
export const HEXDB_DEFAULT_SHARD_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB
export const HEXDB_MEMORY_DEFAULT_MAX_BYTES = 24 * 1024 * 1024; // 24 MiB (§17.1 Tier C)

export const HEXDB_SHARD_NAMES = Object.freeze([
  'func_table',
  'callgraph',
  'xref_code',
  'xref_data',
  'xref_struct',
  'func_sig',
  'hexsig',
  'global_types',
  'delta_wal',
]);

const TEXT_ENCODER = new TextEncoder();

export function normalizeValueBytes(value) {
  if (value instanceof Uint8Array) return value.slice();
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value).slice();
  if (typeof value === 'string') return TEXT_ENCODER.encode(value);
  throw new TypeError('HEXDB_INVALID_VALUE: expected Uint8Array, ArrayBuffer, or string');
}

/**
 * Encode a 64-byte HDB1 shard header (HexDbShardHeader64).
 * Layout (LE):
 *   +0x00 uint32 magic ('HDB1')
 *   +0x04 uint16 version (1)
 *   +0x06 uint16 shardId
 *   +0x08 uint32 entryCount
 *   +0x0C uint32 dataBytes
 *   +0x10 uint32 dataCrc32c
 *   +0x14 uint32 lsnLow
 *   +0x18 uint32 lsnHigh
 *   +0x1C uint32 flags
 *   +0x20 uint8[8] sha256Prefix
 *   +0x28 uint8[20] reserved
 *   +0x3C uint32 headerCrc32c (over bytes 0x00..0x3B)
 */
export function encodeShardHeader64({
  shardId = 0,
  entryCount = 0,
  dataBytes = 0,
  dataCrc32c = 0,
  lsn = 0,
  flags = 0,
  sha256Prefix = null,
} = {}) {
  const buf = new Uint8Array(HEXDB_SHARD_HEADER_SIZE);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setUint32(0x00, HEXDB_SHARD_MAGIC, true);
  view.setUint16(0x04, HEXDB_SHARD_VERSION, true);
  view.setUint16(0x06, shardId & 0xffff, true);
  view.setUint32(0x08, entryCount >>> 0, true);
  view.setUint32(0x0c, dataBytes >>> 0, true);
  view.setUint32(0x10, dataCrc32c >>> 0, true);
  view.setUint32(0x14, lsn >>> 0, true);
  view.setUint32(0x18, Math.floor(lsn / 0x100000000) >>> 0, true);
  view.setUint32(0x1c, flags >>> 0, true);
  if (sha256Prefix) {
    const prefix = sha256Prefix instanceof Uint8Array
      ? sha256Prefix
      : TEXT_ENCODER.encode(String(sha256Prefix));
    buf.set(prefix.subarray(0, 8), 0x20);
  }
  const hdrCrc = crc32c(buf, 0, 0x3c);
  view.setUint32(0x3c, hdrCrc, true);
  return buf;
}

/**
 * Decode and verify a 64-byte HDB1 shard header. Returns null if corrupt or invalid.
 */
export function decodeShardHeader64(bytes) {
  if (!bytes || bytes.byteLength < HEXDB_SHARD_HEADER_SIZE) return null;
  const buf = bytes instanceof Uint8Array
    ? bytes.subarray(0, HEXDB_SHARD_HEADER_SIZE)
    : new Uint8Array(bytes, 0, HEXDB_SHARD_HEADER_SIZE);
  const view = new DataView(buf.buffer, buf.byteOffset, HEXDB_SHARD_HEADER_SIZE);
  if (view.getUint32(0x00, true) !== HEXDB_SHARD_MAGIC) return null;
  const expectedCrc = view.getUint32(0x3c, true);
  if (crc32c(buf, 0, 0x3c) !== expectedCrc) return null;
  const lsn = view.getUint32(0x18, true) * 0x100000000 + view.getUint32(0x14, true);
  return {
    magic: HEXDB_SHARD_MAGIC,
    version: view.getUint16(0x04, true),
    shardId: view.getUint16(0x06, true),
    entryCount: view.getUint32(0x08, true),
    dataBytes: view.getUint32(0x0c, true),
    dataCrc32c: view.getUint32(0x10, true),
    lsn,
    flags: view.getUint32(0x1c, true),
    sha256Prefix: buf.slice(0x20, 0x28),
  };
}

export class HexDbMemoryBackend {
  constructor(options = {}) {
    this.tier = 'memory';
    this._maxBytes = options.maxBytes ?? HEXDB_MEMORY_DEFAULT_MAX_BYTES;
    this._shardMaxBytes = options.shardMaxBytes ?? HEXDB_DEFAULT_SHARD_MAX_BYTES;
    this._walMaxBytes = options.walMaxBytes ?? WAL_DEFAULT_MAX_BYTES;
    this._binaryKey = options.binaryKey ?? 'default';
    this._open = false;
    this._shards = new Map(); // Map<shard, Map<key, Uint8Array>>
    this._lru = new Map(); // compositeKey -> { shard, key, bytes } in insertion/recency order
    this._totalBytes = 0;
    this._evictedCount = 0;
    this._degraded = false;
    this._checkpointCount = 0;
    this._wal = null;
  }

  _assertOpen() {
    if (!this._open) {
      throw new Error('HEXDB_NOT_OPEN: memory backend is not open');
    }
  }

  _compositeKey(shard, key) {
    return `${shard}\u0000${key}`;
  }

  _touchLru(shard, key, bytes) {
    const ck = this._compositeKey(shard, key);
    if (this._lru.has(ck)) {
      this._lru.delete(ck);
    }
    this._lru.set(ck, { shard, key, bytes });
  }

  _removeLru(shard, key) {
    const ck = this._compositeKey(shard, key);
    this._lru.delete(ck);
  }

  async open(options = {}) {
    if (options.binaryKey != null) this._binaryKey = String(options.binaryKey);
    if (options.maxBytes != null) this._maxBytes = options.maxBytes;
    if (options.shardMaxBytes != null) this._shardMaxBytes = options.shardMaxBytes;
    if (options.walMaxBytes != null) this._walMaxBytes = options.walMaxBytes;

    if (!this._wal) {
      this._wal = new HexDbWal({ maxBytes: this._walMaxBytes });
    }
    this._open = true;
    return {
      tier: this.tier,
      binaryKey: this._binaryKey,
      recoveredEntries: 0,
      lastLsn: this._wal.lastLsn,
    };
  }

  async get(shard, key) {
    this._assertOpen();
    const s = String(shard);
    const k = String(key);
    const shardMap = this._shards.get(s);
    if (!shardMap || !shardMap.has(k)) return null;
    const val = shardMap.get(k);
    this._touchLru(s, k, val.byteLength);
    return val.slice();
  }

  _putInternal(shard, key, valueBytes, { appendWal = true } = {}) {
    if (appendWal) {
      this._wal.appendPut(shard, key, valueBytes);
    }
    let shardMap = this._shards.get(shard);
    if (!shardMap) {
      shardMap = new Map();
      this._shards.set(shard, shardMap);
    }
    const prev = shardMap.get(key);
    if (prev) {
      this._totalBytes -= prev.byteLength;
    }
    shardMap.set(key, valueBytes);
    this._totalBytes += valueBytes.byteLength;
    this._touchLru(shard, key, valueBytes.byteLength);

    this._evictIfOverBudget(this._compositeKey(shard, key));
  }

  _delInternal(shard, key, { appendWal = true } = {}) {
    if (appendWal) {
      this._wal.appendDel(shard, key);
    }
    const shardMap = this._shards.get(shard);
    if (!shardMap) return false;
    const prev = shardMap.get(key);
    if (!prev) return false;
    shardMap.delete(key);
    this._totalBytes -= prev.byteLength;
    this._removeLru(shard, key);
    if (shardMap.size === 0) {
      this._shards.delete(shard);
    }
    return true;
  }

  _evictIfOverBudget(protectedCompositeKey = null) {
    if (this._totalBytes <= this._maxBytes) return 0;
    let evicted = 0;
    for (const [ck, entry] of this._lru) {
      if (this._totalBytes <= this._maxBytes) break;
      if (ck === protectedCompositeKey && this._lru.size > 1) continue;
      const shardMap = this._shards.get(entry.shard);
      if (shardMap && shardMap.has(entry.key)) {
        const val = shardMap.get(entry.key);
        shardMap.delete(entry.key);
        this._totalBytes -= val.byteLength;
        if (shardMap.size === 0) this._shards.delete(entry.shard);
      }
      this._lru.delete(ck);
      this._evictedCount += 1;
      this._degraded = true;
      evicted += 1;
    }
    return evicted;
  }

  /**
   * Explicitly evict LRU entries down to targetBytes (called by MemoryBudget under pressure).
   */
  evictToBytes(targetBytes) {
    this._assertOpen();
    let freed = 0;
    for (const [ck, entry] of this._lru) {
      if (this._totalBytes <= targetBytes) break;
      const shardMap = this._shards.get(entry.shard);
      if (shardMap && shardMap.has(entry.key)) {
        const val = shardMap.get(entry.key);
        shardMap.delete(entry.key);
        this._totalBytes -= val.byteLength;
        freed += val.byteLength;
        if (shardMap.size === 0) this._shards.delete(entry.shard);
      }
      this._lru.delete(ck);
      this._evictedCount += 1;
      this._degraded = true;
    }
    return freed;
  }

  async put(shard, key, value) {
    this._assertOpen();
    const s = String(shard);
    const k = String(key);
    const bytes = normalizeValueBytes(value);
    this._putInternal(s, k, bytes);
    if (this._wal.needsCompaction()) {
      await this.checkpoint();
    }
    return { lsn: this._wal.lastLsn, bytes: bytes.byteLength, degraded: this._degraded };
  }

  async del(shard, key) {
    this._assertOpen();
    const s = String(shard);
    const k = String(key);
    const existed = this._delInternal(s, k);
    if (this._wal.needsCompaction()) {
      await this.checkpoint();
    }
    return { lsn: this._wal.lastLsn, deleted: existed };
  }

  async batch(ops) {
    this._assertOpen();
    if (!Array.isArray(ops)) {
      throw new TypeError('HEXDB_BATCH_INVALID: ops must be an array');
    }
    let applied = 0;
    for (let i = 0; i < ops.length; i++) {
      const item = ops[i];
      if (item.op === 'put' || item.op === WAL_OP_PUT) {
        const bytes = normalizeValueBytes(item.value);
        this._putInternal(String(item.shard), String(item.key), bytes);
        applied += 1;
      } else if (item.op === 'del' || item.op === WAL_OP_DEL) {
        this._delInternal(String(item.shard), String(item.key));
        applied += 1;
      } else {
        throw new TypeError(`HEXDB_BATCH_UNKNOWN_OP: ${item.op}`);
      }
    }
    if (this._wal.needsCompaction()) {
      await this.checkpoint();
    }
    return { applied, lsn: this._wal.lastLsn, degraded: this._degraded };
  }

  async checkpoint() {
    this._assertOpen();
    const res = this._wal.compact({ writeCheckpointMarker: true });
    this._checkpointCount += 1;
    return {
      checkpointCount: this._checkpointCount,
      checkpointLsn: res.checkpointLsn,
      compactedFromBytes: res.compactedFromBytes,
      walBytes: res.newBytes,
    };
  }

  async listKeys(shard) {
    this._assertOpen();
    const shardMap = this._shards.get(String(shard));
    if (!shardMap) return [];
    return [...shardMap.keys()];
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
      maxBytes: this._maxBytes,
      shardMaxBytes: this._shardMaxBytes,
      shardCount: this._shards.size,
      entryCount,
      walBytes: this._wal ? this._wal.byteLength : 0,
      walLsn: this._wal ? this._wal.lastLsn : 0,
      checkpointCount: this._checkpointCount,
      evictedCount: this._evictedCount,
      degraded: this._degraded,
      complete: !this._degraded,
      shards,
    };
  }

  async close() {
    if (!this._open) return { closed: true };
    this._open = false;
    return { closed: true };
  }
}
