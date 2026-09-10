import { createMachineEffectBundle } from '../../../../semantics/effects/index.js';
import { instructionMnemonic } from './common.js';
import {
  ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION,
  arm64MachineEffectFamilies,
  liftArm64MachineEffects as liftArm64MachineEffectsBase,
} from './dispatcher.js';
import { arm64FpExceptionTrapFault } from './fp-exception-traps.js';
import { arm64FpAdvSimdAccessTrapFault } from './fp-advsimd-access-traps.js';

export { ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION, arm64MachineEffectFamilies };

function registerReadValue(bundle, registerId) {
  const read = bundle?.operations?.find((operation) => operation?.kind === 'register-read'
    && operation?.register?.registerId === registerId);
  return read?.value ?? null;
}

function isArm64FpAdvSimdBundle(bundle) {
  return bundle?.metadata?.family === 'arm64-fp' || bundle?.metadata?.family === 'arm64-simd';
}

function decorateArm64FpAdvSimdAccessTrapEffects(instruction, bundle, context = {}) {
  if (!bundle || !isArm64FpAdvSimdBundle(bundle)) return bundle;
  if (bundle.completeness !== 'exact' && bundle.completeness !== 'exact-with-intrinsic') return bundle;

  const existingFaults = Array.isArray(bundle.possibleFaults) ? bundle.possibleFaults : [];
  const withoutAccessFault = existingFaults.filter((candidate) => candidate?.kind !== 'fp-advsimd-access-trap');
  const fault = arm64FpAdvSimdAccessTrapFault(instructionMnemonic(instruction), context);
  if (fault == null && withoutAccessFault.length === existingFaults.length) return bundle;

  const machineEffectsOptions = context.machineEffectsOptions ?? context.options ?? {};
  return createMachineEffectBundle({
    ...bundle,
    possibleFaults:fault == null ? withoutAccessFault : [fault, ...withoutAccessFault],
  }, machineEffectsOptions);
}

function decorateArm64FpExceptionTrapEffects(instruction, bundle, context = {}) {
  if (!bundle || registerReadValue(bundle, 'fpcr') == null) return bundle;
  const mnemonic = instructionMnemonic(instruction);
  const intrinsic = bundle.operations?.find((operation) => operation?.kind === 'intrinsic'
    && typeof operation?.intrinsicId === 'string'
    && (operation.intrinsicId.startsWith('arm64.fp.') || operation.intrinsicId.startsWith('arm64.simd.')));
  let executionCondition = null;
  if ((mnemonic === 'fccmp' || mnemonic === 'fccmpe') && intrinsic?.metadata?.condition) {
    const oldNzcv = registerReadValue(bundle, 'nzcv');
    if (oldNzcv != null) {
      executionCondition = Object.freeze({
        kind:'arm64-condition-holds',
        condition:intrinsic.metadata.condition,
        nzcv:oldNzcv,
      });
    }
  }
  const fault = arm64FpExceptionTrapFault(mnemonic, { executionCondition });
  if (!fault) return bundle;
  const existingFaults = Array.isArray(bundle.possibleFaults) ? bundle.possibleFaults : [];
  if (existingFaults.some((candidate) => candidate?.kind === fault.kind
    && candidate?.condition?.kind === fault.condition.kind)) return bundle;
  const machineEffectsOptions = context.machineEffectsOptions ?? context.options ?? {};
  return createMachineEffectBundle({
    ...bundle,
    possibleFaults:[...existingFaults, fault],
  }, machineEffectsOptions);
}

export function liftArm64MachineEffects(decoded, context = {}) {
  const bundle = liftArm64MachineEffectsBase(decoded, context);
  const withAccessTrap = decorateArm64FpAdvSimdAccessTrapEffects(decoded, bundle, context);
  return decorateArm64FpExceptionTrapEffects(decoded, withAccessTrap, context);
}

export const liftExact = liftArm64MachineEffects;
