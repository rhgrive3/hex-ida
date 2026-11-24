import { decorateArm64BtiGuardedPageEffects } from './bti-guard-state.js';
import { liftArm64ControlEffects } from './control.js';
import { adrTargetOperandValue, canonicalAddressValue, canonicalArm64InstructionAddress, canonicalArm64TargetAddress, createArm64EffectContext, directTargetOf, immediateOf, instructionMnemonic, numericOtherTargetValue } from './common.js';
import { liftArm64FlagEffects } from './flags.js';
import { liftArm64FpEffects } from './fp.js';
import { liftArm64IntegerEffects } from './integer.js';
import { liftArm64MemoryEffects } from './memory.js';
import { liftArm64SimdEffects } from './simd.js';
import { liftArm64SystemEffects } from './system.js';

export const ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION = '8';

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
const ARM64_ADD_SUB_ALIAS_MNEMONICS = Object.freeze(new Set(['neg','negs','ngc','ngcs']));
const ARM64_CARRY_MNEMONICS = Object.freeze(new Set(['adc','adcs','sbc','sbcs']));
const ARM64_NGC_MNEMONICS = Object.freeze(new Set(['ngc','ngcs']));
const ARM64_ADD_SUB_FAMILY_MNEMONICS = Object.freeze(new Set([
  ...ARM64_ADD_SUB_IMMEDIATE_MNEMONICS,
  ...ARM64_CARRY_MNEMONICS,
  ...ARM64_ADD_SUB_ALIAS_MNEMONICS,
]));
const ARM64_FLAG_IMMEDIATE_MNEMONICS = Object.freeze(new Set(['cmp','cmn','ccmp','ccmn']));
const ARM64_LOGICAL_IMMEDIATE_MNEMONICS = Object.freeze(new Set(['and','ands','orr','eor','tst']));
const ARM64_LOGICAL_REGISTER_ONLY_MNEMONICS = Object.freeze(new Set(['bic','bics','orn','eon']));
const ARM64_LOGICAL_SHIFT_KINDS = Object.freeze(new Set(['lsl','lsr','asr','ror']));
const ARM64_LITERAL_MEMORY_MNEMONICS = Object.freeze(new Set(['ldr','ldrsw','prfm']));
const ARM64_MULDIV_4OP_MNEMONICS = Object.freeze(new Set(['madd','msub','smaddl','smsubl','umaddl','umsubl']));
const ARM64_MULDIV_SAME_WIDTH_MNEMONICS = Object.freeze(new Set(['mul','mneg','sdiv','udiv','madd','msub']));
const ARM64_MULDIV_LONG_3OP_MNEMONICS = Object.freeze(new Set(['smull','umull','smnegl','umnegl']));
const ARM64_MULDIV_HIGH_MNEMONICS = Object.freeze(new Set(['smulh','umulh']));
const ARM64_MULTIPLY_DIVIDE_MNEMONICS = Object.freeze(new Set([
  'mul','mneg','smull','umull','smulh','umulh','sdiv','udiv',
  'madd','msub','smaddl','smsubl','umaddl','umsubl','smnegl','umnegl',
]));
const ARM64_CONDITIONAL_TWO_SOURCE = Object.freeze(new Set(['csel','csinc','csinv','csneg']));
const ARM64_CONDITIONAL_ONE_SOURCE = Object.freeze(new Set(['cinc','cneg','cinv']));
const ARM64_UNARY_REGISTER_MNEMONICS = Object.freeze(new Set([
  'sxtb','sxth','sxtw','uxtb','uxth','uxtw','clz','rbit','rev','rev16','rev32','abs',
]));
const ARM64_SHIFT_IMMEDIATE_MNEMONICS = Object.freeze(new Set(['lsl','lsr','asr','ror']));
const ARM64_SHIFT_MNEMONICS = Object.freeze(new Set(['lsl','lslv','lsr','lsrv','asr','asrv','ror','rorv']));
const ARM64_VARIABLE_SHIFT_MNEMONICS = Object.freeze(new Set(['lslv','lsrv','asrv','rorv']));
const ARM64_BITFIELD_4OP_MNEMONICS = Object.freeze(new Set(['ubfm','sbfm','bfm','ubfx','sbfx','ubfiz','sbfiz','bfxil','bfi']));
const ARM64_BITFIELD_MNEMONICS = Object.freeze(new Set(['ubfm','sbfm','bfm','ubfx','sbfx','ubfiz','sbfiz','bfxil','bfi','bfc']));

function validImm12WithOptionalLsl12(op) {
  if (op?.k !== 'imm') return true;
  if (op.extend != null) return false;
  const immediate = immediateOf(op);
  if (immediate == null || immediate < 0n || immediate > 0xfffn) return false;
  if (op.shift == null) return true;
  return typeof op.shift.op === 'string'
    && op.shift.op.toLowerCase() === 'lsl'
    && typeof op.shift.amount === 'number'
    && Number.isInteger(op.shift.amount)
    && (op.shift.amount === 0 || op.shift.amount === 12);
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
        masks.add(replicateElement(rotateRightElement(base, rotation, elementBits), elementBits, widthBits));
      }
    }
  }
  return masks;
}

let logicalMasks32 = null;
let logicalMasks64 = null;

function getLogicalImmediateMasks(widthBits) {
  if (widthBits === 32) {
    if (logicalMasks32 === null) logicalMasks32 = buildLogicalImmediateMasks(32);
    return logicalMasks32;
  }
  if (logicalMasks64 === null) logicalMasks64 = buildLogicalImmediateMasks(64);
  return logicalMasks64;
}

function logicalImmediateEncodable(op, widthBits) {
  if (op?.k !== 'imm' || (widthBits !== 32 && widthBits !== 64) || op.shift != null || op.extend != null) return false;
  const immediate = immediateOf(op);
  if (immediate == null) return false;
  return getLogicalImmediateMasks(widthBits).has(BigInt.asUintN(widthBits, immediate));
}

function singleWideMoveEncodable(pattern, widthBits) {
  const value = BigInt.asUintN(widthBits, pattern);
  const widthMask = (1n << BigInt(widthBits)) - 1n;
  for (let shift = 0; shift < widthBits; shift += 16) {
    const laneMask = 0xffffn << BigInt(shift);
    if ((value & (widthMask ^ laneMask)) === 0n) return true;
    const inverted = (~value) & widthMask;
    if ((inverted & (widthMask ^ laneMask)) === 0n) return true;
  }
  return false;
}

function movImmediateEncodable(op, widthBits) {
  if (op?.k !== 'imm' || (widthBits !== 32 && widthBits !== 64) || op.shift != null || op.extend != null) return false;
  const immediate = immediateOf(op);
  if (immediate == null) return false;
  const pattern = BigInt.asUintN(widthBits, immediate);
  return singleWideMoveEncodable(pattern, widthBits) || getLogicalImmediateMasks(widthBits).has(pattern);
}

function asBigIntOrNull(value) {
  return canonicalAddressValue(value);
}

function isGpOrZrRegister(operand) {
  if (operand?.k !== 'reg' || typeof operand.cls !== 'string') return false;
  const cls = operand.cls.toLowerCase();
  return cls === 'gp' || cls === 'zr';
}

function isPlainGpSource(operand) {
  return isGpOrZrRegister(operand) && operand.shift == null && operand.extend == null;
}

function structuredRegisterWidth(operand) {
  const bits = operand?.bits;
  return typeof bits === 'number' && Number.isInteger(bits) && (bits === 32 || bits === 64) ? bits : 0;
}

function isPlainGpSourceOfWidth(operand, widthBits) {
  return isPlainGpSource(operand) && structuredRegisterWidth(operand) === widthBits;
}

function isGpSourceOfWidth(operand, widthBits) {
  return isGpOrZrRegister(operand) && structuredRegisterWidth(operand) === widthBits;
}

function isLogicalShiftedGpSource(operand, widthBits) {
  if (!isGpOrZrRegister(operand) || structuredRegisterWidth(operand) !== widthBits || operand.extend != null) return false;
  if (operand.shift == null) return true;
  if (typeof operand.shift.op !== 'string') return false;
  const kind = operand.shift.op.toLowerCase();
  const amount = operand.shift.amount ?? 0;
  return ARM64_LOGICAL_SHIFT_KINDS.has(kind)
    && typeof amount === 'number' && Number.isInteger(amount) && amount >= 0 && amount < widthBits;
}

function addSubImmediateEncodingFailure(instruction, mnemonic) {
  if (!ARM64_ADD_SUB_FAMILY_MNEMONICS.has(mnemonic)) return null;
  const ops = Array.isArray(instruction?.ops) ? instruction.ops : [];
  if (!isGpOrZrRegister(ops[0])) return null;
  const alias = ARM64_ADD_SUB_ALIAS_MNEMONICS.has(mnemonic);
  const expectedOperandCount = alias ? 2 : 3;
  if (ops.length !== expectedOperandCount) return `arm64-${mnemonic}-operand-shape-unencodable`;
  const lhs = alias ? null : ops[1];
  const rhs = alias ? ops[1] : ops[2];
  if (rhs?.k === 'imm' && !ARM64_ADD_SUB_IMMEDIATE_MNEMONICS.has(mnemonic)) return `arm64-${mnemonic}-immediate-form-unencodable`;
  const widthBits = structuredRegisterWidth(ops[0]);
  if (ARM64_CARRY_MNEMONICS.has(mnemonic)) {
    if (!isGpSourceOfWidth(lhs, widthBits) || !isGpSourceOfWidth(rhs, widthBits)) return `arm64-${mnemonic}-register-width-unencodable`;
    if (!isPlainGpSource(lhs) || !isPlainGpSource(rhs)) return `arm64-${mnemonic}-register-modifier-unencodable`;
  } else if (alias && !isGpSourceOfWidth(rhs, widthBits)) {
    return `arm64-${mnemonic}-register-width-unencodable`;
  } else if (ARM64_NGC_MNEMONICS.has(mnemonic) && !isPlainGpSource(rhs)) {
    return `arm64-${mnemonic}-register-modifier-unencodable`;
  }
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

function flagEncodingFailure(instruction, mnemonic) {
  if (!ARM64_FLAG_IMMEDIATE_MNEMONICS.has(mnemonic)) return null;
  const ops = Array.isArray(instruction?.ops) ? instruction.ops : [];
  if (!isGpOrZrRegister(ops[0])) return null;
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

function logicalEncodingFailure(instruction, mnemonic) {
  const isImmediateCapable = ARM64_LOGICAL_IMMEDIATE_MNEMONICS.has(mnemonic);
  const isRegisterOnly = ARM64_LOGICAL_REGISTER_ONLY_MNEMONICS.has(mnemonic) || mnemonic === 'mvn';
  if (!isImmediateCapable && !isRegisterOnly) return null;
  const ops = Array.isArray(instruction?.ops) ? instruction.ops : [];
  if (!isGpOrZrRegister(ops[0])) {
    if (mnemonic === 'tst' && ops[0]?.k !== 'reg') return 'arm64-tst-lhs-register-required';
    return null;
  }
  const expectedOperandCount = mnemonic === 'mvn' || mnemonic === 'tst' ? 2 : 3;
  if (ops.length !== expectedOperandCount) {
    if (mnemonic === 'tst' && ops.length < expectedOperandCount) return 'arm64-tst-rhs-register-required';
    return `arm64-${mnemonic}-operand-shape-unencodable`;
  }
  const widthBits = structuredRegisterWidth(ops[0]);
  if (widthBits !== 32 && widthBits !== 64) return `arm64-${mnemonic}-width-unencodable`;

  if (mnemonic === 'mvn') {
    return isLogicalShiftedGpSource(ops[1], widthBits) ? null : 'arm64-mvn-source-register-required';
  }

  const lhs = mnemonic === 'tst' ? ops[0] : ops[1];
  const rhs = mnemonic === 'tst' ? ops[1] : ops[2];
  if (!isPlainGpSourceOfWidth(lhs, widthBits)) return `arm64-${mnemonic}-lhs-register-required`;

  if (rhs?.k === 'imm') {
    if (!isImmediateCapable || !logicalImmediateEncodable(rhs, widthBits)) return `arm64-${mnemonic}-logical-immediate-unencodable`;
    return null;
  }
  return isLogicalShiftedGpSource(rhs, widthBits) ? null : `arm64-${mnemonic}-rhs-register-required`;
}

function multiplyDivideEncodingFailure(instruction, mnemonic) {
  if (!ARM64_MULTIPLY_DIVIDE_MNEMONICS.has(mnemonic)) return null;
  const ops = Array.isArray(instruction?.ops) ? instruction.ops : [];
  if (!isGpOrZrRegister(ops[0])) return null;
  const expectedOperandCount = ARM64_MULDIV_4OP_MNEMONICS.has(mnemonic) ? 4 : 3;
  if (ops.length !== expectedOperandCount) return `arm64-${mnemonic}-operand-shape-unencodable`;
  const destinationBits = structuredRegisterWidth(ops[0]);
  if (ARM64_MULDIV_SAME_WIDTH_MNEMONICS.has(mnemonic)) {
    for (let index = 1; index < ops.length; index++) {
      if (!isPlainGpSourceOfWidth(ops[index], destinationBits)) return `arm64-${mnemonic}-source-register-required`;
    }
    return null;
  }
  if (destinationBits !== 64) return `arm64-${mnemonic}-source-register-required`;
  if (ARM64_MULDIV_LONG_3OP_MNEMONICS.has(mnemonic)) {
    if (!isPlainGpSourceOfWidth(ops[1], 32) || !isPlainGpSourceOfWidth(ops[2], 32)) return `arm64-${mnemonic}-source-register-required`;
    return null;
  }
  if (ARM64_MULDIV_HIGH_MNEMONICS.has(mnemonic)) {
    if (!isPlainGpSourceOfWidth(ops[1], 64) || !isPlainGpSourceOfWidth(ops[2], 64)) return `arm64-${mnemonic}-source-register-required`;
    return null;
  }
  if (!isPlainGpSourceOfWidth(ops[1], 32) || !isPlainGpSourceOfWidth(ops[2], 32) || !isPlainGpSourceOfWidth(ops[3], 64)) {
    return `arm64-${mnemonic}-source-register-required`;
  }
  return null;
}

function modifierFreeImmediate(op) {
  return op?.k === 'imm' && op.shift == null && op.extend == null;
}

function scalarImmediateModifierEncodingFailure(mnemonic, ops) {
  if (ARM64_SHIFT_IMMEDIATE_MNEMONICS.has(mnemonic) && ops[2]?.k === 'imm' && !modifierFreeImmediate(ops[2])) {
    return `arm64-${mnemonic}-immediate-modifier-unencodable`;
  }
  if (mnemonic === 'extr' && !modifierFreeImmediate(ops[3])) return 'arm64-extr-immediate-modifier-unencodable';
  if (ARM64_BITFIELD_4OP_MNEMONICS.has(mnemonic)
    && (!modifierFreeImmediate(ops[2]) || !modifierFreeImmediate(ops[3]))) {
    return `arm64-${mnemonic}-immediate-modifier-unencodable`;
  }
  if (mnemonic === 'bfc' && (!modifierFreeImmediate(ops[1]) || !modifierFreeImmediate(ops[2]))) {
    return 'arm64-bfc-immediate-modifier-unencodable';
  }
  return null;
}

function bitfieldRegisterShapeEncodingFailure(mnemonic, ops) {
  if (!ARM64_BITFIELD_MNEMONICS.has(mnemonic)) return null;
  const destination = ops[0];
  const widthBits = Number(destination?.bits || 0);
  if (!isGpOrZrRegister(destination) || (widthBits !== 32 && widthBits !== 64)
    || destination.shift != null || destination.extend != null) {
    return `arm64-${mnemonic}-destination-register-unencodable`;
  }
  if (mnemonic === 'bfc') return null;
  return isPlainGpSourceOfWidth(ops[1], widthBits)
    ? null
    : `arm64-${mnemonic}-source-register-unencodable`;
}

function registerOnlyIntegerEncodingFailure(instruction, mnemonic) {
  const ops = Array.isArray(instruction?.ops) ? instruction.ops : [];
  const immediateFailure = scalarImmediateModifierEncodingFailure(mnemonic, ops);
  if (immediateFailure) return immediateFailure;
  const bitfieldFailure = bitfieldRegisterShapeEncodingFailure(mnemonic, ops);
  if (bitfieldFailure) return bitfieldFailure;
  if (!isGpOrZrRegister(ops[0])) return null;
  const widthBits = structuredRegisterWidth(ops[0]);
  if (mnemonic === 'extr' || ARM64_CONDITIONAL_TWO_SOURCE.has(mnemonic)) {
    if (!isPlainGpSourceOfWidth(ops[1], widthBits) || !isPlainGpSourceOfWidth(ops[2], widthBits)) {
      return `arm64-${mnemonic}-source-register-required`;
    }
  } else if (ARM64_CONDITIONAL_ONE_SOURCE.has(mnemonic)) {
    if (!isPlainGpSourceOfWidth(ops[1], widthBits)) return `arm64-${mnemonic}-source-register-required`;
  } else if (ARM64_UNARY_REGISTER_MNEMONICS.has(mnemonic)) {
    if (!isPlainGpSource(ops[1])) return `arm64-${mnemonic}-source-register-required`;
  }
  if (!ARM64_SHIFT_MNEMONICS.has(mnemonic)) return null;
  if (!isPlainGpSourceOfWidth(ops[1], widthBits)) return `arm64-${mnemonic}-source-register-required`;
  if (ARM64_VARIABLE_SHIFT_MNEMONICS.has(mnemonic) && !isPlainGpSourceOfWidth(ops[2], widthBits)) return `arm64-${mnemonic}-shift-register-required`;
  return null;
}

function moveEncodingFailure(instruction, mnemonic) {
  if (mnemonic !== 'mov') return null;
  const ops = Array.isArray(instruction?.ops) ? instruction.ops : [];
  if (!isGpOrZrRegister(ops[0])) return null;
  const source = ops[1];
  if (source?.k !== 'imm') return null;
  const widthBits = structuredRegisterWidth(ops[0]);
  return movImmediateEncodable(source, widthBits) ? null : 'arm64-mov-immediate-unencodable';
}

function prefetchOperandShapeEncodingFailure(instruction, mnemonic) {
  if (mnemonic !== 'prfm' && mnemonic !== 'prfum') return null;
  const ops = Array.isArray(instruction?.ops) ? instruction.ops : [];
  const hasPrintedSpecifier = ops[0]?.k === 'other';
  const addressIndex = hasPrintedSpecifier ? 1 : 0;
  if (ops.length !== addressIndex + 1) return `arm64-${mnemonic}-operand-shape-unencodable`;
  const address = ops[addressIndex];
  if (address?.k === 'mem' || address?.kind === 'memory') return null;
  if (mnemonic === 'prfm' && (address?.k === 'imm' || address?.kind === 'immediate')) return null;
  return `arm64-${mnemonic}-operand-shape-unencodable`;
}

function literalMemoryEncodingFailure(instruction, mnemonic) {
  if (!ARM64_LITERAL_MEMORY_MNEMONICS.has(mnemonic)) return null;
  const ops = Array.isArray(instruction?.ops) ? instruction.ops : [];
  if (ops.some((op) => op?.k === 'mem' || op?.kind === 'memory')) return null;
  const immediate = ops.find((op) => op?.k === 'imm' || op?.kind === 'immediate');
  const target = asBigIntOrNull(instruction?.pcRelTarget ?? instruction?.literalTarget ?? immediateOf(immediate));
  if (target == null) return null;
  const address = canonicalArm64InstructionAddress(instruction?.address);
  if (address == null) return `arm64-${mnemonic}-literal-address-unavailable-for-encoding`;
  if ((target & 3n) !== 0n) return `arm64-${mnemonic}-literal-target-misaligned-encoding`;
  // Literal PC-relative offsets are SignExtend(imm19:'00', 64) added to the
  // 64-bit PC: valid encodings may wrap the 64-bit address boundary, so the
  // architectural displacement is the modulo-2^64 signed difference, not the
  // raw BigInt subtraction.
  const displacement = BigInt.asIntN(64, target - address);
  if (displacement < -(1n << 20n) || displacement > (1n << 20n) - 4n) return `arm64-${mnemonic}-literal-target-out-of-range-encoding`;
  return null;
}

function unaryEncodingFailure(instruction, mnemonic) {
  if (mnemonic !== 'rev32') return null;
  const ops = Array.isArray(instruction?.ops) ? instruction.ops : [];
  if (!isGpOrZrRegister(ops[0])) return null;
  if (ops[0]?.k === 'reg' && ops[0].bits !== 64) return 'arm64-rev32-destination-width-unencodable';
  if (ops[1]?.k === 'reg' && ops[1].bits !== 64) return 'arm64-rev32-source-width-unencodable';
  return null;
}

const SIGNED_IMM21_MIN = -(1n << 20n);
const SIGNED_IMM21_MAX = (1n << 20n) - 1n;
const A64_PAGE_BYTES = 4096n;

function addressImmediateEncodingFailure(instruction, mnemonic) {
  if (mnemonic !== 'adr' && mnemonic !== 'adrp') return null;
  const ops = Array.isArray(instruction?.ops) ? instruction.ops : [];
  if (ops.length !== 2) return `arm64-${mnemonic}-operand-shape-unencodable`;
  const destination = ops[0];
  const targetOperand = ops[1];
  if (!isGpOrZrRegister(destination) || Number(destination.bits) !== 64
    || destination.shift != null || destination.extend != null) {
    return `arm64-${mnemonic}-destination-unencodable`;
  }
  if ((targetOperand?.k !== 'imm' && targetOperand?.k !== 'other')
    || targetOperand?.shift != null || targetOperand?.extend != null) {
    return `arm64-${mnemonic}-target-operand-unencodable`;
  }
  const address = canonicalArm64InstructionAddress(instruction?.address);
  const target = canonicalArm64TargetAddress(instruction?.pcRelTarget);
  if (address == null || target == null) return `arm64-${mnemonic}-encoding-address-unavailable`;
  if (targetOperand?.k === 'imm' && canonicalArm64TargetAddress(targetOperand.value) !== target) {
    return `arm64-${mnemonic}-target-evidence-mismatch`;
  }
  if (targetOperand?.k === 'other') {
    const otherValue = numericOtherTargetValue(targetOperand);
    if (otherValue != null && canonicalArm64TargetAddress(otherValue) !== target) return `arm64-${mnemonic}-target-evidence-mismatch`;
  }

  if (mnemonic === 'adr') {
    const delta = BigInt.asIntN(64, target - address);
    return delta < SIGNED_IMM21_MIN || delta > SIGNED_IMM21_MAX
      ? 'arm64-adr-target-out-of-encoding-range'
      : null;
  }
  if ((target & (A64_PAGE_BYTES - 1n)) !== 0n) return 'arm64-adrp-target-not-page-aligned';
  const pageBase = address & ~(A64_PAGE_BYTES - 1n);
  const pageDelta = BigInt.asIntN(64, target - pageBase) / A64_PAGE_BYTES;
  return pageDelta < SIGNED_IMM21_MIN || pageDelta > SIGNED_IMM21_MAX
    ? 'arm64-adrp-target-out-of-encoding-range'
    : null;
}

const VALIDATORS_BY_MNEMONIC = new Map();
function registerValidators(mnemonics, validator) {
  for (const mnemonic of mnemonics) {
    let list = VALIDATORS_BY_MNEMONIC.get(mnemonic);
    if (!list) {
      list = [];
      VALIDATORS_BY_MNEMONIC.set(mnemonic, list);
    }
    if (!list.includes(validator)) list.push(validator);
  }
}

// Register in the exact original evaluation order of structuredEncodingFailure.
registerValidators(['adr', 'adrp'], addressImmediateEncodingFailure);
registerValidators(ARM64_ADD_SUB_FAMILY_MNEMONICS, addSubImmediateEncodingFailure);
registerValidators(ARM64_FLAG_IMMEDIATE_MNEMONICS, flagEncodingFailure);
registerValidators(ARM64_LOGICAL_IMMEDIATE_MNEMONICS, logicalEncodingFailure);
registerValidators(ARM64_LOGICAL_REGISTER_ONLY_MNEMONICS, logicalEncodingFailure);
registerValidators(['mvn'], logicalEncodingFailure);
registerValidators(ARM64_MULTIPLY_DIVIDE_MNEMONICS, multiplyDivideEncodingFailure);
registerValidators([
  'extr',
  ...ARM64_BITFIELD_MNEMONICS,
  ...ARM64_CONDITIONAL_TWO_SOURCE,
  ...ARM64_CONDITIONAL_ONE_SOURCE,
  ...ARM64_UNARY_REGISTER_MNEMONICS,
  ...ARM64_SHIFT_MNEMONICS,
], registerOnlyIntegerEncodingFailure);
registerValidators(['mov'], moveEncodingFailure);
registerValidators(['prfm', 'prfum'], prefetchOperandShapeEncodingFailure);
registerValidators(ARM64_LITERAL_MEMORY_MNEMONICS, literalMemoryEncodingFailure);
registerValidators(['rev32'], unaryEncodingFailure);

// Strictly non-overlapping mnemonic -> family direct dispatch table.
// Any mnemonic that can be claimed by multiple families (e.g. add/sub/mov/and/
// orr/eor/bic/mvn/neg/mul/abs/clz/rbit/rev/smull/umull shared with SIMD) is
// intentionally omitted and falls through to ARM64_EFFECT_FAMILIES in order.
const UNIQUE_FAMILY_BY_MNEMONIC = new Map();
function registerUniqueFamily(mnemonics, lift) {
  for (const mnemonic of mnemonics) UNIQUE_FAMILY_BY_MNEMONIC.set(mnemonic, lift);
}
registerUniqueFamily(['cmp','cmn','ccmp','ccmn','tst'], liftArm64FlagEffects);
registerUniqueFamily(['b','bl','br','blr','ret','cbz','cbnz','tbz','tbnz'], liftArm64ControlEffects);
registerUniqueFamily([
  'ldr','ldrb','ldrh','ldrsb','ldrsh','ldrsw','ldur','ldurb','ldurh','ldursb','ldursh','ldursw',
  'ldp','ldpsw','ldnp','ldar','ldarb','ldarh',
  'str','strb','strh','stur','sturb','sturh','stp','stnp','stlr','stlrb','stlrh',
  'prfm','prfum',
], liftArm64MemoryEffects);
registerUniqueFamily([
  'movz','movk','movn','adr','adrp',
  'csel','csinc','csinv','csneg','cset','csetm','cinc','cinv','cneg',
  'sdiv','udiv','madd','msub','smaddl','smsubl','umaddl','umsubl','smulh','umulh',
  'ubfm','sbfm','bfm','ubfx','sbfx','ubfiz','sbfiz','bfxil','bfi','bfc','extr',
  'lsl','lsr','asr','ror','lslv','lsrv','asrv','rorv',
  'sxtb','sxth','sxtw','uxtb','uxth','uxtw','rev16','rev32',
  'adc','adcs','sbc','sbcs','adds','subs','ands','bics','negs','ngc','ngcs',
], liftArm64IntegerEffects);

function structuredEncodingFailure(instruction, mnemonic) {
  const validators = VALIDATORS_BY_MNEMONIC.get(mnemonic);
  if (!validators) return null;
  for (let i = 0; i < validators.length; i++) {
    const failure = validators[i](instruction, mnemonic);
    if (failure) return failure;
  }
  return null;
}

function normalizedInstruction(decoded, context) {
  if (!decoded || typeof decoded !== 'object') throw new TypeError('arm64-decoded-instruction-required');
  const instructionId = decoded.instructionId ?? context?.instructionId;
  const origin = decoded.origin ?? context?.origin;
  const mode = decoded.mode ?? context?.mode;
  const mnemonic = instructionMnemonic(decoded);
  const operands = Array.isArray(decoded.ops) ? decoded.ops : Array.isArray(decoded.operands) ? decoded.operands : [];
  const adrImmediate = operands.length > 1 ? adrTargetOperandValue(operands[1]) : null;
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
  return { ...machineEffectsOptions, ...context, options: machineEffectsOptions, machineEffectsOptions };
}

export function liftArm64MachineEffects(decoded, context = {}) {
  const instruction = normalizedInstruction(decoded, context);
  const familyContext = normalizedContext(context);
  const mnemonic = instructionMnemonic(instruction);
  const encodingFailure = structuredEncodingFailure(instruction, mnemonic);
  if (encodingFailure) {
    const partial = createArm64EffectContext(instruction, familyContext).partial(encodingFailure, ['registers','flags','memory','other']);
    return decorateArm64BtiGuardedPageEffects(instruction, partial, familyContext);
  }
  const directLift = UNIQUE_FAMILY_BY_MNEMONIC.get(mnemonic);
  if (directLift) {
    const result = directLift(instruction, familyContext);
    if (result != null) return decorateArm64BtiGuardedPageEffects(instruction, result, familyContext);
  }
  for (const family of ARM64_EFFECT_FAMILIES) {
    if (family.lift === directLift) continue;
    const result = family.lift(instruction, familyContext);
    if (result != null) return decorateArm64BtiGuardedPageEffects(instruction, result, familyContext);
  }
  return null;
}

export function arm64MachineEffectFamilies() {
  return Object.freeze(ARM64_EFFECT_FAMILIES.map(({ id }) => id));
}

export const liftExact = liftArm64MachineEffects;
