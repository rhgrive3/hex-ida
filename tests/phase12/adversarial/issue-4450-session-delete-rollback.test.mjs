import assert from 'node:assert/strict';
import { InvestigationSessionStore } from '../../../js/ai/session-core/index.js';

// A persistence failure must not remove the still-durable record from the
// process-local cache or from list().
{
  const persisted = { id: 's1', binaryId: 'bin1', goal: 'keep me' };
  const persistence = {
    async load(id) { return id === 's1' ? { ...persisted } : null; },
    async delete() { throw new Error('storage unavailable'); },
  };
  const store = new InvestigationSessionStore({ persistence });
  const loaded = await store.get('s1');

  await assert.rejects(store.delete('s1'), /storage unavailable/);
  assert.equal(store.sessions.has('s1'), true, 'failed persistence delete keeps memory cache');
  assert.deepEqual(store.list().map((session) => session.id), ['s1'], 'failed delete keeps list visibility');
  assert.equal((await store.get('s1')).goal, loaded.goal, 'failed delete keeps the cached record readable');
}

// A successful persistent delete removes the cache only after the persistence
// operation returns, and an unloaded session still reaches persistence.
{
  const events = [];
  const persistence = {
    async delete(id) {
      events.push(['persistence-delete', id]);
    },
  };
  const store = new InvestigationSessionStore({ persistence });
  store.register({ id: 's2', binaryId: 'bin2', goal: 'remove me' });
  await store.delete('s2');
  await store.delete('s3');

  assert.deepEqual(events, [
    ['persistence-delete', 's2'],
    ['persistence-delete', 's3'],
  ], 'persistent deletion is attempted for loaded and unloaded sessions');
  assert.equal(store.sessions.has('s2'), false, 'successful delete removes the loaded cache');
  assert.equal(store.sessions.has('s3'), false, 'unloaded delete preserves existing semantics');
}

// Without a persistence delete hook, the in-memory store remains directly
// deletable.
{
  const store = new InvestigationSessionStore();
  store.register({ id: 's4', goal: 'memory only' });
  await store.delete('s4');
  assert.equal(store.sessions.has('s4'), false);
}

console.log('issue #4450 session delete rollback tests passed');
