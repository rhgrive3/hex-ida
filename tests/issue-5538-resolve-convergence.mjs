import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ChangeLog,
  createCheckpoint,
  createProjectOperation,
  restoreCheckpoint,
} from '../js/collaboration/index.js';
import { RemoteCollaborationGate, createRemoteCollaborationEnvelope } from '../js/collaboration/remote-authority.js';
import { applyRemoteEnvelopeQueued } from '../js/collaboration/remote-delivery.js';

const base = Object.freeze({ projectIdentity: 'project-5538', binaryIdentity: null });
function op(operationId, action, payload = null, causalParents = []) {
  return createProjectOperation({
    ...base,
    operationId,
    targetEntityId: 'entity-5538',
    factKind: 'name',
    action,
    payload,
    causalParents,
  });
}
function seeded() {
  const log = new ChangeLog(base);
  assert.equal(log.applyOperation(op('value-a', 'set', 'A')).status, 'applied');
  assert.equal(log.applyOperation(op('value-b', 'set', 'B')).status, 'conflict');
  return log;
}
function winner(log) {
  return log.snapshot().facts['entity-5538\u0000name'].resolvedOperationId;
}

function remoteGate() {
  return new RemoteCollaborationGate({
    projectIdentity: base.projectIdentity,
    sessionIdentity: 'session-5538',
    allowedActors: { alice: ['*'], bob: ['*'] },
    maxBatch: 4,
    maxMessageBytes: 65536,
    verifyTransportProof: (proof) => proof?.proofIdentity === 'proof-5538',
    transportVerifierIdentity: 'oracle-5538',
  });
}
function remoteSeeded() {
  const log = new ChangeLog({ ...base, allowRemote: true, authorizedAuthors: ['alice', 'bob'] });
  assert.equal(log.applyOperation(op('value-a', 'set', 'A')).status, 'applied');
  assert.equal(log.applyOperation(op('value-b', 'set', 'B')).status, 'conflict');
  return log;
}
function remoteResolve(actorIdentity, operationId, targetOperationId) {
  return createRemoteCollaborationEnvelope({
    projectIdentity: base.projectIdentity,
    sessionIdentity: 'session-5538',
    actorIdentity,
    deviceIdentity: `device-${actorIdentity}`,
    messageId: `message-${operationId}`,
    sequence: 1,
    operations: [{
      operationId,
      targetEntityId: 'entity-5538',
      factKind: 'name',
      action: 'resolve',
      payload: { operationId: targetOperationId },
    }],
    transportProof: {
      authenticated: true,
      confidentiality: 'verified',
      integrity: 'verified',
      proofIdentity: 'proof-5538',
    },
    egress: { userAuthorized: true, rawBinaryBytes: false, derivedDataOnly: true },
  });
}

test('#5538 concurrent resolves converge regardless of arrival order', () => {
  const resolveA = op('resolve-a', 'resolve', { operationId: 'value-a' });
  const resolveB = op('resolve-b', 'resolve', { operationId: 'value-b' });
  const left = seeded();
  const right = seeded();
  assert.equal(left.applyOperation(resolveA).status, 'applied');
  assert.equal(left.applyOperation(resolveB).status, 'applied');
  assert.equal(right.applyOperation(resolveB).status, 'applied');
  assert.equal(right.applyOperation(resolveA).status, 'applied');
  assert.equal(winner(left), winner(right));
  assert.deepEqual(left.snapshot(), right.snapshot());
  assert.equal(left.digest(), right.digest());
});

test('#5538 batch and incremental resolution use the same winner', () => {
  const resolveA = op('resolve-a', 'resolve', { operationId: 'value-a' });
  const resolveB = op('resolve-b', 'resolve', { operationId: 'value-b' });
  const batch = seeded();
  const incremental = seeded();
  assert.equal(batch.applyBatch([resolveB, resolveA]).status, 'applied');
  assert.equal(incremental.applyOperation(resolveB).status, 'applied');
  assert.equal(incremental.applyOperation(resolveA).status, 'applied');
  assert.deepEqual(batch.snapshot(), incremental.snapshot());
  assert.equal(batch.digest(), incremental.digest());
});

test('#5538 causal successor remains ordered by canonical resolution operation id', () => {
  const first = op('resolve-a', 'resolve', { operationId: 'value-a' });
  const later = op('resolve-z', 'resolve', { operationId: 'value-b' }, ['resolve-a']);
  const log = seeded();
  assert.equal(log.applyOperation(first).status, 'applied');
  assert.equal(log.applyOperation(later).status, 'applied');
  assert.equal(winner(log), 'value-b');
});

test('#5538 losing concurrent resolve is still recorded and duplicate replay is idempotent', () => {
  const high = op('resolve-z', 'resolve', { operationId: 'value-b' });
  const low = op('resolve-a', 'resolve', { operationId: 'value-a' });
  const log = seeded();
  assert.equal(log.applyOperation(high).status, 'applied');
  assert.equal(log.applyOperation(low).status, 'applied');
  const before = log.digest();
  assert.equal(log.applyOperation(low).status, 'duplicate');
  assert.equal(log.digest(), before);
  assert.deepEqual(log.appliedOperationIds().filter((id) => id.startsWith('resolve-')), ['resolve-a', 'resolve-z']);
});

test('#5538 checkpoint preserves resolution ordering authority for later concurrent resolves', () => {
  const high = op('resolve-m', 'resolve', { operationId: 'value-a' });
  const lower = op('resolve-a', 'resolve', { operationId: 'value-b' });
  const log = seeded();
  assert.equal(log.applyOperation(high).status, 'applied');
  const checkpoint = createCheckpoint(log);
  assert.deepEqual(checkpoint.resolutionOperations.map((operation) => operation.operationId), ['resolve-m']);
  const restored = restoreCheckpoint(checkpoint, { ...base });
  assert.equal(restored.applyOperation(lower).status, 'applied');
  assert.equal(winner(restored), 'value-a');
});


test('#5538 cross-actor remote delivery converges in either envelope order', () => {
  const envA = remoteResolve('alice', 'resolve-a', 'value-a');
  const envB = remoteResolve('bob', 'resolve-b', 'value-b');
  const left = remoteSeeded();
  const right = remoteSeeded();
  const leftGate = remoteGate();
  const rightGate = remoteGate();
  assert.equal(applyRemoteEnvelopeQueued(left, leftGate, envA).status, 'applied');
  assert.equal(applyRemoteEnvelopeQueued(left, leftGate, envB).status, 'applied');
  assert.equal(applyRemoteEnvelopeQueued(right, rightGate, envB).status, 'applied');
  assert.equal(applyRemoteEnvelopeQueued(right, rightGate, envA).status, 'applied');
  assert.deepEqual(left.snapshot(), right.snapshot());
  assert.equal(left.digest(), right.digest());
});

test('#5538 restored resolution ordering marker rejects structured or noncanonical identities', () => {
  const log = seeded();
  assert.equal(log.applyOperation(op('resolve-z', 'resolve', { operationId: 'value-a' })).status, 'applied');
  for (const bad of [['resolve-z'], { id: 'resolve-z' }, 1, true, ' resolve-z ']) {
    const state = structuredClone(log.snapshot());
    state.facts['entity-5538\u0000name'].resolutionOperationId = bad;
    assert.throws(
      () => new ChangeLog({ ...base, state, operations: [...log.operations.values()] }),
      /changelog-state-resolution-operation-id-invalid/,
    );
  }
});

test('#5538 restored canonical resolution marker must name an applied resolve operation', () => {
  const log = seeded();
  assert.equal(log.applyOperation(op('resolve-z', 'resolve', { operationId: 'value-a' })).status, 'applied');
  const state = structuredClone(log.snapshot());
  state.facts['entity-5538\u0000name'].resolutionOperationId = 'resolve-unknown';
  assert.throws(
    () => new ChangeLog({ ...base, state, operations: [...log.operations.values()] }),
    /changelog-state-resolution-operation-provenance-invalid/,
  );
});

test('#5538 restored resolution marker cannot borrow authority from another fact or winner', () => {
  const log = seeded();
  assert.equal(log.applyOperation(op('resolve-z', 'resolve', { operationId: 'value-a' })).status, 'applied');
  const state = structuredClone(log.snapshot());
  const operations = [...log.operations.values()].filter((operation) => operation.operationId !== 'resolve-z');

  const wrongFact = createProjectOperation({
    ...base,
    operationId: 'resolve-z',
    targetEntityId: 'entity-other',
    factKind: 'name',
    action: 'resolve',
    payload: { operationId: 'value-a' },
  });
  assert.throws(
    () => new ChangeLog({ ...base, state, operations: [...operations, wrongFact] }),
    /changelog-state-resolution-operation-provenance-invalid/,
  );

  const wrongWinner = op('resolve-z', 'resolve', { operationId: 'value-b' });
  assert.throws(
    () => new ChangeLog({ ...base, state, operations: [...operations, wrongWinner] }),
    /changelog-state-resolution-operation-provenance-invalid/,
  );
});


test('#5538 all permutations of three concurrent resolutions converge', () => {
  const resolutions = [
    op('resolve-a', 'resolve', { operationId: 'value-a' }),
    op('resolve-b', 'resolve', { operationId: 'value-b' }),
    op('resolve-c', 'resolve', { operationId: 'value-a' }),
  ];
  const permutations = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ];
  let expected = null;
  for (const order of permutations) {
    const log = seeded();
    for (const index of order) assert.equal(log.applyOperation(resolutions[index]).status, 'applied');
    const observed = { snapshot: log.snapshot(), digest: log.digest() };
    if (expected == null) expected = observed;
    else {
      assert.deepEqual(observed.snapshot, expected.snapshot);
      assert.equal(observed.digest, expected.digest);
    }
  }
  assert.equal(expected.snapshot.facts['entity-5538\u0000name'].resolutionOperationId, 'resolve-c');
});

test('#5538 rejected or stale higher-id resolutions never acquire winner authority', () => {
  const log = seeded();
  const beforeResolve = log.snapshot().facts['entity-5538\u0000name'].stateFingerprint;
  assert.equal(log.applyOperation(op('resolve-a', 'resolve', { operationId: 'value-a' })).status, 'applied');
  const selected = structuredClone(log.snapshot().facts['entity-5538\u0000name']);

  const stale = createProjectOperation({
    ...base,
    operationId: 'resolve-z-stale',
    targetEntityId: 'entity-5538',
    factKind: 'name',
    action: 'resolve',
    payload: { operationId: 'value-b' },
    beforeFingerprint: beforeResolve,
  });
  assert.equal(log.applyOperation(stale).status, 'conflict');
  assert.deepEqual(log.snapshot().facts['entity-5538\u0000name'], selected);

  const missing = op('resolve-z-missing', 'resolve', { operationId: 'value-missing' });
  assert.equal(log.applyOperation(missing).status, 'rejected');
  assert.deepEqual(log.snapshot().facts['entity-5538\u0000name'], selected);
});
