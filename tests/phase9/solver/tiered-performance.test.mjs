import assert from 'node:assert/strict';
import test from 'node:test';

import { measureTieredSolver } from '../../../tools/validation/phase9/tiered-solver-metrics.mjs';

test('startup, 32/64 solve, and memory harness records the deployed tier without weakening budgets', async () => {
  const metrics = await measureTieredSolver();
  assert.equal(metrics.schemaVersion, 'hex-tiered-solver-metrics/v1');
  assert.equal(metrics.backend.id, 'hex-tiered-qfbv');
  assert.equal(typeof metrics.backend.capabilityFingerprint, 'string');
  assert.ok(Number.isFinite(metrics.startup.elapsedMs) && metrics.startup.elapsedMs >= 0);
  assert.ok(Number.isSafeInteger(metrics.startup.heapDeltaBytes) && metrics.startup.heapDeltaBytes >= 0);
  assert.deepEqual(metrics.solves.map((sample) => sample.width), [32, 64]);
  for (const sample of metrics.solves) {
    assert.equal(sample.status, 'sat');
    assert.equal(sample.route, 'bitblast-qfbv');
    assert.ok(Number.isFinite(sample.elapsedMs) && sample.elapsedMs >= 0);
    assert.ok(Number.isSafeInteger(sample.heapDeltaBytes) && sample.heapDeltaBytes >= 0);
    assert.ok(sample.cnfVariables > 0);
    assert.ok(sample.cnfClauses > 0);
  }
  assert.deepEqual(metrics.resourceCeilings, {
    maxVariables: 400000,
    maxClauses: 1600000,
    maxDecisions: 500000,
    maxPropagations: 8000000,
  });
});
