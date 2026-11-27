/**
 * General-purpose static cryptographic constant detection (FindCrypt-style),
 * Shannon entropy analysis (WASM-accelerated with JS fallback), and
 * bitwise/crypto instruction density scoring for ARM64 & x86-64.
 */
import { getHexEngineExports, isWasmBulkMemorySupported } from '../core/hex-engine-wasm.js';
import { getEngineMode, recordWasmCall, recordFallback } from '../core/hex-engine-bridge.js';

const SCRATCH_CHUNK_MAX = 1536 * 1024; // stay comfortably inside 2.5MB WASM scratch arena

export const CRYPTO_ALGO_BY_ID = Object.freeze({
  1: { id: 'aes-sbox', name: 'AES S-Box' },
  2: { id: 'aes-inv-sbox', name: 'AES Inverse S-Box' },
  3: { id: 'sha256-k', name: 'SHA-256 Round Constants (K)' },
  4: { id: 'sha256-h0', name: 'SHA-256 Initial Hash (H0)' },
  5: { id: 'md5-t', name: 'MD5 Sine Constants (T)' },
  6: { id: 'chacha20', name: 'ChaCha20 / Salsa20 Sigma' },
  7: { id: 'crc32-ieee', name: 'CRC32 IEEE Table' },
});

const JS_CRYPTO_SIGS = Object.freeze([
  { algoId: 1, reportLen: 256, bytes: Uint8Array.from([0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76]) },
  { algoId: 2, reportLen: 256, bytes: Uint8Array.from([0x52, 0x09, 0x6a, 0xd5, 0x30, 0x36, 0xa5, 0x38, 0xbf, 0x40, 0xa3, 0x9e, 0x81, 0xf3, 0xd7, 0xfb]) },
  { algoId: 3, reportLen: 256, bytes: Uint8Array.from([0x98, 0x2f, 0x8a, 0x42, 0x91, 0x44, 0x37, 0x71, 0xcf, 0xfb, 0xc0, 0xb5, 0xa5, 0xdb, 0xb5, 0xe9]) },
  { algoId: 3, reportLen: 256, bytes: Uint8Array.from([0x42, 0x8a, 0x2f, 0x98, 0x71, 0x37, 0x44, 0x91, 0xb5, 0xc0, 0xfb, 0xcf, 0xe9, 0xb5, 0xdb, 0xa5]) },
  { algoId: 4, reportLen: 32,  bytes: Uint8Array.from([0x67, 0xe6, 0x09, 0x6a, 0x85, 0xae, 0x67, 0xbb, 0x72, 0xf3, 0x6e, 0x3c, 0x3a, 0xf5, 0x4f, 0xa5]) },
  { algoId: 4, reportLen: 32,  bytes: Uint8Array.from([0x6a, 0x09, 0xe6, 0x67, 0xbb, 0x67, 0xae, 0x85, 0x3c, 0x6e, 0xf3, 0x72, 0xa5, 0x4f, 0xf5, 0x3a]) },
  { algoId: 5, reportLen: 256, bytes: Uint8Array.from([0x78, 0xa4, 0x6a, 0xd7, 0x56, 0xb7, 0xc7, 0xe8, 0xdb, 0x70, 0x20, 0x24, 0xee, 0xce, 0xbd, 0xc1]) },
  { algoId: 6, reportLen: 16,  bytes: Uint8Array.from([0x65, 0x78, 0x70, 0x61, 0x6e, 0x64, 0x20, 0x33, 0x32, 0x2d, 0x62, 0x79, 0x74, 0x65, 0x20, 0x6b]) },
  { algoId: 6, reportLen: 16,  bytes: Uint8Array.from([0x65, 0x78, 0x70, 0x61, 0x6e, 0x64, 0x20, 0x31, 0x36, 0x2d, 0x62, 0x79, 0x74, 0x65, 0x20, 0x6b]) },
  { algoId: 7, reportLen: 1024, bytes: Uint8Array.from([0x00, 0x00, 0x00, 0x00, 0x96, 0x30, 0x07, 0x77, 0x2c, 0x61, 0x0e, 0xee, 0xba, 0x51, 0x09, 0x99]) },
]);

function toU8(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return null;
}

function getWasmExports(opts) {
  if (getEngineMode(opts) === 'js') {
    recordFallback('crypto_entropy:wasm_disabled');
    return null;
  }
  if (!isWasmBulkMemorySupported()) {
    recordFallback('crypto_entropy:no_bulk_memory');
    return null;
  }
  try {
    const ex = getHexEngineExports(opts);
    if (!ex || typeof ex.hex_shannon_entropy_x1000 !== 'function'
      || typeof ex.hex_scan_high_entropy_windows !== 'function'
      || typeof ex.hex_crypto_scan_buffer !== 'function'
      || typeof ex.hex_engine_scratch_alloc !== 'function') {
      recordFallback('crypto_entropy:exports_missing');
      return null;
    }
    return ex;
  } catch {
    recordFallback('crypto_entropy:init_error');
    return null;
  }
}

function shannonEntropyJs(u8) {
  const len = u8.length;
  if (!len) return 0;
  const hist = new Uint32Array(256);
  for (let i = 0; i < len; i++) hist[u8[i]]++;
  let h = 0;
  for (let i = 0; i < 256; i++) {
    const c = hist[i];
    if (!c) continue;
    const p = c / len;
    h -= p * Math.log2(p);
  }
  return Math.max(0, Math.min(8, Math.round(h * 1000) / 1000));
}

/**
 * Compute Shannon entropy (0.000 .. 8.000 bits/byte) of a byte buffer.
 * Uses C++20/WASM when available and buffer fits scratch arena; falls back to JS.
 */
export function shannonEntropy(bytes, opts = null) {
  const u8 = toU8(bytes);
  if (!u8 || u8.length === 0) return 0;
  const ex = u8.length <= SCRATCH_CHUNK_MAX ? getWasmExports(opts) : null;
  if (ex) {
    try {
      ex.hex_engine_scratch_reset();
      const ptr = ex.hex_engine_scratch_alloc(u8.length);
      if (ptr) {
        new Uint8Array(ex.memory.buffer, ptr, u8.length).set(u8);
        const x1000 = ex.hex_shannon_entropy_x1000(ptr, u8.length) >>> 0;
        recordWasmCall('crypto_entropy');
        return x1000 / 1000;
      }
    } catch {
      recordFallback('crypto_entropy:wasm_exception');
    }
  }
  return shannonEntropyJs(u8);
}

/**
 * Scan a buffer for high-entropy windows (encrypted/compressed/packed regions).
 * Returns [{ offset, address, size, entropy }].
 */
export function scanHighEntropyWindows(bytes, {
  baseAddress = 0n,
  windowSize = 4096,
  step = 4096,
  threshold = 7.2,
  maxHits = 64,
  engine = null,
} = {}) {
  const u8 = toU8(bytes);
  if (!u8 || u8.length < windowSize || windowSize <= 0 || maxHits <= 0) return [];
  const stepSize = step > 0 ? step : windowSize;
  const threshX1000 = Math.max(0, Math.min(8000, Math.round(threshold * 1000)));
  const base = BigInt(baseAddress ?? 0n);

  const ex = u8.length <= SCRATCH_CHUNK_MAX ? getWasmExports(engine ? { engine } : null) : null;
  if (ex) {
    try {
      ex.hex_engine_scratch_reset();
      const inPtr = ex.hex_engine_scratch_alloc(u8.length);
      const outPtr = ex.hex_engine_scratch_alloc(maxHits * 8);
      if (inPtr && outPtr) {
        new Uint8Array(ex.memory.buffer, inPtr, u8.length).set(u8);
        const count = ex.hex_scan_high_entropy_windows(inPtr, u8.length, windowSize, stepSize, threshX1000, outPtr, maxHits) >>> 0;
        const pairs = new Uint32Array(ex.memory.buffer, outPtr, count * 2);
        const out = [];
        for (let i = 0; i < count; i++) {
          const offset = pairs[i * 2];
          out.push({
            offset,
            address: base + BigInt(offset),
            size: windowSize,
            entropy: pairs[i * 2 + 1] / 1000,
          });
        }
        recordWasmCall('crypto_entropy');
        return out;
      }
    } catch {
      recordFallback('crypto_entropy:wasm_exception');
    }
  }

  // JS fallback
  const out = [];
  for (let pos = 0; pos + windowSize <= u8.length && out.length < maxHits; pos += stepSize) {
    const ent = shannonEntropyJs(u8.subarray(pos, pos + windowSize));
    if (Math.round(ent * 1000) >= threshX1000) {
      out.push({ offset: pos, address: base + BigInt(pos), size: windowSize, entropy: ent });
    }
  }
  return out;
}

/**
 * Scan a byte buffer for standard cryptographic constant tables (AES S-Box,
 * SHA-256 K/H0, MD5, ChaCha20, CRC32). Chunked across WASM scratch arena for
 * arbitrarily large binaries; falls back to JS when HEX_ENGINE=js.
 */
export function scanCryptoConstants(bytes, {
  baseAddress = 0n,
  maxHits = 64,
  engine = null,
} = {}) {
  const u8 = toU8(bytes);
  if (!u8 || u8.length < 16 || maxHits <= 0) return [];
  const base = BigInt(baseAddress ?? 0n);
  const ex = getWasmExports(engine ? { engine } : null);

  if (ex) {
    try {
      const out = [];
      const seen = new Set();
      let chunkStart = 0;
      const overlap = 15;
      while (chunkStart < u8.length && out.length < maxHits) {
        const chunkEnd = Math.min(u8.length, chunkStart + SCRATCH_CHUNK_MAX);
        const chunkLen = chunkEnd - chunkStart;
        if (chunkLen < 16) break;
        const remain = maxHits - out.length;
        ex.hex_engine_scratch_reset();
        const inPtr = ex.hex_engine_scratch_alloc(chunkLen);
        const outPtr = ex.hex_engine_scratch_alloc(remain * 12);
        if (!inPtr || !outPtr) break;
        new Uint8Array(ex.memory.buffer, inPtr, chunkLen).set(u8.subarray(chunkStart, chunkEnd));
        const count = ex.hex_crypto_scan_buffer(inPtr, chunkLen, outPtr, remain) >>> 0;
        const triples = new Uint32Array(ex.memory.buffer, outPtr, count * 3);
        for (let i = 0; i < count; i++) {
          const absOff = chunkStart + triples[i * 3];
          const algoId = triples[i * 3 + 1];
          const length = triples[i * 3 + 2];
          const key = `${absOff}:${algoId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const meta = CRYPTO_ALGO_BY_ID[algoId] || { id: `algo-${algoId}`, name: `Crypto #${algoId}` };
          out.push({ id: meta.id, name: meta.name, offset: absOff, address: base + BigInt(absOff), length });
        }
        if (chunkEnd >= u8.length) break;
        chunkStart = chunkEnd - overlap;
      }
      recordWasmCall('crypto_entropy');
      return out;
    } catch {
      recordFallback('crypto_entropy:wasm_exception');
    }
  }

  // JS fallback
  const out = [];
  const limit = u8.length - 16;
  for (let i = 0; i <= limit && out.length < maxHits; i++) {
    const b0 = u8[i];
    for (const sig of JS_CRYPTO_SIGS) {
      if (b0 !== sig.bytes[0] || u8[i + 1] !== sig.bytes[1]) continue;
      let ok = true;
      for (let k = 2; k < 16; k++) {
        if (u8[i + k] !== sig.bytes[k]) { ok = false; break; }
      }
      if (ok) {
        const meta = CRYPTO_ALGO_BY_ID[sig.algoId];
        out.push({ id: meta.id, name: meta.name, offset: i, address: base + BigInt(i), length: sig.reportLen });
        break;
      }
    }
  }
  return out;
}

const CRYPTO_HW_RE = /^(?:aese|aesd|aesmc|aesimc|sha1[chmp]|sha1su[01]|sha256h2?|sha256su[01]|sha512h2?|sha512su[01]|pmull2?|crc32c?[bhwdx]|aesenc|aesenclast|aesdec|aesdeclast|aesimc|aeskeygenassist|vaes\w+|sha256rnds2|sha256msg[12]|sha1rnds4|sha1nexte|sha1msg[12]|pclmulqdq|vpclmulqdq)$/i;
const BITWISE_XOR_RE = /^(?:eor|eon|xor|pxor|vpxor|xorps|xorpd)$/i;
const BITWISE_ROT_RE = /^(?:ror|extr|rol|rorx|shld|shrd)$/i;
const BITWISE_SHIFT_RE = /^(?:lsl|lsr|asr|shl|shr|sar|sal|bic|orn|and|ands|orr|not|andn|pand|por|pslld|psrld|psllq|psrlq)$/i;

function isZeroingXor(mn, opsText) {
  if (!/^(?:eor|xor|pxor|xorps|xorpd)$/i.test(mn)) return false;
  const parts = opsText.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 2) return parts[0] === parts[1];
  if (parts.length === 3) return parts[1] === parts[2];
  return false;
}

/**
 * Analyze ARM64 / x86-64 instruction stream for hardware crypto instructions
 * and high bitwise/XOR/rotate density (excluding register-zeroing idioms).
 */
export function analyzeCryptoInsnDensity(insns) {
  const list = Array.isArray(insns) ? insns : [];
  let total = 0;
  let hwCryptoCount = 0;
  let xorCount = 0;
  let rotateCount = 0;
  let shiftMaskCount = 0;

  for (const insn of list) {
    const mn = String(insn?.mnemonic || insn?.mn || '').trim();
    if (!mn) continue;
    total++;
    const opsText = String(insn?.operands || insn?.ops || '');
    if (CRYPTO_HW_RE.test(mn)) {
      hwCryptoCount++;
      continue;
    }
    if (BITWISE_XOR_RE.test(mn)) {
      if (!isZeroingXor(mn, opsText)) xorCount++;
      continue;
    }
    if (BITWISE_ROT_RE.test(mn)) {
      rotateCount++;
      continue;
    }
    if (BITWISE_SHIFT_RE.test(mn)) {
      shiftMaskCount++;
    }
  }
  const bitwiseCount = xorCount + rotateCount + shiftMaskCount;
  const bitwiseRatio = total > 0 ? bitwiseCount / total : 0;
  const highBitwiseDensity = bitwiseCount >= 6 && bitwiseRatio >= 0.22 && (rotateCount >= 1 || xorCount >= 3);
  return {
    total,
    hwCryptoCount,
    xorCount,
    rotateCount,
    shiftMaskCount,
    bitwiseCount,
    bitwiseRatio,
    highBitwiseDensity,
  };
}
