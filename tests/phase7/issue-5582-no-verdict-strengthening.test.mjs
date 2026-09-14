// Regression for #5582, absorbed from superseded PR #7851.
// The product evidence adapter must never strengthen runtime evidence.
// Canonical #7820 semantics preserve the runtime producer's recognized
// `inconclusive` verdict verbatim, while truly unrecognized verdicts fall back
// to `unverified`. This keeps the source PR's independent runtimePlatformForApp
// + product-adapter path alongside #7820's AnalysisQueryAPI regression.
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
  // The projection keeps the producer's own kind (e.g. 'trace'); the verdict is
  // what must never be strengthened.
  return (result?.value ?? []).filter((row) => row.verdict != null);
}

const platform = await runtimePlatformForApp(app);
const { sliceIdentity: liveSliceIdentity } = await runtimeIdentityForApp(app);
const record = (base) => ({ ...base, binaryHash: HASH, source: 'runtime', function: FN, sliceIdentity: liveSliceIdentity });

// A canonical inconclusive runtime trace must remain inconclusive, never
// surface as confirmed product evidence.
{
  platform.evidence.push(record({
    id: 'trace-inconclusive', kind: 'trace', verdict: 'inconclusive', confidence: 0.35,
  }));
  const rows = await observationVerdicts(FN);
  assert.equal(rows.length, 1, 'the observation is projected');
  assert.notEqual(rows[0].verdict, 'confirmed', 'inconclusive must not become confirmed');
  assert.equal(rows[0].verdict, 'inconclusive', 'recognized inconclusive verdict is preserved verbatim');
}

// Recognized canonical verdicts pass through without strengthening or weakening.
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
    'recognized canonical verdicts pass through unchanged',
  );
}

console.log('issue #5582 product adapter never strengthens runtime verdicts regression: PASS');
