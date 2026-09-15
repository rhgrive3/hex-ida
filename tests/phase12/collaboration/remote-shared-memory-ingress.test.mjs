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
function envelope(payload, sequence, messageId, rawBinary = false) {
  return createRemoteCollaborationEnvelope({
    ...base, messageId, sequence,
    operations: [{ targetEntityId: 'hex-entity:sab', factKind: 'comment', action: 'set', payload, causalParents: [] }],
    transportProof: { authenticated: true, confidentiality: 'verified', integrity: 'verified', proofIdentity: 'proof:sab' },
    egress: { userAuthorized: true, rawBinaryBytes: rawBinary, derivedDataOnly: !rawBinary },
  });
}

// #8751 sync to the current raw-binary egress policy: any binary payload
// requires an explicit `rawBinaryBytes:true` declaration at envelope creation,
// and the collaboration gate rejects raw-binary egress unconditionally. The
// SharedArrayBuffer ingress boundary is verified underneath that declaration:
// even with raw egress explicitly allowed, shared-memory state must never
// cross the snapshot boundary.

if (typeof SharedArrayBuffer !== 'undefined') {
  const sab = new SharedArrayBuffer(1);
  const bytes = new Uint8Array(sab); bytes[0] = 1;

  // Raw-binary policy: shared or private bytes without the explicit
  // declaration fail closed at construction.
  assert.throws(() => envelope(bytes, 1, 'raw-policy-sab-view'), /remote-raw-binary-egress-forbidden/);
  assert.throws(() => envelope(new Uint8Array(new ArrayBuffer(2)), 2, 'raw-policy-private-view'), /remote-raw-binary-egress-forbidden/);

  // Shared-memory ingress boundary with raw egress explicitly allowed:
  // construction succeeds, but the SAB-backed state is rejected at the
  // snapshot/shape boundary before anything can apply.
  const hostile = envelope(bytes, 3, 'sab-view', true);
  const g = gate();
  const log = new ChangeLog({ projectIdentity: base.projectIdentity, binaryIdentity: base.binaryIdentity, allowRemote: true, authorizedAuthors: [base.actorIdentity] });
  assert.deepEqual(g.validate(hostile), { ok: false, reason: 'remote-envelope-shape-invalid' });
  assert.equal(applyRemoteEnvelope(log, g, hostile).status, 'rejected');
  bytes[0] = 2;
  assert.equal(log.snapshot().facts?.['hex-entity:sab\u0000comment'], undefined);

  const directSab = envelope(sab, 4, 'sab-direct', true);
  assert.equal(gate().validate(directSab).reason, 'remote-envelope-shape-invalid');

  const dvSab = new SharedArrayBuffer(8);
  const dataView = new DataView(dvSab);
  const dvEnv = envelope(dataView, 5, 'sab-dataview', true);
  assert.equal(gate().validate(dvEnv).reason, 'remote-envelope-shape-invalid');

  // Mutable collections stay forbidden both with and without the raw-binary
  // declaration, including when they hide SAB-backed views.
  assert.throws(
    () => envelope(new Map([['bytes', new Uint8Array(new SharedArrayBuffer(1))]]), 6, 'sab-map', true),
    /remote-operation-mutable-collection-forbidden/,
  );
  assert.throws(
    () => envelope(new Set([new Uint8Array(new SharedArrayBuffer(1))]), 7, 'sab-set', true),
    /remote-operation-mutable-collection-forbidden/,
  );
  assert.throws(
    () => envelope(new Map([['k', 'v']]), 8, 'plain-map'),
    /remote-operation-mutable-collection-forbidden/,
  );
  assert.throws(
    () => envelope(new Set(['v']), 9, 'plain-set'),
    /remote-operation-mutable-collection-forbidden/,
  );
}

// Private (non-shared) bytes are only constructible with the explicit
// rawBinaryBytes:true declaration, and the gate still rejects their egress —
// the product must not re-accept raw binary through `rawBinaryBytes:false`.
const privateBytes = new Uint8Array(new ArrayBuffer(2));
privateBytes.set([7, 9]);
const rawDeclared = envelope(privateBytes, 10, 'arraybuffer-view', true);
const rawGate = gate();
assert.deepEqual(rawGate.validate(rawDeclared), { ok: false, reason: 'remote-raw-binary-egress-forbidden' });

// Derived-data ingress remains accepted and the validated snapshot stays
// detached from caller-mutable structure (the aliasing-safe boundary that the
// raw-binary policy now protects even more strictly).
const mutablePayload = { lines: ['a'] };
const clean = envelope(mutablePayload, 11, 'object-payload');
const cleanGate = gate();
assert.equal(cleanGate.validate(clean).ok, true);
const cleanSnap = cleanGate.validatedSnapshot(clean);
assert.ok(cleanSnap);
assert.deepEqual(cleanSnap.operations[0].payload, { lines: ['a'] });
mutablePayload.lines.push('b');
mutablePayload.extra = 'c';
assert.deepEqual(cleanSnap.operations[0].payload, { lines: ['a'] }, 'validated snapshot must not alias caller-mutable state');

console.log('[phase12] remote SAB ingress regression passed');
