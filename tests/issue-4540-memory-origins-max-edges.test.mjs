import assert from 'node:assert/strict';
import { test } from 'node:test';

import { backwardSlice, memoryOrigins } from '../js/slice.js';

const memoryStore = (id) => {
  const inst = { id, op: 'store' };
  return { inst, node: { kind: 'store', inst } };
};

const memoryClobber = (id) => {
  const inst = { id, op: 'call' };
  return { inst, node: { kind: 'clobber', inst } };
};

test('#4540 processes the destination of the last permitted store edge', () => {
  const { inst, node } = memoryStore('store-1');
  const phi = { kind: 'phi', incoming: [{ node }] };
  const result = memoryOrigins(phi, { maxNodes: 10, maxEdges: 1 });

  assert.deepEqual(result.stores, [inst]);
  assert.equal(result.edges, 1);
  assert.equal(result.nodes, 2);
  assert.equal(result.truncated, false);
});

test('#4540 processes the destination of the last permitted clobber edge', () => {
  const { inst, node } = memoryClobber('clobber-1');
  const phi = { kind: 'phi', incoming: [{ node }] };
  const result = memoryOrigins(phi, { maxNodes: 10, maxEdges: 1 });

  assert.deepEqual(result.clobbers, [inst]);
  assert.equal(result.edges, 1);
  assert.equal(result.nodes, 2);
  assert.equal(result.truncated, false);
});

test('#4540 stops after the first edge while still processing its queued destination', () => {
  const first = memoryStore('store-1');
  const second = memoryClobber('clobber-2');
  const phi = { kind: 'phi', incoming: [{ node: first.node }, { node: second.node }] };
  const result = memoryOrigins(phi, { maxNodes: 10, maxEdges: 1 });

  assert.deepEqual(result.stores, [first.inst]);
  assert.deepEqual(result.clobbers, []);
  assert.equal(result.truncated, true);
  assert.equal(result.nodes, 2);
});

test('#4540 consumes exactly N edges and processes all N reachable destinations', () => {
  const first = memoryStore('store-1');
  const second = memoryStore('store-2');
  const nested = {
    kind: 'phi',
    incoming: [
      { node: first.node },
      { node: { kind: 'phi', incoming: [{ node: second.node }] } },
    ],
  };
  const result = memoryOrigins(nested, { maxNodes: 10, maxEdges: 3 });

  assert.deepEqual(new Set(result.stores), new Set([first.inst, second.inst]));
  assert.deepEqual(result.clobbers, []);
  assert.equal(result.edges, 3);
  assert.equal(result.truncated, false);
});

test('#4540 preserves the node budget and terminates on cycles', () => {
  const store = memoryStore('store-node-budget');
  const limited = memoryOrigins({ kind: 'phi', incoming: [{ node: store.node }] }, { maxNodes: 1, maxEdges: 10 });
  assert.deepEqual(limited.stores, []);
  assert.equal(limited.nodes, 1);
  assert.equal(limited.truncated, true);

  const first = { kind: 'phi', incoming: [] };
  const second = { kind: 'phi', incoming: [{ node: first }] };
  first.incoming = [{ node: second }];
  const cyclic = memoryOrigins(first, { maxNodes: 10, maxEdges: 2 });
  assert.equal(cyclic.nodes, 2);
  assert.equal(cyclic.edges, 2);
  assert.equal(cyclic.truncated, false);
});

test('#4540 keeps the boundary store in backwardSlice results', () => {
  const { inst, node } = memoryStore('slice-store');
  const load = { id: 'slice-load', op: 'load', args: [], memUse: { kind: 'phi', incoming: [{ node }] }, row: 0, block: 0 };
  const result = backwardSlice({ instructions: [inst, load] }, load, { memoryNodeLimit: 10, memoryEdgeLimit: 1 });

  assert.ok(result.instructions.includes(inst));
  assert.equal(result.memoryTraversalTruncated, false);
  assert.equal(result.truncated, false);
});

console.log('issue #4540 memoryOrigins maxEdges boundary: PASS');
