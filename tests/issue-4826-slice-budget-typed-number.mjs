import assert from 'node:assert/strict';
import { backwardSlice, forwardSlice, causalChain, memoryOrigins, findPaths } from '../js/slice.js';

function constInst(id, prev) {
  return { id, op: 'const', block: 0, row: id, args: prev ? [{ value: { id: id * 10 + 1, kind: 'reg', def: prev } }] : [] };
}
function constChain(n) {
  let prev = null;
  const chain = [];
  for (let id = 1; id <= n; id++) { prev = constInst(id, prev); chain.push(prev); }
  return chain;
}

/* ── backwardSlice / forwardSlice / causalChain: structured limit must not become a budget ── */

{
  const chain = constChain(5);
  const ir = { instructions: chain };
  const full = backwardSlice(ir, chain[4], {});
  assert.equal(full.instructions.length, 5);
  assert.equal(full.truncated, false);
  for (const bad of [['1'], '1', [8], {}, true]) {
    const coerced = backwardSlice(ir, chain[4], { limit: bad });
    assert.equal(coerced.instructions.length, 5, `limit ${JSON.stringify(bad)} must fall back to the default`);
    assert.equal(coerced.truncated, false, `limit ${JSON.stringify(bad)} must not truncate the slice`);
  }
  const valid3 = backwardSlice(ir, chain[4], { limit: 3 });
  assert.equal(valid3.instructions.length, 3);
  assert.equal(valid3.truncated, true);
  const validFloor = backwardSlice(ir, chain[4], { limit: 2.5 });
  assert.equal(validFloor.instructions.length, 2);
  assert.equal(validFloor.truncated, true);
  const zero = backwardSlice(ir, chain[4], { limit: 0 });
  assert.equal(zero.instructions.length, 5, 'explicit zero stays a fallback');
}

{
  const chain = constChain(5);
  const ir = { instructions: chain };
  const full = causalChain(ir, chain[4], {});
  assert.equal(full.steps.length, 5);
  assert.equal(full.elided, 0);
  for (const bad of [['8'], '8', [2], {}, true]) {
    const coerced = causalChain(ir, chain[4], { limit: bad });
    assert.equal(coerced.steps.length, 5, `limit ${JSON.stringify(bad)} must keep the default 8`);
    assert.equal(coerced.elided, 0, `limit ${JSON.stringify(bad)} must not elide steps`);
  }
  const valid3 = causalChain(ir, chain[4], { limit: 3 });
  assert.equal(valid3.steps.length, 3);
  assert.equal(valid3.elided, 2);
  const clamped1 = causalChain(ir, chain[4], { limit: 1 });
  assert.equal(clamped1.steps.length, 2, 'finite numbers keep the minimum-2 clamp');
  const floored = causalChain(ir, chain[4], { limit: 2.5 });
  assert.equal(floored.steps.length, 2, 'finite fractional numbers keep the floor semantics');
}

{
  const uses = [];
  for (let id = 1; id <= 3; id++) uses.push(constInst(id, null));
  const seedValue = { id: 100, kind: 'reg', uses };
  for (const inst of uses) inst.dst = seedValue;
  const ir = { instructions: uses };
  const full = forwardSlice(ir, seedValue, {});
  assert.equal(full.instructions.length, 3);
  assert.equal(full.truncated, false);
  for (const bad of [['1'], '1', [1], {}, true]) {
    const coerced = forwardSlice(ir, seedValue, { limit: bad });
    assert.equal(coerced.instructions.length, 3, `limit ${JSON.stringify(bad)} must fall back to the default`);
    assert.equal(coerced.truncated, false, `limit ${JSON.stringify(bad)} must not truncate the slice`);
  }
  const valid1 = forwardSlice(ir, seedValue, { limit: 1 });
  assert.equal(valid1.instructions.length, 1);
  assert.equal(valid1.truncated, true);
}

/* ── memoryOrigins: maxNodes / maxEdges must be typed number boundaries ── */

{
  const s1 = { id: 1 }, s2 = { id: 2 }, s3 = { id: 3 };
  const nested = { kind: 'phi', incoming: [
    { node: { kind: 'store', inst: s1 } },
    { node: { kind: 'phi', incoming: [
      { node: { kind: 'store', inst: s2 } },
      { node: { kind: 'phi', incoming: [{ node: { kind: 'store', inst: s3 } }] } },
    ] } },
  ] };
  const full = memoryOrigins(nested, {});
  assert.equal(full.truncated, false);
  assert.equal(full.stores.length, 3);
  for (const bad of [['1'], '1', [1], {}, true]) {
    const coerced = memoryOrigins(nested, { maxNodes: bad, maxEdges: bad });
    assert.equal(coerced.truncated, false, `maxNodes/maxEdges ${JSON.stringify(bad)} must fall back to the defaults`);
    assert.equal(coerced.stores.length, 3, `maxNodes/maxEdges ${JSON.stringify(bad)} must keep full coverage`);
  }
  const valid = memoryOrigins(nested, { maxNodes: 2, maxEdges: 2 });
  assert.equal(valid.truncated, true, 'finite numbers still bound the traversal');
  assert.equal(valid.nodes, 2);
}

{
  const s1 = { id: 1 }, s2 = { id: 2 };
  const phi = { kind: 'phi', incoming: [
    { node: { kind: 'store', inst: s1 } },
    { node: { kind: 'store', inst: s2 } },
  ] };
  const oneEdge = memoryOrigins(phi, { maxNodes: 32, maxEdges: 1 });
  assert.equal(oneEdge.truncated, true, 'finite maxEdges=1 still truncates');
  for (const bad of [['1'], '1', [1], {}, true]) {
    const coerced = memoryOrigins(phi, { maxNodes: 32, maxEdges: bad });
    assert.equal(coerced.truncated, false, `maxEdges ${JSON.stringify(bad)} must fall back to the default`);
    assert.equal(coerced.stores.length, 2);
  }
}

{
  const load = { id: 9, op: 'load', args: [], memUse: { kind: 'store', inst: { id: 8 } }, row: 0, block: 0 };
  const ir = { instructions: [load] };
  const full = backwardSlice(ir, load, {});
  assert.equal(full.instructions.length, 2);
  assert.equal(full.memoryTraversalTruncated, false);
  for (const bad of [['1'], '1', [1], {}, true]) {
    const coerced = backwardSlice(ir, load, { memoryNodeLimit: bad, memoryEdgeLimit: bad });
    assert.equal(coerced.memoryTraversalTruncated, false, `memory limits ${JSON.stringify(bad)} must fall back to the defaults`);
  }
}

/* ── findPaths: maxDepth / maxPaths / maxVisited must be typed number boundaries ── */

function chainGraph(top) {
  return { calleesOf: (node) => (node < top ? [node + 1] : []) };
}

{
  const graph = chainGraph(30);
  const deep = findPaths(graph, 0, 20, { maxDepth: 12 });
  assert.equal(deep.length, 0, 'a finite maxDepth at the clamp ceiling still bounds traversal');
  for (const bad of [['20'], '20', [20], {}, true]) {
    const fallback = findPaths(graph, 0, 20, { maxDepth: bad });
    assert.equal(fallback.length, 0, `maxDepth ${JSON.stringify(bad)} must fall back to the default 6`);
  }
  const unbounded = findPaths(graph, 0, 20, { maxDepth: 30 });
  assert.equal(unbounded.length, 0, 'traversal beyond maxDepth 12 keeps the clamp ceiling');
  assert.equal(findPaths(graph, 0, 5, {}).length, 1, 'default maxDepth 6 still finds short paths');
  const small = findPaths(graph, 0, 5, { maxDepth: 1 });
  assert.equal(small.length, 0, 'finite maxDepth=1 keeps the minimum-1 clamp');
}

{
  const fan = { calleesOf: (node) => (node === 0 ? [1, 2, 3, 4, 5] : node === 9 ? [] : [9]) };
  const capped = findPaths(fan, 0, 9, { maxPaths: 2 });
  assert.equal(capped.length, 2, 'finite maxPaths still caps result count');
  for (const bad of [['2'], '2', [2], {}, true]) {
    const coerced = findPaths(fan, 0, 9, { maxPaths: bad });
    assert.equal(coerced.length, 5, `maxPaths ${JSON.stringify(bad)} must fall back to the default 8`);
  }
}

{
  for (const bad of [['500'], '500', [500], {}, true]) {
    let visits = 0;
    const graph = { calleesOf(node) { visits++; return node === 0 ? Array.from({ length: 500 }, (_, i) => i + 1) : []; } };
    findPaths(graph, 0, -1, { maxVisited: bad });
    assert.equal(visits, 501, `maxVisited ${JSON.stringify(bad)} must fall back to the default 20000 and drain the frontier`);
  }
  let visits = 0;
  const limited = { calleesOf(node) { visits++; return node === 0 ? Array.from({ length: 500 }, (_, i) => i + 1) : []; } };
  findPaths(limited, 0, -1, { maxVisited: 20 });
  assert.equal(visits, 20, 'finite maxVisited keeps the floor/clamp semantics');
}

console.log('issue #4826 slice budget typed-number boundary: PASS');
