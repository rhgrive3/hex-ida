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

// This order is part of the Phase 2 semantic contract. Shape-sensitive families
// precede scalar families when A64 reuses a mnemonic (for example ADD/MOV in
// SIMD versus integer code). They must return null when the operand shape is not
// theirs. Memory intentionally precedes system so DMB/DSB/ISB/CLREX have one
// canonical implementation: the atomic/memory model, which validates barrier
// options and models exclusive-monitor state.
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

function validImm12WithOptionalLsl12(op) {
  if (op?.k !== 'imm') return true;
  const immediate = immediateOf(op);
  if (immediate == null || immediate < 0n || immediate > 0xfffn) return false;
  if (op.shift == null) return true;
  return String(op.shift.op || '').toLowerCase() === 'lsl' && Number(op.shift.amount) === 12;
}

function addSubImmediateEncodingFailure(instruction) {
  const mnemonic = instructionMnemonic(instruction);
  if (!ARM64_ADD_SUB_FAMILY_MNEMONICS.has(mnemonic)) return null;
  const ops = Array.isArray(instruction?.ops) ? instruction.ops : [];
  const alias = ['neg','negs','ngc','ngcs'].includes(mnemonic);
  const lhs = alias ? null : ops[1];
  const rhs = alias ? ops[1] : ops[2];

  // Only ADD/ADDS/SUB/SUBS have an A64 immediate form. Carry forms and the
  // NEG/NGC aliases are register-only, so a structured immediate must never be
  // promoted to exact semantics by the generic operand reader.
  if (rhs?.k === 'imm' && !ARM64_ADD_SUB_IMMEDIATE_MNEMONICS.has(mnemonic)) {
    return `arm64-${mnemonic}-immediate-form-unencodable`;
  }
  // The first source of the three-operand forms is always a register/SP view.
  if (lhs?.k === 'imm') return `arm64-${mnemonic}-lhs-immediate-unencodable`;

  // A64 add/sub shifted-register encodings reserve shift=3 (ROR). The generic
  // operand modifier supports ROR for instructions that genuinely encode it,
  // so reject it at this mnemonic-specific boundary before semantic lifting.
  if (rhs?.k === 'reg' && String(rhs.shift?.op || '').toLowerCase() === 'ror') {
    return `arm64-${mnemonic}-ror-shift-unencodable`;
  }
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
    || unaryEncodingFailure(instruction);
}

function normalizedInstruction(decoded, context) {
  if (!decoded || typeof decoded !== 'object') throw new TypeError('arm64-decoded-instruction-required');
  const instructionId = decoded.instructionId ?? context?.instructionId;
  const origin = decoded.origin ?? context?.origin;
  const mode = decoded.mode ?? context?.mode;
  const mnemonic = instructionMnemonic(decoded);
  // Current decoded-model producers are allowed to carry ADR/ADRP's resolved
  // absolute target either in pcRelTarget or in the already-decoded immediate
  // operand. Normalize those architecture-layer representations before
  // MachineEffects are created, so generic Semantic IR/SSA consumers never need
  // to inspect instruction text or reconstruct PC-relative semantics.
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
  return {
    ...context,
    ...machineEffectsOptions,
    options: machineEffectsOptions,
    machineEffectsOptions,
  };
}

export function liftArm64MachineEffects(decoded, context = {}) {
  const instruction = normalizedInstruction(decoded, context);
  const familyContext = normalizedContext(context);
  const encodingFailure = structuredEncodingFailure(instruction);
  if (encodingFailure) {
    const partial = createArm64EffectContext(instruction, familyContext).partial(
      encodingFailure,
      ['registers','flags','other'],
    );
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
