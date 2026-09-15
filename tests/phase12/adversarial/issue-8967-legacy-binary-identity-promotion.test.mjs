/*
 * Issue #8967 — `sessionMatchesSnapshot` must not promote a legacy session's
 * `filename:slice` string binding to a strong current-binary identity by bare
 * string equality. `filename:slice` is not a collision-resistant witness: two
 * byte-different files with the same name/slice can exist, and cross-binary
 * investigation state (conversation history, confirmed findings) would then
 * hydrate into the wrong binary's namespace, silently rewriting the session
 * to the foreign strong identity via `sessionStore.update(...,{binaryIdentity})`.
 *
 * #6180 hardened the unbound-wildcard side (`sessionBindingId==null`); this
 * closes the asymmetric legacy↔strong side. Symmetric legacy↔legacy matches
 * remain allowed (no strong identity is being claimed as proven).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveBinaryIdentity } from '../../../js/ai/control/snapshot.js';
import { sessionMatchesSnapshot } from '../../../js/ai/control/runtime-support.js';

function makeSnapshot(local) {
  const identity = resolveBinaryIdentity(local);
  return {
    binaryId: identity?.id ?? null,
    binaryIdentity: identity ?? null,
    legacyBinaryId: identity?.legacyId ?? null,
    projectIdentity: null,
    runtimeSessionIdentity: null,
    runtimeSessionState: 'unknown',
  };
}

test('#8967: legacy filename:slice session does not auto-match a strong snapshot', () => {
  // A: prior investigation bound to a legacy `filename:slice` with no strong identity.
  const legacyA = { binaryId: 'same.bin:0', binaryIdentity: null };
  // B: a byte-different file, same filename + slice, but with a real content digest.
  const snapshotB = makeSnapshot({
    binaryFingerprint: { algorithm: 'sha256', hash: 'BBBB' },
    binaryId: 'same.bin:0',
    sliceIndex: 0,
  });
  assert.equal(snapshotB.binaryIdentity.confidence, 'strong', 'fixture must be a strong snapshot');
  assert.equal(sessionMatchesSnapshot(legacyA, snapshotB), false,
    'filename:slice equality is not a collision-resistant identity witness');
});

test('#8967: strong-vs-strong with same content still matches (regression guard)', () => {
  const identity = { id: 'content:AAAA', hash: 'AAAA', algorithm: 'sha256', confidence: 'strong', state: 'ready', kind: 'content-derived', legacyId: 'same.bin:0' };
  const strongA = { binaryId: identity.id, binaryIdentity: identity };
  const snapshotSame = { binaryId: identity.id, binaryIdentity: identity, legacyBinaryId: 'same.bin:0', projectIdentity: null };
  assert.equal(sessionMatchesSnapshot(strongA, snapshotSame), true);
});

test('#8967: strong-vs-strong with different content still rejects (regression guard)', () => {
  const snapshotB = makeSnapshot({ binaryFingerprint: { algorithm: 'sha256', hash: 'BBBB' }, binaryId: 'same.bin:0', sliceIndex: 0 });
  const strongA = { binaryId: 'content:AAAA', binaryIdentity: { id: 'content:AAAA', hash: 'AAAA', algorithm: 'sha256', confidence: 'strong', state: 'ready', kind: 'content-derived', legacyId: 'same.bin:0' } };
  assert.equal(sessionMatchesSnapshot(strongA, snapshotB), false);
});

test('#8967: completely unbound session still fails closed (#6180 regression)', () => {
  const unbound = { binaryId: null, binaryIdentity: null };
  const strongB = makeSnapshot({ binaryFingerprint: { algorithm: 'sha256', hash: 'BBBB' }, binaryId: 'same.bin:0', sliceIndex: 0 });
  assert.equal(sessionMatchesSnapshot(unbound, strongB), false,
    'unbound session must not wildcard-match a strong snapshot');
});

test('#8967: symmetric legacy-vs-legacy keeps compatibility (no strong promotion)', () => {
  const legacy = { binaryId: 'same.bin:0', binaryIdentity: null };
  // A legacy snapshot has no strong identity either: the fix targets asymmetric
  // weak-to-strong promotion only, so this compatibility stays true.
  const legacySnapshot = {
    binaryId: 'same.bin:0', binaryIdentity: null, legacyBinaryId: 'same.bin:0', projectIdentity: null,
    runtimeSessionIdentity: null, runtimeSessionState: 'unknown',
  };
  assert.equal(sessionMatchesSnapshot(legacy, legacySnapshot), true);
});

test('#8967: project + runtime bindings present on both sides do not rescue weak filename equality', () => {
  const legacy = {
    binaryId: 'same.bin:0',
    binaryIdentity: null,
    projectId: 'project-alpha',
    investigationMemory: { anchor: { runtimeSessionId: 'rt-1', runtimeSessionState: 'bound' } },
  };
  const snapshotB = {
    binaryId: 'content:BBBB',
    binaryIdentity: { id: 'content:BBBB', hash: 'BBBB', algorithm: 'sha256', confidence: 'strong', state: 'ready', kind: 'content-derived', legacyId: 'same.bin:0' },
    legacyBinaryId: 'same.bin:0',
    projectIdentity: 'project-alpha',
    runtimeSessionIdentity: 'rt-1',
    runtimeSessionState: 'bound',
  };
  assert.equal(sessionMatchesSnapshot(legacy, snapshotB), false,
    'project/runtime equality must not upgrade a filename:slice legacy binding to strong identity');
});
