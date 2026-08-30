import {
  ARM64_INSTRUCTION_BYTES,
  createArm64EffectContext,
  directTargetOf,
  immediateOf,
  instructionBits,
} from './common.js';
import { decorateArm64BtypeEffects } from './btype.js';
import { emitArm64Condition } from './flags.js';

const DIRECT_BRANCH = new Set(['b','bl']);
const INDIRECT_BRANCH = new Set(['br','blr']);
const COMPARE_BRANCH = new Set(['cbz','cbnz']);
const TEST_BRANCH = new Set(['tbz','tbnz']);

export function isArm64ControlEffectMnemonic(mnemonic) {
  const base = String(mnemonic || '').toLowerCase();
  return DIRECT_BRANCH.has(base) || INDIRECT_BRANCH.has(base) || COMPARE_BRANCH.has(base)
    || TEST_BRANCH.has(base) || base === 'ret' || /^b\.(?:eq|ne|cs|hs|cc|lo|mi|pl|vs|vc|hi|ls|ge|lt|gt|le|al|nv)$/.test(base);
}

function addressRef(address) {
  return { kind: 'absolute-address', value: BigInt(address).toString(), widthBits: 64 };
}

function instructionAddress(instruction) {
  try { return instruction?.address == null ? null : BigInt(instruction.address); }
  catch { return null; }
}

function fallthroughRef(instruction) {
  const address = instructionAddress(instruction);
  return address == null ? null : addressRef(address + ARM64_INSTRUCTION_BYTES);
}

function sameAbsoluteTarget(target, reference) {
  if (target == null || reference?.kind !== 'absolute-address' || reference.value == null) return false;
  try { return BigInt(target) === BigInt(reference.value); }
  catch { return false; }
}

function isAlignedDirectTarget(target) {
  try { return (BigInt(target) & 3n) === 0n; }
  catch { return false; }
}

function directBranchDisplacementBits(mnemonic) {
  if (mnemonic === 'b' || mnemonic === 'bl') return 26;
  if (COMPARE_BRANCH.has(mnemonic) || /^b\./.test(mnemonic)) return 19;
  if (TEST_BRANCH.has(mnemonic)) return 14;
  return null;
}

function directBranchEncodingStatus(instruction, target, mnemonic) {
  const address = instructionAddress(instruction);
  if (address == null) return { valid:false, reason:`arm64-${mnemonic}-address-unavailable-for-encoding` };
  let destination;
  try { destination = BigInt(target); }
  catch { return { valid:false, reason:`arm64-${mnemonic}-target-unavailable` }; }
  if ((destination & 3n) !== 0n) return { valid:false, reason:`arm64-${mnemonic}-target-misaligned-encoding` };
  const bits = directBranchDisplacementBits(mnemonic);
  if (!bits) return { valid:true };
  // Disassembler targets may be sign-extended 64-bit addresses for backward
  // branches. Compare the architectural modulo-64-bit displacement rather
  // than treating that representation as an unrelated high positive address.
  const displacement = BigInt.asIntN(64, destination - address);
  const minimum = -(1n << BigInt(bits + 1));
  const maximum = (1n << BigInt(bits + 1)) - 4n;
  if (displacement < minimum || displacement > maximum) {
    return { valid:false, reason:`arm64-${mnemonic}-target-out-of-range-encoding` };
  }
  return { valid:true };
}

/**
 * Preserve condition-evaluation operations even when both control outcomes land
 * in the same basic block, but canonicalize the externally visible control edge
 * to one unconditional branch. Semantic IR forbids duplicate node targets, and
 * two identical successors carry no conditional control distinction.
 */
function conditionalControlEffect(target, fallthrough, condition) {
  if (sameAbsoluteTarget(target, fallthrough)) {
    return { kind:'branch', target:addressRef(target) };
  }
  return { kind:'conditional-branch', target:addressRef(target), fallthrough, condition };
}

function targetAlignmentFault() {
  return {
    kind: 'pc-alignment-fault',
    condition: { kind: 'target-misaligned', alignmentBytes: 4 },
    detail: { architecture: 'arm64', instructionSet: 'a64' },
  };
}

function indirectTargetFaults(operand) {
  // The architectural zero register fixes the target to aligned address zero;
  // retaining a target-misaligned possibility for BR/BLR/RET XZR would be a
  // false fault in an otherwise exact encoding-family proof.
  return operand?.k === 'reg' && operand.cls === 'zr' ? [] : [targetAlignmentFault()];
}

function gpRegister(num) {
  return { k: 'reg', cls: 'gp', num, bits: 64, text: `x${num}` };
}

function hasValidControlRegisterNumber(operand) {
  if (!Number.isInteger(operand?.num) || operand.num < 0 || operand.num > 31) return false;
  if (operand.cls === 'zr') return operand.num === 31;
  return operand.cls === 'gp' && operand.num <= 30;
}

function isIndirectControlRegister(operand) {
  return operand?.k === 'reg'
    && (operand.cls === 'gp' || operand.cls === 'zr')
    && hasValidControlRegisterNumber(operand)
    && typeof operand.bits === 'number'
    && Number.isInteger(operand.bits)
    && operand.bits === 64
    && operand.shift == null
    && operand.extend == null;
}

function directTargetOperandShapeValid(instruction, operand, kind = 'branch') {
  if (operand?.shift != null || operand?.extend != null) return false;
  if (operand?.k === 'imm' && operand.value != null) return true;
  if (operand?.k === 'other' && /^#?(?:0x[0-9a-f]+|\d+)$/i.test(String(operand.text || '').trim())) return true;
  const explicit = kind === 'call' ? instruction?.callTarget : instruction?.branchTarget;
  return operand?.k === 'other' && explicit != null;
}

function isBranchTestRegister(operand) {
  return operand?.k === 'reg'
    && (operand.cls === 'gp' || operand.cls === 'zr')
    && hasValidControlRegisterNumber(operand)
    && typeof operand.bits === 'number'
    && Number.isInteger(operand.bits)
    && (operand.bits === 32 || operand.bits === 64)
    && operand.shift == null
    && operand.extend == null;
}

function directBranchOperandShapeValid(instruction, mnemonic, ops) {
  if (mnemonic === 'b' || /^b\./.test(mnemonic)) {
    return ops.length === 1 && directTargetOperandShapeValid(instruction, ops[0], 'branch');
  }
  if (mnemonic === 'bl') {
    return ops.length === 1 && directTargetOperandShapeValid(instruction, ops[0], 'call');
  }
  if (COMPARE_BRANCH.has(mnemonic)) {
    return ops.length === 2 && isBranchTestRegister(ops[0]) && directTargetOperandShapeValid(instruction, ops[1], 'branch');
  }
  if (TEST_BRANCH.has(mnemonic)) {
    const bit = immediateOf(ops[1]);
    const widthBits = instructionBits(ops[0]);
    return ops.length === 3 && isBranchTestRegister(ops[0])
      && ops[1]?.k === 'imm' && bit != null
      && bit >= 0n && bit < BigInt(widthBits)
      && ops[1].shift == null && ops[1].extend == null
      && directTargetOperandShapeValid(instruction, ops[2], 'branch');
  }
  return true;
}

function liftArm64ControlEffectsCore(instruction, options = {}) {
  const mnemonic = String(instruction?.mnemonic || '').toLowerCase();
  if (!isArm64ControlEffectMnemonic(mnemonic)) return null;
  const ctx = createArm64EffectContext(instruction, options);
  const ops = instruction?.ops || [];

  if (!directBranchOperandShapeValid(instruction, mnemonic, ops)) {
    const reason = `arm64-${mnemonic}-operand-shape-invalid`;
    return ctx.partial(reason, ['control','registers'], undefined, { kind:'unknown', reason });
  }

  if (mnemonic === 'b') {
    const target = directTargetOf(instruction, 'branch');
    if (target == null) return ctx.partial('arm64-b-target-unavailable', ['control'], undefined, { kind: 'unknown', reason: 'arm64-b-target-unavailable' });
    const encoding = directBranchEncodingStatus(instruction, target, mnemonic);
    if (!encoding.valid) return ctx.partial(encoding.reason, ['control'], undefined, { kind:'unknown', reason:encoding.reason });
    return ctx.finish({
      controlEffect: { kind: 'branch', target: addressRef(target) },
      metadata: { family: 'control', operation: 'b', direct: true },
    });
  }

  if (mnemonic === 'br') {
    if (ops.length !== 1 || !isIndirectControlRegister(ops[0])) {
      return ctx.partial('arm64-br-operand-shape-invalid', ['control','registers'], undefined, { kind:'unknown', reason:'arm64-br-operand-shape-invalid' });
    }
    const target = ctx.readRegister(ops[0]);
    if (!target) {
      return ctx.partial('arm64-br-target-register-unmodelled', ['control','registers'], undefined, { kind: 'unknown', reason: 'arm64-br-target-register-unmodelled' });
    }
    return ctx.finish({
      controlEffect: { kind: 'indirect', target },
      possibleFaults: indirectTargetFaults(ops[0]),
      metadata: { family: 'control', operation: 'br', indirect: true },
    });
  }

  if (mnemonic === 'bl') {
    const target = directTargetOf(instruction, 'call');
    if (target == null) return ctx.partial('arm64-bl-target-unavailable', ['control','registers'], undefined, { kind: 'unknown', reason: 'arm64-bl-target-unavailable' });
    const address = instructionAddress(instruction);
    if (address == null) {
      return ctx.partial('arm64-bl-link-address-unavailable', ['registers'], undefined, { kind: 'call', target: addressRef(target) });
    }
    const encoding = directBranchEncodingStatus(instruction, target, mnemonic);
    if (!encoding.valid) return ctx.partial(encoding.reason, ['control','registers'], undefined, { kind:'unknown', reason:encoding.reason });
    const fallthrough = fallthroughRef(instruction);
    ctx.writeRegister(gpRegister(30), ctx.constant(64, address + ARM64_INSTRUCTION_BYTES));
    return ctx.finish({
      controlEffect: { kind: 'call', target: addressRef(target), ...(fallthrough ? { fallthrough } : {}) },
      metadata: { family: 'control', operation: 'bl', direct: true, abiSemantics: false },
    });
  }

  if (mnemonic === 'blr') {
    if (ops.length !== 1 || !isIndirectControlRegister(ops[0])) {
      return ctx.partial('arm64-blr-operand-shape-invalid', ['control','registers'], undefined, { kind:'unknown', reason:'arm64-blr-operand-shape-invalid' });
    }
    const target = ctx.readRegister(ops[0]);
    const address = instructionAddress(instruction);
    if (!target) {
      return ctx.partial('arm64-blr-target-register-unmodelled', ['control','registers'], undefined, { kind: 'unknown', reason: 'arm64-blr-target-register-unmodelled' });
    }
    if (address == null) {
      return ctx.partial('arm64-blr-link-address-unavailable', ['registers'], undefined, { kind: 'call', target });
    }
    ctx.writeRegister(gpRegister(30), ctx.constant(64, address + ARM64_INSTRUCTION_BYTES));
    return ctx.finish({
      controlEffect: { kind: 'call', target, ...(fallthroughRef(instruction) ? { fallthrough: fallthroughRef(instruction) } : {}) },
      possibleFaults: indirectTargetFaults(ops[0]),
      metadata: { family: 'control', operation: 'blr', indirect: true, abiSemantics: false },
    });
  }

  if (mnemonic === 'ret') {
    if (ops.length > 1 || (ops.length === 1 && !isIndirectControlRegister(ops[0]))) {
      return ctx.partial('arm64-ret-operand-shape-invalid', ['control','registers'], undefined, { kind:'unknown', reason:'arm64-ret-operand-shape-invalid' });
    }
    const operand = ops[0] || gpRegister(30);
    const target = ctx.readRegister(operand);
    if (!target) {
      return ctx.partial('arm64-ret-target-register-unmodelled', ['control','registers'], undefined, { kind: 'unknown', reason: 'arm64-ret-target-register-unmodelled' });
    }
    return ctx.finish({
      controlEffect: { kind: 'return', target },
      possibleFaults: indirectTargetFaults(operand),
      metadata: { family: 'control', operation: 'ret', abiSemantics: false },
    });
  }

  const target = directTargetOf(instruction, 'branch');
  const fallthrough = fallthroughRef(instruction);
  if (target == null || !fallthrough) {
    return ctx.partial(`arm64-${mnemonic}-targets-unavailable`, ['control'], undefined, { kind: 'unknown', reason: `arm64-${mnemonic}-targets-unavailable` });
  }
  const encoding = directBranchEncodingStatus(instruction, target, mnemonic);
  if (!encoding.valid) {
    return ctx.partial(encoding.reason, ['control'], undefined, { kind:'unknown', reason:encoding.reason });
  }
  if (COMPARE_BRANCH.has(mnemonic)) {
    const widthBits = instructionBits(ops[0]);
    const value = ctx.readOperand(ops[0], widthBits);
    if (!value) return ctx.partial(`arm64-${mnemonic}-operand-unmodelled`, ['control','registers'], undefined, { kind: 'unknown', reason: `arm64-${mnemonic}-operand-unmodelled` });
    let condition = ctx.valueOp('is-zero', [value], 1, { widthBits });
    if (mnemonic === 'cbnz') condition = ctx.valueOp('not-bool', [condition], 1);
    return ctx.finish({
      controlEffect: conditionalControlEffect(target, fallthrough, condition),
      metadata: { family: 'control', operation: mnemonic, conditionKind: mnemonic, ...(sameAbsoluteTarget(target, fallthrough) ? { degenerateConditional:true } : {}) },
    });
  }

  if (TEST_BRANCH.has(mnemonic)) {
    const widthBits = instructionBits(ops[0]);
    const value = ctx.readOperand(ops[0], widthBits);
    const bit = immediateOf(ops[1]);
    if (!value || bit == null || bit < 0n || bit >= BigInt(widthBits)) {
      return ctx.partial(`arm64-${mnemonic}-bit-test-unmodelled`, ['control','registers'], undefined, { kind: 'unknown', reason: `arm64-${mnemonic}-bit-test-unmodelled` });
    }
    const tested = ctx.valueOp('extract-bit', [value], 1, { bit: Number(bit), widthBits });
    const condition = mnemonic === 'tbz' ? ctx.valueOp('is-zero', [tested], 1, { widthBits: 1 }) : tested;
    return ctx.finish({
      controlEffect: conditionalControlEffect(target, fallthrough, condition),
      metadata: { family: 'control', operation: mnemonic, bit: Number(bit), ...(sameAbsoluteTarget(target, fallthrough) ? { degenerateConditional:true } : {}) },
    });
  }

  const conditionCode = mnemonic.slice(2);
  const condition = emitArm64Condition(ctx, conditionCode);
  if (!condition) return ctx.partial(`arm64-${mnemonic}-condition-unmodelled`, ['control','flags'], undefined, { kind: 'unknown', reason: `arm64-${mnemonic}-condition-unmodelled` });
  return ctx.finish({
    controlEffect: conditionalControlEffect(target, fallthrough, condition),
    metadata: { family: 'control', operation: mnemonic, conditionCode, ...(sameAbsoluteTarget(target, fallthrough) ? { degenerateConditional:true } : {}) },
  });
}

export function liftArm64ControlEffects(instruction, options = {}) {
  const bundle = liftArm64ControlEffectsCore(instruction, options);
  if (bundle == null) return null;
  // Encoding-domain failures describe instructions that cannot exist. Do not attach
  // architectural BTYPE post-state to malformed structured evidence. Missing
  // address/target evidence is intentionally not included: a decoded valid direct
  // branch still resets BTYPE even when its concrete target cannot be reconstructed.
  const failureReason = String(bundle.unknownEffects?.reason || '');
  if (/(?:operand-shape-invalid|target-(?:misaligned|out-of-range)-encoding)$/.test(failureReason)) return bundle;
  return decorateArm64BtypeEffects(instruction, options, bundle);
}
