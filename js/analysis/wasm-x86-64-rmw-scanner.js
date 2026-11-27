/**
 * x86-64 Read-Modify-Write (+ Clamp) field scanner & behavior classifier.
 * WASM-accelerated via `hex_scan_x86_64_rmw_fields` and `hex_classify_x86_64_behavior`
 * with 1:1 JS fallback parity.
 */
import { getHexEngineExports, isWasmBulkMemorySupported } from '../core/hex-engine-wasm.js';
import { getEngineMode, recordWasmCall, recordFallback } from '../core/hex-engine-bridge.js';

export const SCRATCH_CHUNK_MAX = 1536 * 1024;
const OVERLAP = 256;
const CHUNK_MAX_OUT = 16384;
const DEFAULT_MAX_OUT = 65536;
const SAFE_MAX_OUT = 262144;
const RMW_HIT_BYTES = 20;
const BEHAVIOR_OUT_BYTES = 32;
const MAX_BISECT_DEPTH = 12;

export const BEHAVIOR_CATEGORY = Object.freeze({
  NONE: 0,
  DRAIN: 1,
  ACCUM: 2,
  RATIO: 3,
  CRYPTO: 4,
  ACCESSOR: 5,
});

function toU8(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return null;
}

function isX86_64Arch(arch) {
  if (arch == null || arch === '') return true;
  const norm = String(arch).trim().toLowerCase();
  return norm === '' || norm === 'x86_64' || norm === 'x64' || norm === 'amd64';
}

function normalizeEngineOpts(opts) {
  if (!opts || typeof opts !== 'object') return null;
  if (opts.engine != null && opts._engine == null) {
    return { ...opts, _engine: opts.engine };
  }
  return opts;
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

function resolveWasmExports(opts, engineOpts, requiredFn, tag) {
  if (getEngineMode(engineOpts) === 'js') {
    recordFallback(`${tag}:wasm_disabled`);
    return null;
  }
  if (!isWasmBulkMemorySupported()) {
    recordFallback(`${tag}:no_bulk_memory`);
    return null;
  }
  try {
    const ex = opts && opts.wasmExports ? opts.wasmExports : getHexEngineExports(engineOpts);
    if (
      !ex
      || !ex.memory
      || !(ex.memory.buffer instanceof ArrayBuffer)
      || typeof ex[requiredFn] !== 'function'
    ) {
      recordFallback(`${tag}:exports_missing`);
      return null;
    }
    return ex;
  } catch {
    recordFallback(`${tag}:init_error`);
    return null;
  }
}

function resolveChunkSize(chunkSize) {
  if (Number.isFinite(chunkSize) && chunkSize > 0) {
    return Math.min(SCRATCH_CHUNK_MAX, Math.max(16, Math.floor(chunkSize)));
  }
  return SCRATCH_CHUNK_MAX;
}

function readI32LE(code, off) {
  return (
    code[off]
    | (code[off + 1] << 8)
    | (code[off + 2] << 16)
    | (code[off + 3] << 24)
  ) | 0;
}

function isLegacyPrefix(b) {
  return (
    b === 0xF0 || b === 0xF2 || b === 0xF3
    || b === 0x66 || b === 0x67
    || b === 0x26 || b === 0x2E || b === 0x36 || b === 0x3E
    || b === 0x64 || b === 0x65
  );
}

function makeFallbackInsn(pos) {
  return {
    off: pos,
    len: 1,
    valid: false,
    hasLock: false,
    hasRepne: false,
    hasRep: false,
    has66: false,
    has67: false,
    isVex: false,
    rexW: 0,
    rexR: 0,
    rexX: 0,
    rexB: 0,
    map: 0,
    opcode: 0,
    hasModrm: false,
    mod: 0,
    regField: 0,
    rmField: 0,
    regNum: 0,
    rmRegNum: 0,
    hasMem: false,
    memValid: false,
    isRipRel: false,
    baseReg: 0,
    disp: 0,
  };
}

/**
 * 100% parity variable-length x86-64 decoder matching `decode_x86_64_insn` in C++.
 * Always guarantees len >= 1 and pos + len <= codeLen, max len <= 15.
 */
function decodeX86_64Insn(code, codeLen, pos) {
  if (pos >= codeLen) return makeFallbackInsn(pos);

  const rem = codeLen - pos;
  const maxEnd = pos + (rem < 15 ? rem : 15);
  let cur = pos;

  const d = makeFallbackInsn(pos);

  // 1. Legacy prefixes
  while (cur < maxEnd && isLegacyPrefix(code[cur])) {
    const p = code[cur++];
    if (p === 0xF0) d.hasLock = true;
    else if (p === 0xF2) d.hasRepne = true;
    else if (p === 0xF3) d.hasRep = true;
    else if (p === 0x66) d.has66 = true;
    else if (p === 0x67) d.has67 = true;
  }

  // 2. REX prefix (0x40..0x4F)
  let hasRex = false;
  if (cur < maxEnd && (code[cur] & 0xF0) === 0x40) {
    const rex = code[cur++];
    hasRex = true;
    d.rexW = (rex >> 3) & 1;
    d.rexR = (rex >> 2) & 1;
    d.rexX = (rex >> 1) & 1;
    d.rexB = rex & 1;
  }

  if (cur >= maxEnd) return makeFallbackInsn(pos);

  const op = code[cur++];
  let needModrm = false;
  let immSize = 0;
  let checkGrp3Imm = false;
  const immZ = d.has66 ? 2 : 4;
  const immV = d.rexW ? 8 : (d.has66 ? 2 : 4);

  // 3. VEX 2-byte (0xC5) / 3-byte (0xC4)
  if (!hasRex && (op === 0xC5 || op === 0xC4)) {
    d.isVex = true;
    if (op === 0xC5) {
      if (cur + 2 > maxEnd) return makeFallbackInsn(pos);
      const v1 = code[cur++];
      d.rexR = ((~v1) >> 7) & 1;
      const pp = v1 & 3;
      if (pp === 1) d.has66 = true;
      else if (pp === 2) d.hasRep = true;
      else if (pp === 3) d.hasRepne = true;
      d.map = 1;
      d.opcode = code[cur++];
    } else {
      if (cur + 3 > maxEnd) return makeFallbackInsn(pos);
      const v1 = code[cur++];
      const v2 = code[cur++];
      d.rexR = ((~v1) >> 7) & 1;
      d.rexX = ((~v1) >> 6) & 1;
      d.rexB = ((~v1) >> 5) & 1;
      d.map = v1 & 0x1F;
      if (d.map < 1 || d.map > 3) return makeFallbackInsn(pos);
      d.rexW = (v2 >> 7) & 1;
      const pp = v2 & 3;
      if (pp === 1) d.has66 = true;
      else if (pp === 2) d.hasRep = true;
      else if (pp === 3) d.hasRepne = true;
      d.opcode = code[cur++];
    }

    if (d.map === 1 && d.opcode === 0x77) {
      needModrm = false;
      immSize = 0;
    } else {
      needModrm = true;
      if (d.map === 3) {
        immSize = 1;
      } else if (
        d.map === 1 && (
          d.opcode === 0x70 || d.opcode === 0x71 || d.opcode === 0x72
          || d.opcode === 0x73 || d.opcode === 0xC2 || d.opcode === 0xC4
          || d.opcode === 0xC5 || d.opcode === 0xC6
        )
      ) {
        immSize = 1;
      }
    }
  } else if (op === 0x0F) {
    // 4. Two-byte / Three-byte escape (0F / 0F 38 / 0F 3A)
    if (cur >= maxEnd) return makeFallbackInsn(pos);
    const op2 = code[cur++];
    if (op2 === 0x38) {
      if (cur >= maxEnd) return makeFallbackInsn(pos);
      d.map = 2;
      d.opcode = code[cur++];
      needModrm = true;
      immSize = 0;
    } else if (op2 === 0x3A) {
      if (cur >= maxEnd) return makeFallbackInsn(pos);
      d.map = 3;
      d.opcode = code[cur++];
      needModrm = true;
      immSize = 1;
    } else {
      d.map = 1;
      d.opcode = op2;
      if (op2 >= 0x80 && op2 <= 0x8F) {
        needModrm = false;
        immSize = 4;
      } else if (
        op2 === 0x05 || op2 === 0x07 || op2 === 0x08 || op2 === 0x09
        || op2 === 0x0B || (op2 >= 0x30 && op2 <= 0x35)
        || op2 === 0x77 || op2 === 0xA0 || op2 === 0xA1 || op2 === 0xA2
        || op2 === 0xA8 || op2 === 0xA9 || op2 === 0xAA
        || (op2 >= 0xC8 && op2 <= 0xCF)
      ) {
        needModrm = false;
        immSize = 0;
      } else if (
        op2 === 0x70 || op2 === 0x71 || op2 === 0x72 || op2 === 0x73
        || op2 === 0xA4 || op2 === 0xAC || op2 === 0xBA || op2 === 0xC2
        || op2 === 0xC4 || op2 === 0xC5 || op2 === 0xC6
      ) {
        needModrm = true;
        immSize = 1;
      } else {
        needModrm = true;
        immSize = 0;
      }
    }
  } else {
    // 5. One-byte legacy opcode
    d.map = 0;
    d.opcode = op;
    if (op <= 0x3F && (op & 7) <= 3) {
      needModrm = true;
      immSize = 0;
    } else if (op <= 0x3F && (op & 7) === 4) {
      needModrm = false;
      immSize = 1;
    } else if (op <= 0x3F && (op & 7) === 5) {
      needModrm = false;
      immSize = immZ;
    } else if (op >= 0x50 && op <= 0x5F) {
      needModrm = false;
      immSize = 0;
    } else if (op === 0x63) {
      needModrm = true;
      immSize = 0;
    } else if (op === 0x68) {
      needModrm = false;
      immSize = immZ;
    } else if (op === 0x69) {
      needModrm = true;
      immSize = immZ;
    } else if (op === 0x6A) {
      needModrm = false;
      immSize = 1;
    } else if (op === 0x6B) {
      needModrm = true;
      immSize = 1;
    } else if (op >= 0x6C && op <= 0x6F) {
      needModrm = false;
      immSize = 0;
    } else if (op >= 0x70 && op <= 0x7F) {
      needModrm = false;
      immSize = 1;
    } else if (op === 0x80 || op === 0x83) {
      needModrm = true;
      immSize = 1;
    } else if (op === 0x81) {
      needModrm = true;
      immSize = immZ;
    } else if (op >= 0x84 && op <= 0x8F) {
      needModrm = true;
      immSize = 0;
    } else if (op >= 0x90 && op <= 0x9F && op !== 0x9A) {
      needModrm = false;
      immSize = 0;
    } else if (op >= 0xA0 && op <= 0xA3) {
      needModrm = false;
      immSize = d.has67 ? 4 : 8;
    } else if ((op >= 0xA4 && op <= 0xA7) || (op >= 0xAA && op <= 0xAF)) {
      needModrm = false;
      immSize = 0;
    } else if (op === 0xA8) {
      needModrm = false;
      immSize = 1;
    } else if (op === 0xA9) {
      needModrm = false;
      immSize = immZ;
    } else if (op >= 0xB0 && op <= 0xB7) {
      needModrm = false;
      immSize = 1;
    } else if (op >= 0xB8 && op <= 0xBF) {
      needModrm = false;
      immSize = immV;
    } else if (op === 0xC0 || op === 0xC1 || op === 0xC6) {
      needModrm = true;
      immSize = 1;
    } else if (op === 0xC2 || op === 0xCA) {
      needModrm = false;
      immSize = 2;
    } else if (op === 0xC3 || op === 0xC9 || op === 0xCB || op === 0xCC || op === 0xCF) {
      needModrm = false;
      immSize = 0;
    } else if (op === 0xC7) {
      needModrm = true;
      immSize = immZ;
    } else if (op === 0xC8) {
      needModrm = false;
      immSize = 3;
    } else if (op === 0xCD) {
      needModrm = false;
      immSize = 1;
    } else if ((op >= 0xD0 && op <= 0xD3) || (op >= 0xD8 && op <= 0xDF)) {
      needModrm = true;
      immSize = 0;
    } else if (op === 0xD7) {
      needModrm = false;
      immSize = 0;
    } else if ((op >= 0xE0 && op <= 0xE7) || op === 0xEB) {
      needModrm = false;
      immSize = 1;
    } else if (op === 0xE8 || op === 0xE9) {
      needModrm = false;
      immSize = 4;
    } else if (
      (op >= 0xEC && op <= 0xEF) || op === 0xF1 || op === 0xF4
      || op === 0xF5 || (op >= 0xF8 && op <= 0xFD)
    ) {
      needModrm = false;
      immSize = 0;
    } else if (op === 0xF6 || op === 0xF7) {
      needModrm = true;
      checkGrp3Imm = true;
    } else if (op === 0xFE || op === 0xFF) {
      needModrm = true;
      immSize = 0;
    } else {
      return makeFallbackInsn(pos);
    }
  }

  // 6. ModRM / SIB / disp
  if (needModrm) {
    if (cur >= maxEnd) return makeFallbackInsn(pos);
    const modrm = code[cur++];
    d.hasModrm = true;
    d.mod = (modrm >> 6) & 3;
    d.regField = (modrm >> 3) & 7;
    d.rmField = modrm & 7;
    d.regNum = (d.rexR << 3) | d.regField;
    d.rmRegNum = (d.rexB << 3) | d.rmField;

    if (checkGrp3Imm) {
      if (d.regField === 0 || d.regField === 1) {
        immSize = d.opcode === 0xF6 ? 1 : immZ;
      } else {
        immSize = 0;
      }
    }

    if (d.mod !== 3) {
      d.hasMem = true;
      let dispSize = 0;
      if (d.rmField === 4) {
        if (cur >= maxEnd) return makeFallbackInsn(pos);
        const sib = code[cur++];
        const sibBase3 = sib & 7;
        const sibIdx3 = (sib >> 3) & 7;
        const idxReg = (d.rexX << 3) | sibIdx3;
        const hasIndex = idxReg !== 4;
        if (d.mod === 0 && sibBase3 === 5) {
          d.memValid = false;
          dispSize = 4;
        } else {
          d.baseReg = (d.rexB << 3) | sibBase3;
          d.memValid = !hasIndex;
          dispSize = d.mod === 1 ? 1 : (d.mod === 2 ? 4 : 0);
        }
      } else if (d.mod === 0 && d.rmField === 5) {
        d.isRipRel = true;
        d.baseReg = 16;
        d.memValid = true;
        dispSize = 4;
      } else {
        d.baseReg = (d.rexB << 3) | d.rmField;
        d.memValid = true;
        dispSize = d.mod === 1 ? 1 : (d.mod === 2 ? 4 : 0);
      }

      if (dispSize > 0) {
        if (cur + dispSize > maxEnd) return makeFallbackInsn(pos);
        if (dispSize === 1) {
          d.disp = (code[cur] << 24) >> 24;
        } else {
          d.disp = readI32LE(code, cur);
        }
        cur += dispSize;
      }
    }
  }

  // 7. Immediate
  if (immSize > 0) {
    if (cur + immSize > maxEnd) return makeFallbackInsn(pos);
    cur += immSize;
  }

  d.len = cur - pos;
  d.valid = true;
  return d;
}

function resolveMemTarget(d, baseOff) {
  if (!d.hasMem || !d.memValid) return null;
  if (d.isRipRel) {
    const nextOff = d.off + d.len;
    const target = baseOff + nextOff + d.disp;
    if (target < -2147483648 || target > 2147483647) return null;
    return { baseReg: 16, disp: target | 0 };
  }
  // Exclude RSP(4) and RBP(5) ONLY; never exclude R12(12) or R13(13)
  if (d.baseReg === 4 || d.baseReg === 5) return null;
  return { baseReg: d.baseReg, disp: d.disp };
}

function isDirectClampInsn(d) {
  if (!d.valid || d.isVex) return false;
  const op = d.opcode;
  if (d.map === 0) {
    if (op >= 0x38 && op <= 0x3D) return true;
    if ((op === 0x80 || op === 0x81 || op === 0x83) && d.regField === 7) return true;
    if (op === 0x84 || op === 0x85 || op === 0xA8 || op === 0xA9) return true;
    if ((op === 0xF6 || op === 0xF7) && (d.regField === 0 || d.regField === 1)) return true;
    if (op >= 0x70 && op <= 0x7F) return true;
  } else if (d.map === 1) {
    if (op >= 0x40 && op <= 0x4F) return true;
    if (op >= 0x80 && op <= 0x8F) return true;
  }
  return false;
}

function isLmsClampInsn(d) {
  if (!d.valid) return false;
  if (isDirectClampInsn(d)) return true;
  if (d.map === 1) {
    if (d.opcode === 0x2E || d.opcode === 0x2F) return true;
    if (d.opcode === 0x5D || d.opcode === 0x5F) return true;
  }
  return false;
}

function isControlBarrier(d) {
  if (!d.valid || d.isVex || d.map !== 0) return false;
  const op = d.opcode;
  if (op === 0xC2 || op === 0xC3 || op === 0xCA || op === 0xCB) return true;
  if (op === 0xE8 || op === 0xE9 || op === 0xEB) return true;
  if (op === 0xFF && (d.regField === 2 || d.regField === 3 || d.regField === 4 || d.regField === 5)) {
    return true;
  }
  return false;
}

function gpOpWidth(d, isByteOp) {
  if (isByteOp) return 1;
  if (d.rexW) return 8;
  if (d.has66) return 2;
  return 4;
}

function getOtherGpWriteReg(d) {
  if (!d.valid || d.isVex) return 255;
  const op = d.opcode;
  if (d.map === 0) {
    if (op === 0x88 || op === 0x89) return d.mod === 3 ? d.rmRegNum : 255;
    if (op === 0x8A || op === 0x8B) return d.mod === 3 ? d.regNum : 255;
    if (op === 0x8D) return d.regNum;
    if (op >= 0x58 && op <= 0x5F) return (d.rexB << 3) | (op & 7);
    if (op >= 0xB0 && op <= 0xBF) return (d.rexB << 3) | (op & 7);
    if ((op === 0xC6 || op === 0xC7 || op === 0x8F) && d.mod === 3 && d.regField === 0) {
      return d.rmRegNum;
    }
    if (
      (op === 0x08 || op === 0x09 || op === 0x10 || op === 0x11
        || op === 0x18 || op === 0x19 || op === 0x20 || op === 0x21
        || op === 0x30 || op === 0x31) && d.mod === 3
    ) {
      return d.rmRegNum;
    }
    if (
      op === 0x0A || op === 0x0B || op === 0x12 || op === 0x13
      || op === 0x1A || op === 0x1B || op === 0x22 || op === 0x23
      || op === 0x32 || op === 0x33
    ) {
      return d.regNum;
    }
    if ((op === 0x80 || op === 0x81 || op === 0x83) && d.mod === 3 && d.regField !== 7) {
      return d.rmRegNum;
    }
    if ((op === 0xC0 || op === 0xC1 || (op >= 0xD0 && op <= 0xD3)) && d.mod === 3) {
      return d.rmRegNum;
    }
    if ((op === 0xF6 || op === 0xF7) && d.mod === 3 && (d.regField === 2 || d.regField === 3)) {
      return d.rmRegNum;
    }
    if (op === 0x69 || op === 0x6B) return d.regNum;
  } else if (d.map === 1) {
    if (op === 0xAF) return d.regNum;
    if (op >= 0x40 && op <= 0x4F) return d.regNum;
    if ((op === 0xB6 || op === 0xB7 || op === 0xBE || op === 0xBF) && d.mod === 3) {
      return d.regNum;
    }
  }
  return 255;
}

function scanX86_64RmwCoreJs(code, baseOff, maxOut, collectHits) {
  const MAX_PENDING = 16;
  const MAX_PCLAMP = 4;
  const pending = new Array(MAX_PENDING);
  for (let i = 0; i < MAX_PENDING; i++) pending[i] = { active: false };
  const pclamp = new Array(MAX_PCLAMP);
  for (let i = 0; i < MAX_PCLAMP; i++) pclamp[i] = { active: false };
  let pclampCursor = 0;

  const hits = collectHits ? [] : null;
  const summary = { clampedSub: 0, unclampedSub: 0, addRmw: 0, totalHits: 0 };

  let insnIdx = 0;
  let lastDirectClampIdx = -100;

  const emitHit = (hit, isDirect) => {
    const isClamped = (hit.flags & 1) !== 0;
    let storedIdx = -1;
    if (collectHits && hits.length < maxOut) {
      storedIdx = hits.length;
      hits.push(hit);
    }
    summary.totalHits++;
    if (hit.opKind === 1) {
      if (isClamped) summary.clampedSub++;
      else summary.unclampedSub++;
    } else if (hit.opKind === 2) {
      summary.addRmw++;
    }
    if (!isClamped) {
      pclamp[pclampCursor] = {
        active: true,
        isDirect,
        clamped: false,
        opKind: hit.opKind,
        emitInsnIdx: insnIdx,
        hitIndex: storedIdx,
      };
      pclampCursor = (pclampCursor + 1) & (MAX_PCLAMP - 1);
    }
  };

  const invalidateBaseReg = (gpReg) => {
    for (let i = 0; i < MAX_PENDING; i++) {
      if (pending[i].active && pending[i].baseReg === gpReg) {
        pending[i].active = false;
      }
    }
  };

  let pos = 0;
  const codeLen = code.length;
  while (pos < codeLen) {
    const d = decodeX86_64Insn(code, codeLen, pos);
    pos += d.len;

    for (let i = 0; i < MAX_PENDING; i++) {
      if (pending[i].active && (insnIdx - pending[i].loadInsnIdx) > 16) {
        pending[i].active = false;
      }
    }

    if (!d.valid) {
      insnIdx++;
      continue;
    }

    if (isControlBarrier(d)) {
      for (let i = 0; i < MAX_PENDING; i++) pending[i].active = false;
      for (let i = 0; i < MAX_PCLAMP; i++) pclamp[i].active = false;
      insnIdx++;
      continue;
    }

    const dirClamp = isDirectClampInsn(d);
    const lmsClamp = dirClamp || isLmsClampInsn(d);

    if (dirClamp) {
      lastDirectClampIdx = insnIdx;
    }
    if (lmsClamp) {
      for (let i = 0; i < MAX_PCLAMP; i++) {
        const pc = pclamp[i];
        if (!pc.active || pc.clamped) continue;
        if ((insnIdx - pc.emitInsnIdx) > 3) {
          pc.active = false;
          continue;
        }
        if (pc.isDirect && !dirClamp) continue;
        pc.clamped = true;
        pc.active = false;
        if (pc.hitIndex >= 0 && hits) {
          hits[pc.hitIndex].flags |= 1;
          hits[pc.hitIndex].clamped = true;
        }
        if (pc.opKind === 1 && summary.unclampedSub > 0) {
          summary.unclampedSub--;
          summary.clampedSub++;
        }
      }
      for (let i = 0; i < MAX_PENDING; i++) {
        if (pending[i].active) pending[i].clamped = true;
      }
    }

    // 1. Direct memory RMW
    if (!d.isVex && d.map === 0 && d.hasMem && d.memValid) {
      let dirOpKind = 0;
      let isByteOp = false;
      const op = d.opcode;
      if (op === 0x00 || op === 0x01) {
        dirOpKind = 2;
        isByteOp = op === 0x00;
      } else if (op === 0x28 || op === 0x29) {
        dirOpKind = 1;
        isByteOp = op === 0x28;
      } else if (op === 0x80 || op === 0x81 || op === 0x83) {
        if (d.regField === 0) dirOpKind = 2;
        else if (d.regField === 5) dirOpKind = 1;
        isByteOp = op === 0x80;
      } else if (op === 0xFE || op === 0xFF) {
        if (d.regField === 0) dirOpKind = 2;
        else if (d.regField === 1) dirOpKind = 1;
        isByteOp = op === 0xFE;
      }

      if (dirOpKind !== 0) {
        const target = resolveMemTarget(d, baseOff);
        if (target) {
          const preClamped = (insnIdx - lastDirectClampIdx) <= 3;
          const flags = (preClamped ? 1 : 0) | 4 | (d.hasLock ? 8 : 0);
          emitHit({
            loadOff: d.off,
            storeOff: d.off,
            arithOff: d.off,
            disp: target.disp,
            baseReg: target.baseReg,
            opKind: dirOpKind,
            clamped: (flags & 1) !== 0,
            isFloat: false,
            directRmw: true,
            locked: (flags & 8) !== 0,
            width: gpOpWidth(d, isByteOp),
            flags,
          }, true);
        }
        insnIdx++;
        continue;
      }
    }

    // 2. Store matching a modified pending load
    if (!d.isVex && d.hasMem && d.memValid) {
      let isStore = false;
      let isFloatStore = false;
      let storeWidth = 0;
      if (d.map === 0 && (d.opcode === 0x88 || d.opcode === 0x89)) {
        isStore = true;
        isFloatStore = false;
        storeWidth = gpOpWidth(d, d.opcode === 0x88);
      } else if (d.map === 1 && d.opcode === 0x11 && (d.hasRep || d.hasRepne)) {
        isStore = true;
        isFloatStore = true;
        storeWidth = d.hasRepne ? 8 : 4;
      }

      if (isStore) {
        const target = resolveMemTarget(d, baseOff);
        if (target) {
          let bestSlot = -1;
          for (let i = 0; i < MAX_PENDING; i++) {
            const pl = pending[i];
            if (!pl.active) continue;
            if (pl.isFloat !== isFloatStore) continue;
            if (pl.reg !== d.regNum) continue;
            if (pl.baseReg !== target.baseReg) continue;
            if (pl.disp !== target.disp) continue;
            if (pl.opKind === 0) continue;
            if ((insnIdx - pl.loadInsnIdx) > 16) continue;
            if (bestSlot < 0 || pl.loadInsnIdx > pending[bestSlot].loadInsnIdx) {
              bestSlot = i;
            }
          }
          if (bestSlot >= 0) {
            const pl = pending[bestSlot];
            const flags = (pl.clamped ? 1 : 0) | (pl.isFloat ? 2 : 0);
            emitHit({
              loadOff: pl.loadOff,
              storeOff: d.off,
              arithOff: pl.arithOff,
              disp: pl.disp,
              baseReg: pl.baseReg,
              opKind: pl.opKind,
              clamped: (flags & 1) !== 0,
              isFloat: (flags & 2) !== 0,
              directRmw: false,
              locked: false,
              width: storeWidth,
              flags,
            }, false);
            pl.active = false;
          }
        }
        insnIdx++;
        continue;
      }
    }

    // 3. Load (GP or Scalar FP)
    if (!d.isVex && d.hasMem && d.memValid) {
      let isLoad = false;
      let isFloatLoad = false;
      let loadWidth = 0;
      if (d.map === 0 && (d.opcode === 0x8A || d.opcode === 0x8B || d.opcode === 0x63)) {
        isLoad = true;
        isFloatLoad = false;
        loadWidth = d.opcode === 0x63 ? 4 : gpOpWidth(d, d.opcode === 0x8A);
      } else if (
        d.map === 1
        && (d.opcode === 0xB6 || d.opcode === 0xB7 || d.opcode === 0xBE || d.opcode === 0xBF)
      ) {
        isLoad = true;
        isFloatLoad = false;
        loadWidth = (d.opcode === 0xB6 || d.opcode === 0xBE) ? 1 : 2;
      } else if (d.map === 1 && d.opcode === 0x10 && (d.hasRep || d.hasRepne)) {
        isLoad = true;
        isFloatLoad = true;
        loadWidth = d.hasRepne ? 8 : 4;
      }

      if (isLoad) {
        if (!isFloatLoad) {
          invalidateBaseReg(d.regNum);
        }
        for (let i = 0; i < MAX_PENDING; i++) {
          if (pending[i].active && pending[i].isFloat === isFloatLoad && pending[i].reg === d.regNum) {
            pending[i].active = false;
          }
        }
        const target = resolveMemTarget(d, baseOff);
        if (target) {
          let targetSlot = -1;
          let oldestSlot = 0;
          for (let i = 0; i < MAX_PENDING; i++) {
            if (!pending[i].active) {
              targetSlot = i;
              break;
            }
            if (pending[i].loadInsnIdx < pending[oldestSlot].loadInsnIdx) {
              oldestSlot = i;
            }
          }
          if (targetSlot < 0) targetSlot = oldestSlot;
          pending[targetSlot] = {
            active: true,
            isFloat: isFloatLoad,
            reg: d.regNum,
            baseReg: target.baseReg,
            width: loadWidth,
            opKind: 0,
            clamped: false,
            disp: target.disp,
            loadOff: d.off,
            arithOff: 0,
            loadInsnIdx: insnIdx,
          };
        }
        insnIdx++;
        continue;
      }
    }

    // 4. Modify (GP add/sub/inc/dec or Scalar FP addss/subss/addsd/subsd)
    if (!d.isVex) {
      let modOpKind = 0;
      let modIsFloat = false;
      let modDst = 255;

      if (d.map === 0) {
        const op = d.opcode;
        if ((op === 0x00 || op === 0x01) && d.mod === 3) {
          modOpKind = 2;
          modDst = d.rmRegNum;
        } else if (op === 0x02 || op === 0x03) {
          modOpKind = 2;
          modDst = d.regNum;
        } else if (op === 0x04 || op === 0x05) {
          modOpKind = 2;
          modDst = 0;
        } else if ((op === 0x28 || op === 0x29) && d.mod === 3) {
          modOpKind = 1;
          modDst = d.rmRegNum;
        } else if (op === 0x2A || op === 0x2B) {
          modOpKind = 1;
          modDst = d.regNum;
        } else if (op === 0x2C || op === 0x2D) {
          modOpKind = 1;
          modDst = 0;
        } else if ((op === 0x80 || op === 0x81 || op === 0x83) && d.mod === 3) {
          if (d.regField === 0) {
            modOpKind = 2;
            modDst = d.rmRegNum;
          } else if (d.regField === 5) {
            modOpKind = 1;
            modDst = d.rmRegNum;
          }
        } else if ((op === 0xFE || op === 0xFF) && d.mod === 3) {
          if (d.regField === 0) {
            modOpKind = 2;
            modDst = d.rmRegNum;
          } else if (d.regField === 1) {
            modOpKind = 1;
            modDst = d.rmRegNum;
          }
        }
      } else if (d.map === 1 && (d.opcode === 0x58 || d.opcode === 0x5C) && (d.hasRep || d.hasRepne)) {
        modOpKind = d.opcode === 0x58 ? 2 : 1;
        modIsFloat = true;
        modDst = d.regNum;
      }

      if (modOpKind !== 0 && modDst < 16) {
        if (!modIsFloat) {
          invalidateBaseReg(modDst);
        }
        for (let i = 0; i < MAX_PENDING; i++) {
          if (
            pending[i].active
            && pending[i].isFloat === modIsFloat
            && pending[i].reg === modDst
            && pending[i].opKind === 0
          ) {
            pending[i].opKind = modOpKind;
            pending[i].arithOff = d.off;
          }
        }
        insnIdx++;
        continue;
      }
    }

    // 5. Other GP register write invalidates pending loads using that register as baseReg
    const writtenGp = getOtherGpWriteReg(d);
    if (writtenGp < 16) {
      invalidateBaseReg(writtenGp);
    }

    insnIdx++;
  }

  return { hits: hits || [], summary };
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
      directRmw: (flags & 4) !== 0,
      locked: (flags & 8) !== 0,
      width,
      flags,
    };
  }
  return out;
}

function mergeChunkHits(target, seen, chunkHits, chunkStart, minRelOff = 0) {
  for (let i = 0; i < chunkHits.length; i++) {
    const h = chunkHits[i];
    if (h.loadOff < minRelOff) continue;
    const loadOff = h.loadOff + chunkStart;
    const storeOff = h.storeOff + chunkStart;
    const arithOff = h.arithOff + chunkStart;
    const key = `${loadOff}:${storeOff}`;
    const existingIdx = seen.get(key);
    const merged = {
      loadOff,
      storeOff,
      arithOff,
      disp: h.disp,
      baseReg: h.baseReg,
      opKind: h.opKind,
      clamped: (h.flags & 1) !== 0,
      isFloat: (h.flags & 2) !== 0,
      directRmw: (h.flags & 4) !== 0,
      locked: (h.flags & 8) !== 0,
      width: h.width,
      flags: h.flags,
    };
    if (existingIdx !== undefined) {
      if (merged.flags > target[existingIdx].flags) {
        target[existingIdx] = merged;
      }
      continue;
    }
    seen.set(key, target.length);
    target.push(merged);
  }
}

function runChunkedScan(u8, maxOut, effChunkSize, scanChunk) {
  const hits = [];
  const seen = new Map();
  let truncated = false;

  const effOverlap = effChunkSize > OVERLAP
    ? OVERLAP
    : Math.max(16, Math.floor(effChunkSize / 2));
  const chunkMaxOut = Math.min(CHUNK_MAX_OUT, maxOut + 1);
  const minBisectLen = Math.max(effOverlap * 4, 512);
  const syncGuard = Math.min(16, Math.floor(effOverlap / 2));

  const scanRange = (start, end, depth) => {
    const len = end - start;
    if (len < 1) return true;
    const chunk = u8.subarray(start, end);
    const chunkHits = scanChunk(chunk, chunkMaxOut, start);
    if (chunkHits === null) return false;

    if (chunkHits.length >= chunkMaxOut) {
      if (depth < MAX_BISECT_DEPTH && len >= minBisectLen) {
        const mid = start + Math.floor(len / 2);
        const leftEnd = Math.min(end, mid + effOverlap);
        const rightStart = Math.max(start, mid - effOverlap);
        if (!scanRange(start, leftEnd, depth + 1)) return false;
        if (!scanRange(rightStart, end, depth + 1)) return false;
        return true;
      }
      truncated = true;
    }

    mergeChunkHits(hits, seen, chunkHits, start, start > 0 ? syncGuard : 0);
    return true;
  };

  let chunkStart = 0;
  while (chunkStart < u8.length) {
    const chunkEnd = Math.min(u8.length, chunkStart + effChunkSize);
    if (!scanRange(chunkStart, chunkEnd, 0)) {
      return null;
    }
    if (chunkEnd >= u8.length) break;
    const nextStart = chunkEnd - effOverlap;
    chunkStart = nextStart > chunkStart ? nextStart : chunkEnd;
  }

  hits.sort((a, b) => (a.loadOff - b.loadOff) || (a.storeOff - b.storeOff));
  if (hits.length > maxOut) {
    hits.length = maxOut;
    truncated = true;
  }

  return { hits, truncated };
}

export function scanX86_64RmwFields(bytes, opts = {}) {
  const {
    arch = 'x86_64',
    maxOut: rawMaxOut = DEFAULT_MAX_OUT,
    chunkSize,
  } = opts || {};

  if (!isX86_64Arch(arch)) {
    return { hits: [], engine: 'js', truncated: false, unsupportedArch: true };
  }

  const maxOut = (rawMaxOut != null && rawMaxOut !== '' && Number.isFinite(Number(rawMaxOut)))
    ? Math.max(0, Math.min(SAFE_MAX_OUT, Math.floor(Number(rawMaxOut))))
    : DEFAULT_MAX_OUT;

  const u8 = toU8(bytes);
  if (!u8 || u8.length < 1 || maxOut === 0) {
    return { hits: [], engine: 'js', truncated: false, unsupportedArch: false };
  }

  const effChunkSize = resolveChunkSize(chunkSize);
  const engineOpts = normalizeEngineOpts(opts);
  const ex = resolveWasmExports(opts, engineOpts, 'hex_scan_x86_64_rmw_fields', 'x86_64_rmw_scanner');

  if (ex) {
    const hasScratch = typeof ex.hex_engine_scratch_reset === 'function'
      && typeof ex.hex_engine_scratch_alloc === 'function';
    try {
      const wasmResult = runChunkedScan(u8, maxOut, effChunkSize, (chunk, chunkMaxOut, chunkStart) => {
        try {
          let inPtr = 0;
          let outPtr = 0;
          const outBytes = chunkMaxOut * RMW_HIT_BYTES;
          if (hasScratch) {
            ex.hex_engine_scratch_reset();
            inPtr = ex.hex_engine_scratch_alloc(chunk.length) >>> 0;
            outPtr = ex.hex_engine_scratch_alloc(outBytes) >>> 0;
            if (inPtr === 0 || outPtr === 0) {
              recordFallback('x86_64_rmw_scanner:oom');
              return null;
            }
          } else {
            const base = getStandaloneHeapBase(ex);
            inPtr = base;
            outPtr = (inPtr + chunk.length + 7) & ~7;
            if (!ensureWasmMemory(ex.memory, outPtr + outBytes)) {
              recordFallback('x86_64_rmw_scanner:oom');
              return null;
            }
          }
          new Uint8Array(ex.memory.buffer, inPtr, chunk.length).set(chunk);
          const count = ex.hex_scan_x86_64_rmw_fields(
            inPtr,
            chunk.length,
            chunkStart >>> 0,
            outPtr,
            chunkMaxOut,
          ) >>> 0;
          return decodeWasmHits(ex.memory.buffer, outPtr, count);
        } finally {
          if (hasScratch) ex.hex_engine_scratch_reset();
        }
      });

      if (wasmResult !== null) {
        recordWasmCall('x86_64_rmw_scanner');
        return {
          hits: wasmResult.hits,
          engine: 'wasm',
          truncated: wasmResult.truncated,
          unsupportedArch: false,
        };
      }
    } catch {
      recordFallback('x86_64_rmw_scanner:wasm_exception');
    }
  }

  const jsResult = runChunkedScan(u8, maxOut, effChunkSize, (chunk, chunkMaxOut, chunkStart) => (
    scanX86_64RmwCoreJs(chunk, chunkStart, chunkMaxOut, true).hits
  ));

  return {
    hits: jsResult.hits,
    engine: 'js',
    truncated: jsResult.truncated,
    unsupportedArch: false,
  };
}

function isHwCryptoInsn(d) {
  if (!d.valid) return false;
  if (d.has66) {
    if (d.map === 2 && d.opcode >= 0xDB && d.opcode <= 0xDF) return true;
    if (d.map === 3 && d.opcode === 0xDF) return true;
  }
  if (!d.isVex && d.map === 2 && d.opcode >= 0xC8 && d.opcode <= 0xCD) return true;
  return false;
}

function isRetInsn(d) {
  return d.valid && !d.isVex && d.map === 0
    && (d.opcode === 0xC2 || d.opcode === 0xC3 || d.opcode === 0xCA || d.opcode === 0xCB);
}

function isCallInsn(d) {
  return d.valid && !d.isVex && d.map === 0
    && (d.opcode === 0xE8 || (d.opcode === 0xFF && (d.regField === 2 || d.regField === 3)));
}

function isLoadInsn(d) {
  if (!d.valid || d.isVex || !d.hasMem) return false;
  if (d.map === 0 && (d.opcode === 0x8A || d.opcode === 0x8B || d.opcode === 0x63)) return true;
  if (d.map === 1 && (d.opcode === 0xB6 || d.opcode === 0xB7 || d.opcode === 0xBE || d.opcode === 0xBF)) {
    return true;
  }
  if (d.map === 1 && d.opcode === 0x10 && (d.hasRep || d.hasRepne)) return true;
  return false;
}

function isStoreInsn(d) {
  if (!d.valid || d.isVex || !d.hasMem) return false;
  if (d.map === 0) {
    const op = d.opcode;
    if (op === 0x88 || op === 0x89) return true;
    if ((op === 0xC6 || op === 0xC7) && d.regField === 0) return true;
    if (op === 0x00 || op === 0x01 || op === 0x28 || op === 0x29) return true;
    if ((op === 0x80 || op === 0x81 || op === 0x83) && (d.regField === 0 || d.regField === 5)) {
      return true;
    }
    if ((op === 0xFE || op === 0xFF) && (d.regField === 0 || d.regField === 1)) {
      return true;
    }
  } else if (d.map === 1 && d.opcode === 0x11 && (d.hasRep || d.hasRepne)) {
    return true;
  }
  return false;
}

function isMulDivInsn(d) {
  if (!d.valid || d.isVex) return false;
  if (d.map === 0) {
    if (d.opcode === 0x69 || d.opcode === 0x6B) return true;
    if ((d.opcode === 0xF6 || d.opcode === 0xF7) && d.regField >= 4 && d.regField <= 7) return true;
  } else if (d.map === 1 && d.opcode === 0xAF) {
    return true;
  }
  return false;
}

function isFpInsn(d) {
  if (!d.valid) return false;
  if (d.map === 1) {
    const op = d.opcode;
    if (op >= 0x2A && op <= 0x2F) return true;
    if ((op >= 0x51 && op <= 0x53) || (op >= 0x58 && op <= 0x5F)) return true;
  }
  return false;
}

function isBitwiseInsn(d) {
  if (!d.valid || d.isVex) return false;
  if (d.map === 0) {
    const op = d.opcode;
    if ((op >= 0x08 && op <= 0x0D) || (op >= 0x20 && op <= 0x25)) return true;
    if (op >= 0x30 && op <= 0x33) {
      if (d.mod === 3 && d.regNum === d.rmRegNum) return false;
      return true;
    }
    if (op === 0x34 || op === 0x35) return true;
    if (
      (op === 0x80 || op === 0x81 || op === 0x83)
      && (d.regField === 1 || d.regField === 4 || d.regField === 6)
    ) {
      return true;
    }
    if ((op === 0xF6 || op === 0xF7) && d.regField === 2) return true;
    if (op === 0xC0 || op === 0xC1 || (op >= 0xD0 && op <= 0xD3)) return true;
  } else if (d.map === 1) {
    const op = d.opcode;
    if (op === 0xA4 || op === 0xA5 || op === 0xAC || op === 0xAD) return true;
    if (op >= 0xC8 && op <= 0xCF) return true;
  }
  return false;
}

function satMul1000(count, weight) {
  if (count <= 0 || weight <= 0) return 0;
  const prod = count * weight;
  return prod > 1000 ? 1000 : prod;
}

function makeInvalidBehaviorResult({ truncated = false, unsupportedArch = false } = {}) {
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

function classifyX86_64BehaviorJs(u8, truncated) {
  const { summary: rmw } = scanX86_64RmwCoreJs(u8, 0, 0, false);

  let insnCount = 0;
  let clampOps = 0;
  let hwCrypto = 0;
  let retOps = 0;
  let loadOps = 0;
  let storeOps = 0;
  let muldivOps = 0;
  let fpOps = 0;
  let bitwiseOps = 0;
  let callOps = 0;

  let pos = 0;
  const codeLen = u8.length;
  while (pos < codeLen) {
    const d = decodeX86_64Insn(u8, codeLen, pos);
    pos += d.len;
    insnCount++;

    if (!d.valid) continue;

    if (isLmsClampInsn(d)) clampOps++;
    if (isHwCryptoInsn(d)) hwCrypto++;
    if (isRetInsn(d)) retOps++;
    if (isCallInsn(d)) callOps++;
    if (isLoadInsn(d)) loadOps++;
    if (isStoreInsn(d)) storeOps++;
    if (isMulDivInsn(d)) muldivOps++;
    if (isFpInsn(d)) fpOps++;
    if (isBitwiseInsn(d)) bitwiseOps++;
  }

  const drainScore = Math.min(
    1000,
    satMul1000(rmw.clampedSub, 450)
    + satMul1000(rmw.unclampedSub, 250)
    + satMul1000(clampOps, 40),
  );
  const accumScore = Math.min(
    1000,
    satMul1000(rmw.addRmw, 350)
    + satMul1000(storeOps, 40),
  );
  const ratioScore = Math.min(
    1000,
    satMul1000(muldivOps, 220)
    + satMul1000(fpOps, 120),
  );
  const cryptoScore = Math.min(
    1000,
    satMul1000(hwCrypto, 500)
    + satMul1000(bitwiseOps, 80),
  );
  const accessorScore = (
    insnCount <= 8
    && callOps === 0
    && (loadOps + storeOps) >= 1
    && retOps >= 1
    && rmw.clampedSub === 0
    && rmw.unclampedSub === 0
    && rmw.addRmw === 0
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
    (rmw.clampedSub > 0 ? 1 : 0)
    | (hwCrypto > 0 ? 2 : 0)
    | (muldivOps > 0 ? 4 : 0)
    | (rmw.addRmw > 0 ? 8 : 0)
    | (accessorScore > 0 ? 16 : 0)
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

export function classifyX86_64Behavior(bytes, opts = {}) {
  const { arch = 'x86_64' } = opts || {};
  if (!isX86_64Arch(arch)) {
    return makeInvalidBehaviorResult({ truncated: false, unsupportedArch: true });
  }

  const raw = toU8(bytes);
  if (!raw || raw.length < 1) {
    return makeInvalidBehaviorResult({ truncated: false, unsupportedArch: false });
  }

  let u8 = raw;
  let truncated = false;
  if (raw.length > SCRATCH_CHUNK_MAX) {
    u8 = raw.subarray(0, SCRATCH_CHUNK_MAX);
    truncated = true;
  }

  const engineOpts = normalizeEngineOpts(opts);
  const ex = resolveWasmExports(opts, engineOpts, 'hex_classify_x86_64_behavior', 'x86_64_behavior_classifier');

  if (ex) {
    const hasScratch = typeof ex.hex_engine_scratch_reset === 'function'
      && typeof ex.hex_engine_scratch_alloc === 'function';
    try {
      let inPtr = 0;
      let outPtr = 0;
      if (hasScratch) {
        ex.hex_engine_scratch_reset();
        inPtr = ex.hex_engine_scratch_alloc(u8.length) >>> 0;
        outPtr = ex.hex_engine_scratch_alloc(BEHAVIOR_OUT_BYTES) >>> 0;
        if (inPtr === 0 || outPtr === 0) {
          recordFallback('x86_64_behavior_classifier:oom');
          return classifyX86_64BehaviorJs(u8, truncated);
        }
      } else {
        const base = getStandaloneHeapBase(ex);
        inPtr = base;
        outPtr = (inPtr + u8.length + 7) & ~7;
        if (!ensureWasmMemory(ex.memory, outPtr + BEHAVIOR_OUT_BYTES)) {
          recordFallback('x86_64_behavior_classifier:oom');
          return classifyX86_64BehaviorJs(u8, truncated);
        }
      }

      new Uint8Array(ex.memory.buffer, inPtr, u8.length).set(u8);
      const ok = ex.hex_classify_x86_64_behavior(inPtr, u8.length, outPtr) >>> 0;
      if (ok === 1) {
        const dv = new DataView(ex.memory.buffer, outPtr, BEHAVIOR_OUT_BYTES);
        recordWasmCall('x86_64_behavior_classifier');
        return {
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
      }
      recordFallback('x86_64_behavior_classifier:wasm_returned_zero');
    } catch {
      recordFallback('x86_64_behavior_classifier:wasm_exception');
    } finally {
      if (hasScratch) ex.hex_engine_scratch_reset();
    }
  }

  return classifyX86_64BehaviorJs(u8, truncated);
}
