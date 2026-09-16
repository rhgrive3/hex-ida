/*
 * Issue #8864 — the planner-evidence fallback must be bound to the current
 * plan and must never launder a `supported`/stale ranking record into
 * confirmed final-answer authority.
 *
 * These run the production `AIRuntime.turn()` path: deterministic planner
 * result -> EvidenceStore.ingestPlan() -> provider final decision with no
 * citations -> finalize/present/persist.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AIRuntime } from '../../../js/ai/runtime.js';
import { EvidenceStore } from '../../../js/ai/evidence.js';
import { InvestigationSessionStore } from '../../../js/ai/session-core/index.js';
import { fallbackEvidence, presentAnswer, qualifyingEvidence, withPlanEvidenceBinding } from '../../../js/ai/control/runtime-support.js';

function candidate({ address = 0x1000n, name = 'candidate_A', evidence = ['raw-source-1'], verification = null }) {
  return {
    address, name, score: 0.42, sources: ['synthetic-search'], reasons: ['synthetic-search'],
    evidence, semanticFacts: [], verification, complete: true,
  };
}

function planFor({ evidence = [], best = null, missingEvidence = ['no-runtime-or-causal-verification'] } = {}) {
  const candidates = best ? [best] : [];
  return {
    candidates, best, evidence, missingEvidence,
    completeness: { complete: true, partial: false, budgetLimited: false, reason: null },
    stats: { analyzedFunctions: candidates.length, disassembly: 0 },
  };
}

function providerDecision({ confidence = 1, answer = 'candidate_A definitely implements the requested behavior.', evidenceIds = [] } = {}) {
  return {
    type: 'final', answer, confidence, evidenceIds,
    hypothesisIds: [], hypotheses: [], suggestedActions: [], followups: [],
  };
}

function harness({ plans, decisions, provider = true }) {
  const turns = [];
  let call = 0;
  const runtime = new AIRuntime({
    context: {},
    planner: async () => {
      const plan = plans[Math.min(call, plans.length - 1)];
      return plan;
    },
    provider: provider ? {
      turnTimeoutMs() { return 120000; },
      async prepareCapabilities() {},
      getCapabilities() { return { contextTokens: 32768, maxOutputTokens: 4096, maxTools: 10, maxRequestBytes: 65536 }; },
      async nextTurn() {
        const decision = decisions[Math.min(call, decisions.length - 1)];
        call += 1;
        return decision;
      },
    } : null,
  });
  return { runtime, turns };
}

async function agentTurn(runtime, goal, sessionId = null) {
  return runtime.turn({
    mode: 'agent', style: 'beginner', scope: 'auto', goal,
    budget: { maxModelCalls: 1, maxToolCalls: 10 },
    ...(sessionId ? { sessionId } : {}),
  });
}

test('#8864 counterexample A: supported planner evidence cannot become confirmed final evidence', async () => {
  const best = candidate({});
  const { runtime } = harness({
    plans: [planFor({ best, evidence: ['raw-source-1'] })],
    decisions: [providerDecision({})],
  });
  const result = await agentTurn(runtime, 'find the function that updates the counter');
  assert.equal(result.evidence.length > 0, true, 'the current plan ranking record may still be surfaced');
  assert.equal(result.evidence.every((item) => item.status === 'supported'), true);
  assert.equal(result.evidence.some((item) => item.status === 'verified'), false,
    'a supported planner record must never appear as verified final evidence');
  assert.ok(result.confidence <= 0.5, `evidence-free-of-authority must keep the cap, got ${result.confidence}`);
  assert.ok(!result.answer.includes('Hex が確認できた根拠'), 'beginner prose must not claim confirmed evidence');
});

test('#8864 counterexample B: a later empty plan cannot inherit an earlier turn evidence', async () => {
  const best = candidate({});
  const first = planFor({ best, evidence: ['raw-source-1'] });
  const second = planFor({ evidence: [], best: null, missingEvidence: ['no-candidate-function'] });
  const { runtime } = harness({
    plans: [first, second],
    decisions: [providerDecision({}), providerDecision({ answer: 'second unrelated claim' })],
  });
  const a = await agentTurn(runtime, 'find the function that updates the counter');
  const b = await agentTurn(runtime, 'find the function that updates the counter', a.sessionId);
  assert.equal(a.evidence.length, 1);
  assert.equal(b.evidence.length, 0, 'turn B has no plan evidence of its own and must inherit none');
  assert.ok(b.confidence <= 0.5, `stale fallback must not lift the confidence cap, got ${b.confidence}`);
  assert.ok(b.answer.includes('次に確認する点: no-candidate-function'), 'the real gap stays visible');
});

test('#8864: successive non-empty plans attach only their own bound records', async () => {
  const planA = planFor({ best: candidate({ address: 0x1000n, name: 'candidate_A', evidence: ['raw-a'] }), evidence: ['raw-a'] });
  const planB = planFor({ best: candidate({ address: 0x2000n, name: 'candidate_B', evidence: ['raw-b'] }), evidence: ['raw-b'] });
  const { runtime } = harness({
    plans: [planA, planB],
    decisions: [providerDecision({}), providerDecision({ answer: 'candidate_B claim' })],
  });
  const a = await agentTurn(runtime, 'find the function that updates the counter');
  const b = await agentTurn(runtime, 'find the function that updates the counter', a.sessionId);
  assert.deepEqual(a.evidence.map((item) => item.sourceData.sourceId).sort(), ['raw-a']);
  assert.deepEqual(b.evidence.map((item) => item.sourceData.sourceId).sort(), ['raw-b'],
    'turn B must receive only records bound to plan B');
});

test('#8864: a genuinely verified deterministic current candidate maps raw source IDs to canonical records', async () => {
  const best = candidate({ evidence: ['raw-1'], verification: { verified: true, evidenceIds: ['raw-1'] } });
  const plan = planFor({ best, evidence: ['raw-1'], missingEvidence: [] });
  const { runtime } = harness({ plans: [plan], decisions: [], provider: false });
  const result = await agentTurn(runtime, 'find the function that updates the counter');
  assert.ok(result.evidence.length >= 2, 'candidate-source and candidate-verification records both bind');
  assert.equal(result.evidence.every((item) => item.status === 'verified'), true);
  assert.ok(result.confidence > 0.5, 'verified deterministic current-plan evidence may carry the answer');
  assert.ok(result.answer.includes('Hex が確認できた根拠は'), 'confirmed prose is allowed for deterministic verified evidence');
  const ids = new Set(result.evidence.map((item) => item.id));
  assert.ok([...ids].every((id) => /^ev_[0-9a-f]{32}$/.test(id)), 'cited ids are canonical record ids');
});

test('#9009 review blocker: provider address-free final cannot inherit plan authority by omitting citations', async () => {
  const best = candidate({ evidence: ['raw-1'], verification: { verified: true, evidenceIds: ['raw-1'] } });
  const plan = planFor({ best, evidence: ['raw-1'], missingEvidence: [] });
  const { runtime } = harness({
    plans: [plan],
    decisions: [providerDecision({
      answer: 'candidate_A definitely deletes every user account.',
      evidenceIds: [],
    })],
  });
  const result = await agentTurn(runtime, 'find the function that updates the counter');
  assert.ok(result.evidence.length >= 2, 'current-plan evidence may remain attached as provenance');
  assert.equal(result.evidence.every((item) => item.status === 'verified'), true);
  assert.ok(result.confidence <= 0.5, `provider prose must not inherit plan authority, got ${result.confidence}`);
  assert.ok(!result.answer.includes('Hex が確認できた根拠は'), 'provider prose must not be presented as confirmed');
  const session = await runtime.sessionStore.get(result.sessionId);
  assert.deepEqual(session.investigationMemory?.confirmedFacts || [], [], 'untrusted provider prose must persist no confirmed facts');
});

test('#8864: the session-global planner scan is gone from the fallback', () => {
  const store = new EvidenceStore();
  store.add({ sourceTool: 'deterministic-goal-planner', sourceId: 'stale-raw', kind: 'candidate-source', status: 'supported', title: 'stale ranking' });
  store.add({ sourceTool: 'deterministic-goal-planner', sourceId: 'other-source', kind: 'candidate-source', status: 'verified', title: 'stale claim' });
  // An earlier turn's records are invisible to a plan that does not name them.
  assert.deepEqual(fallbackEvidence(store, { evidence: ['other-plan-source'] }), []);
  // A plan that names a record whose provenance does not match gets nothing:
  // the raw id must be the record's own source identity, not any tool's id.
  assert.deepEqual(fallbackEvidence(store, { evidence: ['does-not-exist'] }), []);
  // A plan with no evidence at all gets no planner authority either.
  assert.deepEqual(fallbackEvidence(store, { evidence: [] }), []);
  // A turn with no planner result at all keeps the #5159 verified-session view.
  const sessionStore = new InvestigationSessionStore();
  store.restorePersistedConfirmed(sessionStore.register({
    id: 'issue-8864-session',
    confirmedFindings: [{
      id: 'persisted-verified', kind: 'verification', status: 'verified', title: 'verified', sourceTool: 'fixture',
    }],
  }).confirmedFindings);
  assert.deepEqual(fallbackEvidence(store, null).map((item) => item.id), ['persisted-verified']);
  // Qualifying authority is separate from exposure: a supported bound record may
  // be surfaced but never satisfies the gate.
  const bound = { evidenceRecordIds: ['persisted-verified'], evidence: ['stale-raw'] };
  assert.deepEqual(store.planEvidence(bound).map((item) => item.id), ['persisted-verified'],
    'verifiedOnly keeps `supported` ranking out of the authority set');
  assert.deepEqual(qualifyingEvidence(store.planEvidence(bound, { verifiedOnly: false })).map((item) => item.id), ['persisted-verified']);
});

test('#8864: the binding is the exact canonical set produced by one ingestPlan call', () => {
  const store = new EvidenceStore();
  const planA = planFor({ best: candidate({ address: 0x1000n, name: 'candidate_A', evidence: ['shared-source'] }), evidence: ['shared-source'] });
  const planB = planFor({ best: candidate({ address: 0x2000n, name: 'candidate_B', evidence: ['other-source'] }), evidence: ['other-source'] });
  const boundA = withPlanEvidenceBinding(planA, store.ingestPlan(planA));
  const boundB = withPlanEvidenceBinding(planB, store.ingestPlan(planB));
  assert.equal(boundA.evidenceRecordIds.length > 0, true);
  assert.equal(boundB.evidenceRecordIds.length > 0, true);
  assert.deepEqual(
    store.planEvidence(boundA, { verifiedOnly: false }).map((item) => item.id).sort(),
    boundA.evidenceRecordIds.slice().sort(),
    'multiple raw source IDs map deterministically to their own canonical records',
  );
  for (const record of store.planEvidence(boundA, { verifiedOnly: false })) {
    assert.equal(record.functionAddress, '0x1000', 'plan A evidence stays on plan A candidates');
  }
  assert.equal(store.planEvidence(boundB, { verifiedOnly: false }).some((record) => record.functionAddress === '0x1000'), false);
  assert.deepEqual(qualifyingEvidence(fallbackEvidence(store, boundB)), [],
    'a `supported` ranking record never satisfies the verified-evidence gate');
});

test('#8864: presentation keeps supported and verified evidence semantically distinct', () => {
  const supported = [{ id: 'a', status: 'supported' }];
  const mixed = [{ id: 'a', status: 'supported' }, { id: 'b', status: 'verified' }];
  assert.ok(presentAnswer('claim', 'beginner', supported, null).includes('確認済みにした根拠がまだありません'));
  const mixedText = presentAnswer('claim', 'beginner', mixed, null);
  assert.ok(mixedText.includes('Hex が確認できた根拠は 1 件です'), mixedText);
  assert.ok(mixedText.includes('未検証の補強根拠も 1 件'), mixedText);
  assert.equal(presentAnswer('claim', 'analyst', supported, null), 'claim');
});
