import assert from 'node:assert/strict';
import { ChangeLog, createProjectOperation } from '../../../js/collaboration/index.js';

const base = {
  projectIdentity: 'hex-project:p',
  binaryIdentity: 'hex-binary:p:b:macho:arm64',
  targetEntityId: 'hex-entity:e',
  factKind: 'name',
  action: 'set',
  payload: 'value',
};

const invalidIdentities = [
  { id: 'object' },
  ['array'],
  7,
  0,
  true,
  false,
  '',
  '   ',
];

for (const value of invalidIdentities) {
  assert.throws(
    () => createProjectOperation({ ...base, projectIdentity: value }),
    /operation-project-identity-required/,
  );
  assert.throws(
    () => createProjectOperation({ ...base, targetEntityId: value }),
    /operation-target-entity-required/,
  );
  assert.throws(
    () => createProjectOperation({ ...base, binaryIdentity: value }),
    /operation-binary-identity-invalid/,
  );
  assert.throws(
    () => createProjectOperation({ ...base, authorIdentity: value }),
    /operation-author-identity-invalid/,
  );
  assert.throws(
    () => createProjectOperation({ ...base, deviceIdentity: value }),
    /operation-device-identity-invalid/,
  );
  assert.throws(
    () => createProjectOperation({ ...base, operationId: value }),
    /operation-id-required/,
  );
}

assert.throws(
  () => new ChangeLog({ projectIdentity: { id: 'project' } }),
  /changelog-project-identity-required/,
);
assert.throws(
  () => new ChangeLog({ projectIdentity: 'hex-project:p', binaryIdentity: ['binary'] }),
  /changelog-binary-identity-invalid/,
);

const normalized = createProjectOperation({
  ...base,
  projectIdentity: '  hex-project:p  ',
  binaryIdentity: '  hex-binary:p:b:macho:arm64  ',
  targetEntityId: '  hex-entity:e  ',
  authorIdentity: '  actor:a  ',
  deviceIdentity: '  device:a  ',
  operationId: '  op:a  ',
});
assert.equal(normalized.projectIdentity, 'hex-project:p');
assert.equal(normalized.binaryIdentity, 'hex-binary:p:b:macho:arm64');
assert.equal(normalized.targetEntityId, 'hex-entity:e');
assert.equal(normalized.authorIdentity, 'actor:a');
assert.equal(normalized.deviceIdentity, 'device:a');
assert.equal(normalized.operationId, 'op:a');

const log = new ChangeLog({ projectIdentity: 'hex-project:p' });
const entityA = createProjectOperation({
  projectIdentity: 'hex-project:p',
  operationId: 'op:entity-a',
  targetEntityId: 'entity:A',
  factKind: 'name',
  action: 'set',
  payload: 'Alpha',
});
const entityB = createProjectOperation({
  projectIdentity: 'hex-project:p',
  operationId: 'op:entity-b',
  targetEntityId: 'entity:B',
  factKind: 'name',
  action: 'set',
  payload: 'Beta',
});
assert.equal(log.applyOperation(entityA).status, 'applied');
assert.equal(log.applyOperation(entityB).status, 'applied');
assert.deepEqual(
  Object.keys(log.snapshot().facts).sort(),
  ['entity:A\u0000name', 'entity:B\u0000name'],
);

console.log('[phase12] ChangeLog strict identity regression #3622 passed');
