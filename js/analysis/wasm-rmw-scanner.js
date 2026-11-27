/**
 * ARM64 Read-Modify-Write (+ Clamp) field scanner.
 * WASM-accelerated via `hex_scan_arm64_rmw_fields` with 1:1 JS fallback parity.
 */
import { getHexEngineExports, isWasmBulkMemorySupported } from '../core/hex-engine-wasm.js';
import { getEngineMode, recordWasmCall, recordFallback } from '../core/hex-engine-bridge.js';
import { scanArm64RmwCore } from './arm64-insn-bits.js';

const SCRATCH_CHUNK_MAX = 1536 * 1024;
const OVERLAP = 128; // multiple of 8 (32 ARM64 instructions)
const MAX_OUT_LIMIT = 4096;
const RMW_HIT_BYTES = 20;

function toU8(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return null;
}

function isArm64Arch(arch) {
  if (arch == null || arch === '') return true;
  const norm = String(arch).trim().toLowerCase();
  return norm === '' || norm === 'arm64' || norm === 'aarch64' || norm === 'arm64e' || norm === 'arm64_32';
}

function normalizeEngineOpts(opts) {
  if (!opts || typeof opts !== 'object') return null;
  if (opts.engine != null && opts._engine == null) {
    return { ...opts, _engine: opts.engine };
  }
  return opts;
}

function resolveWasmExports(opts, engineOpts) {
  if (getEngineMode(engineOpts) === 'js') {
    recordFallback('rmw_scanner:wasm_disabled');
    return null;
  }
  if (!isWasmBulkMemorySupported()) {
    recordFallback('rmw_scanner:no_bulk_memory');
    return null;
  }
  try {
    const ex = opts && opts.wasmExports ? opts.wasmExports : getHexEngineExports(engineOpts);
    if (
      !ex
      || !ex.memory
      || !(ex.memory.buffer instanceof ArrayBuffer)
      || typeof ex.hex_scan_arm64_rmw_fields !== 'function'
      || typeof ex.hex_engine_scratch_alloc !== 'function'
      || typeof ex.hex_engine_scratch_reset !== 'function'
    ) {
      recordFallback('rmw_scanner:exports_missing');
      return null;
    }
    return ex;
  } catch {
    recordFallback('rmw_scanner:init_error');
    return null;
  }
}

function resolveChunkSize(chunkSize) {
  if (Number.isFinite(chunkSize) && chunkSize > 0) {
    const aligned = Math.floor(chunkSize) & ~3;
    return Math.min(SCRATCH_CHUNK_MAX, Math.max(16, aligned));
  }
  return SCRATCH_CHUNK_MAX;
}

function mergeChunkHits(target, seen, chunkHits, chunkStart, maxOut) {
  let truncated = false;
  for (let i = 0; i < chunkHits.length; i++) {
    const h = chunkHits[i];
    const loadOff = h.loadOff + chunkStart;
    const storeOff = h.storeOff + chunkStart;
    const arithOff = h.arithOff + chunkStart;
    const key = `${loadOff}:${storeOff}`;
    if (seen.has(key)) continue;
    if (target.length >= maxOut) {
      truncated = true;
      break;
    }
    seen.add(key);
    target.push({
      loadOff,
      storeOff,
      arithOff,
      disp: h.disp,
      baseReg: h.baseReg,
      opKind: h.opKind,
      clamped: h.clamped,
      isFloat: h.isFloat,
      width: h.width,
      flags: h.flags,
    });
  }
  return truncated;
}

function runChunkedScan(u8, maxOut, effChunkSize, scanChunk) {
  const hits = [];
  const seen = new Set();
  let truncated = false;

  const overlap = effChunkSize > OVERLAP
    ? OVERLAP
    : Math.max(4, Math.min(OVERLAP, (effChunkSize - 4) & ~3));
  // Request extra headroom so duplicates in the overlap window cannot starve new hits or truncation detection.
  const chunkMaxOut = Math.min(MAX_OUT_LIMIT + 16, maxOut + 16);

  let chunkStart = 0;
  while (chunkStart < u8.length) {
    const chunkEnd = Math.min(u8.length, chunkStart + effChunkSize);
    const chunkLen = chunkEnd - chunkStart;
    if (chunkLen < 4) break;

    const chunk = u8.subarray(chunkStart, chunkEnd);
    const chunkHits = scanChunk(chunk, chunkMaxOut);
    if (chunkHits === null) {
      return null;
    }
    if (mergeChunkHits(hits, seen, chunkHits, chunkStart, maxOut)) {
      truncated = true;
      break;
    }
    if (chunkEnd >= u8.length) break;
    chunkStart = chunkEnd - overlap;
  }

  return { hits, truncated };
}

function decodeWasmHits(buffer, outPtr, count) {
  const dv = new DataView(buffer, outPtr, count * RMW_HIT_BYTES);
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const base = i * RMW_HIT_BYTES;
    const loadOff = dv.getUint32(base + 0, true);
    const storeOff = dv.getUint32(base + 4, true);
    const disp = dv.getInt32(base + 8, true);
    const baseReg = dv.getUint8(base + 12);
    const opKind = dv.getUint8(base + 13);
    const flags = dv.getUint8(base + 14);
    const width = dv.getUint8(base + 15);
    const arithOff = dv.getUint32(base + 16, true);
    out[i] = {
      loadOff,
      storeOff,
      arithOff,
      disp,
      baseReg,
      opKind,
      clamped: (flags & 1) !== 0,
      isFloat: (flags & 2) !== 0,
      width,
      flags,
    };
  }
  return out;
}

export function scanArm64RmwFields(bytes, opts = {}) {
  const {
    arch = 'arm64',
    maxOut: rawMaxOut = MAX_OUT_LIMIT,
    chunkSize,
  } = opts || {};

  if (!isArm64Arch(arch)) {
    return { hits: [], engine: 'js', truncated: false, unsupportedArch: true };
  }

  const maxOut = Number.isFinite(rawMaxOut)
    ? Math.max(0, Math.min(MAX_OUT_LIMIT, Math.floor(rawMaxOut)))
    : MAX_OUT_LIMIT;

  const u8 = toU8(bytes);
  if (!u8 || u8.length < 4 || maxOut === 0) {
    return { hits: [], engine: 'js', truncated: false, unsupportedArch: false };
  }

  const effChunkSize = resolveChunkSize(chunkSize);
  const engineOpts = normalizeEngineOpts(opts);
  const ex = resolveWasmExports(opts, engineOpts);

  if (ex) {
    try {
      const wasmResult = runChunkedScan(u8, maxOut, effChunkSize, (chunk, chunkMaxOut) => {
        try {
          ex.hex_engine_scratch_reset();
          const inPtr = ex.hex_engine_scratch_alloc(chunk.length) >>> 0;
          const outPtr = ex.hex_engine_scratch_alloc(chunkMaxOut * RMW_HIT_BYTES) >>> 0;
          if (inPtr === 0 || outPtr === 0) {
            recordFallback('rmw_scanner:oom');
            return null;
          }
          new Uint8Array(ex.memory.buffer, inPtr, chunk.length).set(chunk);
          const count = ex.hex_scan_arm64_rmw_fields(inPtr, chunk.length, outPtr, chunkMaxOut) >>> 0;
          return decodeWasmHits(ex.memory.buffer, outPtr, count);
        } finally {
          ex.hex_engine_scratch_reset();
        }
      });

      if (wasmResult !== null) {
        recordWasmCall('rmw_scanner');
        return {
          hits: wasmResult.hits,
          engine: 'wasm',
          truncated: wasmResult.truncated,
          unsupportedArch: false,
        };
      }
    } catch {
      recordFallback('rmw_scanner:wasm_exception');
    }
  }

  const jsResult = runChunkedScan(u8, maxOut, effChunkSize, (chunk, chunkMaxOut) => (
    scanArm64RmwCore(chunk, chunkMaxOut, true).hits
  ));

  return {
    hits: jsResult.hits,
    engine: 'js',
    truncated: jsResult.truncated,
    unsupportedArch: false,
  };
}
