import assert from 'node:assert/strict';
import {
  ChangeLog,
  createProjectOperation,
  mergeOperations,
  orderOperations,
} from '../../../js/collaboration/index.js';

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
  '\u0000',
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
  () => createProjectOperation({ ...base, factKind: 'na\u0000me' }),
  /operation-fact-kind-required/,
);
assert.throws(
  () => new ChangeLog({ projectIdentity: { id: 'project' } }),
  /changelog-project-identity-required/,
);
assert.throws(
  () => new ChangeLog({ projectIdentity: 'hex-project:p', binaryIdentity: ['binary'] }),
  /changelog-binary-identity-invalid/,
);

const validRestoredState = {
  schemaVersion: 'hex-project-operation-v1',
  projectIdentity: 'hex-project:p',
  binaryIdentity: null,
  facts: {},
  conflicts: [],
  tombstones: [],
  unresolved: [],
};
assert.throws(
  () => new ChangeLog({
    projectIdentity: 'hex-project:p',
    state: { ...validRestoredState, projectIdentity: 'hex-project:other' },
  }),
  /changelog-state-project-identity-mismatch/,
  'restored state must belong to the ChangeLog project',
);
assert.throws(
  () => new ChangeLog({
    projectIdentity: 'hex-project:p',
    binaryIdentity: 'hex-binary:p:b:macho:arm64',
    state: { ...validRestoredState, binaryIdentity: 'hex-binary:p:other:macho:arm64' },
  }),
  /changelog-state-binary-identity-mismatch/,
  'restored state must belong to the ChangeLog binary',
);
for (const state of [false, 0, '']) {
  assert.throws(
    () => new ChangeLog({ projectIdentity: 'hex-project:p', state }),
    /changelog-state-invalid/,
    'only nullish state may fall back to an empty ChangeLog state',
  );
}

const legacyCollidingKey = 'a\u0000b\u0000c';
assert.throws(
  () => new ChangeLog({
    projectIdentity: 'hex-project:p',
    state: {
      schemaVersion: 'hex-project-operation-v1',
      projectIdentity: 'hex-project:p',
      binaryIdentity: null,
      facts: {
        [legacyCollidingKey]: {
          key: legacyCollidingKey,
          targetEntityId: 'a\u0000b',
          factKind: 'c',
          values: [],
          resolvedOperationId: null,
          stateFingerprint: null,
        },
      },
      conflicts: [],
      tombstones: [],
      unresolved: [],
    },
  }),
  /changelog-state-target-entity-invalid/,
  'restored state must not reintroduce the reserved fact-key separator through an identity component',
);

const rawSchemaTaggedStructured = {
  ...base,
  schemaVersion: 'hex-project-operation-v1',
  operationId: 'op:raw-structured',
  targetEntityId: ['hex-entity:e'],
};
const ingressCases = [
  ['orderOperations', () => orderOperations([rawSchemaTaggedStructured])],
  ['applyOperation', () => new ChangeLog({ projectIdentity: base.projectIdentity, binaryIdentity: base.binaryIdentity }).applyOperation(rawSchemaTaggedStructured)],
  ['applyBatch', () => new ChangeLog({ projectIdentity: base.projectIdentity, binaryIdentity: base.binaryIdentity }).applyBatch([rawSchemaTaggedStructured])],
  ['mergeOperations', () => mergeOperations([rawSchemaTaggedStructured], [])],
];
for (const [name, run] of ingressCases) {
  assert.throws(
    run,
    /operation-target-entity-required/,
    `${name} must not trust schemaVersion as proof of canonical identity validation`,
  );
}

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

const canonical = createProjectOperation({ ...base, operationId: 'op:canonical' });
assert.equal(orderOperations([canonical]).ordered[0].operationId, 'op:canonical');
assert.deepEqual(mergeOperations([canonical], []).map((operation) => operation.operationId), ['op:canonical']);
assert.equal(
  new ChangeLog({ projectIdentity: base.projectIdentity, binaryIdentity: base.binaryIdentity }).applyOperation(canonical).status,
  'applied',
);
assert.equal(
  new ChangeLog({ projectIdentity: base.projectIdentity, binaryIdentity: base.binaryIdentity }).applyBatch([canonical]).status,
  'applied',
);

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

const tombstoneLog = new ChangeLog({ projectIdentity: 'hex-project:p' });
assert.equal(tombstoneLog.applyOperation(entityA).status, 'applied');
const removeEntityA = createProjectOperation({
  projectIdentity: 'hex-project:p',
  operationId: 'op:entity-a-remove',
  targetEntityId: 'entity:A',
  factKind: 'name',
  action: 'remove',
});
assert.equal(tombstoneLog.applyOperation(removeEntityA).status, 'applied');
assert.equal(tombstoneLog.snapshot().facts['entity:A\u0000name'], undefined);
assert.deepEqual(
  tombstoneLog.snapshot().tombstones.map(({ key, targetEntityId, factKind }) => ({ key, targetEntityId, factKind })),
  [{ key: 'entity:A\u0000name', targetEntityId: 'entity:A', factKind: 'name' }],
);

console.log('[phase12] ChangeLog strict identity regression #3622 passed');
