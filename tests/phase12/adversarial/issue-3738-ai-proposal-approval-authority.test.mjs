import assert from 'node:assert/strict';
import { CapabilityExecutor } from '../../../js/ai/capabilities/executor.js';
import { ProposalExecutor } from '../../../js/ai/interaction/proposal-executor.js';
import { ProposalStore, proposalArguments } from '../../../js/ai/proposals.js';

const entries = new Map([
  ['annotation.project', { id: 'annotation.project', agentExposed: true, requiresApproval: true, inputSchema: { type: 'object' } }],
  ['annotation.comment', { id: 'annotation.comment', agentExposed: true, requiresApproval: true, inputSchema: { type: 'object' } }],
  ['project.export-report', { id: 'project.export-report', agentExposed: true, requiresApproval: false, inputSchema: { type: 'object' } }],
]);
const catalog = { get: (id) => entries.get(id) || null };
const evidenceStore = { has: (id) => id === 'evidence' };

function createStore(binding = () => ({ binaryId: 'bin-a', projectId: 'project-a', runtimeSessionId: null })) {
  return new ProposalStore({ evidenceStore, binding });
}

function createProjectProposal(store, id, after = 'approved') {
  return store.create({
    kind: 'project-annotation',
    target: { id },
    before: null,
    after,
    evidenceIds: ['evidence'],
  });
}

async function expectApprovalFailure(promise) {
  await assert.rejects(promise, (error) => error?.code === 'approval_required');
}

{
  const app = { projectAnnotations: [] };
  const executor = new CapabilityExecutor({ catalog, app });
  await expectApprovalFailure(executor.execute(
    'annotation.project',
    { id: 'forged', value: 'changed without approval' },
    { authorization: { kind: 'proposal', token: '12345678', proposalId: 'proposal_forged' } },
  ));
  assert.equal(app.projectAnnotations.length, 0, 'forged token must fail before mutation');
}

{
  const app = { projectAnnotations: [] };
  const store = createStore();
  const capabilityExecutor = new CapabilityExecutor({ catalog, app });
  const proposalExecutor = new ProposalExecutor({ store, capabilityExecutor, app });
  const proposal = createProjectProposal(store, 'approved');
  const result = await proposalExecutor.approveAndApply(proposal.id);
  assert.equal(result.proposal.status, 'applied');
  assert.equal(app.projectAnnotations.length, 1);
  assert.equal(app.projectAnnotations[0].id, 'approved');
  assert.equal(app.projectAnnotations[0].value, 'approved');
}

{
  const app = { projectAnnotations: [] };
  const store = createStore();
  const executor = new CapabilityExecutor({ catalog, app });
  const proposal = createProjectProposal(store, 'wrong-capability');
  const { approvalToken } = store.approve(proposal.id);
  await assert.rejects(store.apply(proposal.id, {
    approvalToken,
    currentState: null,
    apply: (_item, authorization) => executor.execute(
      'annotation.comment',
      { address: '4096', value: 'wrong capability' },
      { authorization },
    ),
  }), (error) => error?.code === 'approval_required');
  assert.equal(app.projectAnnotations.length, 0, 'capability mismatch must not mutate');
}

{
  const app = { projectAnnotations: [] };
  const store = createStore();
  const executor = new CapabilityExecutor({ catalog, app });
  const proposal = createProjectProposal(store, 'wrong-args');
  const { approvalToken } = store.approve(proposal.id);
  await assert.rejects(store.apply(proposal.id, {
    approvalToken,
    currentState: null,
    apply: (_item, authorization) => executor.execute(
      'annotation.project',
      { id: 'different-target', value: 'approved' },
      { authorization },
    ),
  }), (error) => error?.code === 'approval_required');
  assert.equal(app.projectAnnotations.length, 0, 'argument mismatch must not mutate');
}

{
  const app = { projectAnnotations: [] };
  const store = createStore();
  const executor = new CapabilityExecutor({ catalog, app });
  const proposal = createProjectProposal(store, 'wrong-id');
  const { approvalToken } = store.approve(proposal.id);
  await assert.rejects(store.apply(proposal.id, {
    approvalToken,
    currentState: null,
    apply: (item, authorization) => executor.execute(
      'annotation.project',
      proposalArguments(item),
      { authorization: { ...authorization, proposalId: 'proposal_other' } },
    ),
  }), (error) => error?.code === 'approval_required');
  assert.equal(app.projectAnnotations.length, 0, 'proposal id mismatch must not mutate');
}

{
  const app = { projectAnnotations: [] };
  const store = createStore();
  const executor = new CapabilityExecutor({ catalog, app });
  const proposal = createProjectProposal(store, 'single-use');
  const { approvalToken } = store.approve(proposal.id);
  await store.apply(proposal.id, {
    approvalToken,
    currentState: null,
    apply: async (item, authorization) => {
      const args = proposalArguments(item);
      await executor.execute('annotation.project', args, { authorization });
      await expectApprovalFailure(executor.execute('annotation.project', args, { authorization }));
    },
  });
  assert.equal(app.projectAnnotations.length, 1, 'authorization replay must fail before a second mutation');
}

{
  let binding = { binaryId: 'bin-a', projectId: 'project-a', runtimeSessionId: null };
  const app = { projectAnnotations: [] };
  const store = createStore(() => binding);
  const executor = new CapabilityExecutor({ catalog, app });
  const proposal = createProjectProposal(store, 'binding-drift');
  const { approvalToken } = store.approve(proposal.id);
  await assert.rejects(store.apply(proposal.id, {
    approvalToken,
    currentState: null,
    apply: (item, authorization) => {
      binding = { binaryId: 'bin-b', projectId: 'project-a', runtimeSessionId: null };
      return executor.execute('annotation.project', proposalArguments(item), { authorization });
    },
  }), (error) => error?.code === 'approval_required');
  assert.equal(app.projectAnnotations.length, 0, 'binding drift must invalidate the authorization before mutation');
}

{
  const report = { report: { confirmed: [], deep: [] } };
  const executor = new CapabilityExecutor({ catalog, app: { autoReport: report } });
  assert.equal(await executor.execute('project.export-report', {}), report, 'approval-free capability behavior must be unchanged');
}

console.log('issue-3738 proposal approval authority regression: ok');
