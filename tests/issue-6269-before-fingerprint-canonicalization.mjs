import test from 'node:test';
import assert from 'node:assert/strict';

import { ChangeLog, createProjectOperation, mergeOperations } from '../js/collaboration/index.js';

const base = { projectIdentity: 'p', targetEntityId: 'e', factKind: 'name', action: 'set', payload: 'A' };

test('#6269 falsy beforeFingerprint values fail closed instead of aliasing null identity', () => {
  for (const bad of [0, false, '', '   ', NaN]) {
    assert.throws(
      () => createProjectOperation({ ...base, beforeFingerprint: bad }),
      (err) => err instanceof TypeError && err.message === 'operation-before-fingerprint-invalid',
      JSON.stringify(bad),
    );
  }
});

test('#6269 nullish beforeFingerprint keeps null semantics and deterministic auto id', () => {
  const explicitNull = createProjectOperation({ ...base, beforeFingerprint: null });
  const omitted = createProjectOperation({ ...base });
  const undefinedValue = createProjectOperation({ ...base, beforeFingerprint: undefined });
  assert.equal(explicitNull.beforeFingerprint, null);
  assert.equal(omitted.beforeFingerprint, null);
  assert.equal(undefinedValue.beforeFingerprint, null);
  assert.equal(explicitNull.operationId, omitted.operationId);
  assert.equal(explicitNull.operationId, undefinedValue.operationId);
});

test('#6269 valid fingerprint string keeps identical id material and stored value', () => {
  const op = createProjectOperation({ ...base, beforeFingerprint: 'fp:state-1' });
  assert.equal(op.beforeFingerprint, 'fp:state-1');
  const without = createProjectOperation({ ...base });
  assert.notEqual(op.operationId, without.operationId, 'precondition presence must change content identity');
});

test('#6269 no-precondition and precondition operations never share an auto id', () => {
  const noPrecondition = createProjectOperation({ ...base, beforeFingerprint: null });
  const preconditioned = createProjectOperation({ ...base, beforeFingerprint: 'fp:x' });
  assert.notEqual(noPrecondition.operationId, preconditioned.operationId);
});

test('#6269 reverse-order apply of distinct-precondition operations cannot diverge state', () => {
  const first = createProjectOperation({ ...base, beforeFingerprint: null, operationId: 'op:first' });
  const second = createProjectOperation({ ...base, beforeFingerprint: 'fp:missing', operationId: 'op:second' });
  const forward = new ChangeLog({ projectIdentity: 'p' });
  forward.applyOperation(first);
  forward.applyOperation(second);
  const backward = new ChangeLog({ projectIdentity: 'p' });
  backward.applyOperation(second);
  backward.applyOperation(first);
  assert.equal(backward.snapshot().facts['e\u0000name']?.values?.length, 1);
  assert.notEqual(backward.digest(), forward.digest(), 'distinct ids keep conflict semantics ordered, never collapsed');
});

test('#6269 mergeOperations keeps distinct identities for distinct preconditions', () => {
  const first = createProjectOperation({ ...base, beforeFingerprint: null, operationId: 'op:first' });
  const second = createProjectOperation({ ...base, beforeFingerprint: 'fp:x', operationId: 'op:second' });
  const merged = mergeOperations([first], [second]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((operation) => operation.operationId), ['op:first', 'op:second']);
});
