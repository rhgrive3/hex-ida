import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveCanonicalAddressProof,
  deriveCanonicalRegionEvidence,
} from '../../../js/analysis/alias/canonical-address-v2-core.js';

function descriptorIr({
  valueMeta = null,
  nodeMeta = null,
  attributeMeta = null,
  variableMeta = null,
} = {}) {
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
      attributes: attributeMeta == null ? null : { canonicalRoot: attributeMeta },
      variable: variableMeta == null ? null : {
        key: 'state-root', kind: 'logical-state', scope: 'function',
        metadata: { canonicalRoot: variableMeta },
      },
    }],
    blocks: [],
  };
}

const rooted = (address, kind = 'absolute-address') => ({ kind, address, addressSpace: 'memory' });

test('#5802 a single valid canonicalRoot descriptor still produces an exact proof', () => {
  const proof = deriveCanonicalAddressProof(
    descriptorIr({ valueMeta: rooted('0x1000') }), 'v-root',
  );
  assert.equal(proof.kind, 'absolute');
  assert.equal(proof.address, 0x1000n);
});

test('#5802 agreeing canonicalRoot descriptors keep the exact proof', () => {
  const proof = deriveCanonicalAddressProof(
    descriptorIr({ valueMeta: rooted('0x1000'), nodeMeta: rooted('0x1000') }), 'v-root',
  );
  assert.equal(proof.kind, 'absolute');
  assert.equal(proof.address, 0x1000n);
});

test('#5802 conflicting canonicalRoot descriptors fail closed with a conflict reason', () => {
  const proof = deriveCanonicalAddressProof(
    descriptorIr({ valueMeta: rooted('0x1000'), nodeMeta: rooted('0x2000') }), 'v-root',
  );
  assert.equal(proof.kind, 'unknown');
  assert.equal(proof.reason, 'canonical-root-descriptor-conflict');
});

test('#5802 slot placement cannot flip the outcome of contradictory evidence', () => {
  const swapped = deriveCanonicalAddressProof(
    descriptorIr({ valueMeta: rooted('0x2000'), nodeMeta: rooted('0x1000') }), 'v-root',
  );
  assert.equal(swapped.kind, 'unknown');
  assert.equal(swapped.reason, 'canonical-root-descriptor-conflict');
});
const malformedRoot = { kind: 'not-a-root-kind', address: '0x1000', addressSpace: 'memory' };

for (const [valueMeta, nodeMeta] of [
  [malformedRoot, rooted('0x1000')],
  [rooted('0x1000'), malformedRoot],
]) {
  const proof = deriveCanonicalAddressProof(
    descriptorIr({ valueMeta, nodeMeta }), 'v-root',
  );
  assert.equal(proof.kind, 'unknown');
  assert.equal(proof.reason, 'canonical-root-descriptor-invalid');
}

test('#5802 attribute and variable descriptor slots participate in conflict detection', () => {
  for (const slots of [
    { valueMeta: rooted('0x1000'), attributeMeta: rooted('0x2000') },
    { valueMeta: rooted('0x1000'), variableMeta: rooted('0x2000') },
  ]) {
    const proof = deriveCanonicalAddressProof(descriptorIr(slots), 'v-root');
    assert.equal(proof.kind, 'unknown');
    assert.equal(proof.reason, 'canonical-root-descriptor-conflict');
    assert.equal(deriveCanonicalRegionEvidence(descriptorIr(slots), 'v-root'), null);
  }
});

test('#5802 rooted and stack descriptors with different identities fail closed', () => {
  const rootedObject = (rootEntityId, baseOffset = 0, rootIdentity = null) => ({
    kind: 'rooted-object', rootEntityId, baseOffset, addressSpace: 'memory', linearOffsets: true,
    ...(rootIdentity == null ? {} : { rootIdentity }),
  });
  const stackLike = (baseOffset) => ({
    kind: 'stack-like', baseOffset, addressSpace: 'memory', linearOffsets: true,
  });
  for (const [left, right] of [
    [rootedObject('root-A'), rootedObject('root-B')],
    [rootedObject('root-A', 0, { allocation: 'A' }), rootedObject('root-A', 0, { allocation: 'B' })],
    [stackLike(0), stackLike(8)],
  ]) {
    const proof = deriveCanonicalAddressProof(descriptorIr({ valueMeta: left, nodeMeta: right }), 'v-root');
    assert.equal(proof.kind, 'unknown');
    assert.equal(proof.reason, 'canonical-root-descriptor-conflict');
    assert.equal(deriveCanonicalRegionEvidence(descriptorIr({ valueMeta: left, nodeMeta: right }), 'v-root'), null);
  }
});

test('#5802 falsy malformed descriptors cannot be hidden beside valid evidence', () => {
  for (const malformed of [false, 0, '']) {
    const proof = deriveCanonicalAddressProof(
      descriptorIr({ valueMeta: malformed, nodeMeta: rooted('0x1000') }), 'v-root',
    );
    assert.equal(proof.kind, 'unknown');
    assert.equal(proof.reason, 'canonical-root-descriptor-invalid');
  }
});
