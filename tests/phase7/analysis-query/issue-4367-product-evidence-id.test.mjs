import assert from 'node:assert/strict';
import { runtimePlatformForApp, resetAppRuntime } from '../../../js/runtime/app-runtime.js';
import { createAppAnalysisQueryAdapter } from '../../../js/analysis/query/product-evidence-adapter.js';

const address = 0x1000n;
const fileInfo = {
  hash: 'binary-hash-4367',
  slices: [{ info: { uuid: 'slice-uuid-4367', architecture: 'arm64' } }],
};

const app = {
  backend: { binaryId: 'binary-4367', gen: 0 },
  store: {
    get(key) {
      if (key === 'fileInfo') return fileInfo;
      if (key === 'project') return { revision: 0 };
      if (key === 'sliceIndex') return 0;
      if (key === 'architecture') return 'arm64';
      return null;
    },
  },
  async getEvidence() {
    return [
      { id: ['base-array'], verdict: 'supported', detail: 'base-array' },
      { evidenceId: { source: 'base-object' }, verdict: 'supported', detail: 'base-object' },
      { id: 7, verdict: 'supported', detail: 'base-number' },
      { id: true, verdict: 'supported', detail: 'base-boolean' },
      { id: ' base-padded ', verdict: 'supported', detail: 'base-padded' },
      { id: 'base-valid', verdict: 'supported', detail: 'base-valid' },
      { id: null, verdict: 'supported', detail: 'base-null' },
    ];
  },
  async analyzeFunction() {
    return {
      evidence: [
        { id: { source: 'function-object' }, verdict: 'supported', detail: 'function-object' },
        { id: 'function-valid', verdict: 'supported', detail: 'function-valid' },
      ],
      rewriteProof: [
        { evidenceId: ['rewrite-array'], verdict: 'supported', rule: 'rewrite-array' },
        { evidenceId: 'rewrite-valid', verdict: 'supported', rule: 'rewrite-valid' },
      ],
    };
  },
};

const runtimePlatform = await runtimePlatformForApp(app);
runtimePlatform.evidence.push(
  { id: ['runtime-array'], binaryHash: fileInfo.hash, sliceIdentity: 'slice:0:slice-uuid-4367:arm64', function: address, verdict: 'confirmed' },
  { id: 'runtime-valid', binaryHash: fileInfo.hash, sliceIdentity: 'slice:0:slice-uuid-4367:arm64', function: address, verdict: 'confirmed' },
);

try {
  const adapter = createAppAnalysisQueryAdapter(app);
  const snapshot = await adapter.currentIdentity();
  const result = await adapter.evidence(snapshot, { address });
  assert.equal(result.status.completeness, 'complete');
  assert.equal(result.page.next, null);
  assert.equal(result.page.total, 13);
  assert.deepEqual(result.value.map((row) => row.evidenceId), [
    null, null, null, null, null, 'base-valid', null,
    null, 'function-valid',
    null, 'rewrite-valid',
    null, 'runtime-valid',
  ]);
  assert.deepEqual(result.value.map((row) => row.verdict), Array(13).fill('supported').map((_, index) => index >= 11 ? 'confirmed' : 'supported'));
} finally {
  await resetAppRuntime(app);
}

console.log('issue-4367 product evidence identity boundary regression: PASS');
