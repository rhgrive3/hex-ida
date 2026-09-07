import assert from 'node:assert/strict';
import test from 'node:test';

import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';

// Integer constant authority at the Semantic IR v2 -> v1 compatibility
// boundary requires an explicit integer primitive or a strict integer
// literal. BigInt() coercion laundered '' -> 0 and booleans -> 0/1 into
// exact legacy constants (#5870).

const origin = { instructionIds: ['instruction_0'] };

function irFor(payload) {
  return {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId: 'f',
    entryBlockId: 'b0',
    blocks: [{ id: 'b0', nodeIds: ['n0'] }],
    values: [{
      id: 'v0', kind: 'definition',
      machineType: { kind: 'bitvector', widthBits: 64 },
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

function constValueFor(payload) {
  const inst = projectSemanticIrV2ToLegacyV1(irFor(payload))?.instructions?.[0];
  return inst?.extra?.value;
}

test('#5870: blank and boolean const payloads do not become exact constants', () => {
  for (const payload of ['', '   ', true, false]) {
    assert.equal(constValueFor(payload), null, `payload ${JSON.stringify(payload)} must not mint an exact constant`);
  }
});

test('#5870: strict integer payloads keep their exact constant', () => {
  assert.equal(constValueFor(42n), 42n);
  assert.equal(constValueFor(42), 42n);
  assert.equal(constValueFor('42'), 42n);
  assert.equal(constValueFor('0x2A'), 42n);
});

test('#5870: a safe bitvector-kind payload value still resolves', () => {
  const ir = irFor(null);
  ir.nodes[0].attributes = { value: { kind: 'bitvector', value: '7' } };
  const inst = projectSemanticIrV2ToLegacyV1(ir)?.instructions?.[0];
  assert.equal(inst?.extra?.value, 7n);
});

test('#5870: fractional strings never mint integer constants', () => {
  assert.equal(constValueFor('4.2'), null);
});
