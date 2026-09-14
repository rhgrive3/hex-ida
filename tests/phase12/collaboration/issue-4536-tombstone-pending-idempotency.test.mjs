import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ChangeLog,
  createCheckpoint,
  createProjectOperation,
  restoreCheckpoint,
} from '../../../js/collaboration/index.js';
import {
  RemoteCollaborationGate,
  createRemoteCollaborationEnvelope,
} from '../../../js/collaboration/remote-authority.js';
import { applyRemoteEnvelopeQueued } from '../../../js/collaboration/remote-delivery.js';

const base = { projectIdentity: 'p', binaryIdentity: null };

const operation = (operationId, action, payload = null, extra = {}) => createProjectOperation({
  ...base,
  operationId,
  targetEntityId: 'e',
  factKind: 'name',
  action,
  payload,
  ...extra,
});

function tombstoneBlockedLog() {
  const log = new ChangeLog(base);
  assert.equal(log.applyOperation(operation('set-1', 'set', 'A')).status, 'applied');
  assert.equal(log.applyOperation(operation('remove-1', 'remove')).status, 'applied');
  return log;
}

test('#4536 exact tombstone-blocked retry is idempotent', () => {
  const log = tombstoneBlockedLog();
  const blocked = operation('blocked-1', 'set', 'B');

  const first = log.applyOperation(blocked);
  assert.equal(first.status, 'unresolved');
  assert.equal(log.pending.size, 1);
  assert.equal(log.snapshot().unresolved.length, 1);
  const digest = log.digest();

  const retry = log.applyOperation(blocked);
  assert.equal(retry.status, 'unresolved');
  assert.deepEqual([...log.pending.keys()], ['blocked-1']);
  assert.equal(log.snapshot().unresolved.length, 1);
  assert.equal(log.digest(), digest, 'an exact retry must not mutate the state digest');
});

test('#4536 pending tombstone collision rejects without mutation', () => {
  const log = tombstoneBlockedLog();
  const blocked = operation('blocked-1', 'set', 'B');
  assert.equal(log.applyOperation(blocked).status, 'unresolved');
  const before = log.digest();
  const beforeState = log.snapshot();

  const collision = log.applyOperation(operation('blocked-1', 'set', 'C'));
  assert.equal(collision.status, 'rejected');
  assert.equal(collision.reason, 'operation-id-content-mismatch');
  assert.equal(log.digest(), before);
  assert.deepEqual(log.snapshot(), beforeState);
  assert.equal(log.pending.get('blocked-1'), blocked);
});

test('#4536 batch retry and checkpoint restore preserve one blocked diagnostic', () => {
  const log = tombstoneBlockedLog();
  const blocked = operation('blocked-1', 'set', 'B');
  assert.equal(log.applyOperation(blocked).status, 'unresolved');
  const before = log.digest();

  const batchRetry = log.applyBatch([blocked]);
  assert.equal(batchRetry.status, 'applied-with-unresolved');
  assert.equal(log.digest(), before);
  assert.equal(log.snapshot().unresolved.length, 1);
  assert.deepEqual(batchRetry.unresolvedOperationIds, ['blocked-1']);

  const checkpoint = createCheckpoint(log);
  const restored = restoreCheckpoint(checkpoint, {
    ...base,
    operations: [blocked],
  });
  assert.equal(restored.snapshot().unresolved.length, 1);
  assert.deepEqual([...restored.pending.keys()], ['blocked-1']);
  assert.equal(restored.digest(), log.digest());
});

test('#4536 remote retry preserves one blocked diagnostic and digest', () => {
  const log = new ChangeLog({ ...base, allowRemote: true, authorizedAuthors: ['alice'] });
  assert.equal(log.applyOperation(operation('remove-1', 'remove')).status, 'applied');
  const gate = new RemoteCollaborationGate({
    projectIdentity: 'p',
    binaryIdentity: null,
    sessionIdentity: 'session-1',
    allowedActors: { alice: ['*'] },
    verifyTransportProof: (proof) => proof.proofIdentity === 'tls:test',
    transportVerifierIdentity: 'oracle:test',
  });
  const envelope = (messageId, sequence) => createRemoteCollaborationEnvelope({
    projectIdentity: 'p',
    binaryIdentity: null,
    sessionIdentity: 'session-1',
    actorIdentity: 'alice',
    deviceIdentity: 'device:alice',
    messageId,
    sequence,
    operations: [{
      operationId: 'blocked-remote',
      targetEntityId: 'e',
      factKind: 'name',
      action: 'set',
      payload: 'B',
      causalParents: ['remove-1'],
    }],
    transportProof: { authenticated: true, confidentiality: 'verified', integrity: 'verified', proofIdentity: 'tls:test' },
    egress: { userAuthorized: true, rawBinaryBytes: false, derivedDataOnly: true },
  });

  const first = applyRemoteEnvelopeQueued(log, gate, envelope('message-1', 1));
  assert.equal(first.status, 'accepted-with-pending-dependencies');
  assert.equal(log.snapshot().unresolved.length, 1);
  const digest = log.digest();
  const retry = applyRemoteEnvelopeQueued(log, gate, envelope('message-2', 2));
  assert.equal(retry.status, 'accepted-with-pending-dependencies');
  assert.deepEqual(retry.unresolvedOperationIds, ['blocked-remote']);
  assert.equal(log.snapshot().unresolved.length, 1);
  assert.equal(log.digest(), digest);
});

test('#4536 different blocked IDs retain independent diagnostics', () => {
  const log = tombstoneBlockedLog();
  assert.equal(log.applyOperation(operation('blocked-a', 'set', 'A')).status, 'unresolved');
  assert.equal(log.applyOperation(operation('blocked-b', 'set', 'B')).status, 'unresolved');
  assert.deepEqual(
    log.snapshot().unresolved.map((entry) => entry.operationId),
    ['blocked-a', 'blocked-b'],
  );
  assert.deepEqual([...log.pending.keys()], ['blocked-a', 'blocked-b']);
});
