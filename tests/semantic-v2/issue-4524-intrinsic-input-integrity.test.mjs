import assert from 'node:assert/strict';
import { createInstructionId } from '../../js/core/identity/index.js';
import {
  createBitVectorValue,
  createIntrinsicEffectSummary,
  createLocationValue,
  createMachineEffectBundle,
  createMachineOperation,
  createRegisterValue,
  createTemporaryValue,
} from '../../js/semantics/effects/index.js';
import { lowerMachineEffectBundleToSemanticIr } from '../../js/semantics/ir/from-machine-effects.js';

let nextAddress = 0x452400n;

function lower(inputs, name) {
  const instructionId = createInstructionId({
    binaryId: 'bin_issue_4524',
    sliceId: 'slice_issue_4524',
    virtualAddress: nextAddress,
    decodeMode: 'neutral-mode',
    decoderSemanticVersion: '1',
  });
  nextAddress += 4n;
  const output = createTemporaryValue(`${name}-output`, createBitVectorValue(64));
  const summary = createIntrinsicEffectSummary({
    inputs,
    outputs: [output],
    registersRead: [],
    registersWritten: [],
    memoryRead: { scope: 'none' },
    memoryWrite: { scope: 'none' },
    controlEffects: [],
    determinism: 'deterministic',
    symbolicDetail: 'summary-only',
  });
  const bundle = createMachineEffectBundle({
    instructionId,
    architectureId: 'issue-4524-machine',
    mode: 'neutral-mode',
    operations: [createMachineOperation({
      kind: 'intrinsic',
      id: `effect.issue-4524.${name}`,
      intrinsicId: `audit.depends-on-input.${name}`,
      effectSummary: summary,
    })],
    controlEffect: { kind: 'fallthrough' },
    possibleFaults: [],
    origin: { instructionIds: [instructionId], byteRanges: [{ binaryId: 'bin_issue_4524', start: nextAddress - 4n, end: nextAddress }] },
    completeness: 'exact-with-intrinsic',
  });
  return lowerMachineEffectBundleToSemanticIr(bundle, {
    functionId: `function_issue_4524_${name}`,
    blockId: `block_issue_4524_${name}`,
    addressWidthBits: 64,
  });
}

const unresolved = createLocationValue('memory', { kind: 'producer-specific-expression', payload: 1 }, 64);
const representable = createRegisterValue('input-register', 64);

{
  const ir = lower([unresolved], 'single-unresolved');
  const intrinsic = ir.nodes.find((node) => node.operator === 'audit.depends-on-input.single-unresolved');
  assert.ok(intrinsic);
  assert.equal(intrinsic.intrinsic.inputs.length, 1, 'unrepresentable input must retain an explicit placeholder');
  assert.equal(intrinsic.completeness, 'partial');
  assert.equal(ir.completeness, 'partial');
  assert.equal(intrinsic.unknown.reason, 'intrinsic-summary-not-exactly-representable');
  assert.equal(intrinsic.unknown.knownParts.expectedInputCount, 1);
  assert.equal(intrinsic.unknown.knownParts.loweredInputCount, 1);
  assert.deepEqual(intrinsic.unknown.knownParts.unresolvedInputs.map((item) => item.ordinal), [0]);
  assert.equal(intrinsic.unknown.knownParts.unresolvedInputs[0].machineValue.kind, 'memory');
  const placeholder = ir.nodes.find((node) => node.kind === 'unknown-value' && node.outputs.includes(intrinsic.intrinsic.inputs[0]));
  assert.ok(placeholder, 'the retained input must be represented by an unknown value node');
}

{
  const ir = lower([representable, unresolved], 'mixed-inputs');
  const intrinsic = ir.nodes.find((node) => node.operator === 'audit.depends-on-input.mixed-inputs');
  assert.ok(intrinsic);
  assert.equal(intrinsic.intrinsic.inputs.length, 2, 'one unresolved input must not erase its representable sibling or its own slot');
  assert.equal(intrinsic.completeness, 'partial');
  assert.deepEqual(intrinsic.unknown.knownParts.unresolvedInputs.map((item) => item.ordinal), [1]);
}

{
  const ir = lower([representable], 'all-representable');
  const intrinsic = ir.nodes.find((node) => node.operator === 'audit.depends-on-input.all-representable');
  assert.ok(intrinsic);
  assert.equal(intrinsic.intrinsic.inputs.length, 1);
  assert.equal(intrinsic.completeness, 'complete');
  assert.equal(ir.completeness, 'complete');
  assert.equal(intrinsic.unknown, null);
}

console.log('issue-4524 intrinsic input integrity: PASS');
