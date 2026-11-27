/**
 * HEX-DB Append-Only Write-Ahead Log (WAL)
 *
 * Binary frame layout (little-endian):
 *   +0x00  uint32  magic       ('HWAL' = 0x4C415748)
 *   +0x04  uint64  lsn         (strictly monotonic log sequence number, >= 1)
 *   +0x0C  uint8   op          (1 = PUT, 2 = DEL, 3 = CHECKPOINT)
 *   +0x0D  uint8   flags       (reserved, 0)
 *   +0x0E  uint16  shardLen    (UTF-8 byte length of shard name)
 *   +0x10  uint16  keyLen      (UTF-8 byte length of key)
 *   +0x12  uint16  reserved    (0)
 *   +0x14  uint32  valLen      (byte length of value payload)
 *   +0x18  bytes   shard       [shardLen]
 *   +...   bytes   key         [keyLen]
 *   +...   bytes   value       [valLen]
 *   +...   uint32  crc32       (IEEE CRC32 over bytes [0x00 .. end of value])
 */

export const WAL_MAGIC = 0x4c415748; // 'HWAL' in LE
export const WAL_HEADER_SIZE = 24;
export const WAL_TRAILER_SIZE = 4;
export const WAL_FRAME_OVERHEAD = WAL_HEADER_SIZE + WAL_TRAILER_SIZE;
export const WAL_DEFAULT_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB (§17.1 delta_wal.hdb)

export const WAL_OP_PUT = 1;
export const WAL_OP_DEL = 2;
export const WAL_OP_CHECKPOINT = 3;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

// Precomputed IEEE 802.3 CRC32 lookup table (polynomial 0xEDB88320).
const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC32_TABLE[i] = c >>> 0;
}

// Precomputed Castagnoli CRC32C lookup table (polynomial 0x82F63B78).
const CRC32C_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0x82f63b78 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC32C_TABLE[i] = c >>> 0;
}

/**
 * Compute IEEE CRC32 over a Uint8Array slice.
 */
export function crc32(bytes, start = 0, end = bytes.byteLength) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Compute Castagnoli CRC32C over a Uint8Array slice (used by HDB1 shard headers & checkpoints).
 */
export function crc32c(bytes, start = 0, end = bytes.byteLength) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = CRC32C_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toUint8Array(value) {
  if (value == null) return new Uint8Array(0);
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === 'string') return TEXT_ENCODER.encode(value);
  throw new TypeError('HEXDB_WAL_INVALID_VALUE: expected Uint8Array, ArrayBuffer, or string');
}

function concatChunks(chunks, totalBytes) {
  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    out.set(chunks[i], offset);
    offset += chunks[i].byteLength;
  }
  return out;
}

/**
 * Encode a single CRC32-protected WAL frame.
 */
export function encodeWalFrame({ lsn, op, shard = '', key = '', value = null, flags = 0 }) {
  if (!Number.isSafeInteger(lsn) || lsn < 1) {
    throw new RangeError(`HEXDB_WAL_INVALID_LSN: ${lsn}`);
  }
  if (op !== WAL_OP_PUT && op !== WAL_OP_DEL && op !== WAL_OP_CHECKPOINT) {
    throw new RangeError(`HEXDB_WAL_INVALID_OP: ${op}`);
  }
  const shardBytes = TEXT_ENCODER.encode(String(shard));
  const keyBytes = TEXT_ENCODER.encode(String(key));
  const valBytes = toUint8Array(value);

  if (shardBytes.byteLength > 0xffff) {
    throw new RangeError('HEXDB_WAL_SHARD_TOO_LONG');
  }
  if (keyBytes.byteLength > 0xffff) {
    throw new RangeError('HEXDB_WAL_KEY_TOO_LONG');
  }

  const totalLen = WAL_HEADER_SIZE + shardBytes.byteLength + keyBytes.byteLength + valBytes.byteLength + WAL_TRAILER_SIZE;
  const buf = new Uint8Array(totalLen);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  view.setUint32(0, WAL_MAGIC, true);
  const lsnLow = lsn >>> 0;
  const lsnHigh = Math.floor(lsn / 0x100000000) >>> 0;
  view.setUint32(4, lsnLow, true);
  view.setUint32(8, lsnHigh, true);
  view.setUint8(12, op);
  view.setUint8(13, flags & 0xff);
  view.setUint16(14, shardBytes.byteLength, true);
  view.setUint16(16, keyBytes.byteLength, true);
  view.setUint16(18, 0, true);
  view.setUint32(20, valBytes.byteLength, true);

  let pos = WAL_HEADER_SIZE;
  buf.set(shardBytes, pos);
  pos += shardBytes.byteLength;
  buf.set(keyBytes, pos);
  pos += keyBytes.byteLength;
  buf.set(valBytes, pos);
  pos += valBytes.byteLength;

  const checksum = crc32(buf, 0, pos);
  view.setUint32(pos, checksum, true);

  return buf;
}

/**
 * Decode and verify all valid contiguous frames from a raw WAL byte buffer.
 * Stops cleanly at the first corrupt or truncated frame (crash-recovery tail truncation).
 */
export function decodeWalStream(rawBytes) {
  const bytes = toUint8Array(rawBytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = [];
  let offset = 0;
  let lastValidLsn = 0;
  let corruptFrames = 0;
  let truncatedTail = false;
  let stopReason = null;

  while (offset < bytes.byteLength) {
    const remaining = bytes.byteLength - offset;
    if (remaining < WAL_FRAME_OVERHEAD) {
      truncatedTail = true;
      corruptFrames += 1;
      stopReason = 'truncated-header';
      break;
    }

    const magic = view.getUint32(offset, true);
    if (magic !== WAL_MAGIC) {
      corruptFrames += 1;
      stopReason = 'bad-magic';
      break;
    }

    const lsnLow = view.getUint32(offset + 4, true);
    const lsnHigh = view.getUint32(offset + 8, true);
    const lsn = lsnHigh * 0x100000000 + lsnLow;
    const op = view.getUint8(offset + 12);
    const flags = view.getUint8(offset + 13);
    const shardLen = view.getUint16(offset + 14, true);
    const keyLen = view.getUint16(offset + 16, true);
    const valLen = view.getUint32(offset + 20, true);

    if (op !== WAL_OP_PUT && op !== WAL_OP_DEL && op !== WAL_OP_CHECKPOINT) {
      corruptFrames += 1;
      stopReason = 'invalid-op';
      break;
    }
    if (!Number.isSafeInteger(lsn) || lsn <= lastValidLsn) {
      corruptFrames += 1;
      stopReason = 'non-monotonic-lsn';
      break;
    }

    const frameLen = WAL_HEADER_SIZE + shardLen + keyLen + valLen + WAL_TRAILER_SIZE;
    if (offset + frameLen > bytes.byteLength) {
      truncatedTail = true;
      corruptFrames += 1;
      stopReason = 'truncated-payload';
      break;
    }

    const payloadEnd = offset + frameLen - WAL_TRAILER_SIZE;
    const expectedCrc = view.getUint32(payloadEnd, true);
    const actualCrc = crc32(bytes, offset, payloadEnd);
    if (expectedCrc !== actualCrc) {
      corruptFrames += 1;
      stopReason = 'crc32-mismatch';
      break;
    }

    let pos = offset + WAL_HEADER_SIZE;
    const shard = TEXT_DECODER.decode(bytes.subarray(pos, pos + shardLen));
    pos += shardLen;
    const key = TEXT_DECODER.decode(bytes.subarray(pos, pos + keyLen));
    pos += keyLen;
    const value = bytes.slice(pos, pos + valLen);

    entries.push({ lsn, op, flags, shard, key, value });
    lastValidLsn = lsn;
    offset += frameLen;
  }

  return {
    entries,
    lastValidLsn,
    validBytes: offset,
    corruptFrames,
    truncatedTail,
    stopReason,
  };
}

/**
 * Build an in-memory Merge-on-Read overlay index from replayed WAL entries.
 * Returns Map<shard, Map<key, { op, value, lsn }>>.
 */
export function buildWalOverlayIndex(entries) {
  const index = new Map();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.op === WAL_OP_CHECKPOINT) continue;
    let shardMap = index.get(entry.shard);
    if (!shardMap) {
      shardMap = new Map();
      index.set(entry.shard, shardMap);
    }
    shardMap.set(entry.key, {
      op: entry.op,
      value: entry.op === WAL_OP_PUT ? entry.value : null,
      lsn: entry.lsn,
    });
  }
  return index;
}

/**
 * Append-only Write-Ahead Log manager.
 * Can operate purely in-memory or backed by an optional sink:
 *   sink = {
 *     append(frameUint8Array),
 *     readAll() -> Uint8Array,
 *     truncate(byteLength),
 *     replace?(fullUint8Array) // writes new buffer before truncating tail (crash-safe)
 *   }
 */
export class HexDbWal {
  constructor({ maxBytes = WAL_DEFAULT_MAX_BYTES, sink = null, initialLsn = 0 } = {}) {
    this.maxBytes = maxBytes;
    this._sink = sink;
    this._chunks = [];
    this._byteLength = 0;
    this._frameCount = 0;
    this._lastLsn = initialLsn;
    this._lastCheckpointLsn = 0;
  }

  get lastLsn() {
    return this._lastLsn;
  }

  get nextLsn() {
    return this._lastLsn + 1;
  }

  get lastCheckpointLsn() {
    return this._lastCheckpointLsn;
  }

  get byteLength() {
    return this._byteLength;
  }

  get frameCount() {
    return this._frameCount;
  }

  needsCompaction() {
    return this._byteLength >= this.maxBytes;
  }

  /**
   * Capture a lightweight snapshot of in-memory WAL state for rollback on failed writes.
   */
  snapshotState() {
    return {
      chunkCount: this._chunks.length,
      byteLength: this._byteLength,
      frameCount: this._frameCount,
      lastLsn: this._lastLsn,
      lastCheckpointLsn: this._lastCheckpointLsn,
    };
  }

  /**
   * Restore WAL state from a prior snapshot (used by backends to roll back failed writes).
   */
  restoreState(snap) {
    if (!snap) return;
    if (this._sink?.truncate) {
      this._sink.truncate(snap.byteLength);
    } else {
      this._chunks.length = snap.chunkCount;
    }
    this._byteLength = snap.byteLength;
    this._frameCount = snap.frameCount;
    this._lastLsn = snap.lastLsn;
    this._lastCheckpointLsn = snap.lastCheckpointLsn;
  }

  _appendFrame(op, shard, key, value, flags = 0) {
    const lsn = this._lastLsn + 1;
    const frame = encodeWalFrame({ lsn, op, shard, key, value, flags });
    if (this._sink?.append) {
      this._sink.append(frame);
    } else {
      this._chunks.push(frame);
    }
    this._lastLsn = lsn;
    this._byteLength += frame.byteLength;
    this._frameCount += 1;
    if (op === WAL_OP_CHECKPOINT) {
      this._lastCheckpointLsn = lsn;
    }
    return { lsn, bytesWritten: frame.byteLength, frame };
  }

  appendPut(shard, key, value) {
    return this._appendFrame(WAL_OP_PUT, shard, key, value);
  }

  appendDel(shard, key) {
    return this._appendFrame(WAL_OP_DEL, shard, key, null);
  }

  appendCheckpoint(metaBytes = null) {
    return this._appendFrame(WAL_OP_CHECKPOINT, '', '', metaBytes);
  }

  /**
   * Return the complete raw WAL bytes currently buffered or stored in the sink.
   */
  exportBytes() {
    if (this._sink?.readAll) {
      return toUint8Array(this._sink.readAll());
    }
    return concatChunks(this._chunks, this._byteLength);
  }

  /**
   * Replay WAL frames from rawBytes (or the backing sink / internal buffer).
   * Automatically truncates any corrupt/torn tail and restores monotonic LSN state.
   */
  replay(rawBytes = null) {
    const source = rawBytes != null ? toUint8Array(rawBytes) : this.exportBytes();
    const result = decodeWalStream(source);

    if (result.lastValidLsn > this._lastLsn) {
      this._lastLsn = result.lastValidLsn;
    }
    for (let i = 0; i < result.entries.length; i++) {
      if (result.entries[i].op === WAL_OP_CHECKPOINT) {
        this._lastCheckpointLsn = result.entries[i].lsn;
      }
    }

    if (result.corruptFrames > 0) {
      const validSlice = source.slice(0, result.validBytes);
      if (this._sink?.truncate) {
        this._sink.truncate(result.validBytes);
      } else {
        this._chunks = validSlice.byteLength > 0 ? [validSlice] : [];
      }
      this._byteLength = result.validBytes;
      this._frameCount = result.entries.length;
    } else if (rawBytes != null && !this._sink) {
      this._chunks = source.byteLength > 0 ? [source.slice()] : [];
      this._byteLength = source.byteLength;
      this._frameCount = result.entries.length;
    } else {
      this._byteLength = result.validBytes;
      this._frameCount = result.entries.length;
    }

    return result;
  }

  /**
   * Build the single compacted WAL buffer in memory without mutating current state.
   * Useful for transactional backends (e.g. IDB) that must persist before committing.
   */
  buildCompactedBuffer({ retainEntries = [], writeCheckpointMarker = true, metaBytes = null } = {}) {
    const frames = [];
    let totalBytes = 0;
    let nextLsn = this._lastLsn;
    let checkpointLsn = this._lastCheckpointLsn;

    if (writeCheckpointMarker) {
      nextLsn += 1;
      const ckFrame = encodeWalFrame({
        lsn: nextLsn,
        op: WAL_OP_CHECKPOINT,
        shard: '',
        key: '',
        value: metaBytes,
      });
      frames.push(ckFrame);
      totalBytes += ckFrame.byteLength;
      checkpointLsn = nextLsn;
    }

    for (let i = 0; i < retainEntries.length; i++) {
      const entry = retainEntries[i];
      if (entry.op === WAL_OP_PUT || entry.op === WAL_OP_DEL) {
        nextLsn += 1;
        const f = encodeWalFrame({
          lsn: nextLsn,
          op: entry.op,
          shard: entry.shard,
          key: entry.key,
          value: entry.op === WAL_OP_PUT ? entry.value : null,
        });
        frames.push(f);
        totalBytes += f.byteLength;
      }
    }

    const buffer = concatChunks(frames, totalBytes);
    return {
      buffer,
      frameCount: frames.length,
      checkpointLsn,
      lastLsn: nextLsn,
    };
  }

  /**
   * Commit a pre-built compacted buffer (from `buildCompactedBuffer`) into the WAL.
   */
  applyCompactedBuffer(built) {
    const prevBytes = this._byteLength;
    const prevFrames = this._frameCount;
    const buf = built.buffer;

    if (this._sink) {
      if (typeof this._sink.replace === 'function') {
        this._sink.replace(buf);
      } else {
        if (buf.byteLength > 0 && typeof this._sink.append === 'function') {
          this._sink.truncate?.(0);
          this._sink.append(buf);
        } else {
          this._sink.truncate?.(0);
        }
      }
    } else {
      this._chunks = buf.byteLength > 0 ? [buf] : [];
    }

    this._byteLength = buf.byteLength;
    this._frameCount = built.frameCount;
    this._lastLsn = built.lastLsn;
    this._lastCheckpointLsn = built.checkpointLsn;

    return {
      compactedFromBytes: prevBytes,
      compactedFromFrames: prevFrames,
      newBytes: this._byteLength,
      newFrames: this._frameCount,
      checkpointLsn: this._lastCheckpointLsn,
      lastLsn: this._lastLsn,
    };
  }

  /**
   * Compact the WAL after a checkpoint flush.
   * Builds the new checkpoint marker + retained entries into a single buffer
   * BEFORE writing to storage (never truncating to 0 ahead of writing).
   */
  compact({ retainEntries = [], writeCheckpointMarker = true, metaBytes = null } = {}) {
    const built = this.buildCompactedBuffer({ retainEntries, writeCheckpointMarker, metaBytes });
    return this.applyCompactedBuffer(built);
  }
}
