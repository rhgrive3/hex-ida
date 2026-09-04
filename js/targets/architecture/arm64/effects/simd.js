export { ARM64_SIMD_EFFECT_MNEMONICS } from './simd-core.js';
import { decorateArm64FpAdvSimdAccessEffects } from './fp-advsimd-access.js';
import { liftArm64SimdEffects as liftArm64SimdEffectsCore } from './simd-core.js';

export function liftArm64SimdEffects(instruction, context = {}) {
  return decorateArm64FpAdvSimdAccessEffects(
    instruction,
    liftArm64SimdEffectsCore(instruction, context),
    context,
  );
}

export const arm64SimdMachineEffects = liftArm64SimdEffects;
