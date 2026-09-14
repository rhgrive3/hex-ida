import assert from 'node:assert/strict';
import {
  ChangeLog,
  createCheckpoint,
  createProjectOperation,
  replayOperations,
  restoreCheckpoint,
} from '../../../js/collaboration/index.js';

const base = { projectIdentity: 'p', binaryIdentity: null };
const seed = new ChangeLog(base);
seed.applyOperation(createProjectOperation({
  ...base,
  operationId: 'op:seed',
  targetEntityId: 'entity-1',
  factKind: 'name',
  action: 'set',
  payload: 'original',
}));
const checkpoint = createCheckpoint(seed);
const key = 'entity-1\u0000name';

{
  const restored = restoreCheckpoint(structuredClone(checkpoint), base);
  assert.equal(restored.digest(), checkpoint.digest, 'untampered checkpoint must restore');
  assert.equal(restored.snapshot().facts[key].values[0].value, 'original');
  const replayed = replayOperations({ ...base, checkpoint: structuredClone(checkpoint) });
  assert.equal(replayed.digest, checkpoint.digest, 'untampered checkpoint must replay');
  assert.equal(replayed.state.facts[key].values[0].value, 'original');
}

{
  const next = createProjectOperation({
    ...base,
    operationId: 'op:next',
    targetEntityId: 'entity-2',
    factKind: 'name',
    action: 'set',
    payload: 'next',
  });
  const replayed = replayOperations({ ...base, checkpoint: structuredClone(checkpoint), operations: [next] });
  assert.equal(replayed.status, 'applied', 'valid checkpoint replay must admit new operations');
  assert.equal(replayed.state.facts[key].values[0].value, 'original', 'checkpoint facts must survive replay with new operations');
  assert.equal(replayed.state.facts['entity-2\u0000name'].values[0].value, 'next', 'new replay operations must be applied losslessly');
}

{
  const invalidSchema = structuredClone(checkpoint);
  invalidSchema.schemaVersion = 'forged-checkpoint-v2';
  assert.throws(
    () => replayOperations({ ...base, checkpoint: invalidSchema }),
    /checkpoint-schema-invalid/,
    'replay must reject a checkpoint with an invalid schema before trusting its contents',
  );
}

{
  const tampered = structuredClone(checkpoint);
  tampered.state.facts[key].values[0].value = 'tampered';
  assert.throws(
    () => restoreCheckpoint(tampered, base),
    /checkpoint-digest-mismatch/,
    'state mutation with the old digest must fail closed',
  );
  assert.throws(
    () => replayOperations({ ...base, checkpoint: tampered }),
    /checkpoint-digest-mismatch/,
    'replay must enforce the same checkpoint integrity boundary',
  );
}

{
  const tampered = structuredClone(checkpoint);
  tampered.operationIds.push('op:forged');
  assert.throws(
    () => restoreCheckpoint(tampered, base),
    /checkpoint-digest-mismatch/,
    'operation ID mutation with the old digest must fail closed',
  );
}

{
  const tampered = structuredClone(checkpoint);
  tampered.operationIds.pop();
  assert.throws(
    () => restoreCheckpoint(tampered, base),
    /checkpoint-digest-mismatch/,
    'operation ID deletion with the old digest must fail closed',
  );
}

{
  const tampered = structuredClone(checkpoint);
  tampered.digest = `${checkpoint.digest}0`;
  assert.throws(
    () => restoreCheckpoint(tampered, base),
    /checkpoint-digest-mismatch/,
    'digest mutation must fail closed',
  );
}

{
  const originalState = structuredClone(checkpoint.state);
  const tamperedState = structuredClone(checkpoint.state);
  tamperedState.facts[key].values[0].value = 'late-tamper';
  let stateReads = 0;
  const switching = { ...structuredClone(checkpoint) };
  Object.defineProperty(switching, 'state', {
    enumerable: true,
    get() {
      stateReads += 1;
      return stateReads < 3 ? originalState : tamperedState;
    },
  });
  const restored = restoreCheckpoint(switching, base);
  assert.equal(restored.snapshot().facts[key].values[0].value, 'original', 'restore must use the exact state snapshot whose digest was checked');
  assert.equal(stateReads, 1, 'checkpoint state authority must be captured once');
}

{
  const reorderedSeed = new ChangeLog(base);
  for (const [operationId, targetEntityId] of [['op:z', 'z'], ['op:a', 'a']]) {
    reorderedSeed.applyOperation(createProjectOperation({
      ...base, operationId, targetEntityId, factKind: 'name', action: 'set', payload: operationId,
    }));
  }
  const reordered = structuredClone(createCheckpoint(reorderedSeed));
  reordered.operationIds.reverse();
  const restored = restoreCheckpoint(reordered, base);
  assert.equal(restored.digest(), reordered.digest, 'operation ID storage order is normalized before integrity comparison');
}

{
  const nonCanonical = structuredClone(checkpoint);
  nonCanonical.operationIds[0] = ` ${nonCanonical.operationIds[0]} `;
  assert.throws(() => restoreCheckpoint(nonCanonical, base), /checkpoint-operation-id-invalid/);
}

{
  const snapshot = structuredClone(checkpoint);
  let operationIdReads = 0;
  Object.defineProperty(snapshot, 'operationIds', {
    enumerable: true,
    get() {
      operationIdReads += 1;
      return operationIdReads === 1 ? [...checkpoint.operationIds] : ['op:forged'];
    },
  });
  const restored = restoreCheckpoint(snapshot, base);
  assert.equal(restored.digest(), checkpoint.digest, 'restore must use the operation ID snapshot whose digest was checked');
  assert.equal(operationIdReads, 1, 'checkpoint operation IDs must be captured once');
}

console.log('[issue-4177] checkpoint digest validation regression passed');
