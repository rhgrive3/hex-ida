import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryOrigins, backwardSlice } from '../js/slice.js';

test('#5000: memoryOrigins defaults to 1024 maxNodes and 2048 maxEdges when omitted', () => {
  const store1 = { id: 1 };
  const phi = { kind: 'phi', incoming: [{ node: { kind: 'store', inst: store1 } }] };
  const res = memoryOrigins(phi);
  assert.equal(res.truncated, false);
  assert.equal(res.stores.length, 1);
});

test('#5000: memoryOrigins clamps valid primitive safe integers', () => {
  // Build a chain of stores connected by phis
  function buildChain(count) {
    let root = { kind: 'store', inst: { id: count } };
    for (let i = count - 1; i >= 1; i--) {
      root = { kind: 'phi', incoming: [{ node: root }, { node: { kind: 'store', inst: { id: i } } }] };
    }
    return root;
  }

  const graph = buildChain(10);
  const clampedNodes = memoryOrigins(graph, { maxNodes: 3 });
  assert.equal(clampedNodes.truncated, true);
  assert.equal(clampedNodes.nodes, 3);

  const clampedEdges = memoryOrigins(graph, { maxNodes: 100, maxEdges: 2 });
  assert.equal(clampedEdges.truncated, true);
});

test('#5000: memoryOrigins rejects fractional budgets and falls back to defaults without truncating', () => {
  const s1 = { id: 1 }, s2 = { id: 2 };
  const phi = {
    kind: 'phi',
    incoming: [
      { node: { kind: 'store', inst: s1 } },
      { node: { kind: 'store', inst: s2 } },
    ],
  };

  // If maxNodes: 1.9 was floored to 1, it would truncate this two-store graph.
  // It must be rejected as non-safe-integer and fall back to default 1024.
  for (const frac of [1.9, 0.5, 2.7, 1.0001]) {
    const res = memoryOrigins(phi, { maxNodes: frac, maxEdges: frac });
    assert.equal(res.truncated, false, `fractional budget ${frac} must fall back to default`);
    assert.equal(res.stores.length, 2);
  }
});

test('#5000: memoryOrigins rejects unsafe integers and falls back to defaults instead of clamping', () => {
  const s1 = { id: 1 }, s2 = { id: 2 };
  const phi = {
    kind: 'phi',
    incoming: [
      { node: { kind: 'store', inst: s1 } },
      { node: { kind: 'store', inst: s2 } },
    ],
  };

  const unsafeValues = [
    Number.MAX_SAFE_INTEGER + 10,
    9007199254740992,
    1e30,
    Infinity,
    -Infinity,
    NaN,
  ];

  for (const unsafe of unsafeValues) {
    const res = memoryOrigins(phi, { maxNodes: unsafe, maxEdges: unsafe });
    assert.equal(res.truncated, false, `unsafe value ${unsafe} must fall back to default`);
    assert.equal(res.stores.length, 2);
  }
});

test('#5000: memoryOrigins denies budget authority to numeric strings', () => {
  const s1 = { id: 1 }, s2 = { id: 2 };
  const phi = { kind: 'phi', incoming: [
    { node: { kind: 'store', inst: s1 } },
    { node: { kind: 'store', inst: s2 } },
  ] };

  // If '1' was coerced to 1, maxNodes/maxEdges would truncate.
  // With fallback to default 1024/2048, it must not truncate.
  for (const bad of ['1', '0', '10000', '20000', '-5']) {
    const res = memoryOrigins(phi, { maxNodes: bad, maxEdges: bad });
    assert.equal(res.truncated, false, `numeric string ${JSON.stringify(bad)} must fall back to default`);
    assert.equal(res.stores.length, 2);
  }
});

test('#5000: memoryOrigins denies budget authority to arrays, objects, and booleans', () => {
  const s1 = { id: 1 }, s2 = { id: 2 };
  const phi = { kind: 'phi', incoming: [
    { node: { kind: 'store', inst: s1 } },
    { node: { kind: 'store', inst: s2 } },
  ] };

  for (const bad of [['1'], ['10000'], [1], {}, { valueOf: () => 1 }, true, false, null]) {
    const res = memoryOrigins(phi, { maxNodes: bad, maxEdges: bad });
    assert.equal(res.truncated, false, `non-primitive ${JSON.stringify(bad)} must fall back to default`);
    assert.equal(res.stores.length, 2);
  }
});

test('#5000 & #4727: memoryOrigins clamps non-positive safe integers to 1', () => {
  const s1 = { id: 1 }, s2 = { id: 2 };
  const phi = { kind: 'phi', incoming: [
    { node: { kind: 'store', inst: s1 } },
    { node: { kind: 'store', inst: s2 } },
  ] };

  // Negative and zero values are clamped to 1 per #4727
  const neg = memoryOrigins(phi, { maxNodes: -5, maxEdges: -10 });
  assert.equal(neg.truncated, true, 'negative budgets clamp to 1 and truncate');
  assert.equal(neg.nodes, 1);

  const zeroNodes = memoryOrigins(phi, { maxNodes: 0 });
  assert.equal(zeroNodes.truncated, true, 'maxNodes: 0 clamps to 1 and truncates');
  assert.equal(zeroNodes.nodes, 1);
});

test('#5000: memoryOrigins preserves explicit maxEdges === 0 contract (#4540)', () => {
  const s1 = { id: 1 };
  const phi = { kind: 'phi', incoming: [{ node: { kind: 'store', inst: s1 } }] };
  const res = memoryOrigins(phi, { maxEdges: 0 });
  assert.equal(res.truncated, true, 'maxEdges: 0 must truncate phi expansion immediately');
  assert.equal(res.stores.length, 0);
});

test('#5000: backwardSlice applies the same contract to memoryNodeLimit and memoryEdgeLimit', () => {
  const s1 = { id: 10 }, s2 = { id: 20 };
  const memGraph = {
    kind: 'phi',
    incoming: [
      { node: { kind: 'store', inst: s1 } },
      { node: { kind: 'store', inst: s2 } },
    ],
  };
  const load = { id: 1, op: 'load', args: [], memUse: memGraph, row: 0, block: 0 };
  const ir = { instructions: [load] };

  // Using arrays, strings, fractional numbers, or unsafe numbers for memory limits
  // must fall back to defaults and not expand/contract authority
  for (const bad of [['1'], '1', ['10000'], '20000', {}, true, 1.9, 1e30]) {
    const res = backwardSlice(ir, load, { memoryNodeLimit: bad, memoryEdgeLimit: bad });
    assert.equal(res.memoryTraversalTruncated, false, `bad limit ${JSON.stringify(bad)} must fall back to defaults`);
  }
});
