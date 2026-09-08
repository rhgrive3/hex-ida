import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBitVectorValue,
  createMachineEffectBundle,
  createMachineOperation,
  createMemoryAccess,
  createTemporaryValue,
  MAX_UNDEFINED_RESULT_WIDTH_BITS,
  serializeMachineEffectBundle,
} from '../../js/semantics/effects/index.js';
import { lowerMachineEffectBundleToSemanticIr } from '../../js/semantics/ir/from-machine-effects.js';
import { lowerMachineEffectsToLegacyV1 } from '../../js/semantics/compat/machine-effects-to-v1.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { OP } from '../../js/architecture/compat/ir-core-arm64-aapcs64-v1.js';
import { createOriginSet } from '../../js/core/identity/origin.js';

const classes = [
  ['fully', '0xff', undefined],
  ['conditional', '0x80', { kind: 'divide-by-zero', operand: 'divisor' }],
  ['partial', '0xf0', undefined],
  ['operand-dependent', '0x0f', { kind: 'shift-count-at-least-width', operand: 'count' }],
];

for (const [resultClass, mask, condition] of classes) {
  test(`undefined result ${resultClass} survives MachineEffects to Semantic IR V2`, () => {
    const descriptor = { widthBits: 8, mask, class: resultClass, reason: `${resultClass}-architectural-result`, ...(condition == null ? {} : { condition }) };
    const operation = createMachineOperation({
      kind: 'value', id: `effect-${resultClass}`, opcode: 'add',
      inputs: [createBitVectorValue(8, 1n), createBitVectorValue(8, 2n)],
      outputs: [createTemporaryValue(`tmp-${resultClass}`, { kind: 'bitvector', widthBits: 8 })],
      undefinedResult: descriptor,
    });
    const bundle = createMachineEffectBundle({
      instructionId: `instruction-${resultClass}`, architectureId: 'test', mode: 'test', operations: [operation],
      controlEffect: { kind: 'fallthrough' }, possibleFaults: [],
      origin: createOriginSet({ source: 'test', instructionIds: [`instruction-${resultClass}`] }), completeness: 'exact',
    });
    const serialized = JSON.parse(serializeMachineEffectBundle(bundle));
    assert.deepEqual(serialized.operations[0].undefinedResult, operation.undefinedResult);
    const ir = lowerMachineEffectBundleToSemanticIr(bundle, { functionId: 'fn-undefined', blockId: 'block-undefined', addressWidthBits: 64 });
    const node = ir.nodes.find((item) => item.attributes?.machineEffects?.undefinedResult);
    assert.ok(node);
    assert.deepEqual(node.attributes.machineEffects.undefinedResult, operation.undefinedResult);
  });
}

test('undefined result descriptor rejects zero, out-of-width, and class-invalid masks', () => {
  const base = { kind: 'value', opcode: 'add', inputs: [], outputs: [createTemporaryValue('tmp-bad', { kind: 'bitvector', widthBits: 8 })] };
  assert.throws(() => createMachineOperation({ ...base, undefinedResult: { widthBits: 8, mask: '0x00', class: 'partial', reason: 'bad' } }), /invalid-undefined-result-mask/);
  assert.throws(() => createMachineOperation({ ...base, undefinedResult: { widthBits: 8, mask: '0x100', class: 'partial', reason: 'bad' } }), /invalid-undefined-result-mask/);
  assert.throws(() => createMachineOperation({ ...base, undefinedResult: { widthBits: 8, mask: '0xff', class: 'partial', reason: 'bad' } }), /partial-undefined-result-mask-full/);
  assert.throws(() => createMachineOperation({ ...base, undefinedResult: { widthBits: 8, mask: '0x80', class: 'conditional', reason: 'bad' } }), /condition-required/);
  assert.throws(() => createMachineOperation({ ...base, undefinedResult: { widthBits: 16, mask: '0x00ff', class: 'partial', reason: 'bad-width' } }), /output-width-mismatch/);
  assert.doesNotThrow(() => createMachineOperation({ ...base, outputs: [createTemporaryValue('tmp-max-width', { kind: 'bitvector', widthBits: MAX_UNDEFINED_RESULT_WIDTH_BITS })], undefinedResult: { widthBits: MAX_UNDEFINED_RESULT_WIDTH_BITS, mask: '0x1', class: 'partial', reason: 'max-width' } }));
  assert.throws(() => createMachineOperation({ ...base, undefinedResult: { widthBits: MAX_UNDEFINED_RESULT_WIDTH_BITS + 1, mask: '0x1', class: 'partial', reason: 'too-wide' } }), /invalid-undefined-result-width/);
});

test('undefined memory reads retain their memory uncertainty category in legacy compatibility', () => {
  const operation = createMachineOperation({
    kind: 'memory-read', id: 'effect-memory-undefined',
    access: createMemoryAccess({ space: 'memory', addressExpr: { kind: 'register', registerId: 'x0', widthBits: 64 }, widthBits: 8, endian: 'little' }),
    value: createTemporaryValue('tmp-memory-undefined', { kind: 'bitvector', widthBits: 8 }),
    undefinedResult: { widthBits: 8, mask: '0xff', class: 'fully', reason: 'memory-read-undefined' },
  });
  const bundle = createMachineEffectBundle({
    instructionId: 'instruction-memory-undefined', architectureId: 'arm64', mode: 'a64', operations: [operation],
    controlEffect: { kind: 'fallthrough' }, possibleFaults: [],
    origin: createOriginSet({ source: 'test', instructionIds: ['instruction-memory-undefined'] }), completeness: 'exact',
  });
  const lowered = lowerMachineEffectsToLegacyV1(bundle, { registerUniverse: ['x0'] });
  assert.equal(lowered[0].op, OP.UNKNOWN);
  assert.ok(lowered[0].unknownCategories.includes('memory'));
});

test('legacy compatibility projections preserve uncertainty instead of materializing an exact value', () => {
  const operation = createMachineOperation({
    kind: 'value', id: 'effect-compat-undefined', opcode: 'add',
    inputs: [createBitVectorValue(8, 1n), createBitVectorValue(8, 2n)],
    outputs: [createTemporaryValue('tmp-compat-undefined', { kind: 'bitvector', widthBits: 8 })],
    undefinedResult: { widthBits: 8, mask: '0xf0', class: 'partial', reason: 'compatibility-mask-proof' },
  });
  const bundle = createMachineEffectBundle({
    instructionId: 'instruction-compat-undefined', architectureId: 'arm64', mode: 'a64', operations: [operation],
    controlEffect: { kind: 'fallthrough' }, possibleFaults: [],
    origin: createOriginSet({ source: 'test', instructionIds: ['instruction-compat-undefined'] }), completeness: 'exact',
  });
  const direct = lowerMachineEffectsToLegacyV1(bundle);
  assert.equal(direct[0].op, OP.UNKNOWN);
  assert.deepEqual(direct[0].undefinedResult, operation.undefinedResult);

  const semantic = lowerMachineEffectBundleToSemanticIr(bundle, { functionId: 'fn-compat-undefined', blockId: 'block-compat-undefined', addressWidthBits: 64 });
  const projected = projectSemanticIrV2ToLegacyV1(semantic);
  const masked = projected.instructions.find((instruction) => instruction.extra?.undefinedResult);
  assert.equal(masked?.op, OP.UNKNOWN);
  assert.deepEqual(masked.extra.undefinedResult, operation.undefinedResult);
});
