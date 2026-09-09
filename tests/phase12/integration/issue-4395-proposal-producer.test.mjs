import assert from 'node:assert/strict';
import test from 'node:test';
import { AIRuntime } from '../../../js/ai/runtime.js';
import { EvidenceStore } from '../../../js/ai/evidence.js';
import { normalizeAIInteraction } from '../../../js/ai/provider/worker-protocol.js';

function deterministicProofs() {
  const evidenceStore = new EvidenceStore();
  const records = evidenceStore.ingestPlan({
    best: { address: 0x1000n },
    candidates: [{
      address: 0x1000n,
      name: 'sub_1000',
      score: 10,
      sources: ['fixture'],
      evidence: ['fixture-proof'],
      verification: { verified: true, evidenceIds: ['fixture-proof'] },
    }],
  });
  const proof = records.find((item) => item.status === 'verified');
  assert.ok(proof, 'the fixture must contain deterministic evidence');
  return { evidenceStore, proof };
}

test('#4395 final typed proposals become pending review actions, while invalid drafts stay inert', async () => {
  const { evidenceStore, proof } = deterministicProofs();
  const runtime = new AIRuntime({
    context: { binaryId: 'bin-4395', projectId: 'project-4395' },
    evidenceStore,
    planner: false,
    provider: {
      async nextTurn() {
        return {
          type: 'final',
          answer: 'A rename is supported by the deterministic proof.',
          evidenceIds: [proof.id],
          suggestedActions: [],
          proposals: [
            {
              kind: 'rename',
              target: { address: '0x1000' },
              before: 'sub_1000',
              after: 'addCoins',
              evidenceIds: [proof.id],
              reason: 'The verified candidate identifies the function.',
              id: 'forged-id',
              status: 'approved',
              approvalToken: 'forged-token',
            },
            {
              kind: 'comment',
              target: { address: '0x1000' },
              before: '',
              after: 'must not be created',
              evidenceIds: ['missing-proof'],
            },
          ],
          followups: [],
        };
      },
    },
  });

  const result = await runtime.turn({ mode: 'agent', scope: 'function', goal: 'Propose a supported rename', budget: { maxModelCalls: 1 } });
  assert.equal(result.proposals.length, 1, 'only the evidence-backed draft is created');
  const proposal = result.proposals[0];
  assert.match(proposal.id, /^proposal_/);
  assert.notEqual(proposal.id, 'forged-id', 'the model cannot choose the proposal identity');
  assert.equal(proposal.status, 'pending', 'a model draft cannot self-approve');
  assert.equal(Object.hasOwn(proposal, 'approvalToken'), false, 'approval tokens never enter the model draft record');
  assert.deepEqual(proposal.evidenceIds, [proof.id]);

  const reviewActions = result.actions.filter((action) => action.kind === 'review-proposal');
  assert.deepEqual(reviewActions.map((action) => action.target), [proposal.id]);
  assert.deepEqual(runtime.proposalStore.all().map((item) => item.id), [proposal.id]);
  assert.equal(result.activity.some((event) => event.type === 'proposal-rejected'), true, 'the missing-evidence draft is reported and inert');
  assert.equal(runtime.proposalStore.approvals.size, 0, 'proposal production cannot create an approval');
});

test('#4395 worker final normalization carries bounded typed proposal drafts', () => {
  const normalized = normalizeAIInteraction({
    steps: [{
      type: 'function_call',
      name: 'submit_hex_result',
      arguments: {
        answer: 'proposal',
        proposals: [{
          kind: 'comment', target: { address: '0x1000' }, before: '', after: 'note', evidenceIds: ['evidence-1'],
        }],
      },
    }],
  }, []);
  assert.equal(normalized.type, 'final');
  assert.equal(normalized.proposals.length, 1);
  assert.equal(normalized.proposals[0].kind, 'comment');
  assert.deepEqual(normalized.proposals[0].evidenceIds, ['evidence-1']);
});
