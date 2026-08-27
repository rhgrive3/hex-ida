export {
  ARM64_INTEGER_EFFECT_MNEMONICS,
  decodeArm64BitMasks,
  evaluateArm64Bitfield,
} from './integer-core.js';
import { liftArm64IntegerEffects as liftArm64IntegerEffectsCore } from './integer-core.js';

const ADD_SUB_BASE = new Set(['add','adds','sub','subs']);
const ADD_SUB_ALL = new Set(['add','adds','sub','subs','adc','adcs','sbc','sbcs','neg','negs','ngc','ngcs']);
const LOGICAL_NO_SP = new Set(['and','ands','orr','eor','bic','bics','orn','eon','mvn']);
const EXTEND_KINDS = new Set(['uxtb','uxth','uxtw','uxtx','sxtb','sxth','sxtw','sxtx']);

function expectedOperandCount(mnemonic) {
  if (['lsl','lslv','lsr','lsrv','asr','asrv','ror','rorv'].includes(mnemonic)) return 3;
  if (['sxtb','sxth','sxtw','uxtb','uxth','uxtw','clz','rbit','rev','rev16','rev32','abs'].includes(mnemonic)) return 2;
  if (['csel','csinc','csinv','csneg'].includes(mnemonic)) return 4;
  if (['cset','csetm'].includes(mnemonic)) return 2;
  if (['cinc','cneg','cinv'].includes(mnemonic)) return 3;
  if (mnemonic === 'extr') return 4;
  if (['ubfx','sbfx','ubfiz','sbfiz','bfxil','bfi','ubfm','sbfm','bfm'].includes(mnemonic)) return 4;
  if (mnemonic === 'bfc') return 3;
  return null;
}

function regClass(op) { return op?.k === 'reg' ? String(op.cls || '').toLowerCase() : ''; }
function regBits(op) { return Number(op?.bits || 0); }
function isGpOrZr(op) { return op?.k === 'reg' && ['gp','zr'].includes(regClass(op)); }
function isGpOrSp(op) { return op?.k === 'reg' && ['gp','sp'].includes(regClass(op)); }

function validImm12(op) {
  if (op?.k !== 'imm') return false;
  let value;
  try { value = BigInt(op.value); } catch { return false; }
  if (value < 0n || value > 0xfffn) return false;
  if (op.shift == null) return true;
  return String(op.shift.op || '').toLowerCase() === 'lsl' && Number(op.shift.amount) === 12;
}

function validExtendedSource(rhs, targetBits) {
  if (!isGpOrZr(rhs)) return false;
  const modifier = rhs.shift || rhs.extend || null;
  if (modifier == null) return regBits(rhs) === targetBits;
  const kind = String(modifier.op || '').toLowerCase();
  const amount = Number(modifier.amount ?? 0);
  if (!Number.isInteger(amount) || amount < 0 || amount > 4) return false;
  if (kind === 'lsl') return regBits(rhs) === targetBits;
  if (!EXTEND_KINDS.has(kind)) return false;
  if (targetBits === 32) return regBits(rhs) === 32;
  return kind.endsWith('x') ? regBits(rhs) === 64 : regBits(rhs) === 32;
}

function validShiftedSource(rhs, targetBits) {
  if (!isGpOrZr(rhs) || regBits(rhs) !== targetBits) return false;
  const modifier = rhs.shift || rhs.extend || null;
  if (modifier == null) return true;
  const kind = String(modifier.op || '').toLowerCase();
  const amount = Number(modifier.amount ?? 0);
  return ['lsl','lsr','asr'].includes(kind)
    && Number.isInteger(amount) && amount >= 0 && amount < targetBits;
}

function validAddSubRegister31Encoding(mnemonic, ops) {
  if (!ADD_SUB_ALL.has(mnemonic)) return true;
  const containsSp = ops.some((op) => regClass(op) === 'sp');
  if (!ADD_SUB_BASE.has(mnemonic)) return !containsSp;
  if (ops.length !== 3) return false;

  const dst = ops[0], lhs = ops[1], rhs = ops[2];
  const bits = regBits(dst);
  if (bits !== 32 && bits !== 64) return false;
  if (regBits(lhs) !== bits) return false;

  if (rhs?.k === 'imm') {
    // ADD/SUB immediate interpret register 31 as SP for Rn and, when S=0,
    // for Rd. ADDS/SUBS keep Rd=31 as ZR.
    const dstOk = mnemonic === 'add' || mnemonic === 'sub' ? isGpOrSp(dst) : isGpOrZr(dst);
    return dstOk && isGpOrSp(lhs) && validImm12(rhs);
  }

  if (rhs?.k !== 'reg') return false;
  const dstClass = regClass(dst);
  const lhsClass = regClass(lhs);
  const modifier = rhs.shift || rhs.extend || null;
  const explicitExtend = EXTEND_KINDS.has(String(modifier?.op || '').toLowerCase());
  const usesExtendedEncoding = dstClass === 'sp' || lhsClass === 'sp' || explicitExtend;

  if (usesExtendedEncoding) {
    // In ADD/SUB extended-register encodings Rn=31 is SP. Rd=31 is SP only
    // for S=0; flag-setting forms still interpret it as ZR.
    const dstOk = mnemonic === 'add' || mnemonic === 'sub' ? isGpOrSp(dst) : isGpOrZr(dst);
    if (!dstOk || !isGpOrSp(lhs)) return false;
    return validExtendedSource(rhs, bits);
  }

  // Shifted-register encodings interpret register 31 as ZR and never SP.
  if (!isGpOrZr(dst) || !isGpOrZr(lhs)) return false;
  return validShiftedSource(rhs, bits);
}

function validLogicalRegisterClass(mnemonic, ops) {
  if (!LOGICAL_NO_SP.has(mnemonic)) return true;
  return !ops.some((op) => regClass(op) === 'sp');
}

export function liftArm64IntegerEffects(instruction, options = {}) {
  const mnemonic = String(instruction?.mnemonic || '').toLowerCase();
  const ops = Array.isArray(instruction?.ops) ? instruction.ops : [];
  const expected = expectedOperandCount(mnemonic);
  if (expected != null && ops.length !== expected) {
    return liftArm64IntegerEffectsCore({ ...instruction, ops: [] }, options);
  }
  if (!validAddSubRegister31Encoding(mnemonic, ops)) {
    return liftArm64IntegerEffectsCore({ ...instruction, ops: [] }, options);
  }
  if (!validLogicalRegisterClass(mnemonic, ops)) {
    return liftArm64IntegerEffectsCore({ ...instruction, ops: [] }, options);
  }
  return liftArm64IntegerEffectsCore(instruction, options);
}
