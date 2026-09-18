import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisStatus } from '../../../js/analysis/status.js';
import { createTypeResult, certainConclusions, selectedTypeIfCertain, TypeConstraintGraph } from '../../../js/analysis/types/graph.js';

/**
 * #4733: the exported TypeResult constructor is the boundary every cached,
 * serialized or plugin-supplied envelope passes through, and the certainty
 * accessors are the only authority that may present a type as fact. A forged
 * `{completeness:'complete', stopReason:null}` status and a layer that merely
 * borrows `confidence:'certain'` with zero hard evidence must never mint an
 * authoritative conclusion there.
 */

const forgedLayer = (overrides = {}) => ({
  selected: { layer: 'machine', entityId: 'v0', descriptor: { widthBits: 64, class: 'pointer' } },
  confidence: 'certain',
  contradictions: [],
  hardConstraints: [],
  softEvidence: [],
  candidates: [],
  ...overrides,
});

const forgedResult = (status, layers) => createTypeResult({ entityId: 'v0', status, layers });

test('#4733 a forged lightweight status cannot reach the certainty authority', () => {
  const forged = forgedResult({ completeness: 'complete', stopReason: null }, { machine: forgedLayer() });
  assert.equal(selectedTypeIfCertain(forged, 'machine'), null);
  assert.deepEqual(certainConclusions(forged), []);
});

test('#4733 certainty with empty hard evidence is not authoritative even under a canonical status', () => {
  const status = createAnalysisStatus({
    snapshotId: 'snapshot-1',
    analyzerId: 'phase7.types.constraint-graph',
    analyzerVersion: '1.0.0',
    completeness: 'complete',
    stopReason: null,
  });
  const forged = forgedResult(status, { machine: forgedLayer() });
  assert.equal(selectedTypeIfCertain(forged, 'machine'), null);
  assert.deepEqual(certainConclusions(forged), []);
});

test('#4733 certainty with contradictions present is not authoritative under a canonical status', () => {
  const status = createAnalysisStatus({
    snapshotId: 'snapshot-1',
    analyzerId: 'phase7.types.constraint-graph',
    analyzerVersion: '1.0.0',
    completeness: 'complete',
    stopReason: null,
  });
  const forged = forgedResult(status, {
    machine: forgedLayer({ contradictions: [{ code: 'x' }] }),
  });
  assert.equal(selectedTypeIfCertain(forged, 'machine'), null);
  assert.deepEqual(certainConclusions(forged), []);
});

test('#4733 an uncontradicted hard constraint still yields the authoritative answer', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'snapshot-1' });
  graph.addHardConstraint({
    kind: 'access-width',
    origin: 'binary-evidence',
    claim: { layer: 'machine', entityId: 'e', descriptor: { widthBits: 32, class: 'integer' } },
  });
  const result = graph.solveEntity('e');
  assert.equal(result.status.completeness, 'complete');
  assert.equal(selectedTypeIfCertain(result, 'machine').descriptor.widthBits, 32);
  assert.equal(certainConclusions(result).length, 1);
});

test('#4733 the constructor rejects unknown layers and invented confidence values', () => {
  const status = createAnalysisStatus({
    snapshotId: 'snapshot-1',
    analyzerId: 'phase7.types.constraint-graph',
    analyzerVersion: '1.0.0',
    completeness: 'unsupported',
    stopReason: 'unsupported-input',
  });
  assert.throws(() => forgedResult(status, { guessed: forgedLayer() }), /type-result-layer-unknown/);
  assert.throws(
    () => forgedResult(status, { machine: forgedLayer({ confidence: 'verified' }) }),
    /type-result-confidence-invalid/,
  );
});
