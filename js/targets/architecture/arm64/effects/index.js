import { decorateArm64BtiGuardedPageEffects } from './bti-guard-state.js';
import { liftArm64ControlEffects } from './control.js';
import { createArm64EffectContext, directTargetOf, immediateOf, instructionMnemonic } from './common.js';
import { liftArm64FlagEffects } from './flags.js';
import { liftArm64FpEffects } from './fp.js';
import { liftArm64IntegerEffects } from './integer.js';
import { liftArm64MemoryEffects } from './memory.js';
import { liftArm64SimdEffects } from './simd.js';
import { liftArm64SystemEffects } from './system.js';

export const ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION = '7';

const ARM64_EFFECT_FAMILIES = Object.freeze([
  Object.freeze({ id:'flags', lift:liftArm64FlagEffects }),
  Object.freeze({ id:'control', lift:liftArm64ControlEffects }),
  Object.freeze({ id:'memory', lift:liftArm64MemoryEffects }),
  Object.freeze({ id:'simd', lift:liftArm64SimdEffects }),
  Object.freeze({ id:'fp', lift:liftArm64FpEffects }),
  Object.freeze({ id:'integer', lift:liftArm64IntegerEffects }),
  Object.freeze({ id:'system', lift:liftArm64SystemEffects }),
]);

const ARM64_ADD_SUB_IMMEDIATE_MNEMONICS = Object.freeze(new Set(['add','adds','sub','subs']));
const ARM64_ADD_SUB_FAMILY_MNEMONICS = Object.freeze(new Set([
  ...ARM64_ADD_SUB_IMMEDIATE_MNEMONICS,
  'adc','adcs','sbc','sbcs','neg','negs','ngc','ngcs',
]));
const ARM64_LOGICAL_IMMEDIATE_MNEMONICS = Object.freeze(new Set(['and','ands','orr','eor','tst']));
const ARM64_LITERAL_MEMORY_MNEMONICS = Object.freeze(new Set(['ldr','ldrsw','prfm']));

function validImm12WithOptionalLsl12(op) {
  if (op?.k !== 'imm') return true;
  const immediate = immediateOf(op);
  if (immediate == null || immediate < 0n || immediate > 0xfffn) return false;
  if (op.shift == null) return true;
  return String(op.shift.op || '').toLowerCase() === 'lsl' && Number(op.shift.amount) === 12;
}

function rotateRightElement(value, amount, widthBits) {
  const width = BigInt(widthBits);
  const shift = BigInt(amount % widthBits);
  const mask = (1n << width) - 1n;
  if (shift === 0n) return value & mask;
  return ((value >> shift) | (value << (width - shift))) & mask;
}

function replicateElement(value, elementBits, widthBits) {
  let result = 0n;
  for (let offset = 0; offset < widthBits; offset += elementBits) result |= value << BigInt(offset);
  return BigInt.asUintN(widthBits, result);
}

function buildLogicalImmediateMasks(widthBits) {
  const masks = new Set();
  for (let elementBits = 2; elementBits <= widthBits; elementBits *= 2) {
    for (let ones = 1; ones < elementBits; ones++) {
      const base = (1n << BigInt(ones)) - 1n;
      for (let rotation = 0; rotation < elementBits; rotation++) {
        masks.add(replicateElement(rotateRightElement(base, rotation, elementBits), elementBits, widthBits).toString());
      }
    }
  }
  return masks;
}

const LOGICAL_IMMEDIATE_MASKS = Object.freeze({
  32: buildLogicalImmediateMasks(32),
  64: buildLogicalImmediateMasks(64),
});

function logicalImmediateEncodable(op, widthBits) {
  if (op?.k !== 'imm' || (widthBits !== 32 && widthBits !== 64) || op.shift != null) return false;
  const immediate = immediateOf(op);
  if (immediate == null) return false;
  return LOGICAL_IMMEDIATE_MASKS[widthBits].has(BigInt.asUintN(widthBits, immediate).toString());
}

function asBigIntOrNull(value) {
  try { return value == null ? null : BigInt(value); }
  catch { return null; }
}

function addSubImmediateEncodingFailure(instruction) {
  const mnemonic = instructionMnemonic(instruction);
  if (!ARM64_ADD_SUB_FAMILY_MNEMONICS.has(mnemonic)) return null;
  const ops = Array.isArray(instruction?.ops) ? instruction.ops : [];
  const alias = ['neg','negs','ngc','ngcs'].includes(mnemonic);
  const lhs = alias ? null : ops[1];
  const rhs = alias ? ops[1] : ops[2];
  if (rhs?.k === 'imm' && !ARM64_ADD_SUB_IMMEDIATE_MNEMONICS.has(mnemonic)) return `arm64-${mnemonic}-immediate-form-unencodable`;
  if (lhs?.k === 'imm') return `arm64-${mnemonic}-lhs-immediate-unencodable`;
  if (rhs?.k === 'reg' && String(rhs.shift?.op || '').toLowerCase() === 'ror') return `arm64-${mnemonic}-ror-shift-unencodable`;
  if (rhs?.k !== 'imm') return null;
  if (!validImm12WithOptionalLsl12(rhs)) {
    const immediate = immediateOf(rhs);
    if (immediate == null || immediate < 0n || immediate > 0xfffn) return `arm64-${mnemonic}-immediate-out-of-range`;
    return `arm64-${mnemonic}-immediate-shift-unencodable`;
  }
  return null;
}

function flagEncodingFailure(instruction) {
  const mnemonic = instructionMnemonic(instruction);
  if (!['cmp','cmn','ccmp','ccmn'].includes(mnemonic)) return null;
  const ops = Array.isArray(instruction?.ops) ? instruction.ops : [];
  const rhs = ops[1];
  if (rhs?.k !== 'imm') return null;
  if (mnemonic === 'cmp' || mnemonic === 'cmn') {
    if (!validImm12WithOptionalLsl12(rhs)) {
      const immediate = immediateOf(rhs);
      if (immediate == null || immediate < 0n || immediate > 0xfffn) return `arm64-${mnemonic}-immediate-out-of-range`;
      return `arm64-${mnemonic}-immediate-shift-unencodable`;
    }
    return null;
  }
  const immediate = immediateOf(rhs);
  if (immediate == null || immediate < 0n || immediate > 31n) return `arm64-${mnemonic}-immediate-out-of-range`;
  if (rhs.shift != null) return `arm64-${mnemonic}-immediate-shift-unencodable`;
  return null;
}

function logicalEncodingFailure(instruction) {
  const mnemonic = instructionMnemonic(instruction);
  if (!ARM64_LOGICAL_IMMEDIATE_MNEMONICS.has(mnemonic)) return null;
  const ops = Array.isArray(instruction?.ops) ? instruction.ops : [];
  const rhs = mnemonic === 'tst' ? ops[1] : ops[2];
  if (rhs?.k !== 'imm') return null;
  const widthBits = Number(ops[0]?.bits || 0);
  return logicalImmediateEncodable(rhs, widthBits) ? null : `arm64-${mnemonic}-logical-immediate-unencodable`;
}

function literalMemoryEncodingFailure(instruction) {
  const mnemonic = instructionMnemonic(instruction);
  if (!ARM64_LITERAL_MEMORY_MNEMONICS.has(mnemonic)) return null;
  const ops = Array.isArray(instruction?.ops) ? instruction.ops : [];
  if (ops.some((op) => op?.k === 'mem' || op?.kind === 'memory')) return null;
  const immediate = ops.find((op) => op?.k === 'imm' || op?.kind === 'immediate');
  const target = asBigIntOrNull(instruction?.pcRelTarget ?? instruction?.literalTarget ?? immediateOf(immediate));
  if (target == null) return null; // The memory family already fails closed unresolved literal targets.
  const address = asBigIntOrNull(instruction?.address);
  if (address == null) return `arm64-${mnemonic}-literal-address-unavailable-for-encoding`;
  if ((target & 3n) !== 0n) return `arm64-${mnemonic}-literal-target-misaligned-encoding`;
  const displacement = target - address;
  if (displacement < -(1n << 20n) || displacement > (1n << 20n) - 4n) {
    return `arm64-${mnemonic}-literal-target-out-of-range-encoding`;
  }
  return null;
}

function unaryEncodingFailure(instruction) {
  const mnemonic = instructionMnemonic(instruction);
  if (mnemonic !== 'rev32') return null;
  const ops = Array.isArray(instruction?.ops) ? instruction.ops : [];
  if (ops[0]?.k === 'reg' && ops[0].bits !== 64) return 'arm64-rev32-destination-width-unencodable';
  if (ops[1]?.k === 'reg' && ops[1].bits !== 64) return 'arm64-rev32-source-width-unencodable';
  return null;
}

function structuredEncodingFailure(instruction) {
  return addSubImmediateEncodingFailure(instruction)
    || flagEncodingFailure(instruction)
    || logicalEncodingFailure(instruction)
    || literalMemoryEncodingFailure(instruction)
    || unaryEncodingFailure(instruction);
}

function normalizedInstruction(decoded, context) {
  if (!decoded || typeof decoded !== 'object') throw new TypeError('arm64-decoded-instruction-required');
  const instructionId = decoded.instructionId ?? context?.instructionId;
  const origin = decoded.origin ?? context?.origin;
  const mode = decoded.mode ?? context?.mode;
  const mnemonic = instructionMnemonic(decoded);
  const operands = Array.isArray(decoded.ops) ? decoded.ops : Array.isArray(decoded.operands) ? decoded.operands : [];
  const adrImmediate = operands.length > 1 ? immediateOf(operands[1]) : null;
  const normalizedPcRelTarget = (mnemonic === 'adr' || mnemonic === 'adrp') && decoded.pcRelTarget == null
    ? (adrImmediate ?? directTargetOf(decoded))
    : decoded.pcRelTarget;
  if (instructionId == null && origin == null && mode == null && normalizedPcRelTarget === decoded.pcRelTarget) return decoded;
  return {
    ...decoded,
    ...(instructionId == null ? {} : { instructionId }),
    ...(origin == null ? {} : { origin }),
    ...(mode == null ? {} : { mode }),
    ...(normalizedPcRelTarget == null ? {} : { pcRelTarget: normalizedPcRelTarget }),
  };
}

function normalizedContext(context = {}) {
  const machineEffectsOptions = context.machineEffectsOptions ?? context.options ?? {};
  return { ...context, ...machineEffectsOptions, options: machineEffectsOptions, machineEffectsOptions };
}

export function liftArm64MachineEffects(decoded, context = {}) {
  const instruction = normalizedInstruction(decoded, context);
  const familyContext = normalizedContext(context);
  const encodingFailure = structuredEncodingFailure(instruction);
  if (encodingFailure) {
    const partial = createArm64EffectContext(instruction, familyContext).partial(encodingFailure, ['registers','flags','memory','other']);
    return decorateArm64BtiGuardedPageEffects(instruction, partial, familyContext);
  }
  for (const family of ARM64_EFFECT_FAMILIES) {
    const result = family.lift(instruction, familyContext);
    if (result != null) return decorateArm64BtiGuardedPageEffects(instruction, result, familyContext);
  }
  return null;
}

export function arm64MachineEffectFamilies() {
  return Object.freeze(ARM64_EFFECT_FAMILIES.map(({ id }) => id));
}

export const liftExact = liftArm64MachineEffects;
