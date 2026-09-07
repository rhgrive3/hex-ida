import assert from 'node:assert/strict';
import test from 'node:test';

import { TypeConstraintGraph, selectedTypeIfCertain } from '../js/analysis/types/graph.js';

const hard = (entityId, widthBits) => ({
  kind: 'access-width',
  origin: 'binary-evidence',
  claim: { layer: 'machine', entityId, descriptor: { widthBits, class: 'integer' } },
});

test('issue-6245: contradiction cap reached exactly at last pair stays complete', () => {
  const graph = new TypeConstraintGraph({
    snapshotId: 's',
    limits: { maxContradictionsPerLayer: 1 },
  });
  graph.addHardConstraint(hard('v0', 32));
  graph.addHardConstraint(hard('v0', 64));
  const result = graph.solveEntity('v0');
  assert.equal(result.status.completeness, 'complete');
  assert.equal(result.status.stopReason, null);
  assert.equal(result.layers.machine.contradictions.length, 1);
  assert.equal(selectedTypeIfCertain(result, 'machine'), null);
});

test('issue-6245: extra conflict beyond the cap truncates with budget-exhausted', () => {
  const graph = new TypeConstraintGraph({
    snapshotId: 's',
    limits: { maxContradictionsPerLayer: 1 },
  });
  graph.addHardConstraint(hard('v0', 8));
  graph.addHardConstraint(hard('v0', 16));
  graph.addHardConstraint(hard('v0', 32));
  const result = graph.solveEntity('v0');
  assert.equal(result.status.completeness, 'truncated');
  assert.equal(result.status.stopReason, 'budget-exhausted');
  assert.equal(result.layers.machine.contradictions.length, 1);
  assert.equal(selectedTypeIfCertain(result, 'machine'), null);
});

test('issue-6245: contradictions below the cap remain complete', () => {
  const graph = new TypeConstraintGraph({
    snapshotId: 's',
    limits: { maxContradictionsPerLayer: 4 },
  });
  graph.addHardConstraint(hard('v0', 32));
  graph.addHardConstraint(hard('v0', 64));
  const result = graph.solveEntity('v0');
  assert.equal(result.status.completeness, 'complete');
  assert.equal(result.status.stopReason, null);
  assert.equal(result.layers.machine.contradictions.length, 1);
});

test('issue-6245: comparison budget with remaining pairs still truncates', () => {
  const graph = new TypeConstraintGraph({
    snapshotId: 's',
    limits: { maxConstraintsPerLayer: 16, maxComparisonsPerLayer: 1, maxContradictionsPerLayer: 16 },
  });
  graph.addHardConstraint(hard('v0', 8));
  graph.addHardConstraint(hard('v0', 16));
  graph.addHardConstraint(hard('v0', 32));
  const result = graph.solveEntity('v0');
  assert.equal(result.status.completeness, 'truncated');
  assert.equal(result.status.stopReason, 'budget-exhausted');
  assert.equal(selectedTypeIfCertain(result, 'machine'), null);
});

test('issue-6245: solveGraph does not propagate false truncation', () => {
  const graph = new TypeConstraintGraph({
    snapshotId: 's',
    limits: { maxContradictionsPerLayer: 1 },
  });
  graph.addHardConstraint(hard('v0', 32));
  graph.addHardConstraint(hard('v0', 64));
  const solved = graph.solveGraph();
  assert.equal(solved.status.completeness, 'complete');
  const entityResult = solved.results.get('v0');
  assert.equal(entityResult.status.completeness, 'complete');
  assert.equal(entityResult.status.stopReason, null);
  assert.equal(entityResult.layers.machine.contradictions.length, 1);
});
