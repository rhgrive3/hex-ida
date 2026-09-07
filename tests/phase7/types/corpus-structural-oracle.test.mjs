import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TypeConstraintGraph,
  selectedTypeIfCertain,
} from '../../../js/analysis/types/graph.js';
import {
  TYPE_CASES,
  caseConstraints,
  caseExpectations,
} from '../corpus/types.mjs';

function solveCorpusCase(id) {
  const testCase = TYPE_CASES.find((entry) => entry.id === id);
  assert.ok(testCase, `missing frozen type-corpus case: ${id}`);
  const graph = new TypeConstraintGraph({ snapshotId: `structural-oracle:${id}` });
  const { hard, soft } = caseConstraints(testCase, { withDebug: true });
  for (const constraint of hard) graph.addHardConstraint(constraint);
  for (const evidence of soft) graph.addSoftEvidence(evidence);
  return { testCase, result: graph.solveEntity(testCase.entityId) };
}

test('the frozen disjoint-field truth is the complete 12-byte aggregate', () => {
  const { testCase, result } = solveCorpusCase('t-disjoint-fields-coexist');
  const truth = caseExpectations(testCase, { withDebug: true }).truth.structural;
  const layer = result.layers.structural;

  assert.equal(layer.confidence, 'certain');
  assert.equal(layer.contradictions.length, 0);
  assert.deepEqual(layer.selected.descriptor, truth);
  assert.deepEqual(layer.selected.descriptor.members.map(({ offset, sizeBytes }) => ({ offset, sizeBytes })), [
    { offset: 0, sizeBytes: 4 },
    { offset: 8, sizeBytes: 4 },
  ]);
});

test('the frozen soft tie remains ambiguous instead of becoming an exact type', () => {
  const { testCase, result } = solveCorpusCase('t-soft-tie-is-ambiguous');
  const truth = caseExpectations(testCase, { withDebug: true }).truth.nominal;
  const layer = result.layers.nominal;

  assert.equal(truth, null);
  assert.equal(layer.confidence, 'unknown');
  assert.equal(layer.selected, null);
  assert.equal(layer.candidates.length, 2);
  assert.equal(selectedTypeIfCertain(result, 'nominal'), null);
});
