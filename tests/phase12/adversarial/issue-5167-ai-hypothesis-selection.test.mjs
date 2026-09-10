import assert from 'node:assert/strict';
import { AIRuntime } from '../../../js/ai/runtime.js';
import { createTurnSnapshot } from '../../../js/ai/control/snapshot.js';

const context = {
  binaryFingerprint: { algorithm: 'fnv1a64', hash: 'issue-5167' },
  sliceIndex: 0,
};
const snapshot = createTurnSnapshot(context, { scope: 'auto' });
const registry = {
  analysisStats: { disassembly: 0 },
  accounting: { cost: 0 },
};

function decision(overrides = {}) {
  return {
    type: 'final',
    answer: 'answer',
    confidence: 0.9,
    evidenceIds: [],
    hypotheses: [],
    suggestedActions: [],
    followups: [],
    ...overrides,
  };
}

async function finalize(runtime, finalDecision) {
  return runtime.finalize({
    request: { mode: 'chat', style: 'analyst', scope: 'auto' },
    decision: finalDecision,
    plan: null,
    activity: [],
    modelCalls: 1,
    toolCalls: 0,
    contextBytes: 0,
    wireUsage: {},
    started: 0,
    monotonicNow: () => 1,
    limitReason: null,
    registry,
    snapshot,
    effectiveScope: 'binary',
  });
}

const runtime = new AIRuntime({ context, planner: false });
runtime.hypothesisStore.upsert({ id: 'old', claim: 'stale hypothesis', confidence: 0.4 });
runtime.hypothesisStore.upsert({ id: 'selected', claim: 'selected hypothesis', confidence: 0.8 });

const explicitEmpty = await finalize(runtime, decision({ hypothesisIds: [] }));
assert.deepEqual(
  explicitEmpty.hypotheses,
  [],
  'an explicit empty hypothesisIds selection must mean zero hypotheses, not the whole store',
);

const explicitOne = await finalize(runtime, decision({ hypothesisIds: ['selected'] }));
assert.deepEqual(explicitOne.hypotheses.map((item) => item.id), ['selected']);

const explicitMissing = await finalize(runtime, decision({ hypothesisIds: ['does-not-exist'] }));
assert.deepEqual(explicitMissing.hypotheses, [], 'unknown explicit IDs must not fall back to unrelated hypotheses');

const omitted = await finalize(runtime, decision());
assert.deepEqual(
  omitted.hypotheses.map((item) => item.id),
  ['old', 'selected'],
  'omitting hypothesisIds keeps the existing session-level fallback semantics',
);

const modelAuthoredButUnselected = await finalize(runtime, decision({
  hypothesisIds: [],
  hypotheses: [{ id: 'new-from-model', claim: 'new model hypothesis', confidence: 0.6 }],
}));
assert.ok(runtime.hypothesisStore.get('new-from-model'), 'model-authored hypotheses are still persisted in the store');
assert.deepEqual(
  modelAuthoredButUnselected.hypotheses,
  [],
  'newly upserted hypotheses outside the explicit selection must not leak into the response',
);


const turnRuntime = new AIRuntime({
  context,
  planner: false,
  provider: {
    nextTurn: async () => decision({ hypothesisIds: [] }),
  },
});
turnRuntime.hypothesisStore.upsert({ id: 'prior-turn', claim: 'prior turn hypothesis', confidence: 0.5 });
const turnResult = await turnRuntime.turn({ mode: 'chat', style: 'analyst', scope: 'auto', goal: 'answer without hypotheses' });
assert.deepEqual(
  turnResult.hypotheses,
  [],
  'the public turn path must preserve an explicit empty hypothesis selection from provider decision to final response',
);
assert.ok(turnRuntime.hypothesisStore.get('prior-turn'), 'explicit response selection must not delete session-level hypotheses');

console.log('issue-5167-ai-hypothesis-selection: PASS');
