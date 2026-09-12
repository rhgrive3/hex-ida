import assert from 'node:assert/strict';
import test from 'node:test';

import { ProposalExecutor } from '../../../js/ai/interaction/proposal-executor.js';
import { ProposalStore } from '../../../js/ai/proposals.js';

function setup({ readAt, execute = async (_capability, args) => ({ after: args.after }) } = {}) {
  const store = new ProposalStore({ evidenceStore: { has: (id) => id === 'evidence-4458' } });
  const app = { backend: { readAt } };
  const capabilityExecutor = { execute };
  const executor = new ProposalExecutor({ store, capabilityExecutor, app });
  const proposal = store.create({
    kind: 'patch',
    target: { address: '0x1000' },
    before: [1],
    after: [2],
    evidenceIds: ['evidence-4458'],
  });
  return { store, executor, proposal };
}

test('#4458 reads current state while the proposal is still pending', async () => {
  let observedStatus = null;
  const { store, executor, proposal } = setup({
    readAt: async () => {
      observedStatus = store.get(proposal.id).status;
      return { found: true, bytes: new Uint8Array([1]) };
    },
  });

  const result = await executor.approveAndApply(proposal.id);
  assert.equal(observedStatus, 'pending');
  assert.equal(result.proposal.status, 'applied');
  assert.deepEqual(result.execution.after, [2]);
  assert.equal(store.approvals.size, 0);
});

test('#4458 sync current-state failure leaves the proposal retryable', async () => {
  let fail = true;
  const { store, executor, proposal } = setup({
    readAt: async () => {
      if (fail) throw new Error('temporary sync-style read failure');
      return { found: true, bytes: new Uint8Array([1]) };
    },
  });

  await assert.rejects(() => executor.approveAndApply(proposal.id), /temporary sync-style read failure/);
  assert.equal(store.get(proposal.id).status, 'pending');
  assert.equal(store.approvals.size, 0);

  fail = false;
  const retried = await executor.approveAndApply(proposal.id);
  assert.equal(retried.proposal.status, 'applied');
});

test('#4458 async current-state rejection leaves the proposal retryable', async () => {
  let fail = true;
  const { store, executor, proposal } = setup({
    readAt: () => fail
      ? Promise.reject(new Error('temporary async read failure'))
      : Promise.resolve({ found: true, bytes: new Uint8Array([1]) }),
  });

  await assert.rejects(() => executor.approveAndApply(proposal.id), /temporary async read failure/);
  assert.equal(store.get(proposal.id).status, 'pending');
  assert.equal(store.approvals.size, 0);

  fail = false;
  const retried = await executor.approveAndApply(proposal.id);
  assert.equal(retried.proposal.status, 'applied');
});

test('#4458 apply-started failures retain failed semantics and consume approval', async () => {
  const { store, executor, proposal } = setup({
    readAt: async () => ({ found: true, bytes: new Uint8Array([1]) }),
    execute: async () => { throw new Error('mutation adapter failed'); },
  });

  await assert.rejects(() => executor.approveAndApply(proposal.id), /mutation adapter failed/);
  assert.equal(store.get(proposal.id).status, 'failed');
  assert.equal(store.approvals.size, 0);
});

console.log('issue #4458 proposal current-state rollback: PASS');
