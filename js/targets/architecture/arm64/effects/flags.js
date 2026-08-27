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

function validRegisterLhs(mnemonic, op) {
  if (op?.k !== 'reg') return false;
  const cls = String(op.cls || '').toLowerCase();
  if (cls === 'gp' || cls === 'zr') return true;
  // ADD/SUB aliases CMP/CMN have architectural forms whose Rn=31 is SP
  // (notably immediate/extended-register encodings). Conditional compares do not.
  return cls === 'sp' && SP_LHS_MNEMONICS.has(mnemonic);
}

export function liftArm64FlagEffects(instruction, options = {}) {
  const mnemonic = String(instruction?.mnemonic || '').trim().toLowerCase();
  const ops = Array.isArray(instruction?.ops) ? instruction.ops : [];
  if (STRICT_REGISTER_LHS.has(mnemonic) && !validRegisterLhs(mnemonic, ops[0])) {
    return liftArm64FlagEffectsCore({ ...instruction, ops: [] }, options);
  }
  return liftArm64FlagEffectsCore(instruction, options);
}
