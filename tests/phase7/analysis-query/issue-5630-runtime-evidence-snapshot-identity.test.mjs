import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { createAppAnalysisQueryAdapter } from '../../../js/analysis/query/product-evidence-adapter.js';
import { createRuntimeEvidenceRecord } from '../../../js/runtime-evidence/index.js';
import { runtimePlatformForApp } from '../../../js/runtime/app-runtime.js';

function makeApp() {
  const store = new Map([
    ['fileInfo', { hash: 'hash-5630', binaryId: 'bin-5630', slices: [] }],
    ['capability', { architecture: 'arm64', semanticVersion: 'test-v1' }],
  ]);
  return {
    store: { get: (key) => store.get(key) ?? null },
    backend: { gen: 0 },
    symbols: { gen: 0, functionEvidence: () => null, nameAt: () => null, nameEvidence: () => null },
  };
}

const ADDRESS = 0x1000n;
const QUERY = { address: '0x1000' };

async function collectRows(api, snapshot) {
  const result = await api.evidence(snapshot, QUERY, { offset: 0, limit: 5000 }, {});
  return Array.isArray(result?.value) ? result.value : [];
}

test('runtime evidence recorded after snapshot() makes that snapshot stale (#5630)', async () => {
  const app = makeApp();
  const platform = await runtimePlatformForApp(app);
  const adapter = createAppAnalysisQueryAdapter(app);
  const api = new AnalysisQueryAPI(adapter);

  const before = await api.snapshot();
  const rowsBefore = await collectRows(api, before);
  assert.ok(rowsBefore.every((row) => row.kind !== 'runtime-observation'), 'precondition: no runtime rows yet');

  platform._recordEvidence(createRuntimeEvidenceRecord({
    function: ADDRESS,
    binaryHash: 'hash-5630',
    sliceIdentity: 'slice:-1:-:arm64',
    verdict: 'confirmed',
    kind: 'trace',
  }));

  const after = await api.snapshot();
  assert.notEqual(
    before.snapshotId,
    after.snapshotId,
    'snapshot identity must change when runtime evidence appears (#5630)',
  );

  const rowsAfter = await collectRows(api, after);
  assert.ok(rowsAfter.some((row) => row.kind === 'trace' && row.verdict === 'confirmed'), 'runtime row projected after recording');

  // The pre-record snapshot is now stale: queries that reuse it must fail
  // closed instead of silently returning different rows for the same id.
  await assert.rejects(
    () => api.evidence(before, QUERY, {}, {}),
    (error) => error?.code === 'analysis-snapshot-stale' || error?.name === 'AnalysisSnapshotStaleError',
  );
});

test('identity is stable when no runtime evidence changed (#5630 control)', async () => {
  const app = makeApp();
  const adapter = createAppAnalysisQueryAdapter(app);
  const api = new AnalysisQueryAPI(adapter);
  const first = await api.snapshot();
  const second = await api.snapshot();
  assert.equal(first.snapshotId, second.snapshotId);
});
