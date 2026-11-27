/**
 * Shared ARM64 instruction bit-level decoder and RMW core.
 * 1:1 parity implementation of cpp/include/arm64_insn_bits.hpp for JS fallbacks.
 * Zero external dependencies.
 */

export const INSN_CLASS = Object.freeze({
  OTHER: 0,
  ARITH: 1,
  MULDIV: 2,
  BITWISE: 3,
  FP_SIMD: 4,
  LOAD: 5,
  STORE: 6,
  COND_BR: 7,
  UNCOND_BR: 8,
  CALL_DIR: 9,
  CALL_IND: 10,
  CRYPTO_SYS: 11,
});

export function readU32LE(u8, off) {
  return ((u8[off]) |
    (u8[off + 1] << 8) |
    (u8[off + 2] << 16) |
    (u8[off + 3] << 24)) >>> 0;
}

export function isHwCrypto(w) {
  w = w >>> 0;
  if (((w & 0xFF3E0C00) >>> 0) === 0x4E280800) {
    const op = (w >>> 12) & 0x1F;
    if (op >= 4 && op <= 7) return true;
  }
  if (((w & 0xFF208C00) >>> 0) === 0x5E000000) return true;
  if (((w & 0xFF3E0C00) >>> 0) === 0x5E280800) return true;
  if (((w & 0xFF000000) >>> 0) === 0xCE000000) return true;
  if (((w & 0x7FE0E000) >>> 0) === 0x1AC04000) return true;
  return false;
}

export function isRet(w) {
  w = w >>> 0;
  return (((w & 0xFFFFFC1F) >>> 0) === 0xD65F0000) ||
    (((w & 0xFFFFFBFF) >>> 0) === 0xD65F0BFF);
}

export function decodeBrReg(w) {
  w = w >>> 0;
  if (((w & 0xFFFFFC1F) >>> 0) === 0xD61F0000) {
    return (w >>> 5) & 31;
  }
  return -1;
}

export function isCallOrRet(w) {
  w = w >>> 0;
  if (((w & 0xFC000000) >>> 0) === 0x94000000) return true;
  if (((w & 0xFFFFFC1F) >>> 0) === 0xD63F0000) return true;
  if (((w & 0xFEFFF800) >>> 0) === 0xD63F0800) return true;
  return isRet(w);
}

export function isUncondBranch(w) {
  w = w >>> 0;
  if (((w & 0xFC000000) >>> 0) === 0x14000000) return true;
  return decodeBrReg(w) >= 0;
}

export function isCondBranch(w) {
  w = w >>> 0;
  if (((w & 0xFF000010) >>> 0) === 0x54000000) return true;
  if (((w & 0x7E000000) >>> 0) === 0x34000000) return true;
  if (((w & 0x7E000000) >>> 0) === 0x36000000) return true;
  return false;
}

export function decodeImmMem(w) {
  w = w >>> 0;
  const isUnsignedOff = ((w & 0x3B000000) >>> 0) === 0x39000000;
  const isUnscaledOff = ((w & 0x3B200C00) >>> 0) === 0x38000000;
  if (!isUnsignedOff && !isUnscaledOff) return null;

  const size = (w >>> 30) & 3;
  const v = (w >>> 26) & 1;
  const opc = (w >>> 22) & 3;

  let width = 0;
  let isStore = false;
  if (v === 0) {
    if (opc === 0) {
      isStore = true;
      width = 1 << size;
    } else if (opc === 1) {
      isStore = false;
      width = 1 << size;
    } else if (opc === 2) {
      if (size === 3) return null;
      isStore = false;
      width = 1 << size;
    } else {
      if (size >= 2) return null;
      isStore = false;
      width = 1 << size;
    }
  } else {
    const scale = size | ((opc & 2) ? 4 : 0);
    if (scale > 4) return null;
    isStore = (opc & 1) === 0;
    width = 1 << scale;
  }

  let disp = 0;
  if (isUnsignedOff) {
    const imm12 = (w >>> 10) & 0xFFF;
    disp = (imm12 * width) | 0;
  } else {
    let imm9 = (w >>> 12) & 0x1FF;
    if (imm9 & 0x100) imm9 |= ~0x1FF;
    disp = imm9 | 0;
  }

  return {
    valid: true,
    isStore,
    isFloat: v !== 0,
    width,
    rt: w & 31,
    rn: (w >>> 5) & 31,
    disp,
  };
}

export function decodeRegOffsetLoad(w) {
  w = w >>> 0;
  if (((w & 0x3B200C00) >>> 0) !== 0x38200800) return null;
  if ((w & 0x04000000) !== 0) return null;
  const size = (w >>> 30) & 3;
  const opc = (w >>> 22) & 3;
  if (opc === 0) return null;
  if (opc === 2 && size === 3) return null;
  if (opc === 3 && size >= 2) return null;
  return {
    rt: w & 31,
    rn: (w >>> 5) & 31,
    rm: (w >>> 16) & 31,
    width: 1 << size,
  };
}

export function decodeArithAddSub(w) {
  w = w >>> 0;
  if (((w & 0x1F800000) >>> 0) === 0x11000000) {
    const rd = w & 31;
    if (rd === 31) return null;
    return {
      isSub: ((w >>> 30) & 1) !== 0,
      isFloat: false,
      rd,
      rn: (w >>> 5) & 31,
      rm: 31,
      hasRm: false,
    };
  }
  if (((w & 0x1F200000) >>> 0) === 0x0B000000 && ((w >>> 22) & 3) !== 3) {
    const rd = w & 31;
    if (rd === 31) return null;
    return {
      isSub: ((w >>> 30) & 1) !== 0,
      isFloat: false,
      rd,
      rn: (w >>> 5) & 31,
      rm: (w >>> 16) & 31,
      hasRm: true,
    };
  }
  if (((w & 0x1FE00000) >>> 0) === 0x0B200000) {
    const rd = w & 31;
    if (rd === 31) return null;
    return {
      isSub: ((w >>> 30) & 1) !== 0,
      isFloat: false,
      rd,
      rn: (w >>> 5) & 31,
      rm: (w >>> 16) & 31,
      hasRm: true,
    };
  }
  if (((w & 0xFF20EC00) >>> 0) === 0x1E202800) {
    const ftype = (w >>> 22) & 3;
    const opcode = (w >>> 12) & 0xF;
    if (ftype <= 1 && (opcode === 2 || opcode === 3)) {
      return {
        isSub: opcode === 3,
        isFloat: true,
        rd: w & 31,
        rn: (w >>> 5) & 31,
        rm: (w >>> 16) & 31,
        hasRm: true,
      };
    }
  }
  return null;
}

export function isClampOrCond(w) {
  w = w >>> 0;
  if (((w & 0x1FE00800) >>> 0) === 0x1A800000) return true;
  if (((w & 0xFF200C00) >>> 0) === 0x1E200C00) return true;
  if (((w & 0xFF20CC00) >>> 0) === 0x1E204800) {
    const op = (w >>> 12) & 0xF;
    if (op >= 4 && op <= 7) return true;
  }
  if (((w & 0x3F80001F) >>> 0) === 0x3100001F) return true;
  if (((w & 0x3F20001F) >>> 0) === 0x2B00001F) return true;
  if (((w & 0xFF20FC07) >>> 0) === 0x1E202000) return true;
  return isCondBranch(w);
}

export function decodeCmpImm(w) {
  w = w >>> 0;
  if (((w & 0x7F80001F) >>> 0) !== 0x7100001F) return null;
  const rn = (w >>> 5) & 31;
  const imm12 = (w >>> 10) & 0xFFF;
  const sh = (w >>> 22) & 1;
  return { rn, imm: sh ? (imm12 << 12) : imm12 };
}

export function decodeBHiHs(w) {
  w = w >>> 0;
  if (((w & 0xFF000010) >>> 0) !== 0x54000000) return null;
  const cond = w & 0xF;
  if (cond === 8) return { isHi: true };
  if (cond === 2) return { isHi: false };
  return null;
}

export function decodeAdrp(w) {
  w = w >>> 0;
  if (((w & 0x9F000000) >>> 0) !== 0x90000000) return null;
  const immhi = (w >>> 5) & 0x7FFFF;
  const immlo = (w >>> 29) & 3;
  let imm = BigInt((immhi << 2) | immlo);
  if (imm & (1n << 20n)) imm -= (1n << 21n);
  return { rd: w & 31, pageDelta: imm << 12n };
}

export function decodeAdr(w) {
  w = w >>> 0;
  if (((w & 0x9F000000) >>> 0) !== 0x10000000) return null;
  const immhi = (w >>> 5) & 0x7FFFF;
  const immlo = (w >>> 29) & 3;
  let imm = BigInt((immhi << 2) | immlo);
  if (imm & (1n << 20n)) imm -= (1n << 21n);
  return { rd: w & 31, delta: imm };
}

export function decodeAddImm(w) {
  w = w >>> 0;
  if (((w & 0x7F800000) >>> 0) !== 0x11000000) return null;
  const imm12 = (w >>> 10) & 0xFFF;
  const sh = (w >>> 22) & 1;
  return {
    rd: w & 31,
    rn: (w >>> 5) & 31,
    imm: sh ? (imm12 << 12) : imm12,
  };
}

export function isStpFpLr(w) {
  w = w >>> 0;
  return (((w & 0xFFC07FFF) >>> 0) === 0xA9807BFD) ||
    (((w & 0xFFC07FFF) >>> 0) === 0xA9007BFD);
}

export function decodeSubSpImm(w) {
  w = w >>> 0;
  if (((w & 0xFF8003FF) >>> 0) !== 0xD10003FF) return -1;
  const imm12 = (w >>> 10) & 0xFFF;
  const sh = (w >>> 22) & 1;
  return sh ? (imm12 << 12) : imm12;
}

export function classifyInsn(w) {
  w = w >>> 0;
  if (isHwCrypto(w)) return INSN_CLASS.CRYPTO_SYS;
  if (((w & 0xFC000000) >>> 0) === 0x94000000) return INSN_CLASS.CALL_DIR;
  if (((w & 0xFFFFFC1F) >>> 0) === 0xD63F0000 || ((w & 0xFEFFF800) >>> 0) === 0xD63F0800) {
    return INSN_CLASS.CALL_IND;
  }
  if (isCondBranch(w)) return INSN_CLASS.COND_BR;
  if (isUncondBranch(w) || isRet(w)) return INSN_CLASS.UNCOND_BR;

  const mem = decodeImmMem(w);
  if (mem) return mem.isStore ? INSN_CLASS.STORE : INSN_CLASS.LOAD;
  if (decodeRegOffsetLoad(w)) return INSN_CLASS.LOAD;
  if (((w & 0x3B200C00) >>> 0) === 0x38200800) {
    const v = (w >>> 26) & 1;
    const opc = (w >>> 22) & 3;
    const isStore = v ? ((opc & 1) === 0) : (opc === 0);
    return isStore ? INSN_CLASS.STORE : INSN_CLASS.LOAD;
  }
  if (((w & 0x3B200400) >>> 0) === 0x38000400) {
    const v = (w >>> 26) & 1;
    const opc = (w >>> 22) & 3;
    const isStore = v ? ((opc & 1) === 0) : (opc === 0);
    return isStore ? INSN_CLASS.STORE : INSN_CLASS.LOAD;
  }
  if (((w & 0x3A000000) >>> 0) === 0x28000000) {
    return ((w >>> 22) & 1) ? INSN_CLASS.LOAD : INSN_CLASS.STORE;
  }

  if (((w & 0x1E000000) >>> 0) === 0x1E000000 ||
      ((w & 0x0F000000) >>> 0) === 0x0E000000 ||
      ((w & 0x5E000000) >>> 0) === 0x4E000000) {
    return INSN_CLASS.FP_SIMD;
  }
  if (((w & 0x1F000000) >>> 0) === 0x1B000000 ||
      ((w & 0x7FE0F800) >>> 0) === 0x1AC00800) {
    return INSN_CLASS.MULDIV;
  }
  if (((w & 0x1F800000) >>> 0) === 0x11000000 ||
      ((w & 0x1F000000) >>> 0) === 0x0B000000) {
    return INSN_CLASS.ARITH;
  }
  if (((w & 0x1F000000) >>> 0) === 0x0A000000) {
    const opc = (w >>> 29) & 3;
    const N = (w >>> 21) & 1;
    const rn = (w >>> 5) & 31;
    if (opc === 1 && N === 0 && rn === 31) return INSN_CLASS.OTHER;
    return INSN_CLASS.BITWISE;
  }
  if (((w & 0x1F800000) >>> 0) === 0x12000000) {
    const opc = (w >>> 29) & 3;
    const rn = (w >>> 5) & 31;
    if (opc === 1 && rn === 31) return INSN_CLASS.OTHER;
    return INSN_CLASS.BITWISE;
  }
  if (((w & 0x1F800000) >>> 0) === 0x13000000 ||
      ((w & 0x7FE0F000) >>> 0) === 0x1AC02000) {
    return INSN_CLASS.BITWISE;
  }
  return INSN_CLASS.OTHER;
}

export function decodeRegUsage(w) {
  w = w >>> 0;
  const u = {
    gpRead: 0,
    gpWrite: 0,
    fpRead: 0,
    fpWrite: 0,
    gpBaseRead: 0,
    retWriteKind: 0,
    isCall: false,
    isRet: false,
    isBranch: false,
  };
  const addGpR = (r) => { if (r < 31) u.gpRead = (u.gpRead | (1 << r)) >>> 0; };
  const addGpW = (r, is64) => {
    if (r < 31) {
      u.gpWrite = (u.gpWrite | (1 << r)) >>> 0;
      if (r === 0) u.retWriteKind = is64 ? 2 : 1;
    }
  };
  const addFpR = (r) => { if (r < 32) u.fpRead = (u.fpRead | (1 << r)) >>> 0; };
  const addFpW = (r, is64) => {
    if (r < 32) {
      u.fpWrite = (u.fpWrite | (1 << r)) >>> 0;
      if (r === 0) u.retWriteKind = is64 ? 4 : 3;
    }
  };

  if (isRet(w)) { u.isRet = true; return u; }
  if (((w & 0xFC000000) >>> 0) === 0x94000000) { u.isCall = true; return u; }
  if (((w & 0xFFFFFC1F) >>> 0) === 0xD63F0000 || ((w & 0xFEFFF800) >>> 0) === 0xD63F0800) {
    u.isCall = true;
    addGpR((w >>> 5) & 31);
    return u;
  }
  if (((w & 0xFC000000) >>> 0) === 0x14000000) { u.isBranch = true; return u; }
  if (((w & 0xFFFFFC1F) >>> 0) === 0xD61F0000) {
    u.isBranch = true;
    addGpR((w >>> 5) & 31);
    return u;
  }
  if (((w & 0xFF000010) >>> 0) === 0x54000000) { u.isBranch = true; return u; }
  if (((w & 0x7E000000) >>> 0) === 0x34000000 || ((w & 0x7E000000) >>> 0) === 0x36000000) {
    u.isBranch = true;
    addGpR(w & 31);
    return u;
  }

  const mem = decodeImmMem(w);
  if (mem) {
    if (mem.rn < 31) {
      u.gpRead = (u.gpRead | (1 << mem.rn)) >>> 0;
      u.gpBaseRead = (u.gpBaseRead | (1 << mem.rn)) >>> 0;
    }
    if (mem.isStore) {
      if (mem.isFloat) addFpR(mem.rt);
      else addGpR(mem.rt);
    } else {
      if (mem.isFloat) addFpW(mem.rt, mem.width >= 8);
      else addGpW(mem.rt, mem.width >= 8);
    }
    return u;
  }

  const ro = decodeRegOffsetLoad(w);
  if (ro) {
    if (ro.rn < 31) {
      u.gpRead = (u.gpRead | (1 << ro.rn)) >>> 0;
      u.gpBaseRead = (u.gpBaseRead | (1 << ro.rn)) >>> 0;
    }
    addGpR(ro.rm);
    addGpW(ro.rt, ro.width >= 8);
    return u;
  }

  if (((w & 0x3A000000) >>> 0) === 0x28000000) {
    const rt = w & 31;
    const rn = (w >>> 5) & 31;
    const rt2 = (w >>> 10) & 31;
    const isLoad = ((w >>> 22) & 1) !== 0;
    const isFp = ((w >>> 26) & 1) !== 0;
    const opc = (w >>> 30) & 3;
    const is64 = opc !== 0;
    if (rn < 31) {
      u.gpRead = (u.gpRead | (1 << rn)) >>> 0;
      u.gpBaseRead = (u.gpBaseRead | (1 << rn)) >>> 0;
    }
    if (isLoad) {
      if (isFp) { addFpW(rt, is64); addFpW(rt2, is64); }
      else { addGpW(rt, is64); addGpW(rt2, is64); }
    } else {
      if (isFp) { addFpR(rt); addFpR(rt2); }
      else { addGpR(rt); addGpR(rt2); }
    }
    return u;
  }

  if (((w & 0x1F800000) >>> 0) === 0x12800000) {
    const is64 = ((w >>> 31) & 1) !== 0;
    const rd = w & 31;
    if (((w >>> 29) & 3) === 3) addGpR(rd);
    addGpW(rd, is64);
    return u;
  }

  if (((w & 0x1F000000) >>> 0) === 0x10000000) {
    addGpW(w & 31, true);
    return u;
  }

  if (((w & 0x1F800000) >>> 0) === 0x11000000) {
    const is64 = ((w >>> 31) & 1) !== 0;
    addGpR((w >>> 5) & 31);
    addGpW(w & 31, is64);
    return u;
  }

  if (((w & 0x1F000000) >>> 0) === 0x0B000000 || ((w & 0x1F000000) >>> 0) === 0x0A000000) {
    const is64 = ((w >>> 31) & 1) !== 0;
    addGpR((w >>> 5) & 31);
    addGpR((w >>> 16) & 31);
    addGpW(w & 31, is64);
    return u;
  }

  if (((w & 0x1F800000) >>> 0) === 0x12000000 || ((w & 0x1F800000) >>> 0) === 0x13000000) {
    const is64 = ((w >>> 31) & 1) !== 0;
    addGpR((w >>> 5) & 31);
    addGpW(w & 31, is64);
    return u;
  }

  if (((w & 0x1F000000) >>> 0) === 0x1B000000 ||
      ((w & 0x7FE0F800) >>> 0) === 0x1AC00800 ||
      ((w & 0x1FE00800) >>> 0) === 0x1A800000) {
    const is64 = ((w >>> 31) & 1) !== 0;
    addGpR((w >>> 5) & 31);
    addGpR((w >>> 16) & 31);
    addGpW(w & 31, is64);
    return u;
  }

  if (((w & 0xFF200C00) >>> 0) === 0x1E200800) {
    const ftype = (w >>> 22) & 3;
    if (ftype <= 1) {
      addFpR((w >>> 5) & 31);
      addFpR((w >>> 16) & 31);
      addFpW(w & 31, ftype === 1);
      return u;
    }
  }

  if (((w & 0xFF207C00) >>> 0) === 0x1E204000) {
    const ftype = (w >>> 22) & 3;
    if (ftype <= 1) {
      addFpR((w >>> 5) & 31);
      addFpW(w & 31, ftype === 1);
      return u;
    }
  }

  if (((w & 0xFF20FC07) >>> 0) === 0x1E202000) {
    const ftype = (w >>> 22) & 3;
    if (ftype <= 1) {
      addFpR((w >>> 5) & 31);
      if (((w >>> 3) & 1) === 0) addFpR((w >>> 16) & 31);
      return u;
    }
  }

  if (((w & 0xFF201FE0) >>> 0) === 0x1E201000) {
    const ftype = (w >>> 22) & 3;
    if (ftype <= 1) {
      addFpW(w & 31, ftype === 1);
      return u;
    }
  }

  return u;
}

export function scanArm64RmwCore(u8, maxOut = 4096, collectHits = true) {
  const summary = { total: 0, clampedSub: 0, unclampedSub: 0, addRmw: 0 };
  const hits = collectHits ? [] : null;
  if (!u8 || u8.length < 4) return { hits: hits || [], summary };
  if (collectHits && maxOut <= 0) return { hits: [], summary };

  const MAX_PENDING = 16;
  const MAX_WINDOW_BYTES = 64;
  const pending = new Array(MAX_PENDING);
  for (let i = 0; i < MAX_PENDING; i++) pending[i] = { active: false };

  const limit = u8.length & ~3;
  const clearAll = () => {
    for (let i = 0; i < MAX_PENDING; i++) pending[i].active = false;
  };

  for (let off = 0; off < limit; off += 4) {
    const w = readU32LE(u8, off);

    for (let i = 0; i < MAX_PENDING; i++) {
      if (pending[i].active && (off - pending[i].loadOff) > MAX_WINDOW_BYTES) {
        pending[i].active = false;
      }
    }

    if (isCallOrRet(w) || isUncondBranch(w)) {
      clearAll();
      continue;
    }

    if (isClampOrCond(w)) {
      for (let i = 0; i < MAX_PENDING; i++) {
        if (pending[i].active) pending[i].clamped = true;
      }
    }

    const mem = decodeImmMem(w);
    if (mem) {
      if (!mem.isStore) {
        if (!mem.isFloat && mem.rt < 31) {
          for (let i = 0; i < MAX_PENDING; i++) {
            if (pending[i].active && pending[i].baseReg === mem.rt) {
              pending[i].active = false;
            }
          }
        }
        if (mem.rn !== 31 && mem.rn !== 29 && (mem.isFloat || mem.rt !== 31)) {
          let slot = -1;
          let oldestOff = 0xFFFFFFFF;
          let oldestIdx = 0;
          for (let i = 0; i < MAX_PENDING; i++) {
            if (pending[i].active && pending[i].isFloat === mem.isFloat && pending[i].valReg === mem.rt) {
              slot = i;
              break;
            }
            if (!pending[i].active && slot < 0) slot = i;
            if (pending[i].active && pending[i].loadOff < oldestOff) {
              oldestOff = pending[i].loadOff;
              oldestIdx = i;
            }
          }
          if (slot < 0) slot = oldestIdx;
          pending[slot] = {
            active: true,
            isFloat: mem.isFloat,
            valReg: mem.rt,
            baseReg: mem.rn,
            width: mem.width,
            opKind: 0,
            clamped: false,
            disp: mem.disp,
            loadOff: off,
            arithOff: 0,
          };
        }
      } else {
        for (let i = 0; i < MAX_PENDING; i++) {
          const p = pending[i];
          if (!p.active || p.opKind === 0) continue;
          if (p.isFloat !== mem.isFloat) continue;
          if (p.baseReg !== mem.rn || p.disp !== mem.disp) continue;
          if (p.valReg !== mem.rt) continue;

          let clamped = p.clamped;
          if (!clamped) {
            for (let la = off + 4; la < limit && la <= off + 12; la += 4) {
              const lw = readU32LE(u8, la);
              if (isCallOrRet(lw) || isUncondBranch(lw)) break;
              if (isClampOrCond(lw)) {
                clamped = true;
                break;
              }
            }
          }

          summary.total++;
          if (p.opKind === 1) {
            if (clamped) summary.clampedSub++;
            else summary.unclampedSub++;
          } else {
            summary.addRmw++;
          }
          if (hits && hits.length < maxOut) {
            const flags = (clamped ? 1 : 0) | (p.isFloat ? 2 : 0);
            hits.push({
              loadOff: p.loadOff,
              storeOff: off,
              arithOff: p.arithOff,
              disp: p.disp,
              baseReg: p.baseReg,
              opKind: p.opKind,
              clamped,
              isFloat: p.isFloat,
              width: p.width,
              flags,
            });
          }
          p.active = false;
          break;
        }
      }
      continue;
    }

    const arith = decodeArithAddSub(w);
    if (arith) {
      if (!arith.isFloat && arith.rd < 31) {
        for (let i = 0; i < MAX_PENDING; i++) {
          if (pending[i].active && pending[i].baseReg === arith.rd) pending[i].active = false;
        }
      }
      for (let i = 0; i < MAX_PENDING; i++) {
        const p = pending[i];
        if (!p.active || p.isFloat !== arith.isFloat) continue;
        const matchRn = arith.rn === p.valReg;
        const matchRm = arith.hasRm && arith.rm === p.valReg;
        if ((arith.isSub && matchRn) || (!arith.isSub && (matchRn || matchRm))) {
          p.valReg = arith.rd;
          p.opKind = arith.isSub ? 1 : 2;
          p.arithOff = off;
        }
      }
      continue;
    }

    if (((w & 0x1FE00800) >>> 0) === 0x1A800000) {
      const crd = w & 31;
      const crn = (w >>> 5) & 31;
      const crm = (w >>> 16) & 31;
      if (crd < 31) {
        for (let i = 0; i < MAX_PENDING; i++) {
          if (pending[i].active && pending[i].baseReg === crd) pending[i].active = false;
        }
        for (let i = 0; i < MAX_PENDING; i++) {
          if (pending[i].active && !pending[i].isFloat &&
              (pending[i].valReg === crn || pending[i].valReg === crm)) {
            pending[i].valReg = crd;
            pending[i].clamped = true;
          }
        }
      }
      continue;
    }
    if (((w & 0xFF200C00) >>> 0) === 0x1E200C00 ||
        (((w & 0xFF20CC00) >>> 0) === 0x1E204800 && (((w >>> 12) & 0xF) >= 4 && ((w >>> 12) & 0xF) <= 7))) {
      const crd = w & 31;
      const crn = (w >>> 5) & 31;
      const crm = (w >>> 16) & 31;
      for (let i = 0; i < MAX_PENDING; i++) {
        if (pending[i].active && pending[i].isFloat &&
            (pending[i].valReg === crn || pending[i].valReg === crm)) {
          pending[i].valReg = crd;
          pending[i].clamped = true;
        }
      }
      continue;
    }

    const ru = decodeRegUsage(w);
    if (ru.gpWrite !== 0) {
      for (let i = 0; i < MAX_PENDING; i++) {
        if (pending[i].active && pending[i].baseReg < 31 &&
            ((ru.gpWrite >>> pending[i].baseReg) & 1) !== 0) {
          pending[i].active = false;
        }
      }
    }
  }

  return { hits: hits || [], summary };
}
