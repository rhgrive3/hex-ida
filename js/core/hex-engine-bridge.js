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

// Instructions whose JS decompiler oracle semantics can diverge from the fast
// WASM lifter/emitter path and must therefore fail closed to JS.
const EXPLICIT_UNSUPPORTED_ARM64_MNEMONICS = Object.freeze(new Set([
  'fmov',
  'mneg',
  'smull',
  'umull',
  'smaddl',
  'umaddl',
  'smsubl',
  'umsubl',
  'movn',
  'movk',
  'bic',
  'orn',
  'eon',
  'extr',
  'bfm',
  'sbfm',
  'ubfm',
  'bfi',
  'bfxil',
  'sbfx',
  'ubfx',
  'rbit',
  'rev',
  'rev16',
  'rev32',
  'clz',
  'cls',
  'ccmp',
  'ccmn',
  'csinc',
  'csinv',
  'csneg',
  'adc',
  'adcs',
  'sbc',
  'sbcs',
  'bl',
  'blr',
  'br',
  'svc',
  'brk',
  'udf',
]));

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Optional static-like load of ./hex-engine-wasm.js (generated in a parallel worktree).
let wasmModuleApi = null;
try {
  wasmModuleApi = await import('./hex-engine-wasm.js');
} catch {
  wasmModuleApi = null;
}

function noteFallback(domain, reason) {
  recordFallback(`${domain}:${reason}`);
  return null;
}

function getHexEngineExportsSafe() {
  if (!wasmModuleApi || typeof wasmModuleApi.getHexEngineExports !== 'function') {
    return null;
  }
  try {
    return wasmModuleApi.getHexEngineExports() || null;
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

export function getEngineMode() {
  const raw = globalThis.__HEX_ENGINE_MODE__
    || (typeof process !== 'undefined' && process.env?.HEX_ENGINE)
    || 'auto';
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
    recordWasmCall('arm64_decode');
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
    recordWasmCall('x86_64_decode');
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

function classifyUnsupportedArm64Insn(word, insn, ex) {
  const mn = String(insn?.mn ?? insn?.mnemonic ?? '').trim().toLowerCase();
  const ops = String(insn?.ops ?? insn?.opStr ?? '');
  if (mn && EXPLICIT_UNSUPPORTED_ARM64_MNEMONICS.has(mn)) {
    return `unsupported_insn:${mn}`;
  }
  if (isNonAliasOrrRegister(word, mn, ops)) {
    return 'unsupported_insn:orr';
  }
  if (((word & 0x7F800000) >>> 0) === 0x12800000) {
    return 'unsupported_insn:movn';
  }
  if (typeof ex.hex_arm64_is_decompiler_supported === 'function') {
    if (ex.hex_arm64_is_decompiler_supported(word >>> 0) === 0) {
      return `unsupported_insn:${mn || `0x${(word >>> 0).toString(16)}`}`;
    }
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
  for (let i = 0; i < count; i += 1) {
    const w = words[i];
    if (typeof w !== 'number' || !Number.isFinite(w)) {
      return noteFallback('decompile', 'invalid_word');
    }
    const reason = classifyUnsupportedArm64Insn(w >>> 0, insns ? insns[i] : null, ex);
    if (reason) return noteFallback('decompile', reason);
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
    const stripped = rawName.replace(/^_+/, '');
    const nameStr = stripped.length > 0 ? stripped : rawName;
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

    const textPtr = ex.hex_decomp_get_text_ptr();
    const textLen = ex.hex_decomp_get_text_len();
    if (!textPtr || !textLen) {
      return noteFallback('decompile', 'empty_wasm_output');
    }

    const mem = ex.memory.buffer;
    const pseudocode = textDecoder.decode(new Uint8Array(mem, textPtr, textLen));

    const rawLinemap = new Map();
    if (
      typeof ex.hex_decomp_get_linemap_ptr === 'function'
      && typeof ex.hex_decomp_get_linemap_count === 'function'
    ) {
      const lmPtr = ex.hex_decomp_get_linemap_ptr();
      const lmCount = ex.hex_decomp_get_linemap_count();
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

    const lines = [];
    const sourceMap = [];
    let bodyLineNo = 0;
    let seenSig = false;
    for (let idx = 0; idx < rawLines.length; idx += 1) {
      const text = rawLines[idx];
      const trimmed = text.trimStart();
      const indent = Math.floor((text.length - trimmed.length) / 4);
      const isPrelude = !seenSig && (trimmed.startsWith('/*') || trimmed.startsWith('typedef '));
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
      const firstAddr = kind === 'sig' ? baseAddrBig : (mappedAddrs[0] ?? null);
      lines.push({
        kind,
        indent,
        text: trimmed,
        row: firstAddr != null ? (addrToRow.get(firstAddr) ?? null) : null,
        addr: firstAddr,
        address: firstAddr,
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

    recordWasmCall('decompile');
    return { pseudocode, lines, sourceMap };
  } catch {
    return noteFallback('decompile', 'wasm_exception');
  }
}
