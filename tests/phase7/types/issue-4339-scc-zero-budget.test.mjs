import assert from 'node:assert/strict';
import test from 'node:test';

import { condenseTypeGraph } from '../../../js/analysis/types/scc.js';

test('#4339 maxNodes=0 is a hard zero-node budget', () => {
  let dependencyCalls = 0;
  const result = condenseTypeGraph(
    ['A'],
    () => { dependencyCalls += 1; return ['B']; },
    { maxNodes: 0, maxEdges: 10, maxComponents: 10 },
  );

  assert.equal(result.truncated, true);
  assert.equal(result.cancelled, false);
  assert.deepEqual(result.components, []);
  assert.equal(dependencyCalls, 0, 'zero node budget must stop before dependency traversal');
});

test('#4339 maxNodes=0 is complete for an empty graph', () => {
  const result = condenseTypeGraph(
    [],
    () => { throw new Error('empty graph must not traverse dependencies'); },
    { maxNodes: 0, maxEdges: 0, maxComponents: 0 },
  );

  assert.equal(result.truncated, false);
  assert.equal(result.cancelled, false);
  assert.deepEqual(result.components, []);
});

test('#4339 maxEdges=0 permits an edgeless node but truncates on the first discovered edge', () => {
  const edgeless = condenseTypeGraph(
    ['A'],
    () => [],
    { maxNodes: 10, maxEdges: 0, maxComponents: 10 },
  );
  assert.equal(edgeless.truncated, false);
  assert.deepEqual(edgeless.components, [['A']]);

  let yielded = 0;
  function* oneEdge() {
    yielded += 1;
    yield 'B';
    yielded += 1;
    yield 'C';
  }
  const bounded = condenseTypeGraph(
    ['A'],
    () => oneEdge(),
    { maxNodes: 10, maxEdges: 0, maxComponents: 10 },
  );
  assert.equal(bounded.truncated, true);
  assert.deepEqual(bounded.components, []);
  assert.equal(yielded, 1, 'zero edge budget may probe one item to detect overflow but must not consume the tail');
});

test('#4339 maxComponents=0 publishes no SCCs and reports truncation for a non-empty graph', () => {
  const result = condenseTypeGraph(
    ['A'],
    () => [],
    { maxNodes: 10, maxEdges: 10, maxComponents: 0 },
  );

  assert.equal(result.truncated, true);
  assert.equal(result.cancelled, false);
  assert.deepEqual(result.components, []);
  assert.deepEqual(result.recursiveComponents, []);
  assert.equal(result.isRecursiveMap.size, 0);
  assert.equal(result.sccMembersMap.size, 0);
});

test('#4339 malformed SCC limits still fail closed before traversal', () => {
  const malformed = [null, NaN, Infinity, -Infinity, 1.5, -1, Number.MAX_SAFE_INTEGER + 1, '1', ['1'], true, {}, []];
  for (const key of ['maxNodes', 'maxEdges', 'maxComponents']) {
    for (const value of malformed) {
      let rootEnumerations = 0;
      let dependencyCalls = 0;
      const roots = {
        [Symbol.iterator]() {
          rootEnumerations += 1;
          return ['A'][Symbol.iterator]();
        },
      };
      assert.throws(
        () => condenseTypeGraph(roots, () => { dependencyCalls += 1; return []; }, { [key]: value }),
        TypeError,
        `${key}=${String(value)} must be rejected`,
      );
      assert.equal(rootEnumerations, 0, `${key} malformed validation must precede root enumeration`);
      assert.equal(dependencyCalls, 0, `${key} malformed validation must precede dependency traversal`);
    }
  }
});
