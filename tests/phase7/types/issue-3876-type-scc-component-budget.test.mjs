import assert from 'node:assert/strict';
import test from 'node:test';

import { condenseTypeGraph } from '../../../js/analysis/types/scc.js';

test('maxComponents is a hard upper bound for disconnected SCCs (#3876)', () => {
  const result = condenseTypeGraph(
    ['A', 'B'],
    () => [],
    { maxComponents: 1, maxNodes: 10, maxEdges: 10 },
  );

  assert.equal(result.truncated, true);
  assert.deepEqual(result.components, [['A']]);
  assert.equal(result.components.length, 1);
  assert.ok(result.components.length <= 1);
});

test('reaching maxComponents exactly is complete when no SCC remains (#3876)', () => {
  const result = condenseTypeGraph(
    ['A'],
    () => [],
    { maxComponents: 1, maxNodes: 10, maxEdges: 10 },
  );

  assert.equal(result.truncated, false);
  assert.deepEqual(result.components, [['A']]);
});

test('one recursive SCC fits in a one-component budget (#3876)', () => {
  const result = condenseTypeGraph(
    ['A', 'B'],
    (id) => id === 'A' ? ['B'] : ['A'],
    { maxComponents: 1, maxNodes: 10, maxEdges: 10 },
  );

  assert.equal(result.truncated, false);
  assert.deepEqual(result.components, [['A', 'B']]);
  assert.deepEqual(result.recursiveComponents, [['A', 'B']]);
  assert.equal(result.isRecursiveMap.get('A'), true);
  assert.equal(result.isRecursiveMap.get('B'), true);
});

test('truncation never publishes the SCC beyond the component budget (#3876)', () => {
  const result = condenseTypeGraph(
    ['A', 'B'],
    (id) => id === 'A' ? ['A'] : [],
    { maxComponents: 1, maxNodes: 10, maxEdges: 10 },
  );

  assert.equal(result.truncated, true);
  assert.deepEqual(result.components, [['A']]);
  assert.deepEqual(result.recursiveComponents, [['A']]);
  assert.equal(result.isRecursiveMap.get('A'), true);
  assert.equal(result.isRecursiveMap.has('B'), false);
  assert.equal(result.sccMembersMap.has('B'), false);
});
