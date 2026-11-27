/**
 * ARM64 ABI argument, return-type, and stack-frame inference engine.
 * WASM-accelerated via `hex_infer_arm64_abi` with 1:1 parity JS fallback.
 */
import { getHexEngineExports, isWasmBulkMemorySupported } from '../core/hex-engine-wasm.js';
import { getEngineMode, recordWasmCall, recordFallback } from '../core/hex-engine-bridge.js';
import {
  readU32LE,
  isRet,
  isStpFpLr,
  decodeSubSpImm,
  decodeRegUsage,
} from './arm64-insn-bits.js';

export const SCRATCH_CHUNK_MAX = 1536 * 1024; // stay comfortably inside 2.5MB WASM scratch arena

export const ABI_RET_KIND = Object.freeze({
  VOID: 0,
  I32: 1,
  I64: 2,
  F32: 3,
  F64: 4,
});

const MAX_PASS_A_INSNS = 128;
const MAX_FUNC_INSNS = 4096;
const MAX_RET_LOOKBACK = 8;
const OUT_STRUCT_BYTES = 24;

function toU8(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return null;
}

function isArm64Arch(arch) {
  if (arch == null || arch === '') return true;
  const norm = String(arch).trim().toLowerCase();
  if (!norm) return true;
  return norm === 'arm64' || norm === 'aarch64' || norm === 'arm64e' || norm === 'arm64_32';
}

function makeEmptyResult({ engine = 'js', truncated = false, unsupportedArch = false } = {}) {
  return {
    valid: false,
    gpArgMask: 0,
    fpArgMask: 0,
    gpPtrMask: 0,
    gpArgCount: 0,
    fpArgCount: 0,
    retKind: 0,
    hasFrame: false,
    hasThis: false,
    hasX8Sret: false,
    stackFrameBytes: 0,
    insnScanned: 0,
    engine,
    truncated,
    unsupportedArch,
  };
}

function popcountU32(v) {
  let x = v >>> 0;
  let c = 0;
  while (x !== 0) {
    x = (x & (x - 1)) >>> 0;
    c += 1;
  }
  return c;
}

function normalizeEngineOpts(opts) {
  if (!opts || typeof opts !== 'object') return null;
  if (opts._engine != null) return opts;
  if (opts.engine != null) return { ...opts, _engine: opts.engine };
  return opts;
}

function getWasmExports(opts) {
  const modeOpts = normalizeEngineOpts(opts);
  if (getEngineMode(modeOpts) === 'js') {
    recordFallback('abi_scanner:wasm_disabled');
    return null;
  }
  if (opts && opts.wasmExports && typeof opts.wasmExports.hex_infer_arm64_abi === 'function') {
    return opts.wasmExports;
  }
  if (!isWasmBulkMemorySupported()) {
    recordFallback('abi_scanner:no_bulk_memory');
    return null;
  }
  try {
    const ex = getHexEngineExports(modeOpts);
    if (!ex || typeof ex.hex_infer_arm64_abi !== 'function') {
      recordFallback('abi_scanner:exports_missing');
      return null;
    }
    return ex;
  } catch {
    recordFallback('abi_scanner:init_error');
    return null;
  }
}

function allocWasmBuffers(ex, codeLen) {
  if (typeof ex.hex_engine_scratch_alloc === 'function' && typeof ex.hex_engine_scratch_reset === 'function') {
    ex.hex_engine_scratch_reset();
    const inPtr = ex.hex_engine_scratch_alloc(codeLen);
    const outPtr = ex.hex_engine_scratch_alloc(OUT_STRUCT_BYTES);
    if (!inPtr || !outPtr) return null;
    return { inPtr, outPtr };
  }
  if (ex.__heap_base != null && ex.memory && ex.memory.buffer) {
    const rawBase = typeof ex.__heap_base === 'object' ? ex.__heap_base.value : Number(ex.__heap_base);
    if (!Number.isFinite(rawBase) || rawBase < 0) return null;
    const inPtr = ((rawBase >>> 0) + 7) & ~7;
    const outPtr = ((inPtr + codeLen + 7) & ~7) >>> 0;
    const needed = outPtr + OUT_STRUCT_BYTES;
    if (needed > ex.memory.buffer.byteLength) {
      const diff = needed - ex.memory.buffer.byteLength;
      const pages = Math.ceil(diff / 65536);
      try {
        ex.memory.grow(pages);
      } catch {
        return null;
      }
    }
    if (needed > ex.memory.buffer.byteLength) return null;
    return { inPtr, outPtr };
  }
  return null;
}

function inferArm64AbiJs(u8, truncated) {
  const totalInsns = Math.min(u8.length >>> 2, MAX_FUNC_INSNS);
  const passALimit = Math.min(totalInsns, MAX_PASS_A_INSNS);

  let gpArgMask = 0;
  let fpArgMask = 0;
  let gpPtrMask = 0;
  let writtenGp = 0;
  let writtenFp = 0;
  let stackFrameBytes = 0;
  let hasFrame = false;
  let hasX8Sret = false;

  for (let i = 0; i < passALimit; i += 1) {
    const w = readU32LE(u8, i * 4);
    if (isStpFpLr(w)) {
      hasFrame = true;
    }
    const subBytes = decodeSubSpImm(w);
    if (subBytes >= 0) {
      stackFrameBytes = (stackFrameBytes + subBytes) >>> 0;
    }

    const ru = decodeRegUsage(w);
    const liveGpRead = (ru.gpRead & (~writtenGp >>> 0)) >>> 0;
    const liveFpRead = (ru.fpRead & (~writtenFp >>> 0)) >>> 0;
    const liveGpBase = (ru.gpBaseRead & (~writtenGp >>> 0)) >>> 0;

    gpArgMask = (gpArgMask | (liveGpRead & 0xFF)) >>> 0;
    fpArgMask = (fpArgMask | (liveFpRead & 0xFF)) >>> 0;
    gpPtrMask = (gpPtrMask | (liveGpBase & 0xFF)) >>> 0;
    if ((liveGpBase & (1 << 8)) !== 0) {
      hasX8Sret = true;
    }

    writtenGp = (writtenGp | ru.gpWrite) >>> 0;
    writtenFp = (writtenFp | ru.fpWrite) >>> 0;

    if (ru.isCall || ru.isRet || ru.isBranch) {
      break;
    }
  }

  let retKind = 0;
  for (let i = 0; i < totalInsns; i += 1) {
    const w = readU32LE(u8, i * 4);
    if (!isRet(w)) continue;

    let pathRetKind = 0;
    for (let step = 0; step < MAX_RET_LOOKBACK && i > step; step += 1) {
      const j = i - 1 - step;
      const pw = readU32LE(u8, j * 4);
      const pru = decodeRegUsage(pw);
      if (pru.isCall || pru.isRet || pru.isBranch) {
        break;
      }
      if (pru.retWriteKind !== 0) {
        pathRetKind = pru.retWriteKind;
        break;
      }
    }
    if (pathRetKind > retKind) {
      retKind = pathRetKind;
    }
  }

  const hasThis = (gpPtrMask & 1) !== 0;
  return {
    valid: true,
    gpArgMask,
    fpArgMask,
    gpPtrMask,
    gpArgCount: popcountU32(gpArgMask),
    fpArgCount: popcountU32(fpArgMask),
    retKind,
    hasFrame,
    hasThis,
    hasX8Sret,
    stackFrameBytes,
    insnScanned: totalInsns,
    engine: 'js',
    truncated,
    unsupportedArch: false,
  };
}

/**
 * Infer ARM64 ABI signature (argument masks, pointer/this detection, x8 sret,
 * return type, stack frame) from raw machine code bytes.
 */
export function inferArm64Abi(bytes, opts = {}) {
  const arch = opts && (opts.arch ?? opts.architecture);
  if (!isArm64Arch(arch)) {
    return makeEmptyResult({ engine: 'js', truncated: false, unsupportedArch: true });
  }

  const raw = toU8(bytes);
  if (!raw || raw.length < 4) {
    return makeEmptyResult({ engine: 'js', truncated: false, unsupportedArch: false });
  }

  const truncated = raw.length > SCRATCH_CHUNK_MAX;
  const u8 = truncated ? raw.subarray(0, SCRATCH_CHUNK_MAX) : raw;

  const ex = getWasmExports(opts);
  if (ex && ex.memory && ex.memory.buffer) {
    try {
      const bufs = allocWasmBuffers(ex, u8.length);
      if (bufs) {
        new Uint8Array(ex.memory.buffer, bufs.inPtr, u8.length).set(u8);
        const ok = ex.hex_infer_arm64_abi(bufs.inPtr, u8.length, bufs.outPtr) >>> 0;
        if (ok === 1) {
          const dv = new DataView(ex.memory.buffer, bufs.outPtr, OUT_STRUCT_BYTES);
          const gpArgMask = dv.getUint32(0, true);
          const fpArgMask = dv.getUint32(4, true);
          const gpPtrMask = dv.getUint32(8, true);
          const retKind = dv.getUint8(12);
          const flags = dv.getUint8(13);
          const gpArgCount = dv.getUint8(14);
          const fpArgCount = dv.getUint8(15);
          const stackFrameBytes = dv.getUint32(16, true);
          const insnScanned = dv.getUint32(20, true);
          recordWasmCall('abi_scanner');
          return {
            valid: true,
            gpArgMask,
            fpArgMask,
            gpPtrMask,
            gpArgCount,
            fpArgCount,
            retKind,
            hasFrame: (flags & 1) !== 0,
            hasThis: (flags & 2) !== 0,
            hasX8Sret: (flags & 4) !== 0,
            stackFrameBytes,
            insnScanned,
            engine: 'wasm',
            truncated,
            unsupportedArch: false,
          };
        }
        recordFallback('abi_scanner:wasm_returned_zero');
      } else {
        recordFallback('abi_scanner:scratch_alloc_failed');
      }
    } catch {
      recordFallback('abi_scanner:wasm_exception');
    } finally {
      if (typeof ex.hex_engine_scratch_reset === 'function') ex.hex_engine_scratch_reset();
    }
  }

  return inferArm64AbiJs(u8, truncated);
}
