import assert from 'node:assert/strict';
import { CapabilityExecutor } from '../../../js/ai/capabilities/executor.js';
import { ProposalExecutor } from '../../../js/ai/interaction/proposal-executor.js';

const projectCapability = Object.freeze({
  id: 'annotation.project',
  category: 'annotation',
  agentExposed: true,
  requiresApproval: true,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      kind: { type: 'string' },
      value: {},
    },
  },
});

function catalog() {
  return { get(id) { return id === projectCapability.id ? projectCapability : null; } };
}

function proposalStore(proposal) {
  return {
    approve(id) {
      assert.equal(id, proposal.id);
      proposal.status = 'approved';
      return { proposal, approvalToken: 'approval-token-3782' };
    },
    executionView(id) {
      assert.equal(id, proposal.id);
      return proposal;
    },
    async apply(id, { approvalToken, currentState, apply }) {
      assert.equal(id, proposal.id);
      assert.equal(approvalToken, 'approval-token-3782');
      assert.equal(currentState, proposal.before);
      await apply(proposal);
      proposal.status = 'applied';
      return proposal;
    },
  };
}

const createdAt = '2026-01-01T00:00:00.000Z';
const duplicateCreatedAt = '2026-02-01T00:00:00.000Z';
const externalFinding = { id: 'a1', kind: 'note', value: 'external', confirmed: true, source: 'external-analysis' };
let autosaves = 0;
const app = {
  projectAnnotations: [
    { id: 'a1', kind: 'note', value: 'old', createdAt },
    { id: 'a1', kind: 'note', value: 'stale-duplicate', createdAt: duplicateCreatedAt },
  ],
  autoReport: {
    report: {
      confirmed: [
        { id: 'other', kind: 'note', value: 'keep', confirmed: true, source: 'project-annotation' },
        { id: 'a1', kind: 'note', value: 'old', createdAt, confirmed: true, source: 'project-annotation' },
        externalFinding,
        { id: 'a1', kind: 'note', value: 'stale-duplicate', createdAt: duplicateCreatedAt, confirmed: true, source: 'project-annotation' },
      ],
      deep: [],
    },
  },
  workspace: { autosave() { autosaves += 1; return true; } },
};

const capabilityExecutor = new CapabilityExecutor({ catalog: catalog(), app });
const proposal = {
  id: 'proposal-3782',
  kind: 'project-annotation',
  target: { id: 'a1', kind: 'note' },
  before: 'old',
  after: 'new',
  status: 'pending',
};
const executor = new ProposalExecutor({
  store: proposalStore(proposal),
  capabilityExecutor,
  app,
});

const applied = await executor.approveAndApply(proposal.id);
assert.equal(applied.proposal.status, 'applied');
assert.equal(applied.execution.id, 'a1');
assert.equal(applied.execution.value, 'new');
const canonicalAnnotations = app.projectAnnotations.filter((item) => item?.id === 'a1');
assert.equal(canonicalAnnotations.length, 1, 'updating an id must collapse historical duplicate annotations');
assert.equal(canonicalAnnotations[0].value, 'new', 'the canonical first-match annotation must carry the new value');
assert.equal(canonicalAnnotations[0].createdAt, createdAt, 'updating an annotation must preserve the first canonical creation timestamp');
const canonicalFindings = app.autoReport.report.confirmed.filter((item) => item?.id === 'a1' && item?.source === 'project-annotation');
assert.equal(canonicalFindings.length, 1, 'the project-annotation projection must collapse historical duplicates');
assert.equal(canonicalFindings[0].value, 'new');
assert.equal(app.autoReport.report.confirmed.find((item) => item.id === 'other')?.value, 'keep');
assert.equal(app.autoReport.report.confirmed.find((item) => item === externalFinding), externalFinding, 'same-id findings from another source must remain untouched');
assert.equal(externalFinding.value, 'external');
assert.equal(autosaves, 1);

const created = await capabilityExecutor.execute('annotation.project', {
  id: 'a2', kind: 'note', value: 'fresh',
}, {
  authorization: { kind: 'proposal', token: 'approval-token-3782' },
});
assert.equal(created.id, 'a2');
assert.equal(app.projectAnnotations.length, 2, 'a new id must still append exactly one annotation');
assert.equal(app.projectAnnotations.find((item) => item.id === 'a2')?.value, 'fresh');
assert.equal(app.autoReport.report.confirmed.filter((item) => item.id === 'a2' && item.source === 'project-annotation').length, 1);
assert.equal(autosaves, 2);

{
  // Combined #3782/#3762 postcondition: duplicate cleanup is transactional.
  // A failed autosave must restore the original arrays, identities, ordering,
  // and historical duplicates exactly.
  const annotations = [
    { id: 'b1', kind: 'note', value: 'prior', createdAt },
    { id: 'b1', kind: 'note', value: 'prior-duplicate', createdAt: duplicateCreatedAt },
    { id: 'other', kind: 'note', value: 'keep' },
  ];
  const external = { id: 'b1', kind: 'note', value: 'external', confirmed: true, source: 'external-analysis' };
  const confirmed = [
    { id: 'b1', kind: 'note', value: 'prior', createdAt, confirmed: true, source: 'project-annotation' },
    external,
    { id: 'b1', kind: 'note', value: 'prior-duplicate', createdAt: duplicateCreatedAt, confirmed: true, source: 'project-annotation' },
  ];
  const annotationsBefore = annotations.slice();
  const confirmedBefore = confirmed.slice();
  const failingApp = {
    projectAnnotations: annotations,
    autoReport: { report: { confirmed, deep: [] } },
    workspace: { autosave() { return false; } },
  };
  const failingExecutor = new CapabilityExecutor({ catalog: catalog(), app: failingApp });
  await assert.rejects(
    () => failingExecutor.execute('annotation.project', { id: 'b1', kind: 'note', value: 'lost' }, {
      authorization: { kind: 'proposal', token: 'approval-token-3782' },
    }),
    /could not be persisted/,
  );
  assert.equal(failingApp.projectAnnotations, annotations, 'rollback must preserve annotation array identity');
  assert.equal(failingApp.autoReport.report.confirmed, confirmed, 'rollback must preserve confirmed array identity');
  assert.deepEqual(failingApp.projectAnnotations, annotationsBefore, 'failed cleanup/upsert must restore historical annotations exactly');
  assert.deepEqual(failingApp.autoReport.report.confirmed, confirmedBefore, 'failed cleanup/upsert must restore historical findings exactly');
  assert.equal(failingApp.autoReport.report.confirmed[1], external, 'rollback must preserve unrelated same-id source identity');
}

console.log('issue-3782-ai-project-annotation-upsert: PASS');
