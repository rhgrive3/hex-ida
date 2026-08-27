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

function validRegisterLhs(op) {
  return op?.k === 'reg' && ['gp','zr'].includes(String(op.cls || '').toLowerCase());
}

export function liftArm64FlagEffects(instruction, options = {}) {
  const mnemonic = String(instruction?.mnemonic || '').trim().toLowerCase();
  const ops = Array.isArray(instruction?.ops) ? instruction.ops : [];
  if (STRICT_REGISTER_LHS.has(mnemonic) && !validRegisterLhs(ops[0])) {
    return liftArm64FlagEffectsCore({ ...instruction, ops: [] }, options);
  }
  return liftArm64FlagEffectsCore(instruction, options);
}
