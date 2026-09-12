import assert from 'node:assert/strict';
import test from 'node:test';

import { TypeConstraintGraph, reconstructStructuralType } from '../../../js/analysis/types/graph.js';

function addHard(graph, entityId, kind, descriptor, evidenceId = `${entityId}:${kind}`) {
  graph.addHardConstraint({
    kind,
    origin: 'binary-evidence',
    evidenceIds: [evidenceId],
    claim: { layer: 'structural', entityId, descriptor },
  });
}

function structural(graph, entityId) {
  return graph.solveEntity(entityId).layers.structural;
}

test('issue #5190: an unknown-size empty aggregate stays unknown-size instead of synthesizing zero', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-5190-empty' });
  addHard(graph, 'Empty', 'nested-aggregate', { kind: 'struct', members: [] });

  const result = structural(graph, 'Empty');
  assert.equal(result.confidence, 'certain');
  assert.equal(result.selected.descriptor.kind, 'struct');
  assert.deepEqual(result.selected.descriptor.members, []);
  assert.equal(Object.hasOwn(result.selected.descriptor, 'sizeBytes'), false);
  assert.equal(Object.hasOwn(result.selected.descriptor, 'totalSizeBytes'), false);
  assert.equal(result.selected.descriptor.alignBytes, 1);
});

test('issue #5190: an explicit empty-aggregate size remains authoritative', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-5190-sized-empty' });
  addHard(graph, 'Sized', 'nested-aggregate', { kind: 'struct', members: [], sizeBytes: 24 });

  const result = structural(graph, 'Sized');
  assert.equal(result.confidence, 'certain');
  assert.equal(result.selected.descriptor.sizeBytes, 24);
  assert.equal(result.selected.descriptor.totalSizeBytes, 24);
  assert.equal(result.selected.descriptor.alignBytes, 1);
});

test('issue #5190: explicit alignment may be kept while aggregate size remains unknown', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-5190-aligned-empty' });
  addHard(graph, 'Aligned', 'nested-aggregate', { kind: 'struct', members: [], alignBytes: 8 });

  const result = structural(graph, 'Aligned');
  assert.equal(result.confidence, 'certain');
  assert.equal(result.selected.descriptor.alignBytes, 8);
  assert.equal(Object.hasOwn(result.selected.descriptor, 'sizeBytes'), false);
  assert.equal(Object.hasOwn(result.selected.descriptor, 'totalSizeBytes'), false);
});

test('issue #5190: a self-recursive pointer remains a pointer rather than being reconstructed as a struct', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-5190-pointer' });
  addHard(graph, 'P', 'recursive-pointer', { kind: 'pointer', targetEntityId: 'P' });

  const result = structural(graph, 'P');
  assert.equal(result.confidence, 'certain');
  assert.deepEqual(result.selected.descriptor, { kind: 'pointer', targetEntityId: 'P' });
});

test('issue #5190: a single array claim remains an array', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-5190-array' });
  addHard(graph, 'Items', 'array-stride', { kind: 'array', strideBytes: 4, length: 8 });

  const result = structural(graph, 'Items');
  assert.equal(result.confidence, 'certain');
  assert.deepEqual(result.selected.descriptor, { kind: 'array', strideBytes: 4, length: 8 });
});

test('issue #5190: recursive SCC metadata stays separate from pointer semantics', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-5190-recursive-metadata' });
  addHard(graph, 'P', 'recursive-pointer', { kind: 'pointer', targetEntityId: 'P' });

  const solved = graph.solveGraph();
  assert.deepEqual(solved.recursiveComponents, [['P']]);
  assert.equal(solved.results.get('P').layers.structural.selected.descriptor.kind, 'pointer');
});

test('issue #5190: concrete field evidence still synthesizes a bounded struct layout', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-5190-field' });
  addHard(graph, 'Record', 'structural-field', {
    kind: 'field',
    offset: 0,
    sizeBytes: 4,
    fieldName: 'value',
    memberType: { kind: 'integer', widthBits: 32 },
  });

  const result = structural(graph, 'Record');
  assert.equal(result.confidence, 'certain');
  assert.equal(result.selected.descriptor.kind, 'struct');
  assert.equal(result.selected.descriptor.sizeBytes, 4);
  assert.equal(result.selected.descriptor.totalSizeBytes, 4);
  assert.equal(result.selected.descriptor.alignBytes, 4);
});

for (const offset of [0, 8]) {
  test(`issue #5190: member with unknown extent at ${offset} preserves unknown aggregate size`, () => {
    const graph = new TypeConstraintGraph();
    addHard(graph, 'Unknown', 'nested-aggregate', { kind: 'struct', members: [
      { offset, fieldName: 'x', memberType: { kind: 'integer', widthBits: 32 } },
    ] });
    const result = structural(graph, 'Unknown');
    assert.equal(result.confidence, 'certain');
    assert.equal(Object.hasOwn(result.selected.descriptor, 'sizeBytes'), false);
    assert.equal(Object.hasOwn(result.selected.descriptor, 'totalSizeBytes'), false);
    const projected = reconstructStructuralType(graph, 'Unknown');
    assert.equal(projected.sizeBytes, null);
    assert.equal(projected.members[0].sizeBytes, null);
  });
}

for (const sizeBytes of [undefined, 24, 4]) {
  test(`issue #5190: mixed member extents respect explicit size ${sizeBytes}`, () => {
    const graph = new TypeConstraintGraph();
    addHard(graph, 'Mixed', 'nested-aggregate', { kind: 'struct',
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
      members: [
        { offset: 0, sizeBytes: 8, fieldName: 'known' },
        { offset: 8, fieldName: 'unknown' },
      ],
    });
    const result = structural(graph, 'Mixed');
    if (sizeBytes === 4) {
      assert.equal(result.selected, null, 'proven member extent exceeds the explicit bound');
      assert.notEqual(result.confidence, 'certain');
    } else {
      assert.equal(result.confidence, 'certain');
      assert.equal(result.selected.descriptor.sizeBytes, sizeBytes);
      assert.equal(reconstructStructuralType(graph, 'Mixed').sizeBytes, sizeBytes ?? null);
    }
  });
}

test('issue #5190: an unknown extent cannot hide a member start beyond the explicit bound', () => {
  const graph = new TypeConstraintGraph();
  addHard(graph, 'Outside', 'nested-aggregate', {
    kind: 'struct', sizeBytes: 4, members: [{ offset: 8, fieldName: 'x' }],
  });
  assert.equal(structural(graph, 'Outside').selected, null);
});
