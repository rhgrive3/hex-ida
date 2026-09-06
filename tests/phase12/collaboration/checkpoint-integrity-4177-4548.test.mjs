import assert from 'node:assert/strict';

import {
  ChangeLog,
  createCheckpoint,
  createProjectOperation,
  replayOperations,
  restoreCheckpoint,
} from '../../../js/collaboration/index.js';

const projectIdentity = 'checkpoint-integrity-4177';
const seed = createProjectOperation({
  projectIdentity,
  operationId: 'op:seed',
  targetEntityId: 'entity-1',
  factKind: 'name',
  action: 'set',
  payload: 'original',
});
const log = new ChangeLog({ projectIdentity });
assert.equal(log.applyOperation(seed).status, 'applied');

const checkpoint = createCheckpoint(log);
const validRestore = restoreCheckpoint(structuredClone(checkpoint), { projectIdentity });
assert.equal(validRestore.digest(), checkpoint.digest);
assert.deepEqual(validRestore.appliedOperationIds(), ['op:seed']);

function expectIntegrityFailure(candidate, runner = 'restore') {
  const invoke = runner === 'replay'
    ? () => replayOperations({ projectIdentity, checkpoint: candidate })
    : () => restoreCheckpoint(candidate, { projectIdentity });
  assert.throws(
    invoke,
    (error) => error instanceof TypeError && error.message === 'checkpoint-digest-mismatch',
  );
}

const tamperedState = structuredClone(checkpoint);
const [fact] = Object.values(tamperedState.state.facts);
fact.values[0].value = 'tampered';
expectIntegrityFailure(tamperedState);
expectIntegrityFailure(structuredClone(tamperedState), 'replay');

const addedOperationId = structuredClone(checkpoint);
addedOperationId.operationIds.push('op:forged');
expectIntegrityFailure(addedOperationId);

const removedOperationId = structuredClone(checkpoint);
removedOperationId.operationIds.pop();
expectIntegrityFailure(removedOperationId);

const tamperedDigest = structuredClone(checkpoint);
tamperedDigest.digest = `${tamperedDigest.digest}:tampered`;
expectIntegrityFailure(tamperedDigest);

const missingDigest = structuredClone(checkpoint);
missingDigest.digest = null;
expectIntegrityFailure(missingDigest);

for (const operationIds of [
  ['op:seed', 'op:seed'],
  [' op:seed '],
]) {
  const malformed = structuredClone(checkpoint);
  malformed.operationIds = operationIds;
  assert.throws(
    () => restoreCheckpoint(malformed, { projectIdentity }),
    (error) => error instanceof TypeError
      && ['checkpoint-operation-ids-invalid', 'checkpoint-operation-id-invalid'].includes(error.message),
  );
}

assert.throws(
  () => restoreCheckpoint(structuredClone(checkpoint), { projectIdentity: 'wrong-project' }),
  (error) => error instanceof Error && error.message === 'checkpoint-project-identity-mismatch',
);

const next = createProjectOperation({
  projectIdentity,
  operationId: 'op:next',
  targetEntityId: 'entity-2',
  factKind: 'type',
  action: 'set',
  payload: 'function',
});
const replayed = replayOperations({
  projectIdentity,
  checkpoint: structuredClone(checkpoint),
  operations: [next],
});
assert.equal(replayed.status, 'applied');
assert.equal(replayed.state.facts['entity-2\u0000type'].values[0].value, 'function');
assert.equal(typeof replayed.digest, 'string');
assert.ok(replayed.digest.length > 0);

console.log('collaboration checkpoint integrity #4177/#4548: PASS');
