import assert from 'node:assert/strict';
import test from 'node:test';

import { stableDigest } from '../../../js/core/identity/index.js';
import {
  claimsConflict,
  createHardConstraint,
  createTypeClaim,
} from '../../../js/analysis/types/constraints.js';
import { TypeConstraintGraph } from '../../../js/analysis/types/graph.js';

const int32 = Object.freeze({ kind:'integer', widthBits:32, signed:true });
const float32 = Object.freeze({ kind:'float', widthBits:32 });

function member(name, offset, sizeBytes = 4, memberType = int32) {
  return { name, offset, sizeBytes, memberType };
}

function claim(entityId, members) {
  return createTypeClaim({
    layer:'structural',
    entityId,
    descriptor:{ kind:'struct', members },
  });
}

function hard(claimValue, evidenceId) {
  return createHardConstraint({
    kind:'debug-type',
    origin:'debug-matched',
    claim:claimValue,
    evidenceIds:[evidenceId],
  });
}

function permutations(values) {
  if (values.length < 2) return [values];
  return values.flatMap((value, index) => permutations([
    ...values.slice(0, index),
    ...values.slice(index + 1),
  ]).map((tail) => [value, ...tail]));
}

test('#5184 two-member permutation has one canonical descriptor and claim digest', () => {
  const a = member('a', 0);
  const b = member('b', 8);
  const left = claim('S', [a, b]);
  const right = claim('S', [b, a]);

  assert.equal(claimsConflict(left, right), false);
  assert.equal(left.key, right.key);
  assert.deepEqual(left.descriptor, right.descriptor);
  assert.deepEqual(left.descriptor.members.map((entry) => entry.offset), [0, 8]);
});

test('#5184 all permutations of three members preserve semantic identity', () => {
  const members = [member('a', 0), member('b', 8), member('c', 16)];
  const variants = permutations(members).map((order) => claim('P', order));
  const keys = new Set(variants.map((entry) => entry.key));

  assert.equal(keys.size, 1);
  for (const variant of variants) {
    assert.equal(claimsConflict(variants[0], variant), false);
    assert.deepEqual(variant.descriptor.members.map((entry) => entry.offset), [0, 8, 16]);
  }
});

test('#5184 canonicalization does not erase real size/type disagreement or offset identity', () => {
  const base = claim('C', [member('a', 0)]);
  const moved = claim('C', [member('a', 4)]);
  assert.notEqual(base.key, moved.key);
  assert.equal(claimsConflict(base, claim('C', [member('a', 0, 8)])), true);
  assert.equal(claimsConflict(base, claim('C', [member('a', 0, 4, float32)])), true);
});

test('#5184 exact duplicates dedupe while distinct overlapping members retain ambiguity', () => {
  const duplicate = member('a', 0);
  const overlapping = member('overlay', 0, 4, float32);
  const withDuplicate = claim('D', [duplicate, { ...duplicate }]);
  const singleton = claim('D', [duplicate]);
  const ambiguous = claim('O', [overlapping, duplicate]);

  assert.equal(withDuplicate.descriptor.members.length, 1);
  assert.equal(withDuplicate.key, singleton.key);
  assert.equal(ambiguous.descriptor.members.length, 2);
  assert.equal(claimsConflict(claim('O', [duplicate]), claim('O', [overlapping])), true);
});

test('#5184 graph result is invariant to provider insertion and member traversal order', () => {
  const a = member('a', 0);
  const b = member('b', 8);
  const forward = hard(claim('G', [a, b]), 'ev-forward');
  const reverse = hard(claim('G', [b, a]), 'ev-reverse');

  const solve = (constraints) => {
    const graph = new TypeConstraintGraph({ snapshotId:'issue-5184' });
    for (const constraint of constraints) graph.addHardConstraint(constraint);
    return graph.solveEntity('G');
  };

  const first = solve([forward, reverse]);
  const second = solve([reverse, forward]);
  assert.equal(first.status.analyzerVersion, '1.1.1');
  assert.equal(first.layers.structural.hardConstraints.length, 1);
  assert.equal(second.layers.structural.hardConstraints.length, 1);
  assert.equal(first.layers.structural.contradictions.length, 0);
  assert.equal(second.layers.structural.contradictions.length, 0);
  assert.deepEqual(first.layers.structural.selected, second.layers.structural.selected);
  assert.equal(stableDigest(first), stableDigest(second));
});
