import assert from 'node:assert/strict';
import test from 'node:test';

import { AIRuntime } from '../../../js/ai/runtime.js';
import { normalizeTurnRequest } from '../../../js/ai/validation.js';
import {
  createInvestigationSession,
  createProjectSessionPersistence,
  InvestigationSessionStore,
} from '../../../js/ai/session-core/index.js';

const BAD_IDS = [42, false, {}, { toString: () => 'session-A' }, ['session-A'], '', '   '];

function finalProvider() {
  return { nextTurn: async () => ({ type: 'final', answer: 'ok', evidenceIds: [], suggestedActions: [] }) };
}

test('#4456 structured store selectors cannot alias a canonical session', async () => {
  let loadCalls = 0;
  let deleteCalls = 0;
  const persistence = {
    async load() { loadCalls++; return { id: 'session-A', goal: 'should not load' }; },
    async delete() { deleteCalls++; },
  };
  const store = new InvestigationSessionStore({ persistence });
  const original = await store.create({ id: 'session-A', goal: 'original' });

  assert.equal(await store.get(['session-A']), null);
  assert.equal(await store.update(['session-A'], { goal: 'laundered' }), null);
  assert.equal(await store.updateMemory(['session-A'], { goal: 'laundered' }), null);
  assert.equal(await store.appendMessage(['session-A'], { role: 'user', content: 'laundered' }), null);
  assert.equal(await store.delete(['session-A']), false);
  assert.equal(store.register({ id: ['session-A'], goal: 'laundered' }), null);
  assert.equal(loadCalls, 0);
  assert.equal(deleteCalls, 0);
  assert.strictEqual(await store.get('session-A'), original);
});

test('#4456 explicit session IDs require a non-empty primitive string', () => {
  for (const id of BAD_IDS) {
    assert.throws(
      () => createInvestigationSession({ id }),
      /session id must be a non-empty string/i,
      `structured or empty id ${JSON.stringify(id)} must be rejected`,
    );
  }
  assert.equal(createInvestigationSession({ id: 'session-valid' }).id, 'session-valid');
});

test('#4456 request and runtime boundaries reject structured session IDs', async () => {
  for (const sessionId of BAD_IDS) {
    assert.throws(
      () => normalizeTurnRequest({ goal: 'continue', sessionId }),
      (error) => error?.type === 'invalid_model_output' && /session id must be a non-empty string/i.test(error.message),
      `request sessionId ${JSON.stringify(sessionId)} must be rejected`,
    );
  }
  assert.equal(normalizeTurnRequest({ goal: 'continue', sessionId: 'session-valid' }).sessionId, 'session-valid');

  const runtime = new AIRuntime({ context: {}, planner: false, provider: finalProvider() });
  await assert.rejects(
    () => runtime.turn({ goal: 'continue', sessionId: ['session-A'] }),
    (error) => error?.type === 'invalid_model_output' && /session id must be a non-empty string/i.test(error.message),
  );
  assert.equal(runtime.sessionStore.sessions.size, 0, 'rejected request must not create a session');
});

test('#4456 persistence selectors preserve exact string identity', async () => {
  const project = { findings: { investigationSessions: [{ id: 'session-A', goal: 'original' }] } };
  const persistence = createProjectSessionPersistence(project);

  assert.equal(await persistence.load(['session-A']), null);
  await persistence.delete(['session-A']);
  assert.equal(project.findings.investigationSessions.length, 1);
  await assert.rejects(
    () => persistence.save({ id: ['session-A'], goal: 'laundered' }),
    /session id must be a non-empty string/i,
  );
  assert.equal((await persistence.load('session-A')).goal, 'original');
});

test('#4456 valid session strings still persist, reload, update, and release', async () => {
  const project = { findings: { investigationSessions: [] } };
  const persistence = createProjectSessionPersistence(project);
  const store = new InvestigationSessionStore({ persistence });
  await store.create({ id: 'session-valid', goal: 'original' });

  const reloaded = new InvestigationSessionStore({ persistence });
  assert.equal((await reloaded.get('session-valid')).id, 'session-valid');
  assert.equal((await reloaded.update('session-valid', { goal: 'updated' })).goal, 'updated');
  assert.equal((await reloaded.get('session-valid')).goal, 'updated');
  assert.equal(await reloaded.delete('session-valid'), undefined);
  assert.equal(await persistence.load('session-valid'), null);

  const runtime = new AIRuntime({ context: {}, planner: false, provider: finalProvider() });
  await runtime.sessionStore.create({ id: 'session-valid', goal: 'original' });
  assert.equal(await runtime.releaseSession(['session-valid'], { deletePersisted: true }), false);
  assert.equal((await runtime.sessionStore.get('session-valid')).id, 'session-valid');
  assert.equal(await runtime.releaseSession('session-valid', { deletePersisted: true }), true);
  assert.equal(await runtime.sessionStore.get('session-valid'), null);
});

console.log('issue #4456 AI session ID type boundary: PASS');
