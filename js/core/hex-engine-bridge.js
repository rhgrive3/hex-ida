/**
 * Unified JS <-> C++/WASM engine bridge (Wave 2: W2-bridge-decomp).
 *
 * Strictly fail-closed:
 * - Never throws when the unified WASM artifact (`./hex-engine-wasm.js`) is absent
 *   or bulk-memory is unsupported.
 * - Records `recordWasmCall(domain)` ONLY immediately before returning a verified
 *   WASM result.
 * - Records `recordFallback(domain + ':' + reason)` on every fallback path (no
 *   silent fallbacks).
 */
import {
  recordWasmCall,
  recordFallback,
  getWasmCallCount,
  getFallbackCount,
  resetAllTelemetry,
} from './wasm-telemetry.js';

export {
  recordWasmCall,
  recordFallback,
  getWasmCallCount,
  getFallbackCount,
  resetAllTelemetry,
};

export const HEX_OK = 0;
const HEX_ERR_OOM = 2;
export const HEX_EMIT_FLAG_JS_PARITY = 1;

const FNV64_OFFSET_BASIS = 0xcbf29ce484222325n;
const SIZEOF_HEX_IMAGE_INFO = 72;
const SIZEOF_HEX_ARM64_DECODED = 208;
const SIZEOF_HEX_X86_DECODED = 72;
const SIZEOF_HEX_LINEMAP_ENTRY = 16;
const SIZEOF_HEX_IR_STATS = 56;
const SIZEOF_HEX_RISCV64_DECODED = 64;
const HEX_IR_NONE = 0xffffffff;

// Known ARM64 regression guards kept explicitly blocked in JS before WASM
// invocation; all other instructions are delegated directly to C++'s strict
// 0-diff gate (`hex_engine_decompile_arm64` -> HEX_OK vs HEX_ERR_UNSUPPORTED).
const EXPLICIT_UNSUPPORTED_ARM64_MNEMONICS = Object.freeze(new Set([
  'mneg',
  'smull',
]));

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Optional static-like load of ./hex-engine-wasm.js (generated in a parallel worktree).
import * as wasmModuleApi from './hex-engine-wasm.js';

function noteFallback(domain, reason) {
  recordFallback(`${domain}:${reason}`);
  return null;
}

function getHexEngineExportsSafe(opts = null) {
  if (!wasmModuleApi || typeof wasmModuleApi.getHexEngineExports !== 'function') {
    return null;
  }
  try {
    return wasmModuleApi.getHexEngineExports(opts) || null;
  } catch {
    return null;
  }
}

export function isWasmBulkMemorySupported() {
  if (!wasmModuleApi || typeof wasmModuleApi.isWasmBulkMemorySupported !== 'function') {
    return false;
  }
  try {
    return Boolean(wasmModuleApi.isWasmBulkMemorySupported());
  } catch {
    return false;
  }
}

export function resetHexEngineForTest() {
  if (wasmModuleApi && typeof wasmModuleApi.resetHexEngineForTest === 'function') {
    wasmModuleApi.resetHexEngineForTest();
  }
  resetAllTelemetry();
}

export function getEngineMode(opts = null) {
  const raw = (opts && opts._engine != null ? opts._engine : null)
    ?? (typeof globalThis !== 'undefined' ? (globalThis.HEX_ENGINE ?? globalThis.__HEX_ENGINE_MODE__) : null)
    ?? (typeof process !== 'undefined' && process.env ? process.env.HEX_ENGINE : null)
    ?? 'auto';
  const norm = String(raw).trim().toLowerCase();
  if (norm === 'js' || norm === 'wasm' || norm === 'auto') return norm;
  return 'auto';
}

export function isWasmEngineAvailable() {
  return getEngineMode() !== 'js'
    && isWasmBulkMemorySupported()
    && Boolean(getHexEngineExportsSafe());
}

function readCString(mem, ptr, maxLen) {
  const bytes = new Uint8Array(mem, ptr, maxLen);
  let len = 0;
  while (len < maxLen && bytes[len] !== 0) len += 1;
  return textDecoder.decode(bytes.subarray(0, len));
}

function allocScratch(ex, bytes) {
  if (typeof ex.hex_identity_alloc === 'function') return ex.hex_identity_alloc(bytes);
  if (typeof ex.hex_image_scratch_alloc === 'function') return ex.hex_image_scratch_alloc(bytes);
  if (typeof ex.cfg_alloc === 'function') return ex.cfg_alloc(bytes);
  return 0;
}

function resetScratch(ex) {
  if (typeof ex.hex_identity_reset === 'function') ex.hex_identity_reset();
  else if (typeof ex.hex_image_scratch_reset === 'function') ex.hex_image_scratch_reset();
  else if (typeof ex.cfg_reset === 'function') ex.cfg_reset();
}

// ---------------------------------------------------------------------------
// Identity API
// ---------------------------------------------------------------------------
export function wasmFnv64Bytes(bytes) {
  if (getEngineMode() === 'js') return noteFallback('identity', 'wasm_disabled');
  if (!(bytes instanceof Uint8Array)) return noteFallback('identity', 'invalid_bytes');
  const ex = getHexEngineExportsSafe();
  if (!isWasmBulkMemorySupported() || !ex || typeof ex.hex_identity_fnv64_bytes !== 'function') {
    return noteFallback('identity', 'wasm_unavailable');
  }
  try {
    if (bytes.length === 0) {
      const raw = ex.hex_identity_fnv64_bytes(0, 0, FNV64_OFFSET_BASIS);
      const result = BigInt.asUintN(64, BigInt(raw));
      recordWasmCall('identity');
      return result;
    }
    const CHUNK_BYTES = 524288;
    const allocLen = Math.min(bytes.length, CHUNK_BYTES);
    ex.hex_identity_reset?.();
    const ptr = ex.hex_identity_alloc(allocLen);
    if (!ptr) return noteFallback('identity', 'oom');
    let hash = FNV64_OFFSET_BASIS;
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      const chunkLen = Math.min(CHUNK_BYTES, bytes.length - offset);
      new Uint8Array(ex.memory.buffer, ptr, chunkLen).set(bytes.subarray(offset, offset + chunkLen));
      const raw = ex.hex_identity_fnv64_bytes(ptr, chunkLen, hash);
      hash = BigInt.asUintN(64, BigInt(raw));
    }
    recordWasmCall('identity');
    return hash;
  } catch {
    return noteFallback('identity', 'wasm_exception');
  }
}

export function wasmStableStringify(value) {
  if (getEngineMode() === 'js') return noteFallback('identity', 'wasm_disabled');
  const ex = getHexEngineExportsSafe();
  if (!isWasmBulkMemorySupported() || !ex || typeof ex.hex_identity_stable_stringify !== 'function') {
    return noteFallback('identity', 'wasm_unavailable');
  }
  let jsonText;
  try {
    jsonText = JSON.stringify(value);
  } catch {
    return noteFallback('identity', 'non_json_value');
  }
  if (typeof jsonText !== 'string') return noteFallback('identity', 'undefined_value');
  try {
    const encoded = textEncoder.encode(jsonText);
    ex.hex_identity_reset?.();
    const inPtr = encoded.length > 0 ? ex.hex_identity_alloc(encoded.length) : 0;
    if (encoded.length > 0 && !inPtr) return noteFallback('identity', 'oom');
    if (encoded.length > 0) new Uint8Array(ex.memory.buffer, inPtr, encoded.length).set(encoded);
    const outPtrPtr = ex.hex_identity_alloc(8);
    if (!outPtrPtr) return noteFallback('identity', 'oom');
    const outLenPtr = outPtrPtr + 4;
    const status = ex.hex_identity_stable_stringify(inPtr, encoded.length, outPtrPtr, outLenPtr);
    if (status !== HEX_OK) return noteFallback('identity', `wasm_status_${status}`);
    const dv = new DataView(ex.memory.buffer);
    const outPtr = dv.getUint32(outPtrPtr, true);
    const outLen = dv.getUint32(outLenPtr, true);
    const result = outLen > 0
      ? textDecoder.decode(new Uint8Array(ex.memory.buffer, outPtr, outLen))
      : '';
    recordWasmCall('identity');
    return result;
  } catch {
    return noteFallback('identity', 'wasm_exception');
  }
}

export function wasmStableDigest(value) {
  if (getEngineMode() === 'js') return noteFallback('identity', 'wasm_disabled');
  const ex = getHexEngineExportsSafe();
  if (!isWasmBulkMemorySupported() || !ex || typeof ex.hex_identity_digest_utf8 !== 'function') {
    return noteFallback('identity', 'wasm_unavailable');
  }
  let canonicalText;
  if (typeof value === 'string') {
    canonicalText = value;
  } else {
    canonicalText = wasmStableStringify(value);
    if (canonicalText === null) return null;
  }
  try {
    const encoded = textEncoder.encode(canonicalText);
    ex.hex_identity_reset?.();
    const inPtr = encoded.length > 0 ? ex.hex_identity_alloc(encoded.length) : 0;
    if (encoded.length > 0 && !inPtr) return noteFallback('identity', 'oom');
    if (encoded.length > 0) new Uint8Array(ex.memory.buffer, inPtr, encoded.length).set(encoded);
    const outHexPtr = ex.hex_identity_alloc(32);
    if (!outHexPtr) return noteFallback('identity', 'oom');
    const status = ex.hex_identity_digest_utf8(inPtr, encoded.length, outHexPtr);
    if (status !== HEX_OK) return noteFallback('identity', `wasm_status_${status}`);
    const digest = textDecoder.decode(new Uint8Array(ex.memory.buffer, outHexPtr, 32));
    recordWasmCall('identity');
    return digest;
  } catch {
    return noteFallback('identity', 'wasm_exception');
  }
}

// ---------------------------------------------------------------------------
// Binary Inspection API
// ---------------------------------------------------------------------------
export function wasmInspectBinary(bytes) {
  if (getEngineMode() === 'js') return noteFallback('binary', 'wasm_disabled');
  if (!(bytes instanceof Uint8Array)) return noteFallback('binary', 'invalid_bytes');
  const ex = getHexEngineExportsSafe();
  if (
    !isWasmBulkMemorySupported()
    || !ex
    || typeof ex.hex_image_alloc_input !== 'function'
    || typeof ex.hex_image_open !== 'function'
    || typeof ex.hex_image_get_info !== 'function'
    || typeof ex.hex_image_close !== 'function'
  ) {
    return noteFallback('binary', 'wasm_unavailable');
  }
  let handle = 0;
  try {
    let retriedAfterReset = false;
    let outHandlePtr = 0;
    let openStatus = HEX_ERR_OOM;
    for (;;) {
      ex.hex_image_scratch_reset?.();
      const inPtr = bytes.length > 0 ? ex.hex_image_alloc_input(bytes.length) : 0;
      if (bytes.length > 0 && !inPtr) {
        if (!retriedAfterReset && typeof ex.hex_engine_init === 'function') {
          ex.hex_engine_init();
          retriedAfterReset = true;
          continue;
        }
        return noteFallback('binary', 'oom');
      }
      if (bytes.length > 0) new Uint8Array(ex.memory.buffer, inPtr, bytes.length).set(bytes);
      outHandlePtr = ex.hex_image_scratch_alloc(8);
      if (!outHandlePtr) return noteFallback('binary', 'oom');
      openStatus = ex.hex_image_open(inPtr, bytes.length, outHandlePtr);
      if (openStatus === HEX_ERR_OOM && !retriedAfterReset && typeof ex.hex_engine_init === 'function') {
        ex.hex_engine_init();
        retriedAfterReset = true;
        continue;
      }
      break;
    }
    if (openStatus !== HEX_OK) return noteFallback('binary', `open_status_${openStatus}`);
    handle = new DataView(ex.memory.buffer).getUint32(outHandlePtr, true);
    if (!handle) return noteFallback('binary', 'invalid_handle');
    const outInfoPtr = ex.hex_image_scratch_alloc(SIZEOF_HEX_IMAGE_INFO);
    if (!outInfoPtr) return noteFallback('binary', 'oom');
    const infoStatus = ex.hex_image_get_info(handle, outInfoPtr);
    if (infoStatus !== HEX_OK) return noteFallback('binary', `info_status_${infoStatus}`);
    const dv = new DataView(ex.memory.buffer, outInfoPtr, SIZEOF_HEX_IMAGE_INFO);
    const info = {
      format: dv.getUint32(0, true),
      arch: dv.getUint32(4, true),
      bits: dv.getUint32(8, true),
      endian: dv.getUint32(12, true),
      sectionCount: dv.getUint32(16, true),
      isFat: dv.getUint32(20, true) !== 0,
      fatSliceCount: dv.getUint32(24, true),
      entryPoint: dv.getBigUint64(32, true),
      imageBase: dv.getBigUint64(40, true),
      fileSize: dv.getBigUint64(48, true),
      sliceOffset: dv.getBigUint64(56, true),
      sliceSize: dv.getBigUint64(64, true),
    };
    recordWasmCall('binary');
    return info;
  } catch {
    return noteFallback('binary', 'wasm_exception');
  } finally {
    if (handle) {
      try { ex.hex_image_close(handle); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// ARM64 Decode API
// ---------------------------------------------------------------------------
function readArm64Decoded(mem, basePtr) {
  const dv = new DataView(mem, basePtr, SIZEOF_HEX_ARM64_DECODED);
  return {
    word: dv.getUint32(0, true),
    kind: dv.getUint8(4),
    cap: dv.getUint8(5),
    rd: dv.getUint8(6),
    rn: dv.getUint8(7),
    rm: dv.getUint8(8),
    hasTarget: dv.getUint8(9) !== 0,
    hasPcRel: dv.getUint8(10) !== 0,
    hasMemory: dv.getUint8(11) !== 0,
    hasCompareWith: dv.getUint8(12) !== 0,
    hasPairedOffset: dv.getUint8(13) !== 0,
    isPrologue: dv.getUint8(14) !== 0,
    isEnd: dv.getUint8(15) !== 0,
    pc: dv.getBigUint64(24, true),
    target: dv.getBigUint64(32, true),
    compareWith: dv.getBigInt64(40, true),
    mn: readCString(mem, basePtr + 128, 16),
    ops: readCString(mem, basePtr + 144, 64),
  };
}

export function wasmDecodeArm64Word(word, pc = 0n) {
  if (getEngineMode() === 'js') return noteFallback('arm64_decode', 'wasm_disabled');
  const ex = getHexEngineExportsSafe();
  if (!isWasmBulkMemorySupported() || !ex || typeof ex.hex_arm64_decode_word !== 'function') {
    return noteFallback('arm64_decode', 'wasm_unavailable');
  }
  try {
    resetScratch(ex);
    const outPtr = allocScratch(ex, SIZEOF_HEX_ARM64_DECODED);
    if (!outPtr) return noteFallback('arm64_decode', 'oom');
    const status = ex.hex_arm64_decode_word(word >>> 0, BigInt(pc), outPtr);
    if (status !== HEX_OK) return noteFallback('arm64_decode', `wasm_status_${status}`);
    const decoded = readArm64Decoded(ex.memory.buffer, outPtr);
    recordWasmCall('arm64_decode');
    return decoded;
  } catch {
    return noteFallback('arm64_decode', 'wasm_exception');
  }
}

export function wasmDecodeArm64Batch(words, basePc = 0n) {
  if (getEngineMode() === 'js') return noteFallback('arm64_decode', 'wasm_disabled');
  if (!words || typeof words.length !== 'number') return noteFallback('arm64_decode', 'invalid_words');
  const ex = getHexEngineExportsSafe();
  if (!isWasmBulkMemorySupported() || !ex || typeof ex.hex_arm64_decode_batch !== 'function') {
    return noteFallback('arm64_decode', 'wasm_unavailable');
  }
  const count = words.length >>> 0;
  if (count === 0) {
    return [];
  }
  try {
    const CHUNK_WORDS = 4096;
    const basePcBig = BigInt(basePc);
    const out = new Array(count);
    for (let offset = 0; offset < count; offset += CHUNK_WORDS) {
      const chunkCount = Math.min(CHUNK_WORDS, count - offset);
      resetScratch(ex);
      const inPtr = allocScratch(ex, chunkCount * 4);
      const outPtr = allocScratch(ex, chunkCount * SIZEOF_HEX_ARM64_DECODED);
      if (!inPtr || !outPtr) return noteFallback('arm64_decode', 'oom');
      const inView = new Uint32Array(ex.memory.buffer, inPtr, chunkCount);
      for (let i = 0; i < chunkCount; i += 1) inView[i] = words[offset + i] >>> 0;
      const status = ex.hex_arm64_decode_batch(inPtr, chunkCount, basePcBig + BigInt(offset * 4), outPtr);
      if (status !== HEX_OK) return noteFallback('arm64_decode', `wasm_status_${status}`);
      const mem = ex.memory.buffer;
      for (let i = 0; i < chunkCount; i += 1) {
        out[offset + i] = readArm64Decoded(mem, outPtr + i * SIZEOF_HEX_ARM64_DECODED);
      }
    }
    recordWasmCall('arm64_decode');
    return out;
  } catch {
    return noteFallback('arm64_decode', 'wasm_exception');
  }
}

export function wasmClassifyArm64Batch(words) {
  if (getEngineMode() === 'js') return noteFallback('arm64_decode', 'wasm_disabled');
  if (!words || typeof words.length !== 'number') return noteFallback('arm64_decode', 'invalid_words');
  const ex = getHexEngineExportsSafe();
  if (!isWasmBulkMemorySupported() || !ex || typeof ex.hex_arm64_classify_batch !== 'function') {
    return noteFallback('arm64_decode', 'wasm_unavailable');
  }
  const count = words.length >>> 0;
  if (count === 0) {
    return new Uint8Array(0);
  }
  try {
    const CHUNK_WORDS = 65536;
    const out = new Uint8Array(count);
    for (let offset = 0; offset < count; offset += CHUNK_WORDS) {
      const chunkCount = Math.min(CHUNK_WORDS, count - offset);
      resetEngineScratch(ex);
      const inPtr = allocEngineScratch(ex, chunkCount * 4);
      const outPtr = allocEngineScratch(ex, chunkCount);
      if (!inPtr || !outPtr) return noteFallback('arm64_decode', 'oom');
      const inView = new Uint32Array(ex.memory.buffer, inPtr, chunkCount);
      if (words instanceof Uint32Array) {
        inView.set(words.subarray(offset, offset + chunkCount));
      } else {
        for (let i = 0; i < chunkCount; i += 1) inView[i] = words[offset + i] >>> 0;
      }
      const status = ex.hex_arm64_classify_batch(inPtr, chunkCount, outPtr);
      if (status !== HEX_OK) return noteFallback('arm64_decode', `wasm_status_${status}`);
      out.set(new Uint8Array(ex.memory.buffer, outPtr, chunkCount), offset);
    }
    recordWasmCall('arm64_decode');
    return out;
  } catch {
    return noteFallback('arm64_decode', 'wasm_exception');
  }
}

// ---------------------------------------------------------------------------
// x86_64 Decode API
// ---------------------------------------------------------------------------
export function wasmDecodeX86_64Batch(bytes, basePc = 0n) {
  if (getEngineMode() === 'js') return noteFallback('x86_64_decode', 'wasm_disabled');
  if (!(bytes instanceof Uint8Array)) return noteFallback('x86_64_decode', 'invalid_bytes');
  const ex = getHexEngineExportsSafe();
  if (!isWasmBulkMemorySupported() || !ex || typeof ex.hex_x86_64_decode_batch !== 'function') {
    return noteFallback('x86_64_decode', 'wasm_unavailable');
  }
  if (bytes.length === 0) {
    return [];
  }
  try {
    const CHUNK_BYTES = 4096;
    const basePcBig = BigInt(basePc);
    const out = [];
    let offset = 0;
    while (offset < bytes.length) {
      const chunkLen = Math.min(CHUNK_BYTES, bytes.length - offset);
      resetScratch(ex);
      const maxInsns = chunkLen;
      const inPtr = allocScratch(ex, chunkLen);
      const outPtr = allocScratch(ex, maxInsns * SIZEOF_HEX_X86_DECODED);
      const countPtr = allocScratch(ex, 8);
      if (!inPtr || !outPtr || !countPtr) return noteFallback('x86_64_decode', 'oom');
      new Uint8Array(ex.memory.buffer, inPtr, chunkLen).set(bytes.subarray(offset, offset + chunkLen));
      const status = ex.hex_x86_64_decode_batch(inPtr, chunkLen, basePcBig + BigInt(offset), outPtr, maxInsns, countPtr);
      if (status !== HEX_OK) return noteFallback('x86_64_decode', `wasm_status_${status}`);
      const mem = ex.memory.buffer;
      const count = new DataView(mem).getUint32(countPtr, true);
      let consumed = 0;
      let hitInvalid = false;
      for (let i = 0; i < count; i += 1) {
        const base = outPtr + i * SIZEOF_HEX_X86_DECODED;
        const dv = new DataView(mem, base, SIZEOF_HEX_X86_DECODED);
        const ilen = dv.getUint8(36);
        const valid = dv.getUint8(51) !== 0;
        if (!valid && offset + chunkLen < bytes.length && consumed > 0 && chunkLen - consumed < 15) {
          break;
        }
        out.push({
          pc: dv.getBigUint64(0, true),
          target: dv.getBigUint64(8, true),
          disp: dv.getBigInt64(16, true),
          imm: dv.getBigInt64(24, true),
          flags: dv.getUint32(32, true),
          length: ilen,
          kind: dv.getUint8(37),
          cap: dv.getUint8(38),
          rex: dv.getUint8(39),
          opcode: dv.getUint8(40),
          opcode2: dv.getUint8(41),
          modrm: dv.getUint8(42),
          sib: dv.getUint8(43),
          opSize: dv.getUint8(44),
          reg: dv.getUint8(45),
          rm: dv.getUint8(46),
          indexReg: dv.getUint8(47),
          scale: dv.getUint8(48),
          dispSize: dv.getUint8(49),
          immSize: dv.getUint8(50),
          valid,
          mn: readCString(mem, base + 52, 16),
        });
        consumed += ilen;
        if (!valid || ilen === 0) {
          hitInvalid = true;
          break;
        }
      }
      if (consumed === 0 || hitInvalid) break;
      offset += consumed;
    }
    recordWasmCall('x86_64_decode');
    return out;
  } catch {
    return noteFallback('x86_64_decode', 'wasm_exception');
  }
}

// ---------------------------------------------------------------------------
// ARM64 Decompiler Capability Gate + WASM Pipeline Invocation
// ---------------------------------------------------------------------------
function isNonAliasOrrRegister(word, mn, ops) {
  const w = word >>> 0;
  // ARM64 ORR (shifted register): sf 0101010 shift(2) 0 Rm(5) imm6(6) Rn(5) Rd(5)
  // MOV (register) alias is ORR with shift==0, imm6==0, Rn==31 (xzr/wzr).
  const isOrrShiftedReg = (w & 0x7f200000) === 0x2a000000;
  if (isOrrShiftedReg) {
    const rn = (w >>> 5) & 0x1f;
    const imm6 = (w >>> 10) & 0x3f;
    const shift = (w >>> 22) & 0x3;
    const isMovAlias = rn === 31 && imm6 === 0 && shift === 0;
    if (!isMovAlias) return true;
  }
  if (mn === 'orr') {
    const text = String(ops || '').toLowerCase();
    const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 3 && parts[1] !== 'xzr' && parts[1] !== 'wzr') return true;
  }
  return false;
}

function isOrrImmediate(word) {
  const w = word >>> 0;
  // ARM64 ORR (immediate): sf 01 100100 N immr(6) imms(6) Rn(5) Rd(5)
  // Allow 32-bit MOV (bitmask immediate) alias: sf=0, opc=01, Rn=31 (WZR).
  if (((w & 0xffc003e0) >>> 0) === 0x320003e0) return false;
  return ((w & 0x7f800000) >>> 0) === 0x32000000;
}

function classifyUnsupportedArm64Insn(word, insn) {
  const w = word >>> 0;
  const mn = String(insn?.mn ?? insn?.mnemonic ?? '').trim().toLowerCase();
  const ops = String(insn?.ops ?? insn?.opStr ?? '');
  if (mn && EXPLICIT_UNSUPPORTED_ARM64_MNEMONICS.has(mn)) {
    return `unsupported_insn:${mn}`;
  }
  if (isNonAliasOrrRegister(w, mn, ops) || isOrrImmediate(w)) {
    return 'unsupported_insn:orr';
  }
  // Bit-level fallback guards for MNEG and SMULL when mnemonic metadata is omitted (FMOV imm is handled natively in WASM).
  if (((w & 0x7fe0fc00) >>> 0) === 0x1b00fc00) {
    return 'unsupported_insn:mneg';
  }
  if (((w & 0xffe0fc00) >>> 0) === 0x9b207c00) {
    return 'unsupported_insn:smull';
  }
  return null;
}


const WASM_GENERAL_LIBC_SPECS = {
  malloc: { hdr: '<stdlib.h>', ret: 'x0', call: '(uint64)(uintptr_t)malloc((size_t)x0)', regs: ['x0'], needUintptr: true },
  calloc: { hdr: '<stdlib.h>', ret: 'x0', call: '(uint64)(uintptr_t)calloc((size_t)x0, (size_t)x1)', regs: ['x0', 'x1'], needUintptr: true },
  realloc: { hdr: '<stdlib.h>', ret: 'x0', call: '(uint64)(uintptr_t)realloc((void *)(uintptr_t)x0, (size_t)x1)', regs: ['x0', 'x1'], needUintptr: true },
  free: { hdr: '<stdlib.h>', ret: 'void', call: 'free((void *)(uintptr_t)x0)', regs: ['x0'], needUintptr: true },
  exit: { hdr: '<stdlib.h>', ret: 'void', call: 'exit((int)x0)', regs: ['x0'] },
  _exit: { hdr: '<unistd.h>', ret: 'void', call: '_exit((int)x0)', regs: ['x0'] },
  abort: { hdr: '<stdlib.h>', ret: 'void', call: 'abort()', regs: [] },
  strlen: { hdr: '<string.h>', ret: 'x0', call: '(uint64)strlen((const char *)(uintptr_t)x0)', regs: ['x0'], needUintptr: true },
  strcpy: { hdr: '<string.h>', ret: 'x0', call: '(uint64)(uintptr_t)strcpy((char *)(uintptr_t)x0, (const char *)(uintptr_t)x1)', regs: ['x0', 'x1'], needUintptr: true },
  strncpy: { hdr: '<string.h>', ret: 'x0', call: '(uint64)(uintptr_t)strncpy((char *)(uintptr_t)x0, (const char *)(uintptr_t)x1, (size_t)x2)', regs: ['x0', 'x1', 'x2'], needUintptr: true },
  stpcpy: { hdr: '<string.h>', ret: 'x0', call: '(uint64)(uintptr_t)stpcpy((char *)(uintptr_t)x0, (const char *)(uintptr_t)x1)', regs: ['x0', 'x1'], needUintptr: true },
  strcat: { hdr: '<string.h>', ret: 'x0', call: '(uint64)(uintptr_t)strcat((char *)(uintptr_t)x0, (const char *)(uintptr_t)x1)', regs: ['x0', 'x1'], needUintptr: true },
  strncat: { hdr: '<string.h>', ret: 'x0', call: '(uint64)(uintptr_t)strncat((char *)(uintptr_t)x0, (const char *)(uintptr_t)x1, (size_t)x2)', regs: ['x0', 'x1', 'x2'], needUintptr: true },
  strcmp: { hdr: '<string.h>', ret: 'x0', call: '(uint64)(int64_t)strcmp((const char *)(uintptr_t)x0, (const char *)(uintptr_t)x1)', regs: ['x0', 'x1'], needUintptr: true, needInt64: true },
  strncmp: { hdr: '<string.h>', ret: 'x0', call: '(uint64)(int64_t)strncmp((const char *)(uintptr_t)x0, (const char *)(uintptr_t)x1, (size_t)x2)', regs: ['x0', 'x1', 'x2'], needUintptr: true, needInt64: true },
  strchr: { hdr: '<string.h>', ret: 'x0', call: '(uint64)(uintptr_t)strchr((const char *)(uintptr_t)x0, (int)x1)', regs: ['x0', 'x1'], needUintptr: true },
  strrchr: { hdr: '<string.h>', ret: 'x0', call: '(uint64)(uintptr_t)strrchr((const char *)(uintptr_t)x0, (int)x1)', regs: ['x0', 'x1'], needUintptr: true },
  strstr: { hdr: '<string.h>', ret: 'x0', call: '(uint64)(uintptr_t)strstr((const char *)(uintptr_t)x0, (const char *)(uintptr_t)x1)', regs: ['x0', 'x1'], needUintptr: true },
  strdup: { hdr: '<string.h>', ret: 'x0', call: '(uint64)(uintptr_t)strdup((const char *)(uintptr_t)x0)', regs: ['x0'], needUintptr: true },
  memcpy: { hdr: '<string.h>', ret: 'x0', call: '(uint64)(uintptr_t)memcpy((void *)(uintptr_t)x0, (const void *)(uintptr_t)x1, (size_t)x2)', regs: ['x0', 'x1', 'x2'], needUintptr: true },
  memmove: { hdr: '<string.h>', ret: 'x0', call: '(uint64)(uintptr_t)memmove((void *)(uintptr_t)x0, (const void *)(uintptr_t)x1, (size_t)x2)', regs: ['x0', 'x1', 'x2'], needUintptr: true },
  memset: { hdr: '<string.h>', ret: 'x0', call: '(uint64)(uintptr_t)memset((void *)(uintptr_t)x0, (int)x1, (size_t)x2)', regs: ['x0', 'x1', 'x2'], needUintptr: true },
  memcmp: { hdr: '<string.h>', ret: 'x0', call: '(uint64)(int64_t)memcmp((const void *)(uintptr_t)x0, (const void *)(uintptr_t)x1, (size_t)x2)', regs: ['x0', 'x1', 'x2'], needUintptr: true, needInt64: true },
  strtol: { hdr: '<stdlib.h>', ret: 'x0', call: '(uint64)strtol((const char *)(uintptr_t)x0, (char **)(uintptr_t)x1, (int)x2)', regs: ['x0', 'x1', 'x2'], needUintptr: true },
  strtoll: { hdr: '<stdlib.h>', ret: 'x0', call: '(uint64)strtoll((const char *)(uintptr_t)x0, (char **)(uintptr_t)x1, (int)x2)', regs: ['x0', 'x1', 'x2'], needUintptr: true },
  strtoul: { hdr: '<stdlib.h>', ret: 'x0', call: '(uint64)strtoul((const char *)(uintptr_t)x0, (char **)(uintptr_t)x1, (int)x2)', regs: ['x0', 'x1', 'x2'], needUintptr: true },
  strtod: { hdr: '<stdlib.h>', ret: 'd0', call: 'strtod((const char *)(uintptr_t)x0, (char **)(uintptr_t)x1)', regs: ['x0', 'x1', 'd0'], needUintptr: true },
  atoi: { hdr: '<stdlib.h>', ret: 'x0', call: '(uint64)(int64_t)atoi((const char *)(uintptr_t)x0)', regs: ['x0'], needUintptr: true, needInt64: true },
  atol: { hdr: '<stdlib.h>', ret: 'x0', call: '(uint64)(int64_t)atol((const char *)(uintptr_t)x0)', regs: ['x0'], needUintptr: true, needInt64: true },
  atof: { hdr: '<stdlib.h>', ret: 'd0', call: 'atof((const char *)(uintptr_t)x0)', regs: ['x0', 'd0'], needUintptr: true },
  tolower: { hdr: '<ctype.h>', ret: 'x0', call: '(uint64)(int64_t)tolower((int)x0)', regs: ['x0'], needInt64: true },
  toupper: { hdr: '<ctype.h>', ret: 'x0', call: '(uint64)(int64_t)toupper((int)x0)', regs: ['x0'], needInt64: true },
  isalpha: { hdr: '<ctype.h>', ret: 'x0', call: '(uint64)(int64_t)isalpha((int)x0)', regs: ['x0'], needInt64: true },
  isdigit: { hdr: '<ctype.h>', ret: 'x0', call: '(uint64)(int64_t)isdigit((int)x0)', regs: ['x0'], needInt64: true },
  isalnum: { hdr: '<ctype.h>', ret: 'x0', call: '(uint64)(int64_t)isalnum((int)x0)', regs: ['x0'], needInt64: true },
  isspace: { hdr: '<ctype.h>', ret: 'x0', call: '(uint64)(int64_t)isspace((int)x0)', regs: ['x0'], needInt64: true },
  isupper: { hdr: '<ctype.h>', ret: 'x0', call: '(uint64)(int64_t)isupper((int)x0)', regs: ['x0'], needInt64: true },
  islower: { hdr: '<ctype.h>', ret: 'x0', call: '(uint64)(int64_t)islower((int)x0)', regs: ['x0'], needInt64: true },
  abs: { hdr: '<stdlib.h>', ret: 'x0', call: '(uint64)(int64_t)abs((int)x0)', regs: ['x0'], needInt64: true },
  labs: { hdr: '<stdlib.h>', ret: 'x0', call: '(uint64)(int64_t)labs((long)x0)', regs: ['x0'], needInt64: true },
  qsort: { hdr: '<stdlib.h>', ret: 'void', call: 'qsort((void *)(uintptr_t)x0, (size_t)x1, (size_t)x2, (int (*)(const void *, const void *))(uintptr_t)x3)', regs: ['x0', 'x1', 'x2', 'x3'], needUintptr: true },
  bsearch: { hdr: '<stdlib.h>', ret: 'x0', call: '(uint64)(uintptr_t)bsearch((const void *)(uintptr_t)x0, (const void *)(uintptr_t)x1, (size_t)x2, (size_t)x3, (int (*)(const void *, const void *))(uintptr_t)x4)', regs: ['x0', 'x1', 'x2', 'x3', 'x4'], needUintptr: true },
  rand: { hdr: '<stdlib.h>', ret: 'x0', call: '(uint64)(int64_t)rand()', regs: ['x0'], needInt64: true },
  srand: { hdr: '<stdlib.h>', ret: 'void', call: 'srand((unsigned int)x0)', regs: ['x0'] },
  time: { hdr: '<time.h>', ret: 'x0', call: '(uint64)time((time_t *)(uintptr_t)x0)', regs: ['x0'], needUintptr: true },
  clock: { hdr: '<time.h>', ret: 'x0', call: '(uint64)clock()', regs: ['x0'] },
  printf: {
    hdr: '<stdio.h>',
    ret: 'x0',
    call: '(uint64)(int64_t)printf((const char *)(uintptr_t)x0)',
    regs: ['x0'],
    needUintptr: true,
    needInt64: true,
    varargs: { fmtRegIndex: 0, kind: 'printf', fn: 'printf', retCast: '(uint64)(int64_t)', fixedPrefix: '(const char *)(uintptr_t)x0', fixedRegs: ['x0'] },
  },
  fprintf: {
    hdr: '<stdio.h>',
    ret: 'x0',
    call: '(uint64)(int64_t)fprintf((FILE *)(uintptr_t)x0, (const char *)(uintptr_t)x1)',
    regs: ['x0', 'x1'],
    needUintptr: true,
    needInt64: true,
    varargs: { fmtRegIndex: 1, kind: 'printf', fn: 'fprintf', retCast: '(uint64)(int64_t)', fixedPrefix: '(FILE *)(uintptr_t)x0, (const char *)(uintptr_t)x1', fixedRegs: ['x0', 'x1'] },
  },
  sprintf: {
    hdr: '<stdio.h>',
    ret: 'x0',
    call: '(uint64)(int64_t)sprintf((char *)(uintptr_t)x0, (const char *)(uintptr_t)x1)',
    regs: ['x0', 'x1'],
    needUintptr: true,
    needInt64: true,
    varargs: { fmtRegIndex: 1, kind: 'printf', fn: 'sprintf', retCast: '(uint64)(int64_t)', fixedPrefix: '(char *)(uintptr_t)x0, (const char *)(uintptr_t)x1', fixedRegs: ['x0', 'x1'] },
  },
  snprintf: {
    hdr: '<stdio.h>',
    ret: 'x0',
    call: '(uint64)(int64_t)snprintf((char *)(uintptr_t)x0, (size_t)x1, (const char *)(uintptr_t)x2)',
    regs: ['x0', 'x1', 'x2'],
    needUintptr: true,
    needInt64: true,
    varargs: { fmtRegIndex: 2, kind: 'printf', fn: 'snprintf', retCast: '(uint64)(int64_t)', fixedPrefix: '(char *)(uintptr_t)x0, (size_t)x1, (const char *)(uintptr_t)x2', fixedRegs: ['x0', 'x1', 'x2'] },
  },
  vprintf: { hdr: '<stdio.h>', extraHdrs: ['<stdarg.h>'], ret: 'x0', call: '(uint64)(int64_t)vprintf((const char *)(uintptr_t)x0, *(va_list *)(uintptr_t)x1)', regs: ['x0', 'x1'], needUintptr: true, needInt64: true },
  puts: { hdr: '<stdio.h>', ret: 'x0', call: '(uint64)(int64_t)puts((const char *)(uintptr_t)x0)', regs: ['x0'], needUintptr: true, needInt64: true },
  fputs: { hdr: '<stdio.h>', ret: 'x0', call: '(uint64)(int64_t)fputs((const char *)(uintptr_t)x0, (FILE *)(uintptr_t)x1)', regs: ['x0', 'x1'], needUintptr: true, needInt64: true },
  putchar: { hdr: '<stdio.h>', ret: 'x0', call: '(uint64)(int64_t)putchar((int)x0)', regs: ['x0'], needInt64: true },
  fputc: { hdr: '<stdio.h>', ret: 'x0', call: '(uint64)(int64_t)fputc((int)x0, (FILE *)(uintptr_t)x1)', regs: ['x0', 'x1'], needUintptr: true, needInt64: true },
  getchar: { hdr: '<stdio.h>', ret: 'x0', call: '(uint64)(int64_t)getchar()', regs: ['x0'], needInt64: true },
  fgets: { hdr: '<stdio.h>', ret: 'x0', call: '(uint64)(uintptr_t)fgets((char *)(uintptr_t)x0, (int)x1, (FILE *)(uintptr_t)x2)', regs: ['x0', 'x1', 'x2'], needUintptr: true },
  fread: { hdr: '<stdio.h>', ret: 'x0', call: '(uint64)fread((void *)(uintptr_t)x0, (size_t)x1, (size_t)x2, (FILE *)(uintptr_t)x3)', regs: ['x0', 'x1', 'x2', 'x3'], needUintptr: true },
  fwrite: { hdr: '<stdio.h>', ret: 'x0', call: '(uint64)fwrite((const void *)(uintptr_t)x0, (size_t)x1, (size_t)x2, (FILE *)(uintptr_t)x3)', regs: ['x0', 'x1', 'x2', 'x3'], needUintptr: true },
  fopen: { hdr: '<stdio.h>', ret: 'x0', call: '(uint64)(uintptr_t)fopen((const char *)(uintptr_t)x0, (const char *)(uintptr_t)x1)', regs: ['x0', 'x1'], needUintptr: true },
  fclose: { hdr: '<stdio.h>', ret: 'x0', call: '(uint64)(int64_t)fclose((FILE *)(uintptr_t)x0)', regs: ['x0'], needUintptr: true, needInt64: true },
  fflush: { hdr: '<stdio.h>', ret: 'x0', call: '(uint64)(int64_t)fflush((FILE *)(uintptr_t)x0)', regs: ['x0'], needUintptr: true, needInt64: true },
  fseek: { hdr: '<stdio.h>', ret: 'x0', call: '(uint64)(int64_t)fseek((FILE *)(uintptr_t)x0, (long)x1, (int)x2)', regs: ['x0', 'x1', 'x2'], needUintptr: true, needInt64: true },
  ftell: { hdr: '<stdio.h>', ret: 'x0', call: '(uint64)(int64_t)ftell((FILE *)(uintptr_t)x0)', regs: ['x0'], needUintptr: true, needInt64: true },
  scanf: {
    hdr: '<stdio.h>',
    ret: 'x0',
    call: '(uint64)(int64_t)scanf((const char *)(uintptr_t)x0)',
    regs: ['x0'],
    needUintptr: true,
    needInt64: true,
    varargs: { fmtRegIndex: 0, kind: 'scanf', fn: 'scanf', retCast: '(uint64)(int64_t)', fixedPrefix: '(const char *)(uintptr_t)x0', fixedRegs: ['x0'] },
  },
  sscanf: {
    hdr: '<stdio.h>',
    ret: 'x0',
    call: '(uint64)(int64_t)sscanf((const char *)(uintptr_t)x0, (const char *)(uintptr_t)x1)',
    regs: ['x0', 'x1'],
    needUintptr: true,
    needInt64: true,
    varargs: { fmtRegIndex: 1, kind: 'scanf', fn: 'sscanf', retCast: '(uint64)(int64_t)', fixedPrefix: '(const char *)(uintptr_t)x0, (const char *)(uintptr_t)x1', fixedRegs: ['x0', 'x1'] },
  },
  fscanf: {
    hdr: '<stdio.h>',
    ret: 'x0',
    call: '(uint64)(int64_t)fscanf((FILE *)(uintptr_t)x0, (const char *)(uintptr_t)x1)',
    regs: ['x0', 'x1'],
    needUintptr: true,
    needInt64: true,
    varargs: { fmtRegIndex: 1, kind: 'scanf', fn: 'fscanf', retCast: '(uint64)(int64_t)', fixedPrefix: '(FILE *)(uintptr_t)x0, (const char *)(uintptr_t)x1', fixedRegs: ['x0', 'x1'] },
  },
  perror: { hdr: '<stdio.h>', ret: 'void', call: 'perror((const char *)(uintptr_t)x0)', regs: ['x0'], needUintptr: true },
  pthread_mutex_lock: { hdr: '<pthread.h>', ret: 'x0', call: '(uint64)(int64_t)pthread_mutex_lock((pthread_mutex_t *)(uintptr_t)x0)', regs: ['x0'], needUintptr: true, needInt64: true },
  pthread_mutex_unlock: { hdr: '<pthread.h>', ret: 'x0', call: '(uint64)(int64_t)pthread_mutex_unlock((pthread_mutex_t *)(uintptr_t)x0)', regs: ['x0'], needUintptr: true, needInt64: true },
  pthread_create: { hdr: '<pthread.h>', ret: 'x0', call: '(uint64)(int64_t)pthread_create((pthread_t *)(uintptr_t)x0, (const pthread_attr_t *)(uintptr_t)x1, (void *(*)(void *))(uintptr_t)x2, (void *)(uintptr_t)x3)', regs: ['x0', 'x1', 'x2', 'x3'], needUintptr: true, needInt64: true },
  pthread_join: { hdr: '<pthread.h>', ret: 'x0', call: '(uint64)(int64_t)pthread_join((pthread_t)x0, (void **)(uintptr_t)x1)', regs: ['x0', 'x1'], needUintptr: true, needInt64: true },
  objc_msgSend: { hdr: null, proto: 'extern uint64 objc_msgSend(uint64, uint64, ...);', ret: 'x0', call: 'objc_msgSend(x0, x1)', regs: ['x0', 'x1'] },
  objc_retain: { hdr: null, proto: 'extern uint64 objc_retain(uint64);', ret: 'x0', call: 'objc_retain(x0)', regs: ['x0'] },
  objc_release: { hdr: null, proto: 'extern void objc_release(uint64);', ret: 'void', call: 'objc_release(x0)', regs: ['x0'] },
  __ctype_b_loc: { hdr: '<ctype.h>', ret: 'x0', call: '(uint64)(uintptr_t)__ctype_b_loc()', regs: ['x0'], needUintptr: true },
  __ctype_tolower_loc: { hdr: '<ctype.h>', ret: 'x0', call: '(uint64)(uintptr_t)__ctype_tolower_loc()', regs: ['x0'], needUintptr: true },
  __ctype_toupper_loc: { hdr: '<ctype.h>', ret: 'x0', call: '(uint64)(uintptr_t)__ctype_toupper_loc()', regs: ['x0'], needUintptr: true },
  pow: { hdr: '<math.h>', ret: 'd0', call: 'pow(d0, d1)', regs: ['d0', 'd1'] },
  sqrt: { hdr: '<math.h>', ret: 'd0', call: 'sqrt(d0)', regs: ['d0'] },
  sqrtf: { hdr: '<math.h>', ret: 'd0', call: '(double)sqrtf((float)d0)', regs: ['d0'] },
  fabs: { hdr: '<math.h>', ret: 'd0', call: 'fabs(d0)', regs: ['d0'] },
  fabsf: { hdr: '<math.h>', ret: 'd0', call: '(double)fabsf((float)d0)', regs: ['d0'] },
  floor: { hdr: '<math.h>', ret: 'd0', call: 'floor(d0)', regs: ['d0'] },
  ceil: { hdr: '<math.h>', ret: 'd0', call: 'ceil(d0)', regs: ['d0'] },
  round: { hdr: '<math.h>', ret: 'd0', call: 'round(d0)', regs: ['d0'] },
  roundf: { hdr: '<math.h>', ret: 'd0', call: '(double)roundf((float)d0)', regs: ['d0'] },
  floorf: { hdr: '<math.h>', ret: 'd0', call: '(double)floorf((float)d0)', regs: ['d0'] },
  ceilf: { hdr: '<math.h>', ret: 'd0', call: '(double)ceilf((float)d0)', regs: ['d0'] },
  truncf: { hdr: '<math.h>', ret: 'd0', call: '(double)truncf((float)d0)', regs: ['d0'] },
  fmod: { hdr: '<math.h>', ret: 'd0', call: 'fmod(d0, d1)', regs: ['d0', 'd1'] },
  sin: { hdr: '<math.h>', ret: 'd0', call: 'sin(d0)', regs: ['d0'] },
  cos: { hdr: '<math.h>', ret: 'd0', call: 'cos(d0)', regs: ['d0'] },
  log: { hdr: '<math.h>', ret: 'd0', call: 'log(d0)', regs: ['d0'] },
  exp: { hdr: '<math.h>', ret: 'd0', call: 'exp(d0)', regs: ['d0'] },
};

const WASM_LIBC_ALIASES = {
  __isoc99_scanf: 'scanf',
  __isoc99_sscanf: 'sscanf',
  __isoc99_fscanf: 'fscanf',
  __isoc23_scanf: 'scanf',
  __isoc23_sscanf: 'sscanf',
  __isoc23_fscanf: 'fscanf',
  __isoc23_strtol: 'strtol',
  __isoc23_strtoul: 'strtoul',
  __isoc23_strtoll: 'strtoll',
};

function normalizeLibcSymbolName(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let name = raw.trim();
  const at = name.indexOf('@');
  if (at > 0) name = name.slice(0, at);
  if (WASM_LIBC_ALIASES[name]) name = WASM_LIBC_ALIASES[name];
  if (WASM_GENERAL_LIBC_SPECS[name]) return name;
  if (name.startsWith('_') && !name.startsWith('__') && WASM_GENERAL_LIBC_SPECS[name.slice(1)]) {
    return name.slice(1);
  }
  return null;
}

const C_RESERVED_IDENTIFIERS = new Set([
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double',
  'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long',
  'register', 'restrict', 'return', 'short', 'signed', 'sizeof', 'static', 'struct',
  'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while', '_Alignas',
  '_Alignof', '_Atomic', '_Bool', '_Complex', '_Generic', '_Imaginary', '_Noreturn',
  '_Static_assert', '_Thread_local', 'bool', 'true', 'false', 'NULL',
  'uint64', 'int64', 'uint32', 'int32', 'uint16', 'int16', 'uint8', 'int8',
  'uint64_t', 'int64_t', 'uint32_t', 'int32_t', 'uint16_t', 'int16_t', 'uint8_t', 'int8_t',
  'uintptr_t', 'intptr_t', 'size_t', 'ssize_t', 'uint128', 'vector128', 'id', 'sp',
]);

const STANDARD_C_POSIX_DECLARED = new Set([
  'memchr', 'strtok', 'strtok_r', 'open', 'read', 'write', 'close', 'lseek', 'stat', 'fstat',
  'tan', 'sin', 'cos', 'log', 'exp', 'atan', 'atan2', 'asin', 'acos', 'sinh', 'cosh', 'tanh',
  'qsort', 'exit', 'abort', 'system', 'getenv', 'signal', 'raise', 'setjmp', 'longjmp',
  'isalpha', 'isdigit', 'isspace', 'isalnum', 'toupper', 'tolower',
  'atoi', 'atol', 'atof', 'strtol', 'strtoul', 'strtoll', 'strtoull', 'strtod', 'strtof',
  'malloc', 'free', 'calloc', 'realloc', 'memcpy', 'memmove', 'memset', 'memcmp',
  'strlen', 'strcmp', 'strncmp', 'strcpy', 'strncpy', 'strcat', 'strncat', 'strchr', 'strrchr', 'strstr',
  'printf', 'fprintf', 'sprintf', 'snprintf', 'puts', 'putchar', 'fputs', 'fgets', 'fopen', 'fclose', 'fread', 'fwrite',
]);

function sanitizeCallSymbolName(raw, hex, usedNames) {
  if (typeof raw !== 'string') return null;
  let name = raw.trim();
  if (!name) return null;
  const at = name.indexOf('@');
  if (at > 0) name = name.slice(0, at);
  // Strip C++ parameter signature suffix if demangled name was provided
  const paren = name.indexOf('(');
  if (paren > 0) name = name.slice(0, paren).trim();
  name = name.replace(/[^A-Za-z0-9_]/g, '_');
  if (!name || /^_+$/.test(name)) return null;
  if (/^[0-9]/.test(name)) name = `fn_${name}`;
  if (C_RESERVED_IDENTIFIERS.has(name) || usedNames.has(name)) {
    const candidate = `${name}_fn`;
    name = (C_RESERVED_IDENTIFIERS.has(candidate) || usedNames.has(candidate))
      ? `${name}_${hex}`
      : candidate;
  }
  usedNames.add(name);
  return name;
}

const ELF64_INFO_CACHE = new WeakMap();

function parseElf64SectionsAndSyms(fileBytes) {
  if (!(fileBytes instanceof Uint8Array) || fileBytes.length < 64) return null;
  if (fileBytes[0] !== 0x7f || fileBytes[1] !== 0x45 || fileBytes[2] !== 0x4c || fileBytes[3] !== 0x46) return null;
  if (fileBytes[4] !== 2 || fileBytes[5] !== 1) return null; // 64-bit little-endian
  const cached = ELF64_INFO_CACHE.get(fileBytes);
  if (cached) return cached;
  const dv = new DataView(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength);
  const shoff = Number(dv.getBigUint64(40, true));
  const shentsize = dv.getUint16(58, true);
  const shnum = dv.getUint16(60, true);
  const shstrndx = dv.getUint16(62, true);
  const secs = [];
  const syms = new Map();
  if (shoff > 0 && shentsize >= 64 && shoff + shnum * shentsize <= fileBytes.length) {
    let strOff = 0, strSize = 0;
    if (shstrndx < shnum) {
      const sp = shoff + shstrndx * shentsize;
      strOff = Number(dv.getBigUint64(sp + 24, true));
      strSize = Number(dv.getBigUint64(sp + 32, true));
    }
    const readStr = (off, sz, idx) => {
      if (off + idx >= fileBytes.length || idx >= sz) return '';
      let end = off + idx;
      const lim = Math.min(fileBytes.length, off + sz);
      while (end < lim && fileBytes[end] !== 0) end++;
      let s = '';
      for (let k = off + idx; k < end; k++) s += String.fromCharCode(fileBytes[k]);
      return s;
    };
    for (let i = 0; i < shnum; i++) {
      const p = shoff + i * shentsize;
      const shName = dv.getUint32(p, true);
      const shType = dv.getUint32(p + 4, true);
      const shFlags = dv.getBigUint64(p + 8, true);
      const shAddr = dv.getBigUint64(p + 16, true);
      const shOffset = dv.getBigUint64(p + 24, true);
      const shSize = dv.getBigUint64(p + 32, true);
      const shLink = dv.getUint32(p + 40, true);
      const shEntSize = Number(dv.getBigUint64(p + 56, true));
      const name = readStr(strOff, strSize, shName);
      secs.push({ name, type: shType, flags: shFlags, addr: shAddr, offset: shOffset, size: shSize, link: shLink, entsize: shEntSize });
    }
    for (const sec of secs) {
      if ((sec.type === 2 || sec.type === 11) && sec.entsize >= 24 && sec.link < secs.length) {
        const count = Math.floor(Number(sec.size) / sec.entsize);
        const base = Number(sec.offset);
        for (let i = 0; i < count; i++) {
          const ep = base + i * sec.entsize;
          if (ep + 24 > fileBytes.length) break;
          const stInfo = fileBytes[ep + 4];
          const stType = stInfo & 0xf;
          const stValue = dv.getBigUint64(ep + 8, true);
          const stSize = Number(dv.getBigUint64(ep + 16, true));
          if (stType === 2 && stValue > 0n && stSize >= 4) {
            syms.set(stValue, stSize);
          }
        }
      }
    }
  }
  const relativeRelocs = [];
  for (const sec of secs) {
    if (sec.type === 4) { // SHT_RELA
      const entsize = sec.entsize >= 24 ? sec.entsize : 24;
      const count = Math.floor(Number(sec.size) / entsize);
      const base = Number(sec.offset);
      for (let i = 0; i < count; i += 1) {
        const ep = base + i * entsize;
        if (ep + 24 > fileBytes.length) break;
        const rOffset = dv.getBigUint64(ep, true);
        const rInfo = dv.getBigUint64(ep + 8, true);
        if ((rInfo & 0xFFFFFFFFn) === 1027n) { // R_AARCH64_RELATIVE
          const rAddend = dv.getBigInt64(ep + 16, true);
          relativeRelocs.push({ offset: rOffset, addend: rAddend });
        }
      }
    }
  }
  const info = { secs, syms, relativeRelocs };
  ELF64_INFO_CACHE.set(fileBytes, info);
  return info;
}

const NORMALIZED_SECTIONS_CACHE = new WeakMap();
const HEX_BYTE_LUT = Array.from({ length: 256 }, (_, b) => `0x${b.toString(16).padStart(2, '0')}`);

function readBinaryBytesAt(addr, len, { readBytes, fileBytes, sections }) {
  const elfInfo = parseElf64SectionsAndSyms(fileBytes);
  if (elfInfo) {
    for (const sec of elfInfo.secs) {
      if (sec.size <= 0n || sec.addr <= 0n) continue;
      if (addr >= sec.addr && addr < sec.addr + sec.size) {
        if (sec.type === 8 || sec.name === '.bss') return null; // SHT_NOBITS -> keep zeroed writable buffer
        const delta = addr - sec.addr;
        const avail = Number(sec.size - delta);
        const take = Math.min(len, avail);
        const offNum = Number(sec.offset + delta);
        if (offNum >= 0 && offNum + take <= fileBytes.length && take > 0) {
          return fileBytes.subarray(offNum, offNum + take);
        }
      }
    }
    return null;
  }
  if (fileBytes instanceof Uint8Array && Array.isArray(sections)) {
    let norm = NORMALIZED_SECTIONS_CACHE.get(sections);
    if (!norm) {
      norm = [];
      for (const sec of sections) {
        if (!sec) continue;
        let start, size, foff;
        try {
          start = BigInt(sec.address ?? sec.vmAddr ?? sec.addr ?? 0);
          size = BigInt(sec.size ?? 0);
          foff = sec.fileOffset != null ? BigInt(sec.fileOffset) : (sec.offset != null ? BigInt(sec.offset) : null);
        } catch {
          continue;
        }
        if (size <= 0n) continue;
        const nobits = sec.name === '.bss' || sec.type === 'SHT_NOBITS' || Boolean(sec.nobits);
        norm.push({ start, end: start + size, size, foff, nobits });
      }
      NORMALIZED_SECTIONS_CACHE.set(sections, norm);
    }
    for (let i = 0; i < norm.length; i += 1) {
      const sec = norm[i];
      if (addr >= sec.start && addr < sec.end) {
        if (sec.nobits) return null;
        if (sec.foff == null) continue;
        const delta = addr - sec.start;
        const avail = Number(sec.size - delta);
        const take = Math.min(len, avail);
        const offNum = Number(sec.foff + delta);
        if (offNum >= 0 && offNum + take <= fileBytes.length && take > 0) {
          return fileBytes.subarray(offNum, offNum + take);
        }
      }
    }
  }
  if (typeof readBytes === 'function') {
    try {
      const b = readBytes(addr, len);
      if (b && b.length > 0) return b instanceof Uint8Array ? b : new Uint8Array(b);
    } catch {}
  }
  return null;
}

function formatCStringBytes(bytes, startOff, maxEnd, escape = true) {
  let end = startOff;
  while (end < maxEnd && bytes[end] !== 0) {
    const ch = bytes[end];
    if (ch !== 0x09 && ch !== 0x0a && ch !== 0x0d && (ch < 0x20 || ch > 0x7e)) return null;
    end++;
  }
  if (end >= maxEnd || bytes[end] !== 0) return null;
  let s = '';
  for (let k = startOff; k < end; k++) {
    const ch = bytes[k];
    if (!escape) {
      s += String.fromCharCode(ch);
    } else if (ch === 0x5c) s += '\\\\';
    else if (ch === 0x22) s += '\\"';
    else if (ch === 0x0a) s += '\\n';
    else if (ch === 0x0d) s += '\\r';
    else if (ch === 0x09) s += '\\t';
    else s += String.fromCharCode(ch);
  }
  return s;
}

function isStringDataSectionName(name) {
  if (typeof name !== 'string' || !name) return false;
  return (
    name === '.rodata'
    || name.startsWith('.rodata.')
    || name === '__cstring'
    || name === '__const'
    || name === '__data'
    || name === '__cfstring'
    || name === '.rdata'
  );
}

function readCStringFromBinary(addr, { fileBytes, elfInfo, sections, readBytes, escape = true } = {}) {
  if (addr <= 0n) return null;
  if (elfInfo && fileBytes instanceof Uint8Array) {
    for (const sec of elfInfo.secs) {
      if (sec.type === 8 || sec.size <= 0n || sec.addr <= 0n) continue;
      if (!isStringDataSectionName(sec.name)) continue;
      if (addr >= sec.addr && addr < sec.addr + sec.size) {
        const off = Number(sec.offset + (addr - sec.addr));
        const maxEnd = Math.min(fileBytes.length, Number(sec.offset + sec.size), off + 256);
        if (off >= 0 && off < maxEnd) {
          return formatCStringBytes(fileBytes, off, maxEnd, escape);
        }
      }
    }
    return null;
  }
  if (fileBytes instanceof Uint8Array && Array.isArray(sections)) {
    for (let i = 0; i < sections.length; i += 1) {
      const sec = sections[i];
      if (!sec || !isStringDataSectionName(sec.name)) continue;
      let start, size, foff;
      try {
        start = BigInt(sec.address ?? sec.vmAddr ?? sec.addr ?? 0);
        size = BigInt(sec.size ?? 0);
        foff = sec.fileOffset != null ? BigInt(sec.fileOffset) : (sec.offset != null ? BigInt(sec.offset) : null);
      } catch {
        continue;
      }
      if (size <= 0n || foff == null || addr < start || addr >= start + size) continue;
      const off = Number(foff + (addr - start));
      const maxEnd = Math.min(fileBytes.length, Number(foff + size), off + 256);
      if (off >= 0 && off < maxEnd) {
        return formatCStringBytes(fileBytes, off, maxEnd, escape);
      }
    }
  }
  if (typeof readBytes === 'function') {
    try {
      const raw = readBytes(addr, 256);
      if (raw && raw.length > 0) {
        const u8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        return formatCStringBytes(u8, 0, u8.length, escape);
      }
    } catch {}
  }
  return null;
}

function unescapeCStringLiteral(lit) {
  let out = '';
  for (let i = 0; i < lit.length; i += 1) {
    if (lit[i] === '\\' && i + 1 < lit.length) {
      const nxt = lit[i + 1];
      i += 1;
      if (nxt === 'n') out += '\n';
      else if (nxt === 'r') out += '\r';
      else if (nxt === 't') out += '\t';
      else if (nxt === '\\') out += '\\';
      else if (nxt === '"') out += '"';
      else out += nxt;
    } else {
      out += lit[i];
    }
  }
  return out;
}

function parseFormatSpecifiers(fmt, kind, fmtRegIndex) {
  const args = [];
  const regs = [];
  let needUintptr = false;
  let gi = fmtRegIndex + 1;
  let fi = 0;
  let i = 0;
  while (i < fmt.length) {
    if (fmt[i] !== '%') {
      i += 1;
      continue;
    }
    i += 1;
    if (i >= fmt.length) break;
    if (fmt[i] === '%') {
      i += 1;
      continue;
    }
    if (kind === 'scanf') {
      let suppressed = false;
      if (fmt[i] === '*') {
        suppressed = true;
        i += 1;
      }
      while (i < fmt.length && fmt[i] >= '0' && fmt[i] <= '9') i += 1;
      while (i < fmt.length && 'hljztL'.includes(fmt[i])) i += 1;
      if (i < fmt.length) {
        const conv = fmt[i];
        i += 1;
        if (conv === '[') {
          if (i < fmt.length && fmt[i] === '^') i += 1;
          if (i < fmt.length && fmt[i] === ']') i += 1;
          while (i < fmt.length && fmt[i] !== ']') i += 1;
          if (i < fmt.length) i += 1;
        }
        if (!suppressed && gi <= 7) {
          args.push(`(void *)(uintptr_t)x${gi}`);
          regs.push(`x${gi}`);
          needUintptr = true;
          gi += 1;
        }
      }
      continue;
    }
    // printf family
    while (i < fmt.length && "-+ #0'".includes(fmt[i])) i += 1;
    if (i < fmt.length && fmt[i] === '*') {
      if (gi <= 7) {
        args.push(`(int)x${gi}`);
        regs.push(`x${gi}`);
        gi += 1;
      }
      i += 1;
    } else {
      while (i < fmt.length && fmt[i] >= '0' && fmt[i] <= '9') i += 1;
    }
    if (i < fmt.length && fmt[i] === '.') {
      i += 1;
      if (i < fmt.length && fmt[i] === '*') {
        if (gi <= 7) {
          args.push(`(int)x${gi}`);
          regs.push(`x${gi}`);
          gi += 1;
        }
        i += 1;
      } else {
        while (i < fmt.length && fmt[i] >= '0' && fmt[i] <= '9') i += 1;
      }
    }
    let lenMod = '';
    while (i < fmt.length && 'hljztL'.includes(fmt[i])) {
      lenMod += fmt[i];
      i += 1;
    }
    if (i >= fmt.length) break;
    const conv = fmt[i];
    i += 1;
    if ('fFeEgGaA'.includes(conv)) {
      if (fi <= 7) {
        args.push(`d${fi}`);
        regs.push(`d${fi}`);
        fi += 1;
      }
    } else if (conv === 's') {
      if (gi <= 7) {
        args.push(`(const char *)(uintptr_t)x${gi}`);
        regs.push(`x${gi}`);
        needUintptr = true;
        gi += 1;
      }
    } else if (conv === 'p') {
      if (gi <= 7) {
        args.push(`x${gi}`);
        regs.push(`x${gi}`);
        gi += 1;
      }
    } else if ('diouxXc'.includes(conv)) {
      if (gi <= 7) {
        const isWide = lenMod.includes('l') || lenMod.includes('z') || lenMod.includes('j') || lenMod.includes('t');
        args.push(isWide ? `x${gi}` : `(int)x${gi}`);
        regs.push(`x${gi}`);
        gi += 1;
      }
    } else if (conv === 'n') {
      if (gi <= 7) {
        args.push(`(int *)(uintptr_t)x${gi}`);
        regs.push(`x${gi}`);
        needUintptr = true;
        gi += 1;
      }
    }
  }
  return { args, regs, needUintptr };
}

function resolveFormatStringBeforeLine(lines, lineIdx, fmtRegIndex, binaryCtx) {
  const regName = `x${fmtRegIndex}`;
  const assignRe = new RegExp(`^\\s*${regName}\\s*=\\s*(.+);\\s*$`);
  const stopLine = Math.max(0, lineIdx - 16);
  for (let i = lineIdx - 1; i >= stopLine; i -= 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (trimmed === '{' || trimmed === '}' || trimmed.startsWith('return ') || trimmed.startsWith('goto ')) break;
    const m = trimmed.match(assignRe);
    if (!m) {
      if (trimmed.includes('sub_') && trimmed.includes('(')) break;
      continue;
    }
    const rhs = m[1].trim();
    const litM = rhs.match(/"((?:\\.|[^"\\])*)"/);
    if (litM) return unescapeCStringLiteral(litM[1]);
    const globM = rhs.match(/(?:__hex_)?global_([0-9A-Fa-f]+)(?:_buf)?\b/);
    if (globM) {
      const s = readCStringFromBinary(BigInt(`0x${globM[1]}`), { ...binaryCtx, escape: false });
      if (s != null) return s;
    }
    const hexM = rhs.match(/\b0x([0-9A-Fa-f]+)(?:ULL|UL|LL|U|L)?\b/);
    if (hexM) {
      const s = readCStringFromBinary(BigInt(`0x${hexM[1]}`), { ...binaryCtx, escape: false });
      if (s != null) return s;
    }
    break;
  }
  return null;
}

function inferCallerDefinedArgRegs(lines, lineIdx) {
  let maxInt = -1;
  let maxFp = -1;
  const stopLine = Math.max(0, lineIdx - 16);
  for (let i = lineIdx - 1; i >= stopLine; i -= 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (
      trimmed === '{'
      || trimmed === '}'
      || trimmed.startsWith('return ')
      || trimmed.startsWith('goto ')
      || /^[A-Za-z_][A-Za-z0-9_]*:\s*$/.test(trimmed)
    ) {
      break;
    }
    // Stop at a prior call statement
    if (/\b(?:sub_[0-9A-Fa-f]+|[A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*;$/.test(trimmed) && !trimmed.includes('__hex_')) {
      break;
    }
    const xm = trimmed.match(/^x([0-7])\s*=/);
    if (xm) {
      const k = Number(xm[1]);
      if (k > maxInt) maxInt = k;
      continue;
    }
    const dm = trimmed.match(/^d([0-7])\s*=/);
    if (dm) {
      const k = Number(dm[1]);
      if (k > maxFp) maxFp = k;
    }
  }
  return {
    intCount: maxInt >= 0 ? maxInt + 1 : 0,
    fpCount: maxFp >= 0 ? maxFp + 1 : 0,
    found: maxInt >= 0 || maxFp >= 0,
  };
}

function scanArm64EntryArgRegs(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return null;
  const wordCount = Math.min(32, Math.floor(bytes.length / 4));
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let writtenInt = 0;
  let readInt = 0;
  let writtenFp = 0;
  let readFp = 0;
  let decoded = 0;

  const markReadInt = (r) => {
    if (r >= 0 && r <= 7 && (writtenInt & (1 << r)) === 0) readInt |= (1 << r);
  };
  const markWriteInt = (r) => {
    if (r >= 0 && r <= 7) writtenInt |= (1 << r);
  };
  const markReadFp = (r) => {
    if (r >= 0 && r <= 7 && (writtenFp & (1 << r)) === 0) readFp |= (1 << r);
  };
  const markWriteFp = (r) => {
    if (r >= 0 && r <= 7) writtenFp |= (1 << r);
  };

  for (let i = 0; i < wordCount; i += 1) {
    const w = dv.getUint32(i * 4, true) >>> 0;
    if (w === 0 || w === 0xFFFFFFFF) break;
    // NOP / PAC / BTI hints
    if (((w & 0xFFFFF01F) >>> 0) === 0xD503201F) {
      decoded += 1;
      continue;
    }
    // BR / BRAA / BRAB / BRAAZ / BRABZ / BLR / BLRAA* / unconditional B:
    // If reached before any x0..x7 / d0..d7 read, this is a .plt stub, Mach-O __stubs,
    // or tail-call thunk rather than a proven 0-argument function body.
    if (
      ((w & 0xFFFFFC1F) >>> 0) === 0xD61F0000
      || ((w & 0xFFFFF81F) >>> 0) === 0xD61F081F
      || ((w & 0xFFFFF800) >>> 0) === 0xD71F0800
      || ((w & 0xFFFFFC1F) >>> 0) === 0xD63F0000
      || ((w & 0xFFFFF81F) >>> 0) === 0xD63F081F
      || ((w & 0xFFFFF800) >>> 0) === 0xD73F0800
      || ((w & 0xFC000000) >>> 0) === 0x14000000
    ) {
      if (readInt === 0 && readFp === 0) return null;
      decoded += 1;
      break;
    }
    // RET / RETAA / RETAB / BL
    if (
      w === 0xD65F03C0
      || w === 0xD65F0BFF
      || w === 0xD65F0FFF
      || ((w & 0xFC000000) >>> 0) === 0x94000000
    ) {
      decoded += 1;
      break;
    }
    const rd = w & 0x1F;
    const rn = (w >>> 5) & 0x1F;
    const rm = (w >>> 16) & 0x1F;
    const ra = (w >>> 10) & 0x1F;
    const op0 = (w >>> 25) & 0x0F;

    // 1. PC-rel ADR / ADRP
    if ((op0 & 0x0E) === 0x08 && ((w >>> 24) & 0x1F) === 0x10) {
      markWriteInt(rd);
      decoded += 1;
      continue;
    }
    // 2. Data processing - Immediate
    if ((op0 & 0x0E) === 0x08) {
      const op23_25 = (w >>> 23) & 0x07;
      if (op23_25 === 2 || op23_25 === 3) {
        // ADD/ADDS/SUB/SUBS (imm): Rn=31 is SP
        markReadInt(rn);
        markWriteInt(rd);
        decoded += 1;
        continue;
      }
      if (op23_25 === 4) {
        // Logical (imm): ORR/AND/EOR/ANDS
        markReadInt(rn);
        markWriteInt(rd);
        decoded += 1;
        continue;
      }
      if (op23_25 === 5) {
        // Move wide (MOVN/MOVZ/MOVK)
        const opc = (w >>> 29) & 0x03;
        if (opc === 3) markReadInt(rd); // MOVK reads destination
        markWriteInt(rd);
        decoded += 1;
        continue;
      }
      if (op23_25 === 6 || op23_25 === 7) {
        // Bitfield / Extract
        markReadInt(rn);
        if (op23_25 === 7) markReadInt(rm);
        markWriteInt(rd);
        decoded += 1;
        continue;
      }
    }
    // 3. Branches: CBZ/CBNZ/TBZ/TBNZ
    if ((op0 & 0x0E) === 0x0A) {
      const top = (w >>> 24) & 0x7F;
      if (top === 0x34 || top === 0x35 || top === 0x36 || top === 0x37) {
        markReadInt(rd);
        decoded += 1;
        continue;
      }
      decoded += 1;
      continue;
    }
    // 4. Loads and Stores
    if ((op0 & 0x05) === 0x04) {
      const isFp = ((w >>> 26) & 1) === 1;
      const op28_29 = (w >>> 28) & 0x03;
      const op23_25 = (w >>> 23) & 0x07;
      // LDP / STP
      if ((op28_29 === 2) && (op23_25 <= 3 || op23_25 === 5)) {
        const isLoad = ((w >>> 22) & 1) === 1;
        const rt2 = (w >>> 10) & 0x1F;
        markReadInt(rn);
        if (isLoad) {
          if (isFp) { markWriteFp(rd); markWriteFp(rt2); }
          else { markWriteInt(rd); markWriteInt(rt2); }
        } else {
          if (isFp) { markReadFp(rd); markReadFp(rt2); }
          else { markReadInt(rd); markReadInt(rt2); }
        }
        decoded += 1;
        continue;
      }
      // LDR/STR (imm/reg/unscaled)
      if (op28_29 === 3) {
        const opc = (w >>> 22) & 0x03;
        const isStore = opc === 0;
        markReadInt(rn);
        if (isStore) {
          if (isFp) markReadFp(rd);
          else markReadInt(rd);
        } else {
          if (isFp) markWriteFp(rd);
          else markWriteInt(rd);
        }
        decoded += 1;
        continue;
      }
    }
    // 5. Data processing - Register
    if ((op0 & 0x07) === 0x05) {
      const op21_24 = (w >>> 21) & 0x0F;
      const op28 = (w >>> 28) & 1;
      if (op28 === 1 && (op21_24 & 0x08) === 0x08) {
        // 3-source (MADD/MSUB/SMADDL/UMADDL)
        markReadInt(rn);
        markReadInt(rm);
        markReadInt(ra);
        markWriteInt(rd);
      } else {
        // Logical, ADD/SUB shifted/extended, CSEL, UDIV/SDIV, LSLV/LSRV/ASRV
        markReadInt(rn);
        markReadInt(rm);
        markWriteInt(rd);
      }
      decoded += 1;
      continue;
    }
    // 6. Scalar FP data processing
    if ((op0 & 0x07) === 0x07 && ((w >>> 24) & 0x1F) === 0x1E) {
      const bit21 = (w >>> 21) & 1;
      const op16_20 = (w >>> 16) & 0x1F;
      const op10_15 = (w >>> 10) & 0x3F;
      if (bit21 === 1 && (op10_15 & 0x03) === 0) {
        // Conversion between FP and Int
        const opcode = (op16_20 >>> 0) & 0x07;
        if (opcode === 2 || opcode === 3 || opcode === 7) {
          // SCVTF / UCVTF / FMOV (gp -> fp)
          markReadInt(rn);
          markWriteFp(rd);
        } else {
          // FCVTZS / FCVTZU / FMOV (fp -> gp)
          markReadFp(rn);
          markWriteInt(rd);
        }
      } else if (bit21 === 1 && (op10_15 & 0x0F) === 0x08) {
        // FCMP
        markReadFp(rn);
        if ((rd & 0x08) === 0) markReadFp(rm);
      } else if (bit21 === 1 && (op10_15 & 0x03) === 0x02) {
        // 2-source FP arithmetic (FADD/FSUB/FMUL/FDIV)
        markReadFp(rn);
        markReadFp(rm);
        markWriteFp(rd);
      } else {
        // 1-source FP (FMOV/FABS/FNEG/FSQRT/FCVT)
        markReadFp(rn);
        markWriteFp(rd);
      }
      decoded += 1;
      continue;
    }
    decoded += 1;
  }

  if (decoded === 0) return null;
  let intCount = 0;
  for (let r = 0; r < 8; r += 1) {
    if ((readInt & (1 << r)) !== 0) intCount = r + 1;
  }
  let fpCount = 0;
  for (let r = 0; r < 8; r += 1) {
    if ((readFp & (1 << r)) !== 0) fpCount = r + 1;
  }
  return { intCount, fpCount };
}

function extractIndirectBranchTableVas(words, baseAddr) {
  if (!words || typeof words.length !== 'number' || words.length === 0) return [];
  let baseAddrBig;
  try {
    baseAddrBig = BigInt(baseAddr ?? 0n);
  } catch {
    return [];
  }
  const prioritized = [];
  const candidates = [];
  const count = words.length >>> 0;
  for (let i = 0; i < count; i += 1) {
    const w = words[i] >>> 0;
    const isBr = ((w & 0xFFFFFC1F) >>> 0) === 0xD61F0000
      || ((w & 0xFFFFF81F) >>> 0) === 0xD61F081F
      || ((w & 0xFFFFF800) >>> 0) === 0xD71F0800;
    if (!isBr) continue;
    const start = Math.max(0, i - 24);
    const adrpPage = new Map();
    const regVa = new Map();
    for (let k = start; k < i; k += 1) {
      const iw = words[k] >>> 0;
      const ipc = baseAddrBig + BigInt(k * 4);
      if (((iw & 0x9F000000) >>> 0) === 0x90000000) {
        const rd = iw & 31;
        const immhi = (iw >>> 5) & 0x7FFFF;
        const immlo = (iw >>> 29) & 3;
        const imm21 = (immhi << 2) | immlo;
        const s21 = (imm21 & 0x100000) !== 0 ? (imm21 - 0x200000) : imm21;
        const page = (ipc & ~0xFFFn) + (BigInt(s21) << 12n);
        adrpPage.set(rd, page);
        regVa.set(rd, page);
      } else if (((iw & 0x9F000000) >>> 0) === 0x10000000) {
        const rd = iw & 31;
        const immhi = (iw >>> 5) & 0x7FFFF;
        const immlo = (iw >>> 29) & 3;
        const imm21 = (immhi << 2) | immlo;
        const s21 = (imm21 & 0x100000) !== 0 ? (imm21 - 0x200000) : imm21;
        const va = ipc + BigInt(s21);
        regVa.set(rd, va);
        candidates.push(va);
      } else if (
        ((iw & 0x1F800000) >>> 0) === 0x11000000
        && ((iw >>> 30) & 1) === 0
        && ((iw >>> 29) & 1) === 0
      ) {
        const rd = iw & 31;
        const rn = (iw >>> 5) & 31;
        const sh = (iw >>> 22) & 1;
        const imm = BigInt(((iw >>> 10) & 0xFFF) << (sh ? 12 : 0));
        if (adrpPage.has(rn)) {
          const va = adrpPage.get(rn) + imm;
          regVa.set(rd, va);
          candidates.push(va);
        }
      } else if (((iw & 0x3B200C00) >>> 0) === 0x38200800 && ((iw >>> 26) & 1) === 0) {
        const rn = (iw >>> 5) & 31;
        if (regVa.has(rn)) {
          prioritized.push(regVa.get(rn));
        }
      }
    }
    for (const va of adrpPage.values()) candidates.push(va);
  }
  const seen = new Set();
  const out = [];
  for (const va of [...prioritized, ...candidates]) {
    const key = va.toString(16);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(va);
    }
  }
  return out;
}

function findRodataSlice({ fileBytes, sections, readBytes, words, baseAddr }) {
  const MAX_RODATA_BYTES = 256 * 1024;
  const targetVas = extractIndirectBranchTableVas(words, baseAddr);
  const elfInfo = parseElf64SectionsAndSyms(fileBytes);
  if (elfInfo && fileBytes instanceof Uint8Array) {
    const buildElfSlice = (sec, focusVa) => {
      if (!sec || sec.type === 8 || sec.size <= 0n || sec.addr <= 0n) return null;
      let baseDelta = 0n;
      if (focusVa != null && Number(sec.size) > MAX_RODATA_BYTES && focusVa > sec.addr) {
        const delta = focusVa - sec.addr;
        baseDelta = delta > 4096n ? ((delta - 4096n) & ~0xFFFn) : 0n;
      }
      const sliceVaLo = sec.addr + baseDelta;
      const off = Number(sec.offset + baseDelta);
      const avail = Number(sec.size - baseDelta);
      const len = Math.min(MAX_RODATA_BYTES, avail, Math.max(0, fileBytes.length - off));
      if (off < 0 || len <= 0) return null;
      const sliceVaHi = sliceVaLo + BigInt(len);
      let sliceBytes = fileBytes.subarray(off, off + len);
      const relocs = elfInfo.relativeRelocs;
      if (Array.isArray(relocs) && relocs.length > 0) {
        let writable = null;
        let sdv = null;
        for (const rel of relocs) {
          if (rel.offset >= sliceVaLo && rel.offset + 8n <= sliceVaHi) {
            if (!writable) {
              writable = new Uint8Array(len);
              writable.set(sliceBytes);
              sdv = new DataView(writable.buffer, writable.byteOffset, writable.byteLength);
            }
            const relOff = Number(rel.offset - sliceVaLo);
            if (relOff >= 0 && relOff + 8 <= len) {
              sdv.setBigUint64(relOff, BigInt.asUintN(64, rel.addend), true);
            }
          }
        }
        if (writable) sliceBytes = writable;
      }
      return { vaLo: sliceVaLo, vaHi: sliceVaHi, bytes: sliceBytes };
    };

    for (const tva of targetVas) {
      const matched = elfInfo.secs.find((s) => s.type !== 8 && s.size > 0n && s.addr > 0n && tva >= s.addr && tva < s.addr + s.size);
      if (matched) {
        const res = buildElfSlice(matched, tva);
        if (res) return res;
      }
    }

    const exact = elfInfo.secs.find((s) => s.name === '.rodata' && s.type !== 8 && s.size > 0n && s.addr > 0n);
    const sec = exact || elfInfo.secs.find((s) => s.name.startsWith('.rodata') && s.type !== 8 && s.size > 0n && s.addr > 0n);
    if (sec) {
      const res = buildElfSlice(sec, null);
      if (res) return res;
    }
  }
  if (Array.isArray(sections)) {
    const readGenericSec = (sec, focusVa) => {
      if (!sec) return null;
      let start, size, foff;
      try {
        start = BigInt(sec.address ?? sec.vmAddr ?? sec.addr ?? 0);
        size = BigInt(sec.size ?? 0);
        foff = sec.fileOffset != null ? BigInt(sec.fileOffset) : (sec.offset != null ? BigInt(sec.offset) : null);
      } catch {
        return null;
      }
      if (size <= 0n || start <= 0n) return null;
      let baseDelta = 0n;
      if (focusVa != null && Number(size) > MAX_RODATA_BYTES && focusVa > start) {
        const delta = focusVa - start;
        baseDelta = delta > 4096n ? ((delta - 4096n) & ~0xFFFn) : 0n;
      }
      const sliceStart = start + baseDelta;
      const take = Math.min(MAX_RODATA_BYTES, Number(size - baseDelta));
      if (fileBytes instanceof Uint8Array && foff != null) {
        const off = Number(foff + baseDelta);
        const len = Math.min(take, Math.max(0, fileBytes.length - off));
        if (off >= 0 && len > 0) {
          return { vaLo: sliceStart, vaHi: sliceStart + BigInt(len), bytes: fileBytes.subarray(off, off + len) };
        }
      }
      if (typeof readBytes === 'function') {
        try {
          const raw = readBytes(sliceStart, take);
          if (raw && raw.length > 0) {
            const u8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
            return { vaLo: sliceStart, vaHi: sliceStart + BigInt(u8.length), bytes: u8 };
          }
        } catch {}
      }
      return null;
    };

    for (const tva of targetVas) {
      const matched = sections.find((s) => {
        if (!s) return false;
        try {
          const start = BigInt(s.address ?? s.vmAddr ?? s.addr ?? 0);
          const size = BigInt(s.size ?? 0);
          return size > 0n && start > 0n && tva >= start && tva < start + size;
        } catch {
          return false;
        }
      });
      if (matched) {
        const res = readGenericSec(matched, tva);
        if (res) return res;
      }
    }

    const priorityNames = ['.rodata', '.data.rel.ro', '__const', '__text'];
    for (const targetName of priorityNames) {
      const sec = sections.find((s) => s && (s.name === targetName || (targetName === '.rodata' && typeof s.name === 'string' && s.name.startsWith('.rodata.'))));
      const res = readGenericSec(sec, null);
      if (res) return res;
    }
  }
  return null;
}

function postprocessWasmGeneralC(text, { baseAddr = 0n, symbolFor, readBytes, fileBytes, sections, allowHelperInlining = true } = {}) {
  const isGeneral = text.includes('/* arguments unknown */') || text.includes('__hex_global_') || text.includes('static uint64 global_') || (typeof symbolFor === 'function' && text.includes('uint64 x0 = '));
  if (!isGeneral) return { text, addedLines: 0, bodyAddedLines: 0, rawSigLine: -1, outerSigLine: -1, hasUnprovenCallArgs: false };

  let out = text;
  const headers = new Set();
  const extraRegs = new Set();
  const extraProtos = new Set();
  let needUintptr = false;
  let needInt64 = false;
  let needUint8 = false;
  let changed = false;
  let hasUnprovenCallArgs = false;
  const elfInfoShared = parseElf64SectionsAndSyms(fileBytes);
  const binaryCtx = { fileBytes, elfInfo: elfInfoShared, sections, readBytes };

  const stripDummyProto = (codeStr, hex) => {
    let res = codeStr;
    const protoLine = `uint64 sub_${hex} (__HEX_ANY_ARGS);\n`;
    if (res.includes(protoLine)) {
      while (res.startsWith(protoLine)) res = res.slice(protoLine.length);
      const nlProto = `\n${protoLine}`;
      while (res.includes(nlProto)) res = res.replaceAll(nlProto, '\n');
    }
    return res;
  };

  // 1. Resolve sub_<HEX> callees against libc/runtime symbols via symbolFor (with varargs format parsing)
  if (typeof symbolFor === 'function' && out.includes('sub_')) {
    const resolvedHexes = new Map();
    const callRe = /sub_([0-9A-Fa-f]+)\(\/\* arguments unknown \*\/\)/g;
    let m;
    while ((m = callRe.exec(out)) !== null) {
      const hex = m[1];
      if (resolvedHexes.has(hex)) continue;
      let rawSym = null;
      try { rawSym = symbolFor(BigInt(`0x${hex}`)); } catch {}
      const norm = normalizeLibcSymbolName(rawSym);
      if (norm) resolvedHexes.set(hex, WASM_GENERAL_LIBC_SPECS[norm]);
    }
    if (resolvedHexes.size > 0) {
      changed = true;
      const outerIsVoid = /^void\s+[A-Za-z_][A-Za-z0-9_]*\(/m.test(out);
      const voidTailRet = outerIsVoid ? 'return;' : 'return 0;';
      for (const [hex, spec] of resolvedHexes.entries()) {
        if (spec.hdr) headers.add(spec.hdr);
        if (Array.isArray(spec.extraHdrs)) {
          for (const eh of spec.extraHdrs) headers.add(eh);
        }
        if (spec.proto) extraProtos.add(spec.proto);
        if (spec.needUintptr) needUintptr = true;
        if (spec.needInt64) needInt64 = true;
        for (const r of spec.regs) extraRegs.add(r);
        out = stripDummyProto(out, hex);

        const bareCall = `sub_${hex}(/* arguments unknown */);`;
        const assignCall = `x0 = ${bareCall}`;
        const retCall = `return ${bareCall}`;

        if (spec.varargs) {
          const va = spec.varargs;
          const outLines = out.split('\n');
          for (let li = 0; li < outLines.length; li += 1) {
            if (!outLines[li].includes(bareCall)) continue;
            const fmt = resolveFormatStringBeforeLine(outLines, li, va.fmtRegIndex, binaryCtx);
            let vaArgs = [];
            if (fmt != null) {
              const parsed = parseFormatSpecifiers(fmt, va.kind, va.fmtRegIndex);
              vaArgs = parsed.args;
              if (parsed.needUintptr) needUintptr = true;
              for (const r of parsed.regs) extraRegs.add(r);
            } else {
              hasUnprovenCallArgs = true;
              const inferred = inferCallerDefinedArgRegs(outLines, li);
              for (let k = va.fmtRegIndex + 1; k < inferred.intCount; k += 1) {
                vaArgs.push(`x${k}`);
                extraRegs.add(`x${k}`);
              }
              for (let f = 0; f < inferred.fpCount; f += 1) {
                vaArgs.push(`d${f}`);
                extraRegs.add(`d${f}`);
              }
            }
            const fullArgs = vaArgs.length > 0 ? `${va.fixedPrefix}, ${vaArgs.join(', ')}` : va.fixedPrefix;
            const callExpr = `${va.retCast}${va.fn}(${fullArgs})`;
            if (outLines[li].includes(assignCall)) {
              outLines[li] = outLines[li].replaceAll(assignCall, `x0 = ${callExpr};`);
            } else if (outLines[li].includes(retCall)) {
              outLines[li] = outLines[li].replaceAll(retCall, `return ${callExpr};`);
            } else {
              outLines[li] = outLines[li].replaceAll(bareCall, `x0 = ${callExpr};`);
            }
          }
          out = outLines.join('\n');
        } else if (spec.ret === 'void') {
          out = out.replaceAll(assignCall, `${spec.call};`);
          out = out.replaceAll(retCall, `${spec.call}; ${voidTailRet}`);
          out = out.replaceAll(bareCall, `${spec.call};`);
        } else if (spec.ret === 'd0') {
          out = out.replaceAll(assignCall, `d0 = ${spec.call};`);
          out = out.replaceAll(retCall, `return ${spec.call};`);
          out = out.replaceAll(bareCall, `d0 = ${spec.call};`);
        } else {
          out = out.replaceAll(assignCall, `x0 = ${spec.call};`);
          out = out.replaceAll(retCall, `return ${spec.call};`);
          out = out.replaceAll(bareCall, `x0 = ${spec.call};`);
        }
      }
    }
  }

  // 1b. Inline-decompile internal .text helper callees (e.g. GCC func0.part.0) via WASM
  const inlinedHelpers = [];
  const helperGlobals = [];
  const globalDeclRe = /^static\s+(?:_Alignas\(\d+\)\s+)?(?:const\s+)?(?:(?:uint64|uint8_t)\s+|char\s*\*\s*)(?:__hex_)?global_([0-9A-Fa-f]+)(_buf)?\b/;
  const globalDefineRe = /^#define\s+global_([0-9A-Fa-f]+)\b/;
  const seenGlobalKind = new Map();
  const seenGlobalDefines = new Set();
  for (const gm of out.matchAll(/^static\s+(?:_Alignas\(\d+\)\s+)?(?:const\s+)?(?:(?:uint64|uint8_t)\s+|char\s*\*\s*)(?:__hex_)?global_([0-9A-Fa-f]+)(_buf)?\b/gm)) {
    const gHex = gm[1].toUpperCase();
    const isBuf = Boolean(gm[2]);
    seenGlobalKind.set(gHex, isBuf ? 'buf' : (seenGlobalKind.get(gHex) || 'scalar'));
  }
  for (const dm of out.matchAll(/^#define\s+global_([0-9A-Fa-f]+)\b/gm)) {
    seenGlobalDefines.add(dm[1].toUpperCase());
  }
  const rewriteHelperCalls = (code, callerRet, helperInfo) => {
    const unknownCall = `sub_${helperInfo.hex}(/* arguments unknown */)`;
    let res = code.replaceAll(`uint64 sub_${helperInfo.hex} (__HEX_ANY_ARGS);\n`, '');
    if (!res.includes(unknownCall)) return { code: res, matched: false };
    if (helperInfo.hRet === 'void') {
      const voidTailRet = callerRet === 'void' ? 'return;' : 'return 0;';
      res = res.replaceAll(`x0 = ${unknownCall};`, `${helperInfo.callExpr};`);
      res = res.replaceAll(`return ${unknownCall};`, `${helperInfo.callExpr}; ${voidTailRet}`);
      res = res.replaceAll(`${unknownCall};`, `${helperInfo.callExpr};`);
    } else if (helperInfo.hRet === 'float' || helperInfo.hRet === 'double') {
      const tailRet = callerRet === 'void' ? `${helperInfo.callExpr}; return;` : `return ${helperInfo.callExpr};`;
      res = res.replaceAll(`x0 = ${unknownCall};`, `d0 = ${helperInfo.callExpr};`);
      res = res.replaceAll(`return ${unknownCall};`, tailRet);
      res = res.replaceAll(`${unknownCall};`, `d0 = ${helperInfo.callExpr};`);
    } else {
      const tailRet = callerRet === 'void' ? `${helperInfo.callExpr}; return;` : `return ${helperInfo.callExpr};`;
      res = res.replaceAll(`x0 = ${unknownCall};`, `x0 = (uint64)${helperInfo.callExpr};`);
      res = res.replaceAll(`return ${unknownCall};`, tailRet);
      res = res.replaceAll(`${unknownCall};`, `${helperInfo.callExpr};`);
    }
    return { code: res, matched: true };
  };
  if (allowHelperInlining && fileBytes instanceof Uint8Array && out.includes('sub_') && out.includes('/* arguments unknown */')) {
    const elfInfo = parseElf64SectionsAndSyms(fileBytes);
    if (elfInfo) {
      const textSec = elfInfo.secs.find((s) => s.name === '.text');
      const unresolvedHexes = new Set();
      const unresRe = /sub_([0-9A-Fa-f]+)\(\/\* arguments unknown \*\/\)/g;
      let um;
      while ((um = unresRe.exec(out)) !== null) unresolvedHexes.add(um[1]);
      let inlinedCount = 0;
      for (const hex of unresolvedHexes) {
        if (inlinedCount >= 32) break;
        const hAddr = BigInt(`0x${hex}`);
        if (hAddr === baseAddr) continue;
        if (!textSec || hAddr < textSec.addr || hAddr >= textSec.addr + textSec.size) continue;
        const off0 = Number(textSec.offset + (hAddr - textSec.addr));
        if (!Number.isSafeInteger(off0) || off0 < 0 || off0 + 8 > fileBytes.length) continue;
        const symSize = elfInfo.syms.get(hAddr) || 0;
        let byteLen = symSize;
        if (byteLen < 4) {
          const maxBytes = Math.min(1024, Number(textSec.addr + textSec.size - hAddr), fileBytes.length - off0);
          const dv = new DataView(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength);
          for (let off = 0; off + 4 <= maxBytes; off += 4) {
            const w = dv.getUint32(off0 + off, true);
            byteLen = off + 4;
            if (w === 0xd65f03c0) break;
          }
        }
        const wordCnt = Math.floor(byteLen / 4);
        if (wordCnt < 2 || wordCnt > 4096) continue;
        if (off0 + wordCnt * 4 > fileBytes.length) continue;
        inlinedCount++;
        const hWords = new Uint32Array(wordCnt);
        const dv = new DataView(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength);
        for (let i = 0; i < wordCnt; i++) hWords[i] = dv.getUint32(off0 + i * 4, true);
        const hRes = wasmDecompileArm64Function({
          words: hWords,
          baseAddr: hAddr,
          funcName: `sub_${hex}`,
          symbolFor,
          readBytes,
          fileBytes,
          sections,
          allowHelperInlining: false,
        });
        if (!hRes || !hRes.pseudocode) continue;
        // Parse helper signature to know arg count & return type
        const sigM = hRes.pseudocode.match(/^(void|int|uint64|float|double)\s+(sub_[0-9A-Fa-f]+)\(([^)]*)\)/m);
        if (!sigM) continue;
        const hRet = sigM[1];
        const hParamsStr = sigM[3].trim();
        const hParams = hParamsStr === 'void' || !hParamsStr ? [] : hParamsStr.split(',').map((s) => s.trim());
        const callArgs = [];
        const callRegs = [];
        let gi = 0, fi = 0;
        for (const hp of hParams) {
          if (hp.startsWith('float ') || hp.startsWith('double ')) {
            callArgs.push(hp.startsWith('float ') ? `(float)d${fi}` : `d${fi}`);
            extraRegs.add(`d${fi}`);
            callRegs.push(`d${fi}`);
            fi++;
          } else if (hp.startsWith('const char *')) {
            callArgs.push(`(const char *)(uintptr_t)x${gi}`);
            needUintptr = true;
            extraRegs.add(`x${gi}`);
            callRegs.push(`x${gi}`);
            gi++;
          } else {
            callArgs.push(`x${gi}`);
            extraRegs.add(`x${gi}`);
            callRegs.push(`x${gi}`);
            gi++;
          }
        }
        if (hRet === 'float' || hRet === 'double') extraRegs.add('d0');
        const callExpr = `sub_${hex}(${callArgs.join(', ')})`;
        const helperInfo = { hex, hRet, hParamsStr, callExpr, callRegs, def: '' };
        changed = true;
        const outerIsVoid = /^void\s+[A-Za-z_][A-Za-z0-9_]*\(/m.test(out);
        out = rewriteHelperCalls(out, outerIsVoid ? 'void' : 'nonvoid', helperInfo).code;
        // If helper expects more integer parameters than the outer function declared (tail-call forwarding), widen outer signature
        if (gi > 0) {
          const outerSigM = out.match(/^(void|int|uint64|float|double) ([A-Za-z_][A-Za-z0-9_]*)\(([^)]*)\)\n\{/m);
          if (outerSigM) {
            const outerParams = outerSigM[3].trim() === 'void' || !outerSigM[3].trim()
              ? []
              : outerSigM[3].split(',').map((s) => s.trim());
            const curIntCnt = outerParams.filter((x) => x.startsWith('uint64 a')).length;
            if (gi > curIntCnt) {
              const fpParams = outerParams.filter((x) => !x.startsWith('uint64 a'));
              const newIntParams = [];
              for (let k = 1; k <= gi; k++) newIntParams.push(`uint64 a${k}`);
              const allP = [...newIntParams, ...fpParams].join(', ');
              out = out.replace(outerSigM[0], `${outerSigM[1]} ${outerSigM[2]}(${allP})\n{`);
              for (let k = curIntCnt; k < gi; k++) {
                out = out.replace(new RegExp(`^    uint64 x${k} = 0;$`, 'm'), `    uint64 x${k} = a${k + 1};`);
                if (!out.includes(`uint64 x${k} `)) {
                  const bi = out.indexOf(')\n{\n');
                  if (bi >= 0) out = out.slice(0, bi + 4) + `    uint64 x${k} = a${k + 1};\n` + out.slice(bi + 4);
                }
              }
            }
          }
        }
        // Strip duplicate includes/typedefs/pragmas from helper body and deduplicate globals by hex address (preferring buffer over scalar)
        const cleanedHelper = hRes.pseudocode.replaceAll(
          '#if defined(__GNUC__) && !defined(__clang__)\n#pragma GCC optimize("no-strict-aliasing")\n#endif\n',
          ''
        );
        const hLines = cleanedHelper.split('\n').filter((line) => {
          if (line.startsWith('#include ')) {
            headers.add(line.slice(9).trim());
            return false;
          }
          if (line.startsWith('#define _GNU_SOURCE') || line.startsWith('#pragma GCC optimize')) return false;
          if (line.startsWith('typedef ') || line.startsWith('/* hex: fixed-width')) return false;
          if (line.startsWith('static inline float __hex_u32_to_f32') || line.startsWith('static inline double __hex_u64_to_f64') || line.startsWith('static inline uint32_t __hex_f32_to_u32') || line.startsWith('static inline uint64_t __hex_f64_to_u64')) return false;
          const gm = line.match(globalDeclRe);
          if (gm) {
            const gHex = gm[1].toUpperCase();
            const isBuf = Boolean(gm[2]);
            const prevKind = seenGlobalKind.get(gHex);
            if (prevKind === 'buf') return false;
            if (prevKind === 'scalar') {
              if (!isBuf) return false;
              // Prefer buffer over scalar: remove earlier scalar declaration from outer and lifted helper globals
              out = out.replace(new RegExp(`^static\\s+uint64\\s+global_${gHex}\\s*=[^;]*;\\n`, 'gim'), '');
              for (let k = helperGlobals.length - 1; k >= 0; k -= 1) {
                if (helperGlobals[k].gHex === gHex) helperGlobals.splice(k, 1);
              }
            }
            seenGlobalKind.set(gHex, isBuf ? 'buf' : 'scalar');
            helperGlobals.push({ gHex, line });
            return false;
          }
          const dm = line.match(globalDefineRe);
          if (dm) {
            const gHex = dm[1].toUpperCase();
            if (seenGlobalDefines.has(gHex)) return false;
            seenGlobalDefines.add(gHex);
            helperGlobals.push({ gHex, line });
            return false;
          }
          return true;
        });
        helperInfo.def = hLines.join('\n').replace(`${hRet} sub_${hex}(`, `static ${hRet} sub_${hex}(`);
        inlinedHelpers.push(helperInfo);
      }
    }
  }

  // 1c. Resolve ALL remaining named & unnamed sub_<HEX>(/* arguments unknown */) calls
  if (out.includes('sub_') && out.includes('/* arguments unknown */')) {
    const remainingHexes = [];
    const seenRem = new Set();
    const remRe = /sub_([0-9A-Fa-f]+)\(\/\* arguments unknown \*\/\)/g;
    let rm;
    while ((rm = remRe.exec(out)) !== null) {
      if (!seenRem.has(rm[1])) {
        seenRem.add(rm[1]);
        remainingHexes.push(rm[1]);
      }
    }
    if (remainingHexes.length > 0) {
      // Collect identifiers already used in this function (locals, params, outer name)
      const usedNames = new Set();
      for (let r = 0; r < 31; r += 1) usedNames.add(`x${r}`);
      for (let r = 0; r < 32; r += 1) usedNames.add(`d${r}`);
      for (let r = 1; r <= 8; r += 1) usedNames.add(`a${r}`);
      const outerSigM = out.match(/^(void|int|uint64|float|double)\s+([A-Za-z_][A-Za-z0-9_]*)\(([^)]*)\)\n\{/m);
      const outerName = outerSigM ? outerSigM[2] : null;
      const isCurrentFuncVoid = /^void\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/m.test(out);
      if (outerName) usedNames.add(outerName);
      for (const lm of out.matchAll(/^\s*(?:uint64|int64_t|uint32_t|int|double|float|uint128|char)\s+\*?([A-Za-z_][A-Za-z0-9_]*)\b/gm)) {
        usedNames.add(lm[1]);
      }

      const outLines = out.split('\n');
      for (const hex of remainingHexes) {
        const callAddr = BigInt(`0x${hex}`);
        const isSelfCall = baseAddr > 0n && callAddr === baseAddr && Boolean(outerName);
        let rawSym = null;
        if (!isSelfCall && typeof symbolFor === 'function') {
          try { rawSym = symbolFor(callAddr); } catch {}
        }
        const cName = isSelfCall
          ? outerName
          : (rawSym ? sanitizeCallSymbolName(rawSym, hex, usedNames) : null);

        // Priority 2: Callee entry ARM64 register-read scan
        let argSpec = null;
        if (isSelfCall && outerSigM) {
          const pStr = outerSigM[3].trim();
          const params = (!pStr || pStr === 'void') ? [] : pStr.split(',').map((s) => s.trim());
          let intCount = 0;
          let fpCount = 0;
          for (const p of params) {
            if (p.startsWith('float ') || p.startsWith('double ')) fpCount += 1;
            else intCount += 1;
          }
          argSpec = { intCount, fpCount, proven: true };
        } else {
          const calleeBytes = readBinaryBytesAt(callAddr, 128, { readBytes, fileBytes, sections });
          const scanned = scanArm64EntryArgRegs(calleeBytes);
          if (scanned) {
            argSpec = { intCount: scanned.intCount, fpCount: scanned.fpCount, proven: true };
          }
        }

        // Priority 3: Caller-side defined argument registers before call site
        if (!argSpec) {
          const bareNeedle = `sub_${hex}(/* arguments unknown */)`;
          let bestInt = 0;
          let bestFp = 0;
          let foundCaller = false;
          for (let li = 0; li < outLines.length; li += 1) {
            if (!outLines[li].includes(bareNeedle)) continue;
            const inferred = inferCallerDefinedArgRegs(outLines, li);
            if (inferred.found) {
              foundCaller = true;
              if (inferred.intCount > bestInt) bestInt = inferred.intCount;
              if (inferred.fpCount > bestFp) bestFp = inferred.fpCount;
            }
          }
          if (foundCaller) {
            argSpec = { intCount: bestInt, fpCount: bestFp, proven: false };
            hasUnprovenCallArgs = true;
          } else if (cName) {
            // Named symbol with no callee bytes and no caller-set regs -> heuristic 0-arg call
            argSpec = { intCount: 0, fpCount: 0, proven: false };
            hasUnprovenCallArgs = true;
          }
        }

        if (!argSpec) continue;

        const targetName = cName || `sub_${hex}`;
        const callArgs = [];
        const paramTypes = [];
        for (let k = 0; k < argSpec.intCount; k += 1) {
          callArgs.push(`x${k}`);
          paramTypes.push('uint64');
          extraRegs.add(`x${k}`);
        }
        for (let f = 0; f < argSpec.fpCount; f += 1) {
          callArgs.push(`d${f}`);
          paramTypes.push('double');
          extraRegs.add(`d${f}`);
        }
        const paramTypesStr = paramTypes.length > 0 ? paramTypes.join(', ') : 'void';
        const callExpr = `${targetName}(${callArgs.join(', ')})`;

        changed = true;
        out = stripDummyProto(out, hex);
        if (!isSelfCall && !STANDARD_C_POSIX_DECLARED.has(targetName)) {
          extraProtos.add(`extern uint64 ${targetName}(${paramTypesStr});`);
        }
        const bareCall = `sub_${hex}(/* arguments unknown */)`;
        if (isSelfCall && isCurrentFuncVoid) {
          out = out.replaceAll(`x0 = ${bareCall};`, `${callExpr};`);
          out = out.replaceAll(`return ${bareCall};`, `${callExpr}; return;`);
          out = out.replaceAll(bareCall, callExpr);
        } else {
          out = out.replaceAll(bareCall, callExpr);
        }
      }
    }
  }

  // 2. Materialize .rodata / __const / .data globals from binary bytes (ELF + Mach-O string pointer tables)
  if ((readBytes || fileBytes) && out.includes('global_')) {
    out = out.replace(/^static (?:_Alignas\(\d+\) )?uint64 __hex_global_([0-9A-Fa-f]+)_buf\[512\] = \{0\};$/gm, (full, hex) => {
      const gAddr = BigInt(`0x${hex}`);
      const bytes = readBinaryBytesAt(gAddr, 256, { readBytes, fileBytes, sections });
      if (!bytes || bytes.length === 0) return full;
      // Check if this is an array of 64-bit pointers to NUL-terminated strings in .rodata / __cstring / __const
      if (bytes.length >= 8) {
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const ptrStrings = [];
        for (let off = 0; off + 8 <= bytes.length; off += 8) {
          const ptrVal = dv.getBigUint64(off, true);
          const strVal = readCStringFromBinary(ptrVal, { ...binaryCtx, escape: true });
          if (strVal == null) break;
          ptrStrings.push(strVal);
        }
        if (ptrStrings.length >= 2) {
          changed = true;
          const items = ptrStrings.map((s) => `"${s}"`).join(', ');
          return `static const char *__hex_global_${hex}_buf[${ptrStrings.length}] = { ${items} };`;
        }
      }
      changed = true;
      needUint8 = true;
      const hexParts = new Array(bytes.length);
      for (let bi = 0; bi < bytes.length; bi += 1) hexParts[bi] = HEX_BYTE_LUT[bytes[bi]];
      const arr = hexParts.join(', ');
      return `static _Alignas(16) uint8_t __hex_global_${hex}_buf[${bytes.length}] = { ${arr} };`;
    });
    out = out.replace(/^static uint64 global_([0-9A-Fa-f]+) = 0;$/gm, (full, hex) => {
      const bytes = readBinaryBytesAt(BigInt(`0x${hex}`), 8, { readBytes, fileBytes, sections });
      if (!bytes || bytes.length === 0) return full;
      changed = true;
      let val = 0n;
      for (let i = Math.min(bytes.length, 8) - 1; i >= 0; i -= 1) {
        val = (val << 8n) | BigInt(bytes[i]);
      }
      return `static uint64 global_${hex} = 0x${val.toString(16).toUpperCase()}ULL;`;
    });
  }

  // Always add <stdbool.h> and <stddef.h> for general-emitter C11 units when symbolFor/readBytes/fileBytes context is active
  if (typeof symbolFor === 'function' || readBytes || fileBytes) {
    headers.add('<stdbool.h>');
    headers.add('<stddef.h>');
    changed = true;
  }

  if (!changed) return { text, addedLines: 0, bodyAddedLines: 0, rawSigLine: -1, outerSigLine: -1, hasUnprovenCallArgs };

  // Inject any missing local reg declarations inside function body `{`
  const missingLocals = [];
  for (const r of extraRegs) {
    if (r.startsWith('x')) {
      if (!new RegExp(`\\buint64 ${r}\\b`).test(out)) { const rIdx = Number(r.slice(1)); const hasParam = Number.isInteger(rIdx) && out.includes(`uint64 a${rIdx + 1}`); missingLocals.push(`    uint64 ${r} = ${hasParam ? `a${rIdx + 1}` : '0'};`); }
    } else if (r.startsWith('d')) {
      if (!new RegExp(`\\bdouble ${r}\\b`).test(out)) missingLocals.push(`    double ${r} = 0.0;`);
    }
  }
  if (missingLocals.length > 0) {
    const braceIdx = out.indexOf(')\n{\n');
    if (braceIdx >= 0) {
      out = out.slice(0, braceIdx + 4) + missingLocals.join('\n') + '\n' + out.slice(braceIdx + 4);
    }
  }

  // Inject any missing typedefs
  const extraTypedefs = [];
  if (needUintptr && !out.includes('typedef __UINTPTR_TYPE__ uintptr_t;')) extraTypedefs.push('typedef __UINTPTR_TYPE__ uintptr_t;');
  if (needInt64 && !out.includes('typedef __INT64_TYPE__ int64_t;')) extraTypedefs.push('typedef __INT64_TYPE__ int64_t;');
  if (needUint8 && !out.includes('typedef __UINT8_TYPE__ uint8_t;')) extraTypedefs.push('typedef __UINT8_TYPE__ uint8_t;');

  // Infer `const char *a1` for single-param `int fn(uint64 a1)` passing initial x0 (directly or via stack spill) to `strlen`
  const singleStrSigM = out.match(/^int ([A-Za-z_][A-Za-z0-9_]*)\(uint64 a1\)\n\{/m);
  if (singleStrSigM && out.includes('strlen((const char *)(uintptr_t)x0)') && out.includes('    uint64 x0 = a1;')) {
    const bodyStart = out.indexOf(singleStrSigM[0]) + singleStrSigM[0].length;
    const strlenPos = out.indexOf('strlen((const char *)(uintptr_t)x0)', bodyStart);
    const lineStart = out.lastIndexOf('\n', strlenPos);
    const beforeStrlen = out.slice(bodyStart, lineStart > bodyStart ? lineStart : bodyStart);
    let isStrArg = !/^    x0 = /m.test(beforeStrlen);
    if (!isStrArg) {
      const firstWriteIdx = beforeStrlen.search(/^    x0 = /m);
      const beforeFirstWrite = firstWriteIdx >= 0 ? beforeStrlen.slice(0, firstWriteIdx) : beforeStrlen;
      const spillM = beforeFirstWrite.match(/^    \*\(uint64 \*\)\(\(uintptr_t\)\(sp\) \+ (\d+)\) = x0;$/m);
      if (spillM) {
        const slotOff = spillM[1];
        const prevLine = beforeStrlen.trimEnd().split('\n').pop() || '';
        if (prevLine === `    x0 = *(uint64 *)((uintptr_t)(sp) + ${slotOff});`) {
          isStrArg = true;
        }
      }
    }
    if (isStrArg) {
      out = out.replace(singleStrSigM[0], `int ${singleStrSigM[1]}(const char *a1)\n{`);
      out = out.replace('    uint64 x0 = a1;', '    uint64 x0 = (uint64)(uintptr_t)a1;');
      needUintptr = true;
      changed = true;
    }
  }

  if (/\b(?:floor|ceil|trunc|round|sqrt|fabs|rint)\s*\(/.test(out)) {
    headers.add('<math.h>');
  }
  if (inlinedHelpers.length > 0) {
    headers.add('<stdint.h>');
  }
  const hdrLines = [];
  if (headers.has('<string.h>')) hdrLines.push('#define _GNU_SOURCE');
  hdrLines.push('#if defined(__GNUC__) && !defined(__clang__)');
  hdrLines.push('#pragma GCC optimize("no-strict-aliasing")');
  hdrLines.push('#endif');
  for (const h of [...headers].sort()) hdrLines.push(`#include ${h}`);
  for (const td of extraTypedefs) hdrLines.push(td);
  if (extraProtos.size > 0 && !extraTypedefs.includes('typedef __UINT64_TYPE__ uint64;') && !hdrLines.includes('typedef __UINT64_TYPE__ uint64;')) {
    const hasUint64Proto = [...extraProtos].some((pr) => /\buint64\b/.test(pr));
    if (hasUint64Proto) {
      // Remove duplicate typedef __UINT64_TYPE__ uint64; from body if present, or emit guard-safe typedef before protos
      out = out.replace(/^typedef __UINT64_TYPE__ uint64;\n/m, '');
      hdrLines.push('typedef __UINT64_TYPE__ uint64;');
    }
  }
  for (const pr of extraProtos) {
    if (!out.includes(pr)) hdrLines.push(pr);
  }
  const prefix = hdrLines.length > 0 ? `${hdrLines.join('\n')}\n` : '';
  if (inlinedHelpers.length > 0) {
    const rewrittenHelperDefs = inlinedHelpers.map((entry) => {
      let body = entry.def;
      const neededHelperRegs = new Set();
      for (const target of inlinedHelpers) {
        const rw = rewriteHelperCalls(body, entry.hRet, target);
        body = rw.code;
        if (rw.matched) {
          for (const r of target.callRegs) neededHelperRegs.add(r);
          if (target.hRet === 'float' || target.hRet === 'double') neededHelperRegs.add('d0');
        }
      }
      if (neededHelperRegs.size > 0) {
        const hMissingLocals = [];
        for (const r of neededHelperRegs) {
          if (r.startsWith('x')) {
            if (!new RegExp(`\\buint64 ${r}\\b`).test(body)) {
              const rIdx = Number(r.slice(1));
              const hasParam = Number.isInteger(rIdx) && body.includes(`uint64 a${rIdx + 1}`);
              hMissingLocals.push(`    uint64 ${r} = ${hasParam ? `a${rIdx + 1}` : '0'};`);
            }
          } else if (r.startsWith('d')) {
            if (!new RegExp(`\\bdouble ${r}\\b`).test(body)) {
              hMissingLocals.push(`    double ${r} = 0.0;`);
            }
          }
        }
        if (hMissingLocals.length > 0) {
          const braceIdx = body.indexOf(')\n{\n');
          if (braceIdx >= 0) {
            body = body.slice(0, braceIdx + 4) + hMissingLocals.join('\n') + '\n' + body.slice(braceIdx + 4);
          }
        }
      }
      return body;
    });
    const forwardProtos = inlinedHelpers
      .map((h) => `static ${h.hRet} sub_${h.hex}(${h.hParamsStr || 'void'});`)
      .join('\n');
    const liftedGlobalsStr = helperGlobals.length > 0
      ? `${helperGlobals.map((g) => g.line).join('\n')}\n`
      : '';
    let hBlock = `${liftedGlobalsStr}${forwardProtos}\n\n${rewrittenHelperDefs.join('\n\n')}\n\n`;
    for (const h of inlinedHelpers) {
      out = out.replaceAll(`uint64 sub_${h.hex} (__HEX_ANY_ARGS);\n`, '');
    }
    if (hBlock.includes('uint128') && !out.includes('typedef unsigned __int128 uint128;')) {
      hBlock = `typedef unsigned __int128 uint128;\n${hBlock}`;
    }
    const fnSigIdx = out.search(/^(?:void|int|uint64|float|double)\s+[A-Za-z_][A-Za-z0-9_]*\([^)]*\)\n\{/m);
    if (fnSigIdx >= 0) {
      out = out.slice(0, fnSigIdx) + hBlock + out.slice(fnSigIdx);
    }
  }
  const finalText = prefix + out;
  const outerSigRe = /^(?:void|int|uint64|float|double)\s+[A-Za-z_][A-Za-z0-9_]*\([^)]*\)$/;
  const rawLinesArr = text.split('\n');
  const finalLinesArr = finalText.split('\n');
  const rawSigLine = rawLinesArr.findIndex((l) => outerSigRe.test(l));
  const finalSigLine = finalLinesArr.findIndex((l) => outerSigRe.test(l));
  const exactAdded = (rawSigLine >= 0 && finalSigLine >= 0) ? Math.max(0, finalSigLine - rawSigLine) : hdrLines.length;
  const bodyAdded = Math.max(0, (finalLinesArr.length - Math.max(0, finalSigLine)) - (rawLinesArr.length - Math.max(0, rawSigLine)));
  return { text: finalText, lines: finalLinesArr, addedLines: exactAdded, bodyAddedLines: bodyAdded, rawSigLine, outerSigLine: finalSigLine, hasUnprovenCallArgs };
}

export function wasmDecompileArm64Function({ words, baseAddr = 0n, funcName = '', insns = null, symbolFor = null, readBytes = null, fileBytes = null, sections = null, allowHelperInlining = true } = {}) {
  if (getEngineMode() === 'js') return noteFallback('decompile', 'wasm_disabled');
  const ex = getHexEngineExportsSafe();
  const hasTextPtr = Boolean(
    ex && (
      typeof ex.hex_engine_decompile_get_text_ptr === 'function'
      || typeof ex.hex_decomp_get_text_ptr === 'function'
    ),
  );
  const hasTextLen = Boolean(
    ex && (
      typeof ex.hex_engine_decompile_get_text_len === 'function'
      || typeof ex.hex_decomp_get_text_len === 'function'
    ),
  );
  if (
    !isWasmBulkMemorySupported()
    || !ex
    || typeof ex.hex_engine_decompile_arm64 !== 'function'
    || !hasTextPtr
    || !hasTextLen
  ) {
    return noteFallback('decompile', 'wasm_unavailable');
  }
  if (!words || typeof words.length !== 'number' || words.length === 0) {
    return noteFallback('decompile', 'empty_words');
  }

  const count = words.length >>> 0;
  const checkStrictTinyFilter = count <= 3;
  for (let i = 0; i < count; i += 1) {
    const w = words[i];
    if (typeof w !== 'number' || !Number.isFinite(w)) {
      return noteFallback('decompile', 'invalid_word');
    }
    if (checkStrictTinyFilter) {
      const reason = classifyUnsupportedArm64Insn(w >>> 0, insns ? insns[i] : null);
      if (reason) return noteFallback('decompile', reason);
    }
  }

  try {
    resetEngineScratch(ex);
    const wordsPtr = allocEngineScratch(ex, count * 4);
    if (!wordsPtr) return noteFallback('decompile', 'oom');
    {
      const wordsView = new Uint32Array(ex.memory.buffer, wordsPtr, count);
      for (let i = 0; i < count; i += 1) wordsView[i] = words[i] >>> 0;
    }

    let namePtr = 0;
    let nameLen = 0;
    const rawName = typeof funcName === 'string' ? funcName : '';
    let nameStr = '';
    if (rawName.startsWith('-[') || rawName.startsWith('+[')) {
      nameStr = rawName;
    } else if (rawName.length > 0) {
      nameStr = rawName.replace(/^_+/, '').replace(/[^A-Za-z0-9_]/g, '_');
      if (nameStr.length === 0) {
        return noteFallback('decompile', 'unsupported_symbol_name');
      }
      if (/^[0-9]/.test(nameStr)) {
        nameStr = `fn_${nameStr}`;
      }
    }
    if (nameStr.length > 0) {
      const nameBytes = textEncoder.encode(nameStr);
      nameLen = nameBytes.length;
      namePtr = allocEngineScratch(ex, nameLen + 1);
      if (!namePtr) return noteFallback('decompile', 'oom');
      const memView = new Uint8Array(ex.memory.buffer, namePtr, nameLen + 1);
      memView.set(nameBytes, 0);
      memView[nameLen] = 0;
    }

    const freshWordsView = new Uint32Array(ex.memory.buffer, wordsPtr, count);
    let hasIndirectBranch = false;
    for (let i = 0; i < count; i += 1) {
      const w = freshWordsView[i];
      if (
        ((w & 0xFFFFFC1F) >>> 0) === 0xD61F0000
        || ((w & 0xFFFFF81F) >>> 0) === 0xD61F081F
        || ((w & 0xFFFFF800) >>> 0) === 0xD71F0800
      ) {
        hasIndirectBranch = true;
        break;
      }
    }
    let rodataSet = false;
    if (hasIndirectBranch && typeof ex.hex_engine_decompile_set_rodata_slice === 'function') {
      const roSlice = findRodataSlice({ fileBytes, sections, readBytes, words: freshWordsView, baseAddr });
      if (roSlice && roSlice.bytes.length > 0) {
        const roPtr = allocEngineScratch(ex, roSlice.bytes.length);
        if (roPtr) {
          new Uint8Array(ex.memory.buffer, roPtr, roSlice.bytes.length).set(roSlice.bytes);
          const roVa = BigInt(roSlice.vaLo);
          const roVaLo = Number(roVa & 0xFFFFFFFFn) >>> 0;
          const roVaHi = Number((roVa >> 32n) & 0xFFFFFFFFn) >>> 0;
          ex.hex_engine_decompile_set_rodata_slice(roVaLo, roVaHi, roPtr, roSlice.bytes.length);
          rodataSet = true;
        }
      }
    }

    let status;
    try {
      status = ex.hex_engine_decompile_arm64(
        wordsPtr,
        count,
        BigInt(baseAddr),
        namePtr,
        nameLen,
        HEX_EMIT_FLAG_JS_PARITY,
      );
    } finally {
      if (rodataSet && typeof ex.hex_engine_decompile_clear_rodata_slice === 'function') {
        ex.hex_engine_decompile_clear_rodata_slice();
      }
    }
    if (status !== HEX_OK) {
      return noteFallback('decompile', `wasm_status_${status}`);
    }
    const rawLossFlags = typeof ex.hex_engine_decompile_get_loss_flags === 'function'
      ? ((ex.hex_engine_decompile_get_loss_flags() ?? 0) >>> 0)
      : 0;

    const getTP = ex.hex_engine_decompile_get_text_ptr || ex.hex_decomp_get_text_ptr;
    const getTL = ex.hex_engine_decompile_get_text_len || ex.hex_decomp_get_text_len;
    const textPtr = getTP();
    const textLen = getTL();
    if (!textPtr || !textLen) {
      return noteFallback('decompile', 'empty_wasm_output');
    }

    const mem = ex.memory.buffer;
    const rawPseudocode = textDecoder.decode(new Uint8Array(mem, textPtr, textLen));
    const extractedLm = [];
    const getLP = typeof ex.hex_engine_decompile_get_linemap_ptr === 'function'
      ? ex.hex_engine_decompile_get_linemap_ptr
      : ex.hex_decomp_get_linemap_ptr;
    const getLC = typeof ex.hex_engine_decompile_get_linemap_count === 'function'
      ? ex.hex_engine_decompile_get_linemap_count
      : ex.hex_decomp_get_linemap_count;
    if (typeof getLP === 'function' && typeof getLC === 'function') {
      const lmPtr = getLP();
      const lmCount = getLC();
      if (lmPtr && lmCount > 0) {
        const dv = new DataView(mem);
        for (let i = 0; i < lmCount; i += 1) {
          const off = lmPtr + i * SIZEOF_HEX_LINEMAP_ENTRY;
          extractedLm.push({ lineNo: dv.getUint32(off, true), address: dv.getBigUint64(off + 8, true) });
        }
      }
    }

    const post = postprocessWasmGeneralC(rawPseudocode, { baseAddr: BigInt(baseAddr), symbolFor, readBytes, fileBytes, sections, allowHelperInlining });
    const pseudocode = post.text;
    if ((rawName.startsWith('-[') || rawName.startsWith('+[')) && !pseudocode.includes('typedef void * id;')) {
      return noteFallback('decompile', 'unsupported_objc_name');
    }

    const rawLinemap = new Map();
    const bodyThreshold = post.rawSigLine >= 0 ? (post.rawSigLine + 2) : Infinity;
    for (let i = 0; i < extractedLm.length; i += 1) {
      const rawLineNo = extractedLm[i].lineNo;
      const lineNo = rawLineNo + post.addedLines + (rawLineNo > bodyThreshold ? (post.bodyAddedLines || 0) : 0);
      const address = extractedLm[i].address;
      let set = rawLinemap.get(lineNo);
      if (!set) {
        set = new Set();
        rawLinemap.set(lineNo, set);
      }
      set.add(address);
    }

    const rawLines = post.lines || pseudocode.split('\n');
    const legacyRawRegDeclRe = /^\s*(?:u?int(?:8|16|32|64|128)(?:_t)?|float|double)\s+[xw]\d+;/;
    const hasGeneralQDecl = rawLines.some((l) => /^\s*uint128\s+q\d+\s*=\s*0;/.test(l));
    const isLegacyOutput = !hasGeneralQDecl && rawLines.some((l) => (
      l.includes('// … ほかに ')
      || l.includes('*(uint128 *)')
      || l.includes('__builtin_trap();   // ここに来たら異常')
      || legacyRawRegDeclRe.test(l)
    ));
    const baseAddrBig = BigInt(baseAddr);
    let addrToRow = null;
    if (Array.isArray(insns)) {
      addrToRow = new Map();
      for (let i = 0; i < insns.length; i += 1) {
        if (insns[i]?.address != null) addrToRow.set(BigInt(insns[i].address), i);
      }
    }
    const lookupRow = addrToRow
      ? (addr) => addrToRow.get(addr)
      : (addr) => {
          if (typeof addr !== 'bigint' || addr < baseAddrBig) return undefined;
          const delta = addr - baseAddrBig;
          if ((delta & 3n) !== 0n) return undefined;
          const row = Number(delta >> 2n);
          return row < count ? row : undefined;
        };

    const bodyDeclRe = /^(?:const\s+)?(?:u?int(?:8|16|32|64|128)(?:_t)?|float|double|vector128|void\s*\*|id|int|unsigned\s+int|long|char)\s+\*?[A-Za-z_]\w*(?:\s*\[[^\]]*\])?(?:\s*,\s*\*?[A-Za-z_]\w*(?:\s*\[[^\]]*\])?)*(?:\s*=\s*[^;]+)?\s*;$/;
    const synthAssignRe = /^x\d+\s*=\s*a\d+;$/;

    const lines = [];
    const sourceMap = [];
    let bodyLineNo = 0;
    let seenSig = false;
    for (let idx = 0; idx < rawLines.length; idx += 1) {
      const text = rawLines[idx];
      const trimmed = text.trimStart();
      const indent = trimmed.length === 0 ? 0 : Math.floor((text.length - trimmed.length) / 4);
      const isPrelude = !seenSig && (
        trimmed.startsWith('/*')
        || trimmed.startsWith('typedef ')
        || trimmed.startsWith('#')
        || trimmed.startsWith('static ')
        || trimmed.startsWith('extern ')
        || trimmed.endsWith(';')
        || (post.outerSigLine > 0 && idx < post.outerSigLine)
      );
      let kind;
      if (isPrelude) {
        kind = 'decl';
      } else if (!seenSig) {
        kind = 'sig';
        seenSig = true;
      } else if (trimmed.length === 0) {
        kind = 'blank';
      } else if (
        trimmed === '{' || trimmed === '}' || trimmed.startsWith('if ')
        || trimmed.startsWith('if(') || trimmed.startsWith('while ')
        || trimmed.startsWith('while(') || trimmed.startsWith('} else')
        || trimmed.startsWith('else') || trimmed === 'continue;'
        || trimmed === 'break;' || trimmed.startsWith('goto ')
        || trimmed.startsWith('do ') || trimmed === 'do {'
        || (isLegacyOutput && (trimmed === 'return;' || trimmed.startsWith('return ') || trimmed.startsWith('__builtin_trap()')))
      ) {
        kind = 'ctrl';
      } else if (trimmed.startsWith('//') || trimmed.startsWith('/*')) {
        kind = 'comment';
      } else if (
        trimmed.charCodeAt(trimmed.length - 1) === 59
        && (
          trimmed.charCodeAt(0) === 99
          || trimmed.charCodeAt(0) === 117
          || trimmed.charCodeAt(0) === 105
          || trimmed.charCodeAt(0) === 102
          || trimmed.charCodeAt(0) === 100
          || trimmed.charCodeAt(0) === 118
          || trimmed.charCodeAt(0) === 108
        )
        && bodyDeclRe.test(trimmed)
      ) {
        kind = 'decl';
      } else {
        kind = 'stmt';
      }

      const mappedSet = rawLinemap.get(idx + 1);
      const mappedAddrs = mappedSet ? Array.from(mappedSet) : [];
      const isBraceOrElse = kind === 'ctrl' && (
        trimmed === '{' || trimmed === '}' || trimmed === '} else {' || trimmed === 'else {'
      );
      const isSynthLegacyAssign = isLegacyOutput && kind === 'stmt' && synthAssignRe.test(trimmed);

      let firstAddr;
      let lineAddresses;
      if (isLegacyOutput) {
        if (isPrelude || kind === 'decl' || kind === 'comment' || kind === 'blank' || isBraceOrElse || isSynthLegacyAssign) {
          firstAddr = null;
        } else if (kind === 'sig') {
          firstAddr = baseAddrBig;
        } else {
          firstAddr = mappedAddrs[0] ?? null;
        }
        if (isPrelude) {
          lineAddresses = [baseAddrBig];
        } else if (kind === 'decl') {
          lineAddresses = /\bvar_/.test(trimmed) ? [] : [baseAddrBig];
        } else {
          lineAddresses = [];
        }
      } else {
        firstAddr = isPrelude || kind === 'decl' || kind === 'comment' || kind === 'blank' || isBraceOrElse
          ? null
          : (kind === 'sig' ? baseAddrBig : (mappedAddrs[0] ?? null));
        lineAddresses = isPrelude || kind === 'sig'
          ? [baseAddrBig]
          : kind === 'decl'
            ? (mappedAddrs.length > 0 ? mappedAddrs.slice() : [])
            : (kind === 'comment' || kind === 'blank' || isBraceOrElse)
              ? []
              : mappedAddrs.slice();
      }
      const lineRows = lineAddresses
        .map(lookupRow)
        .filter((r) => r !== undefined);
      lines.push({
        kind,
        indent,
        text: trimmed,
        row: firstAddr != null ? (lookupRow(firstAddr) ?? null) : null,
        addr: firstAddr,
        address: firstAddr,
        source: { addresses: lineAddresses, rows: lineRows },
        note: null,
      });

      if (!isLegacyOutput && !isPrelude && !(kind === 'decl' && !/^uint64\s+x\d+\s*=\s*a[1-8];$/.test(trimmed) && /\b(?:local_|var_|call_|self\b|a[1-8]\b)/.test(trimmed))) {
        bodyLineNo += 1;
        const foldedExtra = (kind === 'stmt' && /^\*\([^)]+\)\(.*\)\s*[-+]=\s*/.test(trimmed)) ? 2 : 0;
        const addresses = kind === 'sig'
          ? [baseAddrBig]
          : kind === 'decl'
            ? (mappedAddrs.length > 0 ? mappedAddrs.slice() : [])
            : (kind === 'comment' || kind === 'blank' || isBraceOrElse)
              ? []
              : mappedAddrs.slice();
        const rows = addresses
          .map(lookupRow)
          .filter((r) => r !== undefined);
        sourceMap.push({
          outputStartLine: bodyLineNo,
          outputEndLine: bodyLineNo + foldedExtra,
          source: {
            addresses,
            rows,
            ir: [],
            ssaDefs: [],
            ssaUses: [],
            evidence: [],
          },
          kind,
        });
        bodyLineNo += foldedExtra;
      }
    }

    const lossReasonSet = new Set();
    let lossFlags = 0;
    const hasUnknownCallArgs = pseudocode.includes('/* arguments unknown */') || post.hasUnprovenCallArgs === true;
    const hasUnresolvedIndirectBranch = pseudocode.includes('/* unresolved indirect branch');
    if ((rawLossFlags & 1) !== 0 || hasUnresolvedIndirectBranch) {
      lossFlags |= 1;
      lossReasonSet.add('unresolved-indirect-branch');
    }
    if ((rawLossFlags & 2) !== 0 || hasUnknownCallArgs) {
      lossFlags |= 2;
      lossReasonSet.add('unknown-call-arguments');
    }
    if ((rawLossFlags & 4) !== 0) {
      lossFlags |= 4;
      lossReasonSet.add('dropped-tail-call');
    }
    if ((rawLossFlags & 8) !== 0) {
      lossFlags |= 8;
      lossReasonSet.add('unsupported-instruction');
    }
    if ((rawLossFlags & 16) !== 0) {
      lossFlags |= 16;
      lossReasonSet.add('unresolved-indirect-call');
    }
    const lossReasons = Array.from(lossReasonSet);
    const partial = lossReasons.length > 0;
    const completeness = partial ? 'partial' : 'complete';

    recordWasmCall('decompile');
    return isLegacyOutput
      ? { pseudocode, lines, sourceMap: undefined, lossFlags, lossReasons, partial, completeness }
      : { pseudocode, lines, sourceMap, lossFlags, lossReasons, partial, completeness };
  } catch {
    return noteFallback('decompile', 'wasm_exception');
  }
}

// ---------------------------------------------------------------------------
// Shared Engine Scratch + Decompiler Output Helpers (Wave 8)
// ---------------------------------------------------------------------------
function allocEngineScratch(ex, bytes) {
  if (typeof ex.hex_engine_scratch_alloc === 'function') return ex.hex_engine_scratch_alloc(bytes);
  return allocScratch(ex, bytes);
}

function resetEngineScratch(ex) {
  if (typeof ex.hex_engine_scratch_reset === 'function') ex.hex_engine_scratch_reset();
  else resetScratch(ex);
}

function normalizeDecompileSymbolName(funcName, domain) {
  const rawName = typeof funcName === 'string' ? funcName : '';
  if (rawName.startsWith('-[') || rawName.startsWith('+[')) {
    return { ok: false, reason: 'unsupported_objc_name', name: '' };
  }
  if (rawName.length === 0) {
    return { ok: true, reason: null, name: '' };
  }
  const nameStr = rawName.replace(/^_+/, '').replace(/[^A-Za-z0-9_]/g, '_');
  if (nameStr.length === 0 || /^[0-9]/.test(nameStr)) {
    return { ok: false, reason: 'unsupported_symbol_name', name: '' };
  }
  return { ok: true, reason: null, name: nameStr, domain };
}

function readDecompileLinemap(mem, lmPtr, lmCount) {
  const rawLinemap = new Map();
  if (lmPtr && lmCount > 0) {
    const dv = new DataView(mem);
    for (let i = 0; i < lmCount; i += 1) {
      const off = lmPtr + i * SIZEOF_HEX_LINEMAP_ENTRY;
      const lineNo = dv.getUint32(off, true);
      const address = dv.getBigUint64(off + 8, true);
      let set = rawLinemap.get(lineNo);
      if (!set) {
        set = new Set();
        rawLinemap.set(lineNo, set);
      }
      set.add(address);
    }
  }
  return rawLinemap;
}

function buildDecompiledLinesAndSourceMap(pseudocode, rawLinemap, baseAddrBig, addrToRow) {
  const rawLines = pseudocode.split('\n');
  const lines = [];
  const sourceMap = [];
  let bodyLineNo = 0;
  let seenSig = false;
  for (let idx = 0; idx < rawLines.length; idx += 1) {
    const text = rawLines[idx];
    const trimmed = text.trimStart();
    const indent = Math.floor((text.length - trimmed.length) / 4);
    const isPrelude = !seenSig && (trimmed.startsWith('/*') || trimmed.startsWith('typedef ') || trimmed.startsWith('#'));
    let kind;
    if (isPrelude) {
      kind = 'decl';
    } else if (!seenSig) {
      kind = 'sig';
      seenSig = true;
    } else if (
      trimmed === '{' || trimmed === '}' || trimmed.startsWith('if ')
      || trimmed.startsWith('while ') || trimmed.startsWith('} else')
    ) {
      kind = 'ctrl';
    } else {
      kind = 'stmt';
    }

    const mappedEntry = rawLinemap.get(idx + 1);
    const mappedAddrs = mappedEntry ? (Array.isArray(mappedEntry) ? mappedEntry : Array.from(mappedEntry)) : [];
    const firstAddr = isPrelude || kind === 'decl' ? null : (kind === 'sig' ? baseAddrBig : (mappedAddrs[0] ?? null));
    const lineAddresses = isPrelude || kind === 'sig'
      ? [baseAddrBig]
      : (kind === 'ctrl' && (trimmed === '{' || trimmed === '}'))
        ? []
        : mappedAddrs.slice();
    const lineRows = lineAddresses
      .map((a) => addrToRow.get(a))
      .filter((r) => r !== undefined);
    lines.push({
      kind,
      indent,
      text: trimmed,
      row: firstAddr != null ? (addrToRow.get(firstAddr) ?? null) : null,
      addr: firstAddr,
      address: firstAddr,
      source: { addresses: lineAddresses, rows: lineRows },
      note: null,
    });

    if (!isPrelude) {
      bodyLineNo += 1;
      const addresses = kind === 'sig'
        ? [baseAddrBig]
        : (kind === 'ctrl' && (trimmed === '{' || trimmed === '}'))
          ? []
          : mappedAddrs.slice();
      const rows = addresses
        .map((a) => addrToRow.get(a))
        .filter((r) => r !== undefined);
      sourceMap.push({
        outputStartLine: bodyLineNo,
        outputEndLine: bodyLineNo,
        source: {
          addresses,
          rows,
          ir: [],
          ssaDefs: [],
          ssaUses: [],
          evidence: [],
        },
        kind,
      });
    }
  }
  return { lines, sourceMap };
}

// ---------------------------------------------------------------------------
// x86_64 Decompiler WASM Bridge (Wave 8)
// ---------------------------------------------------------------------------
function resolveX86_64AbiId(abiId, abi) {
  const parseHint = (v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'number' && Number.isFinite(v)) return (v >>> 0) === 1 ? 1 : 0;
    const norm = String(v).trim().toLowerCase();
    if (norm === '') return null;
    if (norm === '1') return 1;
    if (norm === '0') return 0;
    if (
      norm === 'microsoft-x64'
      || norm === 'microsoft-vectorcall'
      || norm === 'win64'
      || norm === 'ms64'
      || norm === 'windows'
      || norm === 'pe'
    ) {
      return 1;
    }
    return 0;
  };
  const fromId = parseHint(abiId);
  if (fromId != null) return fromId;
  const fromAbi = parseHint(abi);
  return fromAbi != null ? fromAbi : 0;
}

const X86_64_DECOMPILE_MAX_BYTES = 32768;

export function wasmDecompileX86_64Function({
  bytes,
  baseAddr = 0n,
  funcName = '',
  abiId = null,
  abi = null,
  insns = null,
  _engine = null,
} = {}) {
  if (getEngineMode({ _engine }) === 'js') return noteFallback('x86_64_decompile', 'wasm_disabled');
  const ex = getHexEngineExportsSafe({ _engine });
  if (
    !isWasmBulkMemorySupported()
    || !ex
    || typeof ex.hex_engine_decompile_x86_64 !== 'function'
    || typeof ex.hex_x86_64_decomp_get_text_ptr !== 'function'
    || typeof ex.hex_x86_64_decomp_get_text_len !== 'function'
  ) {
    return noteFallback('x86_64_decompile', 'wasm_unavailable');
  }
  if (!(bytes instanceof Uint8Array)) {
    return noteFallback('x86_64_decompile', 'invalid_bytes');
  }
  if (bytes.length === 0) {
    return noteFallback('x86_64_decompile', 'empty_bytes');
  }
  if (bytes.length > X86_64_DECOMPILE_MAX_BYTES) {
    return noteFallback('x86_64_decompile', 'too_large');
  }

  const norm = normalizeDecompileSymbolName(funcName, 'x86_64_decompile');
  if (!norm.ok) {
    return noteFallback('x86_64_decompile', norm.reason);
  }

  const resolvedAbiId = resolveX86_64AbiId(abiId, abi);

  try {
    resetEngineScratch(ex);
    const bytesPtr = allocEngineScratch(ex, bytes.length);
    if (!bytesPtr) return noteFallback('x86_64_decompile', 'oom');
    new Uint8Array(ex.memory.buffer, bytesPtr, bytes.length).set(bytes);

    let namePtr = 0;
    let nameLen = 0;
    if (norm.name.length > 0) {
      const nameBytes = textEncoder.encode(norm.name);
      nameLen = nameBytes.length;
      namePtr = allocEngineScratch(ex, nameLen + 1);
      if (!namePtr) return noteFallback('x86_64_decompile', 'oom');
      const memView = new Uint8Array(ex.memory.buffer, namePtr, nameLen + 1);
      memView.set(nameBytes, 0);
      memView[nameLen] = 0;
    }

    const baseAddrBig = BigInt(baseAddr);
    const status = ex.hex_engine_decompile_x86_64(
      bytesPtr,
      bytes.length,
      baseAddrBig,
      namePtr,
      nameLen,
      resolvedAbiId,
      HEX_EMIT_FLAG_JS_PARITY,
    );
    if (status !== HEX_OK) {
      return noteFallback('x86_64_decompile', `wasm_status_${status}`);
    }

    const textPtr = ex.hex_x86_64_decomp_get_text_ptr();
    const textLen = ex.hex_x86_64_decomp_get_text_len();
    if (!textPtr || !textLen) {
      return noteFallback('x86_64_decompile', 'empty_wasm_output');
    }

    const mem = ex.memory.buffer;
    const pseudocode = textDecoder.decode(new Uint8Array(mem, textPtr, textLen));

    const rawLinemap = (
      typeof ex.hex_x86_64_decomp_get_linemap_ptr === 'function'
      && typeof ex.hex_x86_64_decomp_get_linemap_count === 'function'
    )
      ? readDecompileLinemap(
        mem,
        ex.hex_x86_64_decomp_get_linemap_ptr(),
        ex.hex_x86_64_decomp_get_linemap_count(),
      )
      : new Map();

    const addrToRow = new Map();
    if (Array.isArray(insns)) {
      for (let i = 0; i < insns.length; i += 1) {
        if (insns[i]?.address != null) addrToRow.set(BigInt(insns[i].address), i);
      }
    }

    const { lines, sourceMap } = buildDecompiledLinesAndSourceMap(
      pseudocode,
      rawLinemap,
      baseAddrBig,
      addrToRow,
    );

    recordWasmCall('x86_64_decompile');
    return { pseudocode, lines, sourceMap };
  } catch {
    return noteFallback('x86_64_decompile', 'wasm_exception');
  }
}

// ---------------------------------------------------------------------------
// x86_64 Semantic Decompiler WASM Bridge (Wave 12)
// ---------------------------------------------------------------------------
export function wasmDecompileX86_64SemanticFunction({
  bytes,
  baseAddr = 0n,
  abiId = 0,
  insns = null,
  _engine = null,
} = {}) {
  if (getEngineMode({ _engine }) === 'js') return noteFallback('x86_64_decompile', 'wasm_disabled');
  const ex = getHexEngineExportsSafe({ _engine });
  const getTextPtr = ex && typeof ex.hex_x86_64_semantic_get_text_ptr === 'function'
    ? ex.hex_x86_64_semantic_get_text_ptr
    : ex?.hex_x86_64_decomp_get_text_ptr;
  const getTextLen = ex && typeof ex.hex_x86_64_semantic_get_text_len === 'function'
    ? ex.hex_x86_64_semantic_get_text_len
    : ex?.hex_x86_64_decomp_get_text_len;
  if (
    !isWasmBulkMemorySupported()
    || !ex
    || typeof ex.hex_engine_decompile_x86_64_semantic !== 'function'
    || typeof getTextPtr !== 'function'
    || typeof getTextLen !== 'function'
  ) {
    return noteFallback('x86_64_decompile', 'wasm_unavailable');
  }
  if (!(bytes instanceof Uint8Array)) {
    return noteFallback('x86_64_decompile', 'invalid_bytes');
  }
  if (bytes.length === 0) {
    return noteFallback('x86_64_decompile', 'empty_bytes');
  }

  try {
    resetEngineScratch(ex);
    const bytesPtr = allocEngineScratch(ex, bytes.length);
    if (!bytesPtr) return noteFallback('x86_64_decompile', 'oom');
    new Uint8Array(ex.memory.buffer, bytesPtr, bytes.length).set(bytes);

    const baseAddrBig = BigInt(baseAddr);
    const status = ex.hex_engine_decompile_x86_64_semantic(
      bytesPtr,
      bytes.length,
      baseAddrBig,
      abiId >>> 0,
    );
    if (status !== HEX_OK) {
      return noteFallback('x86_64_decompile', `wasm_status_${status}`);
    }

    const textPtr = getTextPtr();
    const textLen = getTextLen();
    if (!textPtr || !textLen) {
      return noteFallback('x86_64_decompile', 'empty_wasm_output');
    }

    const mem = ex.memory.buffer;
    const pseudocode = textDecoder.decode(new Uint8Array(mem, textPtr, textLen));

    const getLinemapPtr = typeof ex.hex_x86_64_semantic_get_linemap_ptr === 'function'
      ? ex.hex_x86_64_semantic_get_linemap_ptr
      : ex.hex_x86_64_decomp_get_linemap_ptr;
    const getLinemapCount = typeof ex.hex_x86_64_semantic_get_linemap_count === 'function'
      ? ex.hex_x86_64_semantic_get_linemap_count
      : ex.hex_x86_64_decomp_get_linemap_count;
    const rawLinemap = (
      typeof getLinemapPtr === 'function'
      && typeof getLinemapCount === 'function'
    )
      ? readDecompileLinemap(mem, getLinemapPtr(), getLinemapCount())
      : new Map();

    const addrToRow = new Map();
    if (Array.isArray(insns)) {
      for (let i = 0; i < insns.length; i += 1) {
        if (insns[i]?.address != null) addrToRow.set(BigInt(insns[i].address), i);
      }
    }

    const { lines, sourceMap } = buildDecompiledLinesAndSourceMap(
      pseudocode,
      rawLinemap,
      baseAddrBig,
      addrToRow,
    );

    recordWasmCall('x86_64_decompile');
    return { pseudocode, lines, sourceMap };
  } catch {
    return noteFallback('x86_64_decompile', 'wasm_exception');
  }
}

// ---------------------------------------------------------------------------
// Resident IR + SSA Optimizer WASM Bridge (Wave 8)
// ---------------------------------------------------------------------------
export function wasmRunResidentIrAndOptimize({
  blocks,
  edges = [],
  insts = [],
  entryBlock = 0,
  maxIters = 16,
} = {}) {
  if (getEngineMode() === 'js') return noteFallback('resident_ir', 'wasm_disabled');
  const ex = getHexEngineExportsSafe();
  if (
    !isWasmBulkMemorySupported()
    || !ex
    || typeof ex.hex_ir_create !== 'function'
    || typeof ex.hex_ir_release !== 'function'
    || typeof ex.hex_ir_add_block !== 'function'
    || typeof ex.hex_ir_add_edge !== 'function'
    || typeof ex.hex_ir_add_inst !== 'function'
    || typeof ex.hex_ir_run_cfg_and_ssa !== 'function'
    || typeof ex.hex_ir_get_stats !== 'function'
    || typeof ex.hex_decomp_optimize_ir !== 'function'
  ) {
    return noteFallback('resident_ir', 'wasm_unavailable');
  }

  const blockCount = typeof blocks === 'number'
    ? (blocks >>> 0)
    : (Array.isArray(blocks) ? blocks.length : 0);
  if (blockCount === 0) {
    return noteFallback('resident_ir', 'empty_blocks');
  }
  const edgeList = Array.isArray(edges) ? edges : [];
  const instList = Array.isArray(insts) ? insts : [];

  let handle = 0;
  try {
    resetEngineScratch(ex);
    const outHandlePtr = allocEngineScratch(ex, 8);
    const outIdPtr = allocEngineScratch(ex, 8);
    const outChangedPtr = allocEngineScratch(ex, 8);
    const outStatsPtr = allocEngineScratch(ex, SIZEOF_HEX_IR_STATS);
    if (!outHandlePtr || !outIdPtr || !outChangedPtr || !outStatsPtr) {
      return noteFallback('resident_ir', 'oom');
    }

    const createStatus = ex.hex_ir_create(entryBlock >>> 0, outHandlePtr);
    if (createStatus !== HEX_OK) {
      return noteFallback('resident_ir', `create_status_${createStatus}`);
    }
    handle = new DataView(ex.memory.buffer).getUint32(outHandlePtr, true);
    if (!handle) {
      return noteFallback('resident_ir', 'invalid_handle');
    }

    for (let i = 0; i < blockCount; i += 1) {
      const st = ex.hex_ir_add_block(handle, outIdPtr);
      if (st !== HEX_OK) return noteFallback('resident_ir', `add_block_status_${st}`);
    }

    for (let i = 0; i < edgeList.length; i += 1) {
      const e = edgeList[i];
      const from = Array.isArray(e) ? e[0] : (e?.from ?? e?.fromBlock ?? e?.from_block);
      const to = Array.isArray(e) ? e[1] : (e?.to ?? e?.toBlock ?? e?.to_block);
      const st = ex.hex_ir_add_edge(handle, from >>> 0, to >>> 0);
      if (st !== HEX_OK) return noteFallback('resident_ir', `add_edge_status_${st}`);
    }

    for (let i = 0; i < instList.length; i += 1) {
      const ins = instList[i];
      const blockId = (ins?.blockId ?? ins?.block_id ?? ins?.block ?? 0) >>> 0;
      const op = (ins?.op ?? 0) & 0xffff;
      const flags = (ins?.flags ?? 0) & 0xffff;
      const dstVal = (ins?.dstVal ?? ins?.dst_val ?? ins?.dst ?? HEX_IR_NONE) >>> 0;
      const arg0 = (ins?.arg0 ?? HEX_IR_NONE) >>> 0;
      const arg1 = (ins?.arg1 ?? HEX_IR_NONE) >>> 0;
      const arg2 = (ins?.arg2 ?? HEX_IR_NONE) >>> 0;
      const imm = BigInt(ins?.imm64 ?? ins?.imm64_or_sym ?? ins?.imm ?? 0n);
      const st = ex.hex_ir_add_inst(handle, blockId, op, flags, dstVal, arg0, arg1, arg2, imm, outIdPtr);
      if (st !== HEX_OK) return noteFallback('resident_ir', `add_inst_status_${st}`);
    }

    const ssaStatus = ex.hex_ir_run_cfg_and_ssa(handle);
    if (ssaStatus !== HEX_OK) {
      return noteFallback('resident_ir', `ssa_status_${ssaStatus}`);
    }

    const optStatus = ex.hex_decomp_optimize_ir(handle, maxIters >>> 0, outChangedPtr);
    if (optStatus !== HEX_OK) {
      return noteFallback('ir_optimizer', `opt_status_${optStatus}`);
    }
    const changedCount = new DataView(ex.memory.buffer).getUint32(outChangedPtr, true);

    const statsStatus = ex.hex_ir_get_stats(handle, outStatsPtr);
    if (statsStatus !== HEX_OK) {
      return noteFallback('resident_ir', `stats_status_${statsStatus}`);
    }
    const dv = new DataView(ex.memory.buffer, outStatsPtr, SIZEOF_HEX_IR_STATS);
    const stats = {
      blockCount: dv.getUint32(0, true),
      edgeCount: dv.getUint32(4, true),
      instCount: dv.getUint32(8, true),
      valueCount: dv.getUint32(12, true),
      phiCount: dv.getUint32(16, true),
      useCount: dv.getUint32(20, true),
      reachableBlockCount: dv.getUint32(24, true),
      sccCount: dv.getUint32(28, true),
      cfgReady: dv.getUint8(32) !== 0,
      ssaReady: dv.getUint8(33) !== 0,
      memssaReady: dv.getUint8(34) !== 0,
      digestLo64: dv.getBigUint64(40, true),
      digestHi64: dv.getBigUint64(48, true),
    };

    recordWasmCall('resident_ir');
    recordWasmCall('ir_optimizer');
    return { stats, changedCount };
  } catch {
    return noteFallback('resident_ir', 'wasm_exception');
  } finally {
    if (handle) {
      try {
        ex.hex_ir_release(handle);
      } catch {
        // Ignore cleanup failure
      }
    }
  }
}

// ---------------------------------------------------------------------------
// RISC-V 64 Decode API (Wave 8 pre-wired)
// ---------------------------------------------------------------------------
export function wasmDecodeRiscv64Batch(bytes, basePc = 0n) {
  if (getEngineMode() === 'js') return noteFallback('riscv64_decode', 'wasm_disabled');
  if (!(bytes instanceof Uint8Array)) return noteFallback('riscv64_decode', 'invalid_bytes');
  const ex = getHexEngineExportsSafe();
  if (!isWasmBulkMemorySupported() || !ex || typeof ex.hex_riscv64_decode_batch !== 'function') {
    return noteFallback('riscv64_decode', 'wasm_unavailable');
  }
  if (bytes.length === 0) {
    return [];
  }
  try {
    const CHUNK_BYTES = 4096;
    const basePcBig = BigInt(basePc);
    const out = [];
    let offset = 0;
    while (offset < bytes.length) {
      const chunkLen = Math.min(CHUNK_BYTES, bytes.length - offset);
      const maxInsns = Math.ceil(chunkLen / 2);
      resetEngineScratch(ex);
      const inPtr = allocEngineScratch(ex, chunkLen);
      const outPtr = allocEngineScratch(ex, maxInsns * SIZEOF_HEX_RISCV64_DECODED);
      if (!inPtr || !outPtr) return noteFallback('riscv64_decode', 'oom');
      new Uint8Array(ex.memory.buffer, inPtr, chunkLen).set(bytes.subarray(offset, offset + chunkLen));
      const count = ex.hex_riscv64_decode_batch(inPtr, chunkLen, basePcBig + BigInt(offset), outPtr, maxInsns) >>> 0;
      const mem = ex.memory.buffer;
      let consumed = 0;
      for (let i = 0; i < count; i += 1) {
        const base = outPtr + i * SIZEOF_HEX_RISCV64_DECODED;
        const dv = new DataView(mem, base, SIZEOF_HEX_RISCV64_DECODED);
        const ilen = dv.getUint8(28);
        out.push({
          pc: dv.getBigUint64(0, true),
          target: dv.getBigUint64(8, true),
          imm: dv.getBigInt64(16, true),
          raw: dv.getUint32(24, true),
          length: ilen,
          kind: dv.getUint8(29),
          rd: dv.getUint8(34),
          rs1: dv.getUint8(35),
          rs2: dv.getUint8(36),
          valid: dv.getUint8(41) !== 0,
          mn: readCString(mem, base + 42, 16),
        });
        consumed += ilen;
      }
      if (consumed === 0 || count === 0) break;
      offset += consumed;
    }
    recordWasmCall('riscv64_decode');
    return out;
  } catch {
    return noteFallback('riscv64_decode', 'wasm_exception');
  }
}

// ---------------------------------------------------------------------------
// Wave 13: String Scanner & Byte Search WASM Bridges
// ---------------------------------------------------------------------------
const STRING_SCAN_MAX_SPANS = 65536;
const STRING_SCAN_ARENA_BUDGET = 1_500_000;
const STRING_SCAN_CHUNK_BYTES = 524288;
const STRING_SCAN_MIN_CHUNK_BYTES = 16384;
const STRING_SCAN_ENCODINGS = Object.freeze(['utf8', 'utf16le', 'utf16be']);
const BYTE_SEARCH_CHUNK_BYTES = 262144;
const BYTE_SEARCH_NOT_FOUND = 0xffffffff;

function runChunkedWasmStringScan(ex, bytes, ranges, {
  minLength,
  maxLength,
  limit,
  utf8,
  utf16le,
  utf16be,
  flags,
}) {
  const bytesLen = bytes.length;
  if (bytesLen > 0xffffffff) return noteFallback('strings', 'input_too_large');
  const normalizedRanges = new Array(ranges.length);
  let prevEnd = 0;
  for (let i = 0; i < ranges.length; i += 1) {
    const r = ranges[i];
    if (!r || typeof r !== 'object') return noteFallback('strings', 'invalid_range');
    const startNum = Number(r.start ?? 0);
    const endNum = r.size != null ? startNum + Number(r.size) : Number(r.end ?? startNum);
    if (!Number.isFinite(startNum) || !Number.isFinite(endNum) || startNum < 0 || endNum < startNum) {
      return noteFallback('strings', 'invalid_range');
    }
    const start = Math.min(bytesLen, Math.floor(startNum));
    const end = Math.min(bytesLen, Math.floor(endNum));
    if (i > 0 && start < prevEnd) {
      return noteFallback('strings', 'overlapping_large_ranges');
    }
    prevEnd = end;
    normalizedRanges[i] = { start, end, idx: i };
  }

  const encFlagsList = [];
  if (utf8) encFlagsList.push(1);
  if (utf16le) encFlagsList.push(2);
  if (utf16be) encFlagsList.push(4);

  const chunks = [];
  let totalSpans = 0;
  try {
    for (let ri = 0; ri < normalizedRanges.length && totalSpans < limit; ri += 1) {
      const { start: rStart, end: rEnd, idx: rangeIdx } = normalizedRanges[ri];
      if (rEnd <= rStart) continue;
      const needSplit = (rEnd - rStart) > STRING_SCAN_CHUNK_BYTES;
      const needParityFix = (rStart & 1) !== 0 && (flags & 6) !== 0;
      const passes = (needSplit || needParityFix || encFlagsList.length > 1) ? encFlagsList : [flags];

      for (let pi = 0; pi < passes.length && totalSpans < limit; pi += 1) {
        const passFlags = passes[pi];
        const isUtf16Pass = (passFlags & 6) !== 0;
        const splitUtf16Parity = isUtf16Pass;
        const evenChunks = splitUtf16Parity ? [] : null;
        const oddChunks = splitUtf16Parity ? [] : null;
        let evenCount = 0;
        let pos = rStart;
        let attemptChunkBytes = STRING_SCAN_CHUNK_BYTES;
        while (pos < rEnd && (splitUtf16Parity ? (totalSpans + evenCount < limit) : (totalSpans < limit))) {
          let cut = Math.min(rEnd, pos + attemptChunkBytes);
          if (cut < rEnd) {
            if (isUtf16Pass) {
              // Ensure 2-byte alignment relative to rStart AND require 4 consecutive NULs so both
              // parity 0 and parity 1 UTF-16 code units terminate cleanly before cut.
              if (((cut - rStart) & 1) !== 0) cut -= 1;
              let found = -1;
              const maxC = cut + 1 < rEnd ? cut : cut - 2;
              for (let c = maxC; c >= pos + 4; c -= 2) {
                if (bytes[c - 2] === 0 && bytes[c - 1] === 0 && bytes[c] === 0 && bytes[c + 1] === 0) {
                  found = c;
                  break;
                }
              }
              if (found >= 0) {
                cut = found;
              } else {
                return noteFallback('strings', 'chunk_no_boundary');
              }
            } else {
              let found = -1;
              for (let c = cut; c >= pos + 4; c -= 1) {
                const b = bytes[c - 1];
                if (b === 0 || (b !== 9 && (b < 0x20 || b === 0x7f)) || b === 0xc0 || b === 0xc1 || b >= 0xf5) {
                  found = c;
                  break;
                }
              }
              if (found >= 0) {
                cut = found;
              } else {
                return noteFallback('strings', 'chunk_no_boundary');
              }
            }
          }
          const chunkLen = cut - pos;
          const remainingLimit = splitUtf16Parity
            ? Math.max(1, limit - totalSpans)
            : (limit - totalSpans);
          // When splitting UTF-16 parity across chunks, allow up to full chunk capacity so
          // odd spans from earlier chunks cannot crowd out even spans inside a single chunk.
          const maxWanted = splitUtf16Parity ? STRING_SCAN_MAX_SPANS : remainingLimit;
          let chunkSpanCap = Math.min(
            maxWanted,
            STRING_SCAN_MAX_SPANS,
            Math.floor((STRING_SCAN_ARENA_BUDGET - chunkLen - 16 - 256) / 16),
          );
          if (chunkSpanCap < 1) return noteFallback('strings', 'input_too_large');

          ex.hex_identity_reset();
          const bytesPtr = ex.hex_identity_alloc(chunkLen);
          const rangesPtr = ex.hex_identity_alloc(16);
          const outCountPtr = ex.hex_identity_alloc(4);
          if (!bytesPtr || !rangesPtr || !outCountPtr) return noteFallback('strings', 'oom');
          let outSpansPtr = ex.hex_identity_alloc(chunkSpanCap * 16);
          while (!outSpansPtr && chunkSpanCap > 1) {
            chunkSpanCap = chunkSpanCap >>> 1;
            outSpansPtr = ex.hex_identity_alloc(chunkSpanCap * 16);
          }
          if (!outSpansPtr) return noteFallback('strings', 'oom');

          new Uint8Array(ex.memory.buffer, bytesPtr, chunkLen).set(bytes.subarray(pos, cut));
          const rdv = new DataView(ex.memory.buffer, rangesPtr, 16);
          rdv.setUint32(0, 0, true);
          rdv.setUint32(4, chunkLen >>> 0, true);
          rdv.setUint32(8, rangeIdx >>> 0, true);
          rdv.setUint32(12, 0, true);

          const status = ex.hex_string_scan_ranges(
            bytesPtr,
            chunkLen >>> 0,
            rangesPtr,
            1,
            minLength >>> 0,
            maxLength >>> 0,
            passFlags >>> 0,
            chunkSpanCap >>> 0,
            outSpansPtr,
            outCountPtr,
          );
          if (status !== HEX_OK) return noteFallback('strings', `wasm_status_${status}`);

          const mem = ex.memory.buffer;
          const outCount = new DataView(mem).getUint32(outCountPtr, true);
          if (outCount > chunkSpanCap) return noteFallback('strings', 'invalid_out_count');
          if (outCount === chunkSpanCap && (splitUtf16Parity || chunkSpanCap < remainingLimit)) {
            if (chunkLen > STRING_SCAN_MIN_CHUNK_BYTES) {
              attemptChunkBytes = Math.max(STRING_SCAN_MIN_CHUNK_BYTES, chunkLen >>> 1);
              continue;
            }
            return noteFallback('strings', 'span_cap_reached');
          }

          if (outCount > 0) {
            const src = new Uint32Array(mem, outSpansPtr, outCount * 4);
            if (splitUtf16Parity) {
              let eLen = 0;
              let oLen = 0;
              for (let k = 0; k < outCount * 4; k += 4) {
                if (((src[k] + pos) & 1) === 0) eLen += 1;
                else oLen += 1;
              }
              const eArr = eLen > 0 ? new Uint32Array(eLen * 4) : null;
              const oArr = oLen > 0 ? new Uint32Array(oLen * 4) : null;
              let ei = 0;
              let oi = 0;
              for (let k = 0; k < outCount * 4; k += 4) {
                const absOff = src[k] + pos;
                if ((absOff & 1) === 0) {
                  eArr[ei++] = absOff;
                  eArr[ei++] = src[k + 1];
                  eArr[ei++] = src[k + 2];
                  eArr[ei++] = src[k + 3];
                } else {
                  oArr[oi++] = absOff;
                  oArr[oi++] = src[k + 1];
                  oArr[oi++] = src[k + 2];
                  oArr[oi++] = src[k + 3];
                }
              }
              if (eArr) { evenChunks.push(eArr); evenCount += eLen; }
              if (oArr) { oddChunks.push(oArr); }
            } else {
              const flatChunk = new Uint32Array(outCount * 4);
              for (let k = 0; k < outCount * 4; k += 4) {
                flatChunk[k] = src[k] + pos;
                flatChunk[k + 1] = src[k + 1];
                flatChunk[k + 2] = src[k + 2];
                flatChunk[k + 3] = src[k + 3];
              }
              chunks.push(flatChunk);
              totalSpans += outCount;
            }
          }
          pos = cut;
          attemptChunkBytes = STRING_SCAN_CHUNK_BYTES;
        }
        if (splitUtf16Parity) {
          for (let ci = 0; ci < evenChunks.length && totalSpans < limit; ci += 1) {
            const arr = evenChunks[ci];
            const avail = arr.length >>> 2;
            const take = Math.min(avail, limit - totalSpans);
            chunks.push(take === avail ? arr : arr.subarray(0, take * 4));
            totalSpans += take;
          }
          for (let ci = 0; ci < oddChunks.length && totalSpans < limit; ci += 1) {
            const arr = oddChunks[ci];
            const avail = arr.length >>> 2;
            const take = Math.min(avail, limit - totalSpans);
            chunks.push(take === avail ? arr : arr.subarray(0, take * 4));
            totalSpans += take;
          }
        }
      }
    }

    const combined = new Uint32Array(totalSpans * 4);
    let writeOff = 0;
    for (let i = 0; i < chunks.length; i += 1) {
      combined.set(chunks[i], writeOff);
      writeOff += chunks[i].length;
    }
    recordWasmCall('strings');
    return combined;
  } catch {
    return noteFallback('strings', 'wasm_exception');
  }
}

export function wasmScanStringsFlat(bytes, ranges, opts = {}) {
  if (getEngineMode(opts) === 'js') return noteFallback('strings', 'wasm_disabled');
  const ex = getHexEngineExportsSafe(opts);
  if (
    !isWasmBulkMemorySupported()
    || !ex
    || typeof ex.hex_string_scan_ranges !== 'function'
    || typeof ex.hex_identity_alloc !== 'function'
    || typeof ex.hex_identity_reset !== 'function'
  ) {
    return noteFallback('strings', 'wasm_unavailable');
  }
  if (!(bytes instanceof Uint8Array)) return noteFallback('strings', 'invalid_bytes');
  if (!Array.isArray(ranges)) return noteFallback('strings', 'invalid_ranges');

  const rawMinLength = Number(opts?.minLength ?? 4);
  const rawMaxLength = Number(opts?.maxLength ?? 256);
  if (!Number.isFinite(rawMinLength) || !Number.isFinite(rawMaxLength) || rawMinLength > 0xffffffff || rawMaxLength > 0xffffffff) {
    return noteFallback('strings', 'invalid_length');
  }
  const minLength = Math.max(1, Math.floor(rawMinLength));
  const maxLength = Math.max(minLength, Math.floor(rawMaxLength));
  const rawLimit = opts?.limit == null ? STRING_SCAN_MAX_SPANS : Number(opts.limit);
  if (!Number.isFinite(rawLimit) || rawLimit < 0) return noteFallback('strings', 'invalid_limit');
  const limit = Math.floor(rawLimit);

  const utf8 = opts?.utf8 !== false;
  const utf16le = Boolean(opts?.utf16le);
  const utf16be = Boolean(opts?.utf16be);
  const flags = (utf8 ? 1 : 0) | (utf16le ? 2 : 0) | (utf16be ? 4 : 0);

  if (ranges.length === 0 || limit === 0 || bytes.length === 0 || flags === 0) {
    recordWasmCall('strings');
    return new Uint32Array(0);
  }

  const bytesLen = bytes.length;
  const rangeBytes = ranges.length * 16;
  let spanCap = Math.min(
    limit,
    STRING_SCAN_MAX_SPANS,
    Math.floor((STRING_SCAN_ARENA_BUDGET - bytesLen - rangeBytes - 256) / 16),
  );
  if (spanCap < 1) {
    return runChunkedWasmStringScan(ex, bytes, ranges, {
      minLength,
      maxLength,
      limit,
      utf8,
      utf16le,
      utf16be,
      flags,
    });
  }

  try {
    ex.hex_identity_reset();
    const bytesPtr = ex.hex_identity_alloc(bytesLen);
    const rangesPtr = ex.hex_identity_alloc(rangeBytes);
    const outCountPtr = ex.hex_identity_alloc(4);
    if (!bytesPtr || !rangesPtr || !outCountPtr) {
      return noteFallback('strings', 'oom');
    }
    let outSpansPtr = ex.hex_identity_alloc(spanCap * 16);
    while (!outSpansPtr && spanCap > 1) {
      spanCap = spanCap >>> 1;
      outSpansPtr = ex.hex_identity_alloc(spanCap * 16);
    }
    if (!outSpansPtr) {
      return noteFallback('strings', 'oom');
    }

    new Uint8Array(ex.memory.buffer, bytesPtr, bytesLen).set(bytes);
    const rdv = new DataView(ex.memory.buffer, rangesPtr, rangeBytes);
    for (let i = 0; i < ranges.length; i += 1) {
      const r = ranges[i];
      if (!r || typeof r !== 'object') return noteFallback('strings', 'invalid_range');
      const startNum = Number(r.start ?? 0);
      const endNum = r.size != null ? startNum + Number(r.size) : Number(r.end ?? startNum);
      if (!Number.isFinite(startNum) || !Number.isFinite(endNum) || startNum < 0 || endNum < startNum) {
        return noteFallback('strings', 'invalid_range');
      }
      const start = Math.min(bytesLen, Math.floor(startNum)) >>> 0;
      const end = Math.min(bytesLen, Math.floor(endNum)) >>> 0;
      const off = i * 16;
      rdv.setUint32(off, start, true);
      rdv.setUint32(off + 4, end, true);
      rdv.setUint32(off + 8, i >>> 0, true);
      rdv.setUint32(off + 12, 0, true);
    }

    const status = ex.hex_string_scan_ranges(
      bytesPtr,
      bytesLen >>> 0,
      rangesPtr,
      ranges.length >>> 0,
      minLength >>> 0,
      maxLength >>> 0,
      flags >>> 0,
      spanCap >>> 0,
      outSpansPtr,
      outCountPtr,
    );
    if (status !== HEX_OK) {
      return noteFallback('strings', `wasm_status_${status}`);
    }

    const mem = ex.memory.buffer;
    const outCount = new DataView(mem).getUint32(outCountPtr, true);
    if (outCount > spanCap) return noteFallback('strings', 'invalid_out_count');
    if (outCount === spanCap && spanCap < limit) {
      return runChunkedWasmStringScan(ex, bytes, ranges, {
        minLength,
        maxLength,
        limit,
        utf8,
        utf16le,
        utf16be,
        flags,
      });
    }

    if (outCount === 0) {
      recordWasmCall('strings');
      return new Uint32Array(0);
    }

    const flat = new Uint32Array(outCount * 4);
    if ((outSpansPtr & 3) === 0) {
      flat.set(new Uint32Array(mem, outSpansPtr, outCount * 4));
    } else {
      const sdv = new DataView(mem, outSpansPtr, outCount * 16);
      for (let i = 0; i < outCount; i += 1) {
        const off = i * 16;
        const base = i * 4;
        flat[base] = sdv.getUint32(off, true);
        flat[base + 1] = sdv.getUint32(off + 4, true);
        flat[base + 2] = sdv.getUint32(off + 8, true);
        flat[base + 3] = sdv.getUint32(off + 12, true);
      }
    }
    recordWasmCall('strings');
    return flat;
  } catch {
    return noteFallback('strings', 'wasm_exception');
  }
}

export function wasmScanStrings(bytes, ranges, opts = {}) {
  const flat = wasmScanStringsFlat(bytes, ranges, opts);
  if (flat === null) return null;
  const outCount = flat.length >>> 2;
  const out = new Array(outCount);
  for (let i = 0; i < outCount; i += 1) {
    const base = i * 4;
    out[i] = {
      fileOffset: flat[base],
      byteLength: flat[base + 1],
      encoding: STRING_SCAN_ENCODINGS[flat[base + 2]] || 'utf8',
      rangeIdx: flat[base + 3],
    };
  }
  return out;
}

export function wasmByteSearchFind(haystack, fromOffset, pattern, masks, foldAscii, opts = {}) {
  if (getEngineMode(opts) === 'js') return noteFallback('byte_search', 'wasm_disabled');
  const ex = getHexEngineExportsSafe(opts);
  if (
    !isWasmBulkMemorySupported()
    || !ex
    || typeof ex.hex_byte_search_find !== 'function'
    || typeof ex.hex_identity_alloc !== 'function'
    || typeof ex.hex_identity_reset !== 'function'
  ) {
    return noteFallback('byte_search', 'wasm_unavailable');
  }
  if (!(haystack instanceof Uint8Array)) return noteFallback('byte_search', 'invalid_haystack');
  if (!(pattern instanceof Uint8Array) || pattern.length < 1 || pattern.length > 4096) {
    return noteFallback('byte_search', 'invalid_pattern');
  }
  if (masks != null && (!(masks instanceof Uint8Array) || masks.length < pattern.length)) {
    return noteFallback('byte_search', 'invalid_masks');
  }

  let start = Number(fromOffset ?? 0);
  if (!Number.isFinite(start)) return noteFallback('byte_search', 'invalid_offset');
  start = start < 0 ? 0 : Math.floor(start);

  const patLen = pattern.length;
  if (start + patLen > haystack.length) {
    recordWasmCall('byte_search');
    return -1;
  }

  const overlap = patLen - 1;
  const flags = (foldAscii ? 1 : 0) | (!foldAscii && masks ? 2 : 0);

  try {
    let chunkStart = start;
    while (chunkStart + patLen <= haystack.length) {
      const chunkLen = Math.min(BYTE_SEARCH_CHUNK_BYTES, haystack.length - chunkStart);
      ex.hex_identity_reset();
      const chunkPtr = ex.hex_identity_alloc(chunkLen);
      const patPtr = ex.hex_identity_alloc(patLen);
      const maskPtr = masks ? ex.hex_identity_alloc(patLen) : 0;
      const outPtr = ex.hex_identity_alloc(4);
      if (!chunkPtr || !patPtr || (masks && !maskPtr) || !outPtr) {
        return noteFallback('byte_search', 'oom');
      }

      const memBytes = new Uint8Array(ex.memory.buffer);
      memBytes.set(haystack.subarray(chunkStart, chunkStart + chunkLen), chunkPtr);
      memBytes.set(pattern, patPtr);
      if (masks) memBytes.set(masks.subarray(0, patLen), maskPtr);

      const status = ex.hex_byte_search_find(
        chunkPtr,
        chunkLen >>> 0,
        0,
        patPtr,
        maskPtr,
        patLen >>> 0,
        flags >>> 0,
        outPtr,
      );
      if (status !== HEX_OK) {
        return noteFallback('byte_search', `wasm_status_${status}`);
      }

      const match = new DataView(ex.memory.buffer).getUint32(outPtr, true);
      if (match !== BYTE_SEARCH_NOT_FOUND) {
        recordWasmCall('byte_search');
        return chunkStart + match;
      }

      if (chunkLen <= overlap) break;
      chunkStart += chunkLen - overlap;
    }

    recordWasmCall('byte_search');
    return -1;
  } catch {
    return noteFallback('byte_search', 'wasm_exception');
  }
}

// ---------------------------------------------------------------------------
// SHA-256 WASM Bridge (Wave 14)
// ---------------------------------------------------------------------------
const SHA256_MAX_CHUNK_BLOCKS = 16384;
const SHA256_MAX_HASH_BYTES = 1048576;

export function wasmSha256CompressBlocks(stateU32, bytes, offset, blockCount, opts = {}) {
  if (getEngineMode(opts) === 'js') {
    noteFallback('sha256', 'wasm_disabled');
    return false;
  }
  const ex = getHexEngineExportsSafe(opts);
  if (
    !isWasmBulkMemorySupported()
    || !ex
    || typeof ex.hex_sha256_compress_blocks !== 'function'
    || typeof ex.hex_identity_alloc !== 'function'
    || typeof ex.hex_identity_reset !== 'function'
  ) {
    noteFallback('sha256', 'wasm_unavailable');
    return false;
  }
  if (!(stateU32 instanceof Uint32Array) || stateU32.length !== 8) {
    noteFallback('sha256', 'invalid_state');
    return false;
  }
  if (!(bytes instanceof Uint8Array)) {
    noteFallback('sha256', 'invalid_bytes');
    return false;
  }
  if (
    !Number.isSafeInteger(offset)
    || offset < 0
    || !Number.isSafeInteger(blockCount)
    || blockCount < 0
    || offset + blockCount * 64 > bytes.length
  ) {
    noteFallback('sha256', 'invalid_range');
    return false;
  }
  if (blockCount === 0) {
    recordWasmCall('sha256');
    return true;
  }

  try {
    const tmpState = new Uint32Array(stateU32);
    let remaining = blockCount;
    let curOff = offset;

    while (remaining > 0) {
      const chunkBlocks = Math.min(SHA256_MAX_CHUNK_BLOCKS, remaining);
      const chunkBytes = chunkBlocks * 64;

      ex.hex_identity_reset();
      const statePtr = ex.hex_identity_alloc(32);
      const blocksPtr = ex.hex_identity_alloc(chunkBytes);
      if (!statePtr || !blocksPtr) {
        noteFallback('sha256', 'oom');
        return false;
      }

      new Uint32Array(ex.memory.buffer, statePtr, 8).set(tmpState);
      new Uint8Array(ex.memory.buffer, blocksPtr, chunkBytes).set(
        bytes.subarray(curOff, curOff + chunkBytes),
      );

      const status = ex.hex_sha256_compress_blocks(statePtr, blocksPtr, chunkBlocks >>> 0);
      if (status !== HEX_OK) {
        noteFallback('sha256', `wasm_status_${status}`);
        return false;
      }

      tmpState.set(new Uint32Array(ex.memory.buffer, statePtr, 8));
      curOff += chunkBytes;
      remaining -= chunkBlocks;
    }

    stateU32.set(tmpState);
    recordWasmCall('sha256');
    return true;
  } catch {
    noteFallback('sha256', 'wasm_exception');
    return false;
  }
}

export function wasmSha256Hash(bytes, opts = {}) {
  if (getEngineMode(opts) === 'js') return noteFallback('sha256', 'wasm_disabled');
  const ex = getHexEngineExportsSafe(opts);
  if (
    !isWasmBulkMemorySupported()
    || !ex
    || typeof ex.hex_sha256_hash !== 'function'
    || typeof ex.hex_identity_alloc !== 'function'
    || typeof ex.hex_identity_reset !== 'function'
  ) {
    return noteFallback('sha256', 'wasm_unavailable');
  }
  if (!(bytes instanceof Uint8Array)) {
    return noteFallback('sha256', 'invalid_bytes');
  }
  if (bytes.length > SHA256_MAX_HASH_BYTES) {
    if (typeof ex.hex_sha256_compress_blocks !== 'function') {
      return noteFallback('sha256', 'input_too_large');
    }

    try {
      const state = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
      ]);
      const fullBlocks = Math.floor(bytes.length / 64);
      let remaining = fullBlocks;
      let curOff = 0;

      while (remaining > 0) {
        const chunkBlocks = Math.min(SHA256_MAX_CHUNK_BLOCKS, remaining);
        const chunkBytes = chunkBlocks * 64;

        ex.hex_identity_reset();
        const statePtr = ex.hex_identity_alloc(32);
        const blocksPtr = ex.hex_identity_alloc(chunkBytes);
        if (!statePtr || !blocksPtr) {
          return noteFallback('sha256', 'oom');
        }

        new Uint32Array(ex.memory.buffer, statePtr, 8).set(state);
        new Uint8Array(ex.memory.buffer, blocksPtr, chunkBytes).set(
          bytes.subarray(curOff, curOff + chunkBytes),
        );

        const status = ex.hex_sha256_compress_blocks(statePtr, blocksPtr, chunkBlocks >>> 0);
        if (status !== HEX_OK) {
          return noteFallback('sha256', `wasm_status_${status}`);
        }

        state.set(new Uint32Array(ex.memory.buffer, statePtr, 8));
        curOff += chunkBytes;
        remaining -= chunkBlocks;
      }

      const rem = bytes.length % 64;
      const tailBlocks = rem >= 56 ? 2 : 1;
      const tailLen = tailBlocks * 64;
      const tail = new Uint8Array(tailLen);
      if (rem > 0) {
        tail.set(bytes.subarray(curOff));
      }
      tail[rem] = 0x80;
      const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
      tailView.setBigUint64(tailLen - 8, BigInt(bytes.length) * 8n, false);

      ex.hex_identity_reset();
      const statePtr = ex.hex_identity_alloc(32);
      const tailPtr = ex.hex_identity_alloc(tailLen);
      if (!statePtr || !tailPtr) {
        return noteFallback('sha256', 'oom');
      }

      new Uint32Array(ex.memory.buffer, statePtr, 8).set(state);
      new Uint8Array(ex.memory.buffer, tailPtr, tailLen).set(tail);

      const status = ex.hex_sha256_compress_blocks(statePtr, tailPtr, tailBlocks >>> 0);
      if (status !== HEX_OK) {
        return noteFallback('sha256', `wasm_status_${status}`);
      }

      state.set(new Uint32Array(ex.memory.buffer, statePtr, 8));

      const out = new Uint8Array(32);
      const outView = new DataView(out.buffer);
      for (let i = 0; i < 8; i += 1) {
        outView.setUint32(i * 4, state[i], false);
      }
      recordWasmCall('sha256');
      return out;
    } catch {
      return noteFallback('sha256', 'wasm_exception');
    }
  }

  try {
    ex.hex_identity_reset();
    const len = bytes.length;
    const dataPtr = len > 0 ? ex.hex_identity_alloc(len) : 0;
    const outPtr = ex.hex_identity_alloc(32);
    if ((len > 0 && !dataPtr) || !outPtr) {
      return noteFallback('sha256', 'oom');
    }
    if (len > 0) {
      new Uint8Array(ex.memory.buffer, dataPtr, len).set(bytes);
    }

    const status = ex.hex_sha256_hash(dataPtr, len >>> 0, outPtr);
    if (status !== HEX_OK) {
      return noteFallback('sha256', `wasm_status_${status}`);
    }

    const out = new Uint8Array(32);
    out.set(new Uint8Array(ex.memory.buffer, outPtr, 32));
    recordWasmCall('sha256');
    return out;
  } catch {
    return noteFallback('sha256', 'wasm_exception');
  }
}

// ---------------------------------------------------------------------------
// ELF Symbol Table Extractor WASM Bridge (Wave 16)
// ---------------------------------------------------------------------------
const ELF_SYMBOLS_ARENA_BUDGET = 1_500_000;

export function wasmExtractElfSymbols(
  symBytes,
  entSize,
  count,
  strBytes,
  xindexBytes,
  is64Bit,
  isBigEndian,
  opts = {},
) {
  if (getEngineMode(opts) === 'js') return noteFallback('elf_symbols', 'wasm_disabled');
  const ex = getHexEngineExportsSafe(opts);
  if (
    !isWasmBulkMemorySupported()
    || !ex
    || typeof ex.hex_elf_extract_symbols !== 'function'
    || typeof ex.hex_identity_alloc !== 'function'
    || typeof ex.hex_identity_reset !== 'function'
  ) {
    return noteFallback('elf_symbols', 'wasm_unavailable');
  }
  if (!(symBytes instanceof Uint8Array)) return noteFallback('elf_symbols', 'invalid_sym_bytes');
  if (!(strBytes instanceof Uint8Array)) return noteFallback('elf_symbols', 'invalid_str_bytes');
  if (xindexBytes != null && !(xindexBytes instanceof Uint8Array)) {
    return noteFallback('elf_symbols', 'invalid_xindex_bytes');
  }
  if (!Number.isSafeInteger(count) || count < 0) return noteFallback('elf_symbols', 'invalid_count');
  const minEntSize = is64Bit ? 24 : 16;
  if (!Number.isSafeInteger(entSize) || entSize < minEntSize) {
    return noteFallback('elf_symbols', 'invalid_ent_size');
  }
  if (count * entSize > symBytes.length) return noteFallback('elf_symbols', 'invalid_range');

  if (count === 0) {
    recordWasmCall('elf_symbols');
    const emptyBuf = new ArrayBuffer(0);
    return { count: 0, buffer: emptyBuf, view: new DataView(emptyBuf) };
  }

  const symLen = symBytes.length;
  const strLen = strBytes.length;
  const xindexLen = xindexBytes ? xindexBytes.length : 0;
  const outBytes = count * 32;
  if (symLen + strLen + xindexLen + outBytes + 256 > ELF_SYMBOLS_ARENA_BUDGET) {
    const avail = ELF_SYMBOLS_ARENA_BUDGET - strLen - 512;
    const perSym = entSize + 32 + (xindexBytes ? 4 : 0);
    const chunkSyms = avail > 0 ? Math.floor(avail / perSym) : 0;
    if (chunkSyms < 64) {
      return noteFallback('elf_symbols', 'input_too_large');
    }
    try {
      const outCopy = new Uint8Array(outBytes);
      const flags = (is64Bit ? 1 : 0) | (isBigEndian ? 2 : 0);
      const hasFullXindex = Boolean(xindexBytes && count * 4 <= xindexBytes.length);
      for (let start = 0; start < count; start += chunkSyms) {
        const n = Math.min(chunkSyms, count - start);
        const sSlice = symBytes.subarray(start * entSize, (start + n) * entSize);
        const xSlice = hasFullXindex
          ? xindexBytes.subarray(start * 4, (start + n) * 4)
          : null;
        ex.hex_identity_reset();
        const symPtr = ex.hex_identity_alloc(sSlice.length);
        const strPtr = strLen > 0 ? ex.hex_identity_alloc(strLen) : 0;
        const xPtr = xSlice && xSlice.length > 0 ? ex.hex_identity_alloc(xSlice.length) : 0;
        const outPtr = ex.hex_identity_alloc(n * 32);
        const outCountPtr = ex.hex_identity_alloc(4);
        if (!symPtr || (strLen > 0 && !strPtr) || (xSlice && xSlice.length > 0 && !xPtr) || !outPtr || !outCountPtr) {
          return noteFallback('elf_symbols', 'oom');
        }
        const memU8 = new Uint8Array(ex.memory.buffer);
        memU8.set(sSlice, symPtr);
        if (strLen > 0) memU8.set(strBytes, strPtr);
        if (xSlice && xSlice.length > 0) memU8.set(xSlice, xPtr);
        const status = ex.hex_elf_extract_symbols(
          symPtr, sSlice.length >>> 0, entSize >>> 0, n >>> 0,
          strPtr, strLen >>> 0, xPtr, (xSlice ? xSlice.length : 0) >>> 0,
          flags >>> 0, outPtr, n >>> 0, outCountPtr,
        );
        if (status !== HEX_OK) return noteFallback('elf_symbols', `wasm_status_${status}`);
        const mem = ex.memory.buffer;
        const outCount = new DataView(mem).getUint32(outCountPtr, true);
        if (outCount !== n) return noteFallback('elf_symbols', 'count_mismatch');
        outCopy.set(new Uint8Array(mem, outPtr, n * 32), start * 32);
      }
      recordWasmCall('elf_symbols');
      return { count, buffer: outCopy.buffer, view: new DataView(outCopy.buffer) };
    } catch {
      return noteFallback('elf_symbols', 'wasm_exception');
    }
  }

  try {
    ex.hex_identity_reset();
    const symPtr = symLen > 0 ? ex.hex_identity_alloc(symLen) : 0;
    const strPtr = strLen > 0 ? ex.hex_identity_alloc(strLen) : 0;
    const xindexPtr = xindexLen > 0 ? ex.hex_identity_alloc(xindexLen) : 0;
    const outPtr = ex.hex_identity_alloc(outBytes);
    const outCountPtr = ex.hex_identity_alloc(4);
    if (
      (symLen > 0 && !symPtr)
      || (strLen > 0 && !strPtr)
      || (xindexLen > 0 && !xindexPtr)
      || !outPtr
      || !outCountPtr
    ) {
      return noteFallback('elf_symbols', 'oom');
    }

    const memU8 = new Uint8Array(ex.memory.buffer);
    if (symLen > 0) memU8.set(symBytes, symPtr);
    if (strLen > 0) memU8.set(strBytes, strPtr);
    if (xindexLen > 0) memU8.set(xindexBytes, xindexPtr);

    const flags = (is64Bit ? 1 : 0) | (isBigEndian ? 2 : 0);
    const status = ex.hex_elf_extract_symbols(
      symPtr,
      symLen >>> 0,
      entSize >>> 0,
      count >>> 0,
      strPtr,
      strLen >>> 0,
      xindexPtr,
      xindexLen >>> 0,
      flags >>> 0,
      outPtr,
      count >>> 0,
      outCountPtr,
    );
    if (status !== HEX_OK) {
      return noteFallback('elf_symbols', `wasm_status_${status}`);
    }

    const mem = ex.memory.buffer;
    const outCount = new DataView(mem).getUint32(outCountPtr, true);
    if (outCount !== count) {
      return noteFallback('elf_symbols', 'count_mismatch');
    }

    const outCopy = new Uint8Array(outBytes);
    outCopy.set(new Uint8Array(mem, outPtr, outBytes));
    recordWasmCall('elf_symbols');
    return {
      count: outCount,
      buffer: outCopy.buffer,
      view: new DataView(outCopy.buffer),
    };
  } catch {
    return noteFallback('elf_symbols', 'wasm_exception');
  }
}
