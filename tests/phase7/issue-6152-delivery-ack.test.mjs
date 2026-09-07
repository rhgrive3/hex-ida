import assert from 'node:assert/strict';
import test from 'node:test';

import { ChangeLog } from '../../js/collaboration/index.js';
import { RemoteCollaborationChannel, RemoteCollaborationGate } from '../../js/collaboration/remote-authority.js';

function channelWith(transportResult) {
  const gate = new RemoteCollaborationGate({
    projectIdentity: 'project-6152',
    sessionIdentity: 'session-6152',
    allowedActors: { actor: ['write'] },
    verifyTransportProof: () => true,
  });
  const snapshot = Object.freeze({ envelopeId: 'envelope-6152' });
  // Keep the fixture focused on Channel's delivery acknowledgement contract;
  // envelope validation itself is covered by the collaboration gate tests.
  gate.validate = () => ({ ok: true });
  gate.validatedSnapshot = () => snapshot;
  const log = new ChangeLog({ projectIdentity: 'project-6152' });
  const transport = { send: async (envelope) => {
    assert.equal(envelope, snapshot);
    return transportResult;
  } };
  return new RemoteCollaborationChannel({ gate, log, transport });
}

test('issue-6152: verification-only transport result is never reported as sent', async () => {
  const channel = channelWith({
    status: 'verified-and-authorized-for-channel-send',
    envelopeId: 'envelope-6152',
  });
  const result = await channel.send({ envelopeId: 'caller-envelope' });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'remote-transport-delivery-unconfirmed');
  assert.equal(result.envelopeId, 'envelope-6152');
});

test('issue-6152: only matching delivery acknowledgement reports sent', async () => {
  const delivered = await channelWith({
    status: 'sent',
    envelopeId: 'envelope-6152',
  }).send({ envelopeId: 'caller-envelope' });
  assert.deepEqual(delivered, { status: 'sent', envelopeId: 'envelope-6152' });

  const mismatched = await channelWith({
    status: 'sent',
    envelopeId: 'different-envelope',
  }).send({ envelopeId: 'caller-envelope' });
  assert.equal(mismatched.status, 'rejected');
  assert.equal(mismatched.reason, 'remote-transport-delivery-unconfirmed');
});
