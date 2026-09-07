import assert from 'node:assert/strict';
import test from 'node:test';

import { TypeConstraintGraph, selectedTypeIfCertain } from '../../../js/analysis/types/graph.js';
import { condenseTypeGraph } from '../../../js/analysis/types/scc.js';

const hard = (entityId, widthBits, evidenceIds = []) => ({
  kind: 'access-width',
  origin: 'binary-evidence',
  claim: { layer: 'machine', entityId, descriptor: { widthBits, class: 'integer' } },
  evidenceIds,
});

test('duplicate hard constraints collapse to one semantic entry', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 's' });
  for (let i = 0; i < 100_000; i += 1) graph.addHardConstraint(hard('v0', 64));
  const result = graph.solveEntity('v0');
  assert.equal(result.status.completeness, 'complete');
  assert.equal(result.layers.machine.hardConstraints.length, 1);
  assert.equal(result.layers.machine.confidence, 'certain');
});

test('constraint admission budget fails closed instead of strengthening certainty', () => {
  const graph = new TypeConstraintGraph({
    snapshotId: 's',
    limits: { maxConstraintsPerLayer: 2, maxComparisonsPerLayer: 100 },
  });
  graph.addHardConstraint(hard('v0', 8));
  graph.addHardConstraint(hard('v0', 16));
  graph.addHardConstraint(hard('v0', 32));
  const result = graph.solveEntity('v0');
  assert.equal(result.status.completeness, 'truncated');
  assert.equal(result.status.stopReason, 'budget-exhausted');
  assert.equal(result.layers.machine.selected, null);
  assert.equal(selectedTypeIfCertain(result, 'machine'), null);
});

test('comparison budget bounds heterogeneous hard-conflict solving', () => {
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
  assert.equal(result.layers.machine.selected, null);
});

test('solve checks cancellation during a heterogeneous comparison loop', () => {
  const graph = new TypeConstraintGraph({
    snapshotId: 's',
    limits: { maxConstraintsPerLayer: 16, maxComparisonsPerLayer: 100 },
  });
  graph.addHardConstraint(hard('v0', 8));
  graph.addHardConstraint(hard('v0', 16));
  graph.addHardConstraint(hard('v0', 32));
  graph.addHardConstraint(hard('v0', 64));
  let probes = 0;
  const signal = { get aborted() { probes += 1; return probes > 2; } };
  const result = graph.solveEntity('v0', { signal });
  assert.equal(result.status.completeness, 'partial');
  assert.equal(result.status.stopReason, 'cancelled');
  assert.equal(selectedTypeIfCertain(result, 'machine'), null);
});

test('duplicate provenance is retained while semantic entry stays deduplicated', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 's' });
  graph.addHardConstraint(hard('v0', 64, ['ev-a']));
  graph.addHardConstraint(hard('v0', 64, ['ev-b']));
  const layer = graph.solveEntity('v0').layers.machine;
  assert.equal(layer.hardConstraints.length, 1);
  assert.deepEqual(layer.hardConstraints[0].evidenceIds, ['ev-a', 'ev-b']);
});

test('TypeConstraintGraph constructor rejects non-primitive, non-integer, or non-positive limits (#4370)', () => {
  for (const bad of ['1', ['1'], true, {}, NaN, Infinity, -Infinity, 1.5, 0, -1]) {
    assert.throws(
      () => new TypeConstraintGraph({ snapshotId: 's', limits: { maxConstraintsPerLayer: bad } }),
      TypeError,
    );
    assert.throws(
      () => new TypeConstraintGraph({ snapshotId: 's', limits: { maxComparisonsPerLayer: bad } }),
      TypeError,
    );
    assert.throws(
      () => new TypeConstraintGraph({ snapshotId: 's', limits: { maxContradictionsPerLayer: bad } }),
      TypeError,
    );
    assert.throws(
      () => new TypeConstraintGraph({ snapshotId: 's', limits: { maxIterationsPerComponent: bad } }),
      TypeError,
    );
    assert.throws(
      () => new TypeConstraintGraph({ snapshotId: 's', limits: { maxComponents: bad } }),
      TypeError,
    );
    assert.throws(
      () => new TypeConstraintGraph({ snapshotId: 's', limits: { maxNodes: bad } }),
      TypeError,
    );
    assert.throws(
      () => new TypeConstraintGraph({ snapshotId: 's', limits: { maxEdges: bad } }),
      TypeError,
    );
  }
});

test('condenseTypeGraph rejects non-primitive, non-integer, or non-positive limits (#6053)', () => {
  const nodes = ['A', 'B'];
  const deps = () => [];
  for (const bad of ['1', ['1'], true, {}, NaN, Infinity, -Infinity, 1.5, 0, -1]) {
    assert.throws(() => condenseTypeGraph(nodes, deps, { maxNodes: bad }), TypeError);
    assert.throws(() => condenseTypeGraph(nodes, deps, { maxEdges: bad }), TypeError);
    assert.throws(() => condenseTypeGraph(nodes, deps, { maxComponents: bad }), TypeError);
  }
});

test('maxContradictionsPerLayer exact limit does not falsely report truncated (#6245)', () => {
  // Case 1: 2 constraints (1 conflicting pair) with maxContradictionsPerLayer: 1 must be complete
  const graph1 = new TypeConstraintGraph({
    snapshotId: 's',
    limits: { maxContradictionsPerLayer: 1 },
  });
  graph1.addHardConstraint(hard('v0', 8));
  graph1.addHardConstraint(hard('v0', 16));
  const res1 = graph1.solveEntity('v0');
  assert.equal(res1.status.completeness, 'complete');
  assert.equal(res1.status.stopReason, null);
  assert.equal(res1.contradictions.length, 1);

  // Case 2: 3 constraints (2+ conflicting pairs) with maxContradictionsPerLayer: 1 must be truncated
  const graph2 = new TypeConstraintGraph({
    snapshotId: 's',
    limits: { maxContradictionsPerLayer: 1 },
  });
  graph2.addHardConstraint(hard('v0', 8));
  graph2.addHardConstraint(hard('v0', 16));
  graph2.addHardConstraint(hard('v0', 32));
  const res2 = graph2.solveEntity('v0');
  assert.equal(res2.status.completeness, 'truncated');
  assert.equal(res2.status.stopReason, 'budget-exhausted');
  assert.equal(res2.contradictions.length, 1);
});

