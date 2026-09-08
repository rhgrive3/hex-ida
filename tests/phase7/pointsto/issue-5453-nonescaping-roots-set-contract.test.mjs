import test from 'node:test';
import assert from 'node:assert/strict';

import { pointsToAlias } from '../../../js/analysis/pointsto/alias.js';
import { createAnalysisStatus } from '../../../js/analysis/status.js';
import {
  createPointsToSet, createPointsToTarget, exactRange,
} from '../../../js/analysis/pointsto/lattice.js';

function rootedSet(entity, evidenceId) {
  return createPointsToSet({
    targets: [createPointsToTarget({
      addressSpace: 'memory',
      rootKind: 'rooted',
      rootEntityId: entity,
      offsetRange: exactRange(0),
      widthBits: 64,
      evidenceIds: [evidenceId],
    })],
  });
}

test('#5453 a truthy non-Set nonEscapingRoots fails closed at the boundary, not with a raw TypeError mid-comparison', () => {
  const left = rootedSet('A', 'e1');
  const right = rootedSet('B', 'e2');

  assert.throws(
    () => pointsToAlias(left, right, { widthBitsLeft: 64, widthBitsRight: 64, nonEscapingRoots: [] }),
    (error) => error instanceof TypeError
      && error.message === 'phase7-alias-nonescaping-roots-set-required',
    'an Array must be rejected with the contract error',
  );

  assert.throws(
    () => pointsToAlias(left, right, { widthBitsLeft: 64, widthBitsRight: 64, nonEscapingRoots: 'A' }),
    (error) => error instanceof TypeError
      && error.message === 'phase7-alias-nonescaping-roots-set-required',
    'a string must be rejected with the contract error',
  );

  assert.throws(
    () => pointsToAlias(left, right, { widthBitsLeft: 64, widthBitsRight: 64, nonEscapingRoots: { has: null } }),
    (error) => error instanceof TypeError
      && error.message === 'phase7-alias-nonescaping-roots-set-required',
    'an object without a callable has() must be rejected',
  );
});

test('#5453 Set-shaped nonEscapingRoots and omission keep their existing semantics', () => {
  const left = rootedSet('A', 'e1');
  const right = rootedSet('B', 'e2');
  const complete = createAnalysisStatus({
    snapshotId: 'snapshot_issue_5453',
    analyzerId: 'pointsto-test',
    analyzerVersion: '1',
    completeness: 'complete',
  });

  const omitting = pointsToAlias(left, right, { status: complete, widthBitsLeft: 64, widthBitsRight: 64 });
  assert.equal(omitting.relation, 'may', 'without the proof, distinct roots stay may');

  const empty = pointsToAlias(left, right, {
    status: complete, widthBitsLeft: 64, widthBitsRight: 64, nonEscapingRoots: new Set(),
  });
  assert.equal(empty.relation, 'may', 'an empty Set is not a separation proof');

  const proven = pointsToAlias(left, right, {
    status: complete, widthBitsLeft: 64, widthBitsRight: 64, nonEscapingRoots: new Set(['A']),
  });
  assert.equal(proven.relation, 'no', 'a real Set with a proven root still separates');
  assert.ok(proven.reasonCodes.includes('distinct-non-escaping-allocation'));
});
