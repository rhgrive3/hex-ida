import assert from 'node:assert/strict';
import test from 'node:test';

import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';

const origin = { instructionIds: ['instruction_0'] };
const FLOAT64 = { kind: 'float', widthBits: 64, format: 'ieee754' };
const BITVECTOR64 = { kind: 'bitvector', widthBits: 64 };

function irFor(payload, machineType = FLOAT64, constKind) {
  return {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId: 'f',
    entryBlockId: 'b0',
    blocks: [{ id: 'b0', nodeIds: ['n0'] }],
    values: [{
      id: 'v0',
      kind: 'definition',
      machineType,
      definitionNodeId: 'n0',
      sourceEntityId: null,
      variableKey: null,
      origin,
    }],
    nodes: [{
      id: 'n0',
      kind: 'const',
      blockId: 'b0',
      inputs: [],
      outputs: ['v0'],
      attributes: { value: payload, ...(constKind == null ? {} : { constKind }) },
      completeness: 'complete',
      origin,
    }],
    completeness: 'complete',
    unknowns: [],
    origin,
  };
}

function projectionFor(payload, machineType = FLOAT64, constKind) {
  const out = projectSemanticIrV2ToLegacyV1(irFor(payload, machineType, constKind));
  const inst = out.instructions.find((candidate) => candidate.semanticNodeId === 'n0');
  return { inst, primaryOutput: inst?.dst };
}

function assertFloatAuthority(payload, expected, machineType = FLOAT64, constKind) {
  const { inst, primaryOutput } = projectionFor(payload, machineType, constKind);
  assert.equal(inst?.extra?.value, null);
  assert.equal(inst?.extra?.float, expected);
  assert.equal(primaryOutput?.const, null);
  assert.equal(primaryOutput?.float, expected);
  assert.equal(primaryOutput?.floatConst, expected);
}

test('#7083: exact large finite float values keep compatibility float authority', () => {
  for (const [payload, expected] of [
    ['9007199254740992.0', 2 ** 53],
    [2 ** 53, 2 ** 53],
    ['1e20', 1e20],
    [2 ** 60, 2 ** 60],
  ]) {
    assertFloatAuthority(payload, expected);
  }
});

test('#7083: explicit float const kind permits an integer-valued unsafe float', () => {
  assertFloatAuthority('9007199254740992.0', 2 ** 53, BITVECTOR64, 'float');
});

test('#7083: integer-typed unsafe numbers remain unknown', () => {
  for (const payload of [2 ** 53, '9007199254740992.0', '1e20']) {
    const { inst, primaryOutput } = projectionFor(payload, BITVECTOR64);
    assert.equal(inst?.extra?.value, null);
    assert.equal(inst?.extra?.float, undefined);
    assert.equal(primaryOutput?.const, null);
    assert.equal(primaryOutput?.float, undefined);
    assert.equal(primaryOutput?.floatConst, undefined);
  }
});

test('#7083: non-finite and underflowed float payloads remain unknown', () => {
  for (const payload of ['Infinity', 'NaN', '1e309', '1e-999', '-1e-999']) {
    const { inst, primaryOutput } = projectionFor(payload);
    assert.equal(inst?.extra?.value, null);
    assert.equal(inst?.extra?.float, undefined);
    assert.equal(primaryOutput?.const, null);
    assert.equal(primaryOutput?.float, undefined);
    assert.equal(primaryOutput?.floatConst, undefined);
  }
});
