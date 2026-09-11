import assert from 'node:assert/strict';
import test from 'node:test';

import { condenseCallGraph } from '../../../js/analysis/summary/interprocedural.js';

test('#4476 maxComponents never publishes an extra disconnected SCC', () => {
  const result = condenseCallGraph(['A', 'B'], () => [], {
    maxComponents: 1,
    maxNodes: 10,
    maxEdges: 10,
  });

  assert.equal(result.truncated, true);
  assert.deepEqual(result.components, [['A']]);
  assert.ok(result.components.length <= 1);
});

test('#4476 a graph that exactly fills maxComponents remains complete', () => {
  const result = condenseCallGraph(['A'], () => [], {
    maxComponents: 1,
    maxNodes: 10,
    maxEdges: 10,
  });

  assert.equal(result.truncated, false);
  assert.deepEqual(result.components, [['A']]);
});

test('#4476 one recursive SCC fits exactly in a one-component budget', () => {
  const result = condenseCallGraph(['A', 'B'], (node) => node === 'A' ? ['B'] : ['A'], {
    maxComponents: 1,
    maxNodes: 10,
    maxEdges: 10,
  });

  assert.equal(result.truncated, false);
  assert.deepEqual(result.components, [['A', 'B']]);
});

test('#4476 truncation keeps the component count within larger budgets', () => {
  const result = condenseCallGraph(['A', 'B', 'C'], () => [], {
    maxComponents: 2,
    maxNodes: 10,
    maxEdges: 10,
  });

  assert.equal(result.truncated, true);
  assert.deepEqual(result.components, [['A'], ['B']]);
  assert.ok(result.components.length <= 2);
});
