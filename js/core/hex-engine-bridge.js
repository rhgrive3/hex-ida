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
  'fmov',
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
    ex.hex_identity_reset?.();
    let ptr = 0;
    if (bytes.length > 0) {
      ptr = ex.hex_identity_alloc(bytes.length);
      if (!ptr) return noteFallback('identity', 'oom');
      new Uint8Array(ex.memory.buffer, ptr, bytes.length).set(bytes);
    }
    const raw = ex.hex_identity_fnv64_bytes(ptr, bytes.length, FNV64_OFFSET_BASIS);
    const result = BigInt.asUintN(64, BigInt(raw));
    recordWasmCall('identity');
    return result;
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
    ex.hex_image_scratch_reset?.();
    const inPtr = bytes.length > 0 ? ex.hex_image_alloc_input(bytes.length) : 0;
    if (bytes.length > 0 && !inPtr) return noteFallback('binary', 'oom');
    if (bytes.length > 0) new Uint8Array(ex.memory.buffer, inPtr, bytes.length).set(bytes);
    const outHandlePtr = ex.hex_image_scratch_alloc(8);
    if (!outHandlePtr) return noteFallback('binary', 'oom');
    const openStatus = ex.hex_image_open(inPtr, bytes.length, outHandlePtr);
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
    resetScratch(ex);
    const inPtr = allocScratch(ex, count * 4);
    const outPtr = allocScratch(ex, count * SIZEOF_HEX_ARM64_DECODED);
    if (!inPtr || !outPtr) return noteFallback('arm64_decode', 'oom');
    const inView = new Uint32Array(ex.memory.buffer, inPtr, count);
    for (let i = 0; i < count; i += 1) inView[i] = words[i] >>> 0;
    const status = ex.hex_arm64_decode_batch(inPtr, count, BigInt(basePc), outPtr);
    if (status !== HEX_OK) return noteFallback('arm64_decode', `wasm_status_${status}`);
    const mem = ex.memory.buffer;
    const out = new Array(count);
    for (let i = 0; i < count; i += 1) {
      out[i] = readArm64Decoded(mem, outPtr + i * SIZEOF_HEX_ARM64_DECODED);
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
    resetScratch(ex);
    const maxInsns = bytes.length;
    const inPtr = allocScratch(ex, bytes.length);
    const outPtr = allocScratch(ex, maxInsns * SIZEOF_HEX_X86_DECODED);
    const countPtr = allocScratch(ex, 8);
    if (!inPtr || !outPtr || !countPtr) return noteFallback('x86_64_decode', 'oom');
    new Uint8Array(ex.memory.buffer, inPtr, bytes.length).set(bytes);
    const status = ex.hex_x86_64_decode_batch(inPtr, bytes.length, BigInt(basePc), outPtr, maxInsns, countPtr);
    if (status !== HEX_OK) return noteFallback('x86_64_decode', `wasm_status_${status}`);
    const mem = ex.memory.buffer;
    const count = new DataView(mem).getUint32(countPtr, true);
    const out = new Array(count);
    for (let i = 0; i < count; i += 1) {
      const base = outPtr + i * SIZEOF_HEX_X86_DECODED;
      const dv = new DataView(mem, base, SIZEOF_HEX_X86_DECODED);
      out[i] = {
        pc: dv.getBigUint64(0, true),
        target: dv.getBigUint64(8, true),
        disp: dv.getBigInt64(16, true),
        imm: dv.getBigInt64(24, true),
        flags: dv.getUint32(32, true),
        length: dv.getUint8(36),
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
        valid: dv.getUint8(51) !== 0,
        mn: readCString(mem, base + 52, 16),
      };
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
  if (((w & 0xff8003e0) >>> 0) === 0x320003e0) return false;
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
  // Bit-level fallback guards for FMOV (imm), MNEG, and SMULL when mnemonic metadata is omitted.
  if (((w & 0x5f201c00) >>> 0) === 0x1e201000) {
    return 'unsupported_insn:fmov';
  }
  if (((w & 0x7fe0fc00) >>> 0) === 0x1b00fc00) {
    return 'unsupported_insn:mneg';
  }
  if (((w & 0xffe0fc00) >>> 0) === 0x9b207c00) {
    return 'unsupported_insn:smull';
  }
  return null;
}

export function wasmDecompileArm64Function({ words, baseAddr = 0n, funcName = '', insns = null } = {}) {
  if (getEngineMode() === 'js') return noteFallback('decompile', 'wasm_disabled');
  const ex = getHexEngineExportsSafe();
  if (
    !isWasmBulkMemorySupported()
    || !ex
    || typeof ex.hex_engine_decompile_arm64 !== 'function'
    || typeof ex.hex_decomp_get_text_ptr !== 'function'
    || typeof ex.hex_decomp_get_text_len !== 'function'
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
    resetScratch(ex);
    const wordsPtr = allocScratch(ex, count * 4);
    if (!wordsPtr) return noteFallback('decompile', 'oom');
    const wordsView = new Uint32Array(ex.memory.buffer, wordsPtr, count);
    for (let i = 0; i < count; i += 1) wordsView[i] = words[i] >>> 0;

    let namePtr = 0;
    let nameLen = 0;
    const rawName = typeof funcName === 'string' ? funcName : '';
    let nameStr = '';
    if (rawName.startsWith('-[') || rawName.startsWith('+[')) {
      nameStr = rawName;
    } else if (rawName.length > 0) {
      nameStr = rawName.replace(/^_+/, '').replace(/[^A-Za-z0-9_]/g, '_');
      if (nameStr.length === 0 || /^[0-9]/.test(nameStr)) {
        return noteFallback('decompile', 'unsupported_symbol_name');
      }
    }
    if (nameStr.length > 0) {
      const nameBytes = textEncoder.encode(nameStr);
      nameLen = nameBytes.length;
      namePtr = allocScratch(ex, nameLen + 1);
      if (!namePtr) return noteFallback('decompile', 'oom');
      const memView = new Uint8Array(ex.memory.buffer, namePtr, nameLen + 1);
      memView.set(nameBytes, 0);
      memView[nameLen] = 0;
    }

    const status = ex.hex_engine_decompile_arm64(
      wordsPtr,
      count,
      BigInt(baseAddr),
      namePtr,
      nameLen,
      HEX_EMIT_FLAG_JS_PARITY,
    );
    if (status !== HEX_OK) {
      return noteFallback('decompile', `wasm_status_${status}`);
    }

    const getTP = ex.hex_engine_decompile_get_text_ptr || ex.hex_decomp_get_text_ptr;
    const getTL = ex.hex_engine_decompile_get_text_len || ex.hex_decomp_get_text_len;
    const textPtr = getTP();
    const textLen = getTL();
    if (!textPtr || !textLen) {
      return noteFallback('decompile', 'empty_wasm_output');
    }

    const mem = ex.memory.buffer;
    const pseudocode = textDecoder.decode(new Uint8Array(mem, textPtr, textLen));
    if ((rawName.startsWith('-[') || rawName.startsWith('+[')) && !pseudocode.includes('typedef void * id;')) {
      return noteFallback('decompile', 'unsupported_objc_name');
    }

    const rawLinemap = new Map();
    if (
      typeof ex.hex_decomp_get_linemap_ptr === 'function'
      && typeof ex.hex_decomp_get_linemap_count === 'function'
    ) {
      const getLP = ex.hex_engine_decompile_get_linemap_ptr || ex.hex_decomp_get_linemap_ptr;
      const getLC = ex.hex_engine_decompile_get_linemap_count || ex.hex_decomp_get_linemap_count;
      const lmPtr = getLP();
      const lmCount = getLC();
      if (lmPtr && lmCount > 0) {
        const dv = new DataView(mem);
        for (let i = 0; i < lmCount; i += 1) {
          const off = lmPtr + i * SIZEOF_HEX_LINEMAP_ENTRY;
          const lineNo = dv.getUint32(off, true);
          const address = dv.getBigUint64(off + 8, true);
          const list = rawLinemap.get(lineNo) || [];
          if (!list.includes(address)) list.push(address);
          rawLinemap.set(lineNo, list);
        }
      }
    }

    const rawLines = pseudocode.split('\n');
    const legacyRawRegDeclRe = /^\s*(?:u?int(?:8|16|32|64|128)(?:_t)?|float|double)\s+[xw]\d+;/;
    const hasGeneralQDecl = rawLines.some((l) => /^\s*uint128\s+q\d+\s*=\s*0;/.test(l));
    const isLegacyOutput = !hasGeneralQDecl && rawLines.some((l) => (
      l.includes('// … ほかに ')
      || l.includes('*(uint128 *)')
      || l.includes('__builtin_trap();   // ここに来たら異常')
      || legacyRawRegDeclRe.test(l)
    ));
    const baseAddrBig = BigInt(baseAddr);
    const addrToRow = new Map();
    if (Array.isArray(insns)) {
      for (let i = 0; i < insns.length; i += 1) {
        if (insns[i]?.address != null) addrToRow.set(BigInt(insns[i].address), i);
      }
    } else {
      for (let i = 0; i < count; i += 1) {
        addrToRow.set(baseAddrBig + BigInt(i * 4), i);
      }
    }

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
        || trimmed.endsWith(';')
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
      } else if (bodyDeclRe.test(trimmed)) {
        kind = 'decl';
      } else {
        kind = 'stmt';
      }

      const mappedAddrs = rawLinemap.get(idx + 1) || [];
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

      if (!isLegacyOutput && !isPrelude && !(kind === 'decl' && /\b(?:local_|var_|call_|self\b|a[1-8]\b)/.test(trimmed))) {
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
          .map((a) => addrToRow.get(a))
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

    recordWasmCall('decompile');
    return isLegacyOutput
      ? { pseudocode, lines, sourceMap: undefined }
      : { pseudocode, lines, sourceMap };
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
      const list = rawLinemap.get(lineNo) || [];
      if (!list.includes(address)) list.push(address);
      rawLinemap.set(lineNo, list);
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

    const mappedAddrs = rawLinemap.get(idx + 1) || [];
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
export function wasmDecompileX86_64Function({
  bytes,
  baseAddr = 0n,
  funcName = '',
  abiId = 0,
  insns = null,
} = {}) {
  if (getEngineMode() === 'js') return noteFallback('x86_64_decompile', 'wasm_disabled');
  const ex = getHexEngineExportsSafe();
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

  const norm = normalizeDecompileSymbolName(funcName, 'x86_64_decompile');
  if (!norm.ok) {
    return noteFallback('x86_64_decompile', norm.reason);
  }

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
      abiId >>> 0,
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
    resetEngineScratch(ex);
    const maxInsns = Math.ceil(bytes.length / 2);
    const inPtr = allocEngineScratch(ex, bytes.length);
    const outPtr = allocEngineScratch(ex, maxInsns * SIZEOF_HEX_RISCV64_DECODED);
    const countPtr = allocEngineScratch(ex, 8);
    if (!inPtr || !outPtr || !countPtr) return noteFallback('riscv64_decode', 'oom');
    new Uint8Array(ex.memory.buffer, inPtr, bytes.length).set(bytes);
    const status = ex.hex_riscv64_decode_batch(inPtr, bytes.length, BigInt(basePc), outPtr, maxInsns, countPtr);
    if (status !== HEX_OK) return noteFallback('riscv64_decode', `wasm_status_${status}`);
    const mem = ex.memory.buffer;
    const count = new DataView(mem).getUint32(countPtr, true);
    const out = new Array(count);
    for (let i = 0; i < count; i += 1) {
      const base = outPtr + i * SIZEOF_HEX_RISCV64_DECODED;
      const dv = new DataView(mem, base, SIZEOF_HEX_RISCV64_DECODED);
      out[i] = {
        pc: dv.getBigUint64(0, true),
        target: dv.getBigUint64(8, true),
        imm: dv.getBigInt64(16, true),
        raw: dv.getUint32(24, true),
        length: dv.getUint8(28),
        kind: dv.getUint8(29),
        rd: dv.getUint8(30),
        rs1: dv.getUint8(31),
        rs2: dv.getUint8(32),
        valid: dv.getUint8(33) !== 0,
        mn: readCString(mem, base + 36, 24),
      };
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
const STRING_SCAN_ENCODINGS = Object.freeze(['utf8', 'utf16le', 'utf16be']);
const BYTE_SEARCH_CHUNK_BYTES = 262144;
const BYTE_SEARCH_NOT_FOUND = 0xffffffff;

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
    // Chunked WASM path for large binaries (> 1.5 MiB) with exact 0-diff ordering & boundary safety.
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
        const passes = (needSplit || needParityFix) ? encFlagsList : [flags];

        for (let pi = 0; pi < passes.length && totalSpans < limit; pi += 1) {
          const passFlags = passes[pi];
          const isUtf16Pass = (passFlags & 6) !== 0;
          const splitUtf16Parity = (needSplit || (rStart & 1) !== 0) && isUtf16Pass;
          const evenChunks = splitUtf16Parity ? [] : null;
          const oddChunks = splitUtf16Parity ? [] : null;
          let evenCount = 0;
          let pos = rStart;
          while (pos < rEnd && (splitUtf16Parity ? (totalSpans + evenCount < limit) : (totalSpans < limit))) {
            let cut = Math.min(rEnd, pos + STRING_SCAN_CHUNK_BYTES);
            if (cut < rEnd) {
              if (isUtf16Pass) {
                // Ensure 2-byte alignment relative to rStart AND 4 consecutive NULs so both
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
                if (found < 0) return noteFallback('strings', 'chunk_no_boundary');
                cut = found;
              } else {
                let found = -1;
                for (let c = cut; c >= pos + 4; c -= 1) {
                  if (bytes[c - 1] === 0) {
                    found = c;
                    break;
                  }
                }
                if (found < 0) return noteFallback('strings', 'chunk_no_boundary');
                cut = found;
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
      return noteFallback('strings', 'span_cap_reached');
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
    return noteFallback('sha256', 'input_too_large');
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
    return noteFallback('elf_symbols', 'input_too_large');
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
