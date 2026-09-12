import assert from 'node:assert/strict';
import test from 'node:test';

import { createTypeClaim } from '../js/analysis/types/constraints.js';
import { TypeConstraintGraph } from '../js/analysis/types/graph.js';

function memberConstraint(entityId, memberType, evidenceId) {
  return {
    kind: 'structural-field',
    origin: 'binary-evidence',
    claim: {
      layer: 'structural',
      entityId,
      descriptor: { members: [{ offset: 0, sizeBytes: 8, memberType }] },
    },
    evidenceIds: [evidenceId],
  };
}

function add(graph, ...constraints) {
  for (const constraint of constraints) graph.addHardConstraint(constraint);
  return graph;
}

test('#4708 a valid string self pointer through members[] keeps its recursive SCC', () => {
  const graph = add(
    new TypeConstraintGraph({ snapshotId: 'issue-4708-valid-self' }),
    memberConstraint('A', { kind: 'pointer', targetEntityId: 'A' }, 'self-A'),
  );
  assert.deepEqual([...graph.dependenciesOf('A')], ['A']);
  assert.deepEqual(graph.solveGraph().recursiveComponents.map((c) => [...c]), [['A']]);
});

test('#4708 a valid mutual string pair keeps its recursive SCC', () => {
  const graph = add(
    new TypeConstraintGraph({ snapshotId: 'issue-4708-valid-mutual' }),
    memberConstraint('A', { kind: 'pointer', targetEntityId: 'B' }, 'A-B'),
    memberConstraint('B', { kind: 'pointer', targetEntityId: 'A' }, 'B-A'),
  );
  assert.deepEqual(graph.solveGraph().recursiveComponents.map((c) => [...c]), [['A', 'B']]);
});

test('#4708 a valid nested elementType string identity stays graph authority', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-4708-valid-elementtype' });
  graph.addHardConstraint({
    kind: 'structural-field',
    origin: 'binary-evidence',
    claim: {
      layer: 'structural',
      entityId: 'A',
      descriptor: {
        memberType: { kind: 'array', elementEntityId: 'A', elementType: { kind: 'pointer', targetEntityId: 'A' } },
      },
    },
    evidenceIds: ['elementtype-A'],
  });
  assert.deepEqual([...graph.dependenciesOf('A')], ['A']);
  assert.deepEqual(graph.solveGraph().recursiveComponents.map((c) => [...c]), [['A']]);
});

test('#4708 a structured members[] targetEntityId is rejected and mints no self-edge', () => {
  const claim = () => createTypeClaim({
    layer: 'structural',
    entityId: 'A',
    descriptor: { members: [{ offset: 0, sizeBytes: 8, memberType: { kind: 'pointer', targetEntityId: ['A'] } }] },
  });
  assert.throws(claim, /structural-identity-invalid/);

  const graph = new TypeConstraintGraph({ snapshotId: 'issue-4708-structured-self' });
  assert.throws(() => add(graph, memberConstraint('A', { kind: 'pointer', targetEntityId: ['A'] }, 'forged-A')),
    /structural-identity-invalid/);
  assert.deepEqual([...graph.dependenciesOf('A')], []);
  assert.deepEqual(graph.solveGraph().recursiveComponents, []);
});

test('#4708 structured mutual identities mint no recursive SCC', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-4708-structured-mutual' });
  assert.throws(() => add(
    graph,
    memberConstraint('A', { kind: 'pointer', targetEntityId: ['B'] }, 'forged-A-B'),
    memberConstraint('B', { kind: 'pointer', targetEntityId: ['A'] }, 'forged-B-A'),
  ), /structural-identity-invalid/);
  assert.deepEqual([...graph.dependenciesOf('A')], []);
  assert.deepEqual([...graph.dependenciesOf('B')], []);
  assert.deepEqual(graph.solveGraph().recursiveComponents, []);
});

test('#4708 every nested identity path uses the strict string contract', () => {
  const malformed = [['A'], { toString: () => 'A' }, 42, true, '', '   '];
  const paths = (bad) => [
    { targetEntityId: bad },
    { elementEntityId: bad },
    { memberType: { kind: 'pointer', targetEntityId: bad } },
    { memberType: { kind: 'array', elementEntityId: bad } },
    { memberType: { kind: 'array', elementType: { targetEntityId: bad } } },
    { elementType: { kind: 'pointer', targetEntityId: bad } },
    { members: [{ offset: 0, sizeBytes: 8, memberType: { kind: 'pointer', targetEntityId: bad } }] },
    { members: [{ offset: 0, sizeBytes: 8, memberType: { kind: 'array', elementEntityId: bad } }] },
    { members: [{ offset: 0, sizeBytes: 8, memberType: { kind: 'array', elementType: { targetEntityId: bad } } }] },
  ];
  for (const bad of malformed) {
    for (const descriptor of paths(bad)) {
      assert.throws(
        () => createTypeClaim({ layer: 'structural', entityId: 'A', descriptor }),
        /structural-identity-invalid/,
        `structured identity must be rejected, not laundered via String(${String(bad)})`,
      );
    }
  }
});

test('#4708 an absent or null nested identity stays valid', () => {
  createTypeClaim({
    layer: 'structural',
    entityId: 'A',
    descriptor: {
      offset: 0,
      sizeBytes: 8,
      memberType: { kind: 'pointer', targetEntityId: null, elementEntityId: undefined },
      members: [{ offset: 8, sizeBytes: 8, memberType: { kind: 'integer', widthBits: 32 } }],
    },
  });
});

test('#4708 malformed dependency never mints a recursive structural annotation', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-4708-no-recursive-mint' });
  add(graph, memberConstraint('A', { kind: 'integer', widthBits: 32 }, 'plain-A'));
  assert.throws(() => add(graph, memberConstraint('A', { kind: 'pointer', targetEntityId: ['A'] }, 'forged-A')),
    /structural-identity-invalid/);

  const structural = graph.solveEntity('A').layers.structural;
  assert.equal(structural.selected.descriptor.isRecursive, false);
  assert.equal(structural.selected.descriptor.recursiveIdentity, null);
  assert.deepEqual(graph.solveGraph().recursiveComponents, []);
});

console.log('issue #4708 nested dependency identity regressions: PASS');
