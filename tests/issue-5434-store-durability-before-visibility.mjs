// Regression for #5434: InvestigationSessionStore create()/update() must not
// expose in-memory state for a write that persistence rejected.
import assert from 'node:assert/strict';
import { InvestigationSessionStore } from '../js/ai/session-core/index.js';

// 1. A failed create leaves no in-memory ghost.
{
  const store = new InvestigationSessionStore({ persistence: { async save() { throw new Error('disk unavailable'); }, async load() { return null; } } });
  await assert.rejects(store.create({ id: 's1', goal: 'audit' }), /disk unavailable/);
  const visible = await store.get('s1');
  assert.equal(visible, null, 'a failed create must not remain visible in memory');
}

// 2. A failed update keeps the previous canonical state visible.
{
  let fail = false;
  const durable = new Map();
  const store = new InvestigationSessionStore({ persistence: {
    async save(session) { if (fail) throw new Error('temporary save failure'); durable.set(session.id, structuredClone(session)); },
    async load(id) { return durable.get(id) || null; },
  } });
  await store.create({ id: 's2', goal: 'old' });
  fail = true;
  await assert.rejects(store.update('s2', { goal: 'new' }), /temporary save failure/);
  fail = false;
  const visible = await store.get('s2');
  assert.equal(visible.goal, 'old', 'the previous state stays canonical after a rejected write');
  const retried = await store.update('s2', { goal: 'new' });
  assert.equal(retried.goal, 'new', 'a retry after recovery succeeds');
  assert.equal(durable.get('s2').goal, 'new');
}

// 3. The happy path keeps returning the live session object identity.
{
  const store = new InvestigationSessionStore({ persistence: { async save() {}, async load() { return null; } } });
  const created = await store.create({ id: 's3', goal: 'live' });
  const updated = await store.update('s3', { summary: 'updated' });
  assert.equal(updated.goal, 'live');
  assert.equal(updated.summary, 'updated');
  const fetched = await store.get('s3');
  assert.equal(fetched.summary, 'updated');
}

console.log('issue #5434 store durability-before-visibility regressions PASS');
