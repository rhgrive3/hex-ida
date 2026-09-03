import assert from 'node:assert/strict';
import { ChangeLog, createCheckpoint, createProjectOperation, mergeOperations, replayOperations, restoreCheckpoint } from '../../../js/collaboration/index.js';

const base = { projectIdentity: 'hex-project:p', binaryIdentity: 'hex-binary:p:b:macho:arm64' };
const nameA = createProjectOperation({ ...base, operationId: 'op-a', targetEntityId: 'hex-entity:e', factKind: 'name', action: 'set', payload: 'alpha', authorIdentity: 'actor-a', timestampHint: '9999' });
const nameB = createProjectOperation({ ...base, operationId: 'op-b', targetEntityId: 'hex-entity:e', factKind: 'name', action: 'set', payload: 'beta', authorIdentity: 'actor-b', timestampHint: '0000' });
const comment = createProjectOperation({ ...base, operationId: 'op-c', targetEntityId: 'hex-entity:e', factKind: 'comment', action: 'set', payload: 'note' });
const log = new ChangeLog(base);
assert.equal(log.applyOperation(nameA).status, 'applied');
assert.equal(log.applyOperation(nameA).status, 'duplicate');
const reordered = new ChangeLog(base);
assert.equal(reordered.applyBatch([comment, nameB]).status, 'applied');
const ordered = new ChangeLog(base);
assert.equal(ordered.applyBatch([nameB, comment]).status, 'applied');
assert.equal(reordered.digest(), ordered.digest(), 'independent operation order must not change semantic state');
assert.equal(log.applyOperation(nameB).status, 'conflict');
assert.equal(log.snapshot().conflicts[0].type, 'meaningful-conflict');
assert.equal(log.snapshot().facts['hex-entity:e\u0000name'].values.length, 2);

const wrongProject = createProjectOperation({ ...nameA, operationId: 'wrong', projectIdentity: 'hex-project:other' });
const atomic = new ChangeLog(base);
const atomicResult = atomic.applyBatch([nameA, wrongProject]);
assert.equal(atomicResult.status, 'rejected');
assert.deepEqual(atomic.snapshot().facts, {});

const remove = createProjectOperation({ ...base, operationId: 'op-remove', targetEntityId: 'hex-entity:e', factKind: 'bookmark', action: 'remove', payload: true });
const tombstoneLog = new ChangeLog(base);
tombstoneLog.applyOperation(createProjectOperation({ ...base, operationId: 'bookmark-set', targetEntityId: 'hex-entity:e', factKind: 'bookmark', action: 'set', payload: true }));
assert.equal(tombstoneLog.applyOperation(remove).status, 'applied');
const resurrect = createProjectOperation({ ...base, operationId: 'bookmark-old-replay', targetEntityId: 'hex-entity:e', factKind: 'bookmark', action: 'set', payload: true });
assert.equal(tombstoneLog.applyOperation(resurrect).status, 'unresolved');
assert.equal(tombstoneLog.snapshot().facts['hex-entity:e\u0000bookmark'], undefined);

for (const action of [false, 0, ['set'], { action: 'set' }]) {
  assert.throws(
    () => createProjectOperation({ ...base, targetEntityId: 'hex-entity:invalid', factKind: 'name', action, payload: 'x' }),
    /operation-action-required/,
  );
}
assert.throws(
  () => createProjectOperation({ ...base, targetEntityId: 'hex-entity:invalid', factKind: 'name', action: '', payload: 'x' }),
  /operation-action-required/,
);
assert.throws(
  () => createProjectOperation({ ...base, targetEntityId: 'hex-entity:invalid', factKind: 'name', action: 'remvoe', payload: 'x' }),
  /operation-action-unsupported/,
);
assert.equal(createProjectOperation({ ...base, targetEntityId: 'hex-entity:default', factKind: 'name', payload: 'x' }).action, 'set');
assert.equal(createProjectOperation({ ...base, targetEntityId: 'hex-entity:null', factKind: 'name', action: null, payload: 'x' }).action, 'set');

const rawVersionedTemplate = createProjectOperation({ ...base, operationId: 'raw-template', targetEntityId: 'hex-entity:raw', factKind: 'name', action: 'set', payload: 'unexpected-write' });
for (const [index, action] of ['remvoe', false, 0, '', ['set'], { action:'set' }].entries()) {
  const raw = { ...rawVersionedTemplate, operationId:`raw-invalid-${index}`, action };
  const expectedReason = typeof action === 'string' ? 'operation-action-unsupported' : 'operation-action-required';
  const single = new ChangeLog(base);
  const singleResult = single.applyOperation(raw);
  assert.equal(singleResult.status, 'rejected', `versioned action ${String(action)} must not bypass applyOperation validation`);
  assert.equal(singleResult.reason, expectedReason);
  assert.deepEqual(single.snapshot().facts, {});

  const batch = new ChangeLog(base);
  const batchResult = batch.applyBatch([raw]);
  assert.equal(batchResult.status, 'rejected', `versioned action ${String(action)} must not bypass applyBatch validation`);
  assert.equal(batchResult.reason, expectedReason);
  assert.deepEqual(batch.snapshot().facts, {});
}
const rawCanonical = { ...rawVersionedTemplate, operationId:'raw-canonical', action:'set' };
assert.equal(new ChangeLog(base).applyOperation(rawCanonical).status, 'applied', 'valid schema-versioned operations remain applicable');

const canonicalLog = new ChangeLog(base);
const canonicalSet = createProjectOperation({ ...base, operationId: 'canonical-set', targetEntityId: 'hex-entity:canonical', factKind: 'name', action: 'set', payload: 'alpha' });
const canonicalSet2 = createProjectOperation({ ...base, operationId: 'canonical-set-2', targetEntityId: 'hex-entity:canonical', factKind: 'name', action: 'set', payload: 'beta' });
assert.equal(canonicalLog.applyOperation(canonicalSet).status, 'applied');
assert.equal(canonicalLog.applyOperation(canonicalSet2).status, 'conflict');
const canonicalResolve = createProjectOperation({ ...base, operationId: 'canonical-resolve', targetEntityId: 'hex-entity:canonical', factKind: 'name', action: 'resolve', payload: { operationId: canonicalSet.operationId } });
assert.equal(canonicalLog.applyOperation(canonicalResolve).status, 'applied');
assert.equal(canonicalLog.snapshot().facts['hex-entity:canonical\u0000name'].resolvedOperationId, canonicalSet.operationId);

const resurrectionLog = new ChangeLog(base);
const target = 'hex-entity:resurrect';
const other = 'hex-entity:other';
assert.equal(resurrectionLog.applyOperation(createProjectOperation({ ...base, operationId: 'res-set', targetEntityId: target, factKind: 'bookmark', action: 'set', payload: 'before' })).status, 'applied');
assert.equal(resurrectionLog.applyOperation(createProjectOperation({ ...base, operationId: 'other-set', targetEntityId: other, factKind: 'bookmark', action: 'set', payload: 'other' })).status, 'applied');
assert.equal(resurrectionLog.applyOperation(createProjectOperation({ ...base, operationId: 'res-remove', targetEntityId: target, factKind: 'bookmark', action: 'remove' })).status, 'applied');
assert.equal(resurrectionLog.applyOperation(createProjectOperation({ ...base, operationId: 'other-remove', targetEntityId: other, factKind: 'bookmark', action: 'remove' })).status, 'applied');
assert.equal(resurrectionLog.applyOperation(createProjectOperation({ ...base, operationId: 'res-blocked-set', targetEntityId: target, factKind: 'bookmark', action: 'set', payload: 'blocked' })).status, 'unresolved');
assert.equal(resurrectionLog.applyOperation(createProjectOperation({ ...base, operationId: 'res-resurrect', targetEntityId: target, factKind: 'bookmark', action: 'resurrect', payload: 'restored' })).status, 'applied');
const afterResurrection = resurrectionLog.snapshot();
assert.equal(afterResurrection.tombstones.some((item) => item.key === `${target}\u0000bookmark`), false);
assert.equal(afterResurrection.tombstones.some((item) => item.key === `${other}\u0000bookmark`), true);
assert.equal(afterResurrection.unresolved.some((item) => item.key === `${target}\u0000bookmark` && item.reason === 'tombstone-protects-state'), false);
assert.equal(resurrectionLog.applyOperation(createProjectOperation({ ...base, operationId: 'res-after-set', targetEntityId: target, factKind: 'bookmark', action: 'set', payload: 'after' })).status, 'applied');

const checkpoint = createCheckpoint(log);
const restored = restoreCheckpoint(checkpoint, { ...base, operations: [nameA, nameB] });
assert.equal(restored.digest(), log.digest());
const withComment = new ChangeLog(base);
withComment.applyBatch([nameA, nameB, comment]);
const restoredWithComment = restoreCheckpoint(checkpoint, { ...base, operations: [nameA, nameB, comment] });
assert.equal(restoredWithComment.digest(), withComment.digest());
const replay = replayOperations({ ...base, operations: mergeOperations([nameA], [nameB, comment]) });
assert.equal(replay.status, 'applied');
assert.equal(replay.state.conflicts.length, 1);
console.log('[phase12] deterministic ChangeLog replay/conflict tests passed');
