import test from 'node:test';
import assert from 'node:assert/strict';

import { AIRuntime } from '../../../js/ai/runtime.js';
import { EvidenceStore } from '../../../js/ai/evidence.js';
import { claimedAddresses, qualifyingEvidence } from '../../../js/ai/control/runtime-support.js';

// #9009: a genuinely verified record proves its own subject. An authentic
// `0x1000` candidate-verification record that a provider happens to cite must
// not terminalise an unrelated claim about `0xDEAD`, even though the record
// exists, is `verified`, and was produced by the deterministic planner path.

function proofStoreFor0x1000() {
  const evidenceStore = new EvidenceStore();
  const plan = {
    candidates: [{
      address: 0x1000n,
      name: 'incrementCounter',
      score: 10,
      sources: ['write-analysis'],
      evidence: ['proof-counter-write'],
      semanticFacts: [{ kind: 'field-update', field: 'counter' }],
      verification: { verified: true, evidenceIds: ['proof-counter-write'] },
      complete: true,
    }],
    best: null,
    evidence: ['proof-counter-write'],
    missingEvidence: [],
    completeness: { complete: true, partial: false, budgetLimited: false },
  };
  plan.best = plan.candidates[0];
  const created = evidenceStore.ingestPlan(plan);
  const verified = created.find((item) => item.kind === 'candidate-verification');
  assert.equal(verified.status, 'verified', 'the fixture proof must be genuinely verified');
  return { evidenceStore, verified };
}

function runtimeFor({ answer, evidenceIds, style = 'beginner', goal = 'what does 0x1000 do?' }) {
  const { evidenceStore, verified } = proofStoreFor0x1000();
  const runtime = new AIRuntime({
    context: { binaryId: 'audit:bin' },
    evidenceStore,
    planner: false,
    provider: {
      async nextTurn() {
        return {
          type: 'final',
          answer,
          confidence: 1,
          evidenceIds: evidenceIds ?? [verified.id],
          hypothesisIds: [],
          hypotheses: [],
          suggestedActions: [],
          proposals: [],
          followups: [],
        };
      },
    },
  });
  return { runtime, verified, turn: () => runtime.turn({ mode: 'chat', style, scope: 'binary', goal, budget: { maxModelCalls: 1, maxToolCalls: 0 } }) };
}

test('#9009 counterexample A: an authentic verified record cannot authorize an unrelated address claim', async () => {
  const { runtime, verified, turn } = runtimeFor({ answer: 'The function at 0xDEAD definitely deletes all user data.' });
  const result = await turn();
  assert.equal(verified.functionAddress, '0x1000');
  assert.deepEqual(result.evidence.map((item) => item.id), [verified.id],
    'the authentic record stays attached as provenance');
  assert.ok(result.confidence <= 0.5, `an unbound citation must keep the no-authority cap, got ${result.confidence}`);
  assert.ok(!result.answer.includes('Hex が確認できた根拠は'),
    'beginner prose must not present the unrelated proof as confirmed evidence');
  assert.ok(result.answer.includes('この回答には、Hex が確認済みにした根拠がまだありません'),
    'the missing proof stays visible instead of being laundered');
  assert.equal(result.activity.some((event) => event.type === 'consistency-check'), true,
    'the demotion must be observable, not silent');
});

test('#9009: a matching deterministic claim binding keeps the intended terminal authority', async () => {
  const { verified, turn } = runtimeFor({ answer: 'The function at 0x1000 writes the counter field.' });
  const result = await turn();
  assert.equal(result.evidence.map((item) => item.id)[0], verified.id);
  assert.ok(result.confidence > 0.5, 'the proof of the asserted subject must still carry the answer');
  assert.ok(result.answer.includes('Hex が確認できた根拠は'), 'confirmed prose stays available for bound proof');
});

test('#9009: an address-free claim keeps the #5159/#8864 explicit-citation contract', async () => {
  const { turn } = runtimeFor({ answer: 'addCoins is the strongest indexed candidate.', goal: 'locate the coin writer' });
  const result = await turn();
  assert.equal(result.confidence, 1, 'nothing proves an address-free claim unsupported');
  assert.ok(result.answer.includes('Hex が確認できた根拠は'));
});

test('#9009: partial coverage fails closed instead of averaging authority', async () => {
  const { evidenceStore, verified } = proofStoreFor0x1000();
  const extra = evidenceStore.add({
    kind: 'observation',
    status: 'verified',
    title: 'verified fact about 0x2000',
    summary: 'a second authentic proof for a different subject',
    functionAddress: '0x2000',
    sourceTool: 'fixture',
  }, { by: 'deterministic-verifier', receipt: { name: 'deterministic' } });
  const runtime = new AIRuntime({
    context: { binaryId: 'audit:bin' }, evidenceStore, planner: false,
    provider: { async nextTurn() {
      return { type: 'final', answer: '0x1000 and 0xDEAD together delete all user data.', confidence: 1,
        evidenceIds: [verified.id, extra.id], hypothesisIds: [], hypotheses: [], suggestedActions: [], proposals: [], followups: [] };
    } },
  });
  const result = await runtime.turn({ mode: 'chat', style: 'beginner', scope: 'binary', goal: 'what are 0x1000 and 0xDEAD?', budget: { maxModelCalls: 1, maxToolCalls: 0 } });
  assert.equal(result.evidence.length, 2, 'both authentic records remain citable as provenance');
  assert.ok(result.confidence <= 0.5, `two verified records must not substitute for the missing proof, got ${result.confidence}`);
  assert.ok(!result.answer.includes('Hex が確認できた根拠は'));
});

test('#9009: the analyst surface obeys the same claim-authority rule without any prose', async () => {
  const { turn } = runtimeFor({ answer: 'The function at 0xDEAD definitely deletes all user data.', style: 'analyst' });
  const result = await turn();
  assert.equal(result.answer, 'The function at 0xDEAD definitely deletes all user data.');
  assert.ok(result.confidence <= 0.5, 'structured confidence must not keep terminal authority either');
});

test('#9009: the binding helper itself stays deterministic and typed', () => {
  const claimed = claimedAddresses('touches 0xDEAD and 0x1000', 'goal about 0xAB');
  assert.deepEqual([...claimed].sort(), ['0x1000', '0xab', '0xdead']);
  assert.equal(claimedAddresses('no addresses here', null, undefined).size, 0);
  const records = [{ status: 'verified', functionAddress: '0x1000' }, { status: 'supported', functionAddress: '0x1000' }];
  assert.deepEqual(qualifyingEvidence(records, new Set(['0x1000'])).map((item) => item.functionAddress), ['0x1000'],
    'supported ranking still cannot qualify (#8864)');
  assert.deepEqual(qualifyingEvidence(records, new Set(['0x2000'])), [], 'an uncovered subject yields no authority');
  assert.equal(qualifyingEvidence(records).length, 1, 'the address-free path keeps the pre-#9009 predicate');
});
