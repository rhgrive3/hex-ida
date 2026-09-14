import assert from 'node:assert/strict';
import test from 'node:test';

import { InvestigationSessionStore } from '../../../js/ai/session-core/index.js';

function makePersistence() {
  const durable = new Map();
  let fail = false;
  return {
    durable,
    setFail(value) { fail = value; },
    persistence: {
      async save(session) {
        if (fail) throw new Error('storage unavailable');
        durable.set(session.id, structuredClone(session));
      },
      async load(id) {
        const session = durable.get(String(id));
        return session ? structuredClone(session) : null;
      },
    },
  };
}

function stateSnapshot(session) {
  return {
    goal: session.goal,
    summary: session.summary,
    messages: session.messages,
    investigationMemory: session.investigationMemory,
  };
}

test('#4420 failed update, appendMessage, and updateMemory keep the prior state canonical', async () => {
  const storage = makePersistence();
  const store = new InvestigationSessionStore({ persistence: storage.persistence });
  const id = 'issue-4420-session';
  await store.create({
    id,
    goal: 'before',
    summary: 'before summary',
    messages: [{ role: 'user', content: 'existing message' }],
    investigationMemory: {
      goal: 'before memory',
      confirmedFacts: [{ id: 'fact-before', summary: 'durable fact' }],
    },
  });

  const before = await store.get(id);
  const beforeSnapshot = stateSnapshot(before);
  const beforeUpdatedAt = before.updatedAt;
  const beforeDurable = stateSnapshot(storage.durable.get(id));
  storage.setFail(true);

  await assert.rejects(store.update(id, { goal: 'after', summary: 'ghost summary' }), /storage unavailable/);
  await assert.rejects(
    store.appendMessage(id, { role: 'assistant', content: 'ghost message' }),
    /storage unavailable/,
  );
  await assert.rejects(
    store.updateMemory(id, { goal: 'ghost memory', confirmedFacts: [{ id: 'fact-ghost' }] }),
    /storage unavailable/,
  );

  const visible = await store.get(id);
  assert.deepEqual(stateSnapshot(visible), beforeSnapshot);
  assert.equal(visible.updatedAt, beforeUpdatedAt, 'a rejected update must not advance updatedAt');
  assert.deepEqual(store.list().map(stateSnapshot), [beforeSnapshot], 'list() must not expose failed writes');
  assert.deepEqual(stateSnapshot(storage.durable.get(id)), beforeDurable, 'durable state must remain unchanged');

  const reloaded = await new InvestigationSessionStore({ persistence: storage.persistence }).get(id);
  assert.deepEqual(stateSnapshot(reloaded), beforeDurable, 'a fresh store must observe the last durable state');
});

test('#4420 successful update-family writes commit after persistence succeeds', async () => {
  const storage = makePersistence();
  const store = new InvestigationSessionStore({ persistence: storage.persistence });
  const id = 'issue-4420-success';
  await store.create({ id, goal: 'before', messages: [], investigationMemory: { goal: 'before memory' } });

  const updated = await store.update(id, { goal: 'after' });
  assert.equal(updated.goal, 'after');
  const appended = await store.appendMessage(id, { role: 'assistant', content: 'committed message' });
  assert.equal(appended.messages.at(-1).content, 'committed message');
  const withMemory = await store.updateMemory(id, { goal: 'after memory', unresolvedQuestions: ['committed question'] });
  assert.equal(withMemory.investigationMemory.goal, 'after memory');
  assert.deepEqual(withMemory.investigationMemory.unresolvedQuestions, ['committed question']);

  const durable = storage.durable.get(id);
  assert.equal(durable.goal, 'after');
  assert.equal(durable.messages.at(-1).content, 'committed message');
  assert.equal(durable.investigationMemory.goal, 'after memory');
  assert.deepEqual(durable.investigationMemory.unresolvedQuestions, ['committed question']);
});
