import assert from 'node:assert/strict';

import { createTurnSnapshot, resolveBinaryIdentity } from '../../../js/ai/control/snapshot.js';
import { assertLiveBindingsUnchanged, sessionMatchesSnapshot } from '../../../js/ai/control/runtime-support.js';

function identity(binaryHash, binaryId) {
  return resolveBinaryIdentity({ binaryHash, binaryId });
}

// Structured hashes must never become a strong content-derived identity.
for (const value of [
  { sha256: 'aaa' },
  ['aaa'],
  true,
  123,
  new String('aaa'),
  '',
]) {
  const resolved = identity(value, 'legacy-A');
  assert.equal(resolved.confidence, 'weak');
  assert.equal(resolved.state, 'hash-unavailable');
  assert.equal(resolved.hash, null);
  assert.ok(!resolved.id.startsWith('content:'), `malformed hash was promoted: ${resolved.id}`);
}

const identityA = identity({ sha256: 'aaa' }, 'legacy-A');
const identityB = identity({ sha256: 'bbb' }, 'legacy-B');
assert.notEqual(identityA.id, identityB.id);
assert.notEqual(identityA.confidence, 'strong');
assert.notEqual(identityB.confidence, 'strong');

// The same fail-closed fallback must protect snapshot/session and live-turn boundaries.
const snapshotA = createTurnSnapshot({ binaryHash: { sha256: 'aaa' }, binaryId: 'legacy-A' });
const snapshotB = createTurnSnapshot({ binaryHash: { sha256: 'bbb' }, binaryId: 'legacy-B' });
assert.equal(sessionMatchesSnapshot({ binaryId: snapshotA.binaryId, binaryIdentity: snapshotA.binaryIdentity }, snapshotB), false);
assert.throws(
  () => assertLiveBindingsUnchanged({ binaryHash: { sha256: 'bbb' }, binaryId: 'legacy-B' }, snapshotA),
  /binary changed/i,
);

// Canonical primitive hashes and already validated explicit identities remain usable.
const canonical = identity('sha256:aaa', 'legacy-A');
assert.equal(canonical.id, 'content:sha256:aaa');
assert.equal(canonical.confidence, 'strong');
const explicit = resolveBinaryIdentity({
  binaryIdentity: {
    id: 'content:explicit', kind: 'content-derived', confidence: 'strong', state: 'ready', hash: 'sha256:explicit',
  },
});
assert.equal(explicit.id, 'content:explicit');
assert.equal(explicit.hash, 'sha256:explicit');

console.log('issue-6241-ai-snapshot-binary-identity: ok');
