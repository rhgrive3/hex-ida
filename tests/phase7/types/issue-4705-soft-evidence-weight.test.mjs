import assert from 'node:assert/strict';
import test from 'node:test';

import { createSoftEvidence } from '../../../js/analysis/types/constraints.js';
import { TypeConstraintGraph } from '../../../js/analysis/types/graph.js';

const claim = Object.freeze({
  layer: 'nominal',
  entityId: 'v0',
  descriptor: Object.freeze({ name: 'Candidate' }),
});

function evidence(weightMarker = Symbol.for('omitted')) {
  const input = {
    kind: 'decompiler-hint',
    origin: 'heuristic',
    claim,
    evidenceIds: ['issue-4705'],
  };
  if (weightMarker !== Symbol.for('omitted')) input.weight = weightMarker;
  return input;
}

test('#4705 omitted/nullish weight keeps documented 0.5 default and primitive numeric weights stay exact', () => {
  assert.equal(createSoftEvidence(evidence()).weight, 0.5);
  assert.equal(createSoftEvidence(evidence(undefined)).weight, 0.5);
  assert.equal(createSoftEvidence(evidence(null)).weight, 0.5);
  for (const weight of [0, -0, 0.25, 0.5, 0.75, 1]) {
    assert.equal(Object.is(createSoftEvidence(evidence(weight)).weight, weight), true, `weight ${weight} changed`);
  }
});

test('#4705 coercible non-number weights are rejected instead of becoming ranking authority', () => {
  for (const weight of [true, false, '1', '0.75', ['1'], [1], {}, new Number(1)]) {
    assert.throws(
      () => createSoftEvidence(evidence(weight)),
      /soft-evidence-invalid-weight/,
      `accepted malformed weight ${Object.prototype.toString.call(weight)}`,
    );
  }
  for (const weight of [NaN, Infinity, -Infinity, -0.01, 1.01]) {
    assert.throws(() => createSoftEvidence(evidence(weight)), /soft-evidence-invalid-weight/);
  }
});

test('#4705 weight validation does not invoke caller-owned coercion hooks', () => {
  let coercions = 0;
  const weight = {
    [Symbol.toPrimitive]() {
      coercions += 1;
      return 1;
    },
  };
  assert.throws(() => createSoftEvidence(evidence(weight)), /soft-evidence-invalid-weight/);
  assert.equal(coercions, 0);
});

test('#4705 malformed maximum weight cannot create a probable graph candidate or ghost entity', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-4705' });
  assert.throws(
    () => graph.addSoftEvidence(evidence(true)),
    /soft-evidence-invalid-weight/,
  );
  assert.deepEqual(graph.entityIds(), []);
  const result = graph.solveEntity('v0');
  assert.equal(result.status.completeness, 'unsupported');
  assert.equal(result.status.stopReason, 'evidence-missing');
});

test('#4705 valid ranking threshold semantics remain unchanged', () => {
  const possible = new TypeConstraintGraph({ snapshotId: 'issue-4705-possible' });
  possible.addSoftEvidence(evidence(0.74));
  const possibleResult = possible.solveEntity('v0');
  assert.equal(possibleResult.layers.nominal.confidence, 'possible');
  assert.equal(possibleResult.layers.nominal.candidates[0].weight, 0.74);

  const probable = new TypeConstraintGraph({ snapshotId: 'issue-4705-probable' });
  probable.addSoftEvidence(evidence(0.75));
  const probableResult = probable.solveEntity('v0');
  assert.equal(probableResult.layers.nominal.confidence, 'probable');
  assert.equal(probableResult.layers.nominal.candidates[0].weight, 0.75);
});
