import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveCanonicalAddressProof } from '../../../js/analysis/alias/canonical-address-v2-core.js';
import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';

function machineType(kind) {
  if (kind === 'float') return { kind, widthBits: 32, format: 'ieee754-binary32' };
  if (kind === 'vector') return { kind, laneCount: 4, elementType: { kind: 'bitvector', widthBits: 32 } };
  if (kind === 'predicate') return { kind, widthBits: 1 };
  if (kind === 'address') return { kind, widthBits: 64, addressSpace: 'memory' };
  return { kind: 'bitvector', widthBits: 64 };
}

function constantIr(kind, constant) {
  return {
    functionId: 'f',
    values: [{
      id: 'v',
      kind: 'definition',
      machineType: machineType(kind),
      definitionNodeId: 'c',
      metadata: { constant },
    }],
    nodes: [{
      id: 'c',
      kind: 'const',
      inputs: [],
      outputs: ['v'],
      attributes: { constant },
    }],
    blocks: [],
  };
}

function arithmeticIr(operator, offsetKind, { addWithCarry = false } = {}) {
  const values = [
    {
      id: 'base', kind: 'definition', machineType: machineType('address'), definitionNodeId: 'base-c',
      metadata: { constant: { kind: 'bitvector', value: '4096', widthBits: 64 } },
    },
    {
      id: 'off', kind: 'definition', machineType: machineType(offsetKind), definitionNodeId: 'off-c',
      metadata: { constant: { kind: offsetKind, value: '8', widthBits: offsetKind === 'float' ? 32 : 64 } },
    },
    { id: 'out', kind: 'definition', machineType: machineType('address'), definitionNodeId: 'op' },
  ];
  const nodes = [
    {
      id: 'base-c', kind: 'const', blockId: 'b', inputs: [], outputs: ['base'],
      attributes: { constant: { kind: 'bitvector', value: '4096', widthBits: 64 } },
    },
    {
      id: 'off-c', kind: 'const', blockId: 'b', inputs: [], outputs: ['off'],
      attributes: { constant: { kind: offsetKind, value: '8', widthBits: offsetKind === 'float' ? 32 : 64 } },
    },
  ];
  if (addWithCarry) {
    values.push({
      id: 'carry', kind: 'definition', machineType: machineType('bitvector'), definitionNodeId: 'carry-c',
      metadata: { constant: { kind: 'bitvector', value: '0', widthBits: 64 } },
    });
    nodes.push({
      id: 'carry-c', kind: 'const', blockId: 'b', inputs: [], outputs: ['carry'],
      attributes: { constant: { kind: 'bitvector', value: '0', widthBits: 64 } },
    });
  }
  nodes.push({
    id: 'op', kind: addWithCarry ? 'intrinsic' : 'binary', blockId: 'b', operator,
    inputs: addWithCarry ? ['base', 'off', 'carry'] : ['base', 'off'], outputs: ['out'], attributes: {},
  });
  return { functionId: 'f', values, nodes, blocks: [{ id: 'b', nodeIds: nodes.map((node) => node.id) }] };
}

for (const kind of ['float', 'predicate', 'vector']) {
  test(`#5228 ${kind} constants never become absolute addresses`, () => {
    const proof = deriveCanonicalAddressProof(constantIr(kind, { value: '0' }), 'v');
    assert.equal(proof.kind, 'unknown');
  });
}

test('#5228 structured constant kind must agree with the integer/address machine domain', () => {
  const proof = deriveCanonicalAddressProof(
    constantIr('bitvector', { kind: 'float', value: '0', widthBits: 32 }),
    'v',
  );
  assert.equal(proof.kind, 'unknown');
});

test('#5228 canonical bitvector and address constants retain exact proofs', () => {
  const bitvector = deriveCanonicalAddressProof(
    constantIr('bitvector', { kind: 'bitvector', value: '4096', widthBits: 64 }),
    'v',
  );
  assert.equal(bitvector.kind, 'absolute');
  assert.equal(bitvector.address, 4096n);
  assert.equal(bitvector.widthBits, 64);

  // Address-typed constants produced by machine-effect lowering carry a
  // bitvector payload under an address machine type; that combination is valid.
  const address = deriveCanonicalAddressProof(
    constantIr('address', { kind: 'bitvector', value: '8192', widthBits: 64 }),
    'v',
  );
  assert.equal(address.kind, 'absolute');
  assert.equal(address.address, 8192n);
  assert.equal(address.widthBits, 64);
});

for (const operator of ['add', 'sub']) {
  test(`#5228 ${operator} does not propagate a float constant as an exact address offset`, () => {
    const proof = deriveCanonicalAddressProof(arithmeticIr(operator, 'float'), 'out');
    assert.equal(proof.kind, 'unknown');
  });
}

test('#5228 add-with-carry does not propagate a float constant as an exact address offset', () => {
  const proof = deriveCanonicalAddressProof(arithmeticIr('add-with-carry', 'float', { addWithCarry: true }), 'out');
  assert.equal(proof.kind, 'unknown');
});

test('#5228 points-to does not re-promote a rejected float displacement', () => {
  const result = analyzeLocalPointsTo(
    arithmeticIr('add', 'float'),
    null,
    { definitions: [], uses: [] },
    {},
  );
  const out = result.pointsTo.get('out');
  assert.ok(out, 'the output must be analyzed');
  assert.equal(out.top, true, 'unknown float displacement must stay conservative');
  assert.equal(out.targets.length, 0, 'A2 must not recover an exact shifted target independently');
});
