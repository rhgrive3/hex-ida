import assert from 'node:assert/strict';
import { AIRuntime } from '../../../js/ai/runtime.js';
import { EvidenceStore } from '../../../js/ai/evidence.js';
import { createTurnSnapshot } from '../../../js/ai/control/snapshot.js';

function verifiedStore() {
  const store = new EvidenceStore();
  store.restorePersistedConfirmed([{
    id: 'old-unrelated',
    kind: 'observation',
    status: 'verified',
    title: 'unrelated prior fact',
    summary: 'must never substitute for an explicitly invalid citation',
    sourceTool: 'fixture',
  }, {
    id: 'valid-explicit',
    kind: 'observation',
    status: 'verified',
    title: 'explicit fact',
    summary: 'the model actually cited this fact',
    sourceTool: 'fixture',
  }]);
  return store;
}

async function finalize(decision, { plan = null } = {}) {
  const context = {};
  const evidenceStore = verifiedStore();
  const runtime = new AIRuntime({ context, evidenceStore, planner: false });
  const activity = [];
  const result = await runtime.finalize({
    request: { mode: 'chat', style: 'analyst', scope: 'auto' },
    decision: {
      type: 'final',
      answer: 'claim',
      confidence: 0.9,
      hypothesisIds: [],
      hypotheses: [],
      suggestedActions: [],
      followups: [],
      ...decision,
    },
    plan,
    activity,
    modelCalls: 1,
    toolCalls: 0,
    contextBytes: 0,
    wireUsage: {},
    started: 0,
    monotonicNow: () => 1,
    limitReason: null,
    registry: { analysisStats: { disassembly: 0 }, accounting: { cost: 0 } },
    snapshot: createTurnSnapshot(context, { scope: 'auto' }),
    effectiveScope: 'binary',
  });
  return { result, activity };
}

{
  const { result, activity } = await finalize({ evidenceIds: ['does-not-exist'] });
  assert.deepEqual(result.evidence, [], 'an explicitly invalid citation set must fail closed instead of binding unrelated fallback evidence');
  assert.equal(result.confidence, 0.5, 'no surviving explicit evidence must retain the evidence-free confidence cap');
  assert.equal(activity.some((event) => event.type === 'consistency-check' && /1/.test(event.label)), true,
    'missing explicit evidence must remain observable as a consistency failure');
}

{
  const { result } = await finalize({ evidenceIds: ['valid-explicit', 'does-not-exist'] });
  assert.deepEqual(result.evidence.map((item) => item.id), ['valid-explicit'],
    'partially valid explicit citations must preserve only the cited evidence');
  assert.equal(result.confidence, 0.9, 'surviving cited evidence should preserve the model confidence contract');
}

{
  const { result } = await finalize({ evidenceIds: [] });
  assert.deepEqual(result.evidence.map((item) => item.id), ['old-unrelated', 'valid-explicit'],
    'an omitted/empty citation selection may still use the existing deterministic verified fallback');
}

{
  const { result } = await finalize({}, { plan: { evidence: ['valid-explicit'] } });
  assert.deepEqual(result.evidence.map((item) => item.id), ['valid-explicit'],
    'planner evidence fallback must remain available when the model made no explicit citation selection');
}

{
  const { result } = await finalize({ evidenceIds: [] }, { plan: { evidence: ['valid-explicit'] } });
  assert.deepEqual(result.evidence.map((item) => item.id), ['valid-explicit'],
    'an explicitly empty citation array retains the existing planner-fallback contract');
}

{
  const { result } = await finalize({ evidenceIds: ['does-not-exist'] }, { plan: { evidence: ['valid-explicit'] } });
  assert.deepEqual(result.evidence, [],
    'planner evidence must not override a non-empty explicit citation set after every cited ID fails resolution');
  assert.equal(result.confidence, 0.5,
    'planner fallback suppression must still expose evidence-free confidence semantics');
}

{
  const { result } = await finalize({ evidenceIds: ['valid-explicit', 'does-not-exist'] }, { plan: { evidence: ['old-unrelated'] } });
  assert.deepEqual(result.evidence.map((item) => item.id), ['valid-explicit'],
    'partial explicit success must never append unrelated planner fallback evidence');
}

// Exercise the public turn path as well: executeTurn constructs the real
// createHexToolRegistry() and must preserve the same fail-closed evidence
// decision after request -> provider decision -> finalize.
{
  const evidenceStore = verifiedStore();
  const runtime = new AIRuntime({
    context: {},
    evidenceStore,
    planner: false,
    provider: {
      async nextTurn() {
        return {
          type: 'final',
          answer: 'public-path claim',
          confidence: 0.95,
          evidenceIds: ['does-not-exist'],
          hypothesisIds: [],
          suggestedActions: [],
          followups: [],
        };
      },
    },
  });
  const result = await runtime.turn({
    mode: 'chat',
    style: 'analyst',
    scope: 'auto',
    goal: 'exercise explicit missing evidence handling',
    budget: { maxModelCalls: 1 },
  });
  assert.deepEqual(result.evidence, [],
    'the real registry/turn path must not substitute unrelated evidence for invalid explicit citations');
  assert.equal(result.confidence, 0.5,
    'the real registry/turn path must apply the evidence-free confidence cap');
  assert.equal(result.activity.some((event) => event.type === 'consistency-check'), true,
    'the real registry/turn path must preserve the missing-citation diagnostic');
}

console.log('issue-5159-ai-explicit-missing-evidence-fail-closed: PASS');
