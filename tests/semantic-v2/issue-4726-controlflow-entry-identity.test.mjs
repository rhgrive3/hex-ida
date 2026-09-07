import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeGraph } from '../../js/controlflow.js';

const INVALID_ENTRIES = [
  '0',
  false,
  0n,
  [0],
  { valueOf() { return 0; } },
  { toString() { return '0'; } },
];

test('#4726 invalid entry identities fail closed instead of entering graph sets', () => {
  for (const entry of INVALID_ENTRIES) {
    const graph = analyzeGraph([[1], []], entry);
    assert.equal(graph.reachable.size, 0, `entry ${String(entry)} must not be reachable`);
    assert.deepEqual(graph.components, []);
    assert.deepEqual(graph.immediateDominators, [-1, -1]);
    assert.deepEqual(graph.componentOf, [-1, -1]);
  }
});

test('#4726 canonical integer entry preserves reachability, dominance, and SCC identity', () => {
  const graph = analyzeGraph([[1], [2], []], 0);
  assert.deepEqual([...graph.reachable].sort((a, b) => a - b), [0, 1, 2]);
  assert.deepEqual(graph.immediateDominators, [-1, 0, 1]);
  assert.equal(graph.components.flat().every(Number.isInteger), true);
  assert.equal(graph.reachable.has('0'), false);
});

test('#4726 successor indices remain strictly typed', () => {
  const graph = analyzeGraph([[1, '1', true, [1], { valueOf() { return 1; } }], []], 0);
  assert.deepEqual(graph.successors[0], [1]);
  assert.deepEqual([...graph.reachable].sort((a, b) => a - b), [0, 1]);
});

test('#4726 out-of-range integer entries preserve empty-unreachable semantics', () => {
  for (const entry of [-1, 2]) {
    const graph = analyzeGraph([[1], []], entry);
    assert.equal(graph.reachable.size, 0);
    assert.deepEqual(graph.immediateDominators, [-1, -1]);
  }
});
