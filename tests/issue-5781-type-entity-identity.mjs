import assert from 'node:assert/strict';
import test from 'node:test';

import { TypeConstraintGraph } from '../js/analysis/types/graph.js';

const hard = (entityId, widthBits) => ({
  kind: 'access-width',
  origin: 'binary-evidence',
  claim: { layer: 'machine', entityId, descriptor: { widthBits, class: 'integer' } },
});

test('#5781 a canonical string entityId resolves its existing evidence', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 's1' });
  graph.addHardConstraint(hard('A', 32));
  const solved = graph.solveEntity('A');
  assert.equal(solved.entityId, 'A');
  assert.equal(solved.layers.machine.confidence, 'certain');
  assert.equal(solved.layers.machine.selected.descriptor.widthBits, 32);
});

test('#5781 structured entity ids are rejected without laundering the result label', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 's1' });
  graph.addHardConstraint(hard('A', 32));
  const structured = graph.solveEntity(['A']);
  assert.equal(structured.entityId, '', 'the malformed key must not be String-coerced into the label');
  assert.equal(structured.status.stopReason, 'unsupported-input');
  assert.equal(structured.status.completeness, 'unsupported');
  assert.equal(structured.status.stopReason, 'unsupported-input');
  assert.deepEqual(structured.layers, {});
});

test('#5781 non-string primitive entity ids are rejected the same way', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 's1' });
  graph.addHardConstraint(hard('A', 32));
  for (const bad of [42, true, { toString: () => 'A' }]) {
    const result = graph.solveEntity(bad);
    assert.equal(result.entityId, '', 'the malformed key must not be String-coerced into the label');
    assert.deepEqual(result.layers, {});
  }
});
