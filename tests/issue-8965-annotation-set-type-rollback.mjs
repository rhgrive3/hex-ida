/* Regression for #8965: `annotation.set-type` treated a failed durable write as a
   plain `tool_failed` while leaving the rejected type in the live `NoteStore`
   map, so the next successful `notes.save()` promoted the refused mutation into
   durable state. Every sibling annotation mutation (`setNote`, `renameSymbol`,
   `setStructField`) already snapshots the prior binding and restores it, plus
   the store status, when persistence returns false; `setType` was the one
   asymmetric path. The whole repair stays inside `setType()` — no shared helper
   and no store-layer edit — so the other four mutation paths keep their exact
   audited behaviour. */
import assert from 'node:assert/strict';
import { CapabilityExecutor } from '../js/ai/capabilities/executor.js';
import { ProposalStore, proposalArguments } from '../js/ai/proposals.js';
import { createCapabilityCatalog } from '../js/ai/capabilities/catalog.js';

class StorageMock {
  constructor() { this.items = new Map(); this.failWrites = false; }
  get length() { return this.items.size; }
  key(index) { return Array.from(this.items.keys())[index] ?? null; }
  getItem(key) { return this.items.get(String(key)) ?? null; }
  setItem(key, value) {
    if (this.failWrites) {
      const error = new Error('storage quota exceeded');
      error.name = 'QuotaExceededError';
      throw error;
    }
    this.items.set(String(key), String(value));
  }
  removeItem(key) { this.items.delete(String(key)); }
  clear() { this.items.clear(); }
}

const catalog = createCapabilityCatalog();
const evidenceStore = { has: (id) => id === 'evidence' };
const binding = () => ({ binaryId: 'bin-a', projectId: 'project-a', runtimeSessionId: null });

function executorFor(app) {
  const executor = new CapabilityExecutor({ catalog, app });
  return executor;
}

/* Apply `annotation.set-type` through real single-use proposal authority, the
   same production entry point the sibling regressions use, so a bypass of the
   approval gate could never be mistaken for coverage. */
async function applySetType(executor, args) {
  const store = new ProposalStore({ evidenceStore, binding });
  const proposal = store.create({
    kind: 'type',
    target: { address: args.address, key: args.key },
    before: args.before,
    after: args.value,
    evidenceIds: ['evidence'],
  });
  const { approvalToken } = store.approve(proposal.id);
  let result = null;
  let error = null;
  try {
    await store.apply(proposal.id, {
      approvalToken,
      currentState: args.before,
      apply: async (approved, authorization) => {
        result = await executor.execute(
          'annotation.set-type',
          proposalArguments(approved),
          { authorization },
        );
      },
    });
  } catch (thrown) {
    error = thrown;
  }
  return { result, error, status: store.records.get(proposal.id)?.status };
}

/* ── 1. The durable-promotion attack: rejected type must not survive into the
   store's own `save()` on the real `NoteStore`. ── */
{
  const storage = new StorageMock();
  globalThis.localStorage = storage;
  const { NoteStore } = await import('../js/names.js');
  const notes = new NoteStore('issue-8965');
  assert.equal(notes.setType(0x1000, 'return', 'int'), true, 'baseline type must persist');
  assert.equal(notes.dirty, false, 'a durable write clears dirty');
  const savedBefore = storage.items.size;

  storage.failWrites = true;
  const executor = executorFor({ notes });
  const { error, status } = await applySetType(executor, {
    address: '0x1000', key: 'return', value: 'my_struct *', before: 'int',
  });
  assert.equal(error?.type, 'tool_failed', 'a failed durable write still surfaces as tool_failed');
  assert.equal(status, 'failed', 'the proposal itself stays failed');
  assert.equal(notes.typeOf(0x1000, 'return'), 'int', 'the rejected type must not stay live');
  assert.equal(notes.dirty, false, 'a rolled-back mutation must not leave the store dirty');
  assert.equal(notes.lastMutationSaved, true, 'rollback must restore the pre-mutation save status');

  storage.failWrites = false;
  assert.equal(notes.save(), true, 'the next save must succeed');
  const reopened = new NoteStore('issue-8965');
  assert.equal(reopened.typeOf(0x1000, 'return'), 'int',
    'the refused type must never be promoted to durable state by a later save');
  assert.equal(reopened.lastMutationSaved, true);
  assert.ok(storage.items.size >= savedBefore);
  for (const key of storage.items.keys()) {
    assert.doesNotMatch(String(storage.items.get(key)), /my_struct/,
      'no durable record may retain the refused type value');
  }
  delete globalThis.localStorage;
}

/* ── 2. Deleting a type is the same transaction. A failed delete must restore
   the previously stored type rather than leave the binding removed. ── */
{
  const storage = new StorageMock();
  globalThis.localStorage = storage;
  const { NoteStore } = await import('../js/names.js');
  const notes = new NoteStore('issue-8965-del');
  assert.equal(notes.setType(0x2000, 'return', 'int'), true);
  storage.failWrites = true;
  const { error } = await applySetType(executorFor({ notes }), {
    address: '0x2000', key: 'return', value: '', before: 'int',
  });
  assert.equal(error?.type, 'tool_failed');
  assert.equal(notes.typeOf(0x2000, 'return'), 'int', 'a failed delete must keep the stored type');
  assert.equal(notes.dirty, false);
  delete globalThis.localStorage;
}

/* ── 3. Rollback is exact per (address, key): a sibling binding of the same
   function is never disturbed, and an absent binding is not fabricated. ── */
{
  const storage = new StorageMock();
  globalThis.localStorage = storage;
  const { NoteStore } = await import('../js/names.js');
  const notes = new NoteStore('issue-8965-keys');
  assert.equal(notes.setType(0x3000, 'arg0', 'int'), true);
  storage.failWrites = true;
  const { error } = await applySetType(executorFor({ notes }), {
    address: '0x3000', key: 'return', value: 'float', before: null,
  });
  assert.equal(error?.type, 'tool_failed');
  assert.equal(notes.typeOf(0x3000, 'return'), null, 'an absent binding must stay absent');
  assert.equal(notes.typeOf(0x3000, 'arg0'), 'int', 'a sibling key must be untouched');
  assert.equal(notes.dirty, false);

  storage.failWrites = false;
  assert.equal(notes.save(), true);
  const reopened = new NoteStore('issue-8965-keys');
  assert.equal(reopened.typeOf(0x3000, 'return'), null);
  assert.equal(reopened.typeOf(0x3000, 'arg0'), 'int');
  delete globalThis.localStorage;
}

/* ── 4. Fail-closed before mutating: without a readable prior binding there is
   no rollback authority, so the setter must never be reached. ── */
{
  let setCalls = 0;
  let current = 'before';
  const executor = executorFor({
    notes: {
      typeOf() { throw new Error('snapshot unavailable'); },
      setType(_address, _key, next) { setCalls += 1; current = next; return false; },
    },
  });
  const { error } = await applySetType(executor, {
    address: '0x4000', key: 'return', value: 'after', before: 'before',
  });
  assert.equal(error?.type, 'tool_failed');
  assert.equal(setCalls, 0, 'a throwing type getter must fail before the mutation');
  assert.equal(current, 'before', 'a throwing type getter must leave live state untouched');
}
{
  let setCalls = 0;
  const executor = executorFor({ notes: { setType() { setCalls += 1; return false; } } });
  const { error } = await applySetType(executor, {
    address: '0x4000', key: 'return', value: 'after', before: null,
  });
  assert.equal(error?.type, 'tool_failed');
  assert.equal(setCalls, 0,
    'an adapter with no snapshot capability must be refused before mutation, not partially applied');
}

/* ── 5. A rollback that itself cannot complete must say so, and must not report
   the plain persistence message that implies the state is unchanged. ── */
{
  let calls = 0;
  const executor = executorFor({
    notes: {
      typeOf: () => 'before',
      dirty: false,
      lastSaveError: null,
      lastMutationSaved: true,
      setType() { calls += 1; return false; },
    },
  });
  // The store refuses the mutation, then the rollback write also fails.
  const { error } = await applySetType(executor, {
    address: '0x5000', key: 'return', value: 'after', before: 'before',
  });
  assert.equal(error?.type, 'tool_failed');
  assert.equal(calls, 2, 'one mutation attempt plus one rollback attempt');
  assert.match(error.message, /could not be rolled back/,
    'a rollback that also fails must not masquerade as a clean persistence failure');
}
{
  const notes = {
    dirty: false, lastSaveError: null, lastMutationSaved: true,
    typeOf: () => 'before',
    setType(_address, _key, next) {
      if (next === 'after') return false;
      throw new Error('rollback write threw');
    },
  };
  const { error } = await applySetType(executorFor({ notes }), {
    address: '0x5000', key: 'return', value: 'after', before: 'before',
  });
  assert.equal(error?.type, 'tool_failed');
  assert.match(error.message, /could not be rolled back/,
    'a failed rollback must be reported as such instead of a clean persistence failure');
  assert.equal(notes.dirty, false, 'the store status must still be restored on a throwing rollback');
}

/* ── 6. Success path stays intact: the approved type is applied and durable, and
   no rollback is attempted. ── */
{
  const storage = new StorageMock();
  globalThis.localStorage = storage;
  const { NoteStore } = await import('../js/names.js');
  const notes = new NoteStore('issue-8965-ok');
  const rollbackCalls = [];
  const wrapped = {
    typeOf: (addr, key) => notes.typeOf(addr, key),
    setType: (...args) => { if (args[3]?.save === false) rollbackCalls.push(args); return notes.setType(...args); },
  };
  const { result, error, status } = await applySetType(executorFor({ notes: wrapped }), {
    address: '0x6000', key: 'return', value: 'ssize_t', before: null,
  });
  assert.equal(error, null, 'a persistable approved type must not fail');
  assert.equal(result?.ok, true);
  assert.deepEqual(rollbackCalls, [], 'a successful mutation must not roll back');
  assert.equal(status, 'applied');
  const reopened = new NoteStore('issue-8965-ok');
  assert.equal(reopened.typeOf(0x6000, 'return'), 'ssize_t', 'the approved type must be durable');
  delete globalThis.localStorage;
}

console.log('issue #8965 annotation.set-type persistence rollback PASS');
