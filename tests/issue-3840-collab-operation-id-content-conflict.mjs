import test from 'node:test';
import assert from 'node:assert/strict';

import { ChangeLog, createProjectOperation, mergeOperations } from '../js/collaboration/index.js';

const sameId = (over = {}) => createProjectOperation({
  operationId: 'op:same',
  projectIdentity: 'p',
  targetEntityId: 'e',
  factKind: 'name',
  action: 'set',
  payload: 'A',
  ...over,
});

test('#3840 same operationId with identical content stays idempotent', () => {
  const log = new ChangeLog({ projectIdentity: 'p' });
  assert.equal(log.applyOperation(sameId()).status, 'applied');
  assert.equal(log.applyOperation(sameId()).status, 'duplicate');
  assert.deepEqual(log.snapshot().facts['e\u0000name'].values.map((item) => item.value), ['A']);
  assert.deepEqual(mergeOperations([sameId()], [sameId()]).map((operation) => operation.payload), ['A']);
});

test('#3840 same operationId with divergent payload is rejected, not a silent duplicate', () => {
  const log = new ChangeLog({ projectIdentity: 'p' });
  assert.equal(log.applyOperation(sameId()).status, 'applied');
  const result = log.applyOperation(sameId({ payload: 'B' }));
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'operation-id-content-mismatch');
  assert.deepEqual(log.snapshot().facts['e\u0000name'].values.map((item) => item.value), ['A']);
});

for (const [label, over] of [
  ['action', { action: 'remove' }],
  ['targetEntityId', { targetEntityId: 'other' }],
  ['factKind', { factKind: 'type' }],
]) {
  test(`#3840 same operationId with divergent ${label} is rejected, not a silent duplicate`, () => {
    const log = new ChangeLog({ projectIdentity: 'p' });
    assert.equal(log.applyOperation(sameId()).status, 'applied');
    const result = log.applyOperation(sameId(over));
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'operation-id-content-mismatch');
  });
}

test('#3840 mergeOperations never picks a side by argument order for divergent content', () => {
  const a = sameId();
  const b = sameId({ payload: 'B' });
  assert.throws(() => mergeOperations([a], [b]), TypeError);
  assert.throws(() => mergeOperations([b], [a]), TypeError);
});

test('#3840 distinct operations keep ordering and replay semantics', () => {
  const a = sameId();
  const b = sameId({ operationId: 'op:other', payload: 'B' });
  const merged = mergeOperations([b], [a]);
  assert.deepEqual(merged.map((operation) => operation.operationId), ['op:other', 'op:same']);
  const log = new ChangeLog({ projectIdentity: 'p' });
  assert.equal(log.applyBatch(merged).status, 'applied');
  assert.deepEqual(log.snapshot().facts['e\u0000name'].values.map((item) => item.value), ['B', 'A']);
});
