import assert from 'node:assert/strict';
import test from 'node:test';
import { InvestigationSessionStore } from '../js/ai/session-core/index.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('issue #5556 - a slow older save can never roll persistence back to a stale snapshot', async () => {
  const events = [];
  let persisted = null;
  const gateA = deferred();
  const gates = new Map([['A', gateA.promise]]);
  const persistence = {
    async save(session) {
      events.push(`save:${session.goal}`);
      if (gates.has(session.goal)) await gates.get(session.goal);
      persisted = structuredClone(session);
      events.push(`done:${session.goal}`);
    },
    async load() { return persisted; },
  };
  const store = new InvestigationSessionStore({ persistence });
  const session = await store.create({ id: 's', goal: 'init' });
  assert.equal(persisted.goal, 'init');

  const first = store.update(session.id, { goal: 'A' });
  // Save A is entered and parked inside the adapter.
  while (!events.includes('save:A')) await Promise.resolve();

  let bSettled = false;
  const second = store.update(session.id, { goal: 'B' });
  second.then(() => { bSettled = true; });
  // B must be queued behind A's save, not overlapped with it.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(bSettled, false, 'save B waits for save A to complete (write ordering)');
  assert.equal(persisted.goal, 'init', 'A is still the in-flight save; nothing newer landed');

  gateA.resolve();
  await first;
  await second;

  assert.equal((await store.get(session.id)).goal, 'B', 'memory keeps the newest state');
  assert.equal(persisted.goal, 'B', 'persistence keeps the newest state');
  assert.deepEqual(events, ['save:init', 'done:init', 'save:A', 'done:A', 'save:B', 'done:B'], 'saves are serialized in logical order');
});

test('issue #5556 - appendMessage/updateMemory overlap keeps the newest revision on reload', async () => {
  const saves = [];
  let persisted = null;
  const gate = deferred();
  let gateNext = false;
  const persistence = {
    async save(session) {
      saves.push(session.messages.map((m) => m.content));
      if (gateNext) { gateNext = false; await gate.promise; }
      persisted = structuredClone(session);
    },
    async load() { return persisted; },
  };
  const store = new InvestigationSessionStore({ persistence });
  const session = await store.create({ id: 's2', goal: 'init', messages: [] });

  gateNext = true;
  const slowAppend = store.appendMessage(session.id, { role: 'user', content: 'first' });
  while (saves.length < 2) await Promise.resolve(); // create + gated append entered
  const memoryUpdate = store.updateMemory(session.id, { goal: 'investigate-x' });
  const fastAppend = store.appendMessage(session.id, { role: 'assistant', content: 'answer' });

  gate.resolve();
  await Promise.all([slowAppend, memoryUpdate, fastAppend]);

  const reloaded = new InvestigationSessionStore({ persistence });
  const restored = await reloaded.get(session.id);
  assert.equal(restored.investigationMemory.goal, 'investigate-x');
  const contents = restored.messages.map((m) => m.content);
  assert.ok(contents.includes('first'), 'the gated first message survives reload');
  assert.ok(contents.includes('answer'), 'the later message survives reload');
});

test('issue #5556 - delete joins the ordering domain and cannot be resurrected by a late save', async () => {
  let persisted = null;
  const saved = [];
  const gate = deferred();
  const gates = new Map([['slow', gate.promise]]);
  const persistence = {
    async save(session) {
      saved.push(session.goal);
      if (gates.has(session.goal)) await gates.get(session.goal);
      persisted = structuredClone(session);
    },
    async load() { return persisted; },
    async delete(id) { persisted = null; },
  };
  const store = new InvestigationSessionStore({ persistence });
  const session = await store.create({ id: 's3', goal: 'init' });
  assert.ok(session);

  const pending = store.update(session.id, { goal: 'slow' });
  const laterUpdate = store.update(session.id, { goal: 'later' });
  const deletion = store.delete(session.id);
  gate.resolve();
  await pending;
  await laterUpdate;
  await deletion;

  assert.equal(persisted, null, 'a completed save never resurrects a deleted session');
  assert.equal(await store.get(session.id), null, 'memory no longer holds the session');
  assert.equal(await store.update(session.id, { goal: 'after-delete' }), null, 'updates to a deleted session fail closed');
});

test('issue #5556 - different sessions are not serialized against each other', async () => {
  let persisted = null;
  const gate = deferred();
  const persistence = {
    async save(session) {
      if (session.goal === 'slow') await gate.promise;
      persisted = persisted || {};
      persisted[session.id] = structuredClone(session);
    },
    async load(id) { return persisted?.[id] || null; },
  };
  const store = new InvestigationSessionStore({ persistence });
  await store.create({ id: 'a', goal: 'init' });
  await store.create({ id: 'b', goal: 'init' });

  const slowA = store.update('a', { goal: 'slow' });
  const fastB = await store.update('b', { goal: 'fast' });
  assert.equal(fastB.goal, 'fast', 'session b is not blocked by session a');
  assert.equal(persisted.b.goal, 'fast');
  gate.resolve();
  await slowA;
  assert.equal(persisted.a.goal, 'slow');
});

test('issue #5556 - a failed save does not stall the queue for later updates', async () => {
  let attempts = 0;
  let persisted = null;
  const persistence = {
    async save(session) {
      attempts += 1;
      if (attempts === 1) throw new Error('disk full');
      persisted = structuredClone(session);
    },
    async load() { return persisted; },
  };
  const store = new InvestigationSessionStore({ persistence });
  await assert.rejects(() => store.create({ id: 's4', goal: 'boom' }), /disk full/);
  const session = await store.create({ id: 's4', goal: 'after-failure' });
  assert.equal(session.goal, 'after-failure');
  assert.equal(persisted.goal, 'after-failure', 'later updates still persist');
  assert.equal((await store.get('s4')).goal, 'after-failure');
});

test('issue #5556 - in-memory state and reloaded state agree after concurrent updates', async () => {
  let persisted = null;
  const persistence = {
    async save(session) { persisted = structuredClone(session); },
    async load() { return persisted; },
  };
  const store = new InvestigationSessionStore({ persistence });
  const session = await store.create({ id: 's5', goal: 'init' });
  await Promise.all([
    store.update(session.id, { goal: 'one' }),
    store.appendMessage(session.id, { role: 'user', content: 'm1' }),
    store.updateMemory(session.id, { confirmedFacts: ['f1'] }),
    store.update(session.id, { goal: 'final' }),
  ]);
  const live = await store.get(session.id);
  const reloaded = new InvestigationSessionStore({ persistence });
  const restored = await reloaded.get(session.id);
  assert.equal(restored.goal, live.goal);
  assert.equal(restored.messages.length, live.messages.length);
  assert.deepEqual(restored.investigationMemory.confirmedFacts, live.investigationMemory.confirmedFacts);
});
