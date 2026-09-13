import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ChangeLog,
  createCheckpoint,
  createProjectOperation,
  replayOperations,
  restoreCheckpoint,
} from '../../../js/collaboration/index.js';

const base = { projectIdentity: 'issue-4562-remote-project', binaryIdentity: null };
const remoteOp = (operationId, extra = {}) => createProjectOperation({
  ...base,
  operationId,
  targetEntityId: extra.targetEntityId ?? 'entity-remote',
  factKind: 'name',
  action: 'set',
  payload: extra.payload ?? operationId,
  causalParents: extra.causalParents ?? [],
  authorIdentity: extra.authorIdentity ?? 'alice',
  provenance: { source: 'issue-4562-test', transport: 'remote' },
});
const localParent = () => createProjectOperation({
  ...base,
  operationId: 'parent',
  targetEntityId: 'entity-parent',
  factKind: 'name',
  action: 'set',
  payload: 'parent',
  provenance: { source: 'issue-4562-test' },
});

function checkpointWithRemotePending() {
  const log = new ChangeLog({ ...base, allowRemote: true, authorizedAuthors: ['alice'] });
  assert.equal(log.applyOperation(remoteOp('child', { causalParents: ['parent'], payload: 'child' })).status, 'unresolved');
  return createCheckpoint(log);
}

test('#4562 restore reuses trusted remote admission for pending child drain', () => {
  const checkpoint = checkpointWithRemotePending();
  const restored = restoreCheckpoint(structuredClone(checkpoint), {
    ...base,
    allowRemote: true,
    authorizedAuthors: ['alice'],
  });
  assert.equal(restored.pending.has('child'), true);
  assert.equal(restored.applyOperation(localParent()).status, 'applied');
  assert.equal(restored.pending.size, 0);
  assert.equal(restored.operations.has('child'), true);
  assert.equal(restored.snapshot().facts['entity-remote\u0000name'].values.some((entry) => entry.operationId === 'child'), true);
});

test('#4562 replay reuses trusted remote admission for pending child drain', () => {
  const checkpoint = checkpointWithRemotePending();
  const replayed = replayOperations({
    ...base,
    checkpoint: structuredClone(checkpoint),
    operations: [localParent()],
    allowRemote: true,
    authorizedAuthors: ['alice'],
  });
  assert.equal(replayed.status, 'applied');
  assert.equal(replayed.state.facts['entity-remote\u0000name'].values.some((entry) => entry.operationId === 'child'), true);
});

test('#4562 restored remote pending child stays fail-closed without trusted admission', () => {
  const checkpoint = checkpointWithRemotePending();
  const restored = restoreCheckpoint(structuredClone(checkpoint), base);
  assert.equal(restored.pending.has('child'), true);
  const result = restored.applyOperation(localParent());
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'remote-transport-security-gate-required');
  assert.equal(restored.operations.has('child'), false);
});

test('#4562 restored remote pending child rejects an unauthorized author', () => {
  const checkpoint = checkpointWithRemotePending();
  const restored = restoreCheckpoint(structuredClone(checkpoint), {
    ...base,
    allowRemote: true,
    authorizedAuthors: ['bob'],
  });
  const result = restored.applyOperation(localParent());
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'unauthorized-remote-actor');
  assert.equal(restored.operations.has('child'), false);
});
