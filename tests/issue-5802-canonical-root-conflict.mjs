import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveCanonicalAddressProof } from '../js/analysis/alias/canonical-address-v2-core.js';

function descriptorIr(valueMeta, nodeMeta) {
  return {
    functionId: 'fn-main',
    values: [{
      id: 'v-root',
      kind: 'computed',
      machineType: { widthBits: 64 },
      definitionNodeId: 'n-root',
      metadata: valueMeta == null ? null : { canonicalRoot: valueMeta },
    }],
    nodes: [{
      id: 'n-root', kind: 'copy', inputs: [],
      metadata: nodeMeta == null ? null : { canonicalRoot: nodeMeta },
    }],
    blocks: [],
  };
}

const rooted = (address, kind = 'absolute-address') => ({ kind, address, addressSpace: 'memory' });

test('#5802 a single valid canonicalRoot descriptor still produces an exact proof', () => {
  const proof = deriveCanonicalAddressProof(
    descriptorIr(rooted('0x1000')), 'v-root',
  );
  assert.equal(proof.kind, 'absolute');
  assert.equal(proof.address, 0x1000n);
});

test('#5802 agreeing canonicalRoot descriptors keep the exact proof', () => {
  const proof = deriveCanonicalAddressProof(
    descriptorIr(rooted('0x1000'), rooted('0x1000')), 'v-root',
  );
  assert.equal(proof.kind, 'absolute');
  assert.equal(proof.address, 0x1000n);
});

test('#5802 conflicting canonicalRoot descriptors fail closed with a conflict reason', () => {
  const proof = deriveCanonicalAddressProof(
    descriptorIr(rooted('0x1000'), rooted('0x2000')), 'v-root',
  );
  assert.equal(proof.kind, 'unknown');
  assert.equal(proof.reason, 'canonical-root-descriptor-conflict');
});

test('#5802 slot placement cannot flip the outcome of contradictory evidence', () => {
  const swapped = deriveCanonicalAddressProof(
    descriptorIr(rooted('0x2000'), rooted('0x1000')), 'v-root',
  );
  assert.equal(swapped.kind, 'unknown');
  assert.equal(swapped.reason, 'canonical-root-descriptor-conflict');
});
