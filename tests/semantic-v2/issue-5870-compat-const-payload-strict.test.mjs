import assert from 'node:assert/strict';
import test from 'node:test';

import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';

// Integer constant authority at the Semantic IR v2 -> v1 compatibility
// boundary requires an explicit integer primitive or a strict integer
// literal. BigInt() and Number() coercion must not mint facts from malformed
// payloads (#5870/#5847).

const origin = { instructionIds: ['instruction_0'] };

function irFor(payload, machineType = { kind: 'bitvector', widthBits: 64 }) {
  return {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId: 'f',
    entryBlockId: 'b0',
    blocks: [{ id: 'b0', nodeIds: ['n0'] }],
    values: [{
      id: 'v0', kind: 'definition',
      machineType,
      definitionNodeId: 'n0', sourceEntityId: null, variableKey: null,
      origin,
    }],
    nodes: [{
      id: 'n0', kind: 'const', blockId: 'b0', inputs: [], outputs: ['v0'],
      attributes: { value: payload },
      completeness: 'complete',
      origin,
    }],
    completeness: 'complete', unknowns: [], origin,
  };
}

function projectionFor(payload, machineType) {
  const out = projectSemanticIrV2ToLegacyV1(irFor(payload, machineType));
  const inst = out?.instructions?.find((candidate) => candidate.semanticNodeId === 'n0') ?? out?.instructions?.[0];
  return { inst, primaryOutput: inst?.dst };
}

function constValueFor(payload) {
  return projectionFor(payload).inst?.extra?.value;
}

test('#5870/#5847: malformed payloads do not become integer or float facts', () => {
  for (const payload of ['', '   ', true, false, [], ['15'], {}, 'Infinity', '1e309', 2 ** 53]) {
    const { inst, primaryOutput } = projectionFor(payload);
    assert.equal(inst?.extra?.value, null, 'malformed payload must not become an integer');
    assert.equal(inst?.extra?.float, undefined, 'malformed payload must not become a float');
    assert.equal(primaryOutput?.float, undefined, 'malformed payload must not populate output.float');
    assert.equal(primaryOutput?.floatConst, undefined, 'malformed payload must not populate output.floatConst');
  }
});

test('#5870: strict integer payloads keep their exact constant', () => {
  const cases = [
    [42n, 42n],
    [42, 42n],
    ['42', 42n],
    ['-42', -42n],
    ['0x2A', 42n],
    ['0b1010', 10n],
    ['0o12', 10n],
  ];
  for (const [payload, expected] of cases) {
    const { inst, primaryOutput } = projectionFor(payload);
    assert.equal(inst?.extra?.value, expected);
    assert.equal(primaryOutput?.const, BigInt.asUintN(64, expected));
    assert.equal(inst?.extra?.float, undefined);
  }
});

test('#5847: canonical numeric strings and numbers retain integer authority', () => {
  const stringProjection = projectionFor('42');
  assert.equal(stringProjection.inst?.extra?.value, 42n);
  assert.equal(stringProjection.primaryOutput?.const, 42n);
  const numberProjection = projectionFor(7);
  assert.equal(numberProjection.inst?.extra?.value, 7n);
  assert.equal(numberProjection.primaryOutput?.const, 7n);
});

test('#5870: strict finite float payloads keep their float authority', () => {
  for (const payload of [1.5, -2.25, '1.5', '-2.25', '1e2']) {
    const { inst, primaryOutput } = projectionFor(payload, { kind: 'float', widthBits: 32, format: 'ieee754' });
    const expected = Number(payload);
    assert.equal(inst?.extra?.float, expected);
    assert.equal(primaryOutput?.float, expected);
    assert.equal(primaryOutput?.floatConst, expected);
  }
});

test('#5870: fractional strings never mint integer constants', () => {
  const { inst, primaryOutput } = projectionFor('4.2');
  assert.equal(inst?.extra?.value, null);
  assert.equal(inst?.extra?.float, 4.2);
  assert.equal(primaryOutput?.const, null);
  assert.equal(primaryOutput?.floatConst, 4.2);
});
