import assert from 'node:assert/strict';
import {
  RemoteCollaborationGate,
  createRemoteCollaborationEnvelope,
} from '../../../js/collaboration/remote-authority.js';

const envelopeBase = {
  projectIdentity: 'project:strict',
  binaryIdentity: 'binary:strict',
  sessionIdentity: 'session:strict',
  actorIdentity: 'alice',
  deviceIdentity: 'device:alice',
  messageId: 'message:strict',
  sequence: 1,
  operations: [{
    targetEntityId: 'entity:1',
    factKind: 'name',
    action: 'set',
    payload: 'value',
  }],
};

const invalidIdentities = [
  { structured: true },
  ['alias'],
  7,
  true,
];

for (const [field, code] of [
  ['projectIdentity', 'remote-project-identity-required'],
  ['binaryIdentity', 'remote-binary-identity-invalid'],
  ['sessionIdentity', 'remote-session-identity-required'],
  ['actorIdentity', 'remote-actor-identity-required'],
  ['deviceIdentity', 'remote-device-identity-required'],
  ['messageId', 'remote-message-id-required'],
]) {
  for (const value of invalidIdentities) {
    assert.throws(
      () => createRemoteCollaborationEnvelope({ ...envelopeBase, [field]: value }),
      (error) => error instanceof TypeError && error.message === code,
      `${field} must reject non-string authority identity`,
    );
  }
  assert.throws(
    () => createRemoteCollaborationEnvelope({ ...envelopeBase, [field]: '   ' }),
    (error) => error instanceof TypeError && error.message === code,
    `${field} must reject blank authority identity`,
  );
}

const canonicalEnvelope = createRemoteCollaborationEnvelope({
  ...envelopeBase,
  projectIdentity: '  project:strict  ',
  binaryIdentity: '  binary:strict  ',
  sessionIdentity: '  session:strict  ',
  actorIdentity: '  alice  ',
  deviceIdentity: '  device:alice  ',
  messageId: '  message:strict  ',
});
assert.equal(canonicalEnvelope.projectIdentity, 'project:strict');
assert.equal(canonicalEnvelope.binaryIdentity, 'binary:strict');
assert.equal(canonicalEnvelope.sessionIdentity, 'session:strict');
assert.equal(canonicalEnvelope.actorIdentity, 'alice');
assert.equal(canonicalEnvelope.deviceIdentity, 'device:alice');
assert.equal(canonicalEnvelope.messageId, 'message:strict');
assert.equal(canonicalEnvelope.operations[0].projectIdentity, 'project:strict');
assert.equal(canonicalEnvelope.operations[0].binaryIdentity, 'binary:strict');
assert.equal(canonicalEnvelope.operations[0].authorIdentity, 'alice');
assert.equal(canonicalEnvelope.operations[0].deviceIdentity, 'device:alice');

const gateBase = {
  projectIdentity: 'project:strict',
  binaryIdentity: 'binary:strict',
  sessionIdentity: 'session:strict',
  allowedActors: { alice: ['*'] },
  verifyTransportProof: () => true,
  transportVerifierIdentity: 'transport:strict',
};

for (const [field, code] of [
  ['projectIdentity', 'remote-gate-project-required'],
  ['binaryIdentity', 'remote-gate-binary-invalid'],
  ['sessionIdentity', 'remote-gate-session-required'],
  ['transportVerifierIdentity', 'remote-gate-transport-verifier-identity-invalid'],
]) {
  for (const value of invalidIdentities) {
    assert.throws(
      () => new RemoteCollaborationGate({ ...gateBase, [field]: value }),
      (error) => error instanceof TypeError && error.message === code,
      `${field} must reject non-string gate authority identity`,
    );
  }
  assert.throws(
    () => new RemoteCollaborationGate({ ...gateBase, [field]: '   ' }),
    (error) => error instanceof TypeError && error.message === code,
    `${field} must reject blank gate authority identity`,
  );
}

const canonicalGate = new RemoteCollaborationGate({
  ...gateBase,
  projectIdentity: '  project:strict  ',
  binaryIdentity: '  binary:strict  ',
  sessionIdentity: '  session:strict  ',
  transportVerifierIdentity: '  transport:strict  ',
});
assert.equal(canonicalGate.projectIdentity, 'project:strict');
assert.equal(canonicalGate.binaryIdentity, 'binary:strict');
assert.equal(canonicalGate.sessionIdentity, 'session:strict');
assert.equal(canonicalGate.transportVerifierIdentity, 'transport:strict');

assert.throws(
  () => canonicalGate.revoke(['alice']),
  (error) => error instanceof TypeError && error.message === 'remote-revoke-actor-required',
);
canonicalGate.revoke('  bob  ');
assert.deepEqual(canonicalGate.snapshot().revokedActors, ['bob']);

console.log('[phase12] remote collaboration authority identity #3619 tests passed');
