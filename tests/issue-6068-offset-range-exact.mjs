import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPointsToSet,
  createPointsToTarget,
  exactRange,
} from '../js/analysis/pointsto/lattice.js';
import { pointsToAlias } from '../js/analysis/pointsto/alias.js';

const base = {
  addressSpace: 'memory',
  rootKind: 'rooted',
  rootIdentity: { id: 'same-root' },
  rootEntityId: 'same-root',
};

const status = {
  snapshotId: 's',
  analyzerId: 'test',
  analyzerVersion: '1',
  completeness: 'complete',
  stopReason: null,
};

function alias(leftRange, rightRange) {
  const left = createPointsToTarget({ ...base, offsetRange: leftRange });
  const right = createPointsToTarget({ ...base, offsetRange: rightRange });
  return {
    left,
    result: pointsToAlias(
      createPointsToSet({ targets: [left] }),
      createPointsToSet({ targets: [right] }),
      { widthBitsLeft: 64, widthBitsRight: 64, status },
    ),
  };
}

test('6068: forged exact flag is re-derived on the way in', () => {
  const target = createPointsToTarget({ ...base, offsetRange: { min: 0n, max: 100n, exact: true } });
  assert.equal(target.offsetRange.exact, false);
  assert.equal(target.offsetRange.min, 0n);
  assert.equal(target.offsetRange.max, 100n);
});

test('6068: overlapping wide range is not strong NoAlias', () => {
  const { result } = alias({ min: 0n, max: 100n, exact: true }, exactRange(8));
  assert.notEqual(result.relation, 'no');
});

test('6068: wide range against exact origin is not MustAlias', () => {
  const { result } = alias({ min: 0n, max: 100n, exact: true }, exactRange(0));
  assert.notEqual(result.relation, 'must');
});

test('6068: genuine exact ranges keep strong answers', () => {
  const { result: must } = alias(exactRange(0), exactRange(0));
  assert.equal(must.relation, 'must');
  const { result: no } = alias(exactRange(0), exactRange(100));
  assert.equal(no.relation, 'no');
});
