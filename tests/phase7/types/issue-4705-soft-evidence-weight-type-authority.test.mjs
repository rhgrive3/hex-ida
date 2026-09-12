import assert from 'node:assert/strict';
import {
  createSoftEvidence,
} from '../../../js/analysis/types/constraints.js';
import { TypeConstraintGraph } from '../../../js/analysis/types/graph.js';

console.log('Testing #4705: soft evidence weight must reject Number() coercion...');

const nominal = (entityId, name) => ({ layer: 'nominal', entityId, descriptor: { name } });

function soft(weight) {
  return { kind: 'decompiler-hint', origin: 'heuristic', weight, claim: nominal('v0', 'Candidate') };
}

function weightOf(input) {
  return createSoftEvidence({
    kind: 'decompiler-hint',
    origin: 'heuristic',
    claim: nominal('v0', 'Candidate'),
    ...input,
  }).weight;
}

// 1. omitted / nullish weight falls back to the documented default 0.5
assert.equal(weightOf({}), 0.5);
assert.equal(weightOf({ weight: undefined }), 0.5);
assert.equal(weightOf({ weight: null }), 0.5);

// 2. primitive finite numbers inside [0,1] are accepted and preserved exactly
assert.equal(weightOf({ weight: 0 }), 0);
assert.equal(weightOf({ weight: 0.5 }), 0.5);
assert.equal(weightOf({ weight: 1 }), 1);
assert.equal(weightOf({ weight: 0.9 }), 0.9);

// 3. booleans must not coerce into ranking authority
assert.throws(() => createSoftEvidence(soft(true)), /soft-evidence-invalid-weight/);
assert.throws(() => createSoftEvidence(soft(false)), /soft-evidence-invalid-weight/);

// 4. numeric strings, single-element arrays, boxed numbers and coercible
//    objects must not launder into a valid weight
assert.throws(() => createSoftEvidence(soft('1')), /soft-evidence-invalid-weight/);
assert.throws(() => createSoftEvidence(soft('0.9')), /soft-evidence-invalid-weight/);
assert.throws(() => createSoftEvidence(soft(['1'])), /soft-evidence-invalid-weight/);
assert.throws(() => createSoftEvidence(soft([1])), /soft-evidence-invalid-weight/);
assert.throws(() => createSoftEvidence(soft(new Number(0.5))), /soft-evidence-invalid-weight/);
assert.throws(() => createSoftEvidence(soft({ valueOf: () => 1 })), /soft-evidence-invalid-weight/);

// 5. non-finite and out-of-range numbers are rejected
assert.throws(() => createSoftEvidence(soft(NaN)), /soft-evidence-invalid-weight/);
assert.throws(() => createSoftEvidence(soft(Infinity)), /soft-evidence-invalid-weight/);
assert.throws(() => createSoftEvidence(soft(-Infinity)), /soft-evidence-invalid-weight/);
assert.throws(() => createSoftEvidence(soft(-1)), /soft-evidence-invalid-weight/);
assert.throws(() => createSoftEvidence(soft(1.1)), /soft-evidence-invalid-weight/);

// 6. a malformed weight can no longer mint a probable singleton candidate
assert.throws(() => {
  const graph = new TypeConstraintGraph({ snapshotId: 'snapshot_4705' });
  graph.addSoftEvidence({
    kind: 'decompiler-hint',
    origin: 'heuristic',
    weight: true,
    claim: nominal('v0', 'InjectedCandidate'),
  });
}, /soft-evidence-invalid-weight/);

// 7. valid numeric soft ranking and the probable/possible threshold hold
{
  const probable = new TypeConstraintGraph({ snapshotId: 'snapshot_4705' });
  probable.addSoftEvidence(soft(0.9));
  const probableResult = probable.solveEntity('v0').layers.nominal;
  assert.equal(probableResult.confidence, 'probable');
  assert.equal(probableResult.selected.descriptor.name, 'Candidate');
  assert.equal(probableResult.candidates[0].weight, 0.9);

  const possible = new TypeConstraintGraph({ snapshotId: 'snapshot_4705' });
  possible.addSoftEvidence({
    kind: 'decompiler-hint',
    origin: 'heuristic',
    weight: 0.5,
    claim: nominal('v0', 'LowWeight'),
  });
  assert.equal(possible.solveEntity('v0').layers.nominal.confidence, 'possible');

  const ranked = new TypeConstraintGraph({ snapshotId: 'snapshot_4705' });
  ranked.addSoftEvidence({
    kind: 'decompiler-hint',
    origin: 'heuristic',
    weight: 0.9,
    claim: nominal('v0', 'Lower'),
  });
  ranked.addSoftEvidence({
    kind: 'symbol-spelling',
    origin: 'heuristic',
    weight: 1,
    claim: nominal('v0', 'Higher'),
  });
  const rankedLayer = ranked.solveEntity('v0').layers.nominal;
  assert.equal(rankedLayer.selected.descriptor.name, 'Higher');
  assert.equal(rankedLayer.candidates[0].weight, 1);
  assert.equal(rankedLayer.confidence, 'probable');
}

console.log('#4705 tests passed successfully.');
