// HSIG1 Binary Signature Pack Encoder & Decoder — 100% byte-for-byte parity with
// cpp/include/hex_hexsig.hpp & cpp/src/analysis/hexsig_engine.cpp (`hex_hexsig_mount`).
// INV-005: ZERO direct imports from js/targets/architecture/ or js/targets/abi/.

import {
  HEXSIG_ARCH_ARM64,
  HEXSIG_ARCH_X86_64,
  HEXSIG_ENTRY_FLAGS,
  HEXSIG_PATTERN_LEN,
  fnv1a64,
} from './hex-sig-extractor.js';

export const HSIG1_MAGIC = 0x47495348; // "HSIG" in Little-Endian
export const HSIG1_VERSION = 1;
export const HSIG1_HEADER_SIZE = 32; // HexSigHeader (32B, alignas(4))
export const HSIG1_ENTRY_SIZE = 96;  // HexSigEntry  (96B, alignas(8))
export const HSIG1_MATCH_RESULT_SIZE = 32; // HexSigMatchResult (32B, alignas(8))
export const HSIG1_MAX_SLOT4_BYTES = 224 * 1024;

const FNV32_OFFSET = 0x811c9dc5;
const FNV32_PRIME = 0x01000193;
const MASK64 = 0xffffffffffffffffn;

/**
 * Exact FNV-1a 32-bit pack checksum with header +0x1C..+0x1F zeroed (matches C++ fnv1a_32_pack).
 */
export function computeHsig1Checksum(blob) {
  let h = FNV32_OFFSET;
  for (let i = 0; i < blob.length; i++) {
    const b = (i >= 0x1c && i < 0x20) ? 0 : (blob[i] & 0xff);
    h ^= b;
    h = Math.imul(h, FNV32_PRIME) >>> 0;
  }
  return h >>> 0;
}

function normalizeArchBit(arch) {
  if (arch === HEXSIG_ARCH_ARM64 || arch === 'arm64') return HEXSIG_ARCH_ARM64;
  if (arch === HEXSIG_ARCH_X86_64 || arch === 'x86_64' || arch === 'x64') return HEXSIG_ARCH_X86_64;
  return HEXSIG_ARCH_ARM64;
}

/**
 * Encode `{ entries, archMask }` into an exact C++-compatible HSIG1 binary blob:
 *   - HexSigHeader (32B @ 0x00):
 *       +0x00 magic[4] ("HSIG")
 *       +0x04 version (u16 = 1)
 *       +0x06 arch_mask (u16: 1=ARM64, 2=X64, 3=BOTH)
 *       +0x08 entry_count (u32)
 *       +0x0C entries_off (u32 = 32, 8B aligned)
 *       +0x10 str_pool_off (u32)
 *       +0x14 str_pool_len (u32)
 *       +0x18 total_size (u32)
 *       +0x1C checksum_fnv32 (u32, FNV-1a32 over full pack with +0x1C..+0x1F zeroed)
 *   - HexSigEntry[entry_count] (96B each @ entries_off):
 *       +0x00 u64 prologue_hash64
 *       +0x08 u32 name_off
 *       +0x0C u16 name_len
 *       +0x0E u16 tail_crc16
 *       +0x10 u16 tail_offset
 *       +0x12 u16 tail_len
 *       +0x14 u16 flags
 *       +0x16 u8  arch (1=ARM64, 2=X64)
 *       +0x17 u8  prologue_len (4..32)
 *       +0x18 u16 min_func_len
 *       +0x1A u16 lib_id
 *       +0x1C u16 base_confidence
 *       +0x1E u16 reserved (0)
 *       +0x20 u8  pattern[32]
 *       +0x40 u8  wildcard_mask[32]
 *   - StringPool (UTF-8 NUL-terminated @ str_pool_off)
 */
export function encodeHsig1Pack({ entries = [], archMask = 0 } = {}) {
  const encoder = new TextEncoder();
  const strMap = new Map();
  const strChunks = [];
  let strCursor = 0;

  function internName(str) {
    const s = String(str ?? '');
    if (strMap.has(s)) return strMap.get(s);
    const bytes = encoder.encode(s);
    const rec = { off: strCursor, len: bytes.length };
    const withNul = new Uint8Array(bytes.length + 1);
    withNul.set(bytes, 0);
    withNul[bytes.length] = 0;
    strChunks.push(withNul);
    strMap.set(s, rec);
    strCursor += withNul.length;
    return rec;
  }

  let computedArchMask = archMask & 0xffff;
  const interned = entries.map((e) => {
    const arch = normalizeArchBit(e.arch ?? e.archId);
    computedArchMask |= arch;
    return {
      entry: e,
      arch,
      name: internName(e.symbolName ?? e.name ?? ''),
    };
  });
  if (computedArchMask === 0) {
    computedArchMask = HEXSIG_ARCH_ARM64 | HEXSIG_ARCH_X86_64;
  }

  const entriesOff = HSIG1_HEADER_SIZE; // 32 (8-byte aligned)
  const strPoolOff = entriesOff + interned.length * HSIG1_ENTRY_SIZE;
  const strPoolLen = strCursor;
  const totalSize = strPoolOff + strPoolLen;

  if (totalSize > HSIG1_MAX_SLOT4_BYTES) {
    throw new RangeError(`HSIG1 pack exceeds Slot 4 budget (${totalSize} > ${HSIG1_MAX_SLOT4_BYTES})`);
  }

  const blob = new Uint8Array(totalSize);
  const dv = new DataView(blob.buffer);

  // Header (32B)
  dv.setUint32(0x00, HSIG1_MAGIC, true);
  dv.setUint16(0x04, HSIG1_VERSION, true);
  dv.setUint16(0x06, computedArchMask & 0xffff, true);
  dv.setUint32(0x08, interned.length >>> 0, true);
  dv.setUint32(0x0c, entriesOff >>> 0, true);
  dv.setUint32(0x10, strPoolOff >>> 0, true);
  dv.setUint32(0x14, strPoolLen >>> 0, true);
  dv.setUint32(0x18, totalSize >>> 0, true);
  dv.setUint32(0x1c, 0, true);

  // Entries (96B each)
  for (let i = 0; i < interned.length; i++) {
    const { entry: e, arch, name } = interned[i];
    const off = entriesOff + i * HSIG1_ENTRY_SIZE;

    const prologueLen = Math.max(4, Math.min(HEXSIG_PATTERN_LEN, e.prologueLen ?? e.length ?? 4));
    const pat = new Uint8Array(HEXSIG_PATTERN_LEN);
    const msk = new Uint8Array(HEXSIG_PATTERN_LEN);
    let hasWildcard = false;
    for (let b = 0; b < prologueLen; b++) {
      const m = (e.mask ? e.mask[b] : (e.wildcardMask ? e.wildcardMask[b] : 0xff)) & 0xff;
      const p = (e.pattern ? e.pattern[b] : 0) & m;
      pat[b] = p;
      msk[b] = m;
      if (m !== 0xff) hasWildcard = true;
    }

    const hash64 = e.prologueHash64 !== undefined
      ? (BigInt(e.prologueHash64) & MASK64)
      : e.patternHash64 !== undefined
        ? (BigInt(e.patternHash64) & MASK64)
        : fnv1a64(pat.subarray(0, prologueLen));

    const tailLen = (e.tailLen ?? 0) & 0xffff;
    const tailOff = (e.tailOffset ?? 0) & 0xffff;
    const tailCrc16 = (e.tailCrc16 ?? e.crc16 ?? 0) & 0xffff;

    let flags = (e.flags ?? 0) & 0xffff;
    if (hasWildcard) flags |= HEXSIG_ENTRY_FLAGS.HAS_WILDCARDS;
    if (tailLen > 0) flags |= HEXSIG_ENTRY_FLAGS.HAS_TAIL_CRC;

    dv.setBigUint64(off + 0x00, hash64, true);
    dv.setUint32(off + 0x08, name.off >>> 0, true);
    dv.setUint16(off + 0x0c, name.len & 0xffff, true);
    dv.setUint16(off + 0x0e, tailCrc16, true);
    dv.setUint16(off + 0x10, tailOff, true);
    dv.setUint16(off + 0x12, tailLen, true);
    dv.setUint16(off + 0x14, flags, true);
    dv.setUint8(off + 0x16, arch & 0xff);
    dv.setUint8(off + 0x17, prologueLen & 0xff);
    dv.setUint16(off + 0x18, (e.minFuncLen ?? prologueLen) & 0xffff, true);
    dv.setUint16(off + 0x1a, (e.libId ?? 0xffff) & 0xffff, true);
    dv.setUint16(off + 0x1c, (e.baseConfidence ?? 850) & 0xffff, true);
    dv.setUint16(off + 0x1e, 0, true);
    blob.set(pat, off + 0x20);
    blob.set(msk, off + 0x40);
  }

  // StringPool
  let cur = strPoolOff;
  for (const chunk of strChunks) {
    blob.set(chunk, cur);
    cur += chunk.length;
  }

  // Compute & store FNV-1a 32-bit checksum at +0x1C
  const checksum = computeHsig1Checksum(blob);
  dv.setUint32(0x1c, checksum, true);

  return blob;
}

/**
 * Decode and strictly validate an HSIG1 binary blob (matching C++ `hex_hexsig_mount`).
 */
export function decodeHsig1Pack(blob) {
  if (!(blob instanceof Uint8Array) || blob.length < HSIG1_HEADER_SIZE) {
    throw new Error('HSIG1: buffer too small');
  }
  if (blob.length > HSIG1_MAX_SLOT4_BYTES) {
    throw new Error('HSIG1: buffer exceeds Slot 4 limit');
  }

  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const magic = dv.getUint32(0x00, true);
  if (magic !== HSIG1_MAGIC) {
    throw new Error(`HSIG1: invalid magic 0x${magic.toString(16)}`);
  }
  const version = dv.getUint16(0x04, true);
  if (version !== HSIG1_VERSION) {
    throw new Error(`HSIG1: unsupported version ${version}`);
  }
  const archMask = dv.getUint16(0x06, true);
  if (archMask === 0 || (archMask & ~(HEXSIG_ARCH_ARM64 | HEXSIG_ARCH_X86_64)) !== 0) {
    throw new Error(`HSIG1: invalid arch_mask 0x${archMask.toString(16)}`);
  }
  const entryCount = dv.getUint32(0x08, true);
  const entriesOff = dv.getUint32(0x0c, true);
  const strPoolOff = dv.getUint32(0x10, true);
  const strPoolLen = dv.getUint32(0x14, true);
  const totalSize = dv.getUint32(0x18, true);
  const storedChecksum = dv.getUint32(0x1c, true);

  if (totalSize !== blob.length) {
    throw new Error(`HSIG1: total_size mismatch (${totalSize} !== ${blob.length})`);
  }
  if (entriesOff < HSIG1_HEADER_SIZE || (entriesOff & 7) !== 0) {
    throw new Error('HSIG1: entries_off must be >= 32 and 8-byte aligned');
  }
  const entriesEnd = entriesOff + entryCount * HSIG1_ENTRY_SIZE;
  if (strPoolOff < entriesEnd || strPoolOff > blob.length || strPoolLen > blob.length - strPoolOff) {
    throw new Error('HSIG1: section offsets out of bounds');
  }

  const actualChecksum = computeHsig1Checksum(blob);
  if (actualChecksum !== storedChecksum) {
    throw new Error(`HSIG1: checksum mismatch (stored=0x${storedChecksum.toString(16)}, computed=0x${actualChecksum.toString(16)})`);
  }

  const decoder = new TextDecoder();
  const entries = new Array(entryCount);

  for (let i = 0; i < entryCount; i++) {
    const off = entriesOff + i * HSIG1_ENTRY_SIZE;
    const prologueHash64 = dv.getBigUint64(off + 0x00, true);
    const nameOff = dv.getUint32(off + 0x08, true);
    const nameLen = dv.getUint16(off + 0x0c, true);
    const tailCrc16 = dv.getUint16(off + 0x0e, true);
    const tailOffset = dv.getUint16(off + 0x10, true);
    const tailLen = dv.getUint16(off + 0x12, true);
    const flags = dv.getUint16(off + 0x14, true);
    const arch = dv.getUint8(off + 0x16);
    const prologueLen = dv.getUint8(off + 0x17);
    const minFuncLen = dv.getUint16(off + 0x18, true);
    const libId = dv.getUint16(off + 0x1a, true);
    const baseConfidence = dv.getUint16(off + 0x1c, true);

    if (arch !== HEXSIG_ARCH_ARM64 && arch !== HEXSIG_ARCH_X86_64) {
      throw new Error(`HSIG1: invalid entry arch ${arch}`);
    }
    if ((arch & archMask) === 0) {
      throw new Error(`HSIG1: entry arch ${arch} not in header arch_mask ${archMask}`);
    }
    if (prologueLen < 4 || prologueLen > HEXSIG_PATTERN_LEN) {
      throw new Error(`HSIG1: invalid prologue_len ${prologueLen}`);
    }
    if (nameOff >= strPoolLen || nameLen >= strPoolLen - nameOff) {
      throw new Error('HSIG1: entry name out of string pool bounds');
    }
    if (blob[strPoolOff + nameOff + nameLen] !== 0) {
      throw new Error('HSIG1: entry name not NUL-terminated');
    }

    const symbolName = decoder.decode(blob.subarray(strPoolOff + nameOff, strPoolOff + nameOff + nameLen));
    const pattern = blob.slice(off + 0x20, off + 0x40);
    const mask = blob.slice(off + 0x40, off + 0x60);

    entries[i] = {
      symbolName,
      nameOff,
      nameLen,
      prologueHash64,
      patternHash64: prologueHash64,
      tailCrc16,
      crc16: tailCrc16,
      tailOffset,
      tailLen,
      flags,
      arch,
      archId: arch,
      prologueLen,
      length: prologueLen,
      minFuncLen,
      libId,
      baseConfidence,
      pattern,
      mask,
      wildcardMask: mask,
    };
  }

  return {
    version,
    archMask,
    entryCount,
    entriesOff,
    strPoolOff,
    strPoolLen,
    totalSize,
    checksum: storedChecksum,
    byteLength: blob.length,
    entries,
  };
}

/**
 * Decode 32B C++ `HexSigMatchResult` POD (`hex_hexsig.hpp`).
 */
export function decodeMatchResult32(buf, offset = 0) {
  if (!buf || buf.length - offset < HSIG1_MATCH_RESULT_SIZE) {
    throw new RangeError('HexSigMatchResult buffer must be at least 32 bytes');
  }
  const dv = new DataView(buf.buffer, buf.byteOffset + offset, HSIG1_MATCH_RESULT_SIZE);
  return {
    queryHash64: dv.getBigUint64(0x00, true),
    entryIndex: dv.getUint32(0x08, true),
    nameOff: dv.getUint32(0x0c, true),
    nameLen: dv.getUint16(0x10, true),
    libId: dv.getUint16(0x12, true),
    confidence: dv.getUint16(0x14, true),
    runnerUpConf: dv.getUint16(0x16, true),
    matchedBits: dv.getUint16(0x18, true),
    tailCrc16Actual: dv.getUint16(0x1a, true),
    status: dv.getUint8(0x1c),
    tailCrcMatched: dv.getUint8(0x1d),
    candidateCount: dv.getUint16(0x1e, true),
  };
}

/**
 * Encode 32B C++ `HexSigMatchResult` POD.
 */
export function encodeMatchResult32(rec) {
  const buf = new Uint8Array(HSIG1_MATCH_RESULT_SIZE);
  const dv = new DataView(buf.buffer);
  dv.setBigUint64(0x00, BigInt(rec.queryHash64 ?? 0n) & MASK64, true);
  dv.setUint32(0x08, (rec.entryIndex ?? 0xffffffff) >>> 0, true);
  dv.setUint32(0x0c, (rec.nameOff ?? 0xffffffff) >>> 0, true);
  dv.setUint16(0x10, (rec.nameLen ?? 0) & 0xffff, true);
  dv.setUint16(0x12, (rec.libId ?? 0xffff) & 0xffff, true);
  dv.setUint16(0x14, (rec.confidence ?? 0) & 0xffff, true);
  dv.setUint16(0x16, (rec.runnerUpConf ?? 0) & 0xffff, true);
  dv.setUint16(0x18, (rec.matchedBits ?? 0) & 0xffff, true);
  dv.setUint16(0x1a, (rec.tailCrc16Actual ?? 0) & 0xffff, true);
  dv.setUint8(0x1c, (rec.status ?? 0) & 0xff);
  dv.setUint8(0x1d, (rec.tailCrcMatched ?? 0) & 0xff);
  dv.setUint16(0x1e, (rec.candidateCount ?? 0) & 0xffff, true);
  return buf;
}
