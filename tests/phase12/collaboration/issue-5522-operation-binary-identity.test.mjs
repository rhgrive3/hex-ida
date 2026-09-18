import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ChangeLog,
  createProjectOperation,
} from '../../../js/collaboration/index.js';
import { createRemoteCollaborationEnvelope } from '../../../js/collaboration/remote-authority.js';

const base = {
  projectIdentity: 'project:5522',
  targetEntityId: 'entity:5522',
  factKind: 'name',
  action: 'set',
  payload: 'same-value',
};

test('#5522 generated operationId uses canonical binary identity', () => {
  const canonical = createProjectOperation({ ...base, binaryIdentity: 'binary:5522' });
  const padded = createProjectOperation({ ...base, binaryIdentity: '  binary:5522  ' });

  assert.equal(canonical.binaryIdentity, 'binary:5522');
  assert.equal(padded.binaryIdentity, 'binary:5522');
  assert.equal(padded.operationId, canonical.operationId);
});

test('#5522 canonical-equivalent operations do not fork ChangeLog history identity', () => {
  const canonical = createProjectOperation({ ...base, binaryIdentity: 'binary:5522' });
  const padded = createProjectOperation({ ...base, binaryIdentity: '  binary:5522  ' });
  const log = new ChangeLog({ projectIdentity: base.projectIdentity, binaryIdentity: 'binary:5522' });

  assert.equal(log.applyOperation(canonical).status, 'applied');
  const afterFirst = log.digest();
  assert.equal(log.applyOperation(padded).status, 'duplicate');
  assert.equal(log.digest(), afterFirst);
  assert.deepEqual(log.appliedOperationIds(), [canonical.operationId]);
});

test('#5522 distinct canonical binary identities remain distinct', () => {
  const a = createProjectOperation({ ...base, binaryIdentity: 'binary:A' });
  const b = createProjectOperation({ ...base, binaryIdentity: 'binary:B' });
  const noneA = createProjectOperation({ ...base, binaryIdentity: null });
  const noneB = createProjectOperation({ ...base });

  assert.notEqual(a.operationId, b.operationId);
  assert.notEqual(a.operationId, noneA.operationId);
  assert.equal(noneA.binaryIdentity, null);
  assert.equal(noneA.operationId, noneB.operationId);
});

test('#5522 generated identity captures binaryIdentity exactly once', () => {
  let reads = 0;
  const input = { ...base };
  Object.defineProperty(input, 'binaryIdentity', {
    enumerable: true,
    get() {
      reads += 1;
      return reads === 1 ? '  binary:5522  ' : 'binary:changed';
    },
  });

  const operation = createProjectOperation(input);
  const expected = createProjectOperation({ ...base, binaryIdentity: 'binary:5522' });
  assert.equal(reads, 1);
  assert.equal(operation.binaryIdentity, 'binary:5522');
  assert.equal(operation.operationId, expected.operationId);
});

test('#5522 generated identity captures causal parents once with the same canonical material', () => {
  let reads = 0;
  const input = { ...base, binaryIdentity: 'binary:5522' };
  Object.defineProperty(input, 'causalParents', {
    enumerable: true,
    get() {
      reads += 1;
      return reads === 1 ? [' parent:a ', 'parent:a'] : ['parent:b'];
    },
  });

  const operation = createProjectOperation(input);
  const expected = createProjectOperation({
    ...base,
    binaryIdentity: 'binary:5522',
    causalParents: ['parent:a'],
  });
  assert.equal(reads, 1);
  assert.deepEqual(operation.causalParents, ['parent:a']);
  assert.equal(operation.operationId, expected.operationId);
});

test('#5522 remote envelope keeps the same canonical binary identity contract', () => {
  const envelope = createRemoteCollaborationEnvelope({
    projectIdentity: base.projectIdentity,
    binaryIdentity: '  binary:5522  ',
    sessionIdentity: 'session:5522',
    actorIdentity: 'actor:5522',
    deviceIdentity: 'device:5522',
    messageId: 'message:5522',
    sequence: 1,
    operations: [{
      targetEntityId: base.targetEntityId,
      factKind: base.factKind,
      action: base.action,
      payload: base.payload,
    }],
  });
  const direct = createProjectOperation({ ...base, binaryIdentity: 'binary:5522' });

  assert.equal(envelope.binaryIdentity, 'binary:5522');
  assert.equal(envelope.operations[0].binaryIdentity, 'binary:5522');
  assert.equal(envelope.operations[0].operationId, direct.operationId);
});

test('#5522 nullish binary identity is captured once without late relabeling', () => {
  let reads = 0;
  const input = { ...base };
  Object.defineProperty(input, 'binaryIdentity', {
    enumerable: true,
    get() {
      reads += 1;
      return reads === 1 ? null : 'binary:late';
    },
  });

  const operation = createProjectOperation(input);
  const omitted = createProjectOperation({ ...base });
  assert.equal(reads, 1);
  assert.equal(operation.binaryIdentity, null);
  assert.equal(operation.operationId, omitted.operationId);
});

test('#5522 explicit operationId validation still precedes later identity validation', () => {
  assert.throws(
    () => createProjectOperation({ ...base, operationId: '', binaryIdentity: [] }),
    /operation-id-required/,
  );
});
