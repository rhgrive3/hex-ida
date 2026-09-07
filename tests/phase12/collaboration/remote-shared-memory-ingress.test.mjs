import assert from 'node:assert/strict';
import { ChangeLog } from '../../../js/collaboration/index.js';
import { RemoteCollaborationGate, applyRemoteEnvelope, createRemoteCollaborationEnvelope } from '../../../js/collaboration/remote-authority.js';

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

if (typeof SharedArrayBuffer !== 'undefined') {
  const sab = new SharedArrayBuffer(1);
  const bytes = new Uint8Array(sab); bytes[0] = 1;
  const hostile = envelope(bytes, 1, 'sab-view');
  const g = gate();
  const log = new ChangeLog({ projectIdentity: base.projectIdentity, binaryIdentity: base.binaryIdentity, allowRemote: true, authorizedAuthors: [base.actorIdentity] });
  assert.deepEqual(g.validate(hostile), { ok: false, reason: 'remote-envelope-shape-invalid' });
  assert.equal(applyRemoteEnvelope(log, g, hostile).status, 'rejected');
  bytes[0] = 2;
  assert.equal(log.snapshot().facts?.['hex-entity:sab\u0000comment'], undefined);

  const directSab = envelope(sab, 2, 'sab-direct');
  assert.equal(gate().validate(directSab).reason, 'remote-envelope-shape-invalid');

  const dvSab = new SharedArrayBuffer(8);
  const dataView = new DataView(dvSab);
  const dvEnv = envelope(dataView, 3, 'sab-dataview');
  assert.equal(gate().validate(dvEnv).reason, 'remote-envelope-shape-invalid');

  const mapEnv = envelope(new Map([['bytes', new Uint8Array(new SharedArrayBuffer(1))]]), 4, 'sab-map');
  assert.equal(gate().validate(mapEnv).reason, 'remote-envelope-shape-invalid');

  const setEnv = envelope(new Set([new Uint8Array(new SharedArrayBuffer(1))]), 5, 'sab-set');
  assert.equal(gate().validate(setEnv).reason, 'remote-envelope-shape-invalid');
}

// Private non-shared bytes remain accepted.
const privateBytes = new Uint8Array(new ArrayBuffer(2));
privateBytes.set([7, 9]);
const clean = envelope(privateBytes, 6, 'arraybuffer-view');
const cleanGate = gate();
assert.equal(cleanGate.validate(clean).ok, true);
const cleanSnap = cleanGate.validatedSnapshot(clean);
assert.ok(cleanSnap);
assert.deepEqual([...cleanSnap.operations[0].payload], [7, 9]);
privateBytes[0] = 99;
assert.deepEqual([...cleanSnap.operations[0].payload], [7, 9]);

console.log('[phase12] remote SAB ingress regression passed');
