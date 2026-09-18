import test from 'node:test';
import assert from 'node:assert/strict';

import { AnalysisQueryAPI } from '../../js/analysis/query/api.js';
import { createAppAnalysisQueryAdapter as createBaseAdapter } from '../../js/analysis/query/app-adapter.js';
import { createAppAnalysisQueryAdapter as createProductEvidenceAdapter } from '../../js/analysis/query/product-evidence-adapter.js';

const identity = Object.freeze({
  binaryId: 'issue-4101',
  projectRevision: 0,
  analysisEpoch: 0,
  artifactVersions: {},
});

function queryApiFor(completeness) {
  return new AnalysisQueryAPI({
    async currentIdentity() { return identity; },
    async binaryInfo() {
      return { value: { ok: true }, status: { completeness, reason: completeness === 'complete' ? null : 'fixture' } };
    },
  });
}

test('AnalysisQueryAPI preserves the canonical Phase7 completeness vocabulary', async () => {
  for (const completeness of ['complete', 'bounded', 'partial', 'truncated', 'unsupported']) {
    const api = queryApiFor(completeness);
    const snapshot = await api.snapshot();
    const result = await api.binaryInfo(snapshot);
    assert.equal(result.completeness, completeness, `${completeness} must survive the public query boundary`);
    assert.equal(result.status.completeness, completeness);
  }
});

test('base evidence never strengthens a bounded function artifact to complete or collapses it to partial', async () => {
  const adapter = createBaseAdapter({
    async analyzeFunction() {
      return {
        status: { completeness: 'bounded', reason: 'deliberate-bound' },
        decompiler: { evidence: [{ id: 'decompiler-e0' }] },
      };
    },
  });

  const result = await adapter.evidence({}, { address: 0x1000n }, { offset: 0, limit: 10 });
  assert.equal(result.value.length, 1);
  assert.equal(result.status.completeness, 'bounded');
});

test('base adapter completeness join recognizes bounded with canonical ordering', async () => {
  const cases = [
    [{ status: { completeness: 'complete' }, completeness: 'bounded' }, 'bounded'],
    [{ status: { completeness: 'bounded' }, partial: true }, 'partial'],
    [{ status: { completeness: 'bounded' }, truncated: true }, 'truncated'],
    [{ status: { completeness: 'bounded' }, unsupported: true }, 'unsupported'],
  ];

  for (const [producerResult, expected] of cases) {
    const adapter = createBaseAdapter({
      async querySearch() { return { results: [{ address: 0x1000n }], ...producerResult }; },
    });
    const result = await adapter.search({}, { text: 'needle' }, { offset: 0, limit: 10 });
    assert.equal(result.status.completeness, expected, JSON.stringify(producerResult));
  }
});

test('product evidence aggregation preserves bounded as the weakest canonical completeness', async () => {
  // complete base + bounded function
  {
    const adapter = createProductEvidenceAdapter({
      async getEvidence() { return [{ id: 'base-e0', verdict: 'supported' }]; },
      async analyzeFunction() {
        return { status: { completeness: 'bounded', reason: 'fixture' }, evidence: [] };
      },
    });
    const result = await adapter.evidence({}, { address: 0x1000n }, { offset: 0, limit: 10 });
    assert.equal(result.status.completeness, 'bounded', 'complete + bounded');
  }

  // Force base.evidence and the subsequent functionById lookup to observe
  // different canonical statuses so both operand directions are fixed.
  for (const [functionCompleteness, expected] of [
    ['complete', 'bounded'],
    ['partial', 'partial'],
    ['truncated', 'truncated'],
  ]) {
    let functionLoads = 0;
    const adapter = createProductEvidenceAdapter({
      async analyzeFunction() {
        functionLoads += 1;
        if (functionLoads === 1) {
          return {
            status: { completeness: 'bounded', reason: 'base-bound' },
            decompiler: { evidence: [{ id: 'base-e0', verdict: 'supported' }] },
          };
        }
        return {
          status: { completeness: functionCompleteness, reason: 'function-fixture' },
          evidence: [],
        };
      },
    });
    const result = await adapter.evidence({}, { address: 0x1000n }, { offset: 0, limit: 10 });
    assert.equal(result.status.completeness, expected, `bounded + ${functionCompleteness}`);
    assert.equal(functionLoads, 2);
  }
});
