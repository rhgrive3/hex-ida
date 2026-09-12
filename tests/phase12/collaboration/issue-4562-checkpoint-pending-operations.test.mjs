import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHECKPOINT_SCHEMA_VERSION,
  ChangeLog,
  collaborationDigest,
  createCheckpoint,
  createProjectOperation,
  replayOperations,
  restoreCheckpoint,
} from '../../../js/collaboration/index.js';

const base = { projectIdentity: 'issue-4562-project', binaryIdentity: null };
const op = (operationId, extra = {}) => createProjectOperation({
  ...base,
  operationId,
  targetEntityId: 'entity-1',
  factKind: 'name',
  action: 'set',
  payload: operationId,
  provenance: { source: 'issue-4562-test', marker: operationId },
  ...extra,
});

function pendingIds(log) {
  return [...log.pending.keys()].sort();
}

test('#4562 missing-parent pending operation survives checkpoint restore and later drains', () => {
  const log = new ChangeLog(base);
  const child = op('child', { causalParents: ['parent'], payload: { value: 'child' } });
  assert.equal(log.applyOperation(child).status, 'unresolved');
  assert.deepEqual(pendingIds(log), ['child']);

  const checkpoint = createCheckpoint(log);
  assert.equal(checkpoint.schemaVersion, CHECKPOINT_SCHEMA_VERSION);
  assert.deepEqual(checkpoint.pendingOperations?.map((operation) => operation.operationId), ['child']);

  const restored = restoreCheckpoint(structuredClone(checkpoint), base);
  assert.deepEqual(pendingIds(restored), ['child']);
  assert.deepEqual(restored.pending.get('child')?.payload, { value: 'child' });
  assert.deepEqual(restored.pending.get('child')?.causalParents, ['parent']);
  assert.deepEqual(restored.pending.get('child')?.provenance, { source: 'issue-4562-test', marker: 'child' });

  const parent = op('parent', { targetEntityId: 'entity-parent', payload: 'parent' });
  assert.equal(restored.applyOperation(parent).status, 'applied');
  assert.deepEqual(pendingIds(restored), []);
  const childRecord = restored.snapshot().facts['entity-1\u0000name'];
  assert.equal(childRecord?.values.some((entry) => entry.operationId === 'child'), true);
});

test('#4562 tombstone-protected pending operation survives checkpoint restore exactly once', () => {
  const log = new ChangeLog(base);
  const set = op('set-1', { payload: 'A' });
  const remove = op('remove-1', { action: 'remove', payload: null });
  const blocked = op('blocked-1', { payload: 'B' });
  assert.equal(log.applyOperation(set).status, 'applied');
  assert.equal(log.applyOperation(remove).status, 'applied');
  assert.equal(log.applyOperation(blocked).status, 'unresolved');
  assert.deepEqual(pendingIds(log), ['blocked-1']);

  const restored = restoreCheckpoint(structuredClone(createCheckpoint(log)), base);
  assert.deepEqual(pendingIds(restored), ['blocked-1']);
  assert.equal(restored.snapshot().unresolved.filter((entry) => entry.operationId === 'blocked-1').length, 1);
});

test('#4562 checkpoint integrity binds pending operation content', () => {
  const log = new ChangeLog(base);
  assert.equal(log.applyOperation(op('child', { causalParents: ['parent'], payload: 'A' })).status, 'unresolved');
  const checkpoint = structuredClone(createCheckpoint(log));
  assert.equal(checkpoint.pendingOperations.length, 1);
  checkpoint.pendingOperations[0].payload = 'tampered';
  assert.throws(() => restoreCheckpoint(checkpoint, base), /checkpoint-digest-mismatch/);
  assert.throws(() => replayOperations({ ...base, checkpoint }), /checkpoint-digest-mismatch/);
});

test('#4562 malformed and cross-scope pending operations fail closed', () => {
  const log = new ChangeLog(base);
  assert.equal(log.applyOperation(op('child', { causalParents: ['parent'] })).status, 'unresolved');
  const canonical = createCheckpoint(log);

  const wrongProject = structuredClone(canonical);
  wrongProject.pendingOperations[0].projectIdentity = 'other-project';
  wrongProject.digest = collaborationDigest({
    state: wrongProject.state,
    operationIds: wrongProject.operationIds,
    pendingOperations: wrongProject.pendingOperations,
  });
  assert.throws(() => restoreCheckpoint(wrongProject, base), /checkpoint-pending-project-identity-mismatch/);

  const malformed = structuredClone(canonical);
  malformed.pendingOperations[0].causalParents = 'parent';
  malformed.digest = collaborationDigest({
    state: malformed.state,
    operationIds: malformed.operationIds,
    pendingOperations: malformed.pendingOperations,
  });
  assert.throws(() => restoreCheckpoint(malformed, base), /operation-causal-parents-invalid/);
});

test('#4562 checkpoint pending operations are canonicalized by operation id', () => {
  const log = new ChangeLog(base);
  assert.equal(log.applyOperation(op('z-child', { causalParents: ['z-parent'] })).status, 'unresolved');
  assert.equal(log.applyOperation(op('a-child', { causalParents: ['a-parent'] })).status, 'unresolved');
  const checkpoint = createCheckpoint(log);
  assert.deepEqual(checkpoint.pendingOperations.map((operation) => operation.operationId), ['a-child', 'z-child']);
});


test('#4562 replayOperations restores pending queue before admitting later parents', () => {
  const log = new ChangeLog(base);
  const child = op('child', { causalParents: ['parent'], payload: 'child' });
  assert.equal(log.applyOperation(child).status, 'unresolved');
  const checkpoint = createCheckpoint(log);
  const parent = op('parent', { targetEntityId: 'entity-parent', payload: 'parent' });
  const replayed = replayOperations({ ...base, checkpoint: structuredClone(checkpoint), operations: [parent] });
  assert.equal(replayed.unresolved.length, 0);
  assert.equal(replayed.state.facts['entity-1\u0000name'].values.some((entry) => entry.operationId === 'child'), true);
});

test('#4562 legacy v1 checkpoints fail closed because pending completeness is unknowable', () => {
  const log = new ChangeLog(base);
  const checkpoint = structuredClone(createCheckpoint(log));
  checkpoint.schemaVersion = 'hex-project-checkpoint-v1';
  assert.throws(() => restoreCheckpoint(checkpoint, base), /checkpoint-legacy-pending-operations-unavailable/);
  assert.throws(() => replayOperations({ ...base, checkpoint }), /checkpoint-legacy-pending-operations-unavailable/);
});


test('#4562 missing-parent pending queue participates in semantic state digest', () => {
  const log = new ChangeLog(base);
  const before = log.digest();
  assert.equal(log.applyOperation(op('child', { causalParents: ['parent'] })).status, 'unresolved');
  assert.notEqual(log.digest(), before, 'pending executable future changes are part of the semantic state');
  assert.equal(createCheckpoint(log).digest, log.digest());
});

test('#4562 duplicate serialized pending IDs fail closed even when content matches', () => {
  const log = new ChangeLog(base);
  assert.equal(log.applyOperation(op('child', { causalParents: ['parent'] })).status, 'unresolved');
  const checkpoint = structuredClone(createCheckpoint(log));
  checkpoint.pendingOperations.push(structuredClone(checkpoint.pendingOperations[0]));
  checkpoint.digest = collaborationDigest({
    state: checkpoint.state,
    operationIds: checkpoint.operationIds,
    pendingOperations: checkpoint.pendingOperations,
  });
  assert.throws(() => restoreCheckpoint(checkpoint, base), /checkpoint-pending-operation-id-invalid/);
});
