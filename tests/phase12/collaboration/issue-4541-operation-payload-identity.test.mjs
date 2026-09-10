import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ChangeLog,
  createProjectOperation,
  mergeOperations,
} from '../../../js/collaboration/index.js';
import {
  applyRemoteEnvelope,
  createRemoteCollaborationEnvelope,
  envelopeIdentity,
  RemoteCollaborationGate,
} from '../../../js/collaboration/remote-authority.js';

const base = {
  projectIdentity: 'hex-project:4541',
  binaryIdentity: 'hex-binary:4541',
  targetEntityId: 'hex-entity:4541',
  factKind: 'name',
  action: 'set',
};

const operation = (payload, extra = {}) => createProjectOperation({ ...base, payload, ...extra });

test('#4541 generated IDs retain undefined and non-finite payload distinctions', () => {
  const empty = operation({});
  const undefinedValue = operation({ marker: undefined });
  const nestedUndefined = operation({ nested: { marker: undefined } });
  const nan = operation({ value: Number.NaN });
  const positiveInfinity = operation({ value: Number.POSITIVE_INFINITY });
  const negativeInfinity = operation({ value: Number.NEGATIVE_INFINITY });
  const zero = operation({ value: 0 });
  const negativeZero = operation({ value: -0 });

  assert.notEqual(undefinedValue.operationId, empty.operationId);
  assert.notEqual(nestedUndefined.operationId, operation({ nested: {} }).operationId);
  assert.notEqual(nan.operationId, empty.operationId);
  assert.notEqual(positiveInfinity.operationId, empty.operationId);
  assert.notEqual(negativeInfinity.operationId, empty.operationId);
  assert.notEqual(nan.operationId, positiveInfinity.operationId);
  assert.notEqual(positiveInfinity.operationId, negativeInfinity.operationId);
  assert.notEqual(zero.operationId, negativeZero.operationId);
  assert.equal(Object.hasOwn(undefinedValue.payload, 'marker'), true);
  assert.equal(Number.isNaN(nan.payload.value), true);
  assert.equal(nan.payload.value, Number.NaN);
  assert.equal(positiveInfinity.payload.value, Number.POSITIVE_INFINITY);
});

test('#4541 local apply and merge preserve distinct lossy payloads', () => {
  const undefinedValue = operation({ marker: undefined });
  const empty = operation({});
  const log = new ChangeLog({ projectIdentity: base.projectIdentity, binaryIdentity: base.binaryIdentity });

  assert.equal(log.applyOperation(undefinedValue).status, 'applied');
  assert.equal(log.applyOperation(empty).status, 'conflict');
  const values = log.snapshot().facts['hex-entity:4541\u0000name'].values;
  assert.equal(values.length, 2);
  assert.equal(Object.hasOwn(values.find((item) => Object.hasOwn(item.value, 'marker')).value, 'marker'), true);
  assert.equal(mergeOperations([undefinedValue], [empty]).length, 2);

  const sameIdNan = operation({ value: Number.NaN }, { operationId: 'op:4541-shared' });
  const sameIdInfinity = operation({ value: Number.POSITIVE_INFINITY }, { operationId: 'op:4541-shared' });
  const guarded = new ChangeLog({ projectIdentity: base.projectIdentity, binaryIdentity: base.binaryIdentity });
  assert.equal(guarded.applyOperation(sameIdNan).status, 'applied');
  const mismatch = guarded.applyOperation(sameIdInfinity);
  assert.equal(mismatch.status, 'rejected');
  assert.equal(mismatch.reason, 'operation-id-content-mismatch');
  assert.equal(mismatch.operationId, 'op:4541-shared');
});

const remoteBase = {
  projectIdentity: 'hex-project:4541-remote',
  binaryIdentity: 'hex-binary:4541-remote',
  sessionIdentity: 'hex-session:4541',
  actorIdentity: 'hex-actor:4541',
  deviceIdentity: 'hex-device:4541',
  transportProof: { authenticated: true, confidentiality: 'verified', integrity: 'verified', proofIdentity: 'proof:4541' },
  egress: { userAuthorized: true, rawBinaryBytes: false, derivedDataOnly: true },
};

function remoteEnvelope(payload, sequence, messageId) {
  return createRemoteCollaborationEnvelope({
    ...remoteBase,
    sequence,
    messageId,
    operations: [{ targetEntityId: 'hex-entity:remote-4541', factKind: 'name', action: 'set', payload, causalParents: [] }],
  });
}

function remoteGate() {
  return new RemoteCollaborationGate({
    projectIdentity: remoteBase.projectIdentity,
    binaryIdentity: remoteBase.binaryIdentity,
    sessionIdentity: remoteBase.sessionIdentity,
    allowedActors: { [remoteBase.actorIdentity]: ['*'] },
    verifyTransportProof: () => true,
  });
}

test('#4541 remote envelope identity and delivery use the same lossless payload contract', () => {
  const undefinedEnvelope = remoteEnvelope({ marker: undefined }, 1, 'message:4541-undefined');
  const emptyEnvelope = remoteEnvelope({}, 2, 'message:4541-empty');
  assert.notEqual(undefinedEnvelope.envelopeId, emptyEnvelope.envelopeId);
  assert.equal(undefinedEnvelope.envelopeId, envelopeIdentity(undefinedEnvelope));
  assert.notEqual(undefinedEnvelope.operations[0].operationId, emptyEnvelope.operations[0].operationId);
  assert.deepEqual(remoteGate().validate(undefinedEnvelope), { ok: true });
  assert.deepEqual(remoteGate().validate(emptyEnvelope), { ok: true });

  const log = new ChangeLog({
    projectIdentity: remoteBase.projectIdentity,
    binaryIdentity: remoteBase.binaryIdentity,
    allowRemote: true,
    authorizedAuthors: [remoteBase.actorIdentity],
  });
  const first = applyRemoteEnvelope(log, remoteGate(), undefinedEnvelope);
  const second = applyRemoteEnvelope(log, remoteGate(), emptyEnvelope);
  assert.equal(first.status, 'applied');
  assert.equal(second.status, 'applied');
  assert.equal(second.results[0].status, 'conflict');
  assert.equal(log.snapshot().facts['hex-entity:remote-4541\u0000name'].values.length, 2);
});

console.log('issue #4541 operation payload identity: PASS');
