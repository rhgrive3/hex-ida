import assert from 'node:assert/strict';
import { InvestigationSessionStore } from '../../../js/ai/session-core/index.js';

const clone = (value) => structuredClone(value);
const persisted = new Map();
const saveAttempts = [];
let failSaves = true;
const persistence = {
  async save(session) {
    saveAttempts.push(session.id);
    if (failSaves) throw new Error('storage unavailable');
    persisted.set(session.id, clone(session));
  },
  async load(id) { return persisted.has(id) ? clone(persisted.get(id)) : null; },
};

const store = new InvestigationSessionStore({ persistence });
const existing = store.register({ id: 'existing', binaryId: 'binary-existing', goal: 'keep me' });

await assert.rejects(
  () => store.create({ id: 'failed', binaryId: 'binary-failed', goal: 'ghost' }),
  /storage unavailable/,
  'a failed persistence write must reject create',
);
assert.equal(store.sessions.has('failed'), false, 'a failed create must not leave an in-memory ghost');
assert.equal(await store.get('failed'), null, 'get must not observe a failed create');
assert.equal(store.list().some((session) => session.id === 'failed'), false, 'list must not expose a failed create');
assert.equal(await store.update('failed', { goal: 'mutate ghost' }), null, 'update must not revive a failed create');
assert.equal(await store.appendMessage('failed', { role: 'user', content: 'mutate ghost' }), null, 'append must not revive a failed create');
assert.strictEqual(store.sessions.get('existing'), existing, 'a failed create must not remove another session');
assert.equal(store.list().some((session) => session.id === 'existing'), true, 'the existing session remains listed');
assert.deepEqual(saveAttempts, ['failed'], 'the failed create attempted exactly one durable write');

failSaves = false;
const recovered = await store.create({ id: 'failed', binaryId: 'binary-recovered', goal: 'recovered' });
assert.equal(recovered.id, 'failed', 'the same explicit id can be created after persistence recovers');
assert.equal(store.sessions.get('failed'), recovered, 'a successful retry becomes visible');
assert.equal(persisted.get('failed').id, 'failed', 'the retry is durably registered');

const successful = await store.create({ id: 'successful', binaryId: 'binary-successful', goal: 'normal' });
assert.equal(successful.id, 'successful');
assert.equal(store.sessions.get('successful'), successful, 'successful create retains normal memory semantics');
assert.equal(persisted.get('successful').id, 'successful', 'successful create retains normal persistence semantics');

console.log('[phase12] #4415 session create durability/rollback tests passed');
