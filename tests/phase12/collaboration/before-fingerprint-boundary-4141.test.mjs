import assert from 'node:assert/strict';

import {
  ChangeLog,
  createProjectOperation,
} from '../../../js/collaboration/index.js';

const projectIdentity = 'project-before-fingerprint-4141';
const targetEntityId = 'entity-1';
const factKind = 'comment';
const key = `${targetEntityId}\u0000${factKind}`;
const base = {
  projectIdentity,
  targetEntityId,
  factKind,
  action: 'set',
};

const log = new ChangeLog({ projectIdentity });
assert.equal(log.applyOperation(createProjectOperation({
  ...base,
  operationId: 'op:seed',
  payload: 'seed',
})).status, 'applied');

const fingerprint = log.snapshot().facts[key].stateFingerprint;
assert.equal(typeof fingerprint, 'string');
assert.ok(fingerprint.length > 0);

const guarded = createProjectOperation({
  ...base,
  operationId: 'op:guarded',
  payload: 'next',
  beforeFingerprint: fingerprint,
});
assert.equal(guarded.beforeFingerprint, fingerprint);
assert.equal(log.applyOperation(guarded).status, 'applied');

const stale = createProjectOperation({
  ...base,
  operationId: 'op:stale',
  payload: 'stale',
  beforeFingerprint: fingerprint,
});
const staleResult = log.applyOperation(stale);
assert.equal(staleResult.status, 'conflict');
assert.equal(staleResult.reason, 'stale-before-fingerprint');

let coercionCalls = 0;
const hostile = {
  toString() {
    coercionCalls += 1;
    return fingerprint;
  },
};

for (const invalid of [
  [fingerprint],
  { value: fingerprint },
  hostile,
  1,
  true,
  '',
  '   ',
]) {
  assert.throws(
    () => createProjectOperation({
      ...base,
      operationId: `op:invalid-${coercionCalls}`,
      payload: 'invalid',
      beforeFingerprint: invalid,
    }),
    (error) => error instanceof TypeError
      && error.message === 'operation-before-fingerprint-invalid',
  );
}
assert.equal(coercionCalls, 0, 'beforeFingerprint must not invoke caller-controlled coercion');

let reads = 0;
const statefulInput = {
  ...base,
  operationId: 'op:stateful',
  payload: 'stateful',
  get beforeFingerprint() {
    reads += 1;
    return reads === 1 ? [fingerprint] : fingerprint;
  },
};
assert.throws(
  () => createProjectOperation(statefulInput),
  (error) => error instanceof TypeError
    && error.message === 'operation-before-fingerprint-invalid',
);
assert.equal(reads, 1, 'beforeFingerprint must be snapshotted exactly once');

assert.equal(createProjectOperation({
  ...base,
  operationId: 'op:null',
  payload: 'null',
  beforeFingerprint: null,
}).beforeFingerprint, null);
assert.equal(createProjectOperation({
  ...base,
  operationId: 'op:undefined',
  payload: 'undefined',
  beforeFingerprint: undefined,
}).beforeFingerprint, null);

const padded = ` ${fingerprint} `;
assert.equal(createProjectOperation({
  ...base,
  operationId: 'op:padded',
  payload: 'padded',
  beforeFingerprint: padded,
}).beforeFingerprint, padded, 'valid string representation is preserved exactly');

console.log('collaboration beforeFingerprint boundary #4141: PASS');
