import assert from 'node:assert/strict';
import test from 'node:test';

import { InvestigationSessionStore } from '../../../js/ai/session-core/index.js';

const clone = (value) => structuredClone(value);

// The canonical runner awaits imports; settle these cases before it imports
// another module that may instrument shared globals such as timers.
await test('#4578 create rejects an in-memory duplicate without touching persistence', async () => {
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

await test('#4578 create rejects an existing persistence-only session without overwriting it', async () => {
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

await test('#4578 concurrent create calls reserve an explicit ID before the first await', async () => {
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

await test('#4578 failed create releases its reservation and normal create/update semantics remain intact', async () => {
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

await test('#4578/#5556 create/delete/create uses one ordered queue and protects the new reservation', async () => {
  const persisted = new Map();
  const events = [];
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const saving = new Promise((resolve) => { started = resolve; });
  const store = new InvestigationSessionStore({ persistence: {
    async load(id) { events.push('load'); return persisted.get(id) ?? null; },
    async save(session) {
      events.push(`save:${session.goal}`);
      if (session.goal === 'first') { started(); await gate; }
      persisted.set(session.id, clone(session));
    },
    async delete(id) { events.push('delete'); persisted.delete(id); },
  } });
  const first = store.create({ id: 'ordered', goal: 'first' });
  await saving;
  assert.equal(store.sessions.has('ordered'), false, 'pending save must remain invisible');
  const deletion = store.delete('ordered');
  const second = store.create({ id: 'ordered', goal: 'second' });
  await assert.rejects(store.create({ id: 'ordered', goal: 'duplicate' }), /already exists/);
  release();
  await first;
  await assert.rejects(store.create({ id: 'ordered', goal: 'late duplicate' }), /already exists/);
  await Promise.all([deletion, second]);
  assert.deepEqual(events, ['load', 'save:first', 'delete', 'load', 'save:second']);
  assert.equal((await store.get('ordered')).goal, 'second');
  assert.equal(persisted.get('ordered').goal, 'second');
});

await test('#4578/#5556 update submitted during the create probe follows the durable creation', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const writes = [];
  const store = new InvestigationSessionStore({ persistence: {
    async load() { await gate; return null; },
    async save(session) { writes.push(session.goal); },
  } });
  const creation = store.create({ id: 'ordered-update', goal: 'created' });
  const update = store.update('ordered-update', { goal: 'updated' });
  await assert.rejects(store.create({ id: 'ordered-update' }), /already exists/);
  release();
  await Promise.all([creation, update]);
  assert.deepEqual(writes, ['created', 'updated']);
  assert.equal((await store.get('ordered-update')).goal, 'updated');
});

await test('#4578 malformed occupied slots fail closed and probe errors release reservations', async () => {
  for (const existing of [false, 0, '', {}, { id: 'other' }]) {
    let saves = 0;
    const store = new InvestigationSessionStore({ persistence: {
      async load() { return existing; }, async save() { saves++; },
    } });
    await assert.rejects(store.create({ id: 'occupied' }), /already exists/);
    assert.equal(saves, 0);
    assert.equal(store.sessions.size, 0);
  }
  let fail = true;
  const store = new InvestigationSessionStore({ persistence: {
    async load() { if (fail) throw new Error('probe failed'); return null; },
  } });
  await assert.rejects(store.create({ id: 'probe-retry' }), /probe failed/);
  fail = false;
  assert.equal((await store.create({ id: 'probe-retry' })).id, 'probe-retry');
});

await test('#4578/#5556 a failed queued delete cannot make an existing ID reusable', async () => {
  const store = new InvestigationSessionStore({ persistence: {
    async delete() { throw new Error('delete failed'); },
  } });
  const original = await store.create({ id: 'keep', goal: 'original' });
  const deletion = store.delete('keep');
  const replacement = store.create({ id: 'keep', goal: 'replacement' });
  await assert.rejects(deletion, /delete failed/);
  await assert.rejects(replacement, /already exists/);
  assert.strictEqual(await store.get('keep'), original);
});

await test('#4578/#5556 queued deletion releases the reservation without exposing a staged create', async () => {
  let staged = null;
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const saving = new Promise((resolve) => { started = resolve; });
  const store = new InvestigationSessionStore({ persistence: {
    async load() { return staged; },
    async save(session) { staged = session; started(); await gate; },
    async delete() { staged = null; },
  } });
  const creation = store.create({ id: 'staged', goal: 'pending' });
  await saving;
  const deletion = store.delete('staged');
  assert.equal(await store.get('staged'), null, 'delete must not expose the earlier undurable save');
  assert.equal(store.sessions.size, 0);
  release();
  await Promise.all([creation, deletion]);
  assert.equal(await store.get('staged'), null);
  assert.equal(store.publishing.size, 0);
  const retry = await store.create({ id: 'staged', goal: 'retry' });
  assert.equal((await store.update('staged', { goal: 'updated' })).goal, 'updated');
  assert.equal(retry.goal, 'retry');
});
