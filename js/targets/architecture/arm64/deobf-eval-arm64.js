// ARM64 BoundedAbstractVM & Opaque-Predicate Evaluator DI Adapter (§13.2).
// Matches C++ flag/overflow (V) & shift (LSL/LSR/ASR/ROR) semantics.
// INV-005: Lives under js/targets/architecture/arm64/, ZERO imports from js/targets/abi/.

import {
  shiftRegArm64,
  computeAddFlagsArm64,
  computeSubFlagsArm64,
} from './mini-arm64-emu.js';

export const ABSTRACT_VM_MAX_STEPS = 1024;
export const ABSTRACT_VM_VSTACK_SIZE = 4096;
export const ABSTRACT_VM_SP_INIT = 0x10000000n + 3072n;

export const DEOBF_EVAL_KIND = Object.freeze({
  STACK_STR: 1,
  LOOP_DEOBF: 2,
  CONST_ADDR: 3,
});

export const OPAQUE_PREDICATE_RESULT = Object.freeze({
  UNKNOWN: 'unknown',
  ALWAYS_TRUE: 'always_true',
  ALWAYS_FALSE: 'always_false',
});

const MASK64 = 0xffffffffffffffffn;
const MASK32 = 0xffffffffn;

function readU32(bytes, off) {
  return (
    (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0
  );
}

function signExtend(val, bits) {
  const shift = 32 - bits;
  return (val << shift) >> shift;
}

function evalCond(cond, flags) {
  if (!flags.known) return null;
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
    default: return null;
  }
}

function isPrintableAscii(byte) {
  return (byte >= 0x20 && byte <= 0x7e) || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

export function evalArm64Deobf(codeBytes, opts = {}) {
  const bytes = codeBytes instanceof Uint8Array ? codeBytes : new Uint8Array(codeBytes || 0);
  const funcVa = BigInt(opts.funcVa ?? 0x100000n);
  const maxSteps = Math.max(1, Math.min(ABSTRACT_VM_MAX_STEPS, opts.maxSteps ?? ABSTRACT_VM_MAX_STEPS));
  const roSegments = Array.isArray(opts.roSegments) ? opts.roSegments : [];

  const regs = new Array(32).fill(null);
  regs[31] = ABSTRACT_VM_SP_INIT;
  const flags = { known: false, N: 0, Z: 0, C: 0, V: 0 };

  const vstackBase = 0x10000000n;
  const vstack = new Uint8Array(ABSTRACT_VM_VSTACK_SIZE);
  const definedMask = new Uint8Array(ABSTRACT_VM_VSTACK_SIZE >> 3);

  function setStackByte(off, val) {
    if (off < 0 || off >= ABSTRACT_VM_VSTACK_SIZE) return;
    vstack[off] = val & 0xff;
    definedMask[off >> 3] |= 1 << (off & 7);
  }

  function isStackByteDefined(off) {
    if (off < 0 || off >= ABSTRACT_VM_VSTACK_SIZE) return false;
    return Boolean(definedMask[off >> 3] & (1 << (off & 7)));
  }

  function readRoByte(va) {
    for (const seg of roSegments) {
      const start = BigInt(seg.va);
      const data = seg.bytes;
      if (va >= start && va < start + BigInt(data.length)) {
        return data[Number(va - start)];
      }
    }
    return null;
  }

  function readMem(addr, widthBytes) {
    if (addr === null) return null;
    if (addr >= vstackBase && addr + BigInt(widthBytes) <= vstackBase + BigInt(ABSTRACT_VM_VSTACK_SIZE)) {
      const baseOff = Number(addr - vstackBase);
      let val = 0n;
      for (let i = 0; i < widthBytes; i++) {
        if (!isStackByteDefined(baseOff + i)) return null;
        val |= BigInt(vstack[baseOff + i]) << BigInt(i * 8);
      }
      return val;
    }
    let val = 0n;
    for (let i = 0; i < widthBytes; i++) {
      const b = readRoByte(addr + BigInt(i));
      if (b === null) return null;
      val |= BigInt(b) << BigInt(i * 8);
    }
    return val;
  }

  function writeStack(addr, val, widthBytes) {
    if (addr === null || val === null) return;
    if (addr < vstackBase || addr + BigInt(widthBytes) > vstackBase + BigInt(ABSTRACT_VM_VSTACK_SIZE)) {
      return;
    }
    const baseOff = Number(addr - vstackBase);
    for (let i = 0; i < widthBytes; i++) {
      setStackByte(baseOff + i, Number((val >> BigInt(i * 8)) & 0xffn));
    }
  }

  function getReg(r, isSp = false) {
    if (r === 31) return isSp ? regs[31] : 0n;
    return regs[r];
  }

  function setReg(r, val, isSp = false) {
    if (r === 31 && !isSp) return;
    regs[r] = val === null ? null : (val & MASK64);
  }

  const records = [];
  const opaquePredicates = [];
  let pcOff = 0;
  let steps = 0;

  while (steps < maxSteps && pcOff >= 0 && pcOff + 4 <= bytes.length) {
    const w = readU32(bytes, pcOff);
    const insnVa = funcVa + BigInt(pcOff);
    steps++;
    let nextOff = pcOff + 4;

    if (w === 0xd65f03c0) break;

    if (((w & 0xfffff01f) >>> 0) === 0xd503201f) {
      pcOff = nextOff;
      continue;
    }

    if (((w & 0xffe0001f) >>> 0) === 0xd4000001 || ((w & 0xfc000000) >>> 0) === 0x94000000 || ((w & 0xfffffc1f) >>> 0) === 0xd63f0000) {
      for (let r = 0; r <= 18; r++) regs[r] = null;
      flags.known = false;
      pcOff = nextOff;
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
      if (opc === 2) setReg(rd, (imm16 << shift) & wMask);
      else if (opc === 0) setReg(rd, (~(imm16 << shift)) & wMask);
      else if (opc === 3) {
        const cur = getReg(rd);
        setReg(rd, cur === null ? null : (((cur & ~(0xffffn << shift)) | (imm16 << shift)) & wMask));
      }
      pcOff = nextOff;
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
        ? ((insnVa & ~0xfffn) + BigInt(imm21) * 4096n) & MASK64
        : (insnVa + BigInt(imm21)) & MASK64;
      setReg(rd, target);
      if (!isAdrp) {
        records.push({ insnVa, resolvedVa: target, kind: DEOBF_EVAL_KIND.CONST_ADDR, stepsUsed: steps });
      }
      pcOff = nextOff;
      continue;
    }

    // ADD / ADDS / SUB / SUBS immediate (exact C++ V flag!)
    if ((w & 0x1f800000) === 0x11000000) {
      const is64 = Boolean((w >>> 31) & 1);
      const isSub = Boolean((w >>> 30) & 1);
      const setFlags = Boolean((w >>> 29) & 1);
      const sh = (w >>> 22) & 1;
      const imm12 = BigInt(((w >>> 10) & 0xfff) << (sh ? 12 : 0));
      const rn = (w >>> 5) & 0x1f;
      const rd = w & 0x1f;
      const wMask = is64 ? MASK64 : MASK32;
      const lhs = getReg(rn, true);
      if (lhs === null) {
        setReg(rd, null, !setFlags);
        if (setFlags) flags.known = false;
      } else {
        const a = lhs & wMask;
        const res = (isSub ? (a - imm12) : (a + imm12)) & wMask;
        setReg(rd, res, !setFlags);
        if (setFlags) {
          const f = isSub ? computeSubFlagsArm64(a, imm12, res, is64) : computeAddFlagsArm64(a, imm12, res, is64);
          flags.known = true;
          flags.N = f.N;
          flags.Z = f.Z;
          flags.C = f.C;
          flags.V = f.V;
        }
      }
      pcOff = nextOff;
      continue;
    }

    // ADD/SUB/Logical shifted register (full LSL/LSR/ASR/ROR + exact C++ V flag!)
    if ((w & 0x1f200000) === 0x0b000000 || (w & 0x1f000000) === 0x0a000000) {
      const is64 = Boolean((w >>> 31) & 1);
      const shiftType = (w >>> 22) & 3;
      const shiftAmt = (w >>> 10) & 0x3f;
      const rd = w & 0x1f;
      const rn = (w >>> 5) & 0x1f;
      const rm = (w >>> 16) & 0x1f;
      const wMask = is64 ? MASK64 : MASK32;
      const a = getReg(rn);
      const b = getReg(rm);
      if (a === null || b === null) {
        setReg(rd, null);
        if (((w & 0x1f200000) === 0x0b000000 && ((w >>> 29) & 1)) || ((w & 0x1f000000) === 0x0a000000 && ((w >>> 29) & 3) === 3)) {
          flags.known = false;
        }
      } else {
        const av = a & wMask;
        const bv = shiftRegArm64(b, shiftType, shiftAmt, is64);
        if ((w & 0x1f200000) === 0x0b000000) {
          const isSub = Boolean((w >>> 30) & 1);
          const setFlags = Boolean((w >>> 29) & 1);
          const res = (isSub ? (av - bv) : (av + bv)) & wMask;
          setReg(rd, res);
          if (setFlags) {
            const f = isSub ? computeSubFlagsArm64(av, bv, res, is64) : computeAddFlagsArm64(av, bv, res, is64);
            flags.known = true;
            flags.N = f.N;
            flags.Z = f.Z;
            flags.C = f.C;
            flags.V = f.V;
          }
        } else {
          const opc = (w >>> 29) & 3;
          const invert = Boolean((w >>> 21) & 1);
          const rhs = invert ? ((~bv) & wMask) : bv;
          let res = 0n;
          if (opc === 0 || opc === 3) res = av & rhs;
          else if (opc === 1) res = av | rhs;
          else if (opc === 2) res = av ^ rhs;
          setReg(rd, res & wMask);
          if (opc === 3) {
            const signBit = is64 ? (1n << 63n) : (1n << 31n);
            flags.known = true;
            flags.N = (res & signBit) !== 0n ? 1 : 0;
            flags.Z = res === 0n ? 1 : 0;
            flags.C = 0;
            flags.V = 0;
          }
        }
      }
      pcOff = nextOff;
      continue;
    }

    // Unsigned-offset integer LDR / STR
    if ((w & 0x3f000000) === 0x39000000) {
      const size = (w >>> 30) & 3;
      const widthBytes = 1 << size;
      const isLoad = Boolean((w >>> 22) & 1);
      const imm12 = BigInt(((w >>> 10) & 0xfff) * widthBytes);
      const rn = (w >>> 5) & 0x1f;
      const rt = w & 0x1f;
      const base = getReg(rn, true);
      const addr = base === null ? null : (base + imm12) & MASK64;
      if (isLoad) setReg(rt, readMem(addr, widthBytes));
      else writeStack(addr, getReg(rt), widthBytes);
      pcOff = nextOff;
      continue;
    }

    // Unconditional B #imm26
    if (((w & 0xfc000000) >>> 0) === 0x14000000) {
      const imm26 = signExtend(w & 0x03ffffff, 26);
      pcOff = pcOff + imm26 * 4;
      continue;
    }

    // Conditional B.cond #imm19
    if (((w & 0xff000010) >>> 0) === 0x54000000) {
      const cond = w & 0xf;
      const taken = evalCond(cond, flags);
      const imm19 = signExtend((w >>> 5) & 0x7ffff, 19);
      if (taken !== null) {
        opaquePredicates.push({
          insnVa,
          cond,
          result: taken ? OPAQUE_PREDICATE_RESULT.ALWAYS_TRUE : OPAQUE_PREDICATE_RESULT.ALWAYS_FALSE,
          targetVa: insnVa + BigInt(imm19 * 4),
        });
        if (taken) nextOff = pcOff + imm19 * 4;
      } else {
        opaquePredicates.push({
          insnVa,
          cond,
          result: OPAQUE_PREDICATE_RESULT.UNKNOWN,
          targetVa: insnVa + BigInt(imm19 * 4),
        });
      }
      pcOff = nextOff;
      continue;
    }

    // CBZ / CBNZ
    if ((w & 0x7e000000) === 0x34000000) {
      const sf = (w >>> 31) & 1;
      const isNz = Boolean((w >>> 24) & 1);
      const rt = w & 0x1f;
      const imm19 = signExtend((w >>> 5) & 0x7ffff, 19);
      const v = getReg(rt);
      if (v !== null) {
        const masked = sf ? v : (v & MASK32);
        const taken = isNz ? (masked !== 0n) : (masked === 0n);
        opaquePredicates.push({
          insnVa,
          result: taken ? OPAQUE_PREDICATE_RESULT.ALWAYS_TRUE : OPAQUE_PREDICATE_RESULT.ALWAYS_FALSE,
          targetVa: insnVa + BigInt(imm19 * 4),
        });
        if (taken) nextOff = pcOff + imm19 * 4;
      }
      pcOff = nextOff;
      continue;
    }

    pcOff = nextOff;
  }

  let scan = 0;
  while (scan < ABSTRACT_VM_VSTACK_SIZE) {
    if (!isStackByteDefined(scan) || !isPrintableAscii(vstack[scan])) {
      scan++;
      continue;
    }
    const start = scan;
    while (scan < ABSTRACT_VM_VSTACK_SIZE && isStackByteDefined(scan) && isPrintableAscii(vstack[scan])) {
      scan++;
    }
    const len = scan - start;
    const nulTerm = scan < ABSTRACT_VM_VSTACK_SIZE && isStackByteDefined(scan) && vstack[scan] === 0;
    if (len >= 3 && (nulTerm || len >= 4)) {
      const payload = vstack.slice(start, start + len);
      const text = new TextDecoder().decode(payload);
      records.push({
        insnVa: funcVa,
        resolvedVa: vstackBase + BigInt(start),
        kind: DEOBF_EVAL_KIND.STACK_STR,
        text,
        payloadBytes: payload,
        nulTerminated: nulTerm,
        stepsUsed: steps,
      });
    }
  }

  return {
    stepsUsed: steps,
    records,
    opaquePredicates,
    finalRegs: regs,
    finalFlags: { ...flags },
  };
}

export const arm64DeobfEvalAdapter = Object.freeze({
  arch: 'arm64',
  evalDeobf: evalArm64Deobf,
});
