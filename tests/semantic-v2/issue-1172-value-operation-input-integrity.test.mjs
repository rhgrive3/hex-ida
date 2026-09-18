import assert from 'node:assert/strict';
import { createInstructionId } from '../../js/core/identity/index.js';
import {
  createBitVectorValue,
  createLocationValue,
  createMachineEffectBundle,
  createMachineOperation,
  createRegisterValue,
  createTemporaryValue,
} from '../../js/semantics/effects/index.js';
import { lowerMachineEffectBundleToSemanticIr } from '../../js/semantics/ir/from-machine-effects.js';

let nextAddress = 0xa100n;

function valueBundle(inputs, label) {
  const instructionId = createInstructionId({
    binaryId: 'bin_issue_1172',
    sliceId: 'slice_issue_1172',
    virtualAddress: nextAddress,
    decodeMode: 'issue-1172-mode',
    decoderSemanticVersion: '1',
  });
  const start = nextAddress;
  nextAddress += 4n;
  return createMachineEffectBundle({
    instructionId,
    architectureId: 'issue-1172-machine',
    mode: 'issue-1172-mode',
    operations: [createMachineOperation({
      kind: 'value',
      id: `${label}.effect`,
      opcode: 'add',
      inputs,
      outputs: [createTemporaryValue(`${label}.result`, createBitVectorValue(64))],
    })],
    controlEffect: { kind: 'fallthrough' },
    possibleFaults: [],
    origin: {
      instructionIds: [instructionId],
      byteRanges: [{ binaryId: 'bin_issue_1172', start, end: nextAddress }],
    },
    completeness: 'exact',
  });
}

function lower(inputs, label) {
  const ir = lowerMachineEffectBundleToSemanticIr(
    valueBundle(inputs, label),
    { functionId: label, blockId: 'entry', addressWidthBits: 64 },
  );
  return { ir, node: ir.nodes.find((node) => node.operator === 'add') };
}

function definingNode(ir, valueId) {
  const value = ir.values.find((candidate) => candidate.id === valueId);
  return ir.nodes.find((candidate) => candidate.id === value?.definitionNodeId);
}

const register = createRegisterValue('r0', 64);
const constant = createBitVectorValue(64, 7n);
const unsupportedLocation = createLocationValue('memory', {
  kind: 'producer-specific-expression',
  payload: 1172,
}, 64);

// 1. A missing second operand must stay visible as an explicit unknown and
// make both the value operation and function partial.
{
  const { ir, node } = lower([register, unsupportedLocation], 'issue-1172.second');
  assert.equal(ir.completeness, 'partial');
  assert.equal(node.completeness, 'partial');
  assert.equal(node.inputs.length, 2);
  const unresolved = node.unknown.knownParts.unresolvedInputs;
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].role, 'value-input');
  assert.equal(unresolved[0].ordinal, 1);
  assert.match(unresolved[0].reason, /unsupported-machine-expression/);
  assert.equal(unresolved[0].machineValue.addressExpr.kind, 'producer-specific-expression');
  assert.equal(definingNode(ir, node.inputs[1]).kind, 'unknown-value');
}

// 2. The same contract applies when the first operand is unresolved; ordinal
// evidence must not be shifted by preserving the supported second operand.
{
  const { ir, node } = lower([unsupportedLocation, constant], 'issue-1172.first');
  assert.equal(ir.completeness, 'partial');
  assert.equal(node.completeness, 'partial');
  assert.equal(node.inputs.length, 2);
  const unresolved = node.unknown.knownParts.unresolvedInputs;
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].ordinal, 0);
  assert.equal(definingNode(ir, node.inputs[0]).kind, 'unknown-value');
  assert.equal(definingNode(ir, node.inputs[1]).kind, 'const');
}

// 3. Fully representable operands retain the prior complete value-operation
// behavior and do not gain unknown evidence.
{
  const { ir, node } = lower([register, constant], 'issue-1172.complete');
  assert.equal(ir.completeness, 'complete');
  assert.equal(node.completeness, 'complete');
  assert.equal(node.inputs.length, 2);
  assert.equal(node.unknown, null);
  assert.equal(definingNode(ir, node.inputs[0]).kind, 'state-read');
  assert.equal(definingNode(ir, node.inputs[1]).kind, 'const');
}

console.log('issue-1172 value-operation input integrity: ok');
