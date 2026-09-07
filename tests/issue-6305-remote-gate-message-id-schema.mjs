/**
 * Issue #6305 regression: `RemoteCollaborationGate.validate()` must verify the
 * raw envelope `messageId` itself — required, primitive string, non-empty after
 * trim, bounded length — before using it as a replay key. A producer helper
 * cannot be assumed for untrusted remote ingress.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

async function setup() {
  const { RemoteCollaborationGate, createRemoteCollaborationEnvelope } = await import('../js/collaboration/remote-authority.js');
  const { stableDigest } = await import('../js/core/identity/index.js');

  const makeGate = () => new RemoteCollaborationGate({
    projectIdentity: 'project:6305',
    binaryIdentity: 'binary:6305',
    sessionIdentity: 'session:6305',
    allowedActors: { alice: ['*'] },
    verifyTransportProof: (proof) => proof.proofIdentity === 'tls:6305',
  });

  const makeEnvelope = (messageId) => createRemoteCollaborationEnvelope({
    projectIdentity: 'project:6305',
    binaryIdentity: 'binary:6305',
    sessionIdentity: 'session:6305',
    actorIdentity: 'alice',
    deviceIdentity: 'device:alice',
    messageId,
    sequence: 1,
    operations: [{ targetEntityId: 'entity:1', factKind: 'name', action: 'set', payload: 'p' }],
    transportProof: { authenticated: true, confidentiality: 'verified', integrity: 'verified', proofIdentity: 'tls:6305' },
    egress: { userAuthorized: true },
  });

  // Rebuild a raw envelope without going through the producer helper (which
  // would throw on a missing messageId), recomputing envelopeId so only the
  // messageId schema check can reject it.
  const rawWith = (messageId) => {
    const base = makeEnvelope('message:seed');
    const raw = structuredClone(base);
    if (messageId === undefined) delete raw.messageId;
    else raw.messageId = messageId;
    const { envelopeId: _old, ...payload } = raw;
    return { ...raw, envelopeId: `remote-envelope:${stableDigest(payload)}` };
  };

  return { RemoteCollaborationGate, createRemoteCollaborationEnvelope, makeGate, makeEnvelope, rawWith };
}

test('#6305 producer output still passes the gate', async () => {
  const { makeGate, makeEnvelope } = await setup();
  assert.deepEqual(makeGate().validate(makeEnvelope('message:ok')), { ok: true });
});

test('#6305 missing messageId is rejected', async () => {
  const { makeGate, rawWith } = await setup();
  assert.deepEqual(makeGate().validate(rawWith(undefined)), { ok: false, reason: 'remote-message-id-invalid' });
});

test('#6305 null / empty / whitespace messageId is rejected', async () => {
  const { makeGate, rawWith } = await setup();
  for (const bad of [null, '', '   ']) {
    assert.deepEqual(makeGate().validate(rawWith(bad)), { ok: false, reason: 'remote-message-id-invalid' });
  }
});

test('#6305 structured and non-string messageId values are rejected', async () => {
  const { makeGate, rawWith } = await setup();
  for (const bad of [{ id: 'm1' }, ['m1'], 7, true]) {
    assert.deepEqual(makeGate().validate(rawWith(bad)), { ok: false, reason: 'remote-message-id-invalid' });
  }
});

test('#6305 oversized messageId is rejected', async () => {
  const { makeGate, rawWith } = await setup();
  assert.deepEqual(makeGate().validate(rawWith('m'.repeat(513))), { ok: false, reason: 'remote-message-id-invalid' });
});

test('#6305 structured messageId never reaches seenMessages', async () => {
  const { makeGate, rawWith } = await setup();
  const gate = makeGate();
  const first = structuredClone(rawWith({ id: 'm1' }));
  const { envelopeId: _e1, ...p1 } = first;
  first.sequence = 1;
  delete first.envelopeId;
  first.envelopeId = `remote-envelope:${(await import('../js/core/identity/index.js')).stableDigest(p1)}`;
  gate.validate(first);
  gate.accept(first);
  assert.equal(gate.seenMessages.size, 0, 'rejected envelopes must not enter the replay set');
});

test('#6305 duplicate canonical string messageId still reports replay', async () => {
  const { makeGate, makeEnvelope } = await setup();
  const gate = makeGate();
  assert.equal(gate.accept(makeEnvelope('message:dup')).status, 'accepted');
  const replay = makeEnvelope('message:dup');
  const raw = structuredClone(replay);
  raw.sequence = 2;
  const { envelopeId: _old, ...payload } = raw;
  raw.envelopeId = `remote-envelope:${(await import('../js/core/identity/index.js')).stableDigest(payload)}`;
  assert.deepEqual(gate.validate(raw), { ok: false, reason: 'remote-replay-or-duplicate' });
});

test('#6305 structured messageId with same logical content cannot collide via Set identity', async () => {
  const { makeGate, rawWith } = await setup();
  const gate = makeGate();
  // Both structured messages are individually invalid, so the gate must fail
  // closed rather than register either as a replay key.
  const first = rawWith({ id: 'm1' });
  const second = structuredClone(rawWith({ id: 'm1' }));
  second.sequence = 2;
  const { stableDigest } = await import('../js/core/identity/index.js');
  for (const raw of [first, second]) {
    const { envelopeId: _old, ...payload } = raw;
    raw.envelopeId = `remote-envelope:${stableDigest(payload)}`;
  }
  assert.deepEqual(gate.validate(first), { ok: false, reason: 'remote-message-id-invalid' });
  assert.deepEqual(gate.validate(second), { ok: false, reason: 'remote-message-id-invalid' });
  assert.equal(gate.seenMessages.size, 0);
});
