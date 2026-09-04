/**
 * #6221 regression: requiresApproval capabilities must verify that the
 * authorization is a live approval issued by a trusted ProposalStore for the
 * matching proposal/capability/binding — not any 8-character string.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityCatalog } from '../js/ai/capabilities/catalog.js';
import { CapabilityExecutor } from '../js/ai/capabilities/executor.js';
import { ProposalStore } from '../js/ai/proposals.js';
import { createProposalExecutor } from '../js/ai/interaction/proposal-executor.js';

const evidenceStore = { has: () => true };

function appWithNotes() {
  let written = null;
  const app = {
    notes: {
      setComment(address, value) { written = [address, value]; },
    },
  };
  return { app, getWritten: () => written };
}

function trustedExecutor(app, store, extra = {}) {
  return new CapabilityExecutor({
    catalog: new CapabilityCatalog(),
    app,
    binaryId: 'bin-test',
    proposalStore: store,
    ...extra,
  });
}

function commentProposal(store, before = null, after = 'hello') {
  const proposal = store.create({
    kind: 'comment',
    target: { address: '4096' },
    before,
    after,
    evidenceIds: ['e1'],
  });
  return proposal;
}

test('#6221 forged 8-char token is rejected', async () => {
  const { app, getWritten } = appWithNotes();
  const store = new ProposalStore({ evidenceStore });
  const executor = trustedExecutor(app, store);
  await assert.rejects(
    () => executor.execute(
      'annotation.comment',
      { address: '4096', value: 'unauthorized' },
      { authorization: { kind: 'proposal', token: 'abcdefgh', proposalId: 'does-not-exist' } },
    ),
    (error) => error.type === 'approval_required',
  );
  assert.equal(getWritten(), null);
});

test('#6221 unknown proposalId is rejected', async () => {
  const { app } = appWithNotes();
  const store = new ProposalStore({ evidenceStore });
  const executor = trustedExecutor(app, store);
  await assert.rejects(
    () => executor.execute(
      'annotation.comment',
      { address: '4096', value: 'x' },
      { authorization: { kind: 'proposal', token: '0123456789abcdef0123456789abcdef', proposalId: 'no-such-proposal' } },
    ),
    (error) => error.type === 'approval_required',
  );
});

test('#6221 token from another proposal cannot be reused', async () => {
  const { app } = appWithNotes();
  const store = new ProposalStore({ evidenceStore });
  const executor = trustedExecutor(app, store);
  const first = commentProposal(store);
  const second = commentProposal(store);
  const { approvalToken: tokenA } = store.approve(first.id);
  store.approve(second.id);
  // Token A presented as authority for proposal B.
  await assert.rejects(
    () => executor.execute(
      'annotation.comment',
      { address: '4096', value: 'x' },
      { authorization: { kind: 'proposal', token: tokenA, proposalId: second.id } },
    ),
    (error) => error.type === 'approval_required',
  );
});

test('#6221 token for another capability kind is rejected', async () => {
  const names = new Map();
  const app = {
    notes: {
      setName: (address, value) => names.set(String(address), value),
      nameOf: (address) => names.get(String(address)) || null,
      setComment: (address, value) => names.set(`comment:${String(address)}`, value),
    },
    symbols: { rename: () => {} },
    viewer: { setSymbols() {} },
    updateChrome() {},
  };
  const store = new ProposalStore({ evidenceStore });
  const executor = trustedExecutor(app, store);
  const renameProposal = store.create({
    kind: 'rename',
    target: { address: '4096' },
    before: null,
    after: 'name-x',
    evidenceIds: ['e1'],
  });
  const { approvalToken } = store.approve(renameProposal.id);
  // A rename approval must not authorize a comment mutation.
  await assert.rejects(
    () => executor.execute(
      'annotation.comment',
      { address: '4096', value: 'x' },
      { authorization: { kind: 'proposal', token: approvalToken, proposalId: renameProposal.id } },
    ),
    (error) => error.type === 'approval_required',
  );
});

test('#6221 executor without trusted authority fails closed', async () => {
  const { app } = appWithNotes();
  const executor = new CapabilityExecutor({
    catalog: new CapabilityCatalog(),
    app,
    binaryId: 'bin-test',
  });
  await assert.rejects(
    () => executor.execute(
      'annotation.comment',
      { address: '4096', value: 'x' },
      { authorization: { kind: 'proposal', token: '0123456789abcdef' } },
    ),
    (error) => error.type === 'approval_required',
  );
});

test('#6221 valid approval executes', async () => {
  const { app, getWritten } = appWithNotes();
  const store = new ProposalStore({ evidenceStore });
  const executor = trustedExecutor(app, store);
  const proposal = commentProposal(store);
  const { approvalToken } = store.approve(proposal.id);
  const result = await executor.execute(
    'annotation.comment',
    { address: '4096', value: 'authorized' },
    { authorization: { kind: 'proposal', token: approvalToken, proposalId: proposal.id } },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(getWritten(), [4096n, 'authorized']);
});

test('#6221 ProposalExecutor legitimate path still succeeds', async () => {
  const names = new Map();
  const app = {
    notes: {
      setName: (address, value) => names.set(String(address), value),
      nameOf: (address) => names.get(String(address)) || null,
    },
    symbols: { rename: (address, value) => names.set(String(address), value) },
    viewer: { setSymbols() {} },
    updateChrome() {},
  };
  const store = new ProposalStore({ evidenceStore });
  const executor = new CapabilityExecutor({
    catalog: new CapabilityCatalog(),
    app,
    proposalStore: store,
  });
  const proposalExecutor = createProposalExecutor({ store, capabilityExecutor: executor, app });
  const proposal = store.create({
    kind: 'rename',
    target: { address: '4096' },
    before: null,
    after: 'approved_name',
    evidenceIds: ['e1'],
  });
  // Seed the live state so the stale-state guard passes (before=null).
  const { proposal: applied } = await proposalExecutor.approveAndApply(proposal.id);
  assert.equal(applied.status, 'applied');
  assert.equal(names.get('4096'), 'approved_name');
});

test('#6221 read-only capability needs no approval', async () => {
  const executor = new CapabilityExecutor({ catalog: new CapabilityCatalog(), app: {} });
  const result = await executor.execute('patch.inspect', {});
  assert.ok(Array.isArray(result.patches));
});
