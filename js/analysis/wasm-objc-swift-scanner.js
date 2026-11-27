/**
 * Objective-C / Swift 5 metadata WASM scanner with 100% parity JS fallback.
 */
import { getHexEngineExports, isWasmBulkMemorySupported } from '../core/hex-engine-wasm.js';
import { getEngineMode, recordWasmCall, recordFallback } from '../core/hex-engine-bridge.js';

const SCRATCH_CHUNK_MAX = 1536 * 1024;
const PTR_CHUNK_MAX = 512 * 1024;
const REL32_CHUNK_MAX = 256 * 1024;
const FIELDMD_CHUNK_MAX_OUT = 16384;
const PTR_RECORD_BYTES = 16;
const REL32_RECORD_BYTES = 16;
const FIELDMD_RECORD_BYTES = 24;
const SAFE_MAX_OUT = 262144;
const DEFAULT_MAX_OUT = 65536;
const PAC_MASK_48 = 0x0000ffffffffffffn;
const TARGET_MASK_36 = 0xfffffffffn;
const U64_MAX = 0xffffffffffffffffn;

function toU8(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return null;
}

function clampMaxOut(rawMaxOut) {
  const n = Number(rawMaxOut);
  return Number.isFinite(n) ? Math.max(0, Math.min(SAFE_MAX_OUT, Math.floor(n))) : DEFAULT_MAX_OUT;
}

function toBigIntSafe(value, fallback = 0n) {
  if (value == null) return fallback;
  try {
    const v = BigInt(value);
    return v >= 0n && v <= U64_MAX ? v : null;
  } catch {
    return null;
  }
}

function ptrEncodingFromFlags(flags) {
  if ((flags & 4) !== 0) return 'chained_vmaddr';
  if ((flags & 2) !== 0) return 'chained_offset';
  if ((flags & 1) !== 0) return 'pac';
  return 'raw';
}

function resolveWasmExports(opts, requiredFnName, metricTag) {
  const engineOpt = opts && opts.engine != null ? opts.engine : (opts && opts._engine != null ? opts._engine : null);
  const modeOpts = engineOpt != null ? { _engine: engineOpt } : null;
  if (getEngineMode(modeOpts) === 'js') {
    recordFallback(`${metricTag}:wasm_disabled`);
    return null;
  }
  const hasRequired = (ex) => Boolean(
    ex
    && ex.memory
    && typeof ex[requiredFnName] === 'function'
    && typeof ex.hex_engine_scratch_alloc === 'function'
    && typeof ex.hex_engine_scratch_reset === 'function',
  );
  if (opts && opts.wasmExports) {
    if (hasRequired(opts.wasmExports)) {
      return opts.wasmExports;
    }
    recordFallback(`${metricTag}:injected_exports_missing`);
    return null;
  }
  if (!isWasmBulkMemorySupported()) {
    recordFallback(`${metricTag}:no_bulk_memory`);
    return null;
  }
  try {
    const ex = getHexEngineExports(modeOpts);
    if (!hasRequired(ex)) {
      recordFallback(`${metricTag}:exports_missing`);
      return null;
    }
    return ex;
  } catch {
    recordFallback(`${metricTag}:init_error`);
    return null;
  }
}

function resolveRel32VaJs(secVa, off, disp) {
  if (disp === 0) return null;
  const uoff = BigInt(off);
  if (uoff > U64_MAX - secVa) return null;
  const slotVa = secVa + uoff;
  if (disp < 0) {
    const mag = BigInt(-disp);
    if (mag > slotVa) return null;
    return slotVa - mag;
  }
  const pos = BigInt(disp);
  if (pos > U64_MAX - slotVa) return null;
  return slotVa + pos;
}

function alignChunkSize(requestedChunkSize, defaultMax, align, minSize) {
  let size = defaultMax;
  if (requestedChunkSize != null && Number.isFinite(Number(requestedChunkSize))) {
    const req = Math.floor(Number(requestedChunkSize));
    if (req >= minSize) {
      size = Math.min(defaultMax, req);
    }
  }
  return Math.max(minSize, Math.floor(size / align) * align);
}

// ---------------------------------------------------------------------------
// 1. Objective-C pointer list scanner
// ---------------------------------------------------------------------------

function scanObjcPtrChunkJs(chunk, chunkStart, imageBase, inFlags, maxOut) {
  const slots = chunk.length >>> 3;
  if (slots === 0 || maxOut <= 0) return [];
  const dv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const stripPac = (inFlags & 1) !== 0;
  const allowChainedOffset = (inFlags & 2) !== 0;
  const allowChainedVmaddr = (inFlags & 4) !== 0;
  const anyChained = (inFlags & 6) !== 0;
  const out = [];

  for (let i = 0; i < slots && out.length < maxOut; i += 1) {
    const off = i * 8;
    const raw = dv.getBigUint64(off, true);
    if (raw === 0n) continue;

    if (anyChained && (raw >> 63n) === 1n) {
      continue;
    }

    let va = 0n;
    let outFlags = 0;
    const chainedHiZero = ((raw >> 44n) & 0x7fn) === 0n && ((raw >> 36n) & 0xffn) === 0n;
    const target = raw & TARGET_MASK_36;

    if (allowChainedOffset && imageBase > 0n
      && chainedHiZero && target !== 0n
      && target < imageBase && target <= U64_MAX - imageBase) {
      va = imageBase + target;
      outFlags = 2;
    } else if (allowChainedVmaddr
      && chainedHiZero && target !== 0n
      && target >= imageBase) {
      va = target;
      outFlags = 4;
    } else if (stripPac) {
      va = raw & PAC_MASK_48;
      outFlags = va !== raw ? 1 : 0;
    } else {
      va = raw;
      outFlags = 0;
    }

    if (va !== 0n && (va & 3n) === 0n) {
      out.push({
        slotOff: chunkStart + off,
        targetVa: va,
        flags: outFlags,
        encoding: ptrEncodingFromFlags(outFlags),
        pacStripped: (outFlags & 1) !== 0,
      });
    }
  }

  return out;
}

function scanObjcPtrChunkWasm(ex, chunk, chunkStart, imageBaseLo, imageBaseHi, inFlags, maxOut) {
  const len = chunk.length;
  if (len < 8 || maxOut <= 0) return [];
  ex.hex_engine_scratch_reset();
  try {
    const inPtr = ex.hex_engine_scratch_alloc(len);
    const outPtr = ex.hex_engine_scratch_alloc(maxOut * PTR_RECORD_BYTES);
    if (!inPtr || !outPtr) {
      throw new Error('objc_ptr_scanner:scratch_alloc_failed');
    }
    new Uint8Array(ex.memory.buffer, inPtr, len).set(chunk);
    const count = ex.hex_scan_objc_ptr_list(
      inPtr,
      len,
      imageBaseLo,
      imageBaseHi,
      inFlags >>> 0,
      outPtr,
      maxOut >>> 0,
    ) >>> 0;

    const out = new Array(count);
    const dv = new DataView(ex.memory.buffer, outPtr, count * PTR_RECORD_BYTES);
    for (let i = 0; i < count; i += 1) {
      const base = i * PTR_RECORD_BYTES;
      const slotOff = chunkStart + dv.getUint32(base, true);
      const flags = dv.getUint32(base + 4, true);
      const vaLo = BigInt(dv.getUint32(base + 8, true));
      const vaHi = BigInt(dv.getUint32(base + 12, true));
      out[i] = {
        slotOff,
        targetVa: (vaHi << 32n) | vaLo,
        flags,
        encoding: ptrEncodingFromFlags(flags),
        pacStripped: (flags & 1) !== 0,
      };
    }
    return out;
  } finally {
    ex.hex_engine_scratch_reset();
  }
}

export function scanObjcPtrList(bytes, opts = {}) {
  const {
    imageBase: rawImageBase = 0n,
    stripPac = true,
    allowChainedOffset: rawAllowChainedOffset,
    allowChainedVmaddr = false,
    inFlags: rawInFlags,
    maxOut: rawMaxOut = DEFAULT_MAX_OUT,
    chunkSize: rawChunkSize,
  } = opts || {};

  const u8 = toU8(bytes);
  const maxOut = clampMaxOut(rawMaxOut);
  const imageBase = toBigIntSafe(rawImageBase, 0n);
  if (imageBase === null) {
    return { entries: [], engine: 'js', truncated: false };
  }

  const ex = resolveWasmExports(opts, 'hex_scan_objc_ptr_list', 'objc_ptr_scanner');
  if (!u8 || u8.length < 8 || maxOut <= 0) {
    return { entries: [], engine: ex ? 'wasm' : 'js', truncated: false };
  }

  const allowChainedOffset = rawAllowChainedOffset != null
    ? Boolean(rawAllowChainedOffset)
    : imageBase > 0n;
  const inFlags = rawInFlags != null
    ? (Number(rawInFlags) >>> 0)
    : ((stripPac ? 1 : 0) | (allowChainedOffset ? 2 : 0) | (allowChainedVmaddr ? 4 : 0));

  const chunkSize = alignChunkSize(rawChunkSize, PTR_CHUNK_MAX, 8, 8);

  const runChunks = (scanChunkFn) => {
    const entries = [];
    let truncated = false;
    for (let chunkStart = 0; chunkStart < u8.length; chunkStart += chunkSize) {
      const chunkEnd = Math.min(u8.length, chunkStart + chunkSize);
      const chunkLen = chunkEnd - chunkStart;
      if (chunkLen < 8) break;
      const remaining = maxOut - entries.length;
      const maxSlotsInChunk = chunkLen >>> 3;
      const chunkMaxOut = Math.min(maxSlotsInChunk, remaining + 1);
      const hits = scanChunkFn(u8.subarray(chunkStart, chunkEnd), chunkStart, chunkMaxOut);
      for (let i = 0; i < hits.length; i += 1) {
        if (entries.length >= maxOut) {
          truncated = true;
          break;
        }
        entries.push(hits[i]);
      }
      if (truncated) break;
    }
    return { entries, truncated };
  };

  if (ex) {
    const imageBaseLo = Number(imageBase & 0xffffffffn) >>> 0;
    const imageBaseHi = Number((imageBase >> 32n) & 0xffffffffn) >>> 0;
    try {
      const { entries, truncated } = runChunks((chunk, chunkStart, chunkMaxOut) => scanObjcPtrChunkWasm(
        ex,
        chunk,
        chunkStart,
        imageBaseLo,
        imageBaseHi,
        inFlags,
        chunkMaxOut,
      ));
      recordWasmCall('objc_ptr_scanner');
      return { entries, engine: 'wasm', truncated };
    } catch {
      recordFallback('objc_ptr_scanner:wasm_exception');
    }
  }

  const { entries, truncated } = runChunks((chunk, chunkStart, chunkMaxOut) => scanObjcPtrChunkJs(
    chunk,
    chunkStart,
    imageBase,
    inFlags,
    chunkMaxOut,
  ));
  return { entries, engine: 'js', truncated };
}

// ---------------------------------------------------------------------------
// 2. Swift 5 rel32 list scanner
// ---------------------------------------------------------------------------

function scanSwift5Rel32ChunkJs(chunk, chunkStart, chunkSecVa, inFlags, maxOut) {
  const slots = chunk.length >>> 2;
  if (slots === 0 || maxOut <= 0) return [];
  const dv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const allowIndirect = (inFlags & 1) !== 0;
  const out = [];

  for (let i = 0; i < slots && out.length < maxOut; i += 1) {
    const off = i * 4;
    const disp = dv.getInt32(off, true);
    const isIndirect = allowIndirect && ((disp & 1) !== 0);
    const effDisp = allowIndirect ? (disp & ~1) : disp;
    if (effDisp === 0) continue;

    const targetVa = resolveRel32VaJs(chunkSecVa, off, effDisp);
    if (targetVa === null) continue;

    out.push({
      slotOff: chunkStart + off,
      targetVa,
      flags: isIndirect ? 1 : 0,
      indirect: isIndirect,
    });
  }

  return out;
}

function scanSwift5Rel32ChunkWasm(ex, chunk, chunkStart, chunkSecVa, inFlags, maxOut) {
  const len = chunk.length;
  if (len < 4 || maxOut <= 0) return [];
  ex.hex_engine_scratch_reset();
  try {
    const inPtr = ex.hex_engine_scratch_alloc(len);
    const outPtr = ex.hex_engine_scratch_alloc(maxOut * REL32_RECORD_BYTES);
    if (!inPtr || !outPtr) {
      throw new Error('swift5_rel32_scanner:scratch_alloc_failed');
    }
    new Uint8Array(ex.memory.buffer, inPtr, len).set(chunk);
    const secVaLo = Number(chunkSecVa & 0xffffffffn) >>> 0;
    const secVaHi = Number((chunkSecVa >> 32n) & 0xffffffffn) >>> 0;
    const count = ex.hex_scan_swift5_rel32_list(
      inPtr,
      len,
      secVaLo,
      secVaHi,
      inFlags >>> 0,
      outPtr,
      maxOut >>> 0,
    ) >>> 0;

    const out = new Array(count);
    const dv = new DataView(ex.memory.buffer, outPtr, count * REL32_RECORD_BYTES);
    for (let i = 0; i < count; i += 1) {
      const base = i * REL32_RECORD_BYTES;
      const slotOff = chunkStart + dv.getUint32(base, true);
      const flags = dv.getUint32(base + 4, true);
      const vaLo = BigInt(dv.getUint32(base + 8, true));
      const vaHi = BigInt(dv.getUint32(base + 12, true));
      out[i] = {
        slotOff,
        targetVa: (vaHi << 32n) | vaLo,
        flags,
        indirect: (flags & 1) !== 0,
      };
    }
    return out;
  } finally {
    ex.hex_engine_scratch_reset();
  }
}

export function scanSwift5Rel32List(bytes, opts = {}) {
  const {
    secVa: rawSecVa = 0n,
    allowIndirect = false,
    inFlags: rawInFlags,
    maxOut: rawMaxOut = DEFAULT_MAX_OUT,
    chunkSize: rawChunkSize,
  } = opts || {};

  const u8 = toU8(bytes);
  const maxOut = clampMaxOut(rawMaxOut);
  const secVa = toBigIntSafe(rawSecVa, 0n);
  if (secVa === null) {
    return { entries: [], engine: 'js', truncated: false };
  }

  const ex = resolveWasmExports(opts, 'hex_scan_swift5_rel32_list', 'swift5_rel32_scanner');
  if (!u8 || u8.length < 4 || maxOut <= 0) {
    return { entries: [], engine: ex ? 'wasm' : 'js', truncated: false };
  }

  const inFlags = rawInFlags != null ? (Number(rawInFlags) >>> 0) : (allowIndirect ? 1 : 0);
  const chunkSize = alignChunkSize(rawChunkSize, REL32_CHUNK_MAX, 4, 4);

  const runChunks = (scanChunkFn) => {
    const entries = [];
    let truncated = false;
    for (let chunkStart = 0; chunkStart < u8.length; chunkStart += chunkSize) {
      const chunkEnd = Math.min(u8.length, chunkStart + chunkSize);
      const chunkLen = chunkEnd - chunkStart;
      if (chunkLen < 4) break;
      const chunkSecVa = secVa + BigInt(chunkStart);
      if (chunkSecVa > U64_MAX) break;
      const remaining = maxOut - entries.length;
      const maxSlotsInChunk = chunkLen >>> 2;
      const chunkMaxOut = Math.min(maxSlotsInChunk, remaining + 1);
      const hits = scanChunkFn(u8.subarray(chunkStart, chunkEnd), chunkStart, chunkSecVa, chunkMaxOut);
      for (let i = 0; i < hits.length; i += 1) {
        if (entries.length >= maxOut) {
          truncated = true;
          break;
        }
        entries.push(hits[i]);
      }
      if (truncated) break;
    }
    return { entries, truncated };
  };

  if (ex) {
    try {
      const { entries, truncated } = runChunks((chunk, chunkStart, chunkSecVa, chunkMaxOut) => scanSwift5Rel32ChunkWasm(
        ex,
        chunk,
        chunkStart,
        chunkSecVa,
        inFlags,
        chunkMaxOut,
      ));
      recordWasmCall('swift5_rel32_scanner');
      return { entries, engine: 'wasm', truncated };
    } catch {
      recordFallback('swift5_rel32_scanner:wasm_exception');
    }
  }

  const { entries, truncated } = runChunks((chunk, chunkStart, chunkSecVa, chunkMaxOut) => scanSwift5Rel32ChunkJs(
    chunk,
    chunkStart,
    chunkSecVa,
    inFlags,
    chunkMaxOut,
  ));
  return { entries, engine: 'js', truncated };
}

// ---------------------------------------------------------------------------
// 3. Swift 5 __swift5_fieldmd scanner
// ---------------------------------------------------------------------------

function parseSingleFieldMdJs(u8, offset, secVa) {
  if (u8.length - offset < 16) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset + offset, u8.length - offset);
  const mangledTypeName = dv.getInt32(0, true);
  const superclass = dv.getInt32(4, true);
  const kind = dv.getUint16(8, true);
  const recordSize = dv.getUint16(10, true);
  const numFields = dv.getUint32(12, true);

  if (kind > 10) return null;
  const validNonzeroRec = recordSize >= 12 && recordSize <= 256 && (recordSize & 3) === 0;
  if (numFields > 0) {
    if (!validNonzeroRec) return null;
  } else if (recordSize !== 0 && !validNonzeroRec) {
    return null;
  }

  const fieldsBytes = BigInt(numFields) * BigInt(recordSize);
  const remaining = BigInt(u8.length - offset - 16);
  if (fieldsBytes > remaining) return null;

  let flags = 0;
  let mangledTypeNameVa = 0n;
  if (mangledTypeName !== 0) {
    const va = resolveRel32VaJs(secVa, offset, mangledTypeName);
    if (va !== null) {
      mangledTypeNameVa = va;
      flags |= 1;
    }
  }
  if (superclass !== 0) {
    flags |= 2;
  }

  const totalBytes = 16 + Number(fieldsBytes);
  return {
    record: {
      descOff: offset,
      numFields,
      kind,
      recordSize,
      flags,
      hasMangledTypeName: (flags & 1) !== 0,
      hasSuperclass: (flags & 2) !== 0,
      mangledTypeNameVa,
    },
    totalBytes,
  };
}

function scanSwift5FieldMdChunkJs(chunk, baseOffset, chunkSecVa, maxOut) {
  const descriptors = [];
  let off = 0;
  while (descriptors.length < maxOut && chunk.length - off >= 16) {
    const parsed = parseSingleFieldMdJs(chunk, off, chunkSecVa);
    if (!parsed) break;
    parsed.record.descOff = baseOffset + off;
    descriptors.push(parsed.record);
    off += parsed.totalBytes;
  }
  return { descriptors, consumed: off };
}

function scanSwift5FieldMdChunkWasm(ex, chunk, baseOffset, chunkSecVa, maxOut) {
  const len = chunk.length;
  if (len < 16 || maxOut <= 0) return { descriptors: [], consumed: 0 };
  ex.hex_engine_scratch_reset();
  try {
    const inPtr = ex.hex_engine_scratch_alloc(len);
    const outPtr = ex.hex_engine_scratch_alloc(maxOut * FIELDMD_RECORD_BYTES);
    const consumedPtr = ex.hex_engine_scratch_alloc(4);
    if (!inPtr || !outPtr || !consumedPtr) {
      throw new Error('swift5_fieldmd_scanner:scratch_alloc_failed');
    }
    new Uint8Array(ex.memory.buffer, inPtr, len).set(chunk);
    const secVaLo = Number(chunkSecVa & 0xffffffffn) >>> 0;
    const secVaHi = Number((chunkSecVa >> 32n) & 0xffffffffn) >>> 0;

    const count = ex.hex_scan_swift5_fieldmd(
      inPtr,
      len,
      secVaLo,
      secVaHi,
      outPtr,
      maxOut >>> 0,
      consumedPtr,
    ) >>> 0;

    const consumedDv = new DataView(ex.memory.buffer, consumedPtr, 4);
    const consumed = consumedDv.getUint32(0, true);

    const descriptors = new Array(count);
    const dv = new DataView(ex.memory.buffer, outPtr, count * FIELDMD_RECORD_BYTES);
    for (let i = 0; i < count; i += 1) {
      const base = i * FIELDMD_RECORD_BYTES;
      const descOff = baseOffset + dv.getUint32(base, true);
      const numFields = dv.getUint32(base + 4, true);
      const kind = dv.getUint16(base + 8, true);
      const recordSize = dv.getUint16(base + 10, true);
      const flags = dv.getUint32(base + 12, true);
      const vaLo = BigInt(dv.getUint32(base + 16, true));
      const vaHi = BigInt(dv.getUint32(base + 20, true));
      descriptors[i] = {
        descOff,
        numFields,
        kind,
        recordSize,
        flags,
        hasMangledTypeName: (flags & 1) !== 0,
        hasSuperclass: (flags & 2) !== 0,
        mangledTypeNameVa: (vaHi << 32n) | vaLo,
      };
    }
    return { descriptors, consumed };
  } finally {
    ex.hex_engine_scratch_reset();
  }
}

export function scanSwift5FieldMd(bytes, opts = {}) {
  const {
    secVa: rawSecVa = 0n,
    maxOut: rawMaxOut = DEFAULT_MAX_OUT,
    chunkSize: rawChunkSize,
  } = opts || {};

  const u8 = toU8(bytes);
  const maxOut = clampMaxOut(rawMaxOut);
  const secVa = toBigIntSafe(rawSecVa, 0n);
  if (secVa === null) {
    return { descriptors: [], consumedBytes: 0, engine: 'js', truncated: false };
  }

  const ex = resolveWasmExports(opts, 'hex_scan_swift5_fieldmd', 'swift5_fieldmd_scanner');
  if (!u8 || u8.length < 16 || maxOut <= 0) {
    return { descriptors: [], consumedBytes: 0, engine: ex ? 'wasm' : 'js', truncated: false };
  }

  const chunkSize = alignChunkSize(rawChunkSize, SCRATCH_CHUNK_MAX, 16, 16);

  const runChunked = (scanChunkFn) => {
    const descriptors = [];
    let offset = 0;
    let truncated = false;

    while (offset < u8.length && (u8.length - offset) >= 16) {
      const remaining = maxOut - descriptors.length;
      if (remaining <= 0) {
        if (parseSingleFieldMdJs(u8, offset, secVa) !== null) {
          truncated = true;
        }
        break;
      }

      const chunkLen = Math.min(chunkSize, u8.length - offset);
      const chunkSecVa = secVa + BigInt(offset);
      if (chunkSecVa > U64_MAX) break;

      const chunkMaxOut = Math.min(FIELDMD_CHUNK_MAX_OUT, remaining);
      const { descriptors: hits, consumed } = scanChunkFn(
        u8.subarray(offset, offset + chunkLen),
        offset,
        chunkSecVa,
        chunkMaxOut,
      );

      if (consumed > 0) {
        for (let i = 0; i < hits.length; i += 1) {
          descriptors.push(hits[i]);
        }
        offset += consumed;
        continue;
      }

      // If 0 bytes consumed and more bytes remain beyond this chunk, a single record
      // may span past chunkSize: fall back to JS for that single oversized record only.
      if (offset + chunkLen < u8.length) {
        const single = parseSingleFieldMdJs(u8, offset, secVa);
        if (single !== null) {
          descriptors.push(single.record);
          offset += single.totalBytes;
          continue;
        }
      }
      break;
    }

    return { descriptors, consumedBytes: offset, truncated };
  };

  if (ex) {
    try {
      const { descriptors, consumedBytes, truncated } = runChunked(
        (chunk, baseOffset, chunkSecVa, chunkMaxOut) => scanSwift5FieldMdChunkWasm(
          ex,
          chunk,
          baseOffset,
          chunkSecVa,
          chunkMaxOut,
        ),
      );
      recordWasmCall('swift5_fieldmd_scanner');
      return { descriptors, consumedBytes, engine: 'wasm', truncated };
    } catch {
      recordFallback('swift5_fieldmd_scanner:wasm_exception');
    }
  }

  const { descriptors, consumedBytes, truncated } = runChunked(
    (chunk, baseOffset, chunkSecVa, chunkMaxOut) => scanSwift5FieldMdChunkJs(
      chunk,
      baseOffset,
      chunkSecVa,
      chunkMaxOut,
    ),
  );
  return { descriptors, consumedBytes, engine: 'js', truncated };
}

// ---------------------------------------------------------------------------
// 4. High-level Mach-O / binary image aggregator
// ---------------------------------------------------------------------------

const OBJC_PTR_SECTION_MAP = Object.freeze({
  __objc_classlist: 'classList',
  __objc_catlist: 'catList',
  __objc_protolist: 'protoList',
  __objc_selrefs: 'selRefs',
});

const SWIFT5_REL32_SECTION_MAP = Object.freeze({
  __swift5_types: 'types',
  __swift5_proto: 'proto',
  __swift5_protos: 'protos',
});

function normalizeSectionName(sec) {
  const raw = sec && (sec.name ?? sec.section ?? sec.sectname ?? '');
  return typeof raw === 'string' ? raw.replace(/\0+$/, '').trim() : '';
}

function extractSectionSlice(sec, imageBytes) {
  if (sec && sec.bytes) {
    const direct = toU8(sec.bytes);
    if (direct && direct.length > 0) return direct;
  }
  if (!imageBytes) return null;
  const rawOff = sec.fileOffset ?? sec.offset ?? sec.fileOff ?? sec.foff;
  const rawSize = sec.size ?? sec.byteLength ?? sec.fileSize;
  if (rawOff == null || rawSize == null) return null;
  const off = Number(rawOff);
  const size = Number(rawSize);
  if (!Number.isFinite(off) || !Number.isFinite(size) || off < 0 || size <= 0) return null;
  if (off + size > imageBytes.length) return null;
  return imageBytes.subarray(off, off + size);
}

function extractSectionVa(sec) {
  const rawVa = sec.address ?? sec.vaddr ?? sec.addr ?? sec.vmAddr ?? sec.va ?? 0n;
  const va = toBigIntSafe(rawVa, 0n);
  return va === null ? 0n : va;
}

export function scanObjcSwiftMetadataFromImage(image, opts = {}) {
  const objc = {
    classList: [],
    catList: [],
    protoList: [],
    selRefs: [],
  };
  const swift5 = {
    types: [],
    proto: [],
    protos: [],
    fieldMd: [],
  };
  const sectionsScanned = [];
  let truncated = false;
  let sawWasm = false;
  let sawJs = false;

  const imageBytes = image && image.bytes ? toU8(image.bytes) : null;
  const sections = image && Array.isArray(image.sections) ? image.sections : [];
  const imageBase = opts.imageBase ?? (image && (image.imageBase ?? image.baseAddr ?? image.textBase)) ?? 0n;
  const allowIndirect = opts.allowIndirect ?? true;

  for (let i = 0; i < sections.length; i += 1) {
    const sec = sections[i];
    if (!sec || typeof sec !== 'object') continue;
    const name = normalizeSectionName(sec);
    if (!name) continue;

    if (Object.prototype.hasOwnProperty.call(OBJC_PTR_SECTION_MAP, name)) {
      const slice = extractSectionSlice(sec, imageBytes);
      if (!slice) continue;
      const res = scanObjcPtrList(slice, {
        ...opts,
        imageBase,
      });
      if (res.engine === 'wasm') sawWasm = true;
      else sawJs = true;
      if (res.truncated) truncated = true;
      const bucket = objc[OBJC_PTR_SECTION_MAP[name]];
      for (let j = 0; j < res.entries.length; j += 1) {
        bucket.push(res.entries[j]);
      }
      sectionsScanned.push(name);
    } else if (Object.prototype.hasOwnProperty.call(SWIFT5_REL32_SECTION_MAP, name)) {
      const slice = extractSectionSlice(sec, imageBytes);
      if (!slice) continue;
      const res = scanSwift5Rel32List(slice, {
        ...opts,
        secVa: extractSectionVa(sec),
        allowIndirect,
      });
      if (res.engine === 'wasm') sawWasm = true;
      else sawJs = true;
      if (res.truncated) truncated = true;
      const bucket = swift5[SWIFT5_REL32_SECTION_MAP[name]];
      for (let j = 0; j < res.entries.length; j += 1) {
        bucket.push(res.entries[j]);
      }
      sectionsScanned.push(name);
    } else if (name === '__swift5_fieldmd') {
      const slice = extractSectionSlice(sec, imageBytes);
      if (!slice) continue;
      const res = scanSwift5FieldMd(slice, {
        ...opts,
        secVa: extractSectionVa(sec),
      });
      if (res.engine === 'wasm') sawWasm = true;
      else sawJs = true;
      if (res.truncated) truncated = true;
      for (let j = 0; j < res.descriptors.length; j += 1) {
        swift5.fieldMd.push(res.descriptors[j]);
      }
      sectionsScanned.push(name);
    }
  }

  let engine = 'js';
  if (sawWasm && !sawJs) {
    engine = 'wasm';
  } else if (!sawWasm && !sawJs) {
    const ex = resolveWasmExports(opts, 'hex_scan_objc_ptr_list', 'objc_swift_image_scanner');
    engine = ex ? 'wasm' : 'js';
  }

  const counts = {
    objcClassList: objc.classList.length,
    objcCatList: objc.catList.length,
    objcProtoList: objc.protoList.length,
    objcSelRefs: objc.selRefs.length,
    swift5Types: swift5.types.length,
    swift5Proto: swift5.proto.length,
    swift5Protos: swift5.protos.length,
    swift5FieldMd: swift5.fieldMd.length,
    total: objc.classList.length
      + objc.catList.length
      + objc.protoList.length
      + objc.selRefs.length
      + swift5.types.length
      + swift5.proto.length
      + swift5.protos.length
      + swift5.fieldMd.length,
  };

  return {
    engine,
    truncated,
    sectionsScanned,
    objc,
    swift5,
    counts,
  };
}
