import assert from 'node:assert/strict';
import test from 'node:test';

import { functionPaths } from '../js/query/causal.js';

function emptyProgram(overrides = {}) {
  return {
    functionRange() { return { start: 0x1000n, end: 0x1010n }; },
    calleesOf() { return []; },
    graphCompleteness: { callsComplete: true },
    ...overrides,
  };
}

test('#3678 fails closed when ProgramIndex authority is unavailable', () => {
  for (const program of [null, undefined]) {
    assert.deepEqual(functionPaths(program, 0x1000n, 0x2000n), {
      paths: [],
      complete: false,
      truncated: true,
      reasons: ['program-unavailable'],
      visited: 0,
    });
  }
});

test('#3678 does not turn missing endpoints into a complete absence proof', () => {
  const program = emptyProgram();
  for (const [from, to] of [[null, 0x2000n], [0x1000n, null]]) {
    assert.deepEqual(functionPaths(program, from, to), {
      paths: [],
      complete: false,
      truncated: true,
      reasons: ['invalid-endpoint'],
      visited: 0,
    });
  }
});

test('#3678 preserves a complete empty result after an actual exhaustive graph query', () => {
  const result = functionPaths(emptyProgram(), 0x1000n, 0x2000n);
  assert.deepEqual(result.paths, []);
  assert.equal(result.complete, true);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.visited, 1);
});

test('#3678 preserves the zero-hop path when source and target are identical', () => {
  const result = functionPaths(emptyProgram(), 0x1000n, 0x1000n);
  assert.deepEqual(result.paths, [[0x1000n]]);
  assert.equal(result.complete, true);
  assert.equal(result.truncated, false);
  assert.equal(result.visited, 1);
});
