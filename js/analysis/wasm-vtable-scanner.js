/**
 * Architecture-independent C++ Vtable / RTTI scanner (WASM-accelerated with
 * identical chunked JS fallback and strict-overlap interval merge).
 */
import { getHexEngineExports, isWasmBulkMemorySupported } from '../core/hex-engine-wasm.js';
import { getEngineMode, recordWasmCall, recordFallback } from '../core/hex-engine-bridge.js';

const SCRATCH_CHUNK_MAX = 1536 * 1024;
const OVERLAP = 2048; // multiple of 8
const RECORD_BYTES = 32;
const PAC_MASK_48 = 0x0000ffffffffffffn;

function toU8(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return null;
}

function hasRequiredVtableExports(ex) {
  return Boolean(
    ex
    && ex.memory
    && typeof ex.hex_scan_vtables === 'function'
    && typeof ex.hex_engine_scratch_alloc === 'function'
    && typeof ex.hex_engine_scratch_reset === 'function',
  );
}

function resolveWasmExports(opts) {
  const engineOpt = opts && opts.engine != null ? opts.engine : (opts && opts._engine != null ? opts._engine : null);
  const modeOpts = engineOpt != null ? { _engine: engineOpt } : null;
  if (getEngineMode(modeOpts) === 'js') {
    recordFallback('vtable_scanner:wasm_disabled');
    return null;
  }
  if (opts && opts.wasmExports) {
    if (hasRequiredVtableExports(opts.wasmExports)) {
      return opts.wasmExports;
    }
    recordFallback('vtable_scanner:injected_exports_missing');
    return null;
  }
  if (!isWasmBulkMemorySupported()) {
    recordFallback('vtable_scanner:no_bulk_memory');
    return null;
  }
  try {
    const ex = getHexEngineExports(modeOpts);
    if (!hasRequiredVtableExports(ex)) {
      recordFallback('vtable_scanner:exports_missing');
      return null;
    }
    return ex;
  } catch {
    recordFallback('vtable_scanner:init_error');
    return null;
  }
}

function scanChunkJs(chunk, chunkStart, textLo, textHi, ptrSize, stripPac, chunkMaxOut) {
  const len = chunk.length;
  if (len < ptrSize * 3 || chunkMaxOut <= 0) return [];
  const dv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const effectiveStripPac = Boolean(stripPac && ptrSize === 8);
  const lastStart = len - ptrSize * 3;
  const lastSlot = len - ptrSize;
  const ptrMask = BigInt(ptrSize - 1);
  const out = [];

  const readRaw = (off) => (ptrSize === 8 ? dv.getBigUint64(off, true) : BigInt(dv.getUint32(off, true)));
  const normVa = (raw) => (effectiveStripPac ? (raw & PAC_MASK_48) : raw);
  const isCode = (va) => va >= textLo && va < textHi && (va & 3n) === 0n;

  let off = 0;
  while (off <= lastStart && out.length < chunkMaxOut) {
    const raw0 = readRaw(off);
    const va0 = normVa(raw0);
    if (!isCode(va0)) {
      off += ptrSize;
      continue;
    }

    let entryCount = 1;
    let pacStripped = effectiveStripPac && (raw0 >> 48n) !== 0n;
    let runEnd = off + ptrSize;

    while (runEnd <= lastSlot) {
      const rawI = readRaw(runEnd);
      const vaI = normVa(rawI);
      if (!isCode(vaI)) break;
      if (effectiveStripPac && (rawI >> 48n) !== 0n) pacStripped = true;
      entryCount += 1;
      runEnd += ptrSize;
    }

    if (entryCount >= 3) {
      let offsetToTop = 0;
      let rttiVa = 0n;
      let hasRtti = false;

      if (off >= 2 * ptrSize) {
        const offTop = ptrSize === 8
          ? dv.getBigInt64(off - 16, true)
          : BigInt(dv.getInt32(off - 8, true));
        const rttiRaw = readRaw(off - ptrSize);
        const candRtti = normVa(rttiRaw);
        const topOk = offTop >= -0x100000n && offTop <= 0n;
        const rttiOk = candRtti !== 0n
          && (candRtti & ptrMask) === 0n
          && !(candRtti >= textLo && candRtti < textHi);
        if (topOk && rttiOk) {
          hasRtti = true;
          offsetToTop = Number(offTop);
          rttiVa = candRtti;
        }
      }

      const flags = (hasRtti ? 1 : 0) | (pacStripped ? 2 : 0);
      out.push({
        vtableOff: chunkStart + off,
        entryCount,
        offsetToTop,
        hasRtti,
        pacStripped,
        rttiVa,
        firstFnVa: va0,
        flags,
      });
    }

    off = runEnd;
  }

  return out;
}

function scanChunkWasm(ex, chunk, chunkStart, textLoLo, textLoHi, textHiLo, textHiHi, ptrSize, inFlags, chunkMaxOut) {
  const len = chunk.length;
  if (len < ptrSize * 3 || chunkMaxOut <= 0) return [];
  ex.hex_engine_scratch_reset();
  try {
  const inPtr = ex.hex_engine_scratch_alloc(len);
  const outPtr = ex.hex_engine_scratch_alloc(chunkMaxOut * RECORD_BYTES);
  if (!inPtr || !outPtr) {
    throw new Error('vtable_scanner:scratch_alloc_failed');
  }
  new Uint8Array(ex.memory.buffer, inPtr, len).set(chunk);
  const count = ex.hex_scan_vtables(
    inPtr,
    len,
    textLoLo,
    textLoHi,
    textHiLo,
    textHiHi,
    ptrSize,
    inFlags,
    outPtr,
    chunkMaxOut,
  ) >>> 0;

  const out = new Array(count);
  const dv = new DataView(ex.memory.buffer, outPtr, count * RECORD_BYTES);
  for (let i = 0; i < count; i += 1) {
    const base = i * RECORD_BYTES;
    const vtableOff = chunkStart + dv.getUint32(base, true);
    const entryCount = dv.getUint32(base + 4, true);
    const offsetToTop = dv.getInt32(base + 8, true);
    const flags = dv.getUint32(base + 12, true);
    const rttiLo = BigInt(dv.getUint32(base + 16, true));
    const rttiHi = BigInt(dv.getUint32(base + 20, true));
    const firstFnLo = BigInt(dv.getUint32(base + 24, true));
    const firstFnHi = BigInt(dv.getUint32(base + 28, true));
    out[i] = {
      vtableOff,
      entryCount,
      offsetToTop,
      hasRtti: (flags & 1) !== 0,
      pacStripped: (flags & 2) !== 0,
      rttiVa: (rttiHi << 32n) | rttiLo,
      firstFnVa: (firstFnHi << 32n) | firstFnLo,
      flags,
    };
  }
  return out;
  } finally {
    ex.hex_engine_scratch_reset();
  }
}

/**
 * Merge chunk-local vtable records across overlapping chunks.
 * Strictly overlapping intervals (`next.vtableOff < prevEnd`) are merged into
 * `[minStart, maxEnd)` preserving `minStart`-side metadata and OR-ing `pacStripped`.
 * Adjacent intervals (`next.vtableOff === prevEnd`) are never merged.
 */
export function mergeVtableRuns(records, ptrSize) {
  if (!Array.isArray(records) || records.length === 0) return [];
  const sorted = records.slice().sort((a, b) => a.vtableOff - b.vtableOff);
  const merged = [];

  for (let i = 0; i < sorted.length; i += 1) {
    const rec = sorted[i];
    const recEnd = rec.vtableOff + rec.entryCount * ptrSize;
    if (merged.length === 0) {
      merged.push({ ...rec });
      continue;
    }
    const prev = merged[merged.length - 1];
    const prevEnd = prev.vtableOff + prev.entryCount * ptrSize;
    if (rec.vtableOff < prevEnd) {
      const minStart = prev.vtableOff;
      const maxEnd = recEnd > prevEnd ? recEnd : prevEnd;
      prev.entryCount = Math.floor((maxEnd - minStart) / ptrSize);
      prev.pacStripped = Boolean(prev.pacStripped || rec.pacStripped);
      prev.flags = (prev.hasRtti ? 1 : 0) | (prev.pacStripped ? 2 : 0);
    } else {
      merged.push({ ...rec });
    }
  }

  return merged;
}

function computeChunkParams(requestedChunkSize, ptrSize) {
  const minChunk = ptrSize * 3;
  let chunkSize = SCRATCH_CHUNK_MAX;
  if (requestedChunkSize != null && Number.isFinite(Number(requestedChunkSize))) {
    const req = Math.floor(Number(requestedChunkSize));
    if (req >= minChunk) {
      chunkSize = Math.min(SCRATCH_CHUNK_MAX, req);
    }
  }
  // Align chunkSize down to a multiple of 8 (or ptrSize when smaller) so chunk starts stay aligned.
  const align = chunkSize >= 8 ? 8 : ptrSize;
  chunkSize = Math.max(minChunk, Math.floor(chunkSize / align) * align);

  let overlap = OVERLAP;
  if (overlap >= chunkSize) {
    overlap = Math.floor(chunkSize / 2);
    overlap = Math.floor(overlap / align) * align;
    if (overlap >= chunkSize) overlap = 0;
  }
  return { chunkSize, overlap };
}

function runChunkedScan(u8, chunkSize, overlap, ptrSize, maxOut, scanChunkFn) {
  const rawRecords = [];
  const chunkMaxOut = maxOut + 1;
  let truncated = false;
  let chunkStart = 0;

  while (chunkStart < u8.length) {
    const chunkEnd = Math.min(u8.length, chunkStart + chunkSize);
    const chunkLen = chunkEnd - chunkStart;
    if (chunkLen < ptrSize * 3) break;

    const hits = scanChunkFn(u8.subarray(chunkStart, chunkEnd), chunkStart, chunkMaxOut);
    if (hits.length > maxOut) {
      truncated = true;
    }
    for (let i = 0; i < hits.length; i += 1) {
      rawRecords.push(hits[i]);
    }
    if (chunkEnd >= u8.length) break;
    chunkStart = chunkEnd - overlap;
  }

  const merged = mergeVtableRuns(rawRecords, ptrSize);
  if (merged.length > maxOut) {
    merged.length = maxOut;
    truncated = true;
  }
  return { vtables: merged, truncated };
}

export function scanVtables(bytes, opts = {}) {
  const {
    textLo: rawTextLo = 0n,
    textHi: rawTextHi = 0n,
    ptrSize: rawPtrSize = 8,
    stripPac = true,
    maxOut: rawMaxOut = 4096,
    chunkSize: rawChunkSize,
  } = opts || {};

  const u8 = toU8(bytes);
  const ptrSize = Number(rawPtrSize);
  const maxOut = Number.isFinite(Number(rawMaxOut)) ? Math.floor(Number(rawMaxOut)) : 4096;
  let textLo;
  let textHi;
  try {
    textLo = BigInt(rawTextLo ?? 0n);
    textHi = BigInt(rawTextHi ?? 0n);
  } catch {
    return { vtables: [], engine: 'js', truncated: false };
  }

  const ex = resolveWasmExports(opts);
  const invalid = !u8
    || (ptrSize !== 4 && ptrSize !== 8)
    || u8.length < ptrSize * 3
    || textHi <= textLo
    || maxOut <= 0;
  if (invalid) {
    return { vtables: [], engine: ex ? 'wasm' : 'js', truncated: false };
  }

  const { chunkSize, overlap } = computeChunkParams(rawChunkSize, ptrSize);

  if (ex) {
    const textLoLo = Number(textLo & 0xffffffffn) >>> 0;
    const textLoHi = Number((textLo >> 32n) & 0xffffffffn) >>> 0;
    const textHiLo = Number(textHi & 0xffffffffn) >>> 0;
    const textHiHi = Number((textHi >> 32n) & 0xffffffffn) >>> 0;
    const inFlags = (stripPac && ptrSize === 8) ? 1 : 0;

    try {
      const { vtables, truncated } = runChunkedScan(
        u8,
        chunkSize,
        overlap,
        ptrSize,
        maxOut,
        (chunk, chunkStart, chunkMaxOut) => scanChunkWasm(
          ex,
          chunk,
          chunkStart,
          textLoLo,
          textLoHi,
          textHiLo,
          textHiHi,
          ptrSize,
          inFlags,
          chunkMaxOut,
        ),
      );
      recordWasmCall('vtable_scanner');
      return { vtables, engine: 'wasm', truncated };
    } catch {
      recordFallback('vtable_scanner:wasm_exception');
    }
  }

  const { vtables, truncated } = runChunkedScan(
    u8,
    chunkSize,
    overlap,
    ptrSize,
    maxOut,
    (chunk, chunkStart, chunkMaxOut) => scanChunkJs(
      chunk,
      chunkStart,
      textLo,
      textHi,
      ptrSize,
      stripPac,
      chunkMaxOut,
    ),
  );
  return { vtables, engine: 'js', truncated };
}
