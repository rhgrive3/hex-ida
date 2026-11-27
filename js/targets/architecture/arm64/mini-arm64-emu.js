// JS-parity Bounded Concrete ARM64 Micro-Emulator (`MiniArm64Emu`, §19.3).
// Matches cpp/src/analysis/mini_arm64_emu.cpp flag/shift/SP semantics + WASM bridge & telemetry.
// INV-005: Lives under js/targets/architecture/arm64/, ZERO imports from js/targets/abi/.

import { getHexEngineExports } from '../../../core/hex-engine-wasm.js';
import { recordWasmCall, recordFallback } from '../../../core/wasm-telemetry.js';

export const HEX_EMU_PAGE_SIZE = 4096;
export const HEX_EMU_PAGE_MASK = 0xfffn;
export const HEX_EMU_MAX_STUB_LEN = 4096;
export const HEX_EMU_RET_SENTINEL = 0xdeadbeef00000000n;
// Matches C++ HEX_ARM64_EMU_STACK_TOP - 0x40 (0x00007FFF00010000 - 0x40 = 0x7FFF0000FFC0)
export const HEX_EMU_DEFAULT_SP = 0x7fff0000ffc0n;

export const HEX_EMU_PROT = Object.freeze({
  R: 1 << 0,
  W: 1 << 1,
  X: 1 << 2,
  BSS: 1 << 3,
});

export const HEX_EMU_STUB_KIND = Object.freeze({
  MEMCPY: 1,
  MEMSET: 2,
  MEMMOVE: 3,
  STRLEN: 4,
});

export const HEX_EMU_STOP_REASON = Object.freeze({
  RETURN_OK: 0,
  STEP_LIMIT: 1,
  PAGE_LIMIT: 2,
  EXT_CALL: 3,
  SYSCALL_SYS: 4,
  UNINIT_READ: 5,
  UNSUPPORTED_INSN: 6,
  CALL_DEPTH: 7,
});

export const HEX_EMU_SPAN_KIND = Object.freeze({
  EMU_STR: 4,
  EMU_TABLE: 5,
  EMU_RAW: 6,
});

export const HEX_EMU_PROFILES = Object.freeze({
  mobile: { maxSteps: 4096, maxCowPages: 64, maxCallDepth: 4 },
  desktop: { maxSteps: 32768, maxCowPages: 512, maxCallDepth: 4 },
});

const MASK64 = 0xffffffffffffffffn;
const MASK32 = 0xffffffffn;

function signExtend(val, bits) {
  const shift = 32 - bits;
  return (val << shift) >> shift;
}

/**
 * Exact C++ `shift_reg(v, shift_type, amount, is64)` parity:
 *   0=LSL, 1=LSR, 2=ASR, 3=ROR
 */
export function shiftRegArm64(val, shiftType, amount, is64) {
  const bits = is64 ? 64 : 32;
  const mask = is64 ? MASK64 : MASK32;
  const v = BigInt(val) & mask;
  const amt = Number(amount) & 0x3f;
  if (amt === 0) return v;
  if (amt >= bits) {
    if (shiftType === 2) {
      const signBit = is64 ? (1n << 63n) : (1n << 31n);
      return (v & signBit) !== 0n ? mask : 0n;
    }
    return 0n;
  }
  const bAmt = BigInt(amt);
  switch (shiftType) {
    case 0: // LSL
      return (v << bAmt) & mask;
    case 1: // LSR
      return v >> bAmt;
    case 2: { // ASR
      const signBit = is64 ? (1n << 63n) : (1n << 31n);
      if ((v & signBit) === 0n) return v >> bAmt;
      const fill = ((1n << bAmt) - 1n) << BigInt(bits - amt);
      return ((v >> bAmt) | fill) & mask;
    }
    case 3: // ROR
      return ((v >> bAmt) | (v << BigInt(bits - amt))) & mask;
    default:
      return v;
  }
}

/**
 * Exact C++ `compute_add_flags(a, b, res, is64)` parity (including signed overflow V).
 */
export function computeAddFlagsArm64(a, b, res, is64) {
  const mask = is64 ? MASK64 : MASK32;
  const signBit = is64 ? (1n << 63n) : (1n << 31n);
  const av = BigInt(a) & mask;
  const bv = BigInt(b) & mask;
  const rv = BigInt(res) & mask;
  return {
    N: (rv & signBit) !== 0n ? 1 : 0,
    Z: rv === 0n ? 1 : 0,
    C: rv < av ? 1 : 0,
    V: (((~(av ^ bv)) & (av ^ rv) & signBit) !== 0n) ? 1 : 0,
  };
}

/**
 * Exact C++ `compute_sub_flags(a, b, res, is64)` parity (including signed overflow V).
 */
export function computeSubFlagsArm64(a, b, res, is64) {
  const mask = is64 ? MASK64 : MASK32;
  const signBit = is64 ? (1n << 63n) : (1n << 31n);
  const av = BigInt(a) & mask;
  const bv = BigInt(b) & mask;
  const rv = BigInt(res) & mask;
  return {
    N: (rv & signBit) !== 0n ? 1 : 0,
    Z: rv === 0n ? 1 : 0,
    C: av >= bv ? 1 : 0, // ARM64: C=1 means NOT borrow
    V: (((av ^ bv) & (av ^ rv) & signBit) !== 0n) ? 1 : 0,
  };
}

function isPrintableAscii(byte) {
  return (byte >= 0x20 && byte <= 0x7e) || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function evalCond(cond, flags) {
  const { N, Z, C, V } = flags;
  switch (cond & 0xf) {
    case 0x0: return Z === 1;
    case 0x1: return Z === 0;
    case 0x2: return C === 1;
    case 0x3: return C === 0;
    case 0x4: return N === 1;
    case 0x5: return N === 0;
    case 0x6: return V === 1;
    case 0x7: return V === 0;
    case 0x8: return C === 1 && Z === 0;
    case 0x9: return C === 0 || Z === 1;
    case 0xa: return N === V;
    case 0xb: return N !== V;
    case 0xc: return Z === 0 && N === V;
    case 0xd: return Z === 1 || N !== V;
    case 0xe: return true;
    case 0xf: return true;
    default: return false;
  }
}

export class MiniArm64Emu {
  constructor(segs = [], stubs = [], cfg = {}) {
    this.segs = segs.map((s) => ({
      va: BigInt(s.va),
      size: s.size ?? (s.bytes ? s.bytes.length : 0),
      bytes: s.bytes ? (s.bytes instanceof Uint8Array ? s.bytes : new Uint8Array(s.bytes)) : null,
      prot: s.prot ?? (HEX_EMU_PROT.R | HEX_EMU_PROT.X),
    }));
    this.stubsByVa = new Map();
    for (const st of stubs) {
      this.stubsByVa.set(BigInt(st.va), st.stubKind ?? st.stub_kind ?? 0);
    }

    const profile = cfg.profile === 'desktop' ? HEX_EMU_PROFILES.desktop : HEX_EMU_PROFILES.mobile;
    this.cfg = {
      entryVa: BigInt(cfg.entryVa ?? cfg.entry_va ?? 0n),
      maxSteps: cfg.maxSteps ?? cfg.max_steps ?? profile.maxSteps,
      maxCowPages: cfg.maxCowPages ?? cfg.max_cow_pages ?? profile.maxCowPages,
      maxCallDepth: cfg.maxCallDepth ?? cfg.max_call_depth ?? profile.maxCallDepth,
      flags: cfg.flags ?? 0,
      arg0Val: BigInt(cfg.arg0Val ?? cfg.arg0_val ?? 0n) & MASK64,
      initialRegs: cfg.initialRegs || null,
    };

    this.gpr = new BigUint64Array(32);
    this.gprInitMask = 0;
    this.vec = Array.from({ length: 32 }, () => new Uint8Array(16));
    this.vecInitMask = 0;
    this.flags = { N: 0, Z: 0, C: 0, V: 0 };
    this.pc = this.cfg.entryVa;
    this.callDepth = 0;
    this.stepsUsed = 0;
    this.stopReason = HEX_EMU_STOP_REASON.RETURN_OK;
    this.cowPages = new Map();

    // Initialize SP (x31 = 0x7fff0000ffc0n, matching C++ mini_arm64_emu.cpp) and LR (x30)
    this.gpr[31] = HEX_EMU_DEFAULT_SP;
    this.gprInitMask = (this.gprInitMask | (1 << 31)) >>> 0;
    this.gpr[30] = HEX_EMU_RET_SENTINEL;
    this.gprInitMask = (this.gprInitMask | (1 << 30)) >>> 0;

    if (this.cfg.flags & 0x04) {
      this.setGpr(0, this.cfg.arg0Val);
    }
    if (this.cfg.initialRegs) {
      for (const [k, v] of Object.entries(this.cfg.initialRegs)) {
        const idx = Number(k);
        if (Number.isInteger(idx) && idx >= 0 && idx <= 31) {
          this.setGpr(idx, BigInt(v) & MASK64);
        }
      }
    }
  }

  _isGprInit(r, isSp = false) {
    if (r === 31 && !isSp) return true;
    return Boolean((this.gprInitMask >>> r) & 1);
  }

  getGpr(r, isSp = false) {
    if (r === 31 && !isSp) return 0n;
    if (!this._isGprInit(r, isSp)) {
      this.stopReason = HEX_EMU_STOP_REASON.UNINIT_READ;
      return null;
    }
    return this.gpr[r];
  }

  setGpr(r, val, isSp = false) {
    if (r === 31 && !isSp) return;
    this.gpr[r] = BigInt(val) & MASK64;
    this.gprInitMask = (this.gprInitMask | (1 << r)) >>> 0;
  }

  getVec(r) {
    if (!((this.vecInitMask >>> r) & 1)) {
      this.stopReason = HEX_EMU_STOP_REASON.UNINIT_READ;
      return null;
    }
    return this.vec[r];
  }

  setVec(r, bytes16) {
    this.vec[r].set(bytes16.subarray(0, 16));
    this.vecInitMask = (this.vecInitMask | (1 << r)) >>> 0;
  }

  _findSeg(va) {
    for (const seg of this.segs) {
      if (va >= seg.va && va < seg.va + BigInt(seg.size)) return seg;
    }
    return null;
  }

  _isExecVa(va) {
    const seg = this._findSeg(va);
    return Boolean(seg && (seg.prot & HEX_EMU_PROT.X));
  }

  _getOrAllocCowPage(pageBase, copyFromSeg = true) {
    let page = this.cowPages.get(pageBase);
    if (page) return page;
    if (this.cowPages.size >= this.cfg.maxCowPages) {
      this.stopReason = HEX_EMU_STOP_REASON.PAGE_LIMIT;
      return null;
    }
    const data = new Uint8Array(HEX_EMU_PAGE_SIZE);
    const initBitmap = new Uint8Array(HEX_EMU_PAGE_SIZE >> 3);
    const dirtyBitmap = new Uint8Array(HEX_EMU_PAGE_SIZE >> 3);

    if (copyFromSeg) {
      for (const seg of this.segs) {
        const segStart = seg.va;
        const segEnd = seg.va + BigInt(seg.size);
        const pageEnd = pageBase + BigInt(HEX_EMU_PAGE_SIZE);
        const ovStart = segStart > pageBase ? segStart : pageBase;
        const ovEnd = segEnd < pageEnd ? segEnd : pageEnd;
        if (ovStart < ovEnd) {
          const pOff = Number(ovStart - pageBase);
          const sOff = Number(ovStart - segStart);
          const len = Number(ovEnd - ovStart);
          if (seg.bytes) {
            data.set(seg.bytes.subarray(sOff, sOff + len), pOff);
            for (let i = 0; i < len; i++) {
              const b = pOff + i;
              initBitmap[b >> 3] |= 1 << (b & 7);
            }
          } else if (seg.prot & HEX_EMU_PROT.BSS) {
            for (let i = 0; i < len; i++) {
              const b = pOff + i;
              initBitmap[b >> 3] |= 1 << (b & 7);
            }
          }
        }
      }
    }

    page = { data, initBitmap, dirtyBitmap, writerInsnOff: 0 };
    this.cowPages.set(pageBase, page);
    return page;
  }

  readByte(va) {
    const pageBase = va & ~HEX_EMU_PAGE_MASK;
    const off = Number(va & HEX_EMU_PAGE_MASK);
    const cow = this.cowPages.get(pageBase);
    if (cow) {
      if (!(cow.initBitmap[off >> 3] & (1 << (off & 7)))) {
        this.stopReason = HEX_EMU_STOP_REASON.UNINIT_READ;
        return null;
      }
      return cow.data[off];
    }
    const seg = this._findSeg(va);
    if (!seg) {
      this.stopReason = HEX_EMU_STOP_REASON.UNINIT_READ;
      return null;
    }
    if (seg.bytes) return seg.bytes[Number(va - seg.va)];
    if (seg.prot & HEX_EMU_PROT.BSS) return 0;
    this.stopReason = HEX_EMU_STOP_REASON.UNINIT_READ;
    return null;
  }

  writeByte(va, byteVal, writerInsnOff = 0) {
    const pageBase = va & ~HEX_EMU_PAGE_MASK;
    const off = Number(va & HEX_EMU_PAGE_MASK);
    const cow = this._getOrAllocCowPage(pageBase, true);
    if (!cow) return false;
    cow.data[off] = byteVal & 0xff;
    cow.initBitmap[off >> 3] |= 1 << (off & 7);
    cow.dirtyBitmap[off >> 3] |= 1 << (off & 7);
    cow.writerInsnOff = writerInsnOff >>> 0;
    return true;
  }

  readInt(va, widthBytes) {
    let acc = 0n;
    for (let i = 0; i < widthBytes; i++) {
      const b = this.readByte(va + BigInt(i));
      if (b === null) return null;
      acc |= BigInt(b) << BigInt(i * 8);
    }
    return acc;
  }

  writeInt(va, val, widthBytes, writerInsnOff = 0) {
    const v = BigInt(val) & MASK64;
    for (let i = 0; i < widthBytes; i++) {
      if (!this.writeByte(va + BigInt(i), Number((v >> BigInt(i * 8)) & 0xffn), writerInsnOff)) {
        return false;
      }
    }
    return true;
  }

  _fetchWord(va) {
    if (!this._isExecVa(va)) return null;
    const b0 = this.readByte(va);
    const b1 = this.readByte(va + 1n);
    const b2 = this.readByte(va + 2n);
    const b3 = this.readByte(va + 3n);
    if (b0 === null || b1 === null || b2 === null || b3 === null) return null;
    return ((b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0);
  }

  _execPureStub(kind, writerInsnOff) {
    const x0 = this.getGpr(0);
    if (x0 === null) return false;

    if (kind === HEX_EMU_STUB_KIND.STRLEN) {
      let len = 0;
      while (len < HEX_EMU_MAX_STUB_LEN) {
        const b = this.readByte(x0 + BigInt(len));
        if (b === null) return false;
        if (b === 0) break;
        len++;
      }
      this.setGpr(0, BigInt(len));
      return true;
    }

    const x1 = this.getGpr(1);
    const x2 = this.getGpr(2);
    if (x1 === null || x2 === null) return false;
    const n = Number(x2);
    if (!Number.isSafeInteger(n) || n < 0 || n > HEX_EMU_MAX_STUB_LEN) {
      this.stopReason = HEX_EMU_STOP_REASON.EXT_CALL;
      return false;
    }

    if (kind === HEX_EMU_STUB_KIND.MEMSET) {
      const fill = Number(x1 & 0xffn);
      for (let i = 0; i < n; i++) {
        if (!this.writeByte(x0 + BigInt(i), fill, writerInsnOff)) return false;
      }
      this.setGpr(0, x0);
      return true;
    }

    if (kind === HEX_EMU_STUB_KIND.MEMCPY || kind === HEX_EMU_STUB_KIND.MEMMOVE) {
      const tmp = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const b = this.readByte(x1 + BigInt(i));
        if (b === null) return false;
        tmp[i] = b;
      }
      for (let i = 0; i < n; i++) {
        if (!this.writeByte(x0 + BigInt(i), tmp[i], writerInsnOff)) return false;
      }
      this.setGpr(0, x0);
      return true;
    }

    this.stopReason = HEX_EMU_STOP_REASON.EXT_CALL;
    return false;
  }

  run() {
    while (true) {
      if (this.pc === HEX_EMU_RET_SENTINEL) {
        this.stopReason = HEX_EMU_STOP_REASON.RETURN_OK;
        break;
      }
      if (this.stepsUsed >= this.cfg.maxSteps) {
        this.stopReason = HEX_EMU_STOP_REASON.STEP_LIMIT;
        break;
      }

      const w = this._fetchWord(this.pc);
      if (w === null) {
        if (this.stopReason === HEX_EMU_STOP_REASON.RETURN_OK) {
          this.stopReason = HEX_EMU_STOP_REASON.UNSUPPORTED_INSN;
        }
        break;
      }

      const insnOff = Number((this.pc - this.cfg.entryVa) & 0xffffffffn) >>> 0;
      this.stepsUsed++;
      const nextPc = (this.pc + 4n) & MASK64;

      // NOP / PAC / BTI hints
      if (((w & 0xfffff01f) >>> 0) === 0xd503201f) {
        this.pc = nextPc;
        continue;
      }

      // SVC / HVC / SMC / BRK / MRS / MSR -> HEX_EMU_STOP_SYSCALL_SYS
      if (
        ((w & 0xff000000) >>> 0) === 0xd4000000
        || ((w & 0xffd00000) >>> 0) === 0xd5100000
        || ((w & 0xffd00000) >>> 0) === 0xd5300000
      ) {
        this.stopReason = HEX_EMU_STOP_REASON.SYSCALL_SYS;
        break;
      }

      // RET
      if (((w & 0xfffffc1f) >>> 0) === 0xd65f0000) {
        const rn = (w >>> 5) & 0x1f;
        const target = this.getGpr(rn);
        if (target === null) break;
        if (this.callDepth > 0) this.callDepth--;
        this.pc = target;
        continue;
      }

      // BL #imm26
      if (((w & 0xfc000000) >>> 0) === 0x94000000) {
        const imm26 = signExtend(w & 0x03ffffff, 26);
        const target = (this.pc + BigInt(imm26 * 4)) & MASK64;
        const stubKind = (this.cfg.flags & 0x01) ? this.stubsByVa.get(target) : undefined;
        if (stubKind) {
          if (!this._execPureStub(stubKind, insnOff)) break;
          this.pc = nextPc;
          continue;
        }
        if (!this._isExecVa(target)) {
          this.stopReason = HEX_EMU_STOP_REASON.EXT_CALL;
          break;
        }
        if (this.callDepth >= this.cfg.maxCallDepth) {
          this.stopReason = HEX_EMU_STOP_REASON.CALL_DEPTH;
          break;
        }
        this.callDepth++;
        this.setGpr(30, nextPc);
        this.pc = target;
        continue;
      }

      // B #imm26
      if (((w & 0xfc000000) >>> 0) === 0x14000000) {
        const imm26 = signExtend(w & 0x03ffffff, 26);
        this.pc = (this.pc + BigInt(imm26 * 4)) & MASK64;
        continue;
      }

      // B.cond #imm19
      if (((w & 0xff000010) >>> 0) === 0x54000000) {
        const cond = w & 0xf;
        const imm19 = signExtend((w >>> 5) & 0x7ffff, 19);
        this.pc = evalCond(cond, this.flags) ? ((this.pc + BigInt(imm19 * 4)) & MASK64) : nextPc;
        continue;
      }

      // CBZ / CBNZ
      if ((w & 0x7e000000) === 0x34000000) {
        const sf = (w >>> 31) & 1;
        const isNz = Boolean((w >>> 24) & 1);
        const rt = w & 0x1f;
        const imm19 = signExtend((w >>> 5) & 0x7ffff, 19);
        const v = this.getGpr(rt);
        if (v === null) break;
        const masked = sf ? v : (v & MASK32);
        const taken = isNz ? (masked !== 0n) : (masked === 0n);
        this.pc = taken ? ((this.pc + BigInt(imm19 * 4)) & MASK64) : nextPc;
        continue;
      }

      // MOVZ / MOVN / MOVK
      if ((w & 0x1f800000) === 0x12800000) {
        const sf = (w >>> 31) & 1;
        const opc = (w >>> 29) & 3;
        const hw = (w >>> 21) & 3;
        const imm16 = BigInt((w >>> 5) & 0xffff);
        const rd = w & 0x1f;
        const shift = BigInt(hw * 16);
        const wMask = sf ? MASK64 : MASK32;
        if (opc === 2) {
          this.setGpr(rd, (imm16 << shift) & wMask);
        } else if (opc === 0) {
          this.setGpr(rd, (~(imm16 << shift)) & wMask);
        } else if (opc === 3) {
          const cur = this.getGpr(rd);
          if (cur === null) break;
          this.setGpr(rd, ((cur & ~(0xffffn << shift)) | (imm16 << shift)) & wMask);
        }
        this.pc = nextPc;
        continue;
      }

      // ADR / ADRP
      if ((w & 0x1f000000) === 0x10000000) {
        const isAdrp = Boolean((w >>> 31) & 1);
        const immlo = (w >>> 29) & 3;
        const immhi = (w >>> 5) & 0x7ffff;
        const imm21 = signExtend((immhi << 2) | immlo, 21);
        const rd = w & 0x1f;
        const target = isAdrp
          ? ((this.pc & ~0xfffn) + BigInt(imm21) * 4096n) & MASK64
          : (this.pc + BigInt(imm21)) & MASK64;
        this.setGpr(rd, target);
        this.pc = nextPc;
        continue;
      }

      // ADD / ADDS / SUB / SUBS immediate (with exact C++ V overflow flag!)
      if ((w & 0x1f800000) === 0x11000000) {
        const is64 = Boolean((w >>> 31) & 1);
        const isSub = Boolean((w >>> 30) & 1);
        const setFlags = Boolean((w >>> 29) & 1);
        const sh = (w >>> 22) & 1;
        const imm12 = BigInt(((w >>> 10) & 0xfff) << (sh ? 12 : 0));
        const rn = (w >>> 5) & 0x1f;
        const rd = w & 0x1f;
        const wMask = is64 ? MASK64 : MASK32;
        const lhs = this.getGpr(rn, true);
        if (lhs === null) break;
        const a = lhs & wMask;
        const res = (isSub ? (a - imm12) : (a + imm12)) & wMask;
        this.setGpr(rd, res, !setFlags);
        if (setFlags) {
          this.flags = isSub
            ? computeSubFlagsArm64(a, imm12, res, is64)
            : computeAddFlagsArm64(a, imm12, res, is64);
        }
        this.pc = nextPc;
        continue;
      }

      // ADD / ADDS / SUB / SUBS shifted register (LSL, LSR, ASR + exact C++ V overflow flag!)
      if ((w & 0x1f200000) === 0x0b000000) {
        const is64 = Boolean((w >>> 31) & 1);
        const isSub = Boolean((w >>> 30) & 1);
        const setFlags = Boolean((w >>> 29) & 1);
        const shiftType = (w >>> 22) & 3;
        const shiftAmt = (w >>> 10) & 0x3f;
        const rm = (w >>> 16) & 0x1f;
        const rn = (w >>> 5) & 0x1f;
        const rd = w & 0x1f;
        const wMask = is64 ? MASK64 : MASK32;
        const a = this.getGpr(rn);
        const b = this.getGpr(rm);
        if (a === null || b === null) break;
        const av = a & wMask;
        const bv = shiftRegArm64(b, shiftType, shiftAmt, is64);
        const res = (isSub ? (av - bv) : (av + bv)) & wMask;
        this.setGpr(rd, res);
        if (setFlags) {
          this.flags = isSub
            ? computeSubFlagsArm64(av, bv, res, is64)
            : computeAddFlagsArm64(av, bv, res, is64);
        }
        this.pc = nextPc;
        continue;
      }

      // Logical shifted register (AND/ORR/EOR/ANDS/BIC/ORN/EON/BICS with LSL/LSR/ASR/ROR!)
      if ((w & 0x1f000000) === 0x0a000000) {
        const is64 = Boolean((w >>> 31) & 1);
        const opc = (w >>> 29) & 3;
        const shiftType = (w >>> 22) & 3;
        const invert = Boolean((w >>> 21) & 1);
        const shiftAmt = (w >>> 10) & 0x3f;
        const rm = (w >>> 16) & 0x1f;
        const rn = (w >>> 5) & 0x1f;
        const rd = w & 0x1f;
        const wMask = is64 ? MASK64 : MASK32;
        const a = this.getGpr(rn);
        const b = this.getGpr(rm);
        if (a === null || b === null) break;
        const av = a & wMask;
        const shifted = shiftRegArm64(b, shiftType, shiftAmt, is64);
        const bv = invert ? ((~shifted) & wMask) : shifted;
        let res = 0n;
        if (opc === 0 || opc === 3) res = av & bv;
        else if (opc === 1) res = av | bv;
        else if (opc === 2) res = av ^ bv;
        this.setGpr(rd, res & wMask);
        if (opc === 3) {
          const signBit = is64 ? (1n << 63n) : (1n << 31n);
          this.flags = { N: (res & signBit) !== 0n ? 1 : 0, Z: res === 0n ? 1 : 0, C: 0, V: 0 };
        }
        this.pc = nextPc;
        continue;
      }

      // Integer LDR / STR unsigned offset (bit 26 V=0)
      if ((w & 0x3f000000) === 0x39000000) {
        const size = (w >>> 30) & 3;
        const width = 1 << size;
        const isLoad = Boolean((w >>> 22) & 1);
        const imm = BigInt(((w >>> 10) & 0xfff) * width);
        const rn = (w >>> 5) & 0x1f;
        const rt = w & 0x1f;
        const base = this.getGpr(rn, true);
        if (base === null) break;
        const addr = (base + imm) & MASK64;
        if (isLoad) {
          const v = this.readInt(addr, width);
          if (v === null) break;
          this.setGpr(rt, v);
        } else {
          const v = this.getGpr(rt);
          if (v === null) break;
          if (!this.writeInt(addr, v, width, insnOff)) break;
        }
        this.pc = nextPc;
        continue;
      }

      // Integer LDR / STR post-index & pre-index (bit 26 V=0)
      if ((w & 0x3f200400) === 0x38000400) {
        const size = (w >>> 30) & 3;
        const width = 1 << size;
        const isLoad = Boolean((w >>> 22) & 1);
        const isPre = Boolean((w >>> 11) & 1);
        const simm9 = BigInt(signExtend((w >>> 12) & 0x1ff, 9));
        const rn = (w >>> 5) & 0x1f;
        const rt = w & 0x1f;
        const base = this.getGpr(rn, true);
        if (base === null) break;
        const addr = isPre ? ((base + simm9) & MASK64) : base;
        if (isLoad) {
          const v = this.readInt(addr, width);
          if (v === null) break;
          this.setGpr(rt, v);
        } else {
          const v = this.getGpr(rt);
          if (v === null) break;
          if (!this.writeInt(addr, v, width, insnOff)) break;
        }
        this.setGpr(rn, (base + simm9) & MASK64, true);
        this.pc = nextPc;
        continue;
      }

      // Minimal NEON: LDR Qt / STR Qt
      if (((w & 0xffc00000) >>> 0) === 0x3dc00000 || ((w & 0xffc00000) >>> 0) === 0x3d800000) {
        const isLoad = ((w & 0xffc00000) >>> 0) === 0x3dc00000;
        const imm = BigInt(((w >>> 10) & 0xfff) * 16);
        const rn = (w >>> 5) & 0x1f;
        const rt = w & 0x1f;
        const base = this.getGpr(rn, true);
        if (base === null) break;
        const addr = (base + imm) & MASK64;
        if (isLoad) {
          const buf = new Uint8Array(16);
          let ok = true;
          for (let i = 0; i < 16; i++) {
            const b = this.readByte(addr + BigInt(i));
            if (b === null) { ok = false; break; }
            buf[i] = b;
          }
          if (!ok) break;
          this.setVec(rt, buf);
        } else {
          const vec = this.getVec(rt);
          if (vec === null) break;
          let ok = true;
          for (let i = 0; i < 16; i++) {
            if (!this.writeByte(addr + BigInt(i), vec[i], insnOff)) { ok = false; break; }
          }
          if (!ok) break;
        }
        this.pc = nextPc;
        continue;
      }

      // Minimal NEON: EOR Vd.16B, Vn.16B, Vm.16B
      if (((w & 0xffe0fc00) >>> 0) === 0x6e201c00) {
        const rd = w & 0x1f;
        const rn = (w >>> 5) & 0x1f;
        const rm = (w >>> 16) & 0x1f;
        const va = this.getVec(rn);
        const vb = this.getVec(rm);
        if (!va || !vb) break;
        const out = new Uint8Array(16);
        for (let i = 0; i < 16; i++) out[i] = va[i] ^ vb[i];
        this.setVec(rd, out);
        this.pc = nextPc;
        continue;
      }

      // Minimal NEON: ADD Vd.16B, Vn.16B, Vm.16B
      if (((w & 0xffe0fc00) >>> 0) === 0x4e208400) {
        const rd = w & 0x1f;
        const rn = (w >>> 5) & 0x1f;
        const rm = (w >>> 16) & 0x1f;
        const va = this.getVec(rn);
        const vb = this.getVec(rm);
        if (!va || !vb) break;
        const out = new Uint8Array(16);
        for (let i = 0; i < 16; i++) out[i] = (va[i] + vb[i]) & 0xff;
        this.setVec(rd, out);
        this.pc = nextPc;
        continue;
      }

      // Minimal NEON: DUP Vd.16B, Wn
      if (((w & 0xfffffc00) >>> 0) === 0x4e010c00) {
        const rd = w & 0x1f;
        const rn = (w >>> 5) & 0x1f;
        const v = this.getGpr(rn);
        if (v === null) break;
        const out = new Uint8Array(16);
        out.fill(Number(v & 0xffn));
        this.setVec(rd, out);
        this.pc = nextPc;
        continue;
      }

      this.stopReason = HEX_EMU_STOP_REASON.UNSUPPORTED_INSN;
      break;
    }

    const dirtySpans = this.extractDirtySpans();
    return {
      engine: 'js',
      stopReason: this.stopReason,
      stepsUsed: this.stepsUsed,
      cowPagesUsed: this.cowPages.size,
      partialRun: this.stopReason !== HEX_EMU_STOP_REASON.RETURN_OK,
      dirtySpans,
      x0: this._isGprInit(0) ? this.gpr[0] : null,
      sp: this.gpr[31],
      flags: { ...this.flags },
    };
  }

  extractDirtySpans() {
    const spans = [];
    const partialFlag = this.stopReason !== HEX_EMU_STOP_REASON.RETURN_OK ? 0x01 : 0x00;

    for (const [pageBase, page] of this.cowPages.entries()) {
      let off = 0;
      while (off < HEX_EMU_PAGE_SIZE) {
        const isDirty = Boolean(page.dirtyBitmap[off >> 3] & (1 << (off & 7)));
        if (!isDirty) {
          off++;
          continue;
        }
        const start = off;
        while (off < HEX_EMU_PAGE_SIZE && (page.dirtyBitmap[off >> 3] & (1 << (off & 7)))) {
          off++;
        }
        const raw = page.data.slice(start, off);
        let strLen = raw.length;
        let nulTerm = false;
        if (strLen > 0 && raw[strLen - 1] === 0) {
          nulTerm = true;
          strLen--;
        }
        let printableCount = 0;
        for (let i = 0; i < strLen; i++) {
          if (isPrintableAscii(raw[i])) printableCount++;
        }
        const isStr = strLen >= 3 && printableCount === strLen;
        const kind = isStr ? HEX_EMU_SPAN_KIND.EMU_STR
          : (raw.length >= 16 && (raw.length % 4 === 0)) ? HEX_EMU_SPAN_KIND.EMU_TABLE
            : HEX_EMU_SPAN_KIND.EMU_RAW;

        spans.push({
          va: pageBase + BigInt(start),
          payloadLen: raw.length,
          payload: raw,
          text: isStr ? new TextDecoder().decode(raw.subarray(0, strLen)) : null,
          kind,
          flags: partialFlag | (nulTerm ? 0x02 : 0x00),
          writerInsnOff: page.writerInsnOff,
        });
      }
    }
    return spans;
  }
}

/**
 * Optional WASM fast-path runner (`hex_arm64_emu_init` + `hex_arm64_emu_run`) for single code-segment runs.
 */
export function runMiniArm64EmuWasm(codeBytes, cfg = {}) {
  const ex = cfg.wasmExports ?? getHexEngineExports(cfg);
  if (
    !ex
    || typeof ex.hex_arm64_emu_init !== 'function'
    || typeof ex.hex_arm64_emu_run !== 'function'
    || typeof ex.hex_deobf_scratch_ptr !== 'function'
  ) {
    recordFallback('EMU_JS_FALLBACK');
    return null;
  }
  try {
    const base = ex.hex_deobf_scratch_ptr();
    const scratchSize = ex.hex_deobf_scratch_size();
    const stateSize = 0x1138;
    const codeAligned = (codeBytes.length + 7) & ~7;
    if (scratchSize < stateSize + codeAligned + 16) {
      recordFallback('EMU_SCRATCH_OOM');
      return null;
    }
    const statePtr = base;
    const codePtr = (base + stateSize + 7) & ~7;
    const mem = new Uint8Array(ex.memory.buffer);
    mem.set(codeBytes, codePtr);

    const entryVa = BigInt(cfg.entryVa ?? cfg.entry_va ?? 0x10000n);
    const codeVa = BigInt(cfg.codeVa ?? entryVa);
    const stepLimit = cfg.maxSteps ?? cfg.max_steps ?? HEX_EMU_PROFILES.mobile.maxSteps;

    const initStatus = ex.hex_arm64_emu_init(statePtr, entryVa, codeVa, codeBytes.length >>> 0, stepLimit >>> 0);
    if (initStatus !== 0) {
      recordFallback('EMU_WASM_INIT_ERR');
      return null;
    }

    const dv = new DataView(ex.memory.buffer);
    if (cfg.initialRegs) {
      for (const [k, v] of Object.entries(cfg.initialRegs)) {
        const idx = Number(k);
        if (Number.isInteger(idx) && idx >= 0 && idx < 31) {
          dv.setBigUint64(statePtr + idx * 8, BigInt(v) & MASK64, true);
        } else if (idx === 31) {
          dv.setBigUint64(statePtr + 0xf8, BigInt(v) & MASK64, true);
        }
      }
    }

    ex.hex_arm64_emu_run(statePtr, codePtr, codeBytes.length >>> 0);
    recordWasmCall('mini_arm64_emu');

    const x0 = dv.getBigUint64(statePtr + 0, true);
    const sp = dv.getBigUint64(statePtr + 0xf8, true);
    const nzcv = dv.getUint32(statePtr + 0x108, true);
    const stepCount = dv.getUint32(statePtr + 0x10c, true);
    const faultCode = dv.getUint32(statePtr + 0x114, true);

    return {
      engine: 'wasm',
      stopReason: faultCode === 1 ? HEX_EMU_STOP_REASON.RETURN_OK : faultCode === 2 ? HEX_EMU_STOP_REASON.STEP_LIMIT : HEX_EMU_STOP_REASON.UNSUPPORTED_INSN,
      faultCode,
      stepsUsed: stepCount,
      x0,
      sp,
      flags: {
        N: (nzcv >>> 31) & 1,
        Z: (nzcv >>> 30) & 1,
        C: (nzcv >>> 29) & 1,
        V: (nzcv >>> 28) & 1,
      },
    };
  } catch {
    recordFallback('EMU_WASM_EXCEPTION');
    return null;
  }
}

export function runMiniArm64Emu(segs, stubs, cfg = {}) {
  if (cfg.preferWasm && segs.length === 1 && (!stubs || stubs.length === 0) && segs[0].bytes) {
    const wasmRes = runMiniArm64EmuWasm(segs[0].bytes, { ...cfg, codeVa: segs[0].va });
    if (wasmRes !== null) return wasmRes;
  }
  const emu = new MiniArm64Emu(segs, stubs, cfg);
  return emu.run();
}
