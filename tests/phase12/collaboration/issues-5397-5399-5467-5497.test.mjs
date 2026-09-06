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

  const pending = new ChangeLog(base);
  const pendingAlpha = op('op:pending', 'alpha', { causalParents: ['parent'] });
  assert.equal(pending.applyOperation(pendingAlpha).status, 'unresolved');
  assert.equal(pending.applyOperation(pendingAlpha).status, 'unresolved');
  const pendingMismatch = pending.applyOperation(op('op:pending', 'beta', { causalParents: ['parent'] }));
  assert.equal(pendingMismatch.status, 'rejected');
  assert.equal(pendingMismatch.reason, 'operation-id-content-mismatch');
  assert.equal(pending.pending.get('op:pending'), pendingAlpha, 'mismatch must not replace the original pending operation');
  assert.equal(pending.applyOperation(op('parent', 'parent', { targetEntityId: 'parent' })).status, 'applied');
  assert.equal(pending.snapshot().facts['e\x00name'].values[0].value, 'alpha');

  const batch = new ChangeLog(base);
  assert.throws(
    () => batch.applyBatch([op('op:batch', 'alpha'), op('op:batch', 'beta')]),
    /operation-id-content-mismatch/,
  );
  assert.deepEqual(batch.appliedOperationIds(), []);
});

test('#5397 batch cannot replace a pre-existing pending operation ID', () => {
  const log = new ChangeLog(base);
  const pendingAlpha = op('op:pending-batch', 'alpha', { causalParents: ['parent-batch'] });
  assert.equal(log.applyOperation(pendingAlpha).status, 'unresolved');
  const beforeDigest = log.digest();
  const beforeState = log.snapshot();

  const mismatch = log.applyBatch([
    op('parent-batch', 'parent', { targetEntityId: 'parent-batch' }),
    op('op:pending-batch', 'beta', { causalParents: ['parent-batch'] }),
  ]);
  assert.equal(mismatch.status, 'rejected');
  assert.equal(mismatch.reason, 'operation-id-content-mismatch');
  assert.equal(mismatch.operationId, 'op:pending-batch');
  assert.equal(log.digest(), beforeDigest, 'rejected batch must not commit the working parent or replacement');
  assert.deepEqual(log.snapshot(), beforeState, 'rejected batch must leave state unchanged');
  assert.equal(log.pending.get('op:pending-batch'), pendingAlpha, 'original pending alpha must remain authoritative');
  assert.equal(log.operations.has('parent-batch'), false, 'working-copy parent must not leak into the original log');

  const matching = new ChangeLog(base);
  const canonicalPending = op('op:pending-retry', 'alpha', { causalParents: ['parent-retry'] });
  const retry = op('op:pending-retry', 'alpha', { causalParents: ['parent-retry'] });
  assert.notEqual(retry, canonicalPending, 'retry fixture must be a distinct object');
  assert.equal(matching.applyOperation(canonicalPending).status, 'unresolved');
  const accepted = matching.applyBatch([
    op('parent-retry', 'parent', { targetEntityId: 'parent-retry' }),
    retry,
  ]);
  assert.equal(accepted.status, 'applied');
  assert.equal(matching.pending.has('op:pending-retry'), false);
  assert.equal(matching.operations.get('op:pending-retry'), canonicalPending, 'the stored pending operation, not the retry object, is applied');
  assert.equal(matching.snapshot().facts['e\x00name'].values[0].value, 'alpha');
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
  guarded.applyOperation(op('add', 'v', { targetEntityId: 't', factKind: 'bookmark', action: 'set', payload: true }));
  guarded.applyOperation(createProjectOperation({ ...base, operationId: 'rm', targetEntityId: 't', factKind: 'bookmark', action: 'remove', payload: true }));
  guarded.applyOperation(createProjectOperation({
    ...base, operationId: 're', targetEntityId: 't', factKind: 'bookmark', action: 'set', payload: true, causalParents: ['later'],
  }));
  guarded.applyOperation(op('later', 'l', { targetEntityId: 'other' }));
  assert.deepEqual([...guarded.pending.keys()], ['re'], 'tombstone-blocked operation stays pending without looping');
  assert.ok(
    guarded.snapshot().unresolved.some((entry) => entry.operationId === 're' && entry.reason === 'tombstone-protects-state'),
    'tombstone block is recorded explicitly',
  );
  assert.equal(guarded.applyOperation(op('later2', 'l2', { targetEntityId: 'other2' })).status, 'applied');
  assert.deepEqual([...guarded.pending.keys()], ['re']);
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
  assert.throws(
    () => restoreCheckpoint(checkpoint, { ...base, operations: [op('set-2', 'B', { targetEntityId: 'e2' }), badResolve] }),
    (error) => {
      assert.equal(error?.code, 'CHECKPOINT_RESTORE_OPERATION_REJECTED');
      assert.equal(error?.reason, 'resolution-target-missing');
      assert.equal(error?.operationId, 'resolve-1');
      assert.deepEqual(error?.results.map((entry) => entry.status), ['applied', 'rejected']);
      assert.equal(error?.log.snapshot().facts['e2\x00name'].values[0].value, 'B');
      return true;
    },
  );

  // A child that becomes ready only during the parent's drain must surface its
  // rejection instead of disappearing behind the parent's applied result.
  const drainChild = createProjectOperation({
    ...base,
    operationId: 'resolve-drained',
    targetEntityId: 'e',
    factKind: 'name',
    action: 'resolve',
    payload: { operationId: 'does-not-exist' },
    causalParents: ['drain-parent'],
  });
  const drainParent = op('drain-parent', 'parent', { targetEntityId: 'parent' });
  assert.throws(
    () => restoreCheckpoint(checkpoint, { ...base, operations: [drainChild, drainParent] }),
    (error) => {
      assert.equal(error?.code, 'CHECKPOINT_RESTORE_OPERATION_REJECTED');
      assert.equal(error?.reason, 'resolution-target-missing');
      assert.equal(error?.operationId, 'resolve-drained');
      assert.deepEqual(error?.results.map((entry) => entry.status), ['unresolved', 'rejected']);
      assert.ok(error?.log.operations.has('drain-parent'), 'the triggering parent remains applied');
      assert.equal(error?.log.pending.has('resolve-drained'), false, 'the rejected child is not left pending');
      return true;
    },
  );

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
  // A consistent checkpoint still restores and preserves its valid state.
  const seed = new ChangeLog({ projectIdentity: 'project-A', binaryIdentity: null });
  assert.equal(
    seed.applyOperation(op('set-1', 'A', { projectIdentity: 'project-A' })).status,
    'applied',
  );
  const good = createCheckpoint(seed);
  const log = restoreCheckpoint(good, { projectIdentity: 'project-A', binaryIdentity: null });
  assert.equal(log.projectIdentity, 'project-A');
  assert.equal(log.snapshot().projectIdentity, 'project-A');
  assert.equal(log.snapshot().facts['e\x00name'].values[0].value, 'A');
});
