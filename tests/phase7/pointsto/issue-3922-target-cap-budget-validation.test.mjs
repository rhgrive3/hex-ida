import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPointsToSet,
  createPointsToTarget,
  exactRange,
  joinPointsTo,
  topPointsTo,
  widenPointsTo,
} from '../../../js/analysis/pointsto/lattice.js';

function target(id) {
  return createPointsToTarget({
    rootKind: 'rooted',
    rootEntityId: id,
    offsetRange: exactRange(0n),
  });
}

function pointsTo(...ids) {
  return createPointsToSet({ targets: ids.map(target) });
}

function assertTargetCap(result, message) {
  assert.equal(result.top, true, message);
  assert.ok(result.lossReasons.includes('target-cap'), message);
}

test('default and nullish target caps remain bounded at eight roots', () => {
  const left = pointsTo('r0', 'r1', 'r2', 'r3');
  const fourMore = pointsTo('r4', 'r5', 'r6', 'r7');
  const fiveMore = pointsTo('r4', 'r5', 'r6', 'r7', 'r8');

  const exactDefault = joinPointsTo(left, fourMore);
  assert.equal(exactDefault.top, false);
  assert.equal(exactDefault.targets.length, 8);

  assertTargetCap(joinPointsTo(left, fiveMore), 'omitted budget uses default cap');
  assertTargetCap(joinPointsTo(left, fiveMore, null), 'null budget uses default cap');
});

test('valid primitive integer cap preserves join and widening semantics', () => {
  assertTargetCap(
    joinPointsTo(pointsTo('a'), pointsTo('b'), { maxTargetsPerSet: 1 }),
    'join cap',
  );

  assertTargetCap(
    widenPointsTo(pointsTo('a'), pointsTo('a', 'b'), { maxTargetsPerSet: 1 }),
    'widen cap',
  );

  const joined = joinPointsTo(pointsTo('a', 'b'), pointsTo('c'), { maxTargetsPerSet: 8 });
  assert.equal(joined.top, false);
  assert.equal(joined.targets.length, 3);
});

test('join and widening reject malformed target caps without numeric coercion', () => {
  const invalid = [
    NaN,
    Infinity,
    -Infinity,
    1.5,
    0,
    -1,
    '8',
    [8],
    true,
    {},
    8n,
  ];

  for (const maxTargetsPerSet of invalid) {
    assert.throws(
      () => joinPointsTo(pointsTo('a'), pointsTo('b'), { maxTargetsPerSet }),
      /points-to-invalid-max-targets-per-set/,
      `join maxTargetsPerSet=${String(maxTargetsPerSet)}`,
    );
    assert.throws(
      () => widenPointsTo(pointsTo('a'), pointsTo('a', 'b'), { maxTargetsPerSet }),
      /points-to-invalid-max-targets-per-set/,
      `widen maxTargetsPerSet=${String(maxTargetsPerSet)}`,
    );
  }

  let coercions = 0;
  const structured = {
    [Symbol.toPrimitive]() {
      coercions += 1;
      return 8;
    },
  };
  assert.throws(
    () => joinPointsTo(pointsTo('a'), pointsTo('b'), { maxTargetsPerSet: structured }),
    /points-to-invalid-max-targets-per-set/,
  );
  assert.throws(
    () => widenPointsTo(pointsTo('a'), pointsTo('a', 'b'), { maxTargetsPerSet: structured }),
    /points-to-invalid-max-targets-per-set/,
  );
  assert.equal(coercions, 0);
});

test('budget validation is an exported API boundary even on lattice short-circuits', () => {
  const malformed = { maxTargetsPerSet: NaN };
  assert.throws(
    () => joinPointsTo(topPointsTo('widened'), pointsTo('a'), malformed),
    /points-to-invalid-max-targets-per-set/,
  );
  assert.throws(
    () => widenPointsTo(null, pointsTo('a'), malformed),
    /points-to-invalid-max-targets-per-set/,
  );
});
