import assert from 'node:assert/strict';

import { InvestigationSessionStore } from '../../../js/ai/session-core/index.js';

function assertFrozenTree(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true, 'published session records must be deeply frozen');
  for (const key of Reflect.ownKeys(value)) assertFrozenTree(value[key], seen);
}

const input = {
  id: 'session-4449',
  binaryId: 'binary-A',
  binaryIdentity: { id: 'binary-A', confidence: 'strong', state: 'ready' },
  projectId: 'project-A',
  goal: 'inspect A',
  messages: [{ role: 'user', content: 'original' }],
  investigationMemory: {
    anchor: { address: '0x1000', scope: 'binary' },
    confirmedFacts: [{ id: 'fact-1', summary: 'original' }],
  },
};
const store = new InvestigationSessionStore();
const created = await store.create(input);

assertFrozenTree(created);
assert.strictEqual(store.sessions.get(created.id), created, 'the owned record remains the map value');
assert.throws(() => { created.binaryId = 'binary-B'; }, TypeError);
assert.throws(() => { created.binaryIdentity.id = 'binary-B'; }, TypeError);
assert.throws(() => { created.investigationMemory.anchor.address = '0x2000'; }, TypeError);
assert.throws(() => { created.investigationMemory.confirmedFacts[0].summary = 'forged'; }, TypeError);
assert.throws(() => { created.messages[0].content = 'forged'; }, TypeError);

input.binaryIdentity.id = 'binary-B';
input.investigationMemory.anchor.address = '0x2000';
input.messages[0].content = 'caller-forged';
const fetched = await store.get(created.id);
assert.strictEqual(fetched, created);
assert.equal(fetched.binaryId, 'binary-A');
assert.equal(fetched.binaryIdentity.id, 'binary-A');
assert.equal(fetched.investigationMemory.anchor.address, '0x1000');
assert.equal(fetched.messages[0].content, 'original');

const listed = store.list();
listed.pop();
assert.equal(store.list().length, 1, 'list array mutation must not affect store membership');
assert.throws(() => { store.list()[0].projectId = 'project-B'; }, TypeError);

const patch = {
  binaryIdentity: { id: 'binary-B', confidence: 'strong', state: 'ready' },
  projectId: 'project-B',
  investigationMemory: { anchor: { address: '0x2000', scope: 'binary' } },
  messages: [{ role: 'assistant', content: 'updated' }],
};
const updated = await store.update(created.id, patch);
assert.notStrictEqual(updated, created, 'controlled update publishes a new owned record');
assertFrozenTree(updated);
assert.equal(updated.binaryId, 'binary-B', 'binaryId follows a controlled identity update');
assert.equal(updated.binaryIdentity.id, 'binary-B');
assert.equal(updated.projectId, 'project-B');
assert.equal(updated.investigationMemory.anchor.address, '0x2000');
patch.binaryIdentity.id = 'binary-C';
patch.investigationMemory.anchor.address = '0x3000';
assert.equal(updated.binaryIdentity.id, 'binary-B', 'update does not retain patch aliases');
assert.equal(updated.investigationMemory.anchor.address, '0x2000');
assert.strictEqual(await store.get(created.id), updated);

const registered = store.register({ id: 'registered-4449', binaryId: 'binary-R', investigationMemory: { anchor: { address: '0x4000' } } });
assertFrozenTree(registered);
assert.strictEqual(store.sessions.get(registered.id), registered);
assert.throws(() => { registered.investigationMemory.anchor.address = '0x5000'; }, TypeError);

const mismatchStore = new InvestigationSessionStore({
  persistence: { async load() { return { id: 'session-other', binaryId: 'binary-other' }; } },
});
assert.equal(await mismatchStore.get('session-requested'), null, 'a persistence identity mismatch fails closed');
assert.equal(mismatchStore.sessions.has('session-requested'), false, 'mismatched persistence must not be cached under the requested key');

console.log('issue-4449 investigation session ownership tests passed');
