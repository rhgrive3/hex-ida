import assert from 'node:assert/strict';
import test from 'node:test';

import { TypeConstraintGraph } from '../../../js/analysis/types/graph.js';

function addArray(graph, entityId, descriptor) {
  graph.addHardConstraint({
    kind: 'array-stride',
    origin: 'binary-evidence',
    claim: { layer: 'structural', entityId, descriptor },
    evidenceIds: [`${entityId}:${descriptor.strideBytes ?? 'array'}`],
  });
}

function structural(graph, entityId) {
  return graph.solveEntity(entityId).layers.structural;
}

test('issue #4503: one structural array claim remains an array and does not synthesize size zero', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-4503-single-array' });
  addArray(graph, 'arr', { kind: 'array', strideBytes: 4, length: 4 });

  const result = structural(graph, 'arr');
  assert.equal(result.contradictions.length, 0);
  assert.equal(result.confidence, 'certain');
  assert.deepEqual(result.selected.descriptor, { kind: 'array', strideBytes: 4, length: 4 });
});

test('issue #4503: an explicitly sized single array also remains an array', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-4503-sized-array' });
  addArray(graph, 'arr', { kind: 'array', strideBytes: 4, length: 4, sizeBytes: 16 });

  const result = structural(graph, 'arr');
  assert.equal(result.confidence, 'certain');
  assert.equal(result.selected.descriptor.kind, 'array');
  assert.equal(result.selected.descriptor.sizeBytes, 16);
});

test('issue #4503: compatible array facts merge without changing the descriptor kind', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-4503-array-merge' });
  addArray(graph, 'arr', { kind: 'array', strideBytes: 4 });
  addArray(graph, 'arr', { kind: 'array', length: 4, sizeBytes: 16, alignBytes: 4 });

  const result = structural(graph, 'arr');
  assert.equal(result.contradictions.length, 0);
  assert.equal(result.confidence, 'certain');
  assert.deepEqual(result.selected.descriptor, {
    kind: 'array', strideBytes: 4, length: 4, sizeBytes: 16, alignBytes: 4,
  });
});

for (const [field, left, right] of [
  ['strideBytes', 4, 8],
  ['length', 4, 8],
]) {
  test(`issue #4503: conflicting array ${field} facts withhold selection`, () => {
    const graph = new TypeConstraintGraph({ snapshotId: `issue-4503-array-${field}` });
    addArray(graph, 'arr', { kind: 'array', strideBytes: 4, length: 4, [field]: left });
    addArray(graph, 'arr', { kind: 'array', strideBytes: 4, length: 4, [field]: right });

    const result = structural(graph, 'arr');
    assert.equal(result.contradictions.length, 1);
    assert.equal(result.confidence, 'unknown');
    assert.equal(result.selected, null);
  });
}

test('issue #4503: conflicting array element types withhold selection', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-4503-array-element-type' });
  addArray(graph, 'arr', { kind: 'array', strideBytes: 4, length: 4, elementType: { kind: 'integer', widthBits: 32 } });
  addArray(graph, 'arr', { kind: 'array', strideBytes: 4, length: 4, elementType: { kind: 'integer', widthBits: 64 } });

  const result = structural(graph, 'arr');
  assert.equal(result.contradictions.length, 1);
  assert.equal(result.selected, null);
});

test('issue #4503: an array claim conflicts with a structural field fragment', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-4503-array-field' });
  addArray(graph, 'arr', { kind: 'array', strideBytes: 4, length: 4 });
  graph.addHardConstraint({
    kind: 'structural-field',
    origin: 'binary-evidence',
    claim: {
      layer: 'structural', entityId: 'arr',
      descriptor: { offset: 0, sizeBytes: 16, memberType: { kind: 'integer', widthBits: 32 } },
    },
  });

  const result = structural(graph, 'arr');
  assert.equal(result.contradictions.length, 1);
  assert.equal(result.selected, null);
});

console.log('issue-4503-structural-array-claims: ok');
