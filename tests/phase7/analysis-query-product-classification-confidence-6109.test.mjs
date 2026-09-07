import assert from 'node:assert/strict';
import test from 'node:test';
import { createProductSurfaceQueries } from '../../js/analysis/query/product-surface.js';

// The historical wrapper imported a root fixture that was never committed.
// Exercise the actual product query here so the Phase 7 denominator is runnable.
const snapshot = Object.freeze({ snapshotId: 'confidence-6109', analysisEpoch: 1 });
async function classification(confidence) {
  return createProductSurfaceQueries({
    analysisQueries: { snapshot: async () => snapshot },
    recognition: { records: [{ address: 4096n, classification: 'GAME_LOGIC', confidence }] },
    analyzeFunctionAt: async () => null,
  }).classification(snapshot, '0x1000');
}

test('#6109 classification preserves finite numeric confidence in [0, 1]', async () => {
  for (const confidence of [0, 0.25, 1]) {
    const result = await classification(confidence);
    assert.equal(result.value.confidence, confidence);
    assert.equal(result.value.base.confidence, confidence);
    assert.equal(result.status.completeness, 'partial');
  }
});

test('#6109 classification rejects coerced and out-of-range confidence', async () => {
  let coercions = 0;
  for (const confidence of [undefined, null, true, false, '1', [1], NaN, Infinity, -Infinity, -0.1, 1.1,
    { valueOf() { coercions++; return 1; }, toString() { coercions++; return '1'; } }]) {
    const result = await classification(confidence);
    assert.equal(result.value.confidence, 0);
    assert.equal(result.value.base.confidence, 0);
  }
  assert.equal(coercions, 0);
});
