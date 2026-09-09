// Regression for #5582: the product evidence adapter projected runtime
// observations with fallback verdict 'confirmed', so the runtime producer's
// 'inconclusive' verdict (traceFunction / readRuntimeField evidence) fell
// through canonicalVerdict()'s unknown-verdict fallback and surfaced to
// product/UI consumers as 'confirmed'. Evidence strength must never be
// strengthened by a consumer: unrecognized verdicts now fall back to
// 'unverified', while recognized canonical verdicts pass through unchanged.
//
// The observation stream is driven through the real runtime platform path
// (RuntimeAnalysisPlatform.traceFunction writes exactly this record shape into
// platform.evidence), so the projection sees the authentic producer output.
import assert from 'node:assert/strict';
import { createAppAnalysisQueryAdapter } from '../../js/analysis/query/product-evidence-adapter.js';
import { runtimePlatformForApp, runtimeIdentityForApp } from '../../js/runtime/app-runtime.js';

const HASH = 'a'.repeat(64);
const FN = 0x1000n;

const fileInfo = { hash: HASH };
const app = {
  store: { get: (key) => (key === 'fileInfo' ? fileInfo : null) },
  backend: {
    contentHash: HASH,
    readAt: async () => ({ found: true, bytes: [1, 2, 3] }),
  },
};

async function observationVerdicts(address) {
  const adapter = createAppAnalysisQueryAdapter(app);
  const result = await adapter.evidence(
    { get: () => null },
    { address },
    { offset: 0, limit: 50 },
    {},
  );
  // the projection keeps the producer's own kind (e.g. 'trace'); the verdict is
  // what must never be strengthened
  return (result?.value ?? []).filter((row) => row.verdict != null);
}

const platform = await runtimePlatformForApp(app);
const { sliceIdentity: liveSliceIdentity } = await runtimeIdentityForApp(app);
const record = (base) => ({ ...base, binaryHash: HASH, source: 'runtime', function: FN, sliceIdentity: liveSliceIdentity });

// an inconclusive runtime trace must not surface as confirmed
{
  platform.evidence.push(record({
    id: 'trace-inconclusive', kind: 'trace', verdict: 'inconclusive', confidence: 0.35,
  }));
  const rows = await observationVerdicts(FN);
  assert.equal(rows.length, 1, 'the observation is projected');
  assert.notEqual(rows[0].verdict, 'confirmed', 'inconclusive must not become confirmed');
  assert.equal(rows[0].verdict, 'unverified', 'inconclusive falls back to unverified');
}

// recognized canonical verdicts pass through without strengthening or weakening
{
  platform.evidence.push(record({
    id: 'read-supported', kind: 'memory-read', verdict: 'supported', confidence: 0.8,
  }));
  platform.evidence.push(record({
    id: 'trace-contradicted', kind: 'trace', verdict: 'contradicted', confidence: 0.9,
  }));
  const rows = await observationVerdicts(FN);
  assert.deepEqual(
    rows.filter((r) => r.evidenceId === 'read-supported' || r.evidenceId === 'trace-contradicted').map((r) => r.verdict).sort(),
    ['contradicted', 'supported'],
    'recognized canonical verdicts pass through unchanged');
}

console.log('issue #5582 product adapter never strengthens runtime verdicts regression: PASS');
