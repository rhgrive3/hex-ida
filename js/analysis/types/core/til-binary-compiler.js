/**
 * TIL1 Binary Format Compiler, Parser, Validator & Zero-Copy View.
 * 100% parity with cpp/src/analysis/til_engine.cpp and hex_ida_beyond_ida_design.md §3.1
 * (Little-Endian, 4B aligned, absolute sig_off in Hash/Sel Index).
 * INV-005: ZERO imports from js/targets/architecture/.
 */

import {
  TIL_NS,
  TIL_TYPE_INVALID,
  HEX_TYPE_INVALID,
  unpackHexTypeId,
  makeHexTypeId,
} from './til-lite-data.js';

export const TIL1_MAGIC = 'TIL1';
export const TIL1_MAGIC_U32 = 0x314C4954; // 'T','I','L','1' little-endian
export const TIL1_VERSION = 1;
export const TIL1_HEADER_SIZE = 36;
export const TIL1_BUCKET_DIR_OFFSET = 0x24;
export const TIL1_BUCKET_DIR_SIZE = 516; // uint16_t buckets[257] + uint16_t pad
export const TIL1_HASH_INDEX_OFFSET = 0x228; // 36 + 516 = 552 = 0x228
export const TIL1_MAX_ARITY = 12;
export const TIL1_CORE_MAX_BYTES = 160 * 1024;

export const TIL1_FLAG = Object.freeze({
  IS_CORE: 1 << 0,
  LOCAL_TID_RELATIVE: 1 << 1,
  HAS_EXT_CHUNK: 1 << 2,
});

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

// ---------------------------------------------------------------------------
// Deterministic FNV-1a 32-bit (checksum) & 64-bit (symbol/selector hash)
// ---------------------------------------------------------------------------
export function fnv1a32(bytes, zeroStart = -1, zeroEnd = -1) {
  let hash = 0x811C9DC5;
  for (let i = 0; i < bytes.length; i++) {
    const b = i >= zeroStart && i < zeroEnd ? 0 : bytes[i];
    hash ^= b;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function fnv1a64(strOrBytes) {
  const bytes = typeof strOrBytes === 'string' ? textEncoder.encode(strOrBytes) : strOrBytes;
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i]);
    hash = (hash * prime) & mask;
  }
  const lo = Number(hash & 0xffffffffn) >>> 0;
  const hi = Number((hash >> 32n) & 0xffffffffn) >>> 0;
  return { hash, lo, hi, bucket: (hi >>> 24) & 0xFF };
}

function align4(n) {
  return (n + 3) & ~3;
}

function compareHash64(aHi, aLo, bHi, bLo) {
  if (aHi !== bHi) return aHi < bHi ? -1 : 1;
  if (aLo !== bLo) return aLo < bLo ? -1 : 1;
  return 0;
}

function validateNulString(bytes, strStart, strEnd, nameOff) {
  if (strStart >= strEnd) return false;
  const poolSize = strEnd - strStart;
  if (nameOff >= poolSize) return false;
  for (let i = strStart + nameOff; i < strEnd; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// String Pool Builder (UTF-8 NUL-terminated, deduplicated)
// ---------------------------------------------------------------------------
class StringPoolBuilder {
  constructor() {
    this.map = new Map();
    this.chunks = [];
    this.offset = 0;
    this.intern('');
  }

  intern(str) {
    const s = str == null ? '' : String(str);
    const existing = this.map.get(s);
    if (existing !== undefined) return existing;
    const encoded = textEncoder.encode(s);
    const off = this.offset;
    const withNul = new Uint8Array(encoded.length + 1);
    withNul.set(encoded, 0);
    withNul[encoded.length] = 0;
    this.chunks.push(withNul);
    this.map.set(s, off);
    this.offset += withNul.length;
    return off;
  }

  toUint8Array() {
    const out = new Uint8Array(this.offset);
    let pos = 0;
    for (const c of this.chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Compile IR -> TIL1 Binary Buffer
// ---------------------------------------------------------------------------
export function compileTil1(ir) {
  if (!ir || typeof ir !== 'object') {
    throw new Error('compileTil1: IR object is required');
  }

  const types = Array.isArray(ir.types) ? ir.types : [];
  const functions = Array.isArray(ir.functions) ? ir.functions : [];
  const selectors = Array.isArray(ir.selectors) ? ir.selectors : [];
  const enums = Array.isArray(ir.enums) ? ir.enums : [];
  const structLayouts = Array.isArray(ir.structLayouts) ? ir.structLayouts : [];

  const isCore = Boolean(ir.isCore);
  const localTidRelative = ir.localTidRelative !== undefined ? Boolean(ir.localTidRelative) : !isCore;
  const hasExtChunk = enums.length > 0 || structLayouts.length > 0;
  const abiMask = (ir.abiMask ?? 0x01) & 0x1F;

  let headerFlags = (abiMask << 3) & 0xFF;
  if (isCore) headerFlags |= TIL1_FLAG.IS_CORE;
  if (localTidRelative) headerFlags |= TIL1_FLAG.LOCAL_TID_RELATIVE;
  if (hasExtChunk) headerFlags |= TIL1_FLAG.HAS_EXT_CHUNK;

  const strPool = new StringPoolBuilder();

  const fnMap = new Map();
  for (const f of functions) {
    if (!f || !f.name) continue;
    fnMap.set(f.name, f);
  }
  const uniqueFunctions = Array.from(fnMap.values());

  const selMap = new Map();
  for (const s of selectors) {
    if (!s || !s.name) continue;
    selMap.set(s.name, s);
  }
  const uniqueSelectors = Array.from(selMap.values());

  const typeList = [];
  const seenTids = new Set();
  for (const t of types) {
    if (!t || !t.name) continue;
    const tid = (t.tid ?? 0) & 0xFFFF;
    if (tid !== 0 && seenTids.has(tid)) continue;
    if (tid !== 0) seenTids.add(tid);
    typeList.push({
      tid,
      kind: (t.kind ?? 0) & 0xFFFF,
      bits: (t.bits ?? 0) & 0xFF,
      qualifiers: (t.qualifiers ?? 0) & 0xFF,
      pointeeTid: (t.pointeeTid ?? 0) & 0xFFFF,
      nameOff: strPool.intern(t.name),
    });
  }

  const sigBlobs = [];
  let sigPoolSize = 0;

  function addSigBlob(entry) {
    const params = Array.isArray(entry.paramHexTypes)
      ? entry.paramHexTypes.slice(0, TIL1_MAX_ARITY)
      : [];
    const arity = params.length;
    const relOff = sigPoolSize;
    const nameOff = strPool.intern(entry.name);
    sigBlobs.push({
      relOff,
      nameOff,
      retHexType: (entry.retHexType ?? 0) >>> 0,
      flags: (entry.flags ?? 0) & 0xFF,
      arity,
      fmtArgIdx: entry.fmtArgIdx !== undefined ? (entry.fmtArgIdx & 0xFF) : 0xFF,
      rsv: (entry.callConv ?? 0) & 0x03,
      params: params.map((p) => p >>> 0),
    });
    sigPoolSize += 12 + 4 * arity;
    return relOff;
  }

  const hashEntries = [];
  for (const f of uniqueFunctions) {
    const sigRelOff = addSigBlob(f);
    const h = fnv1a64(f.name);
    hashEntries.push({ lo: h.lo, hi: h.hi, bucket: h.bucket, sigRelOff });
  }
  hashEntries.sort((a, b) => compareHash64(a.hi, a.lo, b.hi, b.lo));

  const selEntries = [];
  for (const s of uniqueSelectors) {
    const sigRelOff = addSigBlob(s);
    const h = fnv1a64(s.name);
    selEntries.push({ lo: h.lo, hi: h.hi, sigRelOff });
  }
  selEntries.sort((a, b) => compareHash64(a.hi, a.lo, b.hi, b.lo));

  // Bucket Dir (257 x u16)
  const buckets = new Uint16Array(257);
  let cursor = 0;
  for (let b = 0; b < 256; b++) {
    buckets[b] = cursor;
    while (cursor < hashEntries.length && hashEntries[cursor].bucket === b) {
      cursor++;
    }
  }
  buckets[256] = hashEntries.length;

  // ExtChunk entries
  const compiledEnums = enums.map((e) => ({
    tid: (e.tid ?? 0) & 0xFFFF,
    items: (e.items || []).map((item) => ({
      value: BigInt(item.value ?? 0),
      nameOff: strPool.intern(item.name || ''),
    })),
  }));

  const compiledLayouts = structLayouts.map((s) => ({
    tid: (s.tid ?? 0) & 0xFFFF,
    totalSize: (s.totalSize ?? 0) >>> 0,
    members: (s.members || []).map((m) => ({
      offset: (m.offset ?? 0) >>> 0,
      hexType: (m.hexType ?? 0) >>> 0,
      nameOff: strPool.intern(m.name || ''),
      size: (m.size ?? 0) & 0xFFFF,
      bfLsb: (m.bfLsb ?? 0) & 0xFF,
      bfWidth: (m.bfWidth ?? 0) & 0xFF,
    })),
  }));

  const strPoolBytes = strPool.toUint8Array();

  // Compute exact 4B-aligned section offsets
  const hashIndexOff = TIL1_HASH_INDEX_OFFSET; // 0x228
  const selIndexOff = hashIndexOff + hashEntries.length * 12;
  const typeDescOff = selIndexOff + selEntries.length * 12;
  const sigPoolOff = typeDescOff + typeList.length * 12;
  const strPoolOff = sigPoolOff + sigPoolSize;

  let extChunkOff = 0;
  let extChunkSize = 0;
  if (hasExtChunk) {
    extChunkOff = align4(strPoolOff + strPoolBytes.length);
    const headerBytes = 8;
    const enumDefsBytes = compiledEnums.length * 8;
    const layoutDefsBytes = compiledLayouts.length * 12;
    let enumItemsBytes = 0;
    for (const e of compiledEnums) enumItemsBytes += e.items.length * 16;
    let structMembersBytes = 0;
    for (const l of compiledLayouts) structMembersBytes += l.members.length * 16;
    extChunkSize = headerBytes + enumDefsBytes + layoutDefsBytes + enumItemsBytes + structMembersBytes;
  }

  const totalSize = hasExtChunk
    ? extChunkOff + extChunkSize
    : align4(strPoolOff + strPoolBytes.length);

  const buf = new ArrayBuffer(totalSize);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);

  // 1. Header (36 bytes)
  view.setUint32(0x00, TIL1_MAGIC_U32, true);
  view.setUint16(0x04, TIL1_VERSION, true);
  view.setUint16(0x06, headerFlags, true);
  view.setUint32(0x08, hashEntries.length, true);
  view.setUint32(0x0C, selEntries.length, true);
  view.setUint32(0x10, typeList.length, true);
  view.setUint32(0x14, sigPoolOff, true);
  view.setUint32(0x18, strPoolOff, true);
  view.setUint32(0x1C, extChunkOff, true);
  view.setUint32(0x20, 0, true);

  // 2. Bucket Dir (516 bytes at 0x24)
  for (let i = 0; i < 257; i++) {
    view.setUint16(TIL1_BUCKET_DIR_OFFSET + i * 2, buckets[i], true);
  }
  view.setUint16(TIL1_BUCKET_DIR_OFFSET + 257 * 2, 0, true);

  // 3. Hash Index (N * 12B) — sig_off is absolute byte offset into TIL1 blob (parity with til_engine.cpp)
  let pos = hashIndexOff;
  for (const e of hashEntries) {
    view.setUint32(pos, e.lo, true);
    view.setUint32(pos + 4, e.hi, true);
    view.setUint32(pos + 8, sigPoolOff + e.sigRelOff, true);
    pos += 12;
  }

  // 4. Sel Index (M * 12B) — sig_off is absolute byte offset into TIL1 blob
  pos = selIndexOff;
  for (const e of selEntries) {
    view.setUint32(pos, e.lo, true);
    view.setUint32(pos + 4, e.hi, true);
    view.setUint32(pos + 8, sigPoolOff + e.sigRelOff, true);
    pos += 12;
  }

  // 5. TypeDesc (T * 12B)
  pos = typeDescOff;
  for (const t of typeList) {
    view.setUint16(pos, t.kind, true);
    view.setUint8(pos + 2, t.bits);
    view.setUint8(pos + 3, t.qualifiers);
    view.setUint16(pos + 4, t.pointeeTid, true);
    view.setUint16(pos + 6, t.tid, true);
    view.setUint32(pos + 8, t.nameOff, true);
    pos += 12;
  }

  // 6. SigPool
  for (const s of sigBlobs) {
    const p = sigPoolOff + s.relOff;
    view.setUint32(p, s.nameOff, true);
    view.setUint32(p + 4, s.retHexType, true);
    view.setUint8(p + 8, s.flags);
    view.setUint8(p + 9, s.arity);
    view.setUint8(p + 10, s.fmtArgIdx);
    view.setUint8(p + 11, s.rsv);
    for (let i = 0; i < s.arity; i++) {
      view.setUint32(p + 12 + i * 4, s.params[i], true);
    }
  }

  // 7. StringPool
  bytes.set(strPoolBytes, strPoolOff);

  // 8. ExtChunk (optional)
  if (hasExtChunk) {
    view.setUint32(extChunkOff, compiledEnums.length, true);
    view.setUint32(extChunkOff + 4, compiledLayouts.length, true);

    const enumDefsOff = extChunkOff + 8;
    const layoutDefsOff = enumDefsOff + compiledEnums.length * 8;
    let payloadOff = layoutDefsOff + compiledLayouts.length * 12;

    for (let i = 0; i < compiledEnums.length; i++) {
      const e = compiledEnums[i];
      const defPos = enumDefsOff + i * 8;
      view.setUint16(defPos, e.tid, true);
      view.setUint16(defPos + 2, e.items.length, true);
      view.setUint32(defPos + 4, payloadOff - extChunkOff, true);

      for (const item of e.items) {
        const val = BigInt.asIntN(64, item.value);
        const lo = Number(val & 0xffffffffn) >>> 0;
        const hi = Number((val >> 32n) & 0xffffffffn) >>> 0;
        view.setUint32(payloadOff, lo, true);
        view.setUint32(payloadOff + 4, hi, true);
        view.setUint32(payloadOff + 8, item.nameOff, true);
        view.setUint32(payloadOff + 12, 0, true);
        payloadOff += 16;
      }
    }

    for (let i = 0; i < compiledLayouts.length; i++) {
      const l = compiledLayouts[i];
      const defPos = layoutDefsOff + i * 12;
      view.setUint16(defPos, l.tid, true);
      view.setUint16(defPos + 2, l.members.length, true);
      view.setUint32(defPos + 4, l.totalSize, true);
      view.setUint32(defPos + 8, payloadOff - extChunkOff, true);

      for (const m of l.members) {
        view.setUint32(payloadOff, m.offset, true);
        view.setUint32(payloadOff + 4, m.hexType, true);
        view.setUint32(payloadOff + 8, m.nameOff, true);
        view.setUint16(payloadOff + 12, m.size, true);
        view.setUint8(payloadOff + 14, m.bfLsb);
        view.setUint8(payloadOff + 15, m.bfWidth);
        payloadOff += 16;
      }
    }
  }

  // 9. FNV-1a 32-bit checksum over 0x00..EOF (with 0x20..0x23 zeroed)
  const checksum = fnv1a32(bytes, 0x20, 0x24);
  view.setUint32(0x20, checksum, true);

  return bytes;
}

// ---------------------------------------------------------------------------
// Validate TIL1 Buffer (fail-closed, full parity with til_engine.cpp)
// ---------------------------------------------------------------------------
export function validateTil1Buffer(input) {
  const bytes = input instanceof Uint8Array
    ? input
    : input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : null;
  if (!bytes) {
    return { ok: false, error: 'TIL1 buffer must be Uint8Array or ArrayBuffer' };
  }
  if (bytes.byteLength < TIL1_HASH_INDEX_OFFSET) {
    return { ok: false, error: `TIL1 buffer too small (${bytes.byteLength} bytes)` };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0x00, true);
  if (magic !== TIL1_MAGIC_U32) {
    return { ok: false, error: `Invalid TIL1 magic: 0x${magic.toString(16)}` };
  }
  const version = view.getUint16(0x04, true);
  if (version !== TIL1_VERSION) {
    return { ok: false, error: `Unsupported TIL1 version: ${version}` };
  }

  const flags = view.getUint16(0x06, true);
  const entryCount = view.getUint32(0x08, true);
  const selCount = view.getUint32(0x0C, true);
  const typeCount = view.getUint32(0x10, true);
  const sigPoolOff = view.getUint32(0x14, true);
  const strPoolOff = view.getUint32(0x18, true);
  const extChunkOff = view.getUint32(0x1C, true);
  const storedChecksum = view.getUint32(0x20, true);

  if (entryCount > 65535) {
    return { ok: false, error: `entry_count (${entryCount}) exceeds 65535` };
  }

  const computedChecksum = fnv1a32(bytes, 0x20, 0x24);
  if (computedChecksum !== storedChecksum) {
    return {
      ok: false,
      error: `TIL1 checksum mismatch: expected 0x${storedChecksum.toString(16)}, got 0x${computedChecksum.toString(16)}`,
    };
  }

  const expectedSigPoolOff = TIL1_HASH_INDEX_OFFSET + (entryCount + selCount + typeCount) * 12;
  if (sigPoolOff < expectedSigPoolOff || sigPoolOff > bytes.byteLength || (sigPoolOff & 3) !== 0) {
    return { ok: false, error: `Invalid sig_pool_off: ${sigPoolOff}` };
  }
  if (strPoolOff < sigPoolOff || strPoolOff > bytes.byteLength) {
    return { ok: false, error: `Invalid str_pool_off: ${strPoolOff}` };
  }

  const hasExt = (flags & TIL1_FLAG.HAS_EXT_CHUNK) !== 0;
  let strPoolEnd = bytes.byteLength;
  if (hasExt) {
    if (extChunkOff < strPoolOff || extChunkOff + 8 > bytes.byteLength || (extChunkOff & 3) !== 0) {
      return { ok: false, error: `Invalid ext_chunk_off: ${extChunkOff}` };
    }
    strPoolEnd = extChunkOff;
  } else if (extChunkOff !== 0) {
    return { ok: false, error: 'Non-zero ext_chunk_off without HAS_EXT_CHUNK flag' };
  }

  // Verify Bucket Dir monotonicity and sentinel
  const bucketStarts = new Uint16Array(257);
  let prev = 0;
  for (let i = 0; i <= 256; i++) {
    const b = view.getUint16(TIL1_BUCKET_DIR_OFFSET + i * 2, true);
    if (b < prev || b > entryCount) {
      return { ok: false, error: `Invalid bucket directory at index ${i}` };
    }
    bucketStarts[i] = b;
    prev = b;
  }
  if (bucketStarts[256] !== entryCount) {
    return { ok: false, error: `buckets[256] (${bucketStarts[256]}) !== entry_count (${entryCount})` };
  }

  // Verify Hash Index: sorted 64-bit hashes, bucket membership, SigBlob bounds, arity <= 12, NUL-terminated nameOff
  const hashOff = TIL1_HASH_INDEX_OFFSET;
  let prevHashHi = 0;
  let prevHashLo = 0;
  for (let i = 0; i < entryCount; i++) {
    const ep = hashOff + i * 12;
    const hLo = view.getUint32(ep, true);
    const hHi = view.getUint32(ep + 4, true);
    if (i > 0 && compareHash64(hHi, hLo, prevHashHi, prevHashLo) < 0) {
      return { ok: false, error: `Hash index not sorted ascending at entry ${i}` };
    }
    prevHashHi = hHi;
    prevHashLo = hLo;

    const bucket = (hHi >>> 24) & 0xFF;
    if (i < bucketStarts[bucket] || i >= bucketStarts[bucket + 1]) {
      return { ok: false, error: `Hash entry ${i} (bucket ${bucket}) outside bucket range [${bucketStarts[bucket]}, ${bucketStarts[bucket + 1]})` };
    }

    const absOff = view.getUint32(ep + 8, true);
    if (absOff < sigPoolOff || absOff + 12 > strPoolOff || (absOff & 3) !== 0) {
      return { ok: false, error: `Invalid sig_off (${absOff}) at hash entry ${i}` };
    }
    const nameOff = view.getUint32(absOff, true);
    if (!validateNulString(bytes, strPoolOff, strPoolEnd, nameOff)) {
      return { ok: false, error: `Invalid or non-NUL-terminated name_off (${nameOff}) at hash entry ${i}` };
    }
    const arity = view.getUint8(absOff + 9);
    if (arity > TIL1_MAX_ARITY || absOff + 12 + arity * 4 > strPoolOff) {
      return { ok: false, error: `Invalid arity (${arity}) at hash entry ${i}` };
    }
  }

  // Verify Sel Index: sorted 64-bit hashes, SigBlob bounds, arity <= 12, NUL-terminated nameOff
  const selOff = hashOff + entryCount * 12;
  prevHashHi = 0;
  prevHashLo = 0;
  for (let i = 0; i < selCount; i++) {
    const ep = selOff + i * 12;
    const hLo = view.getUint32(ep, true);
    const hHi = view.getUint32(ep + 4, true);
    if (i > 0 && compareHash64(hHi, hLo, prevHashHi, prevHashLo) < 0) {
      return { ok: false, error: `Sel index not sorted ascending at entry ${i}` };
    }
    prevHashHi = hHi;
    prevHashLo = hLo;

    const absOff = view.getUint32(ep + 8, true);
    if (absOff < sigPoolOff || absOff + 12 > strPoolOff || (absOff & 3) !== 0) {
      return { ok: false, error: `Invalid sig_off (${absOff}) at selector entry ${i}` };
    }
    const nameOff = view.getUint32(absOff, true);
    if (!validateNulString(bytes, strPoolOff, strPoolEnd, nameOff)) {
      return { ok: false, error: `Invalid or non-NUL-terminated name_off (${nameOff}) at selector entry ${i}` };
    }
    const arity = view.getUint8(absOff + 9);
    if (arity > TIL1_MAX_ARITY || absOff + 12 + arity * 4 > strPoolOff) {
      return { ok: false, error: `Invalid arity (${arity}) at selector entry ${i}` };
    }
  }

  // Verify TypeDesc nameOff NUL termination
  const typeDescOff = selOff + selCount * 12;
  for (let i = 0; i < typeCount; i++) {
    const nameOff = view.getUint32(typeDescOff + i * 12 + 8, true);
    if (!validateNulString(bytes, strPoolOff, strPoolEnd, nameOff)) {
      return { ok: false, error: `Invalid or non-NUL-terminated name_off (${nameOff}) at TypeDesc ${i}` };
    }
  }

  return {
    ok: true,
    header: {
      magic: TIL1_MAGIC,
      version,
      flags,
      isCore: (flags & TIL1_FLAG.IS_CORE) !== 0,
      localTidRelative: (flags & TIL1_FLAG.LOCAL_TID_RELATIVE) !== 0,
      hasExtChunk: hasExt,
      abiMask: (flags >>> 3) & 0x1F,
      entryCount,
      selCount,
      typeCount,
      sigPoolOff,
      strPoolOff,
      extChunkOff,
      checksumFnv32: storedChecksum,
      byteLength: bytes.byteLength,
    },
  };
}

// ---------------------------------------------------------------------------
// Zero-Copy TIL1 View (O(1) bucketed lookup + relative TID remapping)
// ---------------------------------------------------------------------------
export class Til1View {
  constructor(buffer, { tidBase = TIL_NS.PACK_MIN, tidCap = 2560, packId = '' } = {}) {
    const validation = validateTil1Buffer(buffer);
    if (!validation.ok) {
      throw new Error(`Til1View: ${validation.error}`);
    }
    this.bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.header = validation.header;
    this.tidBase = tidBase & 0xFFFF;
    this.tidCap = tidCap;
    this.packId = packId;

    this.hashIndexOff = TIL1_HASH_INDEX_OFFSET;
    this.selIndexOff = this.hashIndexOff + this.header.entryCount * 12;
    this.typeDescOff = this.selIndexOff + this.header.selCount * 12;
    this.strPoolEnd = this.header.hasExtChunk ? this.header.extChunkOff : this.bytes.byteLength;

    this.typesByTid = new Map();
    this.typesByName = new Map();
    this._indexTypes();
  }

  /**
   * Remaps pack-relative TilTypeIds strictly in [0x1000..0x5FFF] with tidCap check
   * (100% parity with C++ til_engine.cpp remap_tid).
   */
  remapTid(localTid) {
    const tid = localTid & 0xFFFF;
    if (!this.header.localTidRelative) return tid;
    if (tid < TIL_NS.PACK_MIN || tid > TIL_NS.PACK_MAX) {
      return tid;
    }
    const delta = tid - TIL_NS.PACK_MIN;
    if (this.tidCap > 0 && delta >= this.tidCap) {
      return TIL_TYPE_INVALID;
    }
    const mapped = this.tidBase + delta;
    if (mapped >= TIL_TYPE_INVALID) {
      return TIL_TYPE_INVALID;
    }
    return mapped & 0xFFFF;
  }

  remapHexType(hexTypeId) {
    const v = hexTypeId >>> 0;
    if (v === 0 || v === HEX_TYPE_INVALID || !this.header.localTidRelative) return v;
    const base = v & 0xFFFF;
    if (base < TIL_NS.PACK_MIN || base > TIL_NS.PACK_MAX) return v;
    const remapped = this.remapTid(base);
    if (remapped === TIL_TYPE_INVALID) return HEX_TYPE_INVALID;
    return ((v & 0xFFFF0000) | remapped) >>> 0;
  }

  readString(strOff) {
    const start = this.header.strPoolOff + strOff;
    if (start < this.header.strPoolOff || start >= this.strPoolEnd) return '';
    let end = start;
    while (end < this.strPoolEnd && this.bytes[end] !== 0) end++;
    return textDecoder.decode(this.bytes.subarray(start, end));
  }

  _indexTypes() {
    const count = this.header.typeCount;
    for (let i = 0; i < count; i++) {
      const p = this.typeDescOff + i * 12;
      const kind = this.view.getUint16(p, true);
      const bits = this.view.getUint8(p + 2);
      const qualifiers = this.view.getUint8(p + 3);
      const rawPointee = this.view.getUint16(p + 4, true);
      const rawTid = this.view.getUint16(p + 6, true);
      const nameOff = this.view.getUint32(p + 8, true);
      const name = this.readString(nameOff);
      const localTid = rawTid !== 0 ? rawTid : (this.header.isCore ? TIL_NS.CORE_MIN + i : TIL_NS.PACK_MIN + i);
      const tid = this.remapTid(localTid);
      const pointeeTid = this.remapTid(rawPointee);
      const desc = { tid, localTid, name, kind, bits, qualifiers, pointeeTid };
      if (tid !== TIL_TYPE_INVALID) {
        this.typesByTid.set(tid, desc);
      }
      if (name) this.typesByName.set(name, desc);
    }
  }

  _readSigAt(absSigOff, sigIndex) {
    const p = absSigOff;
    const nameOff = this.view.getUint32(p, true);
    const retHexType = this.remapHexType(this.view.getUint32(p + 4, true));
    const flags = this.view.getUint8(p + 8);
    const arity = this.view.getUint8(p + 9);
    const fmtArgIdx = this.view.getUint8(p + 10);
    const rsv = this.view.getUint8(p + 11);
    const paramHexTypes = new Array(arity);
    for (let i = 0; i < arity; i++) {
      paramHexTypes[i] = this.remapHexType(this.view.getUint32(p + 12 + i * 4, true));
    }
    return {
      name: this.readString(nameOff),
      retHexType,
      flags,
      arity,
      fmtArgIdx,
      formatFamily: (flags >>> 2) & 0x07,
      callConv: rsv & 0x03,
      sigIndex,
      paramHexTypes,
    };
  }

  lookupSymbol(symName) {
    if (!symName || this.header.entryCount === 0) return null;
    const h = fnv1a64(symName);
    let lo = this.view.getUint16(TIL1_BUCKET_DIR_OFFSET + h.bucket * 2, true);
    let hi = this.view.getUint16(TIL1_BUCKET_DIR_OFFSET + (h.bucket + 1) * 2, true) - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const p = this.hashIndexOff + mid * 12;
      const eLo = this.view.getUint32(p, true);
      const eHi = this.view.getUint32(p + 4, true);
      const cmp = compareHash64(eHi, eLo, h.hi, h.lo);
      if (cmp === 0) {
        const absSigOff = this.view.getUint32(p + 8, true);
        const rec = this._readSigAt(absSigOff, mid);
        if (rec.name === symName) return rec;
        for (let k = mid - 1; k >= 0; k--) {
          const kp = this.hashIndexOff + k * 12;
          if (this.view.getUint32(kp + 4, true) !== h.hi || this.view.getUint32(kp, true) !== h.lo) break;
          const r = this._readSigAt(this.view.getUint32(kp + 8, true), k);
          if (r.name === symName) return r;
        }
        for (let k = mid + 1; k < this.header.entryCount; k++) {
          const kp = this.hashIndexOff + k * 12;
          if (this.view.getUint32(kp + 4, true) !== h.hi || this.view.getUint32(kp, true) !== h.lo) break;
          const r = this._readSigAt(this.view.getUint32(kp + 8, true), k);
          if (r.name === symName) return r;
        }
        return null;
      }
      if (cmp < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }

  lookupSelector(selKey) {
    if (!selKey || this.header.selCount === 0) return null;
    const h = fnv1a64(selKey);
    let lo = 0;
    let hi = this.header.selCount - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const p = this.selIndexOff + mid * 12;
      const eLo = this.view.getUint32(p, true);
      const eHi = this.view.getUint32(p + 4, true);
      const cmp = compareHash64(eHi, eLo, h.hi, h.lo);
      if (cmp === 0) {
        const absSigOff = this.view.getUint32(p + 8, true);
        const rec = this._readSigAt(absSigOff, mid);
        if (rec.name === selKey) return rec;
        // 64-bit hash collision linear scan (backward & forward, matching lookupSymbol)
        for (let k = mid - 1; k >= 0; k--) {
          const kp = this.selIndexOff + k * 12;
          if (this.view.getUint32(kp + 4, true) !== h.hi || this.view.getUint32(kp, true) !== h.lo) break;
          const r = this._readSigAt(this.view.getUint32(kp + 8, true), k);
          if (r.name === selKey) return r;
        }
        for (let k = mid + 1; k < this.header.selCount; k++) {
          const kp = this.selIndexOff + k * 12;
          if (this.view.getUint32(kp + 4, true) !== h.hi || this.view.getUint32(kp, true) !== h.lo) break;
          const r = this._readSigAt(this.view.getUint32(kp + 8, true), k);
          if (r.name === selKey) return r;
        }
        return null;
      }
      if (cmp < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }

  lookupBareSelector(selName) {
    if (!selName || this.header.selCount === 0) return null;
    if (!this._bareSelCache) {
      this._bareSelCache = new Map();
      for (let i = 0; i < this.header.selCount; i++) {
        const p = this.selIndexOff + i * 12;
        const absSigOff = this.view.getUint32(p + 8, true);
        const rec = this._readSigAt(absSigOff, i);
        const full = rec.name || '';
        const colonIdx = full.indexOf(':');
        const bare = colonIdx >= 0 ? full.slice(colonIdx + 1) : full;
        if (bare && !this._bareSelCache.has(bare)) {
          this._bareSelCache.set(bare, rec);
        }
      }
    }
    return this._bareSelCache.get(selName) || null;
  }

  getTypeByTid(tid) {
    return this.typesByTid.get(tid & 0xFFFF) || null;
  }

  getTypeByName(name) {
    return this.typesByName.get(name) || null;
  }

  parseExtChunk() {
    if (!this.header.hasExtChunk) return { enums: [], structLayouts: [] };
    const base = this.header.extChunkOff;
    const enumCount = this.view.getUint32(base, true);
    const layoutCount = this.view.getUint32(base + 4, true);
    const enumDefsOff = base + 8;
    const layoutDefsOff = enumDefsOff + enumCount * 8;

    const enums = [];
    for (let i = 0; i < enumCount; i++) {
      const p = enumDefsOff + i * 8;
      const tid = this.remapTid(this.view.getUint16(p, true));
      const itemCount = this.view.getUint16(p + 2, true);
      const itemsOff = base + this.view.getUint32(p + 4, true);
      const items = [];
      for (let j = 0; j < itemCount; j++) {
        const ip = itemsOff + j * 16;
        const lo = BigInt(this.view.getUint32(ip, true));
        const hi = BigInt(this.view.getUint32(ip + 4, true));
        const signedVal = BigInt.asIntN(64, (hi << 32n) | lo);
        const nameOff = this.view.getUint32(ip + 8, true);
        items.push({ name: this.readString(nameOff), value: Number(signedVal) });
      }
      const desc = this.typesByTid.get(tid);
      enums.push({ tid, name: desc ? desc.name : '', items });
    }

    const structLayouts = [];
    for (let i = 0; i < layoutCount; i++) {
      const p = layoutDefsOff + i * 12;
      const tid = this.remapTid(this.view.getUint16(p, true));
      const memberCount = this.view.getUint16(p + 2, true);
      const totalSize = this.view.getUint32(p + 4, true);
      const membersOff = base + this.view.getUint32(p + 8, true);
      const members = [];
      for (let j = 0; j < memberCount; j++) {
        const mp = membersOff + j * 16;
        const offset = this.view.getUint32(mp, true);
        const hexType = this.remapHexType(this.view.getUint32(mp + 4, true));
        const nameOff = this.view.getUint32(mp + 8, true);
        const size = this.view.getUint16(mp + 12, true);
        const bfLsb = this.view.getUint8(mp + 14);
        const bfWidth = this.view.getUint8(mp + 15);
        members.push({ offset, hexType, name: this.readString(nameOff), size, bfLsb, bfWidth });
      }
      const desc = this.typesByTid.get(tid);
      structLayouts.push({ tid, name: desc ? desc.name : '', totalSize, members });
    }

    return { enums, structLayouts };
  }
}

export function parseTil1Buffer(buffer, opts = {}) {
  const tilView = new Til1View(buffer, opts);
  const functions = [];
  for (let i = 0; i < tilView.header.entryCount; i++) {
    const p = tilView.hashIndexOff + i * 12;
    const absSigOff = tilView.view.getUint32(p + 8, true);
    functions.push(tilView._readSigAt(absSigOff, i));
  }
  const selectors = [];
  for (let i = 0; i < tilView.header.selCount; i++) {
    const p = tilView.selIndexOff + i * 12;
    const absSigOff = tilView.view.getUint32(p + 8, true);
    selectors.push(tilView._readSigAt(absSigOff, i));
  }
  const types = Array.from(tilView.typesByTid.values());
  const { enums, structLayouts } = tilView.parseExtChunk();

  return {
    header: tilView.header,
    types,
    functions,
    selectors,
    enums,
    structLayouts,
  };
}

export { makeHexTypeId, unpackHexTypeId };
