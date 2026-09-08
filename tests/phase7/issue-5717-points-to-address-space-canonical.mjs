// Regression for #5717: points-to addressSpace is an identity string.
// Non-canonical spelling (whitespace differences) must never mint a strong
// NoAlias ("distinct-address-space") separation proof.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPointsToTarget, createPointsToSet, exactRange } from '../../js/analysis/pointsto/lattice.js';
import { pointsToAlias } from '../../js/analysis/pointsto/alias.js';
import { createAnalysisStatus } from '../../js/analysis/status.js';

const status = createAnalysisStatus({
  snapshotId: 'snap-5717',
  analyzerId: 'issue-5717-regression',
  analyzerVersion: '1',
  completeness: 'complete',
});

function target(space, entityId) {
  return createPointsToTarget({
    addressSpace: space,
    rootKind: 'rooted',
    rootEntityId: entityId,
    offsetRange: exactRange(0n),
  });
}

function alias(leftSpace, rightSpace) {
  return pointsToAlias(
    createPointsToSet({ targets: [target(leftSpace, 'left')] }),
    createPointsToSet({ targets: [target(rightSpace, 'right')] }),
    { status, widthBitsLeft: 64, widthBitsRight: 64 },
  );
}

test('#5717 whitespace-only addressSpace difference is canonicalized at target creation', () => {
  assert.equal(createPointsToTarget({ addressSpace: 'memory ' }).addressSpace, 'memory');
  assert.equal(createPointsToTarget({ addressSpace: ' \ttls\n' }).addressSpace, 'tls');
  // Blank/structured values fall back to the fail-closed unknown space.
  assert.equal(createPointsToTarget({ addressSpace: '   ' }).addressSpace, 'unknown');
  assert.equal(createPointsToTarget({ addressSpace: 42 }).addressSpace, 'unknown');
  assert.equal(createPointsToTarget({}).addressSpace, 'memory');
});

test('#5717 "memory" vs "memory " must not produce a NoAlias separation proof', () => {
  const result = alias('memory', 'memory ');
  assert.notEqual(result.relation, 'no');
  assert.ok(!result.reasonCodes.includes('distinct-address-space'));
});

test('#5717 canonicalized targets in the same space compare by real storage relation', () => {
  // After canonicalization both targets share the address space; distinct roots
  // without separation evidence must stay `may` (escape unproven).
  const result = alias('memory ', ' memory');
  assert.equal(result.relation, 'may');
  assert.ok(result.reasonCodes.includes('escape-unproven'));
});

test('#5717 genuinely distinct canonical address spaces still separate', () => {
  const result = alias('memory', 'tls');
  assert.equal(result.relation, 'no');
  assert.ok(result.reasonCodes.includes('distinct-address-space'));
});

test('#5717 raw non-canonical passthrough values cannot mint separation in pointsToAlias', () => {
  // Simulate a target object that skipped createPointsToTarget canonicalization:
  // the alias layer itself must refuse non-trimmed space strings as proof.
  const raw = (space) => ({
    rootKey: `raw:${space}`,
    addressSpace: space,
    rootKind: 'rooted',
    rootEntityId: 'raw',
    offsetRange: exactRange(0n),
  });
  const result = pointsToAlias(
    createPointsToSet({ targets: [raw('memory')] }),
    createPointsToSet({ targets: [raw('memory ')] }),
    { status, widthBitsLeft: 64, widthBitsRight: 64 },
  );
  assert.notEqual(result.relation, 'no');
  assert.ok(!result.reasonCodes.includes('distinct-address-space'));
});
