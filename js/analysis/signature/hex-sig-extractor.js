// Architecture-agnostic HEX-SIG function fingerprint & prologue signature extractor.
// 100% parity with cpp/include/hex_hexsig.hpp & cpp/src/analysis/hexsig_engine.cpp.
// INV-005: ZERO direct imports from js/targets/architecture/ or js/targets/abi/.

export const HEXSIG_PATTERN_LEN = 32;
export const HEXSIG_FP_BYTE_LEN = 64;

// Exact C++ HexSigArch constants (hex_hexsig.hpp)
export const HEXSIG_ARCH_NONE = 0;
export const HEXSIG_ARCH_ARM64 = 1; // 1 << 0
export const HEXSIG_ARCH_X86_64 = 2; // 1 << 1

export const HEXSIG_ENTRY_FLAGS = Object.freeze({
  NONE: 0,
  HAS_WILDCARDS: 1 << 0,
  HAS_TAIL_CRC: 1 << 1,
  VENDOR_LIB: 1 << 2,
  CRYPTO_LIB: 1 << 3,
});

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

const FNV32_OFFSET = 0x811c9dc5;
const FNV32_PRIME = 0x01000193;

const MINHASH_SEEDS = [0x9e3779b1, 0x85ebca77, 0xc2b2ae3d, 0x27d4eb2f];

/**
 * Exact 64-bit FNV-1a hash over a Uint8Array (matches C++ fnv1a_64).
 */
export function fnv1a64(bytes, seed = FNV64_OFFSET) {
  let h = BigInt(seed) & MASK64;
  if (!bytes || bytes.length === 0) return h;
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i] & 0xff);
    h = (h * FNV64_PRIME) & MASK64;
  }
  return h;
}

/**
 * Exact 32-bit FNV-1a hash over a Uint8Array.
 */
export function fnv1a32(bytes, seed = FNV32_OFFSET) {
  let h = seed >>> 0;
  if (!bytes || bytes.length === 0) return h;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i] & 0xff;
    h = Math.imul(h, FNV32_PRIME) >>> 0;
  }
  return h;
}

/**
 * Standard CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF), matches C++ crc16_ccitt_update.
 */
export function crc16Ccitt(bytes, start = 0, end = bytes ? bytes.length : 0, init = 0xffff) {
  let crc = init & 0xffff;
  if (!bytes || end <= start) return crc;
  const limit = Math.min(bytes.length, end);
  for (let i = Math.max(0, start); i < limit; i++) {
    crc ^= (bytes[i] & 0xff) << 8;
    for (let bit = 0; bit < 8; bit++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc & 0xffff;
}

export function fnv1a64Hex(hashBigInt) {
  return (BigInt(hashBigInt) & MASK64).toString(16).padStart(16, '0');
}

function mix32(v) {
  let x = v >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

function hash4Gram64(t0, t1, t2, t3) {
  let h = FNV64_OFFSET;
  const vals = [t0, t1, t2, t3];
  for (let i = 0; i < 4; i++) {
    const v = vals[i] & 0xffff;
    h ^= BigInt(v & 0xff);
    h = (h * FNV64_PRIME) & MASK64;
    h ^= BigInt((v >>> 8) & 0xff);
    h = (h * FNV64_PRIME) & MASK64;
  }
  return h;
}

export function computeSimHash64(tokens) {
  if (!tokens || tokens.length === 0) return 0n;
  const acc = new Int32Array(64);
  const count = tokens.length >= 4 ? tokens.length - 3 : 1;
  for (let i = 0; i < count; i++) {
    const t0 = tokens[i] ?? 0;
    const t1 = tokens[i + 1] ?? 0;
    const t2 = tokens[i + 2] ?? 0;
    const t3 = tokens[i + 3] ?? 0;
    const h = hash4Gram64(t0, t1, t2, t3);
    for (let b = 0; b < 64; b++) {
      if ((h >> BigInt(b)) & 1n) acc[b] += 1;
      else acc[b] -= 1;
    }
  }
  let out = 0n;
  for (let b = 0; b < 64; b++) {
    if (acc[b] >= 0) out |= 1n << BigInt(b);
  }
  return out & MASK64;
}

export function computeMinHash4(tokens) {
  const sketch = new Uint32Array(4);
  sketch.fill(0xffffffff);
  if (!tokens || tokens.length === 0) return sketch;
  const count = tokens.length >= 4 ? tokens.length - 3 : 1;
  for (let i = 0; i < count; i++) {
    const t0 = tokens[i] ?? 0;
    const t1 = tokens[i + 1] ?? 0;
    const t2 = tokens[i + 2] ?? 0;
    const t3 = tokens[i + 3] ?? 0;
    const base = mix32(((t0 & 0xffff) | ((t1 & 0xffff) << 16)) ^ Math.imul((t2 & 0xffff) | ((t3 & 0xffff) << 16), 0x9e3779b1));
    for (let k = 0; k < 4; k++) {
      const h = mix32(base ^ MINHASH_SEEDS[k]);
      if (h < sketch[k]) sketch[k] = h;
    }
  }
  return sketch;
}

export function computeConstHash64(constants) {
  if (!constants || constants.length === 0) return 0n;
  const nonTrivial = [];
  for (const c of constants) {
    const v = BigInt(c) & MASK64;
    if (v <= 16n || v === MASK64) continue;
    nonTrivial.push(v);
  }
  if (nonTrivial.length === 0) return 0n;
  nonTrivial.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const unique = [];
  for (const v of nonTrivial) {
    if (unique.length === 0 || unique[unique.length - 1] !== v) {
      unique.push(v);
      if (unique.length >= 16) break;
    }
  }
  const buf = new Uint8Array(unique.length * 8);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < unique.length; i++) {
    dv.setBigUint64(i * 8, unique[i], true);
  }
  return fnv1a64(buf);
}

export function computeStringHash64(strings) {
  if (!strings || strings.length === 0) return 0n;
  const cleaned = [...new Set(strings.filter((s) => typeof s === 'string' && s.length > 0))].sort();
  if (cleaned.length === 0) return 0n;
  const encoder = new TextEncoder();
  let h = FNV64_OFFSET;
  for (const s of cleaned) {
    const bytes = encoder.encode(s);
    h = fnv1a64(bytes, h);
    h ^= 0n;
    h = (h * FNV64_PRIME) & MASK64;
  }
  return h;
}

export function popcount64(v) {
  let x = BigInt(v) & MASK64;
  let count = 0;
  while (x !== 0n) {
    x &= x - 1n;
    count++;
  }
  return count;
}

export function scoreHexSigPair(queryFp, entryFp) {
  let sL1 = 0;
  const simBits = 64 - popcount64((BigInt(queryFp.l1Simhash64 ?? 0n) ^ BigInt(entryFp.l1Simhash64 ?? 0n)) & MASK64);
  if (simBits >= 44) {
    const simPart = Math.floor((Math.max(0, simBits - 40) * 220) / 24);
    let mhHits = 0;
    const qMh = queryFp.l1Minhash || [0, 0, 0, 0];
    const eMh = entryFp.l1Minhash || [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) {
      if ((qMh[k] >>> 0) === (eMh[k] >>> 0) && (qMh[k] >>> 0) !== 0xffffffff) mhHits++;
    }
    const qProf = queryFp.l1OpProfile32 >>> 0;
    const eProf = entryFp.l1OpProfile32 >>> 0;
    let profDist = 0;
    for (let shift = 0; shift < 32; shift += 8) {
      profDist += Math.abs(((qProf >>> shift) & 0xff) - ((eProf >>> shift) & 0xff));
    }
    const profPart = Math.floor((Math.max(0, 128 - profDist) * 30) / 128);
    sL1 = Math.min(350, simPart + 25 * mhHits + profPart);
  }

  const qBb = queryFp.l2BbCount ?? 1;
  const eBb = entryFp.l2BbCount ?? 1;
  const wlEq = (BigInt(queryFp.l2WlHash64 ?? 0n) !== 0n)
    && (BigInt(queryFp.l2WlHash64 ?? 0n) === BigInt(entryFp.l2WlHash64 ?? 0n));
  const bbDiff = Math.abs(qBb - eBb);
  const edgeDiff = Math.abs((queryFp.l2EdgeCount ?? 0) - (entryFp.l2EdgeCount ?? 0));
  const loopDiff = Math.abs((queryFp.l2LoopCount ?? 0) - (entryFp.l2LoopCount ?? 0));
  const structScore = Math.max(0, 120 - bbDiff * 12 - edgeDiff * 6 - loopDiff * 20);
  const sL2Cap = qBb === 1 ? 90 : 300;
  const sL2 = Math.min(sL2Cap, (wlEq && qBb >= 3 ? 180 : 0) + structScore);

  const qCrypto = (queryFp.l3CryptoMask ?? 0) & 0xffff;
  const eCrypto = (entryFp.l3CryptoMask ?? 0) & 0xffff;
  const cryptoHit = (qCrypto & eCrypto) !== 0 ? 1 : 0;
  const reqCryptoMiss = eCrypto !== 0 && (qCrypto & eCrypto) === 0 ? 1 : 0;
  const strEq = (BigInt(queryFp.l3StrHash64 ?? 0n) !== 0n)
    && (BigInt(queryFp.l3StrHash64 ?? 0n) === BigInt(entryFp.l3StrHash64 ?? 0n)) ? 1 : 0;
  const constEq = (BigInt(queryFp.l3ConstHash64 ?? 0n) !== 0n)
    && (BigInt(queryFp.l3ConstHash64 ?? 0n) === BigInt(entryFp.l3ConstHash64 ?? 0n)) ? 1 : 0;
  const hintHit = (((queryFp.l3LibHintMask ?? 0) & (entryFp.l3LibHintMask ?? 0)) !== 0) ? 1 : 0;
  const rawL3 = 200 * cryptoHit - 150 * reqCryptoMiss + 180 * strEq + 150 * constEq + 60 * hintHit;
  const sL3 = Math.max(0, Math.min(350, rawL3));

  const layerMask = (sL1 >= 180 ? 1 : 0) | (sL2 >= 90 ? 2 : 0) | (sL3 >= 120 ? 4 : 0);
  const total = Math.max(0, Math.min(1000, sL1 + sL2 + sL3));

  return { total, sL1, sL2, sL3, simBits, layerMask };
}

export function encodeFingerprint64(fp) {
  const buf = new Uint8Array(HEXSIG_FP_BYTE_LEN);
  const dv = new DataView(buf.buffer);
  dv.setBigUint64(0x00, BigInt(fp.l1Simhash64 ?? 0n) & MASK64, true);
  dv.setBigUint64(0x08, BigInt(fp.l2WlHash64 ?? 0n) & MASK64, true);
  dv.setBigUint64(0x10, BigInt(fp.l3ConstHash64 ?? 0n) & MASK64, true);
  dv.setBigUint64(0x18, BigInt(fp.l3StrHash64 ?? 0n) & MASK64, true);
  const mh = fp.l1Minhash || [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff];
  dv.setUint32(0x20, (mh[0] ?? 0xffffffff) >>> 0, true);
  dv.setUint32(0x24, (mh[1] ?? 0xffffffff) >>> 0, true);
  dv.setUint32(0x28, (mh[2] ?? 0xffffffff) >>> 0, true);
  dv.setUint32(0x2c, (mh[3] ?? 0xffffffff) >>> 0, true);
  dv.setUint32(0x30, (fp.l1OpProfile32 ?? 0) >>> 0, true);
  dv.setUint16(0x34, Math.min(0xffff, fp.l2BbCount ?? 1), true);
  dv.setUint16(0x36, Math.min(0xffff, fp.l2EdgeCount ?? 0), true);
  dv.setUint8(0x38, Math.min(0xff, fp.l2MaxLoopDepth ?? 0));
  dv.setUint8(0x39, Math.min(0xff, fp.l2LoopCount ?? 0));
  dv.setUint16(0x3a, (fp.l2CallOutDeg ?? 0) & 0xffff, true);
  dv.setUint16(0x3c, (fp.l3CryptoMask ?? 0) & 0xffff, true);
  dv.setUint16(0x3e, (fp.l3LibHintMask ?? 0) & 0xffff, true);
  return buf;
}

export function decodeFingerprint64(buf, offset = 0) {
  if (!buf || buf.length - offset < HEXSIG_FP_BYTE_LEN) {
    throw new RangeError('HexSigFingerprint buffer must be at least 64 bytes');
  }
  const dv = new DataView(buf.buffer, buf.byteOffset + offset, HEXSIG_FP_BYTE_LEN);
  return {
    l1Simhash64: dv.getBigUint64(0x00, true),
    l2WlHash64: dv.getBigUint64(0x08, true),
    l3ConstHash64: dv.getBigUint64(0x10, true),
    l3StrHash64: dv.getBigUint64(0x18, true),
    l1Minhash: new Uint32Array([
      dv.getUint32(0x20, true),
      dv.getUint32(0x24, true),
      dv.getUint32(0x28, true),
      dv.getUint32(0x2c, true),
    ]),
    l1OpProfile32: dv.getUint32(0x30, true),
    l2BbCount: dv.getUint16(0x34, true),
    l2EdgeCount: dv.getUint16(0x36, true),
    l2MaxLoopDepth: dv.getUint8(0x38),
    l2LoopCount: dv.getUint8(0x39),
    l2CallOutDeg: dv.getUint16(0x3a, true),
    l3CryptoMask: dv.getUint16(0x3c, true),
    l3LibHintMask: dv.getUint16(0x3e, true),
  };
}

/**
 * Compute normalized tail CRC16 matching C++ `compute_normalized_tail_crc16`.
 */
export function computeNormalizedTailCrc16(codeBytes, normalizer, tailOffset, tailLen) {
  if (!codeBytes || tailLen <= 0 || tailOffset < 0 || tailOffset > codeBytes.length || tailLen > codeBytes.length - tailOffset) {
    return 0;
  }
  let crc = 0xffff;
  let consumed = 0;
  while (consumed < tailLen) {
    const chunk = Math.min(32, tailLen - consumed);
    const slice = codeBytes.subarray(tailOffset + consumed, tailOffset + consumed + chunk);
    const norm = normalizer.normalizePrologue(slice, { maxBytes: chunk });
    let nlen = norm.length ?? 0;
    const buf = new Uint8Array(chunk);
    buf.set(norm.pattern.subarray(0, nlen), 0);
    if (nlen < chunk) {
      for (let i = nlen; i < chunk; i++) buf[i] = slice[i];
      nlen = chunk;
    }
    crc = crc16Ccitt(buf, 0, nlen, crc);
    consumed += chunk;
  }
  return crc;
}

/**
 * Arch-agnostic signature extractor taking an injected normalizer DI adapter.
 */
export function extractHexSig(codeBytes, normalizer, opts = {}) {
  if (!normalizer || typeof normalizer.normalizePrologue !== 'function') {
    throw new TypeError('extractHexSig requires an injected architecture normalizer DI adapter');
  }
  const bytes = codeBytes instanceof Uint8Array ? codeBytes : new Uint8Array(codeBytes || 0);
  const norm = normalizer.normalizePrologue(bytes, opts);

  const pattern = new Uint8Array(HEXSIG_PATTERN_LEN);
  const mask = new Uint8Array(HEXSIG_PATTERN_LEN);
  const len = Math.min(HEXSIG_PATTERN_LEN, norm.length ?? (norm.pattern ? norm.pattern.length : 0));

  let hasWildcards = false;
  for (let i = 0; i < len; i++) {
    const m = (norm.mask ? norm.mask[i] : 0xff) & 0xff;
    const p = (norm.pattern ? norm.pattern[i] : 0) & m;
    pattern[i] = p;
    mask[i] = m;
    if (m !== 0xff) hasWildcards = true;
  }

  // Exact C++ parity: fnv1a_64(out_norm32, nlen)
  const patternHash64 = fnv1a64(pattern.subarray(0, len));

  // Optional tail CRC16 window (matching C++ compute_normalized_tail_crc16)
  const tailOffset = opts.tailOffset ?? (bytes.length > len ? len : 0);
  const tailLen = opts.tailLen ?? (bytes.length > len ? Math.min(32, bytes.length - len) : 0);
  const tailCrc16 = tailLen > 0
    ? computeNormalizedTailCrc16(bytes, normalizer, tailOffset, tailLen)
    : crc16Ccitt(pattern, len > 16 ? 16 : 0, len);

  const tokens = norm.tokens || Array.from(pattern.subarray(0, len), (b, i) => ((b << 8) | (mask[i] & 0xff)) & 0xffff);
  const l1Simhash64 = computeSimHash64(tokens);
  const l1Minhash = computeMinHash4(tokens);
  const l1OpProfile32 = (norm.opProfile32 ?? 0) >>> 0;

  const cfg = opts.cfgSummary || {};
  const l2BbCount = cfg.bbCount ?? 1;
  const l2EdgeCount = cfg.edgeCount ?? 0;
  const l2MaxLoopDepth = cfg.maxLoopDepth ?? 0;
  const l2LoopCount = cfg.loopCount ?? 0;
  const l2WlHash64 = BigInt(cfg.wlHash64 ?? 0n) & MASK64;
  const directCalls = Math.min(0xfff, cfg.directCalls ?? 0);
  const indirectCalls = Math.min(0xf, cfg.indirectCalls ?? 0);
  const l2CallOutDeg = (directCalls & 0xfff) | ((indirectCalls & 0xf) << 12);

  const l3ConstHash64 = opts.l3ConstHash64 !== undefined
    ? (BigInt(opts.l3ConstHash64) & MASK64)
    : computeConstHash64(opts.constants || norm.constants || []);
  const l3StrHash64 = opts.l3StrHash64 !== undefined
    ? (BigInt(opts.l3StrHash64) & MASK64)
    : computeStringHash64(opts.strings || []);
  const l3CryptoMask = (opts.l3CryptoMask ?? 0) & 0xffff;
  const l3LibHintMask = (opts.l3LibHintMask ?? 0) & 0xffff;

  const fingerprint = {
    l1Simhash64,
    l2WlHash64,
    l3ConstHash64,
    l3StrHash64,
    l1Minhash,
    l1OpProfile32,
    l2BbCount,
    l2EdgeCount,
    l2MaxLoopDepth,
    l2LoopCount,
    l2CallOutDeg,
    l3CryptoMask,
    l3LibHintMask,
  };

  return {
    archId: normalizer.archId ?? HEXSIG_ARCH_ARM64,
    pattern,
    mask,
    length: len,
    hasWildcards,
    patternHash64,
    patternHashHex: fnv1a64Hex(patternHash64),
    crc16: tailCrc16,
    tailOffset,
    tailLen,
    codeBytes: bytes,
    tokens,
    fingerprint,
    fingerprintBytes: encodeFingerprint64(fingerprint),
  };
}
