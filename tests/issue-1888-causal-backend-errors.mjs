import assert from 'node:assert/strict';
import { functionPaths } from '../js/query/causal.js';

const rangeFailure = functionPaths({
  graphCompleteness: { callsComplete: true },
  functionRange() { throw new Error('backend unavailable'); },
  calleesOf() { return []; },
}, 0x1000n, 0x2000n);

assert.deepEqual(rangeFailure.paths, []);
assert.equal(rangeFailure.complete, false);
assert.equal(rangeFailure.truncated, true);
assert.ok(rangeFailure.reasons.includes('function-range-error'));

const calleeFailure = functionPaths({
  graphCompleteness: { callsComplete: true },
  functionRange() { return { end: 0x1100n }; },
  calleesOf() { throw new Error('backend unavailable'); },
}, 0x1000n, 0x2000n);

assert.deepEqual(calleeFailure.paths, []);
assert.equal(calleeFailure.complete, false);
assert.equal(calleeFailure.truncated, true);
assert.ok(calleeFailure.reasons.includes('callee-query-error'));

console.log('issue #1888 causal backend error regression PASS');
