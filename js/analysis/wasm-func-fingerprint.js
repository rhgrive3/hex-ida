/**
 * Track 3: ARM64 function structural SimHash fingerprinting & fast similarity
 * matching engine (WASM-accelerated with bit-exact BigInt JS fallback).
 */
import { getHexEngineExports, isWasmBulkMemorySupported } from '../core/hex-engine-wasm.js';
import { getEngineMode, recordWasmCall, recordFallback } from '../core/hex-engine-bridge.js';
import { classifyInsn, readU32LE } from './arm64-insn-bits.js';

export const SCRATCH_CHUNK_MAX = 1536 * 1024; // stay comfortably inside 2.5MB WASM scratch arena
const DEFAULT_DB_CHUNK = 131072; // 131072 * 8B = 1MB per WASM chunk
const FNV64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

function toU8(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return null;
}

function isArm64Arch(arch) {
  if (arch == null || arch === '') return true;
  const norm = String(arch).trim().toLowerCase();
  return norm === 'arm64' || norm === 'aarch64' || norm === 'arm64e' || norm === 'arm64_32';
}

function resolveEngineMode(opts) {
  const raw = opts?.engine ?? opts?._engine;
  if (raw != null) {
    const norm = String(raw).trim().toLowerCase();
    if (norm === 'js' || norm === 'wasm' || norm === 'auto') return norm;
  }
  return getEngineMode(opts);
}

function createScratchAllocator(ex) {
  if (typeof ex.hex_engine_scratch_reset === 'function' && typeof ex.hex_engine_scratch_alloc === 'function') {
    return {
      reset() {
        ex.hex_engine_scratch_reset();
      },
      alloc(bytes) {
        return ex.hex_engine_scratch_alloc(bytes >>> 0) >>> 0;
      },
    };
  }
  const rawBase = ex.__heap_base;
  const heapBase = typeof rawBase === 'number'
    ? rawBase
    : (rawBase && typeof rawBase.value === 'number' ? rawBase.value : 0);
  if (!heapBase || !(ex.memory instanceof WebAssembly.Memory)) return null;
  let cursor = (heapBase + 7) & ~7;
  return {
    reset() {
      cursor = (heapBase + 7) & ~7;
    },
    alloc(bytes) {
      const size = bytes >>> 0;
      const aligned = (cursor + 7) & ~7;
      const next = aligned + size;
      const memBytes = ex.memory.buffer.byteLength;
      if (next > memBytes) {
        const needPages = Math.ceil((next - memBytes) / 65536);
        try {
          ex.memory.grow(needPages);
        } catch {
          return 0;
        }
      }
      cursor = next;
      return aligned;
    },
  };
}

function getWasmExports(opts, requiredFn, needScratch = true) {
  if (resolveEngineMode(opts) === 'js') {
    recordFallback('func_fingerprint:wasm_disabled');
    return null;
  }
  if (opts?.wasmExports) {
    const ex = opts.wasmExports;
    if (typeof ex[requiredFn] !== 'function') {
      recordFallback('func_fingerprint:exports_missing');
      return null;
    }
    if (needScratch) {
      const scratch = createScratchAllocator(ex);
      if (!scratch || !(ex.memory instanceof WebAssembly.Memory)) {
        recordFallback('func_fingerprint:scratch_unavailable');
        return null;
      }
      return { ex, scratch };
    }
    return { ex, scratch: null };
  }
  if (!isWasmBulkMemorySupported()) {
    recordFallback('func_fingerprint:no_bulk_memory');
    return null;
  }
  try {
    const ex = getHexEngineExports(opts);
    if (!ex || typeof ex[requiredFn] !== 'function') {
      recordFallback('func_fingerprint:exports_missing');
      return null;
    }
    if (needScratch) {
      const scratch = createScratchAllocator(ex);
      if (!scratch || !(ex.memory instanceof WebAssembly.Memory)) {
        recordFallback('func_fingerprint:scratch_unavailable');
        return null;
      }
      return { ex, scratch };
    }
    return { ex, scratch: null };
  } catch {
    recordFallback('func_fingerprint:init_error');
    return null;
  }
}

function fnv1aU16LE(f) {
  let h = FNV64_OFFSET_BASIS;
  h = ((h ^ BigInt(f & 0xff)) * FNV64_PRIME) & MASK64;
  h = ((h ^ BigInt((f >>> 8) & 0xff)) * FNV64_PRIME) & MASK64;
  return h;
}

function popcount32(x) {
  x = x >>> 0;
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function splitSimhash64(val) {
  if (typeof val === 'bigint') {
    const u = BigInt.asUintN(64, val);
    return {
      lo: Number(u & 0xffffffffn) >>> 0,
      hi: Number((u >> 32n) & 0xffffffffn) >>> 0,
    };
  }
  if (val && typeof val === 'object') {
    if (typeof val.simhash === 'bigint') {
      return splitSimhash64(val.simhash);
    }
    return {
      lo: (val.lo ?? val.simhashLo ?? 0) >>> 0,
      hi: (val.hi ?? val.simhashHi ?? 0) >>> 0,
    };
  }
  const u = BigInt.asUintN(64, BigInt(val ?? 0));
  return {
    lo: Number(u & 0xffffffffn) >>> 0,
    hi: Number((u >> 32n) & 0xffffffffn) >>> 0,
  };
}

function fingerprintArm64FuncJs(u8, truncated) {
  const insnCount = u8.length >>> 2;
  const classCounts = new Uint32Array(12);
  const bigramBits = new Uint32Array(5);
  let uniqueBigrams = 0;
  const v = new Int32Array(64);

  let prevC = 0;
  for (let i = 0; i < insnCount; i++) {
    const w = readU32LE(u8, i << 2);
    const c = classifyInsn(w);
    if (c < 12) classCounts[c]++;

    const h1 = fnv1aU16LE(0x0100 | (c & 0xf));
    const h1Lo = Number(h1 & 0xffffffffn) >>> 0;
    const h1Hi = Number((h1 >> 32n) & 0xffffffffn) >>> 0;
    for (let b = 0; b < 32; b++) v[b] += ((h1Lo >>> b) & 1) ? 1 : -1;
    for (let b = 0; b < 32; b++) v[32 + b] += ((h1Hi >>> b) & 1) ? 1 : -1;

    if (i > 0) {
      const h2 = fnv1aU16LE(0x0200 | ((prevC & 0xf) << 4) | (c & 0xf));
      const h2Lo = Number(h2 & 0xffffffffn) >>> 0;
      const h2Hi = Number((h2 >> 32n) & 0xffffffffn) >>> 0;
      for (let b = 0; b < 32; b++) v[b] += ((h2Lo >>> b) & 1) ? 1 : -1;
      for (let b = 0; b < 32; b++) v[32 + b] += ((h2Hi >>> b) & 1) ? 1 : -1;

      if (prevC < 12 && c < 12) {
        const bgIdx = prevC * 12 + c;
        const wordIdx = bgIdx >>> 5;
        const bitMask = (1 << (bgIdx & 31)) >>> 0;
        if ((bigramBits[wordIdx] & bitMask) === 0) {
          bigramBits[wordIdx] = (bigramBits[wordIdx] | bitMask) >>> 0;
          uniqueBigrams++;
        }
      }
    }
    prevC = c;
  }

  let simhashLo = 0;
  let simhashHi = 0;
  for (let b = 0; b < 32; b++) {
    if (v[b] >= 0) simhashLo |= (1 << b);
  }
  for (let b = 0; b < 32; b++) {
    if (v[32 + b] >= 0) simhashHi |= (1 << b);
  }
  simhashLo = simhashLo >>> 0;
  simhashHi = simhashHi >>> 0;
  const simhash = (BigInt(simhashHi) << 32n) | BigInt(simhashLo);

  return {
    simhash,
    simhashLo,
    simhashHi,
    insnCount,
    uniqueBigrams,
    classCounts,
    valid: true,
    engine: 'js',
    truncated,
    unsupportedArch: false,
  };
}

export function fingerprintArm64Func(bytes, opts = {}) {
  if (!isArm64Arch(opts?.arch)) {
    return {
      simhash: 0n,
      simhashLo: 0,
      simhashHi: 0,
      insnCount: 0,
      uniqueBigrams: 0,
      classCounts: new Uint32Array(12),
      valid: false,
      engine: 'js',
      truncated: false,
      unsupportedArch: true,
    };
  }

  const u8 = toU8(bytes);
  if (!u8 || u8.length < 4) {
    return {
      simhash: 0n,
      simhashLo: 0,
      simhashHi: 0,
      insnCount: 0,
      uniqueBigrams: 0,
      classCounts: new Uint32Array(12),
      valid: false,
      engine: 'js',
      truncated: false,
      unsupportedArch: false,
    };
  }

  const truncated = u8.length > SCRATCH_CHUNK_MAX;
  const slice = truncated ? u8.subarray(0, SCRATCH_CHUNK_MAX) : u8;

  const wasm = getWasmExports(opts, 'hex_fingerprint_arm64_func', true);
  if (wasm) {
    try {
      const { ex, scratch } = wasm;
      scratch.reset();
      const inPtr = scratch.alloc(slice.length);
      const outPtr = scratch.alloc(64);
      if (inPtr && outPtr) {
        new Uint8Array(ex.memory.buffer, inPtr, slice.length).set(slice);
        const ok = ex.hex_fingerprint_arm64_func(inPtr, slice.length, outPtr) >>> 0;
        if (ok === 1) {
          const dv = new DataView(ex.memory.buffer, outPtr, 64);
          const simhashLo = dv.getUint32(0, true);
          const simhashHi = dv.getUint32(4, true);
          const insnCount = dv.getUint32(8, true);
          const uniqueBigrams = dv.getUint32(12, true);
          const classCounts = new Uint32Array(12);
          for (let i = 0; i < 12; i++) {
            classCounts[i] = dv.getUint32(16 + (i << 2), true);
          }
          const simhash = (BigInt(simhashHi) << 32n) | BigInt(simhashLo);
          recordWasmCall('func_fingerprint');
          return {
            simhash,
            simhashLo,
            simhashHi,
            insnCount,
            uniqueBigrams,
            classCounts,
            valid: true,
            engine: 'wasm',
            truncated,
            unsupportedArch: false,
          };
        }
      }
      recordFallback('func_fingerprint:wasm_failed');
    } catch {
      recordFallback('func_fingerprint:wasm_exception');
    } finally {
      wasm.scratch.reset();
    }
  }

  return fingerprintArm64FuncJs(slice, truncated);
}

export function simhashHamming64(a, b, opts = {}) {
  const pa = splitSimhash64(a);
  const pb = splitSimhash64(b);
  const wasm = getWasmExports(opts, 'hex_simhash_hamming64', false);
  if (wasm) {
    try {
      const dist = wasm.ex.hex_simhash_hamming64(pa.lo, pa.hi, pb.lo, pb.hi) >>> 0;
      recordWasmCall('func_fingerprint');
      return dist;
    } catch {
      recordFallback('func_fingerprint:wasm_exception');
    }
  }
  return popcount32((pa.lo ^ pb.lo) >>> 0) + popcount32((pa.hi ^ pb.hi) >>> 0);
}

export function matchFingerprints(querySimhash, dbSimhashes, opts = {}) {
  const maxHamming = Math.max(0, Math.min(64, Math.floor(opts?.maxHamming ?? 12)));
  const limit = Math.max(0, Math.floor(opts?.limit ?? 32));

  const isBigUint = dbSimhashes instanceof BigUint64Array;
  const dbCount = isBigUint
    ? dbSimhashes.length
    : (Array.isArray(dbSimhashes) ? dbSimhashes.length : 0);

  const wasm = getWasmExports(opts, 'hex_match_fingerprints', true);

  if (dbCount === 0 || limit === 0) {
    return {
      matches: [],
      engine: wasm ? 'wasm' : 'js',
      truncated: false,
    };
  }

  const q = splitSimhash64(querySimhash);
  const rawChunk = opts?.dbChunk != null ? Math.floor(Number(opts.dbChunk)) : DEFAULT_DB_CHUNK;
  const maxSafeChunk = Math.floor(SCRATCH_CHUNK_MAX / 8);
  const chunkSize = Number.isFinite(rawChunk) && rawChunk > 0
    ? Math.min(rawChunk, maxSafeChunk)
    : DEFAULT_DB_CHUNK;

  if (wasm) {
    try {
      const { ex, scratch } = wasm;
      const allMatches = [];
      let truncated = false;
      const probeLimit = Math.min(dbCount, limit + 1);

      for (let chunkBaseIdx = 0; chunkBaseIdx < dbCount; chunkBaseIdx += chunkSize) {
        const count = Math.min(chunkSize, dbCount - chunkBaseIdx);
        const chunkMaxOut = Math.min(count, probeLimit);
        scratch.reset();
        const dbPtr = scratch.alloc(count * 8);
        const outPtr = scratch.alloc(chunkMaxOut * 8);
        if (!dbPtr || !outPtr) {
          throw new Error('scratch_alloc_failed');
        }

        const dbDv = new DataView(ex.memory.buffer, dbPtr, count * 8);
        if (isBigUint) {
          for (let i = 0; i < count; i++) {
            const v = dbSimhashes[chunkBaseIdx + i];
            dbDv.setUint32(i << 3, Number(v & 0xffffffffn) >>> 0, true);
            dbDv.setUint32((i << 3) + 4, Number((v >> 32n) & 0xffffffffn) >>> 0, true);
          }
        } else {
          for (let i = 0; i < count; i++) {
            const pair = splitSimhash64(dbSimhashes[chunkBaseIdx + i]);
            dbDv.setUint32(i << 3, pair.lo, true);
            dbDv.setUint32((i << 3) + 4, pair.hi, true);
          }
        }

        const written = ex.hex_match_fingerprints(
          q.lo,
          q.hi,
          dbPtr,
          count,
          maxHamming,
          outPtr,
          chunkMaxOut
        ) >>> 0;

        if (written > limit) {
          truncated = true;
        }
        const take = Math.min(written, limit);
        const outDv = new DataView(ex.memory.buffer, outPtr, written * 8);
        for (let i = 0; i < take; i++) {
          const localIdx = outDv.getUint32(i << 3, true);
          const hamming = outDv.getUint32((i << 3) + 4, true);
          allMatches.push({ idx: chunkBaseIdx + localIdx, hamming });
        }
      }

      if (allMatches.length > limit) {
        truncated = true;
      }
      allMatches.sort((a, b) => (a.hamming - b.hamming) || (a.idx - b.idx));
      const matches = allMatches.length > limit ? allMatches.slice(0, limit) : allMatches;
      recordWasmCall('func_fingerprint');
      return { matches, engine: 'wasm', truncated };
    } catch {
      recordFallback('func_fingerprint:wasm_exception');
    } finally {
      wasm.scratch.reset();
    }
  }

  const allMatches = [];
  for (let i = 0; i < dbCount; i++) {
    const pair = splitSimhash64(dbSimhashes[i]);
    const hamming = popcount32((q.lo ^ pair.lo) >>> 0) + popcount32((q.hi ^ pair.hi) >>> 0);
    if (hamming <= maxHamming) {
      allMatches.push({ idx: i, hamming });
    }
  }
  const truncated = allMatches.length > limit;
  allMatches.sort((a, b) => (a.hamming - b.hamming) || (a.idx - b.idx));
  const matches = truncated ? allMatches.slice(0, limit) : allMatches;
  return { matches, engine: 'js', truncated };
}
