import assert from 'node:assert/strict';
import test from 'node:test';
import { InvestigationSessionStore } from '../../../js/ai/session-core/index.js';
import { AIRuntime } from '../../../js/ai/runtime.js';

for (const key of ['confirmedFacts', 'activeHypotheses', 'rejectedHypotheses', 'unresolvedQuestions', 'userConstraints', 'importantPriorActions']) {
  test(`memory ${key} retains the newest snapshot for each identity`, async () => {
    const store = new InvestigationSessionStore();
    const old = Object.freeze({ id: 'same', summary: 'old', status: 'open', confidence: 0.2 });
    const fresh = Object.freeze({ id: 'same', summary: 'new', status: 'supported', confidence: 0.9 });
    const other = Object.freeze({ id: 'other', summary: 'unrelated' });
    const session = await store.create({ investigationMemory: { [key]: [old, other] } });
    for (let i = 0; i < 2; i++) await store.updateMemory(session.id, { [key]: [fresh] });
    const rows = (await store.get(session.id)).investigationMemory[key];
    assert.deepEqual(rows, [other, fresh]);
    assert.equal(old.summary, 'old');
  });
}

test('last occurrence wins within a batch and string lists stay unique', async () => {
  const store = new InvestigationSessionStore();
  const session = await store.create({});
  await store.updateMemory(session.id, {
    confirmedFacts: [{ id: 'x', summary: 'old' }, { id: 'x', summary: 'latest' }],
    userConstraints: ['a', 'b', 'a'],
    unresolvedQuestions: [{ claim: 'where?', detail: 'old' }, { claim: 'where?', detail: 'new' }],
  });
  const memory = (await store.get(session.id)).investigationMemory;
  assert.deepEqual(memory.confirmedFacts, [{ id: 'x', summary: 'latest' }]);
  assert.deepEqual(memory.userConstraints, ['b', 'a']);
  assert.deepEqual(memory.unresolvedQuestions, [{ claim: 'where?', detail: 'new' }]);
});

for (const [key, limit] of [['confirmedFacts', 64], ['activeHypotheses', 48], ['unresolvedQuestions', 32]]) {
  test(`${key} keeps refreshed oldest entries under its ${limit}-item bound`, async () => {
    const store = new InvestigationSessionStore();
    const current = Array.from({ length: limit }, (_, i) => ({ id: `i${i}`, summary: 'old' }));
    const session = await store.create({ investigationMemory: { [key]: current } });
    const refreshed = { id: 'i0', summary: 'refreshed' };
    await store.updateMemory(session.id, { [key]: [refreshed, { id: 'new', summary: 'new' }] });
    const rows = (await store.get(session.id)).investigationMemory[key];
    assert.equal(rows.length, limit);
    assert.deepEqual(rows.find((row) => row.id === 'i0'), refreshed);
    assert.equal(rows.some((row) => row.id === 'i1'), false);
    assert.equal(new Set(rows.map((row) => row.id)).size, limit);
  });
}

test('latest memory survives persistence reload', async () => {
  const records = new Map();
  const persistence = {
    async save(session) { records.set(session.id, structuredClone(session)); },
    async load(id) { return structuredClone(records.get(id) ?? null); },
  };
  const store = new InvestigationSessionStore({ persistence });
  const session = await store.create({ investigationMemory: { confirmedFacts: [{ id: 'fact', summary: 'old' }] } });
  await store.updateMemory(session.id, { confirmedFacts: [{ id: 'fact', summary: 'new' }] });
  const restored = await new InvestigationSessionStore({ persistence }).get(session.id);
  assert.deepEqual(restored.investigationMemory.confirmedFacts, [{ id: 'fact', summary: 'new' }]);
});

test('two production turns finalize updated hypothesis memory', async () => {
  let turns = 0;
  const runtime = new AIRuntime({
    context: { binaryId: 'issue-5995', currentAddress: 0x1000n },
    planner: false,
    provider: { async nextTurn() {
      turns++;
      return {
        type: 'final', answer: 'test', confidence: 0.2,
        evidenceIds: [], hypothesisIds: ['h1'], suggestedActions: [], followups: [],
        hypotheses: [{ id: 'h1', claim: turns === 1 ? 'initial' : 'revised', status: 'open', confidence: turns === 1 ? 0.2 : 0.4 }],
      };
    } },
  });
  const first = await runtime.turn({ goal: 'Explain the current function', mode: 'chat', scope: 'auto' });
  const second = await runtime.turn({ goal: 'Explain it again', mode: 'chat', scope: 'auto', sessionId: first.sessionId });
  assert.equal(turns, 2);
  assert.equal(second.sessionId, first.sessionId);
  const memory = (await runtime.sessionStore.get(first.sessionId)).investigationMemory.activeHypotheses;
  assert.equal(memory.length, 1);
  assert.equal(memory[0].claim, 'revised');
  assert.equal(memory[0].confidence, 0.4);
});
