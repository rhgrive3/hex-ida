import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveCanonicalAddressProof } from '../../../js/analysis/alias/canonical-address-v2-core.js';

function constantIr(widthBits, { nodeWidthBits, constant = -1 } = {}) {
  return {
    functionId: 'f',
    values: [{
      id: 'v0',
      definitionNodeId: 'n0',
      ...(widthBits === undefined ? {} : { machineType: { widthBits } }),
    }],
    nodes: [{
      id: 'n0',
      kind: 'const',
      inputs: [],
      outputs: ['v0'],
      attributes: {
        constant,
        ...(nodeWidthBits === undefined ? {} : { widthBits: nodeWidthBits }),
      },
    }],
    blocks: [],
  };
}

test('canonical address width authority requires a primitive positive safe-integer number', () => {
  const exact = deriveCanonicalAddressProof(constantIr(8), 'v0');
  assert.equal(exact.kind, 'absolute');
  assert.equal(exact.widthBits, 8);
  assert.equal(exact.address, 255n);

  for (const malformed of [['8'], '8', true, 8n, { value: 8 }]) {
    const proof = deriveCanonicalAddressProof(constantIr(malformed), 'v0');
    assert.equal(proof.kind, 'absolute');
    assert.equal(proof.widthBits, null);
    assert.equal(proof.address, -1n, `must not apply modulo semantics for ${typeof malformed}`);
  }
});

test('width validation never invokes user-controlled numeric coercion', () => {
  let calls = 0;
  const widthBits = {
    valueOf() {
      calls += 1;
      return 8;
    },
    toString() {
      calls += 1;
      return '8';
    },
  };
  const proof = deriveCanonicalAddressProof(constantIr(widthBits), 'v0');
  assert.equal(calls, 0);
  assert.equal(proof.widthBits, null);
  assert.equal(proof.address, -1n);
});

test('independent primitive node width remains authoritative when machine width is malformed', () => {
  const proof = deriveCanonicalAddressProof(constantIr(['8'], { nodeWidthBits: 16 }), 'v0');
  assert.equal(proof.kind, 'absolute');
  assert.equal(proof.widthBits, 16);
  assert.equal(proof.address, 65535n);
});

test('structured constant-local width cannot mint modulo address semantics', () => {
  const proof = deriveCanonicalAddressProof(constantIr(undefined, {
    constant: { value: -1, widthBits: ['8'] },
  }), 'v0');
  assert.equal(proof.kind, 'absolute');
  assert.equal(proof.widthBits, null);
  assert.equal(proof.address, -1n);
});
