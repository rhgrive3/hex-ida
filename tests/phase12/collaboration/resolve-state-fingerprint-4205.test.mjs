import assert from 'node:assert/strict';
import {
  ChangeLog,
  createCheckpoint,
  createProjectOperation,
  restoreCheckpoint,
} from '../../../js/collaboration/index.js';

const projectIdentity = 'project:4205';
const targetEntityId = 'entity:4205';
const factKind = 'comment';
const key = `${targetEntityId}\u0000${factKind}`;
const base = { projectIdentity, targetEntityId, factKind };
const op = (operationId, action, payload, beforeFingerprint = null) => createProjectOperation({
  ...base,
  operationId,
  action,
  payload,
  beforeFingerprint,
});

const log = new ChangeLog({ projectIdentity });
assert.equal(log.applyOperation(op('set:a', 'set', 'A')).status, 'applied');
assert.equal(log.applyOperation(op('set:b', 'set', 'B')).status, 'applied');
const beforeResolve = log.snapshot().facts[key].stateFingerprint;

const resolveA = op('resolve:a', 'resolve', { operationId: 'set:a' });
assert.equal(log.applyOperation(resolveA).status, 'applied');
const afterResolveA = log.snapshot().facts[key];
assert.equal(afterResolveA.resolvedOperationId, 'set:a');
assert.notEqual(afterResolveA.stateFingerprint, beforeResolve,
  'resolving a fact must invalidate the pre-resolution CAS fingerprint');

const staleResolve = log.applyOperation(op(
  'resolve:stale',
  'resolve',
  { operationId: 'set:b' },
  beforeResolve,
));
assert.equal(staleResolve.status, 'conflict');
assert.equal(staleResolve.reason, 'stale-before-fingerprint');
assert.equal(log.snapshot().facts[key].resolvedOperationId, 'set:a',
  'a stale competing resolution must not replace the selected winner');

const beforeMissingTarget = log.snapshot().facts[key].stateFingerprint;
const missingTarget = log.applyOperation(op(
  'resolve:missing',
  'resolve',
  { operationId: 'set:missing' },
  beforeMissingTarget,
));
assert.equal(missingTarget.status, 'rejected');
assert.equal(missingTarget.reason, 'resolution-target-missing');
assert.equal(log.snapshot().facts[key].stateFingerprint, beforeMissingTarget,
  'a rejected resolution must not mutate the fact fingerprint');

const beforeStaleAttempt = structuredClone(log.snapshot().facts[key]);
const stale = log.applyOperation(op('set:stale', 'set', 'stale', beforeResolve));
assert.equal(stale.status, 'conflict');
assert.equal(stale.reason, 'stale-before-fingerprint');
assert.deepEqual(log.snapshot().facts[key], beforeStaleAttempt,
  'stale writes must not mutate the resolved fact');

const afterResolveFingerprint = log.snapshot().facts[key].stateFingerprint;
const fresh = log.applyOperation(op('set:fresh', 'set', 'fresh', afterResolveFingerprint));
assert.equal(fresh.status, 'applied');
assert.equal(log.snapshot().facts[key].resolvedOperationId, 'set:a');
assert.notEqual(log.snapshot().facts[key].stateFingerprint, afterResolveFingerprint,
  'adding a value after resolution must advance the fact fingerprint');

const beforeDuplicate = log.snapshot().facts[key].stateFingerprint;
assert.equal(log.applyOperation(resolveA).status, 'duplicate');
assert.equal(log.snapshot().facts[key].stateFingerprint, beforeDuplicate,
  'duplicate resolution delivery must not perturb semantic state identity');

const resolveAAgain = op('resolve:a-again', 'resolve', { operationId: 'set:a' });
assert.equal(log.applyOperation(resolveAAgain).status, 'applied');
assert.equal(log.snapshot().facts[key].stateFingerprint, beforeDuplicate,
  'a distinct operation selecting the same winner must preserve the semantic fingerprint');

const resolveB = op('resolve:b', 'resolve', { operationId: 'set:b' }, beforeDuplicate);
assert.equal(log.applyOperation(resolveB).status, 'applied');
assert.equal(log.snapshot().facts[key].resolvedOperationId, 'set:b');
assert.notEqual(log.snapshot().facts[key].stateFingerprint, beforeDuplicate,
  'changing the selected winner must change the semantic fingerprint');

const checkpoint = createCheckpoint(log);
const restored = restoreCheckpoint(checkpoint, { projectIdentity });
assert.deepEqual(restored.snapshot().facts[key], log.snapshot().facts[key],
  'checkpoint round-trip must preserve resolved fact fingerprint semantics');
assert.equal(restored.digest(), log.digest());

console.log('collaboration resolve stateFingerprint #4205: PASS');
