/**
 * Issue #5257 regression: `RemoteCollaborationGate` kept every accepted
 * messageId/envelopeId in `seenMessages`/`seenEnvelopeIds` forever, so retained
 * heap grew without bound for the whole session. The gate must keep replay
 * authority (duplicate/replay rejection, per-actor strict monotonic sequence
 * floor) while bounding retained identity state to a configured replay window.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { RemoteCollaborationGate, createRemoteCollaborationEnvelope, envelopeIdentity } from '../js/collaboration/remote-authority.js';

const PROJECT = 'project:5257';
const BINARY = 'binary:5257';
const SESSION = 'session:5257';

function makeGate(input = {}) {
  return new RemoteCollaborationGate({
    projectIdentity: PROJECT,
    binaryIdentity: BINARY,
    sessionIdentity: SESSION,
    allowedActors: { alice: ['*'], bob: ['*'] },
    verifyTransportProof: (proof) => proof.proofIdentity === 'tls:5257',
    ...input,
  });
}

function makeEnvelope(actor, sequence, messageId = `m-${actor}-${sequence}`) {
  return createRemoteCollaborationEnvelope({
    projectIdentity: PROJECT,
    binaryIdentity: BINARY,
    sessionIdentity: SESSION,
    actorIdentity: actor,
    deviceIdentity: `device:${actor}`,
    messageId,
    sequence,
    operations: [{ targetEntityId: 'entity:1', factKind: 'name', action: 'set', payload: 'p' }],
    transportProof: { authenticated: true, confidentiality: 'verified', integrity: 'verified', proofIdentity: 'tls:5257' },
    egress: { userAuthorized: true },
  });
}

test('#5257 long accept run keeps retained replay state within the configured window', () => {
  const gate = makeGate({ replayWindow: 64 });
  for (let i = 0; i < 400; i++) {
    assert.equal(gate.accept(makeEnvelope('alice', i)).status, 'accepted');
  }
  assert.equal(gate.seenMessages.size, 64, 'seenMessages must be bounded by the configured replay window');
  assert.equal(gate.seenEnvelopeIds.size, 64, 'seenEnvelopeIds must be bounded by the configured replay window');
  assert.equal(gate.snapshot().seenMessageCount, 64, 'snapshot seen count must follow the bounded lifecycle');
});

test('#5257 unconfigured gates carry an explicit bounded default window', () => {
  const gate = makeGate();
  assert.equal(Number.isSafeInteger(gate.replayWindow) && gate.replayWindow >= 1, true, 'gate must expose a positive bounded replay window');
  assert.equal(gate.snapshot().replayWindow, gate.replayWindow, 'snapshot must make the authority window explicit');
});

test('#5257 replay-window config is validated fail closed', () => {
  for (const bad of [0, -1, 1.5, 65537, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => makeGate({ replayWindow: bad }), (error) => error instanceof TypeError && error.message === 'remote-gate-replay-window-invalid', `replayWindow ${String(bad)} must be rejected`);
  }
});

test('#5257 in-window duplicate messageId and envelopeId are still rejected as replay', () => {
  const gate = makeGate({ replayWindow: 64 });
  const first = makeEnvelope('alice', 0);
  assert.equal(gate.accept(first).status, 'accepted');
  assert.equal(gate.accept(first).reason, 'remote-replay-or-duplicate', 'the exact accepted envelope cannot be replayed in-window');
  const reuse = makeEnvelope('alice', 5, 'm-alice-0');
  assert.deepEqual(gate.validate(reuse), { ok: false, reason: 'remote-replay-or-duplicate' });
});

test('#5257 cross-actor messageId collision is still rejected in-window', () => {
  const gate = makeGate({ replayWindow: 64 });
  assert.equal(gate.accept(makeEnvelope('alice', 0)).status, 'accepted');
  assert.deepEqual(gate.validate(makeEnvelope('bob', 7, 'm-alice-0')), { ok: false, reason: 'remote-replay-or-duplicate' });
});

test('#5257 per-actor sequence floor survives eviction and rejects stale replays', () => {
  const gate = makeGate({ replayWindow: 8 });
  let stale;
  for (let i = 0; i < 16; i++) {
    const envelope = makeEnvelope('alice', i);
    if (i === 2) stale = envelope;
    assert.equal(gate.accept(envelope).status, 'accepted');
  }
  assert.equal(gate.seenMessages.size, 8, 'identities older than the window must be reclaimed');
  const replay = structuredClone({ ...stale, messageId: 'renamed-after-eviction' });
  replay.envelopeId = envelopeIdentity(replay);
  assert.equal(gate.accept(replay).status, 'rejected', 'an evicted old-sequence envelope must stay rejected via the durable sequence floor');
  assert.equal(gate.accept(replay).reason, 'remote-stale-sequence', 'after eviction the monotonic sequence floor remains the replay authority');
});

test('#5257 multi-actor floors and in-window identities both hold after interleaving', () => {
  const gate = makeGate({ replayWindow: 16 });
  for (let i = 0; i < 40; i++) {
    assert.equal(gate.accept(makeEnvelope(i % 2 === 0 ? 'alice' : 'bob', Math.floor(i / 2))).status, 'accepted');
  }
  assert.ok(gate.seenMessages.size <= 16);
  assert.equal(gate.lastSequenceByActor.get('alice'), 19);
  assert.equal(gate.lastSequenceByActor.get('bob'), 19);
  assert.equal(gate.accept(makeEnvelope('alice', 11)).reason, 'remote-stale-sequence', 'each actor keeps its own durable replay authority');
  assert.equal(gate.accept(makeEnvelope('bob', 5)).reason, 'remote-stale-sequence');
});

test('#5257 snapshot seen count matches live tracked state', () => {
  const gate = makeGate({ replayWindow: 4 });
  for (let i = 0; i < 10; i++) assert.equal(gate.accept(makeEnvelope('alice', i)).status, 'accepted');
  const snap = gate.snapshot();
  assert.equal(snap.seenMessageCount, gate.seenMessages.size);
  assert.equal(snap.seenMessageCount, 4);
  assert.ok(Object.isFrozen(snap));
});
