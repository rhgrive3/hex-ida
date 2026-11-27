/**
 * ARM64 Jump-Table Scanner (WASM-accelerated with 1:1 JS fallback).
 *
 * Scans ARM64 instruction streams for `br Xn` indirect jumps and performs a
 * bounded backward dataflow/pattern scan (up to 24 instructions) to recover
 * bounds checks (`cmp` + `b.hi`/`b.hs`), indexed table loads, relative target
 * additions, and PC-relative table virtual addresses (`adrp`+`add` / `adr`).
 */
import { getHexEngineExports, isWasmBulkMemorySupported } from '../core/hex-engine-wasm.js';
import { getEngineMode, recordWasmCall, recordFallback } from '../core/hex-engine-bridge.js';
import {
  readU32LE,
  isRet,
  decodeBrReg,
  decodeRegOffsetLoad,
  decodeArithAddSub,
  decodeCmpImm,
  decodeBHiHs,
  decodeAdrp,
  decodeAdr,
  decodeAddImm,
} from './arm64-insn-bits.js';

const SCRATCH_CHUNK_MAX = 1536 * 1024;
const OVERLAP = 128; // 8-byte aligned, 32 ARM64 instructions (> 24 + 4 lookback)
const RECORD_BYTES = 24;
const MAX_LOOKBACK_INSNS = 24;
const MAX_CMP_LOOKBACK_INSNS = 4;
const NO_CMP_OFF = 0xFFFFFFFF;
const UNKNOWN_REG = 0xFF;

const FLAG_HAS_BOUNDS = 1;
const FLAG_RELATIVE_ADD = 2;
const FLAG_HAS_TABLE_VA = 4;

const ARM64_ARCHES = new Set(['arm64', 'aarch64', 'arm64e']);

function toU8(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return null;
}

function isArm64Arch(arch) {
  const norm = String(arch ?? 'arm64').trim().toLowerCase();
  return ARM64_ARCHES.has(norm);
}

function popcount8(v) {
  let x = v & 0xFF;
  let c = 0;
  while (x) {
    x &= (x - 1);
    c++;
  }
  return c;
}

function resolveWasmExports(opts) {
  const reqEngine = opts?.engine != null ? String(opts.engine).trim().toLowerCase() : null;
  if (reqEngine === 'js') {
    recordFallback('jumptable_scanner:wasm_disabled');
    return null;
  }
  if (
    opts?.wasmExports
    && typeof opts.wasmExports.hex_scan_arm64_jumptables === 'function'
    && opts.wasmExports.memory
  ) {
    return opts.wasmExports;
  }
  if (reqEngine !== 'wasm' && getEngineMode(opts) === 'js') {
    recordFallback('jumptable_scanner:wasm_disabled');
    return null;
  }
  if (!isWasmBulkMemorySupported()) {
    recordFallback('jumptable_scanner:no_bulk_memory');
    return null;
  }
  try {
    const ex = getHexEngineExports(reqEngine ? { _engine: reqEngine } : null);
    if (!ex || typeof ex.hex_scan_arm64_jumptables !== 'function' || !ex.memory) {
      recordFallback('jumptable_scanner:exports_missing');
      return null;
    }
    return ex;
  } catch {
    recordFallback('jumptable_scanner:init_error');
    return null;
  }
}

function scanChunkWasm(ex, chunkBytes, chunkTextVa, chunkMaxOut) {
  const chunkLen = chunkBytes.length;
  const outBytes = chunkMaxOut * RECORD_BYTES;
  let inPtr = 0;
  let outPtr = 0;
  const hasScratch = typeof ex.hex_engine_scratch_reset === 'function' && typeof ex.hex_engine_scratch_alloc === 'function';

  try {
  if (hasScratch) {
    ex.hex_engine_scratch_reset();
    inPtr = ex.hex_engine_scratch_alloc(chunkLen) >>> 0;
    outPtr = ex.hex_engine_scratch_alloc(outBytes) >>> 0;
    if (!inPtr || !outPtr) {
      throw new Error('scratch_alloc_failed');
    }
  } else {
    const rawBase = (typeof ex.__heap_base === 'object' && ex.__heap_base !== null)
      ? Number(ex.__heap_base.value)
      : Number(ex.__heap_base ?? 65536);
    inPtr = ((rawBase + 7) & ~7) >>> 0;
    outPtr = ((inPtr + chunkLen + 7) & ~7) >>> 0;
    const needed = outPtr + outBytes;
    if (needed > ex.memory.buffer.byteLength) {
      const growPages = Math.ceil((needed - ex.memory.buffer.byteLength) / 65536);
      ex.memory.grow(growPages);
    }
  }

  new Uint8Array(ex.memory.buffer, inPtr, chunkLen).set(chunkBytes);
  const vaLo = Number(chunkTextVa & 0xFFFFFFFFn) >>> 0;
  const vaHi = Number((chunkTextVa >> 32n) & 0xFFFFFFFFn) >>> 0;
  const count = ex.hex_scan_arm64_jumptables(inPtr, chunkLen, vaLo, vaHi, outPtr, chunkMaxOut) >>> 0;

  const dv = new DataView(ex.memory.buffer, outPtr, count * RECORD_BYTES);
  const results = new Array(count);
  for (let i = 0; i < count; i++) {
    const base = i * RECORD_BYTES;
    const brOff = dv.getUint32(base + 0, true);
    const cmpOff = dv.getUint32(base + 4, true);
    const entryCount = dv.getUint32(base + 8, true);
    const tableVaLo = dv.getUint32(base + 12, true);
    const tableVaHi = dv.getUint32(base + 16, true);
    const elemWidth = dv.getUint8(base + 20);
    const indexReg = dv.getUint8(base + 21);
    const targetReg = dv.getUint8(base + 22);
    const flags = dv.getUint8(base + 23);
    results[i] = {
      brOff,
      cmpOff,
      entryCount,
      tableVa: BigInt(tableVaLo) | (BigInt(tableVaHi) << 32n),
      elemWidth,
      indexReg,
      targetReg,
      hasBounds: (flags & FLAG_HAS_BOUNDS) !== 0,
      relativeAdd: (flags & FLAG_RELATIVE_ADD) !== 0,
      hasTableVa: (flags & FLAG_HAS_TABLE_VA) !== 0,
      flags,
    };
  }
  return results;
  } finally {
    if (hasScratch) ex.hex_engine_scratch_reset();
  }
}

function scanChunkJs(chunkBytes, chunkTextVa, chunkMaxOut) {
  const limit = chunkBytes.length & ~3;
  const results = [];

  for (let off = 0; off < limit && results.length < chunkMaxOut; off += 4) {
    const w = readU32LE(chunkBytes, off);
    const target = decodeBrReg(w);
    if (target < 0 || target === 30) continue;

    const curReg = target;
    let hasRelAdd = false;
    let addRn = UNKNOWN_REG;
    let addRm = UNKNOWN_REG;

    let hasLoad = false;
    let tableReg = UNKNOWN_REG;
    let indexReg = UNKNOWN_REG;
    let elemWidth = 0;

    let hasPendingAdd = false;
    let pendingAddImm = 0;
    let tableAdrpReg = UNKNOWN_REG;
    let hasTableVa = false;
    let tableVa = 0n;

    let hasBounds = false;
    let cmpOff = NO_CMP_OFF;
    let entryCount = 0;

    let flags = 0;

    for (let step = 1; step <= MAX_LOOKBACK_INSNS; step++) {
      const deltaBytes = step * 4;
      if (off < deltaBytes) break;
      const insnOff = off - deltaBytes;
      const iw = readU32LE(chunkBytes, insnOff);
      if (isRet(iw)) break;

      if (!hasLoad && !hasRelAdd) {
        const arith = decodeArithAddSub(iw);
        if (arith && !arith.isSub && !arith.isFloat && arith.hasRm && arith.rd === curReg) {
          hasRelAdd = true;
          addRn = arith.rn;
          addRm = arith.rm;
          flags |= FLAG_RELATIVE_ADD;
          continue;
        }
      }

      if (!hasLoad) {
        const ro = decodeRegOffsetLoad(iw);
        if (ro) {
          const rtMatch = (ro.rt === curReg) || (hasRelAdd && (ro.rt === addRn || ro.rt === addRm));
          if (rtMatch) {
            hasLoad = true;
            tableReg = ro.rn;
            indexReg = ro.rm;
            elemWidth = ro.width;
            tableAdrpReg = tableReg;
            continue;
          }
        }
      }

      if (hasLoad && !hasTableVa) {
        if (!hasPendingAdd) {
          const addImm = decodeAddImm(iw);
          if (addImm && addImm.rd === tableReg) {
            hasPendingAdd = true;
            pendingAddImm = addImm.imm;
            tableAdrpReg = addImm.rn;
            continue;
          }
        }

        const adrp = decodeAdrp(iw);
        if (adrp && adrp.rd === tableAdrpReg) {
          const pc = BigInt.asUintN(64, chunkTextVa + BigInt(insnOff));
          const addOff = hasPendingAdd ? BigInt(pendingAddImm) : 0n;
          tableVa = BigInt.asUintN(64, (pc & ~0xFFFn) + adrp.pageDelta + addOff);
          hasTableVa = true;
          flags |= FLAG_HAS_TABLE_VA;
          continue;
        }

        const adr = decodeAdr(iw);
        if (adr && adr.rd === tableAdrpReg) {
          const pc = BigInt.asUintN(64, chunkTextVa + BigInt(insnOff));
          const addOff = hasPendingAdd ? BigInt(pendingAddImm) : 0n;
          tableVa = BigInt.asUintN(64, pc + adr.delta + addOff);
          hasTableVa = true;
          flags |= FLAG_HAS_TABLE_VA;
          continue;
        }
      }

      if (!hasBounds) {
        const bCond = decodeBHiHs(iw);
        if (bCond) {
          for (let k = 1; k <= MAX_CMP_LOOKBACK_INSNS; k++) {
            const cmpDelta = k * 4;
            if (insnOff < cmpDelta) break;
            const cmpInsnOff = insnOff - cmpDelta;
            const cw = readU32LE(chunkBytes, cmpInsnOff);
            if (isRet(cw)) break;
            const cmp = decodeCmpImm(cw);
            if (cmp && (!hasLoad || cmp.rn === indexReg)) {
              const ec = bCond.isHi ? (cmp.imm + 1) : cmp.imm;
              if (ec >= 2 && ec <= 4097) {
                hasBounds = true;
                cmpOff = cmpInsnOff;
                entryCount = ec;
                if (!hasLoad && indexReg === UNKNOWN_REG) {
                  indexReg = cmp.rn;
                }
                flags |= FLAG_HAS_BOUNDS;
                break;
              }
            }
          }
        }
      }
    }

    if (!hasLoad && !hasBounds && !hasTableVa) continue;

    results.push({
      brOff: off,
      cmpOff: hasBounds ? cmpOff : NO_CMP_OFF,
      entryCount: hasBounds ? entryCount : 0,
      tableVa: hasTableVa ? tableVa : 0n,
      elemWidth,
      indexReg,
      targetReg: target,
      hasBounds,
      relativeAdd: hasRelAdd,
      hasTableVa,
      flags,
    });
  }

  return results;
}

function runChunkedScan(u8, baseTextVa, maxOut, effectiveChunkSize, scanChunkFn) {
  const byBrOff = new Map();
  let chunkStart = 0;
  let truncated = false;
  const chunkMaxOut = Math.min(maxOut + 1, 32768);

  while (chunkStart < u8.length) {
    const chunkEnd = Math.min(u8.length, chunkStart + effectiveChunkSize);
    const alignedLen = (chunkEnd - chunkStart) & ~3;
    if (alignedLen < 4) break;

    const chunkSlice = u8.subarray(chunkStart, chunkStart + alignedLen);
    const chunkTextVa = BigInt.asUintN(64, baseTextVa + BigInt(chunkStart));
    const chunkHits = scanChunkFn(chunkSlice, chunkTextVa, chunkMaxOut);

    if (chunkHits.length >= chunkMaxOut) {
      truncated = true;
    }

    for (let i = 0; i < chunkHits.length; i++) {
      const h = chunkHits[i];
      const absBrOff = chunkStart + h.brOff;
      const absCmpOff = h.cmpOff === NO_CMP_OFF ? NO_CMP_OFF : (chunkStart + h.cmpOff);
      const merged = {
        brOff: absBrOff,
        cmpOff: absCmpOff,
        entryCount: h.entryCount,
        tableVa: h.tableVa,
        elemWidth: h.elemWidth,
        indexReg: h.indexReg,
        targetReg: h.targetReg,
        hasBounds: h.hasBounds,
        relativeAdd: h.relativeAdd,
        hasTableVa: h.hasTableVa,
        flags: h.flags,
      };
      const prev = byBrOff.get(absBrOff);
      if (!prev || popcount8(merged.flags) > popcount8(prev.flags)) {
        byBrOff.set(absBrOff, merged);
      }
    }

    if (chunkEnd >= u8.length) break;
    chunkStart = chunkEnd - OVERLAP;
  }

  const tables = Array.from(byBrOff.values()).sort((a, b) => a.brOff - b.brOff);
  if (tables.length > maxOut) {
    truncated = true;
    tables.length = maxOut;
  }
  return { tables, truncated };
}

export function scanArm64JumpTables(bytes, opts = {}) {
  const {
    textVa = 0n,
    arch = 'arm64',
    maxOut = 1024,
    chunkSize,
  } = opts || {};

  if (!isArm64Arch(arch)) {
    return { tables: [], engine: 'js', truncated: false, unsupportedArch: true };
  }

  const u8 = toU8(bytes);
  const maxOutVal = Math.max(0, Math.floor(Number(maxOut ?? 1024)));
  const ex = resolveWasmExports(opts);

  if (!u8 || u8.length < 4 || maxOutVal === 0) {
    return {
      tables: [],
      engine: ex ? 'wasm' : 'js',
      truncated: false,
      unsupportedArch: false,
    };
  }

  const baseTextVa = BigInt.asUintN(64, BigInt(textVa ?? 0n));
  let effectiveChunkSize = SCRATCH_CHUNK_MAX;
  if (chunkSize != null && Number.isFinite(Number(chunkSize))) {
    const requested = Math.floor(Number(chunkSize)) & ~3;
    effectiveChunkSize = Math.min(SCRATCH_CHUNK_MAX, Math.max(OVERLAP + 4, requested));
  }

  if (ex) {
    try {
      const { tables, truncated } = runChunkedScan(
        u8,
        baseTextVa,
        maxOutVal,
        effectiveChunkSize,
        (slice, va, limit) => scanChunkWasm(ex, slice, va, limit),
      );
      recordWasmCall('jumptable_scanner');
      return { tables, engine: 'wasm', truncated, unsupportedArch: false };
    } catch {
      recordFallback('jumptable_scanner:wasm_exception');
    }
  }

  const { tables, truncated } = runChunkedScan(
    u8,
    baseTextVa,
    maxOutVal,
    effectiveChunkSize,
    scanChunkJs,
  );
  return { tables, engine: 'js', truncated, unsupportedArch: false };
}
