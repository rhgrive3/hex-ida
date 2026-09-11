import assert from 'node:assert/strict';
import {
  createProjectSessionPersistence,
  InvestigationSessionStore,
} from '../../../js/ai/session-core/index.js';

const clone = (value) => structuredClone(value);

// A persistence adapter can return a stale/corrupt record for a lookup key.
// The store must not turn that record into an alias for another session.
const mismatchedRecord = {
  id: 'session-b',
  binaryId: 'binary-b',
  binaryIdentity: { id: 'content:binary-b' },
  projectId: 'project-b',
  conversationId: 'conversation-b',
  goal: 'session B',
};
const persisted = new Map([
  ['session-a', mismatchedRecord],
  ['session-b', { ...mismatchedRecord, goal: 'canonical B' }],
  ['session-missing-id', { binaryId: 'binary-orphan', projectId: 'project-orphan' }],
  ['session-number-id', { id: 123, binaryId: 'binary-number', projectId: 'project-number' }],
  ['session-boxed-id', { id: new String('session-boxed-id'), binaryId: 'binary-boxed', projectId: 'project-boxed' }],
]);
const saves = [];
const adapter = {
  async load(id) { return persisted.has(id) ? clone(persisted.get(id)) : null; },
  async save(session) {
    saves.push(clone(session));
    persisted.set(session.id, clone(session));
  },
};

const store = new InvestigationSessionStore({ persistence: adapter });
assert.equal(await store.get('session-a'), null, 'a mismatched persisted id must fail closed');
assert.equal(store.sessions.has('session-a'), false, 'mismatched data must not be cached under the lookup key');
assert.equal(store.sessions.has('session-b'), false, 'mismatched data must not be cached under its returned id');
assert.equal(await store.update('session-a', { goal: 'mutate A' }), null, 'update must not adopt the mismatched record');
assert.equal(await store.appendMessage('session-a', { role: 'user', content: 'mutate A' }), null, 'append must not adopt the mismatched record');
assert.deepEqual(persisted.get('session-a'), mismatchedRecord, 'the lookup record must remain untouched');
assert.deepEqual(persisted.get('session-b'), { ...mismatchedRecord, goal: 'canonical B' }, 'the other session must remain untouched');
assert.equal(saves.length, 0, 'mismatched loads must not persist an alias update');

const missingIdStore = new InvestigationSessionStore({ persistence: adapter });
assert.equal(await missingIdStore.get('session-missing-id'), null, 'a record without an id must fail closed');
assert.equal(missingIdStore.sessions.has('session-missing-id'), false, 'missing-id data must not be cached');
assert.equal(await missingIdStore.get('session-number-id'), null, 'a non-string persisted id must fail closed');
assert.equal(await missingIdStore.get('session-boxed-id'), null, 'a boxed persisted id must fail closed');
assert.equal(missingIdStore.sessions.size, 0, 'invalid identity records must not be cached');

const project = {
  id: 'project-a',
  findings: {
    investigationSessions: [{
      id: 'session-a',
      binaryId: 'binary-a',
      binaryIdentity: { id: 'content:binary-a', confidence: 'strong' },
      projectId: 'project-a',
      conversationId: 'conversation-a',
      goal: 'session A',
    }],
  },
};
const projectStore = new InvestigationSessionStore({
  persistence: createProjectSessionPersistence(project),
});
const restored = await projectStore.get('session-a');
assert.equal(restored.id, 'session-a', 'a matching persisted id still restores');
assert.equal(restored.binaryId, 'binary-a');
assert.deepEqual(restored.binaryIdentity, { id: 'content:binary-a', confidence: 'strong' });
assert.equal(restored.projectId, 'project-a');
assert.equal(restored.conversationId, 'conversation-a');

const updated = await projectStore.update('session-a', { goal: 'updated A' });
assert.equal(updated.id, 'session-a');
assert.equal(project.findings.investigationSessions[0].id, 'session-a');
assert.equal(project.findings.investigationSessions[0].goal, 'updated A');
assert.equal(project.findings.investigationSessions[0].binaryId, 'binary-a');
assert.equal(project.findings.investigationSessions[0].projectId, 'project-a');

const appended = await projectStore.appendMessage('session-a', { role: 'user', content: 'keep A bound' });
assert.equal(appended.id, 'session-a');
assert.equal(project.findings.investigationSessions[0].id, 'session-a');
assert.equal(project.findings.investigationSessions[0].messages.at(-1).content, 'keep A bound');

console.log('[phase12] #4413 persisted session identity tests passed');
