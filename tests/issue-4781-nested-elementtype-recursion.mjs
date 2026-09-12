import assert from 'node:assert/strict';
import test from 'node:test';

import { TypeConstraintGraph, reconstructStructuralType } from '../js/analysis/types/graph.js';

function nestedArrayType(inner, depth) {
  let node = inner;
  for (let i = 0; i < depth; i += 1) {
    node = { kind: 'array', length: 1, elementType: node };
  }
  return node;
}

function nestedPointerConstraint(entityId, targetEntityId, depth) {
  const memberType = nestedArrayType({ kind: 'pointer', targetEntityId }, depth);
  return {
    kind: 'structural-field',
    origin: 'binary-evidence',
    claim: {
      layer: 'structural',
      entityId,
      descriptor: { members: [{ offset: 0, sizeBytes: 8, memberType }] },
    },
    evidenceIds: [`field-${entityId}-${targetEntityId}-${depth}`],
  };
}

function integerConstraint(entityId) {
  return {
    kind: 'structural-field',
    origin: 'binary-evidence',
    claim: {
      layer: 'structural',
      entityId,
      descriptor: { offset: 0, sizeBytes: 4, memberType: { kind: 'integer', widthBits: 32 } },
    },
    evidenceIds: [`int-${entityId}`],
  };
}

function graphFor(snapshotId, ...constraints) {
  const graph = new TypeConstraintGraph({ snapshotId });
  for (const constraint of constraints) graph.addHardConstraint(constraint);
  return graph;
}

for (const depth of [0, 1, 2, 3, 5]) {
  test(`#4781 self-recursion through ${depth} nested array level(s) is detected`, () => {
    const graph = graphFor(`issue-4781-self-${depth}`, nestedPointerConstraint('A', 'A', depth));

    assert.ok(graph.dependenciesOf('A').has('A'), `A -> A dependency edge must exist at depth ${depth}`);

    const solved = graph.solveGraph();
    assert.deepEqual(solved.recursiveComponents.map((component) => [...component]), [['A']]);

    const selected = solved.results.get('A').layers.structural.selected.descriptor;
    assert.equal(selected.isRecursive, true, `isRecursive must be true at depth ${depth}`);
    assert.equal(selected.recursiveIdentity, 'A', `recursiveIdentity must be A at depth ${depth}`);

    const reconstructed = reconstructStructuralType(graph, 'A');
    assert.equal(reconstructed.isRecursive, true);
    assert.equal(reconstructed.recursiveIdentity, 'A');
  });
}

test('#4781 mutual recursion through nested arrays lands in one SCC', () => {
  const graph = graphFor(
    'issue-4781-mutual',
    nestedPointerConstraint('A', 'B', 2),
    nestedPointerConstraint('B', 'A', 2),
  );

  assert.ok(graph.dependenciesOf('A').has('B'));
  assert.ok(graph.dependenciesOf('B').has('A'));

  const solved = graph.solveGraph();
  assert.deepEqual(solved.recursiveComponents.map((component) => [...component].sort()), [['A', 'B']]);

  const a = solved.results.get('A').layers.structural.selected.descriptor;
  const b = solved.results.get('B').layers.structural.selected.descriptor;
  assert.equal(a.isRecursive, true);
  assert.equal(a.recursiveIdentity, 'A');
  assert.deepEqual([...a.sccMembers].sort(), ['A', 'B']);
  assert.equal(b.isRecursive, true);
  assert.equal(b.recursiveIdentity, 'B');
});

test('#4781 an unrelated nested pointer does not become a false self-recursion', () => {
  const graph = graphFor(
    'issue-4781-unrelated',
    nestedPointerConstraint('A', 'B', 2),
    integerConstraint('B'),
  );

  assert.deepEqual([...graph.dependenciesOf('A')], ['B']);
  assert.ok(!graph.dependenciesOf('A').has('A'), 'A must not self-depend on B only through nesting');

  const solved = graph.solveGraph();
  assert.deepEqual(solved.recursiveComponents, []);
  assert.equal(solved.results.get('A').layers.structural.selected.descriptor.isRecursive, false);
});

test('#4781 a cyclic JavaScript descriptor is rejected fail-closed instead of looping', () => {
  const inner = { kind: 'pointer', targetEntityId: 'A' };
  const array = { kind: 'array', length: 1, elementType: inner };
  inner.elementType = array;

  const graph = new TypeConstraintGraph({ snapshotId: 'issue-4781-cyclic' });
  assert.throws(
    () => graph.addHardConstraint({
      kind: 'structural-field',
      origin: 'binary-evidence',
      claim: {
        layer: 'structural',
        entityId: 'A',
        descriptor: { members: [{ offset: 0, sizeBytes: 8, memberType: array }] },
      },
      evidenceIds: ['cyclic-A'],
    }),
    /type-claim-descriptor-cycle/,
  );
});

test('#4781 stays compatible with #4708 structured-identity coercion (no fake edges)', () => {
  const graph = graphFor('issue-4781-coercion', {
    kind: 'structural-field',
    origin: 'binary-evidence',
    claim: {
      layer: 'structural',
      entityId: 'X',
      descriptor: {
        members: [{
          offset: 0,
          sizeBytes: 8,
          memberType: {
            kind: 'array',
            length: 1,
            elementType: {
              kind: 'array',
              length: 1,
              elementType: { kind: 'pointer', targetEntityId: ['A'] },
            },
          },
        }],
      },
    },
    evidenceIds: ['coercion-X'],
  });

  assert.deepEqual([...graph.dependenciesOf('X')], [], 'structured identity must not be coerced into an edge');
});
