// Issue #5271 regression: condenseTypeGraph() materialized, deduplicated and
// sorted each node's full dependency iterable BEFORE charging the edge budget,
// so a single high-fan-out node (or an unbounded generator) exhausted work and
// memory while maxEdges only ever counted edges the Tarjan loop processed.
// Enumeration itself is now globally bounded across all dependency iterables.
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

test('#5271 duplicate-heavy adjacency consumes one global discovery budget', () => {
  const maxEdges = 100;
  let yielded = 0;
  function* duplicateNext(id) {
    const index = Number(String(id).slice(1));
    if (!Number.isSafeInteger(index) || index >= 99) return;
    const next = `n${index + 1}`;
    for (let i = 0; i < 100; i++) {
      yielded += 1;
      yield next;
    }
  }
  const result = condenseTypeGraph(
    ['n0'],
    duplicateNext,
    { maxEdges, maxNodes: 200, maxComponents: 200 },
  );
  assert.equal(result.truncated, true);
  assert.ok(yielded <= maxEdges + 1, `global discovery exceeded maxEdges: ${yielded}`);
});

test('#5271 cancellation is observed during dependency enumeration', () => {
  const controller = new AbortController();
  let yielded = 0;
  function* cancellableDependencies() {
    for (let i = 0; i < 1000; i++) {
      yielded += 1;
      if (yielded === 3) controller.abort();
      yield `n${i}`;
    }
  }
  const result = condenseTypeGraph(
    ['root'],
    (id) => id === 'root' ? cancellableDependencies() : [],
    { maxEdges: 1000, maxNodes: 2000, maxComponents: 2000, signal: controller.signal },
  );
  assert.equal(result.cancelled, true);
  assert.equal(result.truncated, true);
  assert.ok(yielded <= 3, `cancellation must stop enumeration promptly, got ${yielded}`);
});

test('#5271 singleton self-edge classification reuses bounded discovery', () => {
  let providerCalls = 0;
  const result = condenseTypeGraph(
    ['A'],
    () => { providerCalls += 1; return ['A']; },
    { maxEdges: 1, maxNodes: 10, maxComponents: 10 },
  );
  assert.equal(result.truncated, false);
  assert.deepEqual(result.components, [['A']]);
  assert.deepEqual(result.recursiveComponents, [['A']]);
  assert.equal(providerCalls, 1, 'self-edge classification must not re-enumerate dependencies');
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
