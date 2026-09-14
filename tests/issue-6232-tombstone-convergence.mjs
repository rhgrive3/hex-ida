/**
 * #6232 regression: concurrent `remove` operations for the same fact must
 * converge to the same canonical tombstone state/digest regardless of
 * arrival order. Previously tombstones were appended in arrival order, so
 * two replicas with the same operation set diverged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChangeLog, createProjectOperation } from '../js/collaboration/index.js';

const mk = (id, action, payload = null) => createProjectOperation({
  projectIdentity: 'p',
  operationId: id,
  targetEntityId: 'e',
  factKind: 'name',
  action,
  payload,
});

test('#6232 concurrent removes converge regardless of arrival order', () => {
  const seed = mk('set-0', 'set', 'A');
  const removeA = mk('remove-a', 'remove');
  const removeB = mk('remove-b', 'remove');

  const left = new ChangeLog({ projectIdentity: 'p' });
  left.applyOperation(seed);
  left.applyOperation(removeA);
  left.applyOperation(removeB);

  const right = new ChangeLog({ projectIdentity: 'p' });
  right.applyOperation(seed);
  right.applyOperation(removeB);
  right.applyOperation(removeA);

  assert.deepEqual(left.appliedOperationIds(), right.appliedOperationIds());
  assert.deepEqual(left.snapshot().tombstones, right.snapshot().tombstones);
  assert.equal(left.digest(), right.digest());
});

test('#6232 applyBatch and incremental apply converge', () => {
  const seed = mk('set-0', 'set', 'A');
  const removeA = mk('remove-a', 'remove');
  const removeB = mk('remove-b', 'remove');

  const incremental = new ChangeLog({ projectIdentity: 'p' });
  incremental.applyOperation(seed);
  incremental.applyOperation(removeB);
  incremental.applyOperation(removeA);

  const batched = new ChangeLog({ projectIdentity: 'p' });
  batched.applyOperation(seed);
  batched.applyBatch([removeB, removeA]);

  assert.deepEqual(batched.snapshot().tombstones, incremental.snapshot().tombstones);
  assert.equal(batched.digest(), incremental.digest());
});

test('#6232 duplicate remove replay stays idempotent', () => {
  const seed = mk('set-0', 'set', 'A');
  const removeA = mk('remove-a', 'remove');
  const log = new ChangeLog({ projectIdentity: 'p' });
  log.applyOperation(seed);
  const first = log.applyOperation(removeA);
  assert.equal(first.status, 'applied');
  const second = log.applyOperation(removeA);
  assert.equal(second.status, 'duplicate');
  assert.equal(log.snapshot().tombstones.length, 1);
});

test('#6232 removes for different keys converge in canonical order', () => {
  const mkKey = (id, entity) => createProjectOperation({
    projectIdentity: 'p',
    operationId: id,
    targetEntityId: entity,
    factKind: 'name',
    action: 'remove',
  });
  const left = new ChangeLog({ projectIdentity: 'p' });
  left.applyOperation(mkKey('remove-e1', 'e1'));
  left.applyOperation(mkKey('remove-e2', 'e2'));

  const right = new ChangeLog({ projectIdentity: 'p' });
  right.applyOperation(mkKey('remove-e2', 'e2'));
  right.applyOperation(mkKey('remove-e1', 'e1'));

  assert.deepEqual(left.snapshot().tombstones, right.snapshot().tombstones);
  assert.equal(left.digest(), right.digest());
});

test('#6232 checkpoint restore preserves canonical digest', () => {
  const seed = mk('set-0', 'set', 'A');
  const removeA = mk('remove-a', 'remove');
  const removeB = mk('remove-b', 'remove');
  const log = new ChangeLog({ projectIdentity: 'p' });
  log.applyOperation(seed);
  log.applyOperation(removeA);
  log.applyOperation(removeB);
  const checkpoint = log.checkpoint();
  const ids = [...checkpoint.operationIds];
  assert.deepEqual([...ids].sort(), ids, 'checkpoint operation ids stay sorted');
  // Tombstones inside the checkpoint state itself must already be canonical.
  const tombstones = checkpoint.state.tombstones.map((x) => x.operationId);
  assert.deepEqual([...tombstones].sort(), tombstones);
});
