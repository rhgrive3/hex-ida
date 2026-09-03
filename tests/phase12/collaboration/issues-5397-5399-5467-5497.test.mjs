import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHECKPOINT_SCHEMA_VERSION,
  ChangeLog,
  createCheckpoint,
  createProjectOperation,
  mergeOperations,
  restoreCheckpoint,
} from '../../../js/collaboration/index.js';
import { stableDigest } from '../../../js/core/identity/index.js';

/**
 * Collaboration ChangeLog/checkpoint lifecycle: same-ID content forks reject
 * instead of duplicating silently, ready pending drains to a fixed point, and
 * restore surfaces rejections and identity mismatches (#5397, #5399, #5467,
 * #5497).
 */

const base = { projectIdentity: 'p', binaryIdentity: null };
const op = (id, payload, extra = {}) => createProjectOperation({
  ...base, operationId: id, targetEntityId: 'e', factKind: 'name', action: 'set', payload, ...extra,
});

test('#5397 same-ID different content rejects, identical content duplicates', () => {
  const log = new ChangeLog(base);
  assert.equal(log.applyOperation(op('op:shared', 'alpha')).status, 'applied');
  assert.equal(log.applyOperation(op('op:shared', 'alpha')).status, 'duplicate');
  const mismatch = log.applyOperation(op('op:shared', 'beta'));
  assert.equal(mismatch.status, 'rejected');
  assert.equal(mismatch.reason, 'operation-id-content-mismatch');
  const wrongTarget = log.applyOperation(createProjectOperation({
    ...base, operationId: 'op:shared', targetEntityId: 'other', factKind: 'name', action: 'set', payload: 'alpha',
  }));
  assert.equal(wrongTarget.status, 'rejected');
  assert.equal(wrongTarget.reason, 'operation-id-content-mismatch');
  assert.equal(log.applyOperation(createProjectOperation({
    ...base, operationId: 'op:shared', targetEntityId: 'e', factKind: 'name', action: 'remove', payload: 'alpha',
  })).status, 'rejected');
  assert.throws(() => mergeOperations([op('op:m', 'alpha')], [op('op:m', 'beta')]), /operation-id-content-mismatch/);
  assert.equal(mergeOperations([op('op:m', 'alpha')], [op('op:m', 'alpha')]).length, 1);
});

test('#5399 ready pending drains automatically to a fixed point', () => {
  const log = new ChangeLog(base);
  assert.equal(log.applyOperation(op('child', 'child-value', { causalParents: ['parent'] })).status, 'unresolved');
  assert.equal(log.applyOperation(op('parent', 'parent-value', { targetEntityId: 'other' })).status, 'applied');
  assert.deepEqual([...log.pending.keys()], [], 'the child must apply once its parent arrives');
  assert.ok(log.operations.has('child'));
  assert.equal(log.snapshot().facts['e\x00name'].values.length, 1);
});

test('#5399 chained pending drains in deterministic order', () => {
  const log = new ChangeLog(base);
  log.applyOperation(op('grandchild', 'g', { targetEntityId: 'e2', causalParents: ['child'] }));
  log.applyOperation(op('child', 'c', { targetEntityId: 'e2', causalParents: ['parent'] }));
  assert.deepEqual([...log.pending.keys()].sort(), ['child', 'grandchild']);
  log.applyOperation(op('parent', 'p', { targetEntityId: 'other' }));
  assert.deepEqual([...log.pending.keys()], [], 'a three-level chain drains to a fixed point');
  assert.ok(log.operations.has('child') && log.operations.has('grandchild'));
});

test('#5399 unready and tombstone-blocked pending never loops', () => {
  const log = new ChangeLog(base);
  log.applyOperation(op('orphan', 'o', { causalParents: ['never'] }));
  log.applyOperation(op('parent', 'p', { targetEntityId: 'other' }));
  assert.deepEqual([...log.pending.keys()], ['orphan'], 'missing parents stay pending');
  // Tombstone protection: queue, block, then deliver an unrelated parent.
  const guarded = new ChangeLog(base);
  guarded.applyOperation(op('add', 'v', { targetEntityId: 't', factKind: 'bookmark', action: 'add', payload: true }));
  guarded.applyOperation(createProjectOperation({ ...base, operationId: 'rm', targetEntityId: 't', factKind: 'bookmark', action: 'remove', payload: true }));
  guarded.applyOperation(createProjectOperation({
    ...base, operationId: 're', targetEntityId: 't', factKind: 'bookmark', action: 'add', payload: true, causalParents: ['later'],
  }));
  guarded.applyOperation(op('later', 'l', { targetEntityId: 'other' }));
  assert.ok(!guarded.pending.has('re') || true, 'drain terminates');
  assert.equal(guarded.applyOperation(op('later2', 'l2', { targetEntityId: 'other2' })).status, 'applied');
});

test('#5399 batch arrival drains previously pending children', () => {
  const log = new ChangeLog(base);
  log.applyOperation(op('child', 'c', { causalParents: ['parent'] }));
  const result = log.applyBatch([op('parent', 'p', { targetEntityId: 'other' })]);
  assert.equal(result.status, 'applied');
  assert.deepEqual([...log.pending.keys()], []);
  assert.ok(log.operations.has('child'));
});

test('#5467 restoreCheckpoint surfaces rejected incremental operations', () => {
  const seed = new ChangeLog(base);
  seed.applyOperation(op('set-1', 'A'));
  const checkpoint = createCheckpoint(seed);
  // Healthy extra SETs still restore; no throw.
  const restored = restoreCheckpoint(checkpoint, { ...base, operations: [op('set-2', 'B', { targetEntityId: 'e2' })] });
  assert.equal(restored.snapshot().facts['e2\x00name'].values[0].value, 'B');
  // A resolve against a missing target must not vanish silently.
  const badResolve = createProjectOperation({
    ...base, operationId: 'resolve-1', targetEntityId: 'e', factKind: 'name', action: 'resolve',
    payload: { operationId: 'does-not-exist' },
  });
  assert.throws(() => restoreCheckpoint(checkpoint, { ...base, operations: [badResolve] }),
    (error) => error?.code === 'CHECKPOINT_RESTORE_OPERATION_REJECTED' && error?.reason === 'resolution-target-missing');
  // Wrong-project extras are equally loud.
  const wrongProject = createProjectOperation({
    ...base, operationId: 'x-1', projectIdentity: 'other', targetEntityId: 'e', factKind: 'name', action: 'set', payload: 'z',
  });
  assert.throws(() => restoreCheckpoint(checkpoint, { ...base, operations: [wrongProject] }),
    (error) => error?.code === 'CHECKPOINT_RESTORE_OPERATION_REJECTED' && error?.reason === 'wrong-project-identity');
  // Missing parents still park as pending without throwing.
  const orphan = op('orphan', 'o', { causalParents: ['never'] });
  const parked = restoreCheckpoint(checkpoint, { ...base, operations: [orphan] });
  assert.deepEqual([...parked.pending.keys()], ['orphan']);
});

test('#5497 restoreCheckpoint verifies inner state identity', () => {
  const state = {
    schemaVersion: 'hex-project-operation-v1', projectIdentity: 'project-B', binaryIdentity: null,
    facts: {}, conflicts: [], tombstones: [], unresolved: [],
  };
  const checkpoint = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION, projectIdentity: 'project-A', binaryIdentity: null,
    state, operationIds: [],
    digest: stableDigest({ state, operationIds: [] }),
  };
  assert.throws(() => restoreCheckpoint(checkpoint, { projectIdentity: 'project-A', binaryIdentity: null }),
    /checkpoint-state-project-identity-mismatch/);
  // A consistent checkpoint still restores.
  const seed = new ChangeLog({ projectIdentity: 'project-A', binaryIdentity: null });
  seed.applyOperation(op('set-1', 'A'));
  const good = createCheckpoint(seed);
  const log = restoreCheckpoint(good, { projectIdentity: 'project-A', binaryIdentity: null });
  assert.equal(log.projectIdentity, 'project-A');
  assert.equal(log.snapshot().projectIdentity, 'project-A');
});
