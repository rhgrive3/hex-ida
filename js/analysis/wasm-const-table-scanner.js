/**
 * Constant array / IEEE-754 float (f32/f64) table / strided struct ID table
 * scanner (WASM-accelerated with exact-parity JS fallback).
 */
import { getHexEngineExports, isWasmBulkMemorySupported } from '../core/hex-engine-wasm.js';
import { getEngineMode, recordWasmCall, recordFallback } from '../core/hex-engine-bridge.js';

export const SCRATCH_CHUNK_MAX = 1536 * 1024;
export const OVERLAP = 1024; // multiple of 8

const SAFE_MAX_OUT = 262144;
const CHUNK_MAX_OUT = 4096; // 64KB/chunk (4096 * 16B)
const DEFAULT_MAX_OUT = 32768;
const STRIDED_ID_STRIDES = Object.freeze([8, 12, 16, 20, 24, 32, 40, 48, 64]);
const RECORD_BYTES = 16;

function toU8(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return null;
}

function resolveWasmExports(opts) {
  const requested = opts && opts.engine != null
    ? String(opts.engine).trim().toLowerCase()
    : getEngineMode(opts);
  if (requested === 'js') {
    recordFallback('const_table_scanner:wasm_disabled');
    return null;
  }
  if (opts && opts.wasmExports) {
    const ex = opts.wasmExports;
    if (typeof ex.hex_scan_const_tables === 'function' && ex.memory && ex.memory.buffer) {
      return ex;
    }
    recordFallback('const_table_scanner:custom_exports_invalid');
    return null;
  }
  if (!isWasmBulkMemorySupported()) {
    recordFallback('const_table_scanner:no_bulk_memory');
    return null;
  }
  try {
    const ex = getHexEngineExports(opts);
    if (!ex || typeof ex.hex_scan_const_tables !== 'function' || !ex.memory || !ex.memory.buffer) {
      recordFallback('const_table_scanner:exports_missing');
      return null;
    }
    return ex;
  } catch {
    recordFallback('const_table_scanner:init_error');
    return null;
  }
}

function loadU32Le(u8, off) {
  return (u8[off] | (u8[off + 1] << 8) | (u8[off + 2] << 16) | (u8[off + 3] << 24)) >>> 0;
}

function isAsciiByte(b) {
  return (b >= 0x20 && b <= 0x7e) || b === 0x00 || b === 0x09 || b === 0x0a || b === 0x0d;
}

function isAsciiRange(u8, startOff, byteLen) {
  const end = startOff + byteLen;
  for (let i = startOff; i < end; i++) {
    if (!isAsciiByte(u8[i])) return false;
  }
  return true;
}

function scanChunkJs(u8, chunkStart, chunkLen, maxOut) {
  if (chunkLen < 16 || maxOut <= 0) return [];
  const hits = [];

  // Pass 1: f32 table (kind=1, elemSize=4, stride=4), 4B aligned
  {
    const limit4 = chunkLen - 4;
    let off = 0;
    while (off <= limit4) {
      const u0 = loadU32Le(u8, chunkStart + off);
      const e0 = (u0 >>> 23) & 0xff;
      if (e0 < 102 || e0 > 150) {
        off += 4;
        continue;
      }
      let runEnd = off + 4;
      let allSame = true;
      while (runEnd <= limit4) {
        const u = loadU32Le(u8, chunkStart + runEnd);
        const e = (u >>> 23) & 0xff;
        if (e < 102 || e > 150) break;
        if (u !== u0) allSame = false;
        runEnd += 4;
      }
      const byteLen = runEnd - off;
      const elementCount = byteLen >>> 2;
      if (elementCount >= 4 && !allSame && !isAsciiRange(u8, chunkStart + off, byteLen)) {
        hits.push({
          startOff: chunkStart + off,
          byteLen,
          elementCount,
          kind: 1,
          elemSize: 4,
          stride: 4,
        });
        if (hits.length === maxOut) return hits;
      }
      off = runEnd;
    }
  }

  // Pass 2: f64 table (kind=2, elemSize=8, stride=8), 8B aligned
  {
    const limit8 = chunkLen - 8;
    let off = 0;
    while (off <= limit8) {
      const lo0 = loadU32Le(u8, chunkStart + off);
      const hi0 = loadU32Le(u8, chunkStart + off + 4);
      const e0 = (hi0 >>> 20) & 0x7ff;
      if (e0 < 998 || e0 > 1046) {
        off += 8;
        continue;
      }
      let runEnd = off + 8;
      let allSame = true;
      while (runEnd <= limit8) {
        const lo = loadU32Le(u8, chunkStart + runEnd);
        const hi = loadU32Le(u8, chunkStart + runEnd + 4);
        const e = (hi >>> 20) & 0x7ff;
        if (e < 998 || e > 1046) break;
        if (lo !== lo0 || hi !== hi0) allSame = false;
        runEnd += 8;
      }
      const byteLen = runEnd - off;
      const elementCount = byteLen >>> 3;
      if (elementCount >= 4 && !allSame && !isAsciiRange(u8, chunkStart + off, byteLen)) {
        hits.push({
          startOff: chunkStart + off,
          byteLen,
          elementCount,
          kind: 2,
          elemSize: 8,
          stride: 8,
        });
        if (hits.length === maxOut) return hits;
      }
      off = runEnd;
    }
  }

  // Pass 3: strided_id table (kind=3, elemSize=4), 4B aligned per stride
  {
    const recordedStridedStarts = new Set();
    for (let si = 0; si < STRIDED_ID_STRIDES.length; si++) {
      const stride = STRIDED_ID_STRIDES[si];
      const minBytes = stride * 6;
      if (chunkLen < minBytes) continue;
      const maxStart = chunkLen - minBytes;
      const maxElemPos = chunkLen - stride;
      let off = 0;
      while (off <= maxStart) {
        const id0 = loadU32Le(u8, chunkStart + off);
        if (id0 > 10000) {
          off += 4;
          continue;
        }
        let elementCount = 1;
        let pos = off + stride;
        while (pos <= maxElemPos) {
          if (loadU32Le(u8, chunkStart + pos) !== ((id0 + elementCount) >>> 0)) break;
          elementCount++;
          pos += stride;
        }
        if (elementCount >= 6) {
          if (!recordedStridedStarts.has(off)) {
            const byteLen = elementCount * stride;
            recordedStridedStarts.add(off);
            hits.push({
              startOff: chunkStart + off,
              byteLen,
              elementCount,
              kind: 3,
              elemSize: 4,
              stride,
            });
            if (hits.length === maxOut) return hits;
            off += byteLen;
            continue;
          }
        }
        off += 4;
      }
    }
  }

  return hits;
}

function allocWasmBuffers(ex, chunkLen, outBytes) {
  if (typeof ex.hex_engine_scratch_reset === 'function' && typeof ex.hex_engine_scratch_alloc === 'function') {
    ex.hex_engine_scratch_reset();
    const inPtr = ex.hex_engine_scratch_alloc(chunkLen) >>> 0;
    const outPtr = ex.hex_engine_scratch_alloc(outBytes) >>> 0;
    if (!inPtr || !outPtr) throw new Error('scratch_alloc_failed');
    return { inPtr, outPtr };
  }
  const rawHeapBase = ex.__heap_base;
  const heapBase = (typeof rawHeapBase === 'object' && rawHeapBase !== null && 'value' in rawHeapBase)
    ? Number(rawHeapBase.value)
    : (typeof rawHeapBase === 'number' ? rawHeapBase : 65536);
  const inPtr = (heapBase + 15) & ~15;
  const outPtr = (inPtr + chunkLen + 15) & ~15;
  const needed = outPtr + outBytes;
  if (needed > ex.memory.buffer.byteLength) {
    const growPages = Math.ceil((needed - ex.memory.buffer.byteLength) / 65536);
    ex.memory.grow(growPages);
  }
  return { inPtr, outPtr };
}

function scanChunkWasm(ex, u8, chunkStart, chunkLen, maxOut) {
  if (chunkLen < 16 || maxOut <= 0) return [];
  const outBytes = maxOut * RECORD_BYTES;
  try {
  const { inPtr, outPtr } = allocWasmBuffers(ex, chunkLen, outBytes);
  new Uint8Array(ex.memory.buffer, inPtr, chunkLen).set(u8.subarray(chunkStart, chunkStart + chunkLen));
  const count = ex.hex_scan_const_tables(inPtr, chunkLen, outPtr, maxOut) >>> 0;
  const view = new DataView(ex.memory.buffer, outPtr, count * RECORD_BYTES);
  const hits = new Array(count);
  for (let i = 0; i < count; i++) {
    const base = i * RECORD_BYTES;
    hits[i] = {
      startOff: chunkStart + view.getUint32(base + 0, true),
      byteLen: view.getUint32(base + 4, true),
      elementCount: view.getUint32(base + 8, true),
      kind: view.getUint8(base + 12),
      elemSize: view.getUint8(base + 13),
      stride: view.getUint16(base + 14, true),
    };
  }
  return hits;
  } finally {
    if (typeof ex.hex_engine_scratch_reset === 'function') ex.hex_engine_scratch_reset();
  }
}

function mergeChunkTables(rawTables) {
  if (rawTables.length <= 1) return rawTables.slice();

  // Group by (kind, stride, phase) where phase = kind === 3 ? startOff % stride : 0
  const groups = new Map();
  for (let i = 0; i < rawTables.length; i++) {
    const t = rawTables[i];
    const phase = t.kind === 3 ? (t.startOff % t.stride) : 0;
    const key = `${t.kind}:${t.stride}:${phase}`;
    let list = groups.get(key);
    if (!list) {
      list = [];
      groups.set(key, list);
    }
    list.push(t);
  }

  const merged = [];
  for (const list of groups.values()) {
    list.sort((a, b) => (a.startOff - b.startOff) || (a.byteLen - b.byteLen));
    let cur = { ...list[0] };
    let curEnd = cur.startOff + cur.byteLen;
    for (let i = 1; i < list.length; i++) {
      const next = list[i];
      const nextEnd = next.startOff + next.byteLen;
      // Merge ONLY strictly overlapping ranges (next.startOff < prevEnd)
      if (next.startOff < curEnd) {
        const minStart = Math.min(cur.startOff, next.startOff);
        const maxEnd = Math.max(curEnd, nextEnd);
        const byteLen = maxEnd - minStart;
        const unit = cur.kind === 3 ? cur.stride : cur.elemSize;
        cur = {
          startOff: minStart,
          byteLen,
          elementCount: Math.floor(byteLen / unit),
          kind: cur.kind,
          elemSize: cur.elemSize,
          stride: cur.stride,
        };
        curEnd = maxEnd;
      } else {
        merged.push(cur);
        cur = { ...next };
        curEnd = nextEnd;
      }
    }
    merged.push(cur);
  }

  merged.sort((a, b) => (a.kind - b.kind) || (a.stride - b.stride) || (a.startOff - b.startOff));
  return merged;
}

function resolveChunkParams(chunkSizeOpt) {
  const raw = Number.isFinite(chunkSizeOpt) && chunkSizeOpt >= 16
    ? Math.floor(chunkSizeOpt)
    : SCRATCH_CHUNK_MAX;
  const effChunkSize = Math.max(16, Math.min(SCRATCH_CHUNK_MAX, raw & ~7));
  const effOverlap = effChunkSize > OVERLAP
    ? OVERLAP
    : Math.max(8, Math.min(OVERLAP, (effChunkSize >>> 1) & ~7));
  return { effChunkSize, effOverlap };
}

function runChunkedScan(u8, maxOut, effChunkSize, effOverlap, scanChunkFn) {
  const rawTables = [];
  let truncated = false;
  let chunkStart = 0;
  const chunkMaxOut = Math.min(CHUNK_MAX_OUT, maxOut + 1);

  while (chunkStart < u8.length) {
    const chunkEnd = Math.min(u8.length, chunkStart + effChunkSize);
    const chunkLen = chunkEnd - chunkStart;
    if (chunkLen < 16) break;
    const chunkHits = scanChunkFn(u8, chunkStart, chunkLen, chunkMaxOut);
    if (chunkHits.length >= chunkMaxOut) truncated = true;
    for (let i = 0; i < chunkHits.length; i++) {
      rawTables.push(chunkHits[i]);
    }
    if (chunkEnd >= u8.length) break;
    chunkStart = chunkEnd - effOverlap;
  }

  const merged = mergeChunkTables(rawTables);
  if (merged.length > maxOut) {
    merged.length = maxOut;
    truncated = true;
  }
  return { tables: merged, truncated };
}

export function scanConstTables(bytes, opts = {}) {
  const u8 = toU8(bytes);
  const rawMaxOut = opts?.maxOut;
  const maxOut = (rawMaxOut != null && rawMaxOut !== '' && Number.isFinite(Number(rawMaxOut)))
    ? Math.max(0, Math.min(SAFE_MAX_OUT, Math.floor(Number(rawMaxOut))))
    : DEFAULT_MAX_OUT;
  const ex = resolveWasmExports(opts);

  if (!u8 || u8.length < 16 || maxOut <= 0) {
    return { tables: [], engine: ex ? 'wasm' : 'js', truncated: false };
  }

  const { effChunkSize, effOverlap } = resolveChunkParams(opts?.chunkSize);

  if (ex) {
    try {
      const res = runChunkedScan(u8, maxOut, effChunkSize, effOverlap, (buf, start, len, limit) =>
        scanChunkWasm(ex, buf, start, len, limit));
      recordWasmCall('const_table_scanner');
      return { tables: res.tables, engine: 'wasm', truncated: res.truncated };
    } catch {
      recordFallback('const_table_scanner:wasm_exception');
    }
  }

  const res = runChunkedScan(u8, maxOut, effChunkSize, effOverlap, scanChunkJs);
  return { tables: res.tables, engine: 'js', truncated: res.truncated };
}
