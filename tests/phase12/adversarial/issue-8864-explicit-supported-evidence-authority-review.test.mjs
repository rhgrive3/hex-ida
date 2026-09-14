import assert from 'node:assert/strict';
import test from 'node:test';

import { AIRuntime } from '../../../js/ai/runtime.js';
import { EvidenceStore } from '../../../js/ai/evidence.js';

function supportedPlan() {
  const best = {
    address: 0x1000n,
    name: 'candidate_A',
    score: 0.42,
    sources: ['synthetic-search'],
    reasons: ['synthetic-search'],
    evidence: ['raw-supported-source'],
    semanticFacts: [],
    verification: null,
    complete: true,
  };
  return {
    candidates: [best],
    best,
    evidence: ['raw-supported-source'],
    missingEvidence: ['no-runtime-or-causal-verification'],
    completeness: { complete: true, partial: false, budgetLimited: false, reason: null },
    stats: { analyzedFunctions: 1, disassembly: 0 },
  };
}

test('#8864 review: a valid explicit supported citation cannot lift the confidence authority cap', async () => {
  const plan = supportedPlan();
  const evidenceStore = new EvidenceStore();
  const supported = evidenceStore.ingestPlan(plan).find((record) => record.status === 'supported');
  assert.ok(supported, 'fixture must create a current valid supported record');

  const runtime = new AIRuntime({
    context: {},
    evidenceStore,
    planner: async () => plan,
    provider: {
      turnTimeoutMs() { return 120000; },
      async prepareCapabilities() {},
      getCapabilities() {
        return { contextTokens: 32768, maxOutputTokens: 4096, maxTools: 10, maxRequestBytes: 65536 };
      },
      async nextTurn() {
        return {
          type: 'final',
          answer: 'candidate_A definitely implements the requested behavior.',
          confidence: 1,
          evidenceIds: [supported.id],
          hypothesisIds: [],
          hypotheses: [],
          suggestedActions: [],
          followups: [],
        };
      },
    },
  });

  const result = await runtime.turn({
    mode: 'agent',
    style: 'beginner',
    scope: 'auto',
    goal: 'find the function that updates the counter',
    budget: { maxModelCalls: 1, maxToolCalls: 10 },
  });

  assert.deepEqual(result.evidence.map((record) => record.id), [supported.id],
    'the valid explicit citation remains attached for provenance');
  assert.equal(result.evidence[0].status, 'supported');
  assert.ok(result.confidence <= 0.5,
    `supported-only explicit evidence must not satisfy confidence authority, got ${result.confidence}`);
  assert.ok(!result.answer.includes('Hex が確認できた根拠'),
    'supported-only explicit evidence must not be presented as confirmed');
});
