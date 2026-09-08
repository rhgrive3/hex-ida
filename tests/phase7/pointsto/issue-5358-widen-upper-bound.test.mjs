import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPointsToTarget,
  createPointsToSet,
  exactRange,
  widenPointsTo,
  pointsToLessOrEqual,
} from '../../../js/analysis/pointsto/lattice.js';

function setOf(...ids) {
  return createPointsToSet({
    targets: ids.map((id) => createPointsToTarget({
      rootKind: 'allocation',
      rootEntityId: id,
      offsetRange: exactRange(0n),
      addressSpace: 'memory',
      address: null,
    })),
  });
}

// #5358: `widenPointsTo()` mapped only `next.targets`, so a root held only by
// `previous` disappeared from the widened set. Widening may lose precision,
// never reachability — the result must stay an upper bound of `previous`
// (previous ⊑ widened), otherwise the fixed point can converge below its own
// past state.

test('#5358 a previous-only root survives widening', () => {
  const widened = widenPointsTo(setOf('A'), setOf('B'));
  const roots = widened.targets.map((target) => target.rootEntityId);
  assert.ok(roots.includes('A'), 'the previous-only root must not be dropped');
  assert.ok(roots.includes('B'));
});

test('#5358 widening keeps the upper-bound law', () => {
  const previous = setOf('A', 'B');
  const next = setOf('B', 'C');
  const widened = widenPointsTo(previous, next);
  assert.equal(pointsToLessOrEqual(previous, widened), true);
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
