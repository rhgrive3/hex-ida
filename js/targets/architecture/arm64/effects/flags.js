export {
  ARM64_FLAG_EFFECT_MNEMONICS,
  evaluateArm64AddSubFlags,
  evaluateArm64Condition,
  emitArm64AddSub,
  emitArm64LogicalFlags,
  writeArm64NZCV,
  emitArm64Condition,
} from './flags-core.js';
import { liftArm64FlagEffects as liftArm64FlagEffectsCore } from './flags-core.js';

const STRICT_REGISTER_LHS = new Set(['cmp','cmn','ccmp','ccmn']);
const SP_LHS_MNEMONICS = new Set(['cmp','cmn']);
const EXTEND_KINDS = new Set(['uxtb','uxth','uxtw','uxtx','sxtb','sxth','sxtw','sxtx']);

function validRegisterLhs(mnemonic, op) {
  if (op?.k !== 'reg') return false;
  const cls = String(op.cls || '').toLowerCase();
  if (cls === 'gp' || cls === 'zr') return true;
  // ADD/SUB aliases CMP/CMN have architectural forms whose Rn=31 is SP
  // (notably immediate/extended-register encodings). Conditional compares do not.
  return cls === 'sp' && SP_LHS_MNEMONICS.has(mnemonic);
}

function validSpImmediateRhs(op) {
  if (op?.k !== 'imm') return true;
  let immediate;
  try { immediate = BigInt(op.value); } catch { return false; }
  if (immediate < 0n || immediate > 0xfffn) return false;
  if (op.shift == null) return true;
  return String(op.shift.op || '').toLowerCase() === 'lsl' && Number(op.shift.amount) === 12;
}

function validRegisterRhs(mnemonic, lhs, rhs) {
  if (rhs?.k !== 'reg') return true;
  const lhsBits = Number(lhs?.bits || 0);
  const rhsBits = Number(rhs?.bits || 0);
  if (![32,64].includes(lhsBits) || !['gp','zr'].includes(String(rhs.cls || '').toLowerCase())) return false;
  const modifier = rhs.shift || rhs.extend || null;

  // Conditional compare has only the plain Wn/Wm or Xn/Xm register form.
  if (mnemonic === 'ccmp' || mnemonic === 'ccmn') return modifier == null && rhsBits === lhsBits;

  if (modifier == null) return rhsBits === lhsBits;
  const kind = String(modifier.op || '').toLowerCase();
  const amount = Number(modifier.amount ?? 0);
  if (!Number.isInteger(amount) || amount < 0) return false;
  const lhsClass = String(lhs?.cls || '').toLowerCase();

  // SUBS/ADDS shifted-register encodings allow LSL/LSR/ASR only. When Rn is
  // SP, assembler LSL is the preferred spelling of the extended-register UXTX
  // (or UXTW) option and its imm3 range is 0..4.
  if (kind === 'lsl' || kind === 'lsr' || kind === 'asr') {
    if (lhsClass === 'sp') return kind === 'lsl' && rhsBits === lhsBits && amount <= 4;
    return rhsBits === lhsBits && amount < lhsBits;
  }
  if (kind === 'ror') return false;

  if (!EXTEND_KINDS.has(kind) || amount > 4 || lhsClass === 'zr') return false;
  if (lhsBits === 32) return rhsBits === 32;
  return kind.endsWith('x') ? rhsBits === 64 : rhsBits === 32;
}

export function liftArm64FlagEffects(instruction, options = {}) {
  const mnemonic = String(instruction?.mnemonic || '').trim().toLowerCase();
  const ops = Array.isArray(instruction?.ops) ? instruction.ops : [];
  if (STRICT_REGISTER_LHS.has(mnemonic) && !validRegisterLhs(mnemonic, ops[0])) {
    return liftArm64FlagEffectsCore({ ...instruction, ops: [] }, options);
  }
  if (SP_LHS_MNEMONICS.has(mnemonic) && String(ops[0]?.cls || '').toLowerCase() === 'sp' && !validSpImmediateRhs(ops[1])) {
    return liftArm64FlagEffectsCore({ ...instruction, ops: [] }, options);
  }
  if (STRICT_REGISTER_LHS.has(mnemonic) && !validRegisterRhs(mnemonic, ops[0], ops[1])) {
    return liftArm64FlagEffectsCore({ ...instruction, ops: [] }, options);
  }
  return liftArm64FlagEffectsCore(instruction, options);
}
