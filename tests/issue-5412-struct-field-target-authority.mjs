import assert from 'node:assert/strict';
import test from 'node:test';
import { ProposalStore, proposalArguments } from '../js/ai/proposals.js';
import { ProposalExecutor } from '../js/ai/interaction/proposal-executor.js';
import { CapabilityExecutor } from '../js/ai/capabilities/executor.js';
import { CapabilityCatalog } from '../js/ai/capabilities/catalog.js';

function environment() {
  const app = {
    notes: { id: 'bin-1', structs: [], dirty: false, save() { this.saved = (this.saved || 0) + 1; return true; } },
  };
  const catalog = new CapabilityCatalog();
  const capabilityExecutor = new CapabilityExecutor({ app, catalog });
  const store = new ProposalStore({ evidenceStore: { has: () => true } });
  return { app, store, executor: new ProposalExecutor({ store, capabilityExecutor, app }) };
}

test('issue #5412 - after carrying target identity is rejected at creation', () => {
  const { store, app } = environment();
  assert.throws(() => store.create({
    kind: 'struct-field',
    target: { struct: 'A', offset: 0 },
    before: null,
    after: { struct: 'B', offset: 8, field: 'x', type: 'i32' },
    evidenceIds: ['ev-1'],
  }), (error) => error.type === 'invalid_tool_call');
  assert.deepEqual(app.notes.structs, [], 'no mutation from a rejected creation');
});

test('issue #5412 - execution args are pinned to the approved target, never to after', () => {
  const legacy = {
    id: 'legacy-1', kind: 'struct-field',
    target: { struct: 'A', offset: 0 }, before: null,
    after: { struct: 'B', offset: 8, field: 'x', type: 'i32' },
    status: 'pending',
  };
  assert.deepEqual(proposalArguments(legacy), { struct: 'A', offset: 0, field: 'x', type: 'i32' });
  const nameAlias = {
    id: 'legacy-2', kind: 'struct-field',
    target: { name: 'A', offset: 0 }, before: null,
    after: { name: 'B', offset: 8, field: 'x', type: 'i32' },
    status: 'pending',
  };
  assert.deepEqual(proposalArguments(nameAlias), { name: 'A', offset: 0, field: 'x', type: 'i32' });
});

test("issue #5412 - the issue's redirect scenario leaves no cross-target side effect", async () => {
  const { store, executor, app } = environment();
  const proposal = store.create({
    kind: 'struct-field',
    target: { struct: 'A', offset: 0 },
    before: null,
    after: { field: 'x', type: 'i32' },
    evidenceIds: ['ev-1'],
  });
  // Tamper with the approved target after creation: the stale check (target
  // fingerprint) must reject the proposal before any mutation runs.
  app.notes.structs.push({ name: 'A', fields: [{ offset: 0, name: 'old', type: 'u8' }] });
  await assert.rejects(
    () => executor.approveAndApply(proposal.id),
    (error) => error.type === 'tool_failed',
  );
  assert.equal(app.notes.structs[0].fields[0].name, 'old', 'stale target is not mutated');
});

test('issue #5412 - legit {field,type} after applies at the approved target only', async () => {
  const { store, executor, app } = environment();
  const proposal = store.create({
    kind: 'struct-field',
    target: { struct: 'A', offset: 0 },
    before: null,
    after: { field: 'x', type: 'i32' },
    evidenceIds: ['ev-1'],
  });
  const result = await executor.approveAndApply(proposal.id);
  assert.equal(result.proposal.status, 'applied');
  assert.deepEqual(app.notes.structs, [{ name: 'A', fields: [{ offset: 0, name: 'x', type: 'i32' }] }]);
});

test('issue #5412 - after carrying the struct alias `name` is rejected too', () => {
  const { store } = environment();
  // `setStructField` reads args.struct || args.name as the struct identity,
  // so an after.name is a target override, never a field value.
  assert.throws(() => store.create({
    kind: 'struct-field',
    target: { struct: 'A', offset: 0 },
    before: null,
    after: { name: 'B', field: 'x', type: 'i32' },
    evidenceIds: ['ev-1'],
  }), (error) => error.type === 'invalid_tool_call');
});

test('issue #5412 - legacy target.field channel still applies', async () => {
  const { store, executor, app } = environment();
  const proposal = store.create({
    kind: 'struct-field',
    target: { struct: 'A', offset: 0, field: 'x' },
    before: null,
    after: { type: 'i32' },
    evidenceIds: ['ev-1'],
  });
  const result = await executor.approveAndApply(proposal.id);
  assert.equal(result.proposal.status, 'applied');
  assert.deepEqual(app.notes.structs, [{ name: 'A', fields: [{ offset: 0, name: 'x', type: 'i32' }] }]);
});

test('issue #5412 - after keys outside the value domain are ignored, never executed', () => {
  const legacy = {
    id: 'legacy-3', kind: 'struct-field',
    target: { struct: 'A', offset: 0 }, before: null,
    after: { field: 'x', type: 'i32', extra: 'noise' },
    status: 'pending',
  };
  assert.deepEqual(proposalArguments(legacy), { struct: 'A', offset: 0, field: 'x', type: 'i32' });
});
