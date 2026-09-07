import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPointsToSet,
  createPointsToTarget,
  exactRange,
} from '../../../js/analysis/pointsto/lattice.js';
import { pointsToAlias } from '../../../js/analysis/pointsto/alias.js';
import {
  createAnalysisStatus,
  isFailClosedStatus,
  satisfiesRequirement,
} from '../../../js/analysis/status.js';

function status(completeness, stopReason = null) {
  return createAnalysisStatus({
    snapshotId: 'issue-4011',
    analyzerId: 'issue-4011-test',
    analyzerVersion: '1',
    completeness,
    stopReason,
  });
}

function singletonAt(offset) {
  return createPointsToSet({
    targets: [createPointsToTarget({
      addressSpace: 'memory',
      rootKind: 'rooted',
      rootEntityId: 'root-A',
      offsetRange: exactRange(offset),
      widthBits: 64,
    })],
  });
}

test('#4011 iteration-limit cannot claim sound bounded completeness', () => {
  assert.throws(
    () => status('bounded', 'iteration-limit'),
    /analysis-status-aborted-cannot-be-bounded/,
  );
});

test('#4011 iteration-limited incomplete status is fail-closed for bounded consumers', () => {
  const limited = status('partial', 'iteration-limit');
  assert.equal(isFailClosedStatus(limited), true);
  assert.equal(satisfiesRequirement(limited, 'bounded'), false);
});

test('#4011 iteration-limited points-to cannot publish a strong no-alias answer', () => {
  const result = pointsToAlias(singletonAt(0n), singletonAt(16n), {
    status: status('partial', 'iteration-limit'),
    widthBitsLeft: 64,
    widthBitsRight: 64,
  });
  assert.equal(result.relation, 'unknown');
});

test('#4011 complete fixed points retain strong field-disjointness', () => {
  const result = pointsToAlias(singletonAt(0n), singletonAt(16n), {
    status: status('complete'),
    widthBitsLeft: 64,
    widthBitsRight: 64,
  });
  assert.equal(result.relation, 'no');
  assert.deepEqual(result.reasonCodes, ['disjoint-field-interval']);
});

test('#4011 widened bounded results remain usable and are not indiscriminately fail-closed', () => {
  const widened = status('bounded', 'widened');
  assert.equal(isFailClosedStatus(widened), false);
  assert.equal(satisfiesRequirement(widened, 'bounded'), true);

  const result = pointsToAlias(singletonAt(0n), singletonAt(16n), {
    status: widened,
    widthBitsLeft: 64,
    widthBitsRight: 64,
  });
  assert.equal(result.relation, 'no');
});
