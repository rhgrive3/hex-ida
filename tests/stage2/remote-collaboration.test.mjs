import assert from 'node:assert/strict';
import { ChangeLog } from '../../js/collaboration/index.js';
import {
  RemoteCollaborationChannel,
  RemoteCollaborationGate,
  createRemoteCollaborationEnvelope,
  remoteCollaborationSupport,
} from '../../js/collaboration/remote-authority.js';
import { applyRemoteEnvelopeQueued } from '../../js/collaboration/remote-delivery.js';
import { validatedCapabilityProofFixture } from './helpers/profile-proof-fixture.mjs';

function gate(overrides = {}) {
  return new RemoteCollaborationGate({
    projectIdentity: 'project:1',
    binaryIdentity: 'binary:1',
    sessionIdentity: 'collab-session:1',
    allowedActors: {
      alice: ['*'],
      bob: ['fact:name', 'action:set'],
      actionOnly: ['action:set'],
      factOnly: ['fact:name'],
      combined: ['fact:name:action:set'],
    },
    maxBatch: 8,
    maxMessageBytes: 65536,
    verifyTransportProof: (proof) => proof.proofIdentity === 'tls:test',
    transportVerifierIdentity: 'oracle:S2-P12-COLLAB-REMOTE:independent',
    ...overrides,
  });
}
function log() {
  return new ChangeLog({ projectIdentity: 'project:1', binaryIdentity: 'binary:1', allowRemote: true, authorizedAuthors: ['alice', 'bob', 'actionOnly', 'factOnly', 'combined'] });
}
function envelope({ actor = 'alice', device = `device:${actor}`, messageId, sequence, operations, projectIdentity = 'project:1', binaryIdentity = 'binary:1', rawBinaryBytes = false }) {
  return createRemoteCollaborationEnvelope({
    projectIdentity,
    binaryIdentity,
    sessionIdentity: 'collab-session:1',
    actorIdentity: actor,
    deviceIdentity: device,
    messageId,
    sequence,
    operations,
    transportProof: { authenticated: true, confidentiality: 'verified', integrity: 'verified', proofIdentity: 'tls:test' },
    egress: { userAuthorized: true, rawBinaryBytes, derivedDataOnly: !rawBinaryBytes },
  });
}

const remoteGate = gate();
const remoteLog = log();
const callerClaimed = envelope({ messageId: 'msg:caller-claimed', sequence: 1, operations: [{ targetEntityId: 'fn:claimed', factKind: 'name', action: 'set', payload: 'x' }] });
assert.equal(gate({ verifyTransportProof: null }).validate(callerClaimed).reason, 'remote-transport-proof-verifier-required');
assert.equal(gate({ verifyTransportProof: () => { throw new Error('verifier-failed'); } }).validate(callerClaimed).reason, 'remote-transport-proof-rejected');
const child = envelope({ messageId: 'msg:child', sequence: 1, operations: [{ operationId: 'op:child', targetEntityId: 'fn:1', factKind: 'type', action: 'set', payload: 'int', causalParents: ['op:parent'] }] });
const childResult = applyRemoteEnvelopeQueued(remoteLog, remoteGate, child);
assert.equal(childResult.status, 'accepted-with-pending-dependencies');
assert.deepEqual(childResult.unresolvedOperationIds, ['op:child']);

const parent = envelope({ messageId: 'msg:parent', sequence: 2, operations: [{ operationId: 'op:parent', targetEntityId: 'fn:1', factKind: 'name', action: 'set', payload: 'main' }] });
const parentResult = applyRemoteEnvelopeQueued(remoteLog, remoteGate, parent);
assert.equal(parentResult.status, 'applied');
assert.deepEqual(parentResult.unresolvedOperationIds, []);
assert.ok(remoteLog.appliedOperationIds().includes('op:child'));
assert.equal(applyRemoteEnvelopeQueued(remoteLog, remoteGate, parent).reason, 'remote-replay-or-duplicate');

const wrongProject = envelope({ messageId: 'msg:wrong-project', sequence: 3, projectIdentity: 'project:other', operations: [{ targetEntityId: 'fn:1', factKind: 'name', action: 'set', payload: 'x' }] });
assert.equal(applyRemoteEnvelopeQueued(remoteLog, remoteGate, wrongProject).reason, 'remote-wrong-project');
const raw = envelope({ messageId: 'msg:raw', sequence: 3, rawBinaryBytes: true, operations: [{ targetEntityId: 'fn:1', factKind: 'name', action: 'set', payload: 'x' }] });
assert.equal(applyRemoteEnvelopeQueued(remoteLog, remoteGate, raw).reason, 'remote-raw-binary-egress-forbidden');
remoteGate.revoke('alice');
const revoked = envelope({ messageId: 'msg:revoked', sequence: 3, operations: [{ targetEntityId: 'fn:1', factKind: 'name', action: 'set', payload: 'x' }] });
assert.equal(applyRemoteEnvelopeQueued(remoteLog, remoteGate, revoked).reason, 'remote-actor-revoked');

for (const actor of ['actionOnly', 'factOnly']) {
  const unauthorized = envelope({ actor, messageId: `msg:${actor}`, sequence: 1, operations: [{ targetEntityId: 'fn:auth', factKind: 'name', action: 'set', payload: 'x' }] });
  assert.equal(applyRemoteEnvelopeQueued(log(), gate(), unauthorized).reason, 'remote-operation-not-authorized', `${actor} must not be enough by itself`);
}
const combinedAllowed = envelope({ actor: 'combined', messageId: 'msg:combined', sequence: 1, operations: [{ targetEntityId: 'fn:auth', factKind: 'name', action: 'set', payload: 'x' }] });
assert.equal(applyRemoteEnvelopeQueued(log(), gate(), combinedAllowed).status, 'applied');

const envA = envelope({ messageId: 'msg:a', sequence: 1, operations: [{ operationId: 'op:a', targetEntityId: 'fn:2', factKind: 'name', action: 'set', payload: 'A' }] });
const envB = envelope({ actor: 'bob', device: 'device:b', messageId: 'msg:b', sequence: 1, operations: [{ operationId: 'op:b', targetEntityId: 'fn:2', factKind: 'name', action: 'set', payload: 'B' }] });
const logAB = log(), logBA = log(), gateAB = gate(), gateBA = gate();
assert.notEqual(applyRemoteEnvelopeQueued(logAB, gateAB, envA).status, 'rejected');
assert.notEqual(applyRemoteEnvelopeQueued(logAB, gateAB, envB).status, 'rejected');
assert.notEqual(applyRemoteEnvelopeQueued(logBA, gateBA, envB).status, 'rejected');
assert.notEqual(applyRemoteEnvelopeQueued(logBA, gateBA, envA).status, 'rejected');
assert.deepEqual(logAB.snapshot().facts, logBA.snapshot().facts);

const channelLog = log();
const channelGate = gate();
const channel = new RemoteCollaborationChannel({ gate: channelGate, log: channelLog, transport: { send: async () => {} } });
const channelChild = envelope({ messageId: 'channel-child', sequence: 1, operations: [{ operationId: 'channel:child', targetEntityId: 'fn:c', factKind: 'type', action: 'set', payload: 'int', causalParents: ['channel:parent'] }] });
const channelParent = envelope({ messageId: 'channel-parent', sequence: 2, operations: [{ operationId: 'channel:parent', targetEntityId: 'fn:c', factKind: 'name', action: 'set', payload: 'c' }] });
assert.equal(channel.receive(channelChild).status, 'accepted-with-pending-dependencies');
assert.equal(channel.receive(channelParent).status, 'applied');
assert.ok(channelLog.appliedOperationIds().includes('channel:child'), 'public channel receive must use queued causal delivery');

// A tombstone-protected operation already has all causal parents, but it cannot
// become valid until an explicit resurrection occurs. It must remain pending
// without making the drain loop spin or duplicating unresolved diagnostics.
const tombstoneLog = log();
const tombstoneGate = gate();
assert.equal(tombstoneLog.applyOperation({
  operationId: 'op:tombstone', projectIdentity: 'project:1', binaryIdentity: 'binary:1',
  targetEntityId: 'fn:tomb', factKind: 'name', action: 'remove', causalParents: [],
  provenance: { source: 'local' },
}).status, 'applied');
const blocked = envelope({
  messageId: 'msg:tombstone-blocked', sequence: 1,
  operations: [{ operationId: 'op:tombstone-blocked', targetEntityId: 'fn:tomb', factKind: 'name', action: 'set', payload: 'stale', causalParents: ['op:tombstone'] }],
});
const blockedResult = applyRemoteEnvelopeQueued(tombstoneLog, tombstoneGate, blocked);
assert.equal(blockedResult.status, 'accepted-with-pending-dependencies');
assert.deepEqual(blockedResult.unresolvedOperationIds, ['op:tombstone-blocked']);
assert.equal(tombstoneLog.snapshot().unresolved.filter((item) => item.operationId === 'op:tombstone-blocked').length, 1);
const unrelated = envelope({
  messageId: 'msg:after-tombstone', sequence: 2,
  operations: [{ operationId: 'op:after-tombstone', targetEntityId: 'fn:other', factKind: 'type', action: 'set', payload: 'int' }],
});
const afterBlocked = applyRemoteEnvelopeQueued(tombstoneLog, tombstoneGate, unrelated);
assert.equal(afterBlocked.status, 'accepted-with-pending-dependencies');
assert.deepEqual(afterBlocked.unresolvedOperationIds, ['op:tombstone-blocked']);
assert.equal(tombstoneLog.snapshot().unresolved.filter((item) => item.operationId === 'op:tombstone-blocked').length, 1, 'unrelated envelopes must not retry and duplicate permanently blocked operations');

const bigIntEnvelope = envelope({ messageId: 'msg:bigint', sequence: 1, operations: [{ targetEntityId: 'fn:3', factKind: 'type', action: 'set', payload: { value: 2n ** 63n } }] });
assert.doesNotThrow(() => gate().validate(bigIntEnvelope));

const arbitraryBooleanProof = {
  exactHead: true,
  replayTests: true,
  identityTests: true,
  authorizationTests: true,
  transportSecurityTests: true,
  privacyTests: true,
  convergenceTests: true,
  revocationTests: true,
  outOfOrderTests: true,
};
assert.equal(remoteCollaborationSupport({ gate: gate(), securityProfileId: 'arbitrary-profile', proof: arbitraryBooleanProof }).status, 'unsupported', 'caller-supplied profile labels and booleans cannot mint remote support');

const { proofs } = validatedCapabilityProofFixture();
const profileProof = proofs['S2-P12-COLLAB-REMOTE'];
const activeGate = gate();
assert.deepEqual(activeGate.validate(envelope({ messageId: 'msg:support-proof', sequence: 1, operations: [{ targetEntityId: 'fn:support', factKind: 'name', action: 'set', payload: 'support' }] })), { ok: true });
const collabProof = remoteCollaborationSupport({
  gate: activeGate,
  profileProof,
  expectedCommitSha: 'a'.repeat(40),
  expectedTreeSha: 'b'.repeat(40),
});
assert.equal(collabProof.status, 'supported-for-exact-security-profile');
assert.equal(collabProof.securityProfileId, 'collaboration:remote-security-v1');
assert.equal(remoteCollaborationSupport({ gate: gate(), proof: { exactHead: true } }).status, 'unsupported');
assert.equal(remoteCollaborationSupport({ gate: gate({ verifyTransportProof: () => true }), profileProof, expectedCommitSha: 'a'.repeat(40), expectedTreeSha: 'b'.repeat(40) }).status, 'unsupported', 'a verifier function without an active successful verification cannot promote support');
assert.equal(remoteCollaborationSupport({ gate: gate({ verifyTransportProof: () => true }), profileProof: { ...profileProof }, expectedCommitSha: 'a'.repeat(40), expectedTreeSha: 'b'.repeat(40) }).status, 'unsupported', 'copied profile evidence loses validator authority');
assert.equal(remoteCollaborationSupport({ gate: gate({ verifyTransportProof: () => true }), profileProof, expectedCommitSha: 'c'.repeat(40), expectedTreeSha: 'b'.repeat(40) }).status, 'unsupported', 'stale exact-head evidence cannot promote support');
assert.equal(remoteCollaborationSupport({ gate: gate(), profileProof, expectedCommitSha: 'a'.repeat(40), expectedTreeSha: 'b'.repeat(40) }).status, 'unsupported', 'canonical support requires an active transport proof verifier');
assert.equal(remoteCollaborationSupport({ gate: gate({ transportVerifierIdentity: 'oracle:other:independent' }), profileProof, expectedCommitSha: 'a'.repeat(40), expectedTreeSha: 'b'.repeat(40) }).status, 'unsupported', 'transport verifier identity must be bound to the validated profile oracle');
console.log('[stage2] remote collaboration security/reconnect tests passed');
