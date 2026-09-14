import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DebugAdapterError,
  boundedInteger,
  normalizeBreakpoint,
} from '../js/debug/adapter.js';

function assertInvalidNumber(fn) {
  assert.throws(fn, (error) => error instanceof DebugAdapterError && error.code === 'invalid-number');
}

test('boundedInteger accepts finite integer numbers and fallback', () => {
  assert.equal(boundedInteger(8, 1, 1, 4096), 8);
  assert.equal(boundedInteger(null, 1, 1, 4096), 1);
});

test('boundedInteger rejects protocol type coercion', () => {
  for (const value of [true, false, '8', '', [], [8], {}, 1.5, NaN, Infinity, -Infinity]) {
    assertInvalidNumber(() => boundedInteger(value, 1, 1, 4096, 'watchpoint size'));
  }
});

test('normalizeBreakpoint rejects coerced memory watchpoint size', () => {
  for (const size of [true, '8']) {
    assertInvalidNumber(() => normalizeBreakpoint({ kind: 'memory', address: 0, size }));
  }
  assert.deepEqual(normalizeBreakpoint({ kind: 'memory', address: 0, size: 8 }), {
    id: 'bp:memory:0:8:write',
    kind: 'memory',
    address: 0n,
    size: 8,
    access: 'write',
    enabled: true,
  });
});

// Maintainer-owned exact-head regression after canonical generated synchronization.
