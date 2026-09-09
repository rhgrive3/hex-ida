import assert from 'node:assert/strict';

import {
  ChangeLog,
  canonicalizeProjectOperation,
  createProjectOperation,
  restoreCheckpoint,
} from '../../../js/collaboration/index.js';

const NUL = '\u0000';

function operation(operationId, input) {
  return createProjectOperation({
    projectIdentity: 'issue-4528-project',
    operationId,
    action: 'set',
    ...input,
  });
}

const collidingTuples = [
  { targetEntityId: `a${NUL}b`, factKind: 'c' },
  { targetEntityId: 'a', factKind: `b${NUL}c` },
];
for (const [index, tuple] of collidingTuples.entries()) {
  assert.throws(
    () => operation(`nul-${index}`, { ...tuple, payload: `value-${index}` }),
    /operation-(target-entity|fact-kind)-required/,
    'NUL-containing identity components must never become fact keys',
  );
}

const malformedRemote = {
  projectIdentity: 'issue-4528-project',
  operationId: 'nul-remote',
  targetEntityId: `a${NUL}b`,
  factKind: 'c',
  action: 'set',
  payload: 'remote',
};
assert.equal(canonicalizeProjectOperation(malformedRemote), null);
assert.throws(() => new ChangeLog({ projectIdentity: 'issue-4528-project' }).applyOperation(malformedRemote));

const log = new ChangeLog({ projectIdentity: 'issue-4528-project' });
const name = operation('name-1', { targetEntityId: 'entity-a', factKind: 'name', payload: 'Alice' });
const type = operation('type-1', { targetEntityId: 'entity-a', factKind: 'type', payload: 'user' });
assert.equal(log.applyOperation(name).status, 'applied');
assert.equal(log.applyOperation(type).status, 'applied');
assert.equal(Object.keys(log.snapshot().facts).length, 2, 'different fact kinds must have distinct state records');

const typeKey = `entity-a${NUL}type`;
const nameKey = `entity-a${NUL}name`;
const typeFingerprint = log.snapshot().facts[typeKey].stateFingerprint;
const staleType = createProjectOperation({
  projectIdentity: 'issue-4528-project',
  operationId: 'type-stale',
  targetEntityId: 'entity-a',
  factKind: 'type',
  action: 'set',
  beforeFingerprint: 'stale',
  payload: 'admin',
});
assert.equal(log.applyOperation(staleType).status, 'conflict');
assert.equal(log.snapshot().facts[nameKey].values[0].value, 'Alice', 'stale precondition must not cross fact keys');
assert.equal(log.snapshot().facts[typeKey].stateFingerprint, typeFingerprint, 'stale precondition must not mutate the other fact');

const removeName = createProjectOperation({
  projectIdentity: 'issue-4528-project',
  operationId: 'name-remove',
  targetEntityId: 'entity-a',
  factKind: 'name',
  action: 'remove',
});
assert.equal(log.applyOperation(removeName).status, 'applied');
assert.equal(log.snapshot().facts[nameKey], undefined, 'remove must delete only its own fact key');
assert.equal(log.snapshot().facts[typeKey].values[0].value, 'user', 'remove must not delete a neighboring fact');
const blockedName = operation('name-after-remove', { targetEntityId: 'entity-a', factKind: 'name', payload: 'Bob' });
assert.equal(log.applyOperation(blockedName).status, 'unresolved', 'the name tombstone must remain scoped to name');
assert.equal(log.snapshot().facts[typeKey].values[0].value, 'user', 'tombstone must not block a neighboring fact');

const checkpoint = log.checkpoint();
const restored = restoreCheckpoint(checkpoint, { projectIdentity: 'issue-4528-project' });
assert.deepEqual(restored.snapshot(), log.snapshot(), 'valid checkpoint restore must preserve separated facts');

const malformedStateKey = `a${NUL}b${NUL}c`;
const malformedState = {
  schemaVersion: 'hex-project-operation-v1',
  projectIdentity: 'issue-4528-project',
  binaryIdentity: null,
  facts: {
    [malformedStateKey]: {
      key: malformedStateKey,
      targetEntityId: `a${NUL}b`,
      factKind: 'c',
      values: [],
      resolvedOperationId: null,
      stateFingerprint: null,
    },
  },
  conflicts: [],
  tombstones: [],
  unresolved: [],
};
assert.throws(
  () => new ChangeLog({ projectIdentity: 'issue-4528-project', state: malformedState }),
  /changelog-state-(target-entity|fact-kind)-invalid/,
  'restored state must reject malformed tuple components',
);
assert.throws(
  () => restoreCheckpoint({ ...checkpoint, state: malformedState }, { projectIdentity: 'issue-4528-project' }),
  /changelog-state-(target-entity|fact-kind)-invalid/,
  'checkpoint import must not bypass fact-key validation',
);

console.log('issue #4528 fact-key separator collision regressions: PASS');
