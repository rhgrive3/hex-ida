import assert from 'node:assert/strict';
import { findPaths } from '../js/slice.js';

// #4439: maxVisited must bound the frontier, not just dequeued paths.
// Count path.concat allocations: one high fan-out expansion must not
// allocate far beyond maxVisited.
const fanout = 100000;
const graph = {
  calleesOf(node) {
    if (node !== 0) return [];
    return Array.from({ length: fanout }, (_, i) => i + 1);
  },
};

let concatCalls = 0;
const origConcat = Array.prototype.concat;
Array.prototype.concat = function (...args) {
  concatCalls++;
  return origConcat.apply(this, args);
};
let paths;
try {
  paths = findPaths(graph, 0, -1, { maxDepth: 6, maxPaths: 8, maxVisited: 16 });
} finally {
  Array.prototype.concat = origConcat;
}
assert.ok(Array.isArray(paths), 'findPaths returns an array');
assert.ok(
  concatCalls <= 16,
  `frontier allocations bounded by maxVisited=16, got ${concatCalls} concats for ${fanout} fan-out`,
);

// Small-graph shortest-path order is preserved.
const small = {
  calleesOf(node) {
    if (node === 'a') return ['b', 'c'];
    if (node === 'b') return ['d'];
    if (node === 'c') return ['d'];
    return [];
  },
};
const smallPaths = findPaths(small, 'a', 'd', { maxDepth: 6, maxPaths: 8, maxVisited: 20000 });
assert.equal(smallPaths.length, 2);
assert.deepEqual(smallPaths[0], ['a', 'b', 'd']);
assert.deepEqual(smallPaths[1], ['a', 'c', 'd']);

// Null endpoints stay safe.
assert.deepEqual(findPaths(graph, null, 1, {}), []);
assert.deepEqual(findPaths(graph, 0, null, {}), []);

console.log('issue #4439 findPaths frontier bound: PASS');
