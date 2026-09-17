import test from 'node:test';
import assert from 'node:assert/strict';
import { queryTaint, createTaintModels, symbolicExecute } from '../../../js/symbolic/index.js';
import { identity, scalarFixture } from './fixtures.mjs';
const models = createTaintModels({ id: 'deadline-model', version: '1', provenance: 'regression', sinks: [{ id: 'out', valueId: 'out' }] });

test('the outer taint deadline interrupts executor preflight, not just later projection', () => {
  let checks = 0;
  const result = queryTaint(scalarFixture(), { identity, models, timeoutMs: 5,
    now: () => checks >= 50 ? 5 : 0,
    getCurrentIdentity: () => { checks++; return identity; },
    memory: { addressBits: 8, timeoutMs: 250 }, execution: { timeoutMs: 250 } });
  assert.equal(result.status, 'partial'); assert.equal(result.reason, 'deadline');
  assert.equal(result.evidence, null); assert.deepEqual(result.sinks, []);
  assert.ok(checks <= 64, `preflight ran ${checks} lifecycle checks after a bounded deadline`);
});

test('non-finite and backwards clocks cannot bypass query deadlines', () => {
  for (const now of [() => NaN, () => Infinity, (() => { let n = 10; return () => n--; })()]) {
    const result = symbolicExecute(scalarFixture(), { byteMemory: { identity, now } });
    assert.equal(result.status, 'partial'); assert.equal(result.reason, 'invalid-clock');
    assert.deepEqual(result.paths, []); assert.ok(Number.isFinite(result.metrics.wallClock));
  }
});

test('a narrower memory deadline still wins over the outer taint allowance', () => {
  const result = queryTaint(scalarFixture(), { identity, models, timeoutMs: 120, memory: { timeoutMs: 0 } });
  assert.equal(result.status, 'partial'); assert.equal(result.reason, 'deadline'); assert.equal(result.evidence, null);
});
