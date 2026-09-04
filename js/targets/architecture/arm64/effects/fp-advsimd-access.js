import { createMachineEffectBundle } from '../../../../semantics/effects/index.js';

const EXACT_COMPLETENESS = new Set(['exact', 'exact-with-intrinsic']);

function mnemonicOf(instruction) {
  if (typeof instruction?.mnemonic !== 'string') return '';
  return instruction.mnemonic.trim().toLowerCase();
}

function accessFault(instruction) {
  return {
    kind: 'fp-advsimd-access-trap',
    condition: {
      kind: 'architectural-access-check',
      access: 'fp-advsimd',
      operation: mnemonicOf(instruction),
    },
  };
}

export function decorateArm64FpAdvSimdAccessEffects(instruction, effect, context = {}) {
  if (!effect || !EXACT_COMPLETENESS.has(effect.completeness)) return effect;
  const operation = mnemonicOf(instruction);
  if (!operation) return effect;
  if ((effect.possibleFaults || []).some((fault) => fault?.kind === 'fp-advsimd-access-trap')) return effect;
  return createMachineEffectBundle({
    ...effect,
    possibleFaults: [accessFault(instruction), ...(effect.possibleFaults || [])],
  }, context?.machineEffectsOptions || {});
}
