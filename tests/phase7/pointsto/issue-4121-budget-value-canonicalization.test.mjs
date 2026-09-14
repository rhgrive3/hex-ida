import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPointsToSet,
  createPointsToTarget,
  exactRange,
  joinPointsTo,
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

// #4121: a structured / non-canonical budget must never act as a target cap
// through JS implicit coercion (`2 > ['1']`). Every non primitive positive
// safe-integer cap must be rejected at the lattice boundary instead.
test('#4121 structured maxTargetsPerSet is rejected, not coerced', () => {
  const left = pointsTo('a');
  const right = pointsTo('b');
  for (const bad of ['1', ['1'], true, {}, NaN, Infinity, 0, -1, 1.5]) {
    assert.throws(
      () => joinPointsTo(left, right, { maxTargetsPerSet: bad }),
      /points-to-invalid-max-targets-per-set/,
      `maxTargetsPerSet=${String(bad)} must be rejected rather than coerced`,
    );
  }
});

test('#4121 canonical numeric maxTargetsPerSet is still accepted', () => {
  const cap = joinPointsTo(pointsTo('a'), pointsTo('b'), { maxTargetsPerSet: 1 });
  assert.equal(cap.top, true);
  assert.ok(cap.lossReasons.includes('target-cap'));
});
