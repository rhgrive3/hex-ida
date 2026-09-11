import assert from 'node:assert/strict';
import test from 'node:test';

import { createCapabilityCatalog } from '../../../js/ai/capabilities/catalog.js';
import { CapabilityExecutor } from '../../../js/ai/capabilities/executor.js';
import { ProposalExecutor } from '../../../js/ai/interaction/proposal-executor.js';
import { ProposalStore } from '../../../js/ai/proposals.js';
import { NoteStore } from '../../../js/names.js';

const evidenceStore = { has: (id) => id === 'ev' };

class MemoryStorage {
  constructor() { this.items = new Map(); }
  get length() { return this.items.size; }
  key(index) { return Array.from(this.items.keys())[index] ?? null; }
  getItem(key) { return this.items.get(String(key)) ?? null; }
  setItem(key, value) { this.items.set(String(key), String(value)); }
  removeItem(key) { this.items.delete(String(key)); }
}

async function withStorage(run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
  try { return await run(); }
  finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
}

function harness({ canonicalizeEmpty = false, initial = 'old' } = {}) {
  let value = initial;
  let writes = 0;
  const notes = {
    id: 'fixture-binary',
    comment() { return value; },
    setComment(_address, next) {
      writes += 1;
      value = canonicalizeEmpty && next === '' ? null : next;
      return true;
    },
  };
  const app = { notes };
  const store = new ProposalStore({ evidenceStore });
  const capabilityExecutor = new CapabilityExecutor({ catalog: createCapabilityCatalog(), app });
  const executor = new ProposalExecutor({ store, capabilityExecutor, app });
  return { app, store, executor, value: () => value, writes: () => writes };
}

function createComment(store, { before = 'old', after = '' } = {}) {
  return store.create({
    kind: 'comment',
    target: { address: '4096' },
    before,
    after,
    evidenceIds: ['ev'],
  });
}

test('#5120 empty comment applies when an adapter preserves the empty write value', async () => {
  const { store, executor, value } = harness({ canonicalizeEmpty: false });
  const proposal = createComment(store);
  const result = await executor.approveAndApply(proposal.id);
  assert.equal(result.proposal.status, 'applied');
  assert.equal(value(), '');
});

test('#5120 empty comment applies when the adapter canonicalizes deletion to null', async () => {
  const { store, executor, value } = harness({ canonicalizeEmpty: true });
  const proposal = createComment(store);
  const result = await executor.approveAndApply(proposal.id);
  assert.equal(result.proposal.status, 'applied');
  assert.equal(value(), null);
});

test('#5120 the real NoteStore deletion representation applies through the production proposal/capability path', async () => {
  await withStorage(async () => {
    const notes = new NoteStore('issue-5120');
    assert.equal(notes.setComment(4096n, 'old'), true);
    const app = { notes };
    const store = new ProposalStore({ evidenceStore });
    const capabilityExecutor = new CapabilityExecutor({ catalog: createCapabilityCatalog(), app });
    const executor = new ProposalExecutor({ store, capabilityExecutor, app });
    const proposal = createComment(store);

    const result = await executor.approveAndApply(proposal.id);
    assert.equal(result.proposal.status, 'applied');
    assert.equal(notes.comment(4096n), null, 'NoteStore represents a cleared comment as absence');
  });
});

test('#5120 non-empty comment updates keep their exact approved value', async () => {
  const { store, executor, value } = harness({ canonicalizeEmpty: true });
  const proposal = createComment(store, { after: 'fresh note' });
  const result = await executor.approveAndApply(proposal.id);
  assert.equal(result.proposal.status, 'applied');
  assert.equal(value(), 'fresh note');
  assert.equal(result.proposal.after, 'fresh note');
});

test('#5120 an empty current comment uses the same canonical absence representation for staleness checks', async () => {
  const { store, executor } = harness({ canonicalizeEmpty: false, initial: '' });
  const proposal = createComment(store, { before: '', after: 'fresh note' });
  const result = await executor.approveAndApply(proposal.id);
  assert.equal(result.proposal.status, 'applied');
});

test('#5120 malformed falsy adapter states are not laundered into comment absence', async () => {
  for (const sample of [false, 0]) {
    const app = { notes: { id: 'fixture-binary', comment: () => sample } };
    const executor = new ProposalExecutor({ app });
    const live = await executor.currentState({ kind: 'comment', target: { address: '4096' } });
    assert.strictEqual(live, sample, `falsy adapter state ${String(sample)} must remain distinguishable from absence`);
  }
  let coerced = 0;
  const hostile = { [Symbol.toPrimitive]() { coerced += 1; throw new Error('must not coerce'); } };
  const app = { notes: { id: 'fixture-binary', comment: () => hostile } };
  const executor = new ProposalExecutor({ app });
  assert.strictEqual(await executor.currentState({ kind: 'comment', target: { address: '4096' } }), hostile);
  assert.equal(coerced, 0, 'comment state normalization must not invoke caller-controlled coercion hooks');
});

test('#5120 stale comment state is still rejected before mutation', async () => {
  const { store, executor, writes } = harness({ canonicalizeEmpty: true, initial: 'changed elsewhere' });
  const proposal = createComment(store, { before: 'old', after: '' });
  await assert.rejects(
    () => executor.approveAndApply(proposal.id),
    (error) => error?.type === 'tool_failed' && /target changed/.test(error.message),
  );
  assert.equal(store.get(proposal.id).status, 'failed');
  assert.equal(writes(), 0, 'stale proposals must fail before the mutation adapter is called');
});
