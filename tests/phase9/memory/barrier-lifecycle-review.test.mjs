import test from 'node:test';
import assert from 'node:assert/strict';
import { createByteMemory } from '../../../js/symbolic/memory/byte-memory.js';
import { symbolicExecute } from '../../../js/symbolic/index.js';
import { identity, scalarFixture } from '../taint/fixtures.mjs';

test('barrier cannot be cleared by a later empty or malformed reason', () => {
  for (const reason of ['', null, false, 0]) {
    const memory = createByteMemory({ identity });
    memory.store(0n, 1, 42n);
    memory.barrier('unknown-call');
    try { memory.barrier(reason); } catch (error) { assert.ok(error instanceof TypeError); }
    const read = memory.load(0n, 1);
    assert.equal(read.status, 'unknown');
    assert.equal(read.reason, 'unknown-call');
    assert.equal(read.expression, null);
  }
});

test('direct byte executor respects zero outer timeout during preflight', () => {
  const result = symbolicExecute(scalarFixture(), { timeoutMs: 0, byteMemory: { identity } });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.paths, []);
  assert.equal(result.reason, 'deadline');
});
