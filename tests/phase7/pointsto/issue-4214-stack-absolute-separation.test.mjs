import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPointsToSet,
  createPointsToTarget,
  createRootDescriptorSeparatedTarget,
  exactRange,
} from '../../../js/analysis/pointsto/lattice.js';
import { pointsToAlias } from '../../../js/analysis/pointsto/alias.js';
import { targetFromCanonicalProof } from '../../../js/analysis/pointsto/local.js';
import { deriveCanonicalAddressProof } from '../../../js/analysis/alias/canonical-address-v2.js';
import { createAnalysisStatus } from '../../../js/analysis/status.js';

const complete = createAnalysisStatus({
  snapshotId: 'snapshot_issue_4214',
  analyzerId: 'pointsto-test',
  analyzerVersion: '1',
  completeness: 'complete',
});

function singleton(target) {
  return createPointsToSet({ targets: [target] });
}

function aliasOf(left, right, nonEscapingRoots = new Set()) {
  return pointsToAlias(singleton(left), singleton(right), {
    status: complete,
    widthBitsLeft: 64,
    widthBitsRight: 64,
    nonEscapingRoots,
  });
}

function stack(rootKind = 'stack-like') {
  return createPointsToTarget({
    addressSpace: 'memory',
    rootKind,
    rootEntityId: 'stack:frame',
    offsetRange: exactRange(0),
    widthBits: 64,
  });
}

function absolute(address = '4096') {
  return createPointsToTarget({
    addressSpace: 'memory',
    rootKind: 'absolute',
    address,
    offsetRange: exactRange(0),
    widthBits: 64,
  });
}

function descriptorTarget(rootEntityId) {
  const valueId = `value-${rootEntityId}`;
  const proof = deriveCanonicalAddressProof({
    functionId: 'issue-4214-proof',
    values: [{
      id: valueId,
      kind: 'entry',
      variableKey: `root-${rootEntityId}`,
      machineType: { kind: 'address', widthBits: 64 },
      metadata: {
        canonicalRoot: {
          kind: 'global-like',
          rootEntityId,
          baseOffset: 0,
          addressSpace: 'memory',
          linearOffsets: true,
        },
      },
    }],
    nodes: [],
    blocks: [],
  }, valueId, { addressSpace: 'memory' });
  assert.equal(proof.kind, 'rooted');
  return createRootDescriptorSeparatedTarget({
    addressSpace: 'memory',
    rootKind: 'rooted',
    rootEntityId,
    offsetRange: exactRange(0),
    widthBits: 64,
  }, proof);
}

test('#4214 stack-like vs bare canonical absolute stays may without storage proof', () => {
  const result = aliasOf(stack('stack-like'), absolute('4096'));
  assert.equal(result.relation, 'may');
  assert.ok(result.reasonCodes.includes('escape-unproven'));
  assert.ok(!result.reasonCodes.includes('distinct-proven-root'));
});

test('#4214 stack-fixed spelling does not prove separation from a bare absolute', () => {
  const result = aliasOf(stack('stack-fixed'), absolute('4096'));
  assert.equal(result.relation, 'may');
  assert.ok(result.reasonCodes.includes('escape-unproven'));
  assert.ok(!result.reasonCodes.includes('distinct-proven-root'));
});

test('#4214 non-escaping stack vs bare absolute stays may', () => {
  const left = stack('stack-like');
  const result = aliasOf(left, absolute('4096'), new Set([left.rootKey]));
  assert.equal(result.relation, 'may');
  assert.ok(result.reasonCodes.includes('escape-unproven'));
  assert.ok(!result.reasonCodes.includes('distinct-proven-root'));
  assert.ok(!result.reasonCodes.includes('distinct-non-escaping-allocation'));
});

test('#4214 function-local-stack vs proven image-global-static yields no', () => {
  const left = createPointsToTarget({
    addressSpace: 'memory',
    rootKind: 'stack-like',
    rootEntityId: 'stack:frame',
    canonicalRootStorageClass: 'function-local-stack',
    offsetRange: exactRange(0),
    widthBits: 64,
  });
  const right = createPointsToTarget({
    addressSpace: 'memory',
    rootKind: 'absolute',
    address: '4096',
    canonicalRootStorageClass: 'image-global-static',
    offsetRange: exactRange(0),
    widthBits: 64,
  });
  const result = aliasOf(left, right);
  assert.equal(result.relation, 'no');
  assert.ok(result.reasonCodes.includes('distinct-proven-root'));
});

test('#4214 canonical constant-pointer from targetFromCanonicalProof does not produce unproven distinct-proven-root or distinct-non-escaping-allocation', () => {
  const left = stack('stack-like');
  const proof = { kind: 'constant', value: 4096n, widthBits: 64 };
  const constantTarget = targetFromCanonicalProof(proof, ['ev-const']);
  assert.ok(constantTarget);
  assert.equal(constantTarget.rootKind, 'absolute');
  assert.equal(constantTarget.address, '4096');

  // Without non-escaping
  const result1 = aliasOf(left, constantTarget);
  assert.equal(result1.relation, 'may');
  assert.ok(result1.reasonCodes.includes('escape-unproven'));
  assert.ok(!result1.reasonCodes.includes('distinct-proven-root'));
  assert.ok(!result1.reasonCodes.includes('distinct-non-escaping-allocation'));

  // With non-escaping stack root
  const result2 = aliasOf(left, constantTarget, new Set([left.rootKey]));
  assert.equal(result2.relation, 'may');
  assert.ok(result2.reasonCodes.includes('escape-unproven'));
  assert.ok(!result2.reasonCodes.includes('distinct-proven-root'));
  assert.ok(!result2.reasonCodes.includes('distinct-non-escaping-allocation'));
});

test('#4214 proof-bearing descriptor separation remains strong', () => {
  const result = aliasOf(descriptorTarget('global:A'), descriptorTarget('global:B'));
  assert.equal(result.relation, 'no');
  assert.ok(result.reasonCodes.includes('distinct-proven-root'));
});

test('#4214 disjoint absolute intervals remain NoAlias', () => {
  const result = aliasOf(absolute('4096'), absolute('8192'));
  assert.equal(result.relation, 'no');
  assert.ok(result.reasonCodes.includes('disjoint-global-interval'));
});

test('#4214 distinct physical address spaces remain NoAlias', () => {
  const left = createPointsToTarget({
    addressSpace: 'memory', rootKind: 'rooted', rootEntityId: 'a', offsetRange: exactRange(0), widthBits: 64,
  });
  const right = createPointsToTarget({
    addressSpace: 'tls', rootKind: 'rooted', rootEntityId: 'b', offsetRange: exactRange(0), widthBits: 64,
  });
  const result = aliasOf(left, right);
  assert.equal(result.relation, 'no');
  assert.ok(result.reasonCodes.includes('distinct-address-space'));
});
