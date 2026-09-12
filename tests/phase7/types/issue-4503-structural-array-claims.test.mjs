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


test('issue #4503: explicit field fragments still reconstruct a structural member', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-4503-explicit-field' });
  graph.addHardConstraint({
    kind: 'structural-field',
    origin: 'binary-evidence',
    claim: {
      layer: 'structural', entityId: 'record',
      descriptor: {
        kind: 'field', offset: 0, sizeBytes: 4,
        fieldName: 'value', memberType: { kind: 'integer', widthBits: 32 },
      },
    },
    evidenceIds: ['record:value'],
  });

  const result = structural(graph, 'record');
  assert.equal(result.contradictions.length, 0);
  assert.equal(result.confidence, 'certain');
  assert.equal(result.selected.descriptor.kind, 'struct');
  assert.equal(result.selected.descriptor.totalSizeBytes, 4);
  assert.deepEqual(result.selected.descriptor.members, [{
    kind: 'field', offset: 0, sizeBytes: 4,
    fieldName: 'value', memberType: { kind: 'integer', widthBits: 32 },
  }]);
});

test('issue #4503: explicit recursive field fragments retain SCC reconstruction', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-4503-explicit-recursive-field' });
  graph.addHardConstraint({
    kind: 'structural-field',
    origin: 'binary-evidence',
    claim: {
      layer: 'structural', entityId: 'Node',
      descriptor: {
        kind: 'field', offset: 0, sizeBytes: 8,
        fieldName: 'next', memberType: { kind: 'pointer', targetEntityId: 'Node' },
      },
    },
    evidenceIds: ['Node:next'],
  });

  const result = structural(graph, 'Node');
  assert.equal(result.contradictions.length, 0);
  assert.equal(result.confidence, 'certain');
  assert.equal(result.selected.descriptor.kind, 'struct');
  assert.equal(result.selected.descriptor.isRecursive, true);
  assert.equal(result.selected.descriptor.members[0].isRecursive, true);
  assert.equal(result.selected.descriptor.members[0].memberType.isRecursive, true);
});

test('issue #4503: compatible top-level pointer facts merge without synthesizing a struct', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-4503-pointer-merge' });
  for (const [index, descriptor] of [
    { kind: 'pointer', targetEntityId: 'Target', sizeBytes: 8 },
    { kind: 'pointer', targetEntityId: 'Target', alignBytes: 8 },
  ].entries()) {
    graph.addHardConstraint({
      kind: 'recursive-pointer',
      origin: 'binary-evidence',
      claim: { layer: 'structural', entityId: 'ptr', descriptor },
      evidenceIds: [`ptr:${index}`],
    });
  }

  const result = structural(graph, 'ptr');
  assert.equal(result.contradictions.length, 0);
  assert.equal(result.confidence, 'certain');
  assert.deepEqual(result.selected.descriptor, {
    kind: 'pointer', targetEntityId: 'Target', sizeBytes: 8, alignBytes: 8,
  });
});

test('issue #4503: incompatible top-level pointer facts withhold selection conservatively', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-4503-pointer-conflict' });
  for (const [index, targetEntityId] of ['TargetA', 'TargetB'].entries()) {
    graph.addHardConstraint({
      kind: 'recursive-pointer',
      origin: 'binary-evidence',
      claim: {
        layer: 'structural', entityId: 'ptr',
        descriptor: { kind: 'pointer', targetEntityId, sizeBytes: 8 },
      },
      evidenceIds: [`ptr-conflict:${index}`],
    });
  }

  const result = structural(graph, 'ptr');
  assert.equal(result.confidence, 'unknown');
  assert.equal(result.selected, null);
});

console.log('issue-4503-structural-array-claims: ok');
