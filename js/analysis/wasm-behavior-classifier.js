/**
 * Stringless ARM64 function behavior classifier (WASM-accelerated with 1:1 JS fallback).
 * Classifies ARM64 machine code into DRAIN / ACCUM / RATIO / CRYPTO / ACCESSOR categories
 * using shared bit-level instruction decoding and RMW+Clamp detection.
 */
import { getHexEngineExports, isWasmBulkMemorySupported } from '../core/hex-engine-wasm.js';
import { getEngineMode, recordWasmCall, recordFallback } from '../core/hex-engine-bridge.js';
import {
  INSN_CLASS,
  readU32LE,
  classifyInsn,
  isClampOrCond,
  isHwCrypto,
  isRet,
  scanArm64RmwCore,
} from './arm64-insn-bits.js';

export const SCRATCH_CHUNK_MAX = 1536 * 1024; // 1.5 MiB (4-byte aligned, inside 2.5 MiB WASM scratch arena)
const OUT_STRUCT_BYTES = 32;

export const BEHAVIOR_CATEGORY = Object.freeze({
  NONE: 0,
  DRAIN: 1,
  ACCUM: 2,
  RATIO: 3,
  CRYPTO: 4,
  ACCESSOR: 5,
});

let testStandaloneExports = null;

/**
 * Inject standalone WASM exports for unit testing (e.g., HEX_TEST_STANDALONE_WASM).
 * Pass null/undefined to clear the override.
 */
export function setBehaviorClassifierWasmExportsForTest(exportsObj) {
  testStandaloneExports = exportsObj || null;
}

function toU8(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return null;
}

function isArm64Arch(arch) {
  if (arch == null || arch === '') return true;
  const norm = String(arch).trim().toLowerCase();
  return norm === 'arm64' || norm === 'aarch64' || norm === 'arm64e';
}

function resolveEngineMode(opts) {
  const direct = opts?.engine ?? opts?._engine;
  if (direct != null) {
    const norm = String(direct).trim().toLowerCase();
    if (norm === 'js' || norm === 'wasm' || norm === 'auto') return norm;
  }
  return getEngineMode(opts);
}

function makeInvalidResult({ truncated = false, unsupportedArch = false } = {}) {
  return {
    valid: false,
    drainScore: 0,
    accumScore: 0,
    ratioScore: 0,
    cryptoScore: 0,
    accessorScore: 0,
    topCategory: BEHAVIOR_CATEGORY.NONE,
    insnCount: 0,
    flags: 0,
    engine: 'js',
    truncated,
    unsupportedArch,
  };
}

function getWasmExports(opts) {
  const mode = resolveEngineMode(opts);
  if (mode === 'js') {
    recordFallback('behavior_classifier:wasm_disabled');
    return null;
  }
  if (!isWasmBulkMemorySupported()) {
    recordFallback('behavior_classifier:no_bulk_memory');
    return null;
  }
  const injected = opts?.wasmExports || testStandaloneExports;
  if (injected) {
    if (typeof injected.hex_classify_arm64_behavior === 'function' && injected.memory) {
      return injected;
    }
    recordFallback('behavior_classifier:injected_exports_missing');
    return null;
  }
  try {
    const ex = getHexEngineExports(mode !== 'auto' ? { _engine: mode } : opts);
    if (!ex || typeof ex.hex_classify_arm64_behavior !== 'function' || !ex.memory) {
      recordFallback('behavior_classifier:exports_missing');
      return null;
    }
    return ex;
  } catch {
    recordFallback('behavior_classifier:init_error');
    return null;
  }
}

function getStandaloneHeapBase(ex) {
  const hb = ex.__heap_base;
  let base = 65536;
  if (typeof hb === 'number' && Number.isFinite(hb) && hb > 0) {
    base = hb >>> 0;
  } else if (hb && typeof hb.value === 'number' && Number.isFinite(hb.value) && hb.value > 0) {
    base = hb.value >>> 0;
  }
  return (base + 7) & ~7;
}

function ensureWasmMemory(memory, neededEnd) {
  const curBytes = memory.buffer.byteLength;
  if (neededEnd <= curBytes) return true;
  const diff = neededEnd - curBytes;
  const pages = Math.ceil(diff / 65536);
  try {
    memory.grow(pages);
    return memory.buffer.byteLength >= neededEnd;
  } catch {
    return false;
  }
}

function runWasmClassifier(ex, u8, truncated) {
  const len = u8.length;
  let inPtr = 0;
  let outPtr = 0;
  const hasScratch = typeof ex.hex_engine_scratch_reset === 'function' &&
      typeof ex.hex_engine_scratch_alloc === 'function';

  try {
  if (hasScratch) {
    ex.hex_engine_scratch_reset();
    inPtr = ex.hex_engine_scratch_alloc(len);
    outPtr = ex.hex_engine_scratch_alloc(OUT_STRUCT_BYTES);
    if (!inPtr || !outPtr) return null;
  } else {
    const base = getStandaloneHeapBase(ex);
    inPtr = base;
    outPtr = (inPtr + len + 7) & ~7;
    if (!ensureWasmMemory(ex.memory, outPtr + OUT_STRUCT_BYTES)) return null;
  }

  new Uint8Array(ex.memory.buffer, inPtr, len).set(u8);
  const ok = ex.hex_classify_arm64_behavior(inPtr, len, outPtr) >>> 0;
  if (ok !== 1) return null;

  const dv = new DataView(ex.memory.buffer, outPtr, OUT_STRUCT_BYTES);
  const result = {
    valid: true,
    drainScore: dv.getUint32(0, true),
    accumScore: dv.getUint32(4, true),
    ratioScore: dv.getUint32(8, true),
    cryptoScore: dv.getUint32(12, true),
    accessorScore: dv.getUint32(16, true),
    topCategory: dv.getUint32(20, true),
    insnCount: dv.getUint32(24, true),
    flags: dv.getUint32(28, true),
    engine: 'wasm',
    truncated,
    unsupportedArch: false,
  };
  recordWasmCall('behavior_classifier');
  return result;
  } finally {
    if (hasScratch) ex.hex_engine_scratch_reset();
  }
}

function satMul1000(count, weight) {
  if (count <= 0 || weight <= 0) return 0;
  const prod = count * weight;
  return prod > 1000 ? 1000 : prod;
}

function classifyArm64BehaviorJs(u8, truncated) {
  const { summary: rmw } = scanArm64RmwCore(u8, 0, false);

  const insnCount = u8.length >>> 2;
  const limit = insnCount << 2;

  let clampOps = 0;
  let hwCrypto = 0;
  let retOps = 0;
  let loadOps = 0;
  let storeOps = 0;
  let muldivOps = 0;
  let fpOps = 0;
  let bitwiseOps = 0;
  let callOps = 0;

  for (let off = 0; off < limit; off += 4) {
    const w = readU32LE(u8, off);
    if (isClampOrCond(w)) clampOps++;
    if (isHwCrypto(w)) hwCrypto++;
    if (isRet(w)) retOps++;

    const cls = classifyInsn(w);
    if (cls === INSN_CLASS.LOAD) loadOps++;
    else if (cls === INSN_CLASS.STORE) storeOps++;
    else if (cls === INSN_CLASS.MULDIV) muldivOps++;
    else if (cls === INSN_CLASS.FP_SIMD) fpOps++;
    else if (cls === INSN_CLASS.BITWISE) bitwiseOps++;
    else if (cls === INSN_CLASS.CALL_DIR || cls === INSN_CLASS.CALL_IND) callOps++;
  }

  const drainScore = Math.min(
    1000,
    satMul1000(rmw.clampedSub, 450) +
    satMul1000(rmw.unclampedSub, 250) +
    satMul1000(clampOps, 40),
  );
  const accumScore = Math.min(
    1000,
    satMul1000(rmw.addRmw, 350) +
    satMul1000(storeOps, 40),
  );
  const ratioScore = Math.min(
    1000,
    satMul1000(muldivOps, 220) +
    satMul1000(fpOps, 120),
  );
  const cryptoScore = Math.min(
    1000,
    satMul1000(hwCrypto, 500) +
    satMul1000(bitwiseOps, 80),
  );
  const accessorScore = (
    insnCount <= 8 &&
    callOps === 0 &&
    (loadOps + storeOps) >= 1 &&
    retOps >= 1 &&
    rmw.clampedSub === 0 &&
    rmw.unclampedSub === 0 &&
    rmw.addRmw === 0
  ) ? 900 : 0;

  const scores = [drainScore, accumScore, ratioScore, cryptoScore, accessorScore];
  let bestScore = 0;
  let topCategory = BEHAVIOR_CATEGORY.NONE;
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] > bestScore) {
      bestScore = scores[i];
      topCategory = i + 1;
    }
  }
  if (bestScore < 250) {
    topCategory = BEHAVIOR_CATEGORY.NONE;
  }

  const flags = (
    (rmw.clampedSub > 0 ? 1 : 0) |
    (hwCrypto > 0 ? 2 : 0) |
    (muldivOps > 0 ? 4 : 0) |
    (rmw.addRmw > 0 ? 8 : 0) |
    (accessorScore > 0 ? 16 : 0)
  ) >>> 0;

  return {
    valid: true,
    drainScore,
    accumScore,
    ratioScore,
    cryptoScore,
    accessorScore,
    topCategory,
    insnCount,
    flags,
    engine: 'js',
    truncated,
    unsupportedArch: false,
  };
}

/**
 * Classify an ARM64 machine-code buffer by behavioral signature without strings/symbols.
 */
export function classifyArm64Behavior(bytes, opts = {}) {
  if (!isArm64Arch(opts?.arch)) {
    return makeInvalidResult({ truncated: false, unsupportedArch: true });
  }
  const raw = toU8(bytes);
  if (!raw || raw.length < 4) {
    return makeInvalidResult({ truncated: false, unsupportedArch: false });
  }

  let u8 = raw;
  let truncated = false;
  if (raw.length > SCRATCH_CHUNK_MAX) {
    u8 = raw.subarray(0, SCRATCH_CHUNK_MAX);
    truncated = true;
  }

  const ex = getWasmExports(opts);
  if (ex) {
    try {
      const wasmRes = runWasmClassifier(ex, u8, truncated);
      if (wasmRes) return wasmRes;
      recordFallback('behavior_classifier:wasm_returned_zero');
    } catch {
      recordFallback('behavior_classifier:wasm_exception');
    }
  }

  return classifyArm64BehaviorJs(u8, truncated);
}
