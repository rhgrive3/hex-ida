/**
 * Architecture-independent C++ Vtable / RTTI scanner (WASM-accelerated with
 * identical chunked JS fallback and strict-overlap interval merge).
 */
import { getHexEngineExports, isWasmBulkMemorySupported } from '../core/hex-engine-wasm.js';
import { getEngineMode, recordWasmCall, recordFallback } from '../core/hex-engine-bridge.js';

const SCRATCH_CHUNK_MAX = 1536 * 1024;
const OVERLAP = 2048; // multiple of 8
const RECORD_BYTES = 32;
const CHUNK_MAX_OUT = 16384; // 512KB/chunk (16384 * 32B)
const MAX_BISECT_DEPTH = 12;
const SAFE_MAX_OUT = 262144;
const DEFAULT_MAX_OUT = 65536;
const PAC_MASK_48 = 0x0000ffffffffffffn;
const U64_MAX = 0xffffffffffffffffn;
const TARGET_MASK_36 = 0xfffffffffn;

function toU8(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return null;
}

function encodingFromFlags(flags) {
  if ((flags & 8) !== 0) return 'relative32';
  if ((flags & 4) !== 0) return 'chained_offset';
  return 'absolute';
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

function decodeChainedOffset64Js(raw, imageBase) {
  if ((raw >> 63n) !== 0n) return null;
  if (((raw >> 44n) & 0x7fn) !== 0n) return null;
  if (((raw >> 36n) & 0xffn) !== 0n) return null;
  const target = raw & TARGET_MASK_36;
  if (target === 0n) return null;
  if (target > U64_MAX - imageBase) return null;
  return imageBase + target;
}

function resolveRelative32VaJs(dataVa, off, disp) {
  if (disp === 0) return null;
  const uoff = BigInt(off);
  if (uoff > U64_MAX - dataVa) return null;
  const slotVa = dataVa + uoff;
  if (disp < 0) {
    const mag = BigInt(-disp);
    if (mag > slotVa) return null;
    return slotVa - mag;
  }
  const pos = BigInt(disp);
  if (pos > U64_MAX - slotVa) return null;
  return slotVa + pos;
}

function scanChunkJs(
  chunk,
  chunkStart,
  textLo,
  textHi,
  imageBase,
  chunkDataVa,
  ptrSize,
  inFlags,
  minLen,
  chunkMaxOut,
) {
  const len = chunk.length;
  if (len < minLen || chunkMaxOut <= 0) return [];
  const dv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const effectiveStripPac = ((inFlags & 1) !== 0) && ptrSize === 8;
  const enableChainedOffset = ((inFlags & 2) !== 0) && ptrSize === 8 && imageBase > 0n;
  const enableRelative32 = ((inFlags & 4) !== 0) && chunkDataVa > 0n;
  const ptrMask = BigInt(ptrSize - 1);
  const out = [];

  const readRaw = (off) => (ptrSize === 8 ? dv.getBigUint64(off, true) : BigInt(dv.getUint32(off, true)));
  const normVa = (raw) => (effectiveStripPac ? (raw & PAC_MASK_48) : raw);
  const isCode = (va) => va >= textLo && va < textHi && (va & 3n) === 0n;

  // Pass 1: absolute pointers
  if (len >= ptrSize * 3 && out.length < chunkMaxOut) {
    const lastStart = len - ptrSize * 3;
    const lastSlot = len - ptrSize;
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
          encoding: 'absolute',
        });
      }

      off = runEnd;
    }
  }

  // Pass 2: DYLD_CHAINED_PTR_64_OFFSET
  if (enableChainedOffset && len >= 24 && out.length < chunkMaxOut) {
    const lastStart = len - 24;
    const lastSlot = len - 8;
    let off = 0;

    while (off <= lastStart && out.length < chunkMaxOut) {
      const raw0 = dv.getBigUint64(off, true);
      const va0 = decodeChainedOffset64Js(raw0, imageBase);
      if (va0 === null || !isCode(va0) || isCode(normVa(raw0))) {
        off += 8;
        continue;
      }

      let entryCount = 1;
      let runEnd = off + 8;

      while (runEnd <= lastSlot) {
        const rawI = dv.getBigUint64(runEnd, true);
        const vaI = decodeChainedOffset64Js(rawI, imageBase);
        if (vaI === null || !isCode(vaI) || isCode(normVa(rawI))) break;
        entryCount += 1;
        runEnd += 8;
      }

      if (entryCount >= 3) {
        let offsetToTop = 0;
        let rttiVa = 0n;
        let hasRtti = false;

        if (off >= 16) {
          const offTop = dv.getBigInt64(off - 16, true);
          const rttiRaw = dv.getBigUint64(off - 8, true);
          const candRtti = decodeChainedOffset64Js(rttiRaw, imageBase);
          const topOk = offTop >= -0x100000n && offTop <= 0n;
          const rttiOk = candRtti !== null
            && (candRtti & 7n) === 0n
            && !(candRtti >= textLo && candRtti < textHi);
          if (topOk && rttiOk) {
            hasRtti = true;
            offsetToTop = Number(offTop);
            rttiVa = candRtti;
          }
        }

        const flags = (hasRtti ? 1 : 0) | 4;
        out.push({
          vtableOff: chunkStart + off,
          entryCount,
          offsetToTop,
          hasRtti,
          pacStripped: false,
          rttiVa,
          firstFnVa: va0,
          flags,
          encoding: 'chained_offset',
        });
      }

      off = runEnd;
    }
  }

  // Pass 3: 32-bit relative vtables
  if (enableRelative32 && len >= 12 && out.length < chunkMaxOut) {
    const lastStart = len - 12;
    const lastSlot = len - 4;
    let off = 0;

    while (off <= lastStart && out.length < chunkMaxOut) {
      const disp0 = dv.getInt32(off, true);
      const va0 = resolveRelative32VaJs(chunkDataVa, off, disp0);
      if (va0 === null || !isCode(va0)) {
        off += 4;
        continue;
      }

      let entryCount = 1;
      let runEnd = off + 4;

      while (runEnd <= lastSlot) {
        const dispI = dv.getInt32(runEnd, true);
        const vaI = resolveRelative32VaJs(chunkDataVa, runEnd, dispI);
        if (vaI === null || !isCode(vaI)) break;
        entryCount += 1;
        runEnd += 4;
      }

      if (entryCount >= 3) {
        let offsetToTop = 0;
        let rttiVa = 0n;
        let hasRtti = false;

        if (off >= 8) {
          const offTop = dv.getInt32(off - 8, true);
          const rttiDisp = dv.getInt32(off - 4, true);
          const candRtti = resolveRelative32VaJs(chunkDataVa, off - 4, rttiDisp);
          const topOk = offTop >= -0x100000 && offTop <= 0;
          const rttiOk = candRtti !== null
            && candRtti !== 0n
            && (candRtti & 3n) === 0n
            && !(candRtti >= textLo && candRtti < textHi);
          if (topOk && rttiOk) {
            hasRtti = true;
            offsetToTop = offTop;
            rttiVa = candRtti;
          }
        }

        const flags = (hasRtti ? 1 : 0) | 8;
        out.push({
          vtableOff: chunkStart + off,
          entryCount,
          offsetToTop,
          hasRtti,
          pacStripped: false,
          rttiVa,
          firstFnVa: va0,
          flags,
          encoding: 'relative32',
        });
      }

      off = runEnd;
    }
  }

  return out;
}

function decodeWasmRecords(memoryBuffer, outPtr, count, chunkStart) {
  const out = new Array(count);
  const dv = new DataView(memoryBuffer, outPtr, count * RECORD_BYTES);
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
      encoding: encodingFromFlags(flags),
    };
  }
  return out;
}

function scanChunkWasm(
  ex,
  chunk,
  chunkStart,
  textLoLo,
  textLoHi,
  textHiLo,
  textHiHi,
  imageBaseLo,
  imageBaseHi,
  chunkDataVa,
  ptrSize,
  inFlags,
  useExt,
  minLen,
  chunkMaxOut,
) {
  const len = chunk.length;
  if (len < minLen || chunkMaxOut <= 0) return [];
  ex.hex_engine_scratch_reset();
  try {
    const inPtr = ex.hex_engine_scratch_alloc(len);
    const outPtr = ex.hex_engine_scratch_alloc(chunkMaxOut * RECORD_BYTES);
    if (!inPtr || !outPtr) {
      throw new Error('vtable_scanner:scratch_alloc_failed');
    }
    new Uint8Array(ex.memory.buffer, inPtr, len).set(chunk);

    let count;
    if (useExt) {
      const dataVaLo = Number(chunkDataVa & 0xffffffffn) >>> 0;
      const dataVaHi = Number((chunkDataVa >> 32n) & 0xffffffffn) >>> 0;
      count = ex.hex_scan_vtables_ext(
        inPtr,
        len,
        textLoLo,
        textLoHi,
        textHiLo,
        textHiHi,
        imageBaseLo,
        imageBaseHi,
        dataVaLo,
        dataVaHi,
        ptrSize,
        inFlags,
        outPtr,
        chunkMaxOut,
      ) >>> 0;
    } else {
      count = ex.hex_scan_vtables(
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
    }

    return decodeWasmRecords(ex.memory.buffer, outPtr, count, chunkStart);
  } finally {
    ex.hex_engine_scratch_reset();
  }
}

/**
 * Merge chunk-local vtable records across overlapping chunks.
 * Grouped by encoding (`absolute` / `chained_offset` / `relative32`).
 * Strictly overlapping intervals (`next.vtableOff < prevEnd`) are merged into
 * `[minStart, maxEnd)` preserving `minStart`-side metadata, OR-ing `pacStripped`,
 * and preserving encoding bits (`bit2`/`bit3`) in `flags`.
 * Adjacent intervals (`next.vtableOff === prevEnd`) are never merged.
 */
export function mergeVtableRuns(records, ptrSize) {
  if (!Array.isArray(records) || records.length === 0) return [];

  const groups = new Map();
  for (let i = 0; i < records.length; i += 1) {
    const r = records[i];
    const enc = r.encoding ?? ((r.flags & 8) ? 'relative32' : ((r.flags & 4) ? 'chained_offset' : 'absolute'));
    let list = groups.get(enc);
    if (!list) {
      list = [];
      groups.set(enc, list);
    }
    list.push(r);
  }

  const merged = [];
  for (const [enc, list] of groups.entries()) {
    const slotSize = enc === 'relative32' ? 4 : ptrSize;
    const sorted = list.slice().sort((a, b) => a.vtableOff - b.vtableOff);
    const groupMerged = [];

    for (let i = 0; i < sorted.length; i += 1) {
      const rec = sorted[i];
      const recEnd = rec.vtableOff + rec.entryCount * slotSize;
      if (groupMerged.length === 0) {
        groupMerged.push({ ...rec });
        continue;
      }
      const prev = groupMerged[groupMerged.length - 1];
      const prevEnd = prev.vtableOff + prev.entryCount * slotSize;
      if (rec.vtableOff < prevEnd) {
        const minStart = prev.vtableOff;
        const maxEnd = recEnd > prevEnd ? recEnd : prevEnd;
        prev.entryCount = Math.floor((maxEnd - minStart) / slotSize);
        prev.pacStripped = Boolean(prev.pacStripped || rec.pacStripped);
        const encBits = (prev.flags ?? 0) & 12;
        prev.flags = (prev.hasRtti ? 1 : 0) | (prev.pacStripped ? 2 : 0) | encBits;
      } else {
        groupMerged.push({ ...rec });
      }
    }

    for (let i = 0; i < groupMerged.length; i += 1) {
      merged.push(groupMerged[i]);
    }
  }

  merged.sort((a, b) => (a.vtableOff - b.vtableOff) || ((a.flags ?? 0) - (b.flags ?? 0)));
  return merged;
}

function computeChunkParams(requestedChunkSize, ptrSize, minLen) {
  const minChunk = minLen;
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

function runChunkedScan(u8, chunkSize, effOverlap, ptrSize, minLen, maxOut, scanChunkFn) {
  const rawRecords = [];
  const chunkMaxOut = Math.min(CHUNK_MAX_OUT, maxOut + 1);
  const alignMask = ~7;
  const minBisectLen = Math.max((effOverlap * 4) & alignMask, 256);
  let truncated = false;

  function scanRange(start, end, depth) {
    const chunkLen = end - start;
    if (chunkLen < minLen) return;

    const chunkHits = scanChunkFn(u8.subarray(start, end), start, chunkMaxOut);
    if (chunkMaxOut === CHUNK_MAX_OUT && chunkHits.length >= CHUNK_MAX_OUT) {
      const mid = (start + Math.floor(chunkLen / 2)) & alignMask;
      const leftEnd = Math.min(end, (mid + effOverlap) & alignMask);
      const rightStart = Math.max(start, (mid - effOverlap) & alignMask);
      if (depth < MAX_BISECT_DEPTH && chunkLen > minBisectLen && leftEnd < end && rightStart > start) {
        scanRange(start, leftEnd, depth + 1);
        scanRange(rightStart, end, depth + 1);
        return;
      }
    }

    if (chunkHits.length >= chunkMaxOut) {
      truncated = true;
    }
    for (let i = 0; i < chunkHits.length; i += 1) {
      rawRecords.push(chunkHits[i]);
    }
  }

  let chunkStart = 0;
  while (chunkStart < u8.length) {
    const chunkEnd = Math.min(u8.length, chunkStart + chunkSize);
    const chunkLen = chunkEnd - chunkStart;
    if (chunkLen < minLen) break;

    scanRange(chunkStart, chunkEnd, 0);
    if (chunkEnd >= u8.length) break;
    chunkStart = chunkEnd - effOverlap;
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
    imageBase: rawImageBase = 0n,
    dataVa: rawDataVa = 0n,
    chainedOffset: rawChainedOffset,
    relative32: rawRelative32,
    ptrSize: rawPtrSize = 8,
    stripPac = true,
    maxOut: rawMaxOut = DEFAULT_MAX_OUT,
    chunkSize: rawChunkSize,
  } = opts || {};

  const u8 = toU8(bytes);
  const ptrSize = Number(rawPtrSize);
  const maxOutNum = Number(rawMaxOut);
  const maxOut = Number.isFinite(maxOutNum)
    ? Math.max(0, Math.min(SAFE_MAX_OUT, Math.floor(maxOutNum)))
    : DEFAULT_MAX_OUT;

  let textLo;
  let textHi;
  let imageBase;
  let dataVa;
  try {
    textLo = BigInt(rawTextLo ?? 0n);
    textHi = BigInt(rawTextHi ?? 0n);
    imageBase = BigInt(rawImageBase ?? 0n);
    dataVa = BigInt(rawDataVa ?? 0n);
  } catch {
    return { vtables: [], engine: 'js', truncated: false };
  }

  const hasValidImageBase = imageBase > 0n && imageBase <= U64_MAX;
  const hasValidDataVa = dataVa > 0n && dataVa <= U64_MAX;
  const enableChainedOffset = Boolean((rawChainedOffset ?? hasValidImageBase) && ptrSize === 8 && hasValidImageBase);
  const enableRelative32 = Boolean((rawRelative32 ?? hasValidDataVa) && hasValidDataVa);
  const useExt = enableChainedOffset || enableRelative32;

  let ex = resolveWasmExports(opts);
  if (ex && useExt && typeof ex.hex_scan_vtables_ext !== 'function') {
    recordFallback('vtable_scanner:ext_export_missing');
    ex = null;
  }

  const minLen = enableRelative32 ? 12 : (ptrSize * 3);
  const invalid = !u8
    || (ptrSize !== 4 && ptrSize !== 8)
    || u8.length < minLen
    || textHi <= textLo
    || maxOut <= 0;
  if (invalid) {
    return { vtables: [], engine: ex ? 'wasm' : 'js', truncated: false };
  }

  const { chunkSize, overlap } = computeChunkParams(rawChunkSize, ptrSize, minLen);
  const inFlags = ((stripPac && ptrSize === 8) ? 1 : 0)
    | (enableChainedOffset ? 2 : 0)
    | (enableRelative32 ? 4 : 0);

  const computeChunkDataVa = (chunkStart) => {
    if (!enableRelative32) return 0n;
    const va = dataVa + BigInt(chunkStart);
    return va <= U64_MAX ? va : 0n;
  };

  if (ex) {
    const textLoLo = Number(textLo & 0xffffffffn) >>> 0;
    const textLoHi = Number((textLo >> 32n) & 0xffffffffn) >>> 0;
    const textHiLo = Number(textHi & 0xffffffffn) >>> 0;
    const textHiHi = Number((textHi >> 32n) & 0xffffffffn) >>> 0;
    const imageBaseLo = Number(imageBase & 0xffffffffn) >>> 0;
    const imageBaseHi = Number((imageBase >> 32n) & 0xffffffffn) >>> 0;

    try {
      const { vtables, truncated } = runChunkedScan(
        u8,
        chunkSize,
        overlap,
        ptrSize,
        minLen,
        maxOut,
        (chunk, chunkStart, chunkMaxOut) => scanChunkWasm(
          ex,
          chunk,
          chunkStart,
          textLoLo,
          textLoHi,
          textHiLo,
          textHiHi,
          imageBaseLo,
          imageBaseHi,
          computeChunkDataVa(chunkStart),
          ptrSize,
          inFlags,
          useExt,
          minLen,
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
    minLen,
    maxOut,
    (chunk, chunkStart, chunkMaxOut) => scanChunkJs(
      chunk,
      chunkStart,
      textLo,
      textHi,
      imageBase,
      computeChunkDataVa(chunkStart),
      ptrSize,
      inFlags,
      minLen,
      chunkMaxOut,
    ),
  );
  return { vtables, engine: 'js', truncated };
}
