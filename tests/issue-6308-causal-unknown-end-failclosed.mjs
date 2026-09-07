/**
 * Issue #6308 regression: when a function's end is unknown, `functionPaths()`
 * must not treat the rest of the address space as that function's body. Callee
 * expansion is fail-closed (`function-range-unknown`) instead of claiming
 * later functions' call sites as callees.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { functionPaths } from '../js/query/causal.js';

function programIndexLike({ unknownEndFor = null } = {}) {
  const symbols = {
    functionCount: 2,
    functionAt(addr) {
      if (addr === 0x1000n) return { start: 0x1000n, end: unknownEndFor === 0x1000n ? null : 0x2000n };
      if (addr === 0x2000n) return { start: 0x2000n, end: 0x3000n };
      return null;
    },
  };
  const callFrom = new BigUint64Array([0x1004n, 0x2004n]);
  const callTo = new BigUint64Array([0x3000n, 0x4000n]);
  const callsComplete = true;
  const callsCapped = false;
  return {
    callFrom,
    callTo,
    symbols,
    graphCompleteness: { callsComplete },
    callsCapped,
    functionAt: (addr) => symbols.functionAt(addr) ?? null,
    functionStartOf: (addr) => {
      if (addr >= 0x1000n && addr < 0x2000n) return 0x1000n;
      if (addr >= 0x2000n && addr < 0x3000n) return 0x2000n;
      return null;
    },
    functionRange: (addr) => {
      const fn = symbols.functionAt(addr);
      if (!fn) return null;
      return { start: fn.start, end: fn.end != null ? fn.end : null, region: null };
    },
    calleesOf(start, end, limit = 200) {
      const out = new Map();
      for (let i = 0; i < callFrom.length; i++) {
        const from = callFrom[i];
        if (end != null && from >= end) break;
        if (from < start) continue;
        out.set(callTo[i].toString(), { addr: callTo[i], site: from, count: 1 });
        if (out.size >= limit) break;
      }
      return [...out.values()];
    },
  };
}

test('#6308 unknown-end function does not absorb later call sites', () => {
  const program = programIndexLike({ unknownEndFor: 0x1000n });
  // 0x2004 -> 0x4000 belongs to function 0x2000; it must never be reachable
  // through the unbounded tail of function 0x1000.
  const out = functionPaths(program, 0x1000n, 0x4000n, { maxDepth: 4, maxPaths: 8 });
  assert.deepEqual(out.paths, []);
  assert.ok(out.reasons.includes('function-range-unknown'));
  assert.equal(out.complete, false);
  assert.equal(out.truncated, true);
});

test('#6308 unknown-end function still reaches its own true callees', () => {
  const program = programIndexLike({ unknownEndFor: 0x1000n });
  // 0x1004 -> 0x3000 is inside function 0x1000's true body, but the body bound
  // is unprovable, so the edge cannot be attributed either.
  const out = functionPaths(program, 0x1000n, 0x3000n, { maxDepth: 4, maxPaths: 8 });
  assert.deepEqual(out.paths, []);
  assert.ok(out.reasons.includes('function-range-unknown'));
});

test('#6308 exact bounded range still expands only in-range call sites', () => {
  const program = programIndexLike();
  const seen = [];
  const wrapped = {
    ...program,
    calleesOf: (start, end, limit) => {
      seen.push([start.toString(), end.toString()]);
      return program.calleesOf(start, end, limit);
    },
  };
  const out = functionPaths(wrapped, 0x1000n, 0x3000n, { maxDepth: 4, maxPaths: 8 });
  assert.deepEqual(out.paths, [[0x1000n, 0x3000n]]);
  assert.equal(out.complete, true);
  // Every callee query is bounded by the head's exact function end.
  assert.ok(seen.length >= 1);
  assert.deepEqual(seen[0], ['4096', '8192']);
});

test('#6308 half-open boundary: call at end address is not a callee', () => {
  const callFrom = new BigUint64Array([0x2000n]); // exactly at end of fn 0x1000
  const callTo = new BigUint64Array([0x5000n]);
  const program = {
    graphCompleteness: { callsComplete: true },
    functionRange: (addr) => (addr === 0x1000n ? { start: 0x1000n, end: 0x2000n, region: null } : null),
    calleesOf(start, end) {
      const out = [];
      for (let i = 0; i < callFrom.length; i++) {
        if (callFrom[i] < start) continue;
        if (end != null && callFrom[i] >= end) break;
        out.push({ addr: callTo[i], site: callFrom[i], count: 1 });
      }
      return out;
    },
  };
  const out = functionPaths(program, 0x1000n, 0x5000n, { maxDepth: 4 });
  assert.deepEqual(out.paths, [], 'half-open semantics must exclude the call at end');
});

test('#6308 null range is fail-closed with a reason', () => {
  const program = {
    graphCompleteness: { callsComplete: true },
    functionRange: () => null,
    calleesOf: () => [],
  };
  const out = functionPaths(program, 0x1000n, 0x2000n, { maxDepth: 4 });
  assert.deepEqual(out.paths, []);
  assert.ok(out.reasons.includes('function-range-unknown'));
  assert.equal(out.complete, false);
});

test('#6308 existing completeness and truncation semantics are preserved', () => {
  const program = programIndexLike();
  // One edge now reaches 0x3000. A different sink still requires expansion
  // beyond that edge budget, independently of the incomplete source graph.
  const partial = functionPaths({ ...program, graphCompleteness: { callsComplete: false } }, 0x1000n, 0x4000n, { maxDepth: 1 });
  assert.deepEqual(partial.paths, []);
  assert.ok(partial.reasons.includes('depth-limit'));
  assert.ok(partial.reasons.includes('program-calls-incomplete'));
  assert.equal(partial.complete, false);
});
