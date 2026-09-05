import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPointsToSet,
  createPointsToTarget,
  exactRange,
} from '../js/analysis/pointsto/lattice.js';
import { pointsToAlias } from '../js/analysis/pointsto/alias.js';

const status = {
  snapshotId: 's',
  analyzerId: 'test',
  analyzerVersion: '1',
  completeness: 'complete',
  stopReason: null,
};

function target(rootEntityId) {
  return createPointsToTarget({
    addressSpace: 'memory',
    rootKind: 'rooted',
    rootEntityId,
    separationClass: 'heap-like',
    separationAuthority: 'root-descriptor',
    offsetRange: exactRange(0),
  });
}

test('6063: rootEntityId is stored canonicalized', () => {
  assert.equal(target(' root ').rootEntityId, 'root');
  assert.equal(target('root').rootEntityId, 'root');
  assert.equal(target('   ').rootEntityId, null);
});

test('6063: whitespace variants of one root are not distinct roots', () => {
  const left = createPointsToSet({ targets: [target('root')] });
  const right = createPointsToSet({ targets: [target(' root ')] });
  const result = pointsToAlias(left, right, { widthBitsLeft: 64, widthBitsRight: 64, status });
  assert.notEqual(result.relation, 'no');
  assert.ok(!result.reasonCodes.includes('distinct-proven-root'));
});

test('6063: genuinely distinct roots still separate', () => {
  const left = createPointsToSet({ targets: [target('a')] });
  const right = createPointsToSet({ targets: [target('b')] });
  const result = pointsToAlias(left, right, { widthBitsLeft: 64, widthBitsRight: 64, status });
  assert.equal(result.relation, 'no');
});
