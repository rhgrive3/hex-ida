// Regression for #5257: RemoteCollaborationGate retained every accepted
// messageId and envelopeId forever, so retained heap grew in proportion to
// accepted envelopes for the lifetime of the session (no delete/clear/TTL/
// LRU anywhere in the production path). Replay identity is now bounded by a
// configurable window (default 4096): identity older than the window is
// evicted, while the per-actor strict monotonic sequence authority
// (lastSequenceByActor) still rejects any replay that could reach the gate
// with an evicted identity — the duplicate-id Sets are a second layer, never
// the only line of defense.
import assert from 'node:assert/strict';
import { RemoteCollaborationGate, createRemoteCollaborationEnvelope } from '../../../js/collaboration/remote-authority.js';

const BASE = {
  projectIdentity: 'hex-project:p:5257',
  binaryIdentity: 'hex-binary:p:5257:arm64',
  targetEntityId: 'hex-entity:5257',
  factKind: 'comment',
};

function gateConfig(extra = {}) {
  return {
    projectIdentity: BASE.projectIdentity,
    binaryIdentity: BASE.binaryIdentity,
    sessionIdentity: 'hex-session:5257',
    allowedActors: { 'hex-actor:5257': ['*'] },
    transportVerifierIdentity: 'hex-oracle:5257',
    verifyTransportProof,
    ...extra,
  };
}

const verifyTransportProof = () => true;

function buildEnvelope(gate, { messageId, sequence }) {
  return createRemoteCollaborationEnvelope({
    ...BASE,
    sessionIdentity: 'hex-session:5257',
    actorIdentity: 'hex-actor:5257',
    deviceIdentity: 'hex-device:5257',
    messageId,
    sequence,
    operations: [{ ...BASE, operationId: `op:5257:${sequence}`, action: 'set', payload: `v-${sequence}`, causalParents: [] }],
    transportProof: { authenticated: true, confidentiality: 'verified', integrity: 'verified', proofIdentity: `proof:5257:${sequence}` },
    egress: { userAuthorized: true, rawBinaryBytes: false, derivedDataOnly: true },
  });
}

function makeAccepted(gate, { messageId, sequence }) {
  const envelope = buildEnvelope(gate, { messageId, sequence });
  const checked = gate.validate(envelope);
  if (!checked.ok) throw new Error(`fixture envelope rejected: ${checked.reason}`);
  return envelope;
}

// retained identity stays bounded across a long acceptance stream
{
  const gate = new RemoteCollaborationGate(gateConfig({ maxTrackedMessageIds: 64 }));
  for (let i = 1; i <= 10_000; i++) {
    const outcome = gate.accept(makeAccepted(gate, { messageId: `m-${i}`, sequence: i }));
    assert.equal(outcome.status, 'accepted', `envelope ${i} must be accepted`);
  }
  assert.equal(gate.seenMessages.size <= 64, true, 'message identity window stays bounded');
  assert.equal(gate.seenEnvelopeIds.size <= 64, true, 'envelope identity window stays bounded');
  assert.equal(gate.snapshot().seenMessageCount <= 64, true);
}

// duplicate id within the window is still rejected (protection preserved)
{
  const gate = new RemoteCollaborationGate(gateConfig({ maxTrackedMessageIds: 64 }));
  gate.accept(makeAccepted(gate, { messageId: 'dup', sequence: 1 }));
  const replay = gate.validate(buildEnvelope(gate, { messageId: 'dup', sequence: 2 }));
  assert.deepEqual(replay, { ok: false, reason: 'remote-replay-or-duplicate' },
    'duplicate messageId within the window is still authority-rejected');
}

// per-actor monotonic sequence still rejects stale replays (never weakened)
{
  const gate = new RemoteCollaborationGate(gateConfig({ maxTrackedMessageIds: 16 }));
  for (let i = 1; i <= 100; i++) gate.accept(makeAccepted(gate, { messageId: `m-${i}`, sequence: i }));
  const staleReplay = gate.validate(buildEnvelope(gate, { messageId: 'm-2', sequence: 2 }));
  assert.deepEqual(staleReplay, { ok: false, reason: 'remote-stale-sequence' },
    'sequence floor outlives identity eviction');
  // With a 16-id window, m-2 was evicted after 100 accepts; identity reuse
  // outside the window is therefore detectable only while tracked. The
  // sequence floor (O(actors) state) is the durable authority: it rejects
  // any old-sequence replay regardless of eviction.
  assert.equal(gate.seenMessages.has('m-2'), false, 'identity beyond the window is evicted');
}

// malformed window configuration fails closed
assert.throws(() => new RemoteCollaborationGate(gateConfig({ maxTrackedMessageIds: 0 })), TypeError);
assert.throws(() => new RemoteCollaborationGate(gateConfig({ maxTrackedMessageIds: 2_000_000 })), TypeError);

console.log('issue #5257 bounded remote replay identity regression: PASS');
