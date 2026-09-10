import assert from 'node:assert/strict';
import { createCapabilityCatalog } from '../js/ai/capabilities/catalog.js';
import { CapabilityExecutor } from '../js/ai/capabilities/executor.js';
import { ProposalStore } from '../js/ai/proposals.js';

const evidenceStore = { has: () => true };
const writes = [];
const comments = new Map();
const app = { notes: {
  comment(address) { return comments.get(String(address)) ?? null; },
  setComment(address, value) {
    writes.push([address, value]);
    comments.set(String(address), value);
  },
} };
const store = new ProposalStore({ evidenceStore });
const executor = new CapabilityExecutor({ catalog: createCapabilityCatalog(), app });
const proposal = store.create({
  kind: 'comment',
  target: { address: '4096' },
  before: null,
  after: 'approved',
  evidenceIds: ['e1'],
});
const { approvalToken } = store.approve(proposal.id);
await assert.rejects(
  () => executor.execute(
    'annotation.comment',
    { address: '4096', value: 'forged' },
    { authorization: { kind: 'proposal', token: approvalToken, proposalId: proposal.id } },
  ),
  (error) => error.type === 'approval_required',
);
assert.deepEqual(writes, []);
await store.apply(proposal.id, {
  approvalToken,
  currentState: null,
  apply: async (execution, authorization) => {
    await executor.execute(
      'annotation.comment',
      { address: execution.target.address, value: execution.after },
      { authorization },
    );
  },
});
assert.deepEqual(writes, [[4096n, 'approved']]);
assert.equal(app.notes.comment('4096'), 'approved');
console.log('#6221 current branded ProposalStore authorization: PASS');
