import assert from 'node:assert/strict';
import test from 'node:test';
import { ProposalStore } from '../js/ai/proposals.js';
import { ProposalExecutor } from '../js/ai/interaction/proposal-executor.js';
import { CapabilityExecutor } from '../js/ai/capabilities/executor.js';
import { CapabilityCatalog } from '../js/ai/capabilities/catalog.js';

function environment(app) {
  const catalog = new CapabilityCatalog();
  const capabilityExecutor = new CapabilityExecutor({ app, catalog });
  const store = new ProposalStore({ evidenceStore: { has: () => true } });
  return { store, executor: new ProposalExecutor({ store, capabilityExecutor, app }) };
}

function renameApp({ symbolBackendFails = false, rollbackThrows = false, readbackFailsAfterWrite = false } = {}) {
  let liveName = 'old_name';
  let symbolName = 'old_name';
  let wrote = false;
  const app = {
    notes: {
      id: 'bin-1',
      nameOf: () => {
        if (readbackFailsAfterWrite && wrote) throw new Error('readback store unavailable');
        return liveName;
      },
      setName: (_address, value) => {
        if (rollbackThrows && value !== 'new_name') throw new Error('note adapter exploded during rollback');
        liveName = value;
      },
    },
    symbols: {
      rename: (_address, value) => {
        if (symbolBackendFails) throw new Error('symbol backend failed');
        symbolName = value;
        wrote = true;
      },
      nameAt: () => symbolName,
    },
    viewer: { setSymbols() {} },
    updateChrome() {},
  };
  return { app, state: () => ({ liveName, symbolName }) };
}

function structApp({ saveThrows = false } = {}) {
  const app = {
    notes: {
      id: 'bin-1',
      structs: [{ name: 'A', fields: [{ offset: 0, name: 'old', type: 'u8' }] }],
      dirty: false,
      save() {
        if (saveThrows) throw new Error('save exploded');
        return true;
      },
    },
  };
  return { app, struct: () => app.notes.structs[0] };
}

function renameProposal(store) {
  return store.create({
    kind: 'rename',
    target: { address: 4096 },
    before: 'old_name',
    after: 'new_name',
    evidenceIds: ['ev-1'],
  });
}

function structProposal(store) {
  return store.create({
    kind: 'struct-field',
    target: { struct: 'A', offset: 0 },
    before: { offset: 0, name: 'old', type: 'u8' },
    after: { field: 'new', type: 'i32' },
    evidenceIds: ['ev-1'],
  });
}

test('issue #5133 - rename rolls back the note when symbols.rename throws mid-mutation', async () => {
  const { app, state } = renameApp({ symbolBackendFails: true });
  const { store, executor } = environment(app);
  const proposal = renameProposal(store);
  await assert.rejects(
    () => executor.approveAndApply(proposal.id),
    /symbol backend failed/,
  );
  assert.deepEqual(state(), { liveName: 'old_name', symbolName: 'old_name' }, 'failed rename must leave the before state');
  assert.equal(store.get(proposal.id).status, 'failed');
  assert.notEqual(store.get(proposal.id).partial, true, 'fully rolled back rename is not a partial application');
});

test('issue #5133 - struct-field rolls back the field array when save throws after mutation', async () => {
  const { app, struct } = structApp({ saveThrows: true });
  const { store, executor } = environment(app);
  const proposal = structProposal(store);
  await assert.rejects(
    () => executor.approveAndApply(proposal.id),
    (error) => error.type === 'tool_failed' && /Structure annotation could not be persisted/.test(error.message),
  );
  assert.deepEqual(struct().fields, [{ offset: 0, name: 'old', type: 'u8' }], 'failed struct-field write must restore the before field state');
  assert.equal(app.notes.dirty, false, 'rollback must restore the persistence status it captured');
  assert.equal(store.get(proposal.id).status, 'failed');
});

test('issue #5133 - applied mutation with an unverifiable postcondition is recorded partial, not plain failed', async () => {
  const { app, state } = renameApp({ readbackFailsAfterWrite: true });
  const { store, executor } = environment(app);
  const proposal = renameProposal(store);
  await assert.rejects(
    () => executor.approveAndApply(proposal.id),
    (error) => error.type === 'tool_failed' && error.details?.verification === 'indeterminate',
  );
  const record = store.get(proposal.id);
  assert.equal(record.status, 'failed');
  assert.equal(record.partial, true, 'an applied-but-unverifiable mutation must never masquerade as failed-without-change');
  assert.ok(store.audit.some((entry) => entry.type === 'proposal-partial' && entry.proposalId === proposal.id));
  assert.deepEqual(state().liveName, 'new_name', 'the applied mutation itself stays honest: readback failure must not fake a rollback');
});

test('issue #5133 - a failed rollback is surfaced explicitly, never as a silent no-change failure', async () => {
  const { app, state } = renameApp({ symbolBackendFails: true, rollbackThrows: true });
  const { store, executor } = environment(app);
  const proposal = renameProposal(store);
  await assert.rejects(
    () => executor.approveAndApply(proposal.id),
    (error) => error.type === 'tool_failed'
      && /could not be rolled back/.test(error.message)
      && /symbol backend failed/.test(error.details?.cause || ''),
  );
  assert.equal(state().liveName, 'new_name');
  const record = store.get(proposal.id);
  assert.equal(record.status, 'failed');
  assert.equal(record.partial, true, 'a failed rollback leaves the mutation applied and must be explicit partial, never a silent no-change failure');
  assert.ok(store.audit.some((entry) => entry.type === 'proposal-partial' && entry.proposalId === proposal.id));
});

test('issue #5133 - proposal is applied only when mutation and postcondition both succeed', async () => {
  const { app, state } = renameApp();
  const { store, executor } = environment(app);
  const proposal = renameProposal(store);
  const result = await executor.approveAndApply(proposal.id);
  assert.equal(result.proposal.status, 'applied');
  assert.deepEqual(state(), { liveName: 'new_name', symbolName: 'new_name' });
  assert.notEqual(store.get(proposal.id).partial, true);
});

test('issue #5133 - approval token stays single-use across a failed apply', async () => {
  const { app } = renameApp({ symbolBackendFails: true });
  const { store } = environment(app);
  const proposal = renameProposal(store);
  const { approvalToken } = store.approve(proposal.id);
  await assert.rejects(
    () => store.apply(proposal.id, { approvalToken, currentState: 'old_name', apply: async () => { throw new Error('symbol backend failed'); } }),
    /symbol backend failed/,
  );
  await assert.rejects(
    () => store.apply(proposal.id, { approvalToken, currentState: 'old_name', apply: async () => {} }),
    (error) => error.type === 'approval_required',
  );
  assert.equal(store.get(proposal.id).status, 'failed');
});
