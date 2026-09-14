import assert from 'node:assert/strict';
import test from 'node:test';

import { condenseTypeGraph } from '../../../js/analysis/types/scc.js';

test('#8905 a huge root iterable cannot run past maxNodes before the budget is observed', () => {
  let yielded = 0;
  function* roots(n) {
    for (let i = 0; i < n; i += 1) {
      yielded += 1;
      yield `root_${String(i).padStart(6, '0')}`;
    }
  }
  const result = condenseTypeGraph(roots(100_000), () => [], { maxNodes: 1, maxEdges: 1, maxComponents: 1 });
  assert.equal(result.cancelled, false);
  assert.equal(result.truncated, true);
  assert.ok(yielded <= 2, `root enumeration must stop at maxNodes, got ${yielded}`);
  assert.ok(result.components.length <= 1);
});

test('#8905 an already-aborted signal prevents root enumeration from starting', () => {
  const controller = new AbortController();
  controller.abort();
  let yielded = 0;
  function* roots(n) {
    for (let i = 0; i < n; i += 1) {
      yielded += 1;
      yield `r${i}`;
    }
  }
  const result = condenseTypeGraph(roots(100_000), () => [], { maxNodes: 1, maxEdges: 1, maxComponents: 1, signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.equal(result.truncated, true);
  assert.equal(yielded, 0, 'cancellation must be observed before the first root is pulled');
});

test('#8905 cancellation during root enumeration is observed at a bounded interval', () => {
  const controller = new AbortController();
  let yielded = 0;
  function* roots() {
    for (let i = 0; i < 100_000; i += 1) {
      yielded += 1;
      if (yielded === 3) controller.abort();
      yield `r${i}`;
    }
  }
  const result = condenseTypeGraph(roots(), () => [], { maxNodes: 10_000, maxEdges: 10_000, maxComponents: 10_000, signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.ok(yielded <= 3, `cancellation must stop enumeration promptly, got ${yielded}`);
});

test('#8905 a duplicate-heavy non-terminating iterable is bounded by maxNodes enumeration work', () => {
  let yielded = 0;
  function* forever() {
    while (true) {
      yielded += 1;
      yield 'only-a';
    }
  }
  const result = condenseTypeGraph(forever(), () => [], { maxNodes: 4, maxEdges: 10, maxComponents: 10 });
  assert.equal(result.truncated, true);
  assert.ok(yielded <= 5, `enumeration must stop at maxNodes+1 pulls even for duplicate floods, got ${yielded}`);
});

test('#8905 maxNodes=0 still probes exactly one item to detect overflow, never the tail', () => {
  let dependencyCalls = 0;
  let yielded = 0;
  function* roots() {
    yielded += 1;
    yield 'A';
    yielded += 1;
    yield 'B';
  }
  const result = condenseTypeGraph(roots(), () => { dependencyCalls += 1; return []; }, { maxNodes: 0, maxEdges: 10, maxComponents: 10 });
  assert.equal(result.truncated, true);
  assert.deepEqual(result.components, []);
  assert.equal(dependencyCalls, 0);
  assert.equal(yielded, 1, 'zero node budget may probe one item but must not consume the tail');
});

test('#8905 within-budget root sets keep their exact prior condensation and determinism', () => {
  const deps = (id) => (id === 'A' ? ['B'] : id === 'B' ? ['A'] : []);
  const a = condenseTypeGraph(['B', 'root', 'A'], deps, { maxNodes: 10, maxEdges: 10, maxComponents: 10 });
  const b = condenseTypeGraph(['A', 'B', 'root'], deps, { maxNodes: 10, maxEdges: 10, maxComponents: 10 });
  assert.equal(a.truncated, false);
  assert.equal(a.cancelled, false);
  // roots are still sorted internally, so iteration order of entityIds must not matter
  assert.deepEqual(a.components, b.components);
  assert.deepEqual(a.components, [['A', 'B'], ['root']]);
});
