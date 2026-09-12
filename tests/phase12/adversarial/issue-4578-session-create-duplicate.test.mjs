import assert from 'node:assert/strict';
import test from 'node:test';

import { InvestigationSessionStore } from '../../../js/ai/session-core/index.js';

const clone = (value) => structuredClone(value);

test('#4578 create rejects an in-memory duplicate without touching persistence', async () => {
  let saves = 0;
  const persistence = {
    async save() { saves++; },
    async load() { throw new Error('duplicate-in-memory must not consult persistence'); },
  };
  const store = new InvestigationSessionStore({ persistence });
  const original = store.register({ id: 'dup-memory', goal: 'keep-original' });

  await assert.rejects(
    () => store.create({ id: 'dup-memory', goal: 'replacement' }),
    /already exists/i,
  );
  assert.strictEqual(await store.get('dup-memory'), original);
  assert.equal((await store.get('dup-memory')).goal, 'keep-original');
  assert.equal(saves, 0, 'duplicate rejection must happen before persistence.save');
});

test('#4578 create rejects an existing persistence-only session without overwriting it', async () => {
  const persisted = new Map([
    ['dup-cold', { id: 'dup-cold', goal: 'persisted-original' }],
  ]);
  let saves = 0;
  const persistence = {
    async load(id) { return persisted.has(id) ? clone(persisted.get(id)) : null; },
    async save(session) { saves++; persisted.set(session.id, clone(session)); },
  };
  const store = new InvestigationSessionStore({ persistence });

  await assert.rejects(
    () => store.create({ id: 'dup-cold', goal: 'replacement' }),
    /already exists/i,
  );
  assert.equal(saves, 0, 'cold duplicate rejection must not write over persisted state');
  assert.equal(persisted.get('dup-cold').goal, 'persisted-original');
  assert.equal(store.sessions.has('dup-cold'), false, 'duplicate probe must not publish a replacement');
});

test('#4578 concurrent create calls reserve an explicit ID before the first await', async () => {
  let releaseSave;
  let saveStartedResolve;
  const saveStarted = new Promise((resolve) => { saveStartedResolve = resolve; });
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  let loads = 0;
  let saves = 0;
  const persistence = {
    async load() { loads++; return null; },
    async save() {
      saves++;
      saveStartedResolve();
      await saveGate;
    },
  };
  const store = new InvestigationSessionStore({ persistence });

  const first = store.create({ id: 'same-id', goal: 'first' });
  await saveStarted;
  const second = store.create({ id: 'same-id', goal: 'second' });
  await Promise.resolve();
  releaseSave();
  const results = await Promise.allSettled([first, second]);

  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1,
    'exactly one concurrent create may own the explicit ID');
  assert.equal(results.filter((item) => item.status === 'rejected' && /already exists/i.test(item.reason?.message || '')).length, 1,
    'the losing create must fail as a duplicate');
  assert.equal(loads, 1, 'the losing create must not start a second persistence probe');
  assert.equal(saves, 1, 'exactly one concurrent create may persist the reserved ID');
  assert.equal((await store.get('same-id')).goal, 'first');
});

test('#4578 failed create releases its reservation and normal create/update semantics remain intact', async () => {
  let fail = true;
  const persisted = new Map();
  const persistence = {
    async load(id) { return persisted.has(id) ? clone(persisted.get(id)) : null; },
    async save(session) {
      if (fail) throw new Error('storage unavailable');
      persisted.set(session.id, clone(session));
    },
  };
  const store = new InvestigationSessionStore({ persistence });

  await assert.rejects(() => store.create({ id: 'retry-id', goal: 'first attempt' }), /storage unavailable/);
  fail = false;
  const retry = await store.create({ id: 'retry-id', goal: 'retry' });
  assert.equal(retry.goal, 'retry');

  const other = await store.create({ id: 'other-id', goal: 'other' });
  assert.equal(other.id, 'other-id');
  const automatic = await store.create({ goal: 'automatic' });
  assert.match(automatic.id, /^ai_/);

  const updated = await store.update('retry-id', { goal: 'updated' });
  assert.equal(updated.goal, 'updated', 'explicit update remains the mutation API for an existing session');
  assert.equal((await store.get('other-id')).goal, 'other');
});

console.log('issue #4578 session create duplicate authority: PASS');
