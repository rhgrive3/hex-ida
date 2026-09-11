import assert from 'node:assert/strict';
import test from 'node:test';

import { createProductSurfaceQueries } from '../../js/analysis/query/product-surface.js';
import { createAnalysisSnapshot } from '../../js/analysis/query/snapshot.js';

// #5344: the product surface used to compare only the snapshotId string, so an
// envelope whose other identity fields were missing or contradictory was
// accepted as current whenever it named the current snapshot. The surface must
// enforce the same canonical AnalysisSnapshot contract AnalysisQueryAPI does.

const CURRENT = createAnalysisSnapshot({ binaryId: 'binary-5344', analysisEpoch: 1 });

function app(overrides = {}) {
  return {
    analysisQueries: { snapshot: async () => overrides.current ?? CURRENT },
    store: { get: () => null },
    backend: { gen: 1, strings: async () => ({ complete: true, scannedBytes: 0, results: [] }) },
    autoReport: { report: { findings: [{ id: 'a', title: 'A', verdict: 'confirmed', confidence: 1 }] } },
    recognition: { records: [] },
  };
}

test('#5344 a forged envelope naming the current snapshotId is rejected', async () => {
  const forged = { snapshotId: CURRENT.snapshotId, analysisEpoch: 999999 };
  const queries = createProductSurfaceQueries(app());
  await assert.rejects(() => queries.claims(forged, {}, {}), (error) => error?.name === 'TypeError');
  await assert.rejects(() => queries.strings(forged, {}, { offset: 0, limit: 5 }), (error) => error?.name === 'TypeError');
  await assert.rejects(() => queries.classification(forged, 0x1000n), (error) => error?.name === 'TypeError');
});

test('#5344 a canonical envelope is accepted and its epoch flows through unchanged', async () => {
  const queries = createProductSurfaceQueries(app());
  const result = await queries.claims(CURRENT, {}, {});
  assert.equal(result.snapshotId, CURRENT.snapshotId);
  assert.equal(result.analysisEpoch, CURRENT.analysisEpoch);
});

test('#5344 a canonical envelope for a stale snapshot is still rejected as stale', async () => {
  const stale = createAnalysisSnapshot({ binaryId: 'binary-5344', analysisEpoch: 2 });
  const queries = createProductSurfaceQueries(app());
  await assert.rejects(() => queries.claims(stale, {}, {}), (error) => error?.code === 'ANALYSIS_SNAPSHOT_STALE');
});

test('#5344 forged identity fields cannot ride a correct snapshotId', async () => {
  // Even with every canonical field present, a snapshotId that does not match
  // the recomputed identity must be rejected by the shared contract.
  const forged = {
    ...CURRENT,
    analysisEpoch: 7,
  };
  const queries = createProductSurfaceQueries(app());
  await assert.rejects(() => queries.claims(forged, {}, {}), (error) => error?.name === 'TypeError');
});
