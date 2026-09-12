// Regression for #4590: AIRuntime.storesFor() hydrated persisted evidence and
// hypotheses but never session.proposedActions, so a pending proposal that
// turn persistence had saved became unreachable to review/apply after any
// runtime recreation or namespace rebuild.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AIRuntime } from '../../../js/ai/runtime.js';
import { InvestigationSessionStore } from '../../../js/ai/session-core/index.js';

const BINARY = 'bin-4590';

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

async function seededPersistence(binaryId = BINARY) {
  const sessionStore = new InvestigationSessionStore();
  const runtime = new AIRuntime({ context: { binaryId }, sessionStore, planner: false });
  const session = await sessionStore.create({ id: 's-4590', binaryId });
  const stores = runtime.storesFor(session, binaryId);
  const ingested = stores.evidenceStore.ingestPlan({
    best: { address: 0x1000n },
    candidates: [{ address: 0x1000n, name: 'fn', score: 10, sources: ['src'], evidence: ['src-1'], verification: { verified: true } }],
  });
  const proof = ingested.find((item) => item.status === 'verified');
  stores.hypothesisStore.upsert({ id: 'h-4590', claim: 'claim', status: 'open', supportEvidenceIds: [proof.id] });
  const created = stores.proposalStore.create({
    id: 'p-4590',
    kind: 'comment',
    target: { address: '0x1000' },
    before: '',
    after: 'restored pending proposal',
    evidenceIds: [proof.id],
  });
  const updated = await sessionStore.update(session.id, {
    effectiveScope: 'auto',
    hypotheses: stores.hypothesisStore.all(),
    confirmedFindings: stores.evidenceStore.byStatus('verified'),
    proposedActions: stores.proposalStore.all(),
  });
  const approval = stores.proposalStore.approve('p-4590');
  return {
    frozenSession: updated,
    evidenceId: proof.id,
    persisted: copy(updated),
    persistedProposal: copy(created),
    approvalToken: approval.approvalToken,
  };
}

function resumed(session, binaryId = BINARY) {
  return new AIRuntime({ context: { binaryId }, planner: false }).storesFor(session, binaryId);
}

test('#4590 pending proposal persists into a rebuilt runtime namespace and stays reviewable', async () => {
  const { frozenSession, persisted, persistedProposal } = await seededPersistence();
  assert.equal(persisted.proposedActions.length, 1);
  assert.equal(Object.isFrozen(frozenSession.proposedActions[0]), true);

  const stores = resumed(persisted);
  assert.equal(stores.proposalStore.has('p-4590'), true);
  assert.deepEqual(stores.proposalStore.all().map((item) => item.id), ['p-4590']);

  const restored = stores.proposalStore.require('p-4590');
  assert.equal(restored.id, persistedProposal.id);
  assert.equal(restored.kind, persistedProposal.kind);
  assert.equal(restored.status, 'pending');
  assert.deepEqual(restored.target, persistedProposal.target);
  assert.deepEqual(restored.before, persistedProposal.before);
  assert.deepEqual(restored.after, persistedProposal.after);
  assert.deepEqual(restored.evidenceIds, persistedProposal.evidenceIds);
  assert.equal(restored.revision, persistedProposal.revision);
  assert.deepEqual(restored.binding, persistedProposal.binding);
  assert.equal(restored.bindingRevision, persistedProposal.bindingRevision);
  assert.equal(restored.createdAt, persistedProposal.createdAt);

  assert.equal(stores.proposalStore.executionView('p-4590').after, 'restored pending proposal');

  const reapproved = stores.proposalStore.approve('p-4590');
  assert.equal(typeof reapproved.approvalToken, 'string');
  assert.notEqual(reapproved.approvalToken, '');
  let executed = null;
  const result = await stores.proposalStore.apply('p-4590', {
    approvalToken: reapproved.approvalToken,
    currentState: persistedProposal.before,
    apply: async (proposal) => { executed = proposal; },
  });
  assert.equal(result.status, 'applied');
  assert.equal(executed.after, 'restored pending proposal');
});

test('#4590 approval credentials are never persisted or restored', async () => {
  const { persisted, persistedProposal, approvalToken } = await seededPersistence();
  assert.equal(Object.hasOwn(persistedProposal, 'approvalToken'), false);
  assert.equal(Object.hasOwn(persistedProposal, 'token'), false);

  const stores = resumed(persisted);
  assert.equal(stores.proposalStore.approvals.size, 0);
  const reapproved = stores.proposalStore.approve('p-4590');
  await assert.rejects(
    stores.proposalStore.apply('p-4590', { approvalToken, currentState: persistedProposal.before, apply: async () => {} }),
    (error) => error.type === 'approval_required',
  );
  assert.equal(stores.proposalStore.get('p-4590').status, 'approved');
  let appliedWith = null;
  await stores.proposalStore.apply('p-4590', {
    approvalToken: reapproved.approvalToken,
    currentState: persistedProposal.before,
    apply: async () => { appliedWith = true; },
  });
  assert.equal(appliedWith, true);
});

test('#4590 fail-closed restore rejects evidence, binding, and revision inconsistency', async () => {
  const { persisted, persistedProposal, evidenceId } = await seededPersistence();

  const missingEvidence = copy(persisted);
  missingEvidence.proposedActions[0].evidenceIds = ['ev-does-not-exist'];
  assert.equal(resumed(missingEvidence).proposalStore.has('p-4590'), false);

  const emptyEvidence = copy(persisted);
  emptyEvidence.proposedActions[0].evidenceIds = [];
  assert.equal(resumed(emptyEvidence).proposalStore.has('p-4590'), false);

  const droppedEvidence = copy(persisted);
  droppedEvidence.confirmedFindings = [];
  assert.equal(droppedEvidence.proposedActions[0].evidenceIds[0], evidenceId);
  assert.equal(resumed(droppedEvidence).proposalStore.has('p-4590'), false);

  assert.equal(resumed(persisted, 'other-binary').proposalStore.has('p-4590'), false);

  const staleBinding = copy(persisted);
  staleBinding.proposedActions[0].bindingRevision = '0'.repeat(persistedProposal.bindingRevision.length);
  assert.equal(resumed(staleBinding).proposalStore.has('p-4590'), false);

  const tamperedPayload = copy(persisted);
  tamperedPayload.proposedActions[0].before = 'tampered approved state';
  assert.equal(resumed(tamperedPayload).proposalStore.has('p-4590'), false);

  const missingRevision = copy(persisted);
  delete missingRevision.proposedActions[0].revision;
  assert.equal(resumed(missingRevision).proposalStore.has('p-4590'), false);

  const forgedKind = copy(persisted);
  forgedKind.proposedActions[0].kind = 'unknown-kind';
  assert.equal(resumed(forgedKind).proposalStore.has('p-4590'), false);

  const duplicateId = copy(persisted);
  duplicateId.proposedActions.push(copy(persisted.proposedActions[0]));
  assert.deepEqual(resumed(duplicateId).proposalStore.all().map((item) => item.id), ['p-4590']);
});

test('#4590 non-pending persisted proposal states follow the fail-closed restore policy', async () => {
  const { persisted } = await seededPersistence();
  for (const status of ['approved', 'applying', 'applied', 'failed', 'rejected', 'pending ', null, undefined, 'unknown']) {
    const candidate = copy(persisted);
    candidate.proposedActions[0].status = status;
    assert.equal(resumed(candidate).proposalStore.has('p-4590'), false, `status ${JSON.stringify(status)}`);
  }
});

test('#4590 a persisted-proposal-only session never claims the shared default namespace', async () => {
  const { persisted } = await seededPersistence();
  const proposalsOnly = { id: persisted.id, binaryId: persisted.binaryId, proposedActions: copy(persisted.proposedActions) };
  const runtime = new AIRuntime({ context: { binaryId: BINARY }, planner: false });
  const stores = runtime.storesFor(proposalsOnly, BINARY);

  assert.equal(runtime.initialStoresClaimed, false);
  assert.notEqual(stores.proposalStore, runtime.initialStores.proposalStore);
  assert.notEqual(stores.evidenceStore, runtime.initialStores.evidenceStore);
  assert.deepEqual(stores.proposalStore.all(), []);
  assert.deepEqual(runtime.initialStores.proposalStore.all(), []);

  const plain = runtime.storesFor({ id: 's-plain', binaryId: BINARY }, BINARY);
  assert.equal(plain, runtime.initialStores);
  const otherBinary = runtime.storesFor({ id: persisted.id, binaryId: 'other-binary' }, 'other-binary');
  assert.notEqual(otherBinary.proposalStore, stores.proposalStore);
  assert.equal(otherBinary.proposalStore.has('p-4590'), false);
});

test('#4590 evidence and hypothesis restore semantics are unchanged', async () => {
  const { persisted, evidenceId } = await seededPersistence();
  const stores = resumed(persisted);
  assert.equal(stores.evidenceStore.has(evidenceId), true);
  assert.equal(stores.evidenceStore.get(evidenceId).status, 'verified');
  assert.deepEqual(stores.hypothesisStore.all().map((item) => item.id), ['h-4590']);

  const findingsOnly = { id: 's-findings', binaryId: BINARY, confirmedFindings: copy(persisted.confirmedFindings) };
  const partial = new AIRuntime({ context: { binaryId: BINARY }, planner: false }).storesFor(findingsOnly, BINARY);
  assert.equal(partial.evidenceStore.has(evidenceId), true);
  assert.deepEqual(partial.proposalStore.all(), []);
});
