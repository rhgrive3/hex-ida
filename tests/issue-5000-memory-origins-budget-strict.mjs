import assert from 'node:assert/strict';
import { backwardSlice, memoryOrigins } from '../js/slice.js';

// A linear MemorySSA phi chain long enough that the sanctioned defaults
// (maxNodes 1024 / maxEdges 2048) truncate it, while the coercion targets
// named in the issue (numeric string '20000' / array ['10000'] -> 10000/20000)
// would let it drain fully. Exploring the whole chain is the observable
// symptom of unauthorized budget authority.
const LENGTH = 3000;
const leafInst = { id: 'leaf-store', op: 'store' };
function memoryChain() {
  let node = { kind: 'store', inst: leafInst };
  for (let i = 0; i < LENGTH; i++) node = { kind: 'phi', incoming: [{ node }] };
  return node;
}

// #4540 / #4727 shared micro fixtures for the preserved-boundary checks.
const s1 = { id: 1, op: 'store' };
const s2 = { id: 2, op: 'store' };
const s3 = { id: 3, op: 'store' };
const nested = { kind: 'phi', incoming: [
  { node: { kind: 'store', inst: s1 } },
  { node: { kind: 'phi', incoming: [
    { node: { kind: 'store', inst: s2 } },
    { node: { kind: 'phi', incoming: [{ node: { kind: 'store', inst: s3 } }] } },
  ] } },
] };

// 1. Primitive valid budget clamps as before and explores the full chain.
const primitive = memoryOrigins(memoryChain(), { maxNodes: 5000, maxEdges: 5000 });
assert.equal(primitive.truncated, false);
assert.equal(primitive.nodes, LENGTH + 1);
assert.equal(primitive.edges, LENGTH);

// Primitive at/above the sanctioned ceiling clamps (never exceeds authority).
const clamped = memoryOrigins(memoryChain(), { maxNodes: 1e9, maxEdges: 1e9 });
assert.equal(clamped.truncated, false, 'clamped to 10000/20000 still drains a 3000-node chain');

// 4. Omitted budget falls back to the 1024/2048 defaults and truncates.
const omitted = memoryOrigins(memoryChain(), {});
assert.equal(omitted.truncated, true);
assert.equal(omitted.nodes, 1024);

// 2. Numeric string must NOT gain budget authority (fails closed to default).
const nodeString = memoryOrigins(memoryChain(), { maxNodes: '10000', maxEdges: 20000 });
assert.equal(nodeString.truncated, true, 'numeric string maxNodes must not expand node budget');
assert.equal(nodeString.nodes, 1024);
const edgeString = memoryOrigins(memoryChain(), { maxNodes: 10000, maxEdges: '20000' });
assert.equal(edgeString.truncated, true, 'numeric string maxEdges must not expand edge budget');

// 3. Array / object must NOT gain budget authority (issue minimal counterexample).
const arrayBoth = memoryOrigins(memoryChain(), { maxNodes: ['10000'], maxEdges: ['20000'] });
assert.equal(arrayBoth.truncated, true, 'array budget values must not gain authority');
assert.equal(arrayBoth.nodes, 1024);
const objectNode = memoryOrigins(memoryChain(), { maxNodes: { valueOf: () => 10000 }, maxEdges: 20000 });
assert.equal(objectNode.truncated, true, 'object maxNodes must not gain authority via valueOf coercion');
assert.equal(objectNode.nodes, 1024);

// Boolean must fail closed to the fallback, not coerce to a tiny budget of 1.
const boolNode = memoryOrigins(memoryChain(), { maxNodes: true, maxEdges: 20000 });
assert.equal(boolNode.nodes, 1024, 'boolean maxNodes falls back to the default node budget');

// 5. The agent-facing backwardSlice() path honours the same contract.
const chainForSlice = memoryChain();
const sliceLoad = { id: 'load-1', op: 'load', args: [], memUse: chainForSlice, row: 0, block: 0 };
const structuredSlice = backwardSlice({ instructions: [leafInst, sliceLoad] }, sliceLoad, {
  memoryNodeLimit: ['10000'],
  memoryEdgeLimit: '20000',
});
assert.equal(structuredSlice.memoryTraversalTruncated, true, 'structured slice limits must fail closed');
const primitiveSlice = backwardSlice({ instructions: [leafInst, sliceLoad] }, sliceLoad, {
  memoryNodeLimit: 10000,
  memoryEdgeLimit: 20000,
});
assert.equal(primitiveSlice.memoryTraversalTruncated, false, 'primitive budgets drain the chain');
assert.ok(primitiveSlice.instructions.includes(leafInst));

// 6. #4540 edge boundary + explicit zero-edge contract are preserved.
const singleEdge = { kind: 'phi', incoming: [{ node: { kind: 'store', inst: s1 } }] };
const boundary = memoryOrigins(singleEdge, { maxNodes: 10, maxEdges: 1 });
assert.deepEqual(boundary.stores, [s1]);
assert.equal(boundary.nodes, 2);
assert.equal(boundary.truncated, false);
const zeroEdge = memoryOrigins(nested, { maxNodes: 32, maxEdges: 0 });
assert.equal(zeroEdge.truncated, true);
assert.deepEqual(zeroEdge.stores, []);
const zeroNode = memoryOrigins(nested, { maxNodes: 0, maxEdges: 32 });
assert.equal(zeroNode.truncated, true);
assert.equal(zeroNode.nodes, 1);

console.log('issue #5000 memoryOrigins budget strict contract: PASS');
