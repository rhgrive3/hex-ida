import assert from 'node:assert/strict';
import { functionPaths } from '../../../js/query/causal.js';

const fanoutProgram = (fanout = 200) => ({
  functionRange(head) { return { start: head, end: head + 1n }; },
  calleesOf(head) {
    return Array.from({ length: fanout }, (_, k) => ({ addr: head * 211n + BigInt(k + 1) }));
  },
  graphCompleteness: { callsComplete: true },
});

function maxEnqueuedTracked(program, from, to, opts) {
  let live = 0, peak = 0;
  const wrapped = {
    functionRange: (h) => program.functionRange(h),
    calleesOf: (h, e, c) => program.calleesOf(h, e, c),
    graphCompleteness: program.graphCompleteness,
  };
  const out = functionPaths(wrapped, from, to, opts);
  return { out, peak };
}

const r1 = functionPaths(fanoutProgram(), 1n, -1n, { maxDepth: 4, maxPaths: 32, maxVisited: 1000 });
assert.equal(r1.complete, false, 'frontier-exhausted result must not be an absence proof');
assert.equal(r1.truncated, true);
assert.ok(r1.reasons.includes('frontier-limit'), `expected frontier-limit, got ${JSON.stringify(r1.reasons)}`);

const r2 = functionPaths(fanoutProgram(), 1n, -1n, {});
assert.equal(r2.complete, false, 'default find_paths shape must fail closed on frontier');
assert.ok(r2.reasons.includes('frontier-limit'));
assert.ok(r2.visited < 1000, 'frontier bound must be hit before the visited budget');

const r3 = functionPaths(fanoutProgram(), 1n, 212n, {});
assert.ok(r3.paths.length > 0);
assert.ok(r3.paths.every((p) => Array.isArray(p) && p[0] === 1n && p[p.length - 1] === 212n));

const r4 = functionPaths(fanoutProgram(), 1n, 212n, { maxDepth: 1, maxPaths: 32, maxVisited: 1000 });
assert.ok(r4.paths.length >= 1, 'direct edge must still be discoverable');

const cycleProgram = {
  functionRange(head) { return { start: head, end: head + 1n }; },
  calleesOf(head) {
    if (head === 1n) return [{ addr: 2n }, { addr: 3n }];
    if (head === 2n) return [{ addr: 1n }, { addr: 4n }];
    if (head === 3n) return [{ addr: 1n }];
    return [];
  },
  graphCompleteness: { callsComplete: true },
};
const r5 = functionPaths(cycleProgram, 1n, 4n, { maxDepth: 6, maxPaths: 8, maxVisited: 1000 });
assert.equal(r5.complete, true, 'a small in-budget graph must remain complete');
assert.deepEqual(r5.paths, [[1n, 2n, 4n]]);
assert.ok(r5.paths.every((p) => new Set(p).size === p.length), 'no path repeats a node');

const multiplexProgram = {
  functionRange(head) { return { start: head, end: head + 1n }; },
  calleesOf(head) {
    if (head === 1n) return [{ addr: 2n }, { addr: 3n }];
    if (head === 2n) return [{ addr: 4n }];
    if (head === 3n) return [{ addr: 4n }];
    return [];
  },
  graphCompleteness: { callsComplete: true },
};
const r6 = functionPaths(multiplexProgram, 1n, 4n, { maxDepth: 6, maxPaths: 8, maxVisited: 1000 });
assert.equal(r6.paths.length, 2, 'path multiplicity preserved for in-budget graphs');

const calleeLimitProgram = {
  functionRange(head) { return { start: head, end: head + 1n }; },
  calleesOf() { return Array.from({ length: 201 }, (_, k) => ({ addr: BigInt(10000 + k) })); },
  graphCompleteness: { callsComplete: true },
};
const r7 = functionPaths(calleeLimitProgram, 1n, -1n, { maxDepth: 1, maxPaths: 8, maxVisited: 1000 });
assert.ok(r7.reasons.includes('callee-limit'));

const emptyProgram = {
  functionRange(h) { return { start: h, end: h + 1n }; },
  calleesOf() { return []; },
  graphCompleteness: { callsComplete: true },
};
const r8 = functionPaths(emptyProgram, 1n, -1n, {});
assert.equal(r8.complete, true);
assert.equal(r8.paths.length, 0);
assert.equal(r8.truncated, false);

const depthProgram = {
  functionRange(h) { return { start: h, end: h + 1n }; },
  calleesOf(h) { return [{ addr: h + 1n }]; },
  graphCompleteness: { callsComplete: true },
};
const r9 = functionPaths(depthProgram, 1n, -1n, { maxDepth: 3, maxPaths: 8, maxVisited: 1000 });
assert.ok(r9.reasons.includes('depth-limit'), '#4529 edge-depth semantics preserved');

assert.ok(Number.isSafeInteger(r1.visited) && r1.visited >= 1);
console.log('issue-8915 query-causal frontier-admission regression PASS');
