import assert from 'node:assert/strict';
import { ChangeLog } from '../../../js/collaboration/index.js';
import { applyRemoteEnvelopeQueued } from '../../../js/collaboration/remote-delivery.js';
import { RemoteCollaborationGate, createRemoteCollaborationEnvelope } from '../../../js/collaboration/remote-authority.js';

function gate() {
  return new RemoteCollaborationGate({
    projectIdentity: 'project:integrity',
    binaryIdentity: 'binary:integrity',
    sessionIdentity: 'session:integrity',
    allowedActors: { alice: ['*'] },
  });
}

function envelope() {
  return createRemoteCollaborationEnvelope({
    projectIdentity: 'project:integrity',
    binaryIdentity: 'binary:integrity',
    sessionIdentity: 'session:integrity',
    actorIdentity: 'alice',
    deviceIdentity: 'device:alice',
    messageId: 'message:integrity',
    sequence: 1,
    operations: [{ targetEntityId: 'entity:1', factKind: 'name', action: 'set', payload: 'original' }],
    transportProof: { authenticated: true, confidentiality: 'verified', integrity: 'verified', proofIdentity: 'tls:integrity' },
    egress: { userAuthorized: true },
  });
}

const valid = envelope();
assert.deepEqual(gate().validate(valid), { ok: true });

const changedPayload = structuredClone(valid);
changedPayload.operations[0].payload = 'tampered';
assert.deepEqual(gate().validate(changedPayload), { ok: false, reason: 'remote-envelope-identity-mismatch' });

const changedMessage = structuredClone(valid);
changedMessage.messageId = 'message:forged';
assert.equal(
  applyRemoteEnvelopeQueued(
    new ChangeLog({ projectIdentity: 'project:integrity', binaryIdentity: 'binary:integrity', allowRemote: true, authorizedAuthors: ['alice'] }),
    gate(),
    changedMessage,
  ).reason,
  'remote-envelope-identity-mismatch',
);

console.log('[phase12] remote envelope identity integrity tests passed');
