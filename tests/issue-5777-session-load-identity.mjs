// Regression for #5777: InvestigationSessionStore.get() adopted any truthy
// persistence record without checking that the record's own id equals the
// lookup key, so load('session-A') could cache and return session-B's record —
// aliasing another session's binary/project/conversation bindings onto the
// requested id and persisting edits under the wrong id. The mismatch now fails
// closed as not-found.
import assert from 'node:assert/strict';
import { InvestigationSessionStore } from '../js/ai/session-core/index.js';

{
  const store = new InvestigationSessionStore({
    persistence: {
      async load(id) {
        return id === 'session-A'
          ? { id: 'session-B', goal: 'B investigation', binaryId: 'binary-B', projectId: 'project-B' }
          : null;
      },
      async save() {},
    },
  });
  const session = await store.get('session-A');
  assert.equal(session, null, 'a record whose id differs from the lookup key must not be adopted');
  assert.equal(store.sessions.get('session-A'), undefined, 'the corrupted record must not be cached under the requested id');

  const updated = await store.update('session-A', { goal: 'updated-via-A' });
  assert.equal(updated, null, 'updates must not resurrect the mismatched record');
}

{
  const saved = [];
  const store = new InvestigationSessionStore({
    persistence: {
      async load(id) {
        return id === 'session-A'
          ? { id: 'session-A', goal: 'A investigation', binaryId: 'binary-A' }
          : null;
      },
      async save(session) { saved.push(session); },
    },
  });
  const session = await store.get('session-A');
  assert.equal(session.id, 'session-A', 'matching identities keep loading normally');
  assert.equal(session.goal, 'A investigation');

  const updated = await store.update('session-A', { goal: 'updated-via-A' });
  assert.equal(updated.goal, 'updated-via-A');
  assert.equal(saved.at(-1).id, 'session-A', 'persisted identity stays the requested one');
}

{
  const store = new InvestigationSessionStore({
    persistence: {
      async load(id) {
        return id === 'session-A'
          ? { goal: 'record without its own id' }
          : null;
      },
      async save() {},
    },
  });
  const session = await store.get('session-A');
  assert.equal(session, null, 'a record without its own id cannot claim the lookup identity');
}
