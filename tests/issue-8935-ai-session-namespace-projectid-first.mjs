// Issue #8935 regression: the AiSession default conversation store must key the
// localStorage namespace on the *distinct* `projectId` scope first, not on
// `binaryHash`. The binary-first pick made two different projects that analyze
// the same binary share one transcript bucket, so saving A's chat and then
// opening a session for B restored A's transcript into B. `binaryHash` stays the
// fallback when there is no project, and `'default'` when there is neither.
// Legacy binary-only buckets are deliberately NOT auto-migrated into a
// project-bound namespace: without a trustworthy originating project identity,
// copying that history could recreate the cross-project leak this issue fixes.
import assert from 'node:assert/strict';
import test from 'node:test';

import { AiSession } from '../js/ai/ui/session.js';

function withMemoryLocalStorage(fn) {
  const data = new Map();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k) => (data.has(k) ? data.get(k) : null),
      setItem: (k, v) => data.set(k, String(v)),
      removeItem: (k) => data.delete(k),
    },
  });
  try { return fn(data); } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
}

function sessionFor(localContext) {
  return new AiSession({ engine: { localContext }, storage: undefined });
}

function saveChat(session, text) {
  session.current.turns.push({ role: 'user', text, status: 'done', at: Date.now() });
  session.current.updatedAt = Date.now();
  session.flushSave();
}

function transcriptHas(session, needle) {
  return (session.conversations || []).some((c) => JSON.stringify(c).includes(needle));
}

test('#8935 distinct projects sharing a binaryHash do not alias into one transcript bucket', () => {
  withMemoryLocalStorage(() => {
    const a = sessionFor({ binaryHash: 'samehash', projectId: 'proj-A' });
    assert.equal(a.namespace, 'proj-A', 'projectId must win over binaryHash');
    saveChat(a, 'A secret investigation');

    const b = sessionFor({ binaryHash: 'samehash', projectId: 'proj-B' });
    assert.equal(b.namespace, 'proj-B', 'the second project gets its own namespace');
    assert.equal(transcriptHas(b, 'A secret investigation'), false, 'B must not restore A transcript');
  });
});

test('#8935 a fresh session in the same project still sees that project transcript', () => {
  withMemoryLocalStorage(() => {
    const a = sessionFor({ binaryHash: 'samehash', projectId: 'proj-A' });
    saveChat(a, 'persisted A note');
    const a2 = sessionFor({ binaryHash: 'samehash', projectId: 'proj-A' });
    assert.equal(a2.namespace, 'proj-A');
    assert.equal(transcriptHas(a2, 'persisted A note'), true, 'same project must round-trip its own transcript');
  });
});

test('#8935 binaryHash is still the fallback namespace when no projectId is present', () => {
  withMemoryLocalStorage(() => {
    const a = sessionFor({ binaryHash: 'onlybinary', projectId: null });
    assert.equal(a.namespace, 'onlybinary', 'without a project, binaryHash keeps separating by image');
    const b = sessionFor({ binaryHash: null, projectId: null });
    assert.equal(b.namespace, 'default', 'without either, the shared default bucket is preserved');
  });
});

test('#8935 legacy binary-only history is not auto-migrated into a project-bound namespace', () => {
  withMemoryLocalStorage(() => {
    const legacy = sessionFor({ binaryHash: 'samehash', projectId: null });
    assert.equal(legacy.namespace, 'samehash');
    saveChat(legacy, 'legacy binary-only transcript');

    const project = sessionFor({ binaryHash: 'samehash', projectId: 'proj-A' });
    assert.equal(project.namespace, 'proj-A');
    assert.equal(
      transcriptHas(project, 'legacy binary-only transcript'),
      false,
      'a project-bound session must not import an unscoped legacy binary transcript',
    );

    const legacyAgain = sessionFor({ binaryHash: 'samehash', projectId: null });
    assert.equal(
      transcriptHas(legacyAgain, 'legacy binary-only transcript'),
      true,
      'legacy history remains available only to the binary-only fallback scope',
    );
  });
});
