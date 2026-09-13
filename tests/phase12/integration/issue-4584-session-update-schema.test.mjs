import assert from 'node:assert/strict';
import test from 'node:test';

import { InvestigationSessionStore } from '../../../js/ai/session-core/index.js';

function memoryPersistence() {
  const durable = new Map();
  return {
    durable,
    persistence: {
      async save(session) { durable.set(session.id, structuredClone(session)); },
      async load(id) {
        const value = durable.get(id);
        return value ? structuredClone(value) : null;
      },
    },
  };
}

function assertCanonicalCollections(session) {
  for (const key of ['messages', 'pinnedEvidence', 'hypotheses', 'confirmedFindings', 'rejectedHypotheses', 'proposedActions']) {
    assert.equal(Array.isArray(session[key]), true, `${key} must remain an array after update()`);
  }
}

test('#4584 update re-applies the canonical session schema before persistence', async () => {
  const storage = memoryPersistence();
  const store = new InvestigationSessionStore({ persistence: storage.persistence });
  const session = await store.create({
    id: 'issue-4584-malformed-patch',
    mode: 'agent',
    style: 'beginner',
    scope: 'binary',
    effectiveScope: 'function',
    messages: [{ role: 'user', content: 'keep canonical shape' }],
    pinnedEvidence: ['ev-1'],
    hypotheses: [{ id: 'h-1' }],
    confirmedFindings: [{ id: 'e-1' }],
    rejectedHypotheses: [{ id: 'h-old' }],
    proposedActions: [{ id: 'p-1' }],
  });
  const createdAt = session.createdAt;

  const updated = await store.update(session.id, {
    mode: 'unsupported-mode',
    style: 'unsupported-style',
    scope: 'unsupported-scope',
    effectiveScope: 'unsupported-effective-scope',
    messages: 'not-an-array',
    pinnedEvidence: { id: 'not-an-array' },
    hypotheses: 1,
    confirmedFindings: false,
    rejectedHypotheses: { nope: true },
    proposedActions: 'not-an-array',
  });

  assert.equal(updated.mode, 'chat');
  assert.equal(updated.style, 'analyst');
  assert.equal(updated.scope, 'auto');
  assert.equal(updated.effectiveScope, null);
  assertCanonicalCollections(updated);
  assert.equal(updated.createdAt, createdAt, 'update must preserve the original creation timestamp');

  const durable = storage.durable.get(session.id);
  assert.equal(durable.mode, 'chat');
  assert.equal(durable.style, 'analyst');
  assert.equal(durable.scope, 'auto');
  assert.equal(durable.effectiveScope, null);
  assertCanonicalCollections(durable);

  const reloaded = await new InvestigationSessionStore({ persistence: storage.persistence }).get(session.id);
  assertCanonicalCollections(reloaded);

  const appended = await store.appendMessage(session.id, { role: 'user', content: 'still works' });
  assert.equal(appended.messages.length, 1);
  assert.equal(appended.messages[0].content, 'still works');
  assertCanonicalCollections(storage.durable.get(session.id));
});

test('#4584 valid partial updates retain existing normalization and binary identity synchronization', async () => {
  const storage = memoryPersistence();
  const store = new InvestigationSessionStore({ persistence: storage.persistence });
  const session = await store.create({
    id: 'issue-4584-valid-patch',
    mode: 'agent',
    style: 'beginner',
    scope: 'project',
    messages: [{ role: 'user', content: 'before' }],
    pinnedEvidence: ['ev-1'],
  });

  const updated = await store.update(session.id, {
    goal: 'updated goal',
    messages: [{ role: 'assistant', content: 'after' }],
    pinnedEvidence: ['ev-1', 'ev-1', 'ev-2'],
    binaryIdentity: { id: 'content:abcdef', kind: 'content', confidence: 'strong' },
  });

  assert.equal(updated.mode, 'agent');
  assert.equal(updated.style, 'beginner');
  assert.equal(updated.scope, 'project');
  assert.equal(updated.goal, 'updated goal');
  assert.equal(updated.messages.length, 1);
  assert.equal(updated.messages[0].content, 'after');
  assert.deepEqual(updated.pinnedEvidence, ['ev-1', 'ev-2']);
  assert.equal(updated.binaryId, 'content:abcdef');
  assert.equal(updated.binaryIdentity.id, 'content:abcdef');
});
