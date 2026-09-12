import assert from 'node:assert/strict';
import test from 'node:test';

import { InvestigationSessionStore } from '../../../js/ai/session-core/index.js';

function ids(rows) {
  return rows.map((row) => typeof row === 'string' ? row : row.id).sort();
}

async function completesWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('different session update was globally serialized')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('#4586 concurrent updateMemory merges both confirmed facts instead of losing one', async () => {
  const store = new InvestigationSessionStore();
  const session = await store.create({
    id: 'issue-4586-facts',
    investigationMemory: { confirmedFacts: [] },
  });

  await Promise.all([
    store.updateMemory(session.id, { confirmedFacts: [{ id: 'A', claim: 'fact A' }] }),
    store.updateMemory(session.id, { confirmedFacts: [{ id: 'B', claim: 'fact B' }] }),
  ]);

  const current = await store.get(session.id);
  assert.deepEqual(ids(current.investigationMemory.confirmedFacts), ['A', 'B']);
});

test('#4586 concurrent updateMemory serializes every merge-list field and preserves dedupe', async () => {
  const store = new InvestigationSessionStore();
  const session = await store.create({ id: 'issue-4586-lists' });

  await Promise.all([
    store.updateMemory(session.id, {
      activeHypotheses: [{ id: 'h-A' }],
      rejectedHypotheses: [{ id: 'r-A' }],
      unresolvedQuestions: [{ id: 'q-A' }],
      importantPriorActions: [{ id: 'p-A' }],
      userConstraints: ['shared', 'constraint-A'],
    }),
    store.updateMemory(session.id, {
      activeHypotheses: [{ id: 'h-B' }],
      rejectedHypotheses: [{ id: 'r-B' }],
      unresolvedQuestions: [{ id: 'q-B' }],
      importantPriorActions: [{ id: 'p-B' }],
      userConstraints: ['shared', 'constraint-B'],
    }),
  ]);

  const memory = (await store.get(session.id)).investigationMemory;
  assert.deepEqual(ids(memory.activeHypotheses), ['h-A', 'h-B']);
  assert.deepEqual(ids(memory.rejectedHypotheses), ['r-A', 'r-B']);
  assert.deepEqual(ids(memory.unresolvedQuestions), ['q-A', 'q-B']);
  assert.deepEqual(ids(memory.importantPriorActions), ['p-A', 'p-B']);
  assert.deepEqual([...memory.userConstraints].sort(), ['constraint-A', 'constraint-B', 'shared']);
  assert.equal(memory.userConstraints.filter((value) => value === 'shared').length, 1);
});

test('#4586 cold persistence load also serializes concurrent memory merges', async () => {
  const durable = new Map();
  const persistence = {
    async save(session) { durable.set(session.id, structuredClone(session)); },
    async load(id) {
      const value = durable.get(id);
      return value ? structuredClone(value) : null;
    },
  };
  const writer = new InvestigationSessionStore({ persistence });
  await writer.create({ id: 'issue-4586-cold', investigationMemory: { confirmedFacts: [] } });

  const store = new InvestigationSessionStore({ persistence });
  await Promise.all([
    store.updateMemory('issue-4586-cold', { confirmedFacts: [{ id: 'cold-A' }] }),
    store.updateMemory('issue-4586-cold', { confirmedFacts: [{ id: 'cold-B' }] }),
  ]);

  assert.deepEqual(ids((await store.get('issue-4586-cold')).investigationMemory.confirmedFacts), ['cold-A', 'cold-B']);
  const reloaded = await new InvestigationSessionStore({ persistence }).get('issue-4586-cold');
  assert.deepEqual(ids(reloaded.investigationMemory.confirmedFacts), ['cold-A', 'cold-B']);
});

test('#4586 a failed memory write releases the per-session serialization lane', async () => {
  let fail = false;
  const durable = new Map();
  const persistence = {
    async save(session) {
      if (fail) throw new Error('storage unavailable');
      durable.set(session.id, structuredClone(session));
    },
    async load(id) {
      const value = durable.get(id);
      return value ? structuredClone(value) : null;
    },
  };
  const store = new InvestigationSessionStore({ persistence });
  await store.create({ id: 'issue-4586-retry' });
  fail = true;
  await assert.rejects(
    store.updateMemory('issue-4586-retry', { confirmedFacts: [{ id: 'lost' }] }),
    /storage unavailable/,
  );
  fail = false;
  await store.updateMemory('issue-4586-retry', { confirmedFacts: [{ id: 'kept' }] });

  assert.deepEqual(ids((await store.get('issue-4586-retry')).investigationMemory.confirmedFacts), ['kept']);
});

test('#4586 different session IDs are not globally serialized', async () => {
  let releaseA;
  let enteredA;
  const gateA = new Promise((resolve) => { releaseA = resolve; });
  const aEntered = new Promise((resolve) => { enteredA = resolve; });
  const persistence = {
    async save(session) {
      const facts = session.investigationMemory?.confirmedFacts ?? [];
      if (session.id === 'issue-4586-independent-A' && facts.some((row) => row.id === 'hold-A')) {
        enteredA();
        await gateA;
      }
    },
  };
  const store = new InvestigationSessionStore({ persistence });
  await store.create({ id: 'issue-4586-independent-A' });
  await store.create({ id: 'issue-4586-independent-B' });

  const first = store.updateMemory('issue-4586-independent-A', { confirmedFacts: [{ id: 'hold-A' }] });
  await aEntered;
  const second = store.updateMemory('issue-4586-independent-B', { confirmedFacts: [{ id: 'free-B' }] });
  await completesWithin(second, 100);

  releaseA();
  await first;
  assert.deepEqual(ids((await store.get('issue-4586-independent-B')).investigationMemory.confirmedFacts), ['free-B']);
});
