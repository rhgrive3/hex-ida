import assert from 'node:assert/strict';
import test from 'node:test';

import { pointsToAlias } from '../../../js/analysis/pointsto/alias.js';
import { createPointsToSet, createPointsToTarget, exactRange } from '../../../js/analysis/pointsto/lattice.js';
import { createAnalysisStatus } from '../../../js/analysis/status.js';

const completeStatus = createAnalysisStatus({
  snapshotId: 'snapshot-t053-alias-completeness',
  analyzerId: 'phase7.alias.t053-fixture',
  analyzerVersion: '1.0.0',
  completeness: 'complete',
});

function singleton(target) {
  return createPointsToSet({ targets: [createPointsToTarget(target)] });
}

function objectAt(offset) {
  return singleton({
    addressSpace: 'memory',
    rootKind: 'heap',
    rootIdentity: 'fixture-object',
    offsetRange: exactRange(offset),
  });
}

function aliasOptions(status) {
  return { status, widthBitsLeft: 64, widthBitsRight: 64 };
}

test('T053: exact alias answers require the fixture completeness authority', () => {
  const mustAlias = pointsToAlias(objectAt(0n), objectAt(0n), aliasOptions(completeStatus));
  assert.equal(mustAlias.relation, 'must');
  assert.equal(mustAlias.status.completeness, 'complete');
  assert.equal(mustAlias.status.snapshotId, completeStatus.snapshotId);

  const noAlias = pointsToAlias(objectAt(0n), objectAt(8n), aliasOptions(completeStatus));
  assert.equal(noAlias.relation, 'no');
  assert.ok(noAlias.reasonCodes.includes('disjoint-field-interval'));
  assert.equal(noAlias.status.completeness, 'complete');
});

test('T053: missing, stale, and non-exhaustive authority never publish exact alias answers', () => {
  const left = objectAt(0n);
  const right = objectAt(0n);

  // A direct low-level query without an authority envelope must fail closed;
  // it must not manufacture a strong answer from the intervals alone.
  assert.throws(
    () => pointsToAlias(left, right, { widthBitsLeft: 64, widthBitsRight: 64 }),
    /analysis-status-completeness-required/,
    'missing completeness authority must not mint MustAlias',
  );

  const staleStatus = createAnalysisStatus({
    snapshotId: 'snapshot-old',
    analyzerId: 'phase7.alias.t053-fixture',
    analyzerVersion: '0.9.0',
    completeness: 'partial',
    stopReason: 'dependency-mismatch',
  });
  const stale = pointsToAlias(left, right, aliasOptions(staleStatus));
  assert.equal(stale.relation, 'unknown');
  assert.notEqual(stale.relation, 'must');
  assert.notEqual(stale.relation, 'no');
  assert.equal(stale.status.stopReason, 'dependency-mismatch');

  const nonExhaustiveStatus = createAnalysisStatus({
    snapshotId: completeStatus.snapshotId,
    analyzerId: completeStatus.analyzerId,
    analyzerVersion: completeStatus.analyzerVersion,
    completeness: 'partial',
    stopReason: 'evidence-missing',
  });
  const nonExhaustive = pointsToAlias(left, right, aliasOptions(nonExhaustiveStatus));
  assert.equal(nonExhaustive.relation, 'unknown');
  assert.notEqual(nonExhaustive.relation, 'must');
  assert.notEqual(nonExhaustive.relation, 'no');
  assert.equal(nonExhaustive.status.completeness, 'partial');
  assert.equal(nonExhaustive.status.stopReason, 'evidence-missing');
});
