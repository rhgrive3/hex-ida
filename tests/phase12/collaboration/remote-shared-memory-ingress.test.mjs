import assert from 'node:assert/strict';
import { CHANGELOG_SCHEMA_VERSION, ChangeLog, createProjectOperation } from '../../../js/collaboration/index.js';
import { REMOTE_COLLAB_SCHEMA, RemoteCollaborationGate, applyRemoteEnvelope, createRemoteCollaborationEnvelope, envelopeIdentity } from '../../../js/collaboration/remote-authority.js';

const base = {
  projectIdentity: 'hex-project:sab', binaryIdentity: 'hex-binary:sab:x86_64',
  sessionIdentity: 'hex-session:sab', actorIdentity: 'hex-actor:sab', deviceIdentity: 'hex-device:sab',
};
const gate = () => new RemoteCollaborationGate({
  projectIdentity: base.projectIdentity, binaryIdentity: base.binaryIdentity, sessionIdentity: base.sessionIdentity,
  allowedActors: { [base.actorIdentity]: ['*'] }, verifyTransportProof: () => true, transportVerifierIdentity: 'oracle:sab',
});
function envelope(payload, sequence, messageId) {
  return createRemoteCollaborationEnvelope({
    ...base, messageId, sequence,
    operations: [{ targetEntityId: 'hex-entity:sab', factKind: 'comment', action: 'set', payload, causalParents: [] }],
    transportProof: { authenticated: true, confidentiality: 'verified', integrity: 'verified', proofIdentity: 'proof:sab' },
    egress: { userAuthorized: true, rawBinaryBytes: false, derivedDataOnly: true },
  });
}

function forgeRawEnvelope(payload, sequence, messageId) {
  const operation = createProjectOperation({
    targetEntityId: 'hex-entity:sab', factKind: 'comment', action: 'set', payload, causalParents: [],
    projectIdentity: base.projectIdentity, binaryIdentity: base.binaryIdentity,
    authorIdentity: base.actorIdentity, deviceIdentity: base.deviceIdentity,
    provenance: { source: 'collaborator', transport: 'remote', actorIdentity: base.actorIdentity, deviceIdentity: base.deviceIdentity },
  });
  const envelopeValue = {
    schemaVersion: REMOTE_COLLAB_SCHEMA,
    operationSchemaVersion: CHANGELOG_SCHEMA_VERSION,
    ...base, messageId, sequence,
    operations: [operation],
    transportProof: { authenticated: true, confidentiality: 'verified', integrity: 'verified', proofIdentity: 'proof:sab' },
    egress: { userAuthorized: true, rawBinaryBytes: false, derivedDataOnly: true },
  };
  return Object.freeze({ ...envelopeValue, envelopeId: envelopeIdentity(envelopeValue) });
}

if (typeof SharedArrayBuffer !== 'undefined') {
  const sab = new SharedArrayBuffer(1);
  const bytes = new Uint8Array(sab); bytes[0] = 1;
  const hostile = forgeRawEnvelope(bytes, 1, 'sab-view');
  const g = gate();
  const log = new ChangeLog({ projectIdentity: base.projectIdentity, binaryIdentity: base.binaryIdentity, allowRemote: true, authorizedAuthors: [base.actorIdentity] });
  assert.deepEqual(g.validate(hostile), { ok: false, reason: 'remote-envelope-shape-invalid' });
  assert.equal(applyRemoteEnvelope(log, g, hostile).status, 'rejected');
  bytes[0] = 2;
  assert.equal(log.snapshot().facts?.['hex-entity:sab\u0000comment'], undefined);

  const directSab = forgeRawEnvelope(sab, 2, 'sab-direct');
  assert.equal(gate().validate(directSab).reason, 'remote-envelope-shape-invalid');

  const dvSab = new SharedArrayBuffer(8);
  const dataView = new DataView(dvSab);
  const dvEnv = forgeRawEnvelope(dataView, 3, 'sab-dataview');
  assert.equal(gate().validate(dvEnv).reason, 'remote-envelope-shape-invalid');

  const mapEnv = forgeRawEnvelope(new Map([['bytes', new Uint8Array(new SharedArrayBuffer(1))]]), 4, 'sab-map');
  assert.equal(gate().validate(mapEnv).reason, 'remote-envelope-shape-invalid');

  const setEnv = forgeRawEnvelope(new Set([new Uint8Array(new SharedArrayBuffer(1))]), 5, 'sab-set');
  assert.equal(gate().validate(setEnv).reason, 'remote-envelope-shape-invalid');
}

const privateBytes = new Uint8Array(new ArrayBuffer(2));
privateBytes.set([7, 9]);
assert.throws(() => envelope(privateBytes, 6, 'arraybuffer-view'), /remote-raw-binary-egress-forbidden/);
const forgedPrivateBytes = forgeRawEnvelope(privateBytes, 6, 'arraybuffer-view-forged');
assert.equal(gate().validate(forgedPrivateBytes).reason, 'remote-raw-binary-egress-forbidden');
const forgedPrivateBuffer = forgeRawEnvelope(Buffer.from('deadbeef', 'hex'), 7, 'node-buffer-forged');
assert.equal(gate().validate(forgedPrivateBuffer).reason, 'remote-raw-binary-egress-forbidden');
const cleanEnvelope = createRemoteCollaborationEnvelope({
  ...base, messageId: 'arraybuffer-clean', sequence: 8,
  operations: [{ targetEntityId: 'hex-entity:sab', factKind: 'comment', action: 'set', payload: { confidence: 0.9, offsets: [7, 9] }, causalParents: [] }],
  transportProof: { authenticated: true, confidentiality: 'verified', integrity: 'verified', proofIdentity: 'proof:sab' },
  egress: { userAuthorized: true, rawBinaryBytes: false, derivedDataOnly: true },
});
const cleanGate = gate();
assert.equal(cleanGate.validate(cleanEnvelope).ok, true);
const cleanSnap = cleanGate.validatedSnapshot(cleanEnvelope);
assert.ok(cleanSnap);
assert.deepEqual(cleanSnap.operations[0].payload, { confidence: 0.9, offsets: [7, 9] });

console.log('[phase12] remote SAB ingress regression passed');
