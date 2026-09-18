import assert from 'node:assert/strict';
import { createInstructionId } from '../../js/core/identity/index.js';
import {
  createBitVectorValue,
  createIntrinsicEffectSummary,
  createLocationValue,
  createMachineEffectBundle,
  createMachineOperation,
  createRegisterValue,
} from '../../js/semantics/effects/index.js';
import { lowerMachineEffectBundleToSemanticIr } from '../../js/semantics/ir/from-machine-effects.js';

let nextAddress = 0x9000n;
function intrinsicBundle(inputs, intrinsicId) {
  const instructionId = createInstructionId({
    binaryId: 'bin_issue_4524',
    sliceId: 'slice_issue_4524',
    virtualAddress: nextAddress,
    decodeMode: 'issue-4524-mode',
    decoderSemanticVersion: '1',
  });
  nextAddress += 4n;
  const summary = createIntrinsicEffectSummary({
    inputs,
    outputs: [createBitVectorValue(64, 1n)],
    registersRead: [],
    registersWritten: [],
    memoryRead: { scope: 'none' },
    memoryWrite: { scope: 'none' },
    controlEffects: [],
    determinism: 'deterministic',
    symbolicDetail: 'summary-only',
  });
  return createMachineEffectBundle({
    instructionId,
    architectureId: 'issue-4524-machine',
    mode: 'issue-4524-mode',
    operations: [createMachineOperation({
      kind: 'intrinsic',
      id: `${intrinsicId}.effect`,
      intrinsicId,
      effectSummary: summary,
    })],
    controlEffect: { kind: 'fallthrough' },
    possibleFaults: [],
    origin: {
      instructionIds: [instructionId],
      byteRanges: [{ binaryId: 'bin_issue_4524', start: nextAddress - 4n, end: nextAddress }],
    },
    completeness: 'exact-with-intrinsic',
  });
}

function lower(inputs, intrinsicId) {
  const ir = lowerMachineEffectBundleToSemanticIr(
    intrinsicBundle(inputs, intrinsicId),
    { functionId: intrinsicId, blockId: 'entry', addressWidthBits: 64 },
  );
  return { ir, node: ir.nodes.find((node) => node.operator === intrinsicId) };
}

function definingNode(ir, valueId) {
  const value = ir.values.find((candidate) => candidate.id === valueId);
  return ir.nodes.find((candidate) => candidate.id === value?.definitionNodeId);
}

const unsupportedLocation = createLocationValue('memory', {
  kind: 'producer-specific-expression',
  payload: 1,
}, 64);

// 1. An unsupported location input must remain an explicit unknown value and
// make the intrinsic/function partial instead of disappearing into filter(Boolean).
{
  const { ir, node } = lower([unsupportedLocation], 'issue-4524.single');
  assert.equal(ir.completeness, 'partial');
  assert.equal(node.completeness, 'partial');
  assert.equal(node.inputs.length, 1);
  assert.deepEqual(node.intrinsic.inputs, node.inputs);
  const unresolved = node.unknown.knownParts.unresolvedInputs;
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].role, 'intrinsic-input');
  assert.equal(unresolved[0].ordinal, 0);
  assert.match(unresolved[0].reason, /unsupported-machine-expression/);
  assert.equal(unresolved[0].machineValue.addressExpr.kind, 'producer-specific-expression');
  assert.equal(definingNode(ir, node.inputs[0]).kind, 'unknown-value');
}

// 2. With one supported and one unsupported input, both ordinals survive and
// only the unresolved input is reported as non-exact.
{
  const { ir, node } = lower([
    createBitVectorValue(64, 7n),
    unsupportedLocation,
  ], 'issue-4524.mixed');
  assert.equal(ir.completeness, 'partial');
  assert.equal(node.inputs.length, 2);
  assert.equal(node.unknown.knownParts.unresolvedInputs.length, 1);
  assert.equal(node.unknown.knownParts.unresolvedInputs[0].ordinal, 1);
  assert.equal(definingNode(ir, node.inputs[0]).kind, 'const');
  assert.equal(definingNode(ir, node.inputs[1]).kind, 'unknown-value');
}

// 3. Fully representable inputs preserve the prior exact/complete behavior.
{
  const { ir, node } = lower([
    createRegisterValue('input-register', 64),
    createBitVectorValue(64, 9n),
  ], 'issue-4524.complete');
  assert.equal(ir.completeness, 'complete');
  assert.equal(node.completeness, 'complete');
  assert.equal(node.inputs.length, 2);
  assert.equal(node.unknown, null);
  assert.equal(ir.unknowns.length, 0);
}

console.log('semantic-v2 Issue #4524 intrinsic input integrity: PASS');
