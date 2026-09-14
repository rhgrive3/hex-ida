import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createOffsetRange,
  createPointsToTarget,
  createPointsToSet,
  exactRange,
  widenPointsTo,
  pointsToLessOrEqual,
} from '../../../js/analysis/pointsto/lattice.js';

function targetOf(id, offsetRange = exactRange(0n)) {
  return createPointsToTarget({
    rootKind: 'allocation',
    rootEntityId: id,
    offsetRange,
    addressSpace: 'memory',
    address: null,
  });
}

function setOf(...ids) {
  return createPointsToSet({
    targets: ids.map((id) => targetOf(id)),
  });
}

function rangedSet(id, min, max, lossReasons = []) {
  return createPointsToSet({
    targets: [targetOf(id, createOffsetRange(min, max))],
    lossReasons,
  });
}

// #5358: `widenPointsTo()` mapped only `next.targets`, so a root held only by
// `previous` disappeared from the widened set. Widening may lose precision,
// never reachability or already-recorded provenance loss — the result must stay
// an upper bound of both inputs while retaining their loss reasons.

test('#5358 a previous-only root survives widening', () => {
  const widened = widenPointsTo(setOf('A'), setOf('B'));
  const roots = widened.targets.map((target) => target.rootEntityId);
  assert.ok(roots.includes('A'), 'the previous-only root must not be dropped');
  assert.ok(roots.includes('B'));
});

test('#5358 widening keeps both upper-bound directions', () => {
  const previous = setOf('A', 'B');
  const next = setOf('B', 'C');
  const widened = widenPointsTo(previous, next);
  assert.equal(pointsToLessOrEqual(previous, widened), true, 'previous must be below widened');
  assert.equal(pointsToLessOrEqual(next, widened), true, 'next must be below widened');
});

test('#5358 same-root range growth widens conservatively', () => {
  const previous = rangedSet('A', 0n, 0n);
  const next = rangedSet('A', 0n, 4n);
  const widened = widenPointsTo(previous, next);
  const [target] = widened.targets;

  assert.equal(target.offsetRange.min, 0n);
  assert.equal(target.offsetRange.max, null, 'outward max growth must widen to +infinity');
  assert.equal(pointsToLessOrEqual(previous, widened), true);
  assert.equal(pointsToLessOrEqual(next, widened), true);
  assert.ok(widened.lossReasons.includes('widened'));
});

test('#5358 stable same-root input does not spuriously gain widened provenance', () => {
  const previous = rangedSet('A', -2n, 3n);
  const next = rangedSet('A', -2n, 3n);
  const widened = widenPointsTo(previous, next);
  assert.equal(widened.lossReasons.includes('widened'), false);
});

test('#5358 prior-only loss reasons survive widening', () => {
  const previous = rangedSet('A', 0n, 0n, ['unresolved-load']);
  const next = rangedSet('A', 0n, 0n);
  const widened = widenPointsTo(previous, next);

  assert.deepEqual(widened.lossReasons, ['unresolved-load']);
});

test('#5358 a previous-only root still counts as a widened step', () => {
  // The fixed point relies on the `widened` loss reason to know that the
  // result changed shape; a root that only exists in `previous` is exactly
  // such a step.
  const widened = widenPointsTo(setOf('A'), setOf('B'));
  assert.ok(widened.lossReasons.includes('widened'));
});

test('#5358 the target cap still bounds the merged set', () => {
  const previous = setOf('extra-a', 'extra-b');
  const next = setOf('r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8');
  const widened = widenPointsTo(previous, next, { maxTargetsPerSet: 8 });
  assert.equal(widened.top, true);
  assert.ok(widened.lossReasons.includes('target-cap'));
});
