import {
  createBitVectorValue,
  createIntrinsicEffectSummary,
  createMachineEffectBundle,
  createMachineOperation,
  createRegisterValue,
  createTemporaryValue,
} from '../../../../semantics/effects/index.js';
import { arm64RegisterOperand } from './addressing.js';
import { instructionMnemonic } from './common.js';
import {
  ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION,
  arm64MachineEffectFamilies,
  liftArm64MachineEffects as liftArm64MachineEffectsBase,
} from './dispatcher.js';
import { arm64FpExceptionTrapFault } from './fp-exception-traps.js';
import { arm64FpAdvSimdAccessTrapFault } from './fp-advsimd-access-traps.js';

export { ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION, arm64MachineEffectFamilies };

const FULL_ENVIRONMENT_SYSTEM_STATE = Object.freeze([
  'sys:currentel',
  'sys:daif',
  'sys:spsel',
  'sys:tpidr_el0',
  'sys:tpidrro_el0',
  'sys:cntvct_el0',
  'sys:cntpct_el0',
  'sys:cntfrq_el0',
]);

const PSTATE_IMMEDIATE_STATE = new Map([
  ['uao', 'sys:uao'],
  ['pan', 'sys:pan'],
  ['spsel', 'sys:spsel'],
  ['ssbs', 'sys:ssbs'],
  ['dit', 'sys:dit'],
  ['tco', 'sys:tco'],
  ['daifset', 'sys:daif'],
  ['daifclr', 'sys:daif'],
  ['allint', 'sys:allint'],
  ['pm', 'sys:pm'],
  ['svcrsm', 'sys:svcr'],
  ['svcrza', 'sys:svcr'],
  ['svcrsmza', 'sys:svcr'],
]);

function instructionOperands(instruction) {
  if (Array.isArray(instruction?.ops)) return instruction.ops;
  if (Array.isArray(instruction?.operandsParsed)) return instruction.operandsParsed;
  if (Array.isArray(instruction?.parsed)) return instruction.parsed;
  return [];
}

function operandText(operand) {
  return typeof operand?.text === 'string' ? operand.text.trim().toLowerCase() : '';
}

function unique(values) {
  return [...new Set(values)];
}

function rewriteIntrinsicRegisters(operation, { reads = [], writes = [], replace = null } = {}) {
  if (operation?.kind !== 'intrinsic') return operation;
  const summary = operation.effectSummary;
  const mapRegister = (register) => replace?.get(register) ?? register;
  const registersRead = unique([...summary.registersRead.map(mapRegister), ...reads]);
  const registersWritten = unique([...summary.registersWritten.map(mapRegister), ...writes]);
  return createMachineOperation({
    ...operation,
    effectSummary:createIntrinsicEffectSummary({
      ...summary,
      registersRead,
      registersWritten,
    }),
  });
}

function decorateArm64SystemStateIdentity(instruction, bundle, context = {}) {
  if (!bundle || !Array.isArray(bundle.operations)) return bundle;
  const mnemonic = instructionMnemonic(instruction);
  const operands = instructionOperands(instruction);
  let changed = false;
  let operations = bundle.operations;

  if (mnemonic === 'msr' && operands.length === 2 && operands[1]?.k === 'imm') {
    const field = operandText(operands[0]);
    const stateId = PSTATE_IMMEDIATE_STATE.get(field);
    if (stateId) {
      const replace = new Map([[`sys:${field}`, stateId]]);
      operations = operations.map((operation) => rewriteIntrinsicRegisters(operation, {
        reads:field === 'daifset' || field === 'daifclr' ? [stateId] : [],
        writes:[stateId],
        replace,
      }));
      changed = true;
    }
  }

  if (bundle.metadata?.environmentFootprintComplete === true) {
    const next = operations.map((operation) => {
      if (operation?.kind !== 'intrinsic' || operation?.metadata?.conservativeFullEnvironment !== true) return operation;
      changed = true;
      return rewriteIntrinsicRegisters(operation, {
        reads:FULL_ENVIRONMENT_SYSTEM_STATE,
        writes:FULL_ENVIRONMENT_SYSTEM_STATE,
      });
    });
    operations = next;
  }

  const hasSpMemoryBase = operands.some((operand) => {
    if (operand?.k !== 'mem' && operand?.kind !== 'memory') return false;
    const base = operand.base ?? operand.baseRegister;
    return arm64RegisterOperand(base)?.kind === 'sp';
  });
  if (hasSpMemoryBase && !operations.some((operation) => operation?.kind === 'register-read'
    && operation?.register?.registerId === 'sys:spsel')) {
    const selector = createTemporaryValue('arm64.spsel.current', createBitVectorValue(1));
    operations = [
      createMachineOperation({
        kind:'register-read',
        register:createRegisterValue('sys:spsel', 1, { view:'PSTATE.SPSel' }),
        value:selector,
        metadata:{ architecturalState:'PSTATE.SPSel', purpose:'stack-pointer-bank-selection' },
      }),
      ...operations,
    ];
    changed = true;
  }

  if (!changed) return bundle;
  const machineEffectsOptions = context.machineEffectsOptions ?? context.options ?? {};
  return createMachineEffectBundle({ ...bundle, operations }, machineEffectsOptions);
}

function registerReadValue(bundle, registerId) {
  const read = bundle?.operations?.find((operation) => operation?.kind === 'register-read'
    && operation?.register?.registerId === registerId);
  return read?.value ?? null;
}

function isArm64FpAdvSimdBundle(instruction, bundle) {
  const family = bundle?.metadata?.family;
  if (family === 'arm64-fp' || family === 'arm64-simd') return true;
  if (family !== 'arm64-memory') return false;
  // Memory-family transfers use the same FP/AdvSIMD registers and access controls.
  const operands = Array.isArray(instruction?.ops) ? instruction.ops
    : Array.isArray(instruction?.operands) ? instruction.operands : [];
  return operands.some((operand) => arm64RegisterOperand(operand)?.kind === 'vector');
}

function decorateArm64FpAdvSimdAccessTrapEffects(instruction, bundle, context = {}) {
  if (!bundle || !isArm64FpAdvSimdBundle(instruction, bundle)) return bundle;
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
  const withSystemState = decorateArm64SystemStateIdentity(decoded, bundle, context);
  const withAccessTrap = decorateArm64FpAdvSimdAccessTrapEffects(decoded, withSystemState, context);
  return decorateArm64FpExceptionTrapEffects(decoded, withAccessTrap, context);
}

export const liftExact = liftArm64MachineEffects;
