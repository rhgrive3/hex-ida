import assert from 'node:assert/strict';
import { CapabilityExecutor } from '../../../js/ai/capabilities/executor.js';
import { ProposalExecutor } from '../../../js/ai/interaction/proposal-executor.js';
import { ProposalStore, consumeProposalAuthorization, proposalArguments } from '../../../js/ai/proposals.js';

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

function createProjectApp() {
  return { projectAnnotations: [], workspace: { autosave: () => true } };
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
  await assert.rejects(promise, (error) => error?.type === 'approval_required');
}

{
  const app = createProjectApp();
  const executor = new CapabilityExecutor({ catalog, app });
  await expectApprovalFailure(executor.execute(
    'annotation.project',
    { id: 'forged', value: 'changed without approval' },
    { authorization: { kind: 'proposal', token: '12345678', proposalId: 'proposal_forged' } },
  ));
  assert.equal(app.projectAnnotations.length, 0, 'forged token must fail before mutation');
}

{
  const app = createProjectApp();
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
  const store = createStore();
  const proposal = store.create({
    kind: 'comment',
    target: { address: '4096' },
    before: null,
    after: 'approved comment',
    evidenceIds: ['evidence'],
  });
  const proposalId = proposal.id;
  const originalBindingRevision = proposal.bindingRevision;

  proposal.kind = 'rename';
  proposal.bindingRevision = 'forged-create-view';
  const fetched = store.get(proposalId);
  assert.equal(fetched.kind, 'comment', 'mutating the create() view must not change the stored proposal kind');
  assert.equal(fetched.bindingRevision, originalBindingRevision, 'mutating the create() view must not change binding authority');
  fetched.kind = 'rename';
  fetched.bindingRevision = 'forged-get-view';
  const listed = store.all()[0];
  listed.kind = 'rename';
  listed.bindingRevision = 'forged-all-view';

  const { proposal: approvedView, approvalToken } = store.approve(proposalId);
  approvedView.kind = 'rename';
  approvedView.bindingRevision = 'forged-approve-view';
  let wrongCapabilityAuthorized = null;
  const applied = await store.apply(proposalId, {
    approvalToken,
    currentState: null,
    apply: (item, authorization) => {
      assert.equal(item.kind, 'comment', 'execution must use the creation-time proposal kind');
      wrongCapabilityAuthorized = consumeProposalAuthorization(
        authorization,
        'annotation.rename',
        proposalArguments(item),
      );
    },
  });
  assert.equal(wrongCapabilityAuthorized, false, 'mutating returned proposal views must not mint another capability');
  assert.equal(applied.kind, 'comment');
  assert.equal(applied.bindingRevision, originalBindingRevision);
}

{
  let binding = { binaryId: 'bin-a', projectId: 'project-a', runtimeSessionId: null };
  const store = createStore(() => binding);
  const oldProposal = store.create({
    kind: 'comment',
    target: { address: '4096' },
    before: null,
    after: 'old binding',
    evidenceIds: ['evidence'],
  });
  const oldProposalId = oldProposal.id;

  binding = { binaryId: 'bin-b', projectId: 'project-a', runtimeSessionId: null };
  const currentProposal = store.create({
    kind: 'comment',
    target: { address: '8192' },
    before: null,
    after: 'current binding',
    evidenceIds: ['evidence'],
  });
  oldProposal.bindingRevision = currentProposal.bindingRevision;
  const fetchedOld = store.get(oldProposalId);
  fetchedOld.bindingRevision = currentProposal.bindingRevision;
  const { proposal: approvedView, approvalToken } = store.approve(oldProposalId);
  approvedView.bindingRevision = currentProposal.bindingRevision;
  let invoked = false;
  await assert.rejects(store.apply(oldProposalId, {
    approvalToken,
    currentState: null,
    apply: () => { invoked = true; },
  }), (error) => error?.type === 'scope_violation');
  assert.equal(invoked, false, 'binding mismatch must fail before the mutation adapter runs');
  assert.equal(store.get(oldProposalId).status, 'failed');
}

{
  const store = createStore();
  const firstBefore = Uint8Array.from([0x90]);
  const driftedBefore = Uint8Array.from([0xcc]);
  let beforeReads = 0;
  const proposal = store.create({
    kind: 'patch',
    target: { address: '4096' },
    get before() {
      beforeReads += 1;
      return beforeReads === 1 ? firstBefore : driftedBefore;
    },
    after: Uint8Array.from([0x91]),
    evidenceIds: ['evidence'],
  });
  const { approvalToken } = store.approve(proposal.id);
  let executionBefore = null;
  await store.apply(proposal.id, {
    approvalToken,
    currentState: firstBefore,
    apply: (item, authorization) => {
      executionBefore = Array.from(item.before);
      assert.equal(
        consumeProposalAuthorization(authorization, 'patch.create', proposalArguments(item)),
        true,
        'authorization must bind the same snapshotted patch arguments that execute',
      );
    },
  });
  assert.deepEqual(executionBefore, [0x90], 'stale-state revision and execution payload must come from one snapshot');
  assert.equal(beforeReads, 2, 'create() must not fingerprint caller-owned before separately from payload snapshotting');
}

{
  const app = createProjectApp();
  const store = createStore();
  const executor = new CapabilityExecutor({ catalog, app });
  const proposal = createProjectProposal(store, 'snapshot', 'safe');
  const { approvalToken } = store.approve(proposal.id);
  let idReads = 0;
  let valueReads = 0;
  await store.apply(proposal.id, {
    approvalToken,
    currentState: null,
    apply: (_item, authorization) => {
      const args = {};
      Object.defineProperties(args, {
        id: { enumerable: true, get: () => (++idReads <= 2 ? 'snapshot' : 'other') },
        value: { enumerable: true, get: () => (++valueReads <= 2 ? 'safe' : 'evil') },
      });
      return executor.execute('annotation.project', args, { authorization });
    },
  });
  assert.equal(idReads, 1, 'approved arguments must be snapshotted before validation and authorization');
  assert.equal(valueReads, 1, 'approved argument values must not be reread from caller-owned accessors');
  assert.equal(app.projectAnnotations.length, 1);
  assert.equal(app.projectAnnotations[0].id, 'snapshot', 'caller drift must not change the approved target');
  assert.equal(app.projectAnnotations[0].value, 'safe', 'caller drift must not change the approved value');
}

{
  const app = createProjectApp();
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
  }), (error) => error?.type === 'approval_required');
  assert.equal(app.projectAnnotations.length, 0, 'capability mismatch must not mutate');
}

{
  const app = createProjectApp();
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
  }), (error) => error?.type === 'approval_required');
  assert.equal(app.projectAnnotations.length, 0, 'argument mismatch must not mutate');
}

{
  const app = createProjectApp();
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
  }), (error) => error?.type === 'approval_required');
  assert.equal(app.projectAnnotations.length, 0, 'proposal id mismatch must not mutate');
}

{
  const app = createProjectApp();
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
  const app = createProjectApp();
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
  }), (error) => error?.type === 'approval_required');
  assert.equal(app.projectAnnotations.length, 0, 'binding drift must invalidate the authorization before mutation');
}

{
  const report = { report: { confirmed: [], deep: [] } };
  const executor = new CapabilityExecutor({ catalog, app: { autoReport: report } });
  assert.equal(await executor.execute('project.export-report', {}), report, 'approval-free capability behavior must be unchanged');
}

console.log('issue-3738 proposal approval authority regression: ok');
