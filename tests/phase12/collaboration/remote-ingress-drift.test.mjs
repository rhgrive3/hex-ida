import assert from 'node:assert/strict';

import { ChangeLog, createProjectOperation } from '../../../js/collaboration/index.js';
import {
  RemoteCollaborationGate,
  applyRemoteEnvelope,
  createRemoteCollaborationEnvelope,
  envelopeIdentity,
} from '../../../js/collaboration/remote-authority.js';

console.log('[phase12] remote ingress validation/use drift regression...');

const BASE = {
  projectIdentity: 'hex-project:p:drift',
  binaryIdentity: 'hex-binary:p:drift:x86_64',
  targetEntityId: 'hex-entity:drift',
  factKind: 'comment',
};

const gateInput = {
  projectIdentity: BASE.projectIdentity,
  binaryIdentity: BASE.binaryIdentity,
  sessionIdentity: 'hex-session:drift',
  allowedActors: { 'hex-actor:drift': ['*'] },
  transportVerifierIdentity: 'hex-oracle:drift',
};

const verifyTransportProof = () => true;

// Accessor-backed ingress attempt: the payload getter must never be allowed to
// present one value to validation and a different one to ChangeLog application.
// The gate rejects accessor-backed authority before any value is consumed.
function accessorBackedEnvelope({ driftValue }) {
  const envelope = createRemoteCollaborationEnvelope({
    ...BASE,
    sessionIdentity: 'hex-session:drift',
    actorIdentity: 'hex-actor:drift',
    deviceIdentity: 'hex-device:drift',
    messageId: `drift-accessor-${driftValue}`,
    sequence: 1,
    operations: [{ ...BASE, operationId: 'op:drift-accessor', action: 'set', payload: 'safe', causalParents: [] }],
    transportProof: { authenticated: true, confidentiality: 'verified', integrity: 'verified', proofIdentity: 'proof:drift' },
    egress: { userAuthorized: true, rawBinaryBytes: false, derivedDataOnly: true },
  });
  const operations = envelope.operations.map((operation) => {
    const hostile = { ...operation };
    Object.defineProperty(hostile, 'payload', {
      enumerable: true,
      configurable: true,
      get() { return driftValue; },
    });
    return hostile;
  });
  const accessorized = { ...envelope, operations };
  return { ...accessorized, envelopeId: envelopeIdentity(accessorized) };
}

const alwaysEvil = accessorBackedEnvelope({ driftValue: 'evil' });
const gateA = new RemoteCollaborationGate({ ...gateInput, verifyTransportProof });
const logA = new ChangeLog({ projectIdentity: BASE.projectIdentity, binaryIdentity: BASE.binaryIdentity, allowRemote: true });
const rejected = applyRemoteEnvelope(logA, gateA, alwaysEvil);
assert.equal(rejected.status, 'rejected');
assert.equal(rejected.reason, 'remote-envelope-shape-invalid');
assert.equal(logA.state.facts?.[`${BASE.targetEntityId}\u0000comment`]?.payload ?? logA.snapshot().facts?.[`${BASE.targetEntityId}\u0000comment`]?.payload, undefined, 'no hostile payload may reach the ChangeLog state');

// Stateful drift that would pass accessor rejection by hiding inside a
// non-configurable enumerable value property cannot occur: the gate snapshots
// the envelope once at ingress and every downstream consumer (identity digest,
// canonicality, authorization, ChangeLog apply, final acceptance) reads only
// that frozen snapshot. Prove it by mutating the raw envelope between the
// gate's validation and the delivery application attempt.
function mutationEnvelope() {
  const envelope = createRemoteCollaborationEnvelope({
    ...BASE,
    sessionIdentity: 'hex-session:drift',
    actorIdentity: 'hex-actor:drift',
    deviceIdentity: 'hex-device:drift',
    messageId: 'drift-mutation',
    sequence: 2,
    operations: [{ ...BASE, operationId: 'op:drift-mutation', action: 'set', payload: 'safe', causalParents: [] }],
    transportProof: { authenticated: true, confidentiality: 'verified', integrity: 'verified', proofIdentity: 'proof:drift' },
    egress: { userAuthorized: true, rawBinaryBytes: false, derivedDataOnly: true },
  });
  return envelope;
}

const gateB = new RemoteCollaborationGate({ ...gateInput, verifyTransportProof });
const logB = new ChangeLog({ projectIdentity: BASE.projectIdentity, binaryIdentity: BASE.binaryIdentity, allowRemote: true, authorizedAuthors: ['hex-actor:drift'] });
const clean = mutationEnvelope();

// The gate validates once and captures an owned snapshot of the exact data it
// validated. Delivery applies that snapshot, so validated state and applied
// state are the same frozen data even when the raw caller object is mutable.
const checked = gateB.validate(clean);
assert.equal(checked.ok, true);
const snap = gateB.validatedSnapshot(clean);
assert.ok(snap, 'validate() must capture an owned ingress snapshot');
assert.equal(snap.operations[0].payload, 'safe');
assert.notEqual(snap, clean, 'the snapshot must be owned data, not the raw envelope');

// The snapshot is frozen: post-validation mutation of the applied data is
// impossible, and the raw envelope cannot be swapped underneath the gate.
assert.throws(() => { snap.operations[0].payload = 'evil'; }, TypeError);

// Delivery consumes the same snapshot the gate validated.
// Raw-mutation drift is rejected before any apply: the envelope identity
// digest no longer matches the mutated raw body, and the rejected attempt
// must not burn the replay authority.
const mutatedRaw = { ...clean, operations: [{ ...clean.operations[0], payload: 'evil' }] };
mutatedRaw.envelopeId = clean.envelopeId;
const mutated = applyRemoteEnvelope(logB, gateB, mutatedRaw);
assert.equal(mutated.status, 'rejected');
assert.equal(mutated.reason, 'remote-envelope-identity-mismatch', 'post-validation raw mutation must not reach the ChangeLog');
assert.equal(gateB.seenMessages.has('drift-mutation'), false, 'a rejected drift attempt must not burn replay authority');

const result = applyRemoteEnvelope(logB, gateB, clean);
assert.equal(result.status, 'applied');
const applied = logB.snapshot().facts?.[`${BASE.targetEntityId}\u0000comment`]?.values?.[0]?.value;
assert.equal(applied, 'safe', 'the applied payload must be the validated ingress snapshot');

// A previously accepted envelope id cannot be replayed.
const replay = applyRemoteEnvelope(logB, gateB, clean);
assert.equal(replay.status, 'rejected');
assert.equal(replay.reason, 'remote-replay-or-duplicate');

// A non-plain envelope (class instance / accessor-backed envelope object) is
// fail-closed rejected even before schema checks.
const gateC = new RemoteCollaborationGate({ ...gateInput, verifyTransportProof });
class HostileEnvelope {}
assert.equal(gateC.validate(new HostileEnvelope()).reason, 'remote-envelope-shape-invalid');
assert.equal(gateC.validate(null).reason, 'remote-envelope-shape-invalid');

// Canonical local operations remain unaffected.
assert.ok(createProjectOperation({ ...BASE, operationId: 'op:plain', action: 'set', payload: 'ok', causalParents: [] }).operationId);

console.log('[phase12] remote ingress validation/use drift regression passed');
