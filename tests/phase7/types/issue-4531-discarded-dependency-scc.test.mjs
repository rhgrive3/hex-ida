import assert from 'node:assert/strict';
import test from 'node:test';

import { TypeConstraintGraph } from '../../../js/analysis/types/graph.js';

function field(entityId, offset = 0) {
  return {
    kind: 'structural-field',
    origin: 'binary-evidence',
    claim: {
      layer: 'structural',
      entityId,
      descriptor: { offset, sizeBytes: 4, memberType: { kind: 'integer', widthBits: 32 } },
    },
    evidenceIds: [`field-${entityId}-${offset}`],
  };
}

function pointer(entityId, targetEntityId, origin = 'binary-evidence') {
  return {
    kind: 'recursive-pointer',
    origin,
    claim: {
      layer: 'structural',
      entityId,
      descriptor: { offset: 8, sizeBytes: 8, memberType: { kind: 'pointer', targetEntityId } },
    },
    evidenceIds: [`pointer-${entityId}-${targetEntityId}`],
  };
}

function add(graph, ...constraints) {
  for (const constraint of constraints) graph.addHardConstraint(constraint);
  return graph;
}

test('#4531 discarded hard constraints do not create ghost SCC dependencies', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-4531', limits: { maxConstraintsPerLayer: 1 } });
  add(graph, field('S'), pointer('S', 'S'));

  assert.deepEqual([...graph.dependenciesOf('S')], [], 'discarded self-reference must not become a dependency');
  const solved = graph.solveGraph();
  assert.equal(solved.status.completeness, 'truncated');
  assert.deepEqual(solved.recursiveComponents, [], 'discarded self-reference must not become a recursive SCC');
});

test('#4531 discarded cross-entity edges do not merge unrelated components', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-4531-cross', limits: { maxConstraintsPerLayer: 1 } });
  add(graph, field('A'), pointer('A', 'B'), field('B'));

  assert.deepEqual([...graph.dependenciesOf('A')], []);
  const solved = graph.solveGraph();
  assert.deepEqual(solved.components.map((component) => [...component]), [['A'], ['B']]);
  assert.deepEqual(solved.recursiveComponents, []);
});

test('#4531 retained self and mutual recursion still enter SCCs', () => {
  const self = add(
    new TypeConstraintGraph({ snapshotId: 'issue-4531-self', limits: { maxConstraintsPerLayer: 1 } }),
    pointer('S', 'S'),
  );
  assert.deepEqual([...self.dependenciesOf('S')], ['S']);
  assert.deepEqual(self.solveGraph().recursiveComponents.map((component) => [...component]), [['S']]);

  const mutual = add(
    new TypeConstraintGraph({ snapshotId: 'issue-4531-mutual', limits: { maxConstraintsPerLayer: 1 } }),
    pointer('A', 'B'),
    pointer('B', 'A'),
  );
  const solved = mutual.solveGraph();
  assert.deepEqual(solved.recursiveComponents.map((component) => [...component]), [['A', 'B']]);
});

test('#4531 a discarded user-approved constraint does not claim user authority', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-4531-user', limits: { maxConstraintsPerLayer: 1 } });
  add(graph, field('U'), pointer('U', 'U', 'user-approved'));
  assert.equal(graph.solveEntity('U').userConstrained, false);
});

test('#4531 duplicate retained evidence keeps dependency semantics', () => {
  const graph = new TypeConstraintGraph({ snapshotId: 'issue-4531-duplicate', limits: { maxConstraintsPerLayer: 1 } });
  const first = pointer('D', 'D');
  graph.addHardConstraint(first);
  graph.addHardConstraint({ ...first, evidenceIds: ['duplicate-evidence'] });
  assert.deepEqual([...graph.dependenciesOf('D')], ['D']);
  assert.equal(graph.solveEntity('D').layers.structural.hardConstraints.length, 1);
});

console.log('issue #4531 discarded dependency/SCC regressions: PASS');
