import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPointsToSet,
  joinPointsTo,
  pointsToDigest,
  pointsToEqual,
} from '../../../js/analysis/pointsto/lattice.js';

function setWithEvidence(ids) {
  return createPointsToSet({
    targets: [{ rootKey: 'root-1', offsetRange: { min: 0n, max: 8n }, widthBits: 64, evidenceIds: ids }],
  });
}

test('#5629 provenance-only joins must be observable as fixed-point growth', () => {
  const a = setWithEvidence(['e1']);
  const b = setWithEvidence(['e2']);
  // Same root/range/width, different provenance: the join unions the ids, so
  // the fixed-point equality must see the difference.
  assert.equal(pointsToEqual(a, b), false);
  const joined = joinPointsTo(a, b);
  assert.deepEqual(joined.targets[0].evidenceIds, ['e1', 'e2']);
  assert.notEqual(pointsToDigest(joined), pointsToDigest(a));
  assert.equal(pointsToEqual(joined, a), false);
});

test('#5629 identical provenance keeps structural equality', () => {
  const a = setWithEvidence(['e1', 'e2']);
  const b = setWithEvidence(['e2', 'e1']);
  assert.equal(pointsToEqual(a, b), true, 'same canonical id set must stay equal');
  const joined = joinPointsTo(a, b);
  assert.equal(pointsToEqual(joined, a), true);
});

test('#5629 a fixed-point iteration converges after provenance stabilizes', () => {
  // Simulate the local solver loop: transferring the same fact twice first
  // grows provenance, then stabilizes — the loop must stop only after the
  // provenance step, not before it.
  let iteration = 0;
  let current = setWithEvidence([]);
  const seen = [];
  while (iteration < 4) {
    iteration += 1;
    const incoming = setWithEvidence(iteration === 1 ? ['e1'] : ['e1']);
    const next = joinPointsTo(current, incoming);
    if (pointsToEqual(current, next)) break;
    seen.push(next.targets[0].evidenceIds.length);
    current = next;
  }
  assert.deepEqual(seen, [1], 'exactly one provenance growth step, then convergence');
});
