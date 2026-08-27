export {
  ARM64_INTEGER_EFFECT_MNEMONICS,
  decodeArm64BitMasks,
  evaluateArm64Bitfield,
} from './integer-core.js';
import { liftArm64IntegerEffects as liftArm64IntegerEffectsCore } from './integer-core.js';

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

export function liftArm64IntegerEffects(instruction, options = {}) {
  const mnemonic = String(instruction?.mnemonic || '').toLowerCase();
  const ops = Array.isArray(instruction?.ops) ? instruction.ops : [];
  const expected = expectedOperandCount(mnemonic);
  if (expected != null && ops.length !== expected) {
    return liftArm64IntegerEffectsCore({ ...instruction, ops: [] }, options);
  }
  return liftArm64IntegerEffectsCore(instruction, options);
}
