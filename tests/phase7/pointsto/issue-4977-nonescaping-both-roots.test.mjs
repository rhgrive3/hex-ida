import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPointsToSet,
  createPointsToTarget,
  exactRange,
} from '../../../js/analysis/pointsto/lattice.js';
import { pointsToAlias } from '../../../js/analysis/pointsto/alias.js';
import { createAnalysisStatus } from '../../../js/analysis/status.js';

const complete = createAnalysisStatus({
  snapshotId: 'snapshot_issue_4977',
  analyzerId: 'pointsto-test',
  analyzerVersion: '1',
  completeness: 'complete',
});

function singleton(target) {
  return createPointsToSet({ targets: [target] });
}

function aliasOf(left, right, nonEscapingRoots = new Set(), options = {}) {
  return pointsToAlias(singleton(left), singleton(right), {
    status: complete,
    widthBitsLeft: 64,
    widthBitsRight: 64,
    nonEscapingRoots,
    ...options,
  });
}

function heap(entityId) {
  return createPointsToTarget({
    addressSpace: 'memory',
    rootKind: 'heap-like',
    rootIdentity: entityId,
    rootEntityId: entityId,
    offsetRange: exactRange(0),
    widthBits: 64,
  });
}

function unknown(entityId) {
  return createPointsToTarget({
    addressSpace: 'memory',
    rootKind: 'unknown',
    rootIdentity: entityId,
    rootEntityId: entityId,
    offsetRange: exactRange(0),
    widthBits: 64,
  });
}

test('#4977 only A non-escaping + distinct roots stays may', () => {
  const a = heap('alloc-a');
  const b = unknown('unknown-b');
  const result = aliasOf(a, b, new Set([a.rootEntityId]));
  assert.equal(result.relation, 'may');
  assert.ok(result.reasonCodes.includes('escape-unproven'));
  assert.ok(!result.reasonCodes.includes('distinct-non-escaping-allocation'));
});

test('#4977 only B non-escaping + distinct roots stays may', () => {
  const a = heap('alloc-a');
  const b = unknown('unknown-b');
  const result = aliasOf(a, b, new Set([b.rootEntityId]));
  assert.equal(result.relation, 'may');
  assert.ok(result.reasonCodes.includes('escape-unproven'));
  assert.ok(!result.reasonCodes.includes('distinct-non-escaping-allocation'));
});

test('#4977 both non-escaping + distinct allocation roots separates', () => {
  const a = heap('alloc-a');
  const b = heap('alloc-b');
  const result = aliasOf(a, b, new Set([a.rootEntityId, b.rootEntityId]));
  assert.equal(result.relation, 'no');
  assert.ok(result.reasonCodes.includes('distinct-non-escaping-allocation'));
});

test('#4977 neither non-escaping stays may', () => {
  const a = heap('alloc-a');
  const b = heap('alloc-b');
  const result = aliasOf(a, b, new Set());
  assert.equal(result.relation, 'may');
  assert.ok(result.reasonCodes.includes('escape-unproven'));
});

test('#4977 independent address-space separation is retained', () => {
  const a = createPointsToTarget({
    addressSpace: 'memory',
    rootKind: 'heap-like',
    rootIdentity: 'a',
    rootEntityId: 'alloc-a',
    offsetRange: exactRange(0),
    widthBits: 64,
  });
  const b = createPointsToTarget({
    addressSpace: 'tls',
    rootKind: 'tls-like',
    rootIdentity: 'b',
    rootEntityId: 'unknown-b',
    offsetRange: exactRange(0),
    widthBits: 64,
  });
  const result = aliasOf(a, b, new Set([a.rootEntityId]));
  assert.equal(result.relation, 'no');
  assert.ok(result.reasonCodes.includes('distinct-address-space'));
});

test('#4977 same-root disjoint field interval has no regression', () => {
  const a = createPointsToTarget({
    addressSpace: 'memory',
    rootKind: 'heap-like',
    rootIdentity: 'a',
    rootEntityId: 'alloc-a',
    offsetRange: exactRange(0),
    widthBits: 64,
  });
  const b = createPointsToTarget({
    addressSpace: 'memory',
    rootKind: 'heap-like',
    rootIdentity: 'a',
    rootEntityId: 'alloc-a',
    offsetRange: exactRange(8),
    widthBits: 64,
  });
  const result = aliasOf(a, b, new Set());
  assert.equal(result.relation, 'no');
  assert.ok(result.reasonCodes.includes('disjoint-field-interval'));
});
