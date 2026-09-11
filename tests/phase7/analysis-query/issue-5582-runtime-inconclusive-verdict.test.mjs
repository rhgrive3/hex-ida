import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { createAppAnalysisQueryAdapter } from '../../../js/analysis/query/product-evidence-adapter.js';
import { createRuntimeEvidenceRecord } from '../../../js/runtime-evidence/index.js';
import { runtimePlatformForApp } from '../../../js/runtime/app-runtime.js';

function makeApp() {
  const store = new Map([
    ['fileInfo', { hash: 'hash-5582', binaryId: 'bin-5582', slices: [] }],
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
const SLICE = 'slice:-1:-:arm64';

async function runtimeRowWithVerdict(verdict) {
  const app = makeApp();
  const platform = await runtimePlatformForApp(app);
  const adapter = createAppAnalysisQueryAdapter(app);
  const api = new AnalysisQueryAPI(adapter);
  // Record FIRST, then snapshot: the product snapshot identity binds the
  // query-visible runtime evidence corpus (#5630), so a snapshot taken before
  // the record would be stale by the time it is queried on the combined tree.
  platform._recordEvidence(createRuntimeEvidenceRecord({
    function: ADDRESS,
    binaryHash: 'hash-5582',
    sliceIdentity: SLICE,
    verdict,
    confidence: 0.35,
    kind: 'trace',
  }));
  const snapshot = await api.snapshot();
  const result = await api.evidence(snapshot, QUERY, { offset: 0, limit: 5000 }, {});
  const rows = Array.isArray(result?.value) ? result.value : [];
  return rows.find((row) => row.kind === 'trace' || row.kind === 'runtime-observation') ?? null;
}

test('runtime evidence with canonical producer verdict "inconclusive" is not laundered into "confirmed" (#5582)', async () => {
  const row = await runtimeRowWithVerdict('inconclusive');
  assert.ok(row, 'runtime-observation row must be projected');
  assert.notEqual(
    row.verdict,
    'confirmed',
    'the product consumer must not strengthen an inconclusive runtime verdict into confirmed (#5582)',
  );
  assert.equal(row.verdict, 'inconclusive', 'the inconclusive verdict is preserved verbatim (fail-closed, no strengthening)');
});

test('runtime evidence with an unrecognized verdict falls back to unverified, never confirmed (#5582)', async () => {
  const row = await runtimeRowWithVerdict('definitely-confirmed-trust-me');
  assert.ok(row, 'runtime-observation row must be projected');
  assert.equal(row.verdict, 'unverified', 'unrecognized verdicts must degrade to the weakest canonical tier');
});

test('canonical runtime verdicts still project verbatim (#5582 control)', async () => {
  const confirmed = await runtimeRowWithVerdict('confirmed');
  assert.ok(confirmed, 'control row must be projected');
  assert.equal(confirmed.verdict, 'confirmed');

  const contradicted = await runtimeRowWithVerdict('contradicted');
  assert.ok(contradicted, 'control row must be projected');
  assert.equal(contradicted.verdict, 'contradicted');
});
