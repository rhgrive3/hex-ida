import assert from 'node:assert/strict';
import { stableDigest } from '../../../js/core/identity/index.js';
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

const secureEnvelope = createRemoteCollaborationEnvelope({
  ...envelopeBase,
  transportProof: {
    authenticated: true,
    confidentiality: 'verified',
    integrity: 'verified',
    proofIdentity: 'proof:strict',
  },
  egress: {
    userAuthorized: true,
    rawBinaryBytes: false,
    derivedDataOnly: true,
  },
});

function forgeRawIdentity(field, value) {
  const operation = { ...secureEnvelope.operations[0] };
  if (field === 'projectIdentity') operation.projectIdentity = value;
  if (field === 'binaryIdentity') operation.binaryIdentity = value;
  if (field === 'actorIdentity') operation.authorIdentity = value;
  if (field === 'deviceIdentity') operation.deviceIdentity = value;
  const raw = { ...secureEnvelope, [field]: value, operations: [operation] };
  const { envelopeId: _discardedEnvelopeId, ...payload } = raw;
  return { ...payload, envelopeId: `remote-envelope:${stableDigest(payload)}` };
}

const rawGate = new RemoteCollaborationGate(gateBase);
for (const [field, value, reason] of [
  ['projectIdentity', ['project:strict'], 'remote-project-identity-required'],
  ['binaryIdentity', ['binary:strict'], 'remote-binary-identity-invalid'],
  ['sessionIdentity', ['session:strict'], 'remote-session-identity-required'],
  ['actorIdentity', ['alice'], 'remote-actor-identity-required'],
  ['deviceIdentity', ['device:alice'], 'remote-device-identity-required'],
  ['messageId', ['message:strict'], 'remote-message-id-required'],
]) {
  assert.deepEqual(
    rawGate.validate(forgeRawIdentity(field, value)),
    { ok: false, reason },
    `${field} must reject structured raw authority identity before authorization`,
  );
  assert.deepEqual(
    rawGate.validate(forgeRawIdentity(field, '   ')),
    { ok: false, reason },
    `${field} must reject blank raw authority identity`,
  );
}
assert.deepEqual(
  rawGate.validate(secureEnvelope),
  { ok: true },
  'canonical primitive-string envelope must remain valid',
);

assert.throws(
  () => canonicalGate.revoke(['alice']),
  (error) => error instanceof TypeError && error.message === 'remote-revoke-actor-required',
);
canonicalGate.revoke('  bob  ');
assert.deepEqual(canonicalGate.snapshot().revokedActors, ['bob']);

console.log('[phase12] remote collaboration authority identity #3619 tests passed');
