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

function statefulCheckpoint() {
  const original = structuredClone(checkpoint.state);
  const altered = structuredClone(original);
  const [fact] = Object.values(altered.facts);
  fact.values[0].value = 'accessor-tampered';
  let reads = 0;
  let operationReads = 0;
  const candidate = {
    schemaVersion: checkpoint.schemaVersion,
    projectIdentity: checkpoint.projectIdentity,
    binaryIdentity: checkpoint.binaryIdentity,
    digest: checkpoint.digest,
    get operationIds() {
      operationReads += 1;
      return operationReads === 1
        ? checkpoint.operationIds
        : [...checkpoint.operationIds, 'op:forged'];
    },
    get state() {
      reads += 1;
      return reads === 1 ? original : altered;
    },
  };
  return { candidate, reads: () => reads, operationReads: () => operationReads, original };
}

{
  const { candidate, reads, operationReads, original } = statefulCheckpoint();
  const restored = restoreCheckpoint(candidate, { projectIdentity });
  assert.equal(reads(), 1, 'restore must own checkpoint state before validation');
  assert.equal(operationReads(), 1, 'restore must own checkpoint operation ids before validation');
  assert.equal(restored.state.facts['entity-1\u0000name'].values[0].value, original.facts['entity-1\u0000name'].values[0].value);
}

{
  const { candidate, reads, operationReads, original } = statefulCheckpoint();
  const replayedStateful = replayOperations({ projectIdentity, checkpoint: candidate });
  assert.equal(reads(), 1, 'replay must own checkpoint state before validation');
  assert.equal(operationReads(), 1, 'replay must own checkpoint operation ids before validation');
  assert.equal(replayedStateful.state.facts['entity-1\u0000name'].values[0].value, original.facts['entity-1\u0000name'].values[0].value);
}

console.log('collaboration checkpoint integrity #4177/#4548: PASS');
