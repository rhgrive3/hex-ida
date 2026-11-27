/**
 * General-purpose static cryptographic constant detection (FindCrypt-style),
 * Shannon entropy + compression-magic classification (WASM-accelerated with JS
 * fallback), and ARM64/x86-64 bitwise / 1-XOR loop / HW-crypto density scoring.
 */
import { getHexEngineExports, isWasmBulkMemorySupported } from '../core/hex-engine-wasm.js';
import { getEngineMode, recordWasmCall, recordFallback } from '../core/hex-engine-bridge.js';

const SCRATCH_CHUNK_MAX = 1536 * 1024; // stay comfortably inside 2.5MB WASM scratch arena

export const CRYPTO_ALGO_BY_ID = Object.freeze({
  1:  { id: 'aes-sbox',     name: 'AES S-Box' },
  2:  { id: 'aes-inv-sbox', name: 'AES Inverse S-Box' },
  3:  { id: 'sha256-k',     name: 'SHA-256 Round Constants (K)' },
  4:  { id: 'sha256-h0',    name: 'SHA-256 Initial Hash (H0)' },
  5:  { id: 'md5-t',        name: 'MD5 Sine Constants (T)' },
  6:  { id: 'chacha20',     name: 'ChaCha20 / Salsa20 Sigma' },
  7:  { id: 'crc32-ieee',   name: 'CRC32 IEEE Table' },
  8:  { id: 'aes-ttable',   name: 'AES T-Table (Te0/Td0)' },
  9:  { id: 'sha512-k',     name: 'SHA-512 Round Constants (K)' },
  10: { id: 'sha1-h0',      name: 'SHA-1 Initial Hash (H0)' },
  11: { id: 'blake2b-iv',   name: 'BLAKE2b IV' },
  12: { id: 'blowfish-p',   name: 'Blowfish P-Array' },
  13: { id: 'keccak-rc',    name: 'Keccak / SHA-3 Round Constants' },
});

const JS_CRYPTO_SIGS = Object.freeze([
  { algoId: 1,  reportLen: 256,  bytes: Uint8Array.from([0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76]) },
  { algoId: 2,  reportLen: 256,  bytes: Uint8Array.from([0x52, 0x09, 0x6a, 0xd5, 0x30, 0x36, 0xa5, 0x38, 0xbf, 0x40, 0xa3, 0x9e, 0x81, 0xf3, 0xd7, 0xfb]) },
  { algoId: 3,  reportLen: 256,  bytes: Uint8Array.from([0x98, 0x2f, 0x8a, 0x42, 0x91, 0x44, 0x37, 0x71, 0xcf, 0xfb, 0xc0, 0xb5, 0xa5, 0xdb, 0xb5, 0xe9]) },
  { algoId: 3,  reportLen: 256,  bytes: Uint8Array.from([0x42, 0x8a, 0x2f, 0x98, 0x71, 0x37, 0x44, 0x91, 0xb5, 0xc0, 0xfb, 0xcf, 0xe9, 0xb5, 0xdb, 0xa5]) },
  { algoId: 4,  reportLen: 32,   bytes: Uint8Array.from([0x67, 0xe6, 0x09, 0x6a, 0x85, 0xae, 0x67, 0xbb, 0x72, 0xf3, 0x6e, 0x3c, 0x3a, 0xf5, 0x4f, 0xa5]) },
  { algoId: 4,  reportLen: 32,   bytes: Uint8Array.from([0x6a, 0x09, 0xe6, 0x67, 0xbb, 0x67, 0xae, 0x85, 0x3c, 0x6e, 0xf3, 0x72, 0xa5, 0x4f, 0xf5, 0x3a]) },
  { algoId: 5,  reportLen: 256,  bytes: Uint8Array.from([0x78, 0xa4, 0x6a, 0xd7, 0x56, 0xb7, 0xc7, 0xe8, 0xdb, 0x70, 0x20, 0x24, 0xee, 0xce, 0xbd, 0xc1]) },
  { algoId: 6,  reportLen: 16,   bytes: Uint8Array.from([0x65, 0x78, 0x70, 0x61, 0x6e, 0x64, 0x20, 0x33, 0x32, 0x2d, 0x62, 0x79, 0x74, 0x65, 0x20, 0x6b]) },
  { algoId: 6,  reportLen: 16,   bytes: Uint8Array.from([0x65, 0x78, 0x70, 0x61, 0x6e, 0x64, 0x20, 0x31, 0x36, 0x2d, 0x62, 0x79, 0x74, 0x65, 0x20, 0x6b]) },
  { algoId: 7,  reportLen: 1024, bytes: Uint8Array.from([0x00, 0x00, 0x00, 0x00, 0x96, 0x30, 0x07, 0x77, 0x2c, 0x61, 0x0e, 0xee, 0xba, 0x51, 0x09, 0x99]) },
  { algoId: 8,  reportLen: 1024, bytes: Uint8Array.from([0xa5, 0x63, 0x63, 0xc6, 0x84, 0x7c, 0x7c, 0xf8, 0x99, 0x77, 0x77, 0xee, 0x8d, 0x7b, 0x7b, 0xf6]) },
  { algoId: 8,  reportLen: 1024, bytes: Uint8Array.from([0xc6, 0x63, 0x63, 0xa5, 0xf8, 0x7c, 0x7c, 0x84, 0xee, 0x77, 0x77, 0x99, 0xf6, 0x7b, 0x7b, 0x8d]) },
  { algoId: 8,  reportLen: 1024, bytes: Uint8Array.from([0x50, 0xa7, 0xf4, 0x51, 0x53, 0x65, 0x41, 0x7e, 0xc3, 0xa4, 0x17, 0x1a, 0x96, 0x5e, 0x27, 0x3a]) },
  { algoId: 8,  reportLen: 1024, bytes: Uint8Array.from([0x51, 0xf4, 0xa7, 0x50, 0x7e, 0x41, 0x65, 0x53, 0x1a, 0x17, 0xa4, 0xc3, 0x3a, 0x27, 0x5e, 0x96]) },
  { algoId: 9,  reportLen: 640,  bytes: Uint8Array.from([0x22, 0xae, 0x28, 0xd7, 0x98, 0x2f, 0x8a, 0x42, 0xcd, 0x65, 0xef, 0x23, 0x91, 0x44, 0x37, 0x71]) },
  { algoId: 9,  reportLen: 640,  bytes: Uint8Array.from([0x42, 0x8a, 0x2f, 0x98, 0xd7, 0x28, 0xae, 0x22, 0x71, 0x37, 0x44, 0x91, 0x23, 0xef, 0x65, 0xcd]) },
  { algoId: 10, reportLen: 20,   bytes: Uint8Array.from([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10]) },
  { algoId: 10, reportLen: 20,   bytes: Uint8Array.from([0x67, 0x45, 0x23, 0x01, 0xef, 0xcd, 0xab, 0x89, 0x98, 0xba, 0xdc, 0xfe, 0x10, 0x32, 0x54, 0x76]) },
  { algoId: 11, reportLen: 64,   bytes: Uint8Array.from([0x08, 0xc9, 0xbc, 0xf3, 0x67, 0xe6, 0x09, 0x6a, 0x3b, 0xa7, 0xca, 0x84, 0x85, 0xae, 0x67, 0xbb]) },
  { algoId: 12, reportLen: 72,   bytes: Uint8Array.from([0x88, 0x6a, 0x3f, 0x24, 0xd3, 0x08, 0xa3, 0x85, 0x2e, 0x8a, 0x19, 0x13, 0x44, 0x73, 0x70, 0x03]) },
  { algoId: 12, reportLen: 72,   bytes: Uint8Array.from([0x24, 0x3f, 0x6a, 0x88, 0x85, 0xa3, 0x08, 0xd3, 0x13, 0x19, 0x8a, 0x2e, 0x03, 0x70, 0x73, 0x44]) },
  { algoId: 13, reportLen: 192,  bytes: Uint8Array.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x82, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]) },
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
 * Distinguish well-known compressed stream headers from generic encrypted/packed data.
 */
export function classifyHighEntropyKind(bytes, offset = 0) {
  const u8 = toU8(bytes);
  if (!u8 || offset < 0 || offset + 4 > u8.length) return 'encrypted-or-packed';
  const b0 = u8[offset], b1 = u8[offset + 1], b2 = u8[offset + 2], b3 = u8[offset + 3];
  if (b0 === 0x1f && b1 === 0x8b && b2 === 0x08) return 'compressed:gzip';
  if (b0 === 0x28 && b1 === 0xb5 && b2 === 0x2f && b3 === 0xfd) return 'compressed:zstd';
  if (b0 === 0x04 && b1 === 0x22 && b2 === 0x4d && b3 === 0x18) return 'compressed:lz4';
  if (b0 === 0x50 && b1 === 0x4b && b2 === 0x03 && b3 === 0x04) return 'compressed:zip';
  if (offset + 6 <= u8.length && b0 === 0xfd && b1 === 0x37 && b2 === 0x7a && b3 === 0x58 && u8[offset + 4] === 0x5a && u8[offset + 5] === 0x00) {
    return 'compressed:xz';
  }
  if (b0 === 0x78 && (b1 === 0x01 || b1 === 0x5e || b1 === 0x9c || b1 === 0xda)) return 'compressed:zlib';
  return 'encrypted-or-packed';
}

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

  const ex = windowSize <= SCRATCH_CHUNK_MAX ? getWasmExports(engine ? { engine } : null) : null;
  if (ex) {
    try {
      const out = [];
      const maxStepSpan = Math.floor((SCRATCH_CHUNK_MAX - windowSize) / stepSize) * stepSize;
      const chunkBody = maxStepSpan + windowSize;
      let pos = 0;
      while (pos + windowSize <= u8.length && out.length < maxHits) {
        const end = Math.min(u8.length, pos + chunkBody);
        const chunkLen = end - pos;
        if (chunkLen < windowSize) break;
        const remain = maxHits - out.length;
        ex.hex_engine_scratch_reset();
        const inPtr = ex.hex_engine_scratch_alloc(chunkLen);
        const outPtr = ex.hex_engine_scratch_alloc(remain * 8);
        if (!inPtr || !outPtr) throw new Error('scratch_alloc_failed');
        new Uint8Array(ex.memory.buffer, inPtr, chunkLen).set(u8.subarray(pos, end));
        const count = ex.hex_scan_high_entropy_windows(inPtr, chunkLen, windowSize, stepSize, threshX1000, outPtr, remain) >>> 0;
        const pairs = new Uint32Array(ex.memory.buffer, outPtr, count * 2);
        for (let i = 0; i < count; i++) {
          const offset = pos + pairs[i * 2];
          out.push({
            offset,
            address: base + BigInt(offset),
            size: windowSize,
            entropy: pairs[i * 2 + 1] / 1000,
            kind: classifyHighEntropyKind(u8, offset),
          });
        }
        const windowsInChunk = Math.floor((chunkLen - windowSize) / stepSize) + 1;
        pos += windowsInChunk * stepSize;
      }
      recordWasmCall('crypto_entropy');
      return out;
    } catch {
      recordFallback('crypto_entropy:wasm_exception');
    }
  }

  const out = [];
  for (let pos = 0; pos + windowSize <= u8.length && out.length < maxHits; pos += stepSize) {
    const ent = shannonEntropyJs(u8.subarray(pos, pos + windowSize));
    if (Math.round(ent * 1000) >= threshX1000) {
      out.push({
        offset: pos,
        address: base + BigInt(pos),
        size: windowSize,
        entropy: ent,
        kind: classifyHighEntropyKind(u8, pos),
      });
    }
  }
  return out;
}

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
const BITWISE_XOR_RE = /^(?:eor|eor3|eon|xor|pxor|vpxor|vpxord|vpxorq|xorps|xorpd|vxorps|vxorpd)$/i;
const BITWISE_ROT_RE = /^(?:ror|extr|rol|rorx|shld|shrd)$/i;
const BITWISE_SHIFT_RE = /^(?:lsl|lsr|asr|shl|shr|sar|sal|bic|orn|and|ands|orr|not|andn|pand|por|pslld|psrld|psllq|psrlq)$/i;
const LOOP_BRANCH_RE = /^(?:b|b\.\w+|cbz|cbnz|tbz|tbnz|jmp|je|jne|jz|jnz|jl|jle|jg|jge|jb|jbe|ja|jae|loop\w*)$/i;
const LOOP_LOAD_RE = /^(?:ldrb|ldrh|ldr|ldur|ldurb|ldurh|ld1|ldp|mov|movzx|movsx|movq|movd|movdqu|movdqa|movups|movaps|vmovdqu\w*|vmovdqa\w*|vmovups|vmovaps)$/i;
const LOOP_STORE_RE = /^(?:strb|strh|str|stur|sturb|sturh|st1|stp|mov|movq|movd|movdqu|movdqa|movups|movaps|vmovdqu\w*|vmovdqa\w*|vmovups|vmovaps)$/i;

function isZeroingXor(mn, opsText) {
  if (!/^(?:eor|xor|pxor|vpxor|vpxord|vpxorq|xorps|xorpd|vxorps|vxorpd)$/i.test(mn)) return false;
  const parts = opsText.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 2) return parts[0] === parts[1];
  if (parts.length === 3) return parts[1] === parts[2];
  return false;
}

function parseBranchTarget(opsText) {
  const m = /#?(0x[0-9a-f]+)/i.exec(String(opsText || ''));
  if (!m) return null;
  try { return BigInt(m[1]); } catch { return null; }
}

/**
 * Analyze ARM64 / x86-64 instruction stream for hardware crypto instructions,
 * high bitwise/XOR/rotate density, and simple single-XOR loops (load -> xor -> store + backedge).
 */
export function analyzeCryptoInsnDensity(insns) {
  const list = Array.isArray(insns) ? insns : [];
  let total = 0;
  let hwCryptoCount = 0;
  let xorCount = 0;
  let rotateCount = 0;
  let shiftMaskCount = 0;
  let hasXorLoop = false;

  const addrToIndex = new Map();
  for (let i = 0; i < list.length; i++) {
    const a = list[i]?.address ?? list[i]?.addr;
    if (a != null) {
      try { addrToIndex.set(BigInt(a), i); } catch { /* ignore */ }
    }
  }

  for (let i = 0; i < list.length; i++) {
    const insn = list[i];
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
      continue;
    }
    if (!hasXorLoop && LOOP_BRANCH_RE.test(mn)) {
      const target = parseBranchTarget(opsText);
      const startIdx = target != null ? addrToIndex.get(target) : undefined;
      if (startIdx != null && startIdx < i && i - startIdx <= 64) {
        let sawLoad = false, sawXor = false, sawStore = false;
        for (let k = startIdx; k < i; k++) {
          const km = String(list[k]?.mnemonic || list[k]?.mn || '').trim();
          const ko = String(list[k]?.operands || list[k]?.ops || '');
          const firstComma = ko.indexOf(',');
          const dstIsMem = (firstComma >= 0 ? ko.slice(0, firstComma) : ko).includes('[');
          if (BITWISE_XOR_RE.test(km) && !isZeroingXor(km, ko)) {
            sawXor = true;
            if (dstIsMem) { sawLoad = true; sawStore = true; }
            else if (ko.includes('[')) { sawLoad = true; }
          } else if (LOOP_STORE_RE.test(km) && (km.toLowerCase().startsWith('st') || dstIsMem)) {
            sawStore = true;
          } else if (LOOP_LOAD_RE.test(km) && ko.includes('[') && !dstIsMem) {
            sawLoad = true;
          }
        }
        if (sawLoad && sawXor && sawStore) hasXorLoop = true;
      }
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
    hasXorLoop,
  };
}

/**
 * Scan binary file regions (prioritizing rodata/const/data then executable code)
 * for cryptographic constants and high-entropy encrypted/packed windows.
 */
export async function scanBinaryRegionsCrypto(file, regions, {
  maxBytes = 16 * 1024 * 1024,
  maxConstHits = 64,
  maxEntropyHits = 32,
  windowSize = 4096,
  step = 4096,
  threshold = 7.2,
  engine = null,
} = {}) {
  const empty = { constants: [], highEntropy: [], scannedBytes: 0, complete: true };
  if (!file || typeof file.slice !== 'function' || !Array.isArray(regions) || regions.length === 0) {
    return empty;
  }
  const priority = (r) => {
    const s = String(r?.section || r?.name || '').toLowerCase();
    if (/rodata|const|rdata/.test(s)) return 0;
    if (/data/.test(s) && !r?.exec) return 1;
    if (r?.exec || /text/.test(s)) return 2;
    return 3;
  };
  const live = regions
    .filter((r) => r && !r.zerofill && r.size != null && BigInt(r.size) >= 16n && r.fileOffset != null && BigInt(r.fileOffset) >= 0n)
    .sort((a, b) => priority(a) - priority(b));

  const constants = [];
  const highEntropy = [];
  let scannedBytes = 0;
  let complete = true;

  for (const r of live) {
    if (scannedBytes >= maxBytes) { complete = false; break; }
    const avail = maxBytes - scannedBytes;
    const rawSize = Number(BigInt(r.size));
    if (!Number.isFinite(rawSize) || rawSize < 16) continue;
    const take = Math.min(rawSize, avail);
    if (take < rawSize) complete = false;
    const fileOff = Number(BigInt(r.fileOffset));
    if (!Number.isSafeInteger(fileOff) || fileOff < 0) continue;
    let buf;
    try {
      buf = new Uint8Array(await file.slice(fileOff, fileOff + take).arrayBuffer());
    } catch {
      complete = false;
      continue;
    }
    if (buf.length < 16) continue;
    scannedBytes += buf.length;
    const baseAddress = BigInt(r.vmAddr ?? 0n);
    const section = String(r.section || r.name || '');

    if (constants.length < maxConstHits) {
      const hits = scanCryptoConstants(buf, { baseAddress, maxHits: maxConstHits - constants.length, engine });
      for (const h of hits) constants.push({ ...h, section });
    }
    if (highEntropy.length < maxEntropyHits && buf.length >= windowSize) {
      const wins = scanHighEntropyWindows(buf, {
        baseAddress, windowSize, step, threshold, maxHits: maxEntropyHits - highEntropy.length, engine,
      });
      for (const w of wins) highEntropy.push({ ...w, section });
    }
  }
  return { constants, highEntropy, scannedBytes, complete };
}
