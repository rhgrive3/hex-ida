// ARM64 DI Recovery Adapter (§8.2, §15).
// Supplies ARM64-specific register ABI names, 4B instruction alignment checks,
// tail-call / thunk / outlined-cold-block detection, and shifted-pointer base recognition
// for js/analysis/recovery/ via dependency injection (INV-005 compliant; zero js/targets/abi imports).

export const ARM64_GP_ARG_REGS = Object.freeze([
  'x0',
  'x1',
  'x2',
  'x3',
  'x4',
  'x5',
  'x6',
  'x7',
]);

export const ARM64_FP_ARG_REGS = Object.freeze([
  'v0',
  'v1',
  'v2',
  'v3',
  'v4',
  'v5',
  'v6',
  'v7',
]);

export const ARM64_SP_REG = 'sp';
export const ARM64_FP_REG = 'x29';
export const ARM64_LR_REG = 'x30';
export const ARM64_SP_REG_ID = 31;

const FP_PREFIX_WIDTH = Object.freeze({
  b: 1,
  h: 2,
  s: 4,
  d: 8,
  q: 16,
  v: 16,
});

export function parseArm64Register(name) {
  const tok = String(name || '').trim().toLowerCase();
  if (!tok) return null;
  if (tok === 'sp' || tok === 'wsp') {
    return {
      canonical: 'sp',
      bank: 'sp',
      regId: ARM64_SP_REG_ID,
      byteWidth: tok === 'wsp' ? 4 : 8,
      isSp: true,
      isFpOrLr: false,
    };
  }
  if (tok === 'fp') {
    return {
      canonical: 'x29',
      bank: 'gpr',
      regId: 29,
      byteWidth: 8,
      isSp: false,
      isFpOrLr: true,
    };
  }
  if (tok === 'lr') {
    return {
      canonical: 'x30',
      bank: 'gpr',
      regId: 30,
      byteWidth: 8,
      isSp: false,
      isFpOrLr: true,
    };
  }

  const gprMatch = /^([xw])(\d{1,2})$/.exec(tok);
  if (gprMatch) {
    const id = Number(gprMatch[2]);
    if (id >= 0 && id <= 30) {
      return {
        canonical: `${gprMatch[1]}${id}`,
        bank: 'gpr',
        regId: id,
        byteWidth: gprMatch[1] === 'w' ? 4 : 8,
        isSp: false,
        isFpOrLr: id === 29 || id === 30,
      };
    }
    return null;
  }

  const fprMatch = /^([bhsdqv])(\d{1,2})$/.exec(tok);
  if (fprMatch) {
    const id = Number(fprMatch[2]);
    if (id >= 0 && id <= 31) {
      return {
        canonical: `${fprMatch[1]}${id}`,
        bank: 'fpr',
        regId: id,
        byteWidth: FP_PREFIX_WIDTH[fprMatch[1]],
        isSp: false,
        isFpOrLr: false,
      };
    }
    return null;
  }

  return null;
}

export function formatArm64Register(bank, regId, byteWidth = 8) {
  if (bank === 'sp' || regId === ARM64_SP_REG_ID) return 'sp';
  if (bank === 'fpr') {
    if (byteWidth === 1) return `b${regId}`;
    if (byteWidth === 2) return `h${regId}`;
    if (byteWidth === 4) return `s${regId}`;
    if (byteWidth === 8) return `d${regId}`;
    return `v${regId}`;
  }
  return byteWidth <= 4 ? `w${regId}` : `x${regId}`;
}

export function isArm64CodeAligned(va) {
  const big = typeof va === 'bigint' ? va : BigInt(va);
  return (big & 3n) === 0n;
}

function normMnem(insn) {
  return String(insn?.mnemonic ?? insn?.mnem ?? '').trim().toLowerCase();
}

function normOps(insn) {
  return String(insn?.operands ?? insn?.opStr ?? '').trim().toLowerCase();
}

function hasArm64FramePrologue(insns) {
  const limit = Math.min(insns.length, 4);
  for (let i = 0; i < limit; i++) {
    const m = normMnem(insns[i]);
    const ops = normOps(insns[i]);
    if (m === 'stp' && (ops.includes('x29') || ops.includes('fp')) && (ops.includes('x30') || ops.includes('lr'))) {
      return true;
    }
    if (m === 'pacibsp' || m === 'paciasp') {
      return true;
    }
  }
  return false;
}

/**
 * Detect ARM64 tail calls, C++ `this`-adjusting thunks, and outlined cold/tail blocks (§15.2).
 */
export function detectArm64TailCallOrThunk(insns, funcRange = null) {
  const list = Array.isArray(insns) ? insns : [];
  if (list.length === 0) {
    return {
      isTailCall: false,
      isThunk: false,
      thunkDelta: 0,
      targetVa: null,
      hasPrologue: false,
      isOutlinedColdCandidate: false,
    };
  }

  const hasPrologue = hasArm64FramePrologue(list);
  const last = list[list.length - 1];
  const lastMnem = normMnem(last);
  const lastOps = normOps(last);

  let targetVa = last.targetVa !== undefined && last.targetVa !== null ? BigInt(last.targetVa) : null;
  if (targetVa === null && lastMnem === 'b') {
    const hexMatch = /0x[0-9a-f]+/i.exec(lastOps);
    if (hexMatch) targetVa = BigInt(hexMatch[0]);
  }

  const startVa = funcRange?.startVa !== undefined ? BigInt(funcRange.startVa) : null;
  const endVa = funcRange?.endVa !== undefined ? BigInt(funcRange.endVa) : null;
  const jumpsOutside =
    targetVa !== null &&
    startVa !== null &&
    endVa !== null &&
    (targetVa < startVa || targetVa >= endVa);

  const isUncondBranch = lastMnem === 'b' || lastMnem === 'br' || lastMnem === 'braa' || lastMnem === 'brab';
  const isTailCall = isUncondBranch && (jumpsOutside || funcRange === null);

  // C++ `this`-adjusting thunk: short sequence `sub/add x0, x0, #imm` + `b target`
  let isThunk = false;
  let thunkDelta = 0;
  if (isTailCall && list.length <= 4 && !hasPrologue) {
    for (let i = 0; i < list.length - 1; i++) {
      const m = normMnem(list[i]);
      const ops = normOps(list[i]);
      const adjMatch = /^(add|sub)$/.exec(m) && /^x0\s*,\s*x0\s*,\s*#(0x[0-9a-f]+|\d+)/i.exec(ops);
      if (adjMatch) {
        const imm = Number(adjMatch[1]);
        thunkDelta += m === 'sub' ? -imm : imm;
        isThunk = true;
      }
    }
  }

  const isTerminalExit =
    lastMnem === 'ret' ||
    lastMnem === 'retaa' ||
    lastMnem === 'retab' ||
    lastMnem === 'brk' ||
    lastMnem === 'udf' ||
    (lastMnem === 'b' && !jumpsOutside) ||
    Boolean(last.isNoreturnCall);

  const isOutlinedColdCandidate = !hasPrologue && (isTerminalExit || isTailCall);

  return {
    isTailCall,
    isThunk,
    thunkDelta,
    targetVa,
    hasPrologue,
    isOutlinedColdCandidate,
  };
}

/**
 * Recognize ARM64 shifted-pointer / `container_of` base adjustment idioms (§15.4).
 * Detects:
 *  - `SUB xd, xn, #imm` (container_of shift back by `imm`)
 *  - `ADD xd, xn, #-imm` (negative immediate adjustment)
 *  - `LDUR/STUR rt, [xn, #-imm]` (negative offset access relative to shifted base)
 */
export function recognizeArm64ShiftedBase(insns) {
  const results = [];
  for (const insn of insns || []) {
    const m = normMnem(insn);
    const ops = normOps(insn);
    const va = insn.va ?? null;

    if (m === 'sub') {
      const match = /^(x\d{1,2})\s*,\s*(x\d{1,2})\s*,\s*#(0x[0-9a-f]+|\d+)$/i.exec(ops);
      if (match) {
        const delta = Number(match[3]);
        if (Number.isInteger(delta) && delta > 0 && delta <= 0x10000) {
          results.push({
            va,
            kind: 'sub_imm',
            destReg: match[1],
            baseReg: match[2],
            shiftDelta: delta,
          });
        }
      }
    } else if (m === 'add') {
      const match = /^(x\d{1,2})\s*,\s*(x\d{1,2})\s*,\s*#-(0x[0-9a-f]+|\d+)$/i.exec(ops);
      if (match) {
        const delta = Number(match[3]);
        if (Number.isInteger(delta) && delta > 0 && delta <= 0x10000) {
          results.push({
            va,
            kind: 'add_neg_imm',
            destReg: match[1],
            baseReg: match[2],
            shiftDelta: delta,
          });
        }
      }
    } else if (m === 'ldur' || m === 'stur' || m === 'ldr' || m === 'str') {
      const match = /^([xwdsqv]\d{1,2})\s*,\s*\[\s*(x\d{1,2})\s*,\s*#-(0x[0-9a-f]+|\d+)\s*\]$/i.exec(
        ops
      );
      if (match) {
        const negOff = Number(match[3]);
        if (Number.isInteger(negOff) && negOff > 0) {
          results.push({
            va,
            kind: 'neg_mem_access',
            destReg: match[1],
            baseReg: match[2],
            shiftDelta: negOff,
          });
        }
      }
    }
  }
  return results;
}

/**
 * Factory creating the ARM64 DI adapter for js/analysis/recovery/* modules.
 */
export function createArm64RecoveryAdapter() {
  return Object.freeze({
    arch: 'arm64',
    ptrBytes: 8,
    gpArgRegs: ARM64_GP_ARG_REGS,
    fpArgRegs: ARM64_FP_ARG_REGS,
    spReg: ARM64_SP_REG,
    fpReg: ARM64_FP_REG,
    lrReg: ARM64_LR_REG,
    spRegId: ARM64_SP_REG_ID,
    parseRegister: parseArm64Register,
    formatRegister: formatArm64Register,
    isCodeAligned: isArm64CodeAligned,
    isFrameOrLinkReg: (regId) => regId === 29 || regId === 30,
    detectTailCallOrThunk: detectArm64TailCallOrThunk,
    recognizeShiftedBase: recognizeArm64ShiftedBase,
  });
}
