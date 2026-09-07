import test from 'node:test';
import assert from 'node:assert/strict';

import { CHANGELOG_SCHEMA_VERSION, ChangeLog, createProjectOperation, orderOperations, mergeOperations } from '../js/collaboration/index.js';
import { RemoteCollaborationGate, createRemoteCollaborationEnvelope, envelopeIdentity } from '../js/collaboration/remote-authority.js';

const base = { projectIdentity: 'hex-project:p', binaryIdentity: null };

test('#6248 current-schema raw object without causalParents is normalized, never crashes', () => {
  const log = new ChangeLog({ projectIdentity: 'hex-project:p' });
  const result = log.applyOperation({
    schemaVersion: CHANGELOG_SCHEMA_VERSION,
    operationId: 'op:malformed',
    projectIdentity: 'hex-project:p',
    binaryIdentity: null,
    targetEntityId: 'e',
    factKind: 'name',
    action: 'set',
    payload: 'A',
    provenance: { source: 'local' },
  });
  assert.equal(result.status, 'applied');
  assert.deepEqual(log.snapshot().facts['e\u0000name'].values[0].value, 'A');
  const equivalent = new ChangeLog({ projectIdentity: 'hex-project:p' });
  equivalent.applyOperation(createProjectOperation({
    schemaVersion: CHANGELOG_SCHEMA_VERSION,
    operationId: 'op:malformed',
    projectIdentity: 'hex-project:p',
    binaryIdentity: null,
    targetEntityId: 'e',
    factKind: 'name',
    action: 'set',
    payload: 'A',
    provenance: { source: 'local' },
  }));
  assert.equal(equivalent.digest(), log.digest(), 'raw current-schema input must take the same canonical path as createProjectOperation');
});

test('#6248 current-schema raw object without targetEntityId does not mutate state', () => {
  const log = new ChangeLog({ projectIdentity: 'hex-project:p' });
  const result = log.applyOperation({
    schemaVersion: CHANGELOG_SCHEMA_VERSION,
    operationId: 'op:pollute',
    projectIdentity: 'hex-project:p',
    binaryIdentity: null,
    causalParents: [],
    action: 'set',
    payload: 'A',
    provenance: { source: 'local' },
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'operation-target-entity-required');
  assert.deepEqual(log.snapshot().facts, {});
  assert.deepEqual(log.appliedOperationIds(), []);
  assert.deepEqual([...log.pending.keys()], []);
});

test('#6248 current-schema raw object without factKind does not mutate state', () => {
  const log = new ChangeLog({ projectIdentity: 'hex-project:p' });
  const result = log.applyOperation({
    schemaVersion: CHANGELOG_SCHEMA_VERSION,
    operationId: 'op:pollute-kind',
    projectIdentity: 'hex-project:p',
    binaryIdentity: null,
    targetEntityId: 'e',
    causalParents: [],
    action: 'set',
    payload: 'A',
    provenance: { source: 'local' },
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'operation-fact-kind-required');
  assert.deepEqual(log.snapshot().facts, {});
  assert.deepEqual(log.appliedOperationIds(), []);
  assert.deepEqual([...log.pending.keys()], []);
});

test('#6248 current-schema raw object with non-array causalParents is deterministically rejected', () => {
  const log = new ChangeLog({ projectIdentity: 'hex-project:p' });
  const result = log.applyOperation({
    schemaVersion: CHANGELOG_SCHEMA_VERSION,
    operationId: 'op:bad-parents',
    projectIdentity: 'hex-project:p',
    binaryIdentity: null,
    targetEntityId: 'e',
    factKind: 'name',
    action: 'set',
    payload: 'A',
    causalParents: 'op:nope',
    provenance: { source: 'local' },
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'operation-causal-parents-invalid');
  assert.deepEqual(log.snapshot().facts, {});
  assert.deepEqual(log.appliedOperationIds(), []);
  assert.deepEqual([...log.pending.keys()], []);
});

test('#6248 applyBatch/orderOperations/mergeOperations enforce the same shape contract', () => {
  const log = new ChangeLog({ projectIdentity: 'hex-project:p' });
  const batchResult = log.applyBatch([{
    schemaVersion: CHANGELOG_SCHEMA_VERSION,
    operationId: 'op:batch-bad',
    projectIdentity: 'hex-project:p',
    binaryIdentity: null,
    targetEntityId: 'e',
    factKind: 'name',
    action: 'set',
    payload: 'A',
    provenance: { source: 'local' },
  }]);
  assert.equal(batchResult.status, 'applied');
  assert.deepEqual(log.snapshot().facts['e\u0000name'].values[0].value, 'A', 'applyBatch must canonicalize current-schema raw input instead of trusting it');

  const ordered = orderOperations([{
    schemaVersion: CHANGELOG_SCHEMA_VERSION,
    operationId: 'op:order-bad',
    projectIdentity: 'hex-project:p',
    binaryIdentity: null,
    targetEntityId: 'e',
    factKind: 'name',
    action: 'set',
    payload: 'A',
    provenance: { source: 'local' },
  }]);
  assert.deepEqual(ordered.ordered.map((operation) => [operation.operationId, operation.causalParents]), [['op:order-bad', []]]);

  const merged = mergeOperations([{
    schemaVersion: CHANGELOG_SCHEMA_VERSION,
    operationId: 'op:merge-bad',
    projectIdentity: 'hex-project:p',
    binaryIdentity: null,
    targetEntityId: 'e',
    factKind: 'name',
    action: 'set',
    payload: 'A',
    provenance: { source: 'local' },
  }]);
  assert.deepEqual(merged.map((operation) => [operation.operationId, operation.causalParents, Object.isFrozen(operation)]), [['op:merge-bad', [], true]]);
});

test('#6248 canonical createProjectOperation output and round-tripped operations still apply', () => {
  const log = new ChangeLog({ projectIdentity: 'hex-project:p' });
  const canonical = createProjectOperation({ ...base, operationId: 'op:good', targetEntityId: 'e', factKind: 'name', action: 'set', payload: 'A' });
  assert.equal(log.applyOperation(canonical).status, 'applied');
  const roundTripped = JSON.parse(JSON.stringify(canonical));
  const second = new ChangeLog({ projectIdentity: 'hex-project:p' });
  assert.equal(second.applyOperation(roundTripped).status, 'applied');
  assert.equal(second.digest(), log.digest());
});

test('#6248 remote gate rejects per-operation shape violations fail-closed', () => {
  const gate = new RemoteCollaborationGate({
    projectIdentity: 'project:1',
    binaryIdentity: 'binary:1',
    sessionIdentity: 'collab-session:1',
    allowedActors: { alice: ['*'] },
    verifyTransportProof: (proof) => proof.proofIdentity === 'tls:test',
    transportVerifierIdentity: 'oracle:S2-P12-COLLAB-REMOTE:independent',
  });
  const good = createRemoteCollaborationEnvelope({
    projectIdentity: 'project:1',
    binaryIdentity: 'binary:1',
    sessionIdentity: 'collab-session:1',
    actorIdentity: 'alice',
    deviceIdentity: 'device:alice',
    messageId: 'msg:good',
    sequence: 1,
    operations: [{ operationId: 'op:good', targetEntityId: 'fn:1', factKind: 'name', action: 'set', payload: 'x' }],
    transportProof: { authenticated: true, confidentiality: 'verified', integrity: 'verified', proofIdentity: 'tls:test' },
    egress: { userAuthorized: true, derivedDataOnly: true },
  });
  assert.equal(gate.validate(good).ok, true);
  const badSource = createRemoteCollaborationEnvelope({
    ...good,
    messageId: 'msg:bad',
    operations: [{ ...good.operations[0], operationId: 'op:bad' }],
  });
  const bad = { ...badSource, operations: [{ ...badSource.operations[0], factKind: undefined }] };
  bad.envelopeId = envelopeIdentity(bad);
  assert.equal(gate.validate(bad).ok, false);
  assert.equal(gate.validate(bad).reason, 'remote-operation-shape-invalid');
  const parentsSource = createRemoteCollaborationEnvelope({
    ...good,
    messageId: 'msg:parents',
    operations: [{ ...good.operations[0], operationId: 'op:parents', causalParents: ['op:anchor'] }],
  });
  const tamperedParents = { ...parentsSource, operations: [{ ...parentsSource.operations[0], causalParents: 'nope' }] };
  tamperedParents.envelopeId = envelopeIdentity(tamperedParents);
  assert.equal(gate.validate(tamperedParents).reason, 'remote-operation-shape-invalid');
  const entitySource = createRemoteCollaborationEnvelope({
    ...good,
    messageId: 'msg:entity',
    operations: [{ ...good.operations[0], operationId: 'op:entity' }],
  });
  const tamperedEntity = { ...entitySource, operations: [{ ...entitySource.operations[0], targetEntityId: '' }] };
  tamperedEntity.envelopeId = envelopeIdentity(tamperedEntity);
  assert.equal(gate.validate(tamperedEntity).reason, 'remote-operation-shape-invalid');
});
