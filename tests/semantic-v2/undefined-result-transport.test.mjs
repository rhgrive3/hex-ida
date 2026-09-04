import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBitVectorValue,
  createIntrinsicEffectSummary,
  createMachineEffectBundle,
  createMachineOperation,
  createMemoryAccess,
  createTemporaryValue,
  serializeMachineEffectBundle,
} from '../../js/semantics/effects/index.js';
import { lowerMachineEffectBundleToSemanticIr } from '../../js/semantics/ir/from-machine-effects.js';
import { lowerMachineEffectsToLegacyV1 } from '../../js/semantics/compat/machine-effects-to-v1.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { OP } from '../../js/architecture/compat/ir-core-arm64-aapcs64-v1.js';
import { createOriginSet } from '../../js/core/identity/origin.js';
import { runPassTransaction, seedAnalysisState } from '../../js/decompiler/phase8/transaction.js';
import { SCCP_PASS, runSccpPass } from '../../js/decompiler/phase8/sccp.js';
import { isFull } from '../../js/decompiler/phase8/range.js';

const classes = Object.freeze([
  ['fully', '0xff', null],
  ['conditional', '0x80', { kind: 'divisor-zero', operandIndex: 1 }],
  ['partial', '0xf0', null],
  ['operand-dependent', '0x0f', { kind: 'count-at-least-width', operandIndex: 1 }],
]);

function descriptor(resultClass, mask, condition) {
  return {
    widthBits: 8,
    mask,
    class: resultClass,
    reason: `${resultClass}-architectural-result`,
    ...(condition == null ? {} : { condition }),
  };
}

function valueBundle(resultClass, mask, condition, {
  completeness = 'exact',
  unknownEffects = null,
} = {}) {
  const output = createTemporaryValue(`tmp-${resultClass}`, { kind: 'bitvector', widthBits: 8 });
  const operation = createMachineOperation({
    kind: 'value',
    id: `effect-${resultClass}`,
    opcode: 'add',
    inputs: [createBitVectorValue(8, 1n), createBitVectorValue(8, 2n)],
    outputs: [output],
    undefinedResult: descriptor(resultClass, mask, condition),
  });
  return createMachineEffectBundle({
    instructionId: `instruction-${resultClass}`,
    architectureId: 'arm64',
    mode: 'a64',
    operations: [operation],
    controlEffect: { kind: 'fallthrough' },
    possibleFaults: [],
    origin: createOriginSet({ source: 'test', instructionIds: [`instruction-${resultClass}`] }),
    completeness,
    ...(unknownEffects == null ? {} : { unknownEffects }),
  });
}

function semanticFor(bundle, suffix = bundle.instructionId) {
  return lowerMachineEffectBundleToSemanticIr(bundle, {
    functionId: `fn-${suffix}`,
    blockId: `block-${suffix}`,
    addressWidthBits: 64,
  });
}

function analyze(projected) {
  const state = seedAnalysisState(projected);
  const outcome = runPassTransaction(state, {
    descriptor: SCCP_PASS,
    run: runSccpPass,
  }, { analysis: state, ir: projected }, {});
  assert.equal(outcome.committed, true);
  return state.get('ranges');
}

for (const [resultClass, mask, condition] of classes) {
  test(`undefined result ${resultClass} survives ME, Semantic IR v2, v1, and SCCP`, () => {
    const bundle = valueBundle(resultClass, mask, condition);
    const expected = bundle.operations[0].undefinedResult;
    const serialized = JSON.parse(serializeMachineEffectBundle(bundle));
    assert.deepEqual(serialized.operations[0].undefinedResult, expected);

    const semantic = semanticFor(bundle);
    const producer = semantic.nodes.find((node) => node.attributes?.machineEffects?.undefinedResult);
    assert.ok(producer);
    assert.deepEqual(producer.attributes.machineEffects.undefinedResult, expected);
    assert.equal(producer.outputs.length, 1);
    assert.equal(semantic.completeness, 'complete');

    const operandConstants = semantic.nodes.filter((node) => node.kind === 'const');
    assert.equal(operandConstants.length, 2);
    assert.ok(operandConstants.every((node) => node.attributes?.machineEffects?.undefinedResult == null),
      'an output descriptor must not contaminate exact input constants');

    const direct = lowerMachineEffectsToLegacyV1(bundle);
    assert.equal(direct[0].op, OP.UNKNOWN);
    assert.equal(Object.hasOwn(direct[0], 'value'), false);
    assert.deepEqual(direct[0].undefinedResult, expected);

    const projected = projectSemanticIrV2ToLegacyV1(semantic);
    const uncertain = projected.instructions.find((instruction) => instruction.extra?.undefinedResult != null);
    assert.equal(uncertain?.op, OP.UNKNOWN);
    assert.equal(Object.hasOwn(uncertain.extra, 'value'), false);
    assert.deepEqual(uncertain.extra.undefinedResult, expected);

    const output = projected.values.find((value) => value.semanticValueId === producer.outputs[0]);
    assert.ok(output);
    const facts = analyze(projected);
    assert.equal(facts.constants.has(output.id), false);
    assert.equal(isFull(facts.ranges.get(output.id)), true);
    assert.match(facts.overdefinedReasons.get(output.id) ?? '', /architecturally undefined result bits/);
  });
}

test('an undefined memory read keeps value and memory uncertainty in compatibility', () => {
  const operation = createMachineOperation({
    kind: 'memory-read',
    id: 'effect-memory-undefined',
    access: createMemoryAccess({
      space: 'memory',
      addressExpr: { kind: 'register', registerId: 'x0', widthBits: 64 },
      widthBits: 8,
      endian: 'little',
    }),
    value: createTemporaryValue('tmp-memory-undefined', { kind: 'bitvector', widthBits: 8 }),
    undefinedResult: { widthBits: 8, mask: '0xff', class: 'fully', reason: 'memory-read-undefined' },
  });
  const bundle = createMachineEffectBundle({
    instructionId: 'instruction-memory-undefined',
    architectureId: 'arm64',
    mode: 'a64',
    operations: [operation],
    controlEffect: { kind: 'fallthrough' },
    possibleFaults: [],
    origin: createOriginSet({ source: 'test', instructionIds: ['instruction-memory-undefined'] }),
    completeness: 'exact',
  });
  const lowered = lowerMachineEffectsToLegacyV1(bundle, { registerUniverse: ['x0'] });
  assert.equal(lowered[0].op, OP.UNKNOWN);
  assert.ok(lowered[0].unknownCategories.includes('memory'));
  assert.ok(lowered[0].unknownCategories.includes('value'));
  assert.equal(lowered[0].memoryBarrier, true);
  assert.deepEqual(lowered[0].memoryAccess, operation.access);
  assert.equal(Object.hasOwn(lowered[0], 'value'), false);
  assert.deepEqual(lowered[0].undefinedResult, operation.undefinedResult);

  const semantic = semanticFor(bundle);
  const projected = projectSemanticIrV2ToLegacyV1(semantic);
  const uncertainRead = projected.instructions.find((instruction) => instruction.extra?.undefinedResult != null);
  assert.equal(uncertainRead?.op, OP.UNKNOWN);
  assert.deepEqual(uncertainRead.extra.undefinedResult, operation.undefinedResult);
  assert.ok(uncertainRead.extra.unknownCategories.includes('memory'));
  assert.equal(uncertainRead.memoryBarrier, true);
  assert.ok(uncertainRead.memoryAccess);
});

test('an undefined intrinsic preserves its exact effect summary while withholding its value', () => {
  const output = createTemporaryValue('tmp-intrinsic-undefined', { kind: 'bitvector', widthBits: 8 });
  const summary = createIntrinsicEffectSummary({
    inputs: [createBitVectorValue(8, 3n)],
    outputs: [output],
    registersRead: ['x0'],
    registersWritten: ['x1'],
    memoryRead: { scope: 'none' },
    memoryWrite: { scope: 'none' },
    controlEffects: [],
    determinism: 'deterministic',
    symbolicDetail: 'summary-only',
  });
  const operation = createMachineOperation({
    kind: 'intrinsic',
    id: 'effect-intrinsic-undefined',
    intrinsicId: 'test.undefined.intrinsic',
    effectSummary: summary,
    undefinedResult: { widthBits: 8, mask: '0xf0', class: 'partial', reason: 'intrinsic-undefined' },
  });
  const bundle = createMachineEffectBundle({
    instructionId: 'instruction-intrinsic-undefined',
    architectureId: 'arm64',
    mode: 'a64',
    operations: [operation],
    controlEffect: { kind: 'fallthrough' },
    possibleFaults: [],
    origin: createOriginSet({ source: 'test', instructionIds: ['instruction-intrinsic-undefined'] }),
    completeness: 'exact-with-intrinsic',
  });

  const direct = lowerMachineEffectsToLegacyV1(bundle);
  assert.equal(direct[0].op, OP.CLOBBER);
  assert.deepEqual(direct[0].intrinsicSummary, summary);
  assert.deepEqual(direct[0].undefinedResult, operation.undefinedResult);
  assert.equal(Object.hasOwn(direct[0], 'value'), false);

  const semantic = semanticFor(bundle);
  const projected = projectSemanticIrV2ToLegacyV1(semantic);
  const intrinsic = projected.instructions.find((instruction) => instruction.extra?.undefinedResult != null);
  assert.equal(intrinsic?.op, OP.CLOBBER);
  assert.deepEqual(intrinsic.extra.undefinedResult, operation.undefinedResult);
  const result = projected.values.find((value) => value.semanticValueId === semantic.nodes.find((node) => node.kind === 'intrinsic').outputs[0]);
  const facts = analyze(projected);
  assert.equal(facts.constants.has(result.id), false);
  assert.equal(isFull(facts.ranges.get(result.id)), true);
});

test('partial input completeness cannot improve during undefined-result transport', () => {
  const bundle = valueBundle('partial', '0xf0', null, {
    completeness: 'partial',
    unknownEffects: { categories: ['memory'], reason: 'secondary effects unavailable' },
  });
  const semantic = semanticFor(bundle, 'partial-completeness');
  assert.equal(semantic.completeness, 'partial');
  assert.ok(semantic.unknowns.length > 0);
  const projected = projectSemanticIrV2ToLegacyV1(semantic);
  assert.equal(projected.instructions.some((instruction) => instruction.op === OP.UNKNOWN), true);
  assert.equal(projected.instructions.some((instruction) => instruction.extra?.undefinedResult != null), true);
});

test('explicit null or undefined markers fail closed at every transport boundary', () => {
  const valid = valueBundle('fully', '0xff', null);
  for (const marker of [null, undefined]) {
    const malformedBundle = {
      ...valid,
      operations:valid.operations.map((operation) => ({ ...operation, undefinedResult:marker })),
    };
    assert.throws(() => serializeMachineEffectBundle(malformedBundle), /undefined-result-required/);
    assert.throws(() => lowerMachineEffectsToLegacyV1(malformedBundle), /undefined-result-required/);
    assert.throws(() => lowerMachineEffectBundleToSemanticIr(malformedBundle, {
      functionId:`fn-malformed-${String(marker)}`, blockId:'entry', addressWidthBits:64,
    }), /undefined-result-required/);
  }

  const semantic = semanticFor(valid, 'malformed-v2-presence');
  const producerId = semantic.nodes.find((node) => node.attributes?.machineEffects?.undefinedResult != null).id;
  const malformedSemantic = {
    ...semantic,
    nodes:semantic.nodes.map((node) => node.id !== producerId ? node : {
      ...node,
      attributes:{ ...node.attributes, machineEffects:{ ...node.attributes.machineEffects, undefinedResult:null } },
    }),
  };
  const projected = projectSemanticIrV2ToLegacyV1(malformedSemantic);
  const uncertain = projected.instructions.find((instruction) => instruction.extra?.undefinedResult?.class === 'malformed');
  assert.equal(uncertain?.op, OP.UNKNOWN);
  const output = projected.values.find((value) => value.semanticValueId === semantic.nodes.find((node) => node.id === producerId).outputs[0]);
  const facts = analyze(projected);
  assert.equal(facts.constants.has(output.id), false);
  assert.equal(isFull(facts.ranges.get(output.id)), true);

  const undefinedSemantic = {
    ...malformedSemantic,
    nodes:malformedSemantic.nodes.map((node) => node.id !== producerId ? node : {
      ...node,
      attributes:{ ...node.attributes, machineEffects:{ ...node.attributes.machineEffects, undefinedResult:undefined } },
    }),
  };
  assert.throws(() => projectSemanticIrV2ToLegacyV1(undefinedSemantic), /semantic-ir-invalid-node-attributes/);
});
