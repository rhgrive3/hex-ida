// Issue #5271 regression: condenseTypeGraph() materialized, deduplicated and
// sorted each node's full dependency iterable BEFORE charging the edge budget,
// so a single high-fan-out node (or an unbounded generator) exhausted work and
// memory while maxEdges only ever counted edges the Tarjan loop processed.
// Enumeration itself is now bounded: more than maxEdges raw items from one
// dependency iterable truncates immediately.
import assert from 'node:assert/strict';
import test from 'node:test';

import { condenseTypeGraph } from '../../../js/analysis/types/scc.js';

test('#5271 an unbounded dependency iterable cannot run past the edge budget', () => {
  let yielded = 0;
  function* hugeDependencies() {
    for (let i = 0; i < 1_000_000; i++) { yielded++; yield `n${i}`; }
  }
  const result = condenseTypeGraph(
    ['root'],
    (id) => id === 'root' ? hugeDependencies() : [],
    { maxEdges: 1, maxNodes: 10, maxComponents: 10 },
  );
  assert.equal(result.truncated, true);
  assert.ok(yielded <= 2, `enumeration must stop at maxEdges, got ${yielded} items`);
});

test('#5271 a high-fan-out node above the budget truncates without full traversal', () => {
  const fanOut = 1000;
  const result = condenseTypeGraph(
    ['root'],
    () => Array.from({ length: fanOut }, (_, i) => `n${i}`),
    { maxEdges: 100, maxNodes: 2000, maxComponents: 10 },
  );
  assert.equal(result.truncated, true);
});

test('#5271 within-budget graphs keep their exact prior condensation', () => {
  const result = condenseTypeGraph(
    ['A', 'B'],
    (id) => id === 'A' ? ['B'] : ['A'],
    { maxEdges: 10, maxNodes: 10, maxComponents: 10 },
  );
  assert.equal(result.truncated, false);
  assert.deepEqual(result.components, [['A', 'B']]);
});
