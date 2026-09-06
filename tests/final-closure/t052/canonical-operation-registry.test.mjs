import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHANGELOG_SCHEMA_VERSION,
  ChangeLog,
  canonicalizeProjectOperation,
  createProjectOperation,
  isCanonicalProjectOperation,
  mergeOperations,
  orderOperations,
} from '../../../js/collaboration/index.js';

const base = Object.freeze({
  projectIdentity: 'project:t052',
  binaryIdentity: null,
  targetEntityId: 'entity:t052',
  factKind: 'name',
  action: 'set',
  payload: 'alpha',
});

function rawOperation(operationId, overrides = {}) {
  return {
    schemaVersion: CHANGELOG_SCHEMA_VERSION,
    operationId,
    causalParents: [],
    provenance: { source: 'local' },
    ...base,
    ...overrides,
  };
}

test('T052 canonical operation identity is private and structurally unforgeable', () => {
  const canonical = createProjectOperation({ ...base, operationId: 'op:canonical' });
  const forged = { ...canonical };

  assert.equal(isCanonicalProjectOperation(canonical), true);
  assert.equal(canonicalizeProjectOperation(canonical), canonical);
  assert.equal(isCanonicalProjectOperation(forged), false);
  assert.equal(isCanonicalProjectOperation({ ...forged, normalized: true }), false);

  const normalized = canonicalizeProjectOperation(forged);
  assert.notEqual(normalized, forged, 'normalization must create a separately branded value');
  assert.equal(isCanonicalProjectOperation(forged), false, 'normalization must never brand caller-owned input');
  assert.equal(isCanonicalProjectOperation(normalized), true);
  assert.equal(Object.isFrozen(normalized), true);

  const invalid = canonicalizeProjectOperation({ ...forged, action: 'add' });
  assert.equal(isCanonicalProjectOperation(invalid), false);
  assert.equal(invalid.normalized, false);
  assert.equal(invalid.error?.message, 'operation-action-unsupported');
});

test('T052 every public operation ingress canonicalizes raw current-schema values', () => {
  const applyRaw = rawOperation('op:apply');
  const single = new ChangeLog({ projectIdentity: base.projectIdentity });
  assert.equal(single.applyOperation(applyRaw).status, 'applied');
  assert.notEqual(single.operations.get('op:apply'), applyRaw);
  assert.equal(isCanonicalProjectOperation(single.operations.get('op:apply')), true);

  const batchRaw = rawOperation('op:batch', { targetEntityId: 'entity:batch' });
  const batch = new ChangeLog({ projectIdentity: base.projectIdentity });
  assert.equal(batch.applyBatch([batchRaw]).status, 'applied');
  assert.notEqual(batch.operations.get('op:batch'), batchRaw);
  assert.equal(isCanonicalProjectOperation(batch.operations.get('op:batch')), true);

  const orderRaw = rawOperation('op:order', { targetEntityId: 'entity:order' });
  const ordered = orderOperations([orderRaw]).ordered[0];
  assert.notEqual(ordered, orderRaw);
  assert.equal(isCanonicalProjectOperation(ordered), true);

  const mergeRaw = rawOperation('op:merge', { targetEntityId: 'entity:merge' });
  const merged = mergeOperations([mergeRaw])[0];
  assert.notEqual(merged, mergeRaw);
  assert.equal(isCanonicalProjectOperation(merged), true);
});

test('T052 malformed and unsupported raw operations fail closed without mutation', () => {
  const log = new ChangeLog({ projectIdentity: base.projectIdentity });
  const malformed = rawOperation('op:missing-target');
  delete malformed.targetEntityId;
  const malformedResult = log.applyOperation(malformed);
  assert.equal(malformedResult.status, 'rejected');
  assert.equal(malformedResult.reason, 'operation-target-entity-required');
  assert.deepEqual(log.appliedOperationIds(), []);
  assert.deepEqual(log.snapshot().facts, {});

  const badParents = log.applyOperation(rawOperation('op:bad-parents', { causalParents: 'op:parent' }));
  assert.equal(badParents.status, 'rejected');
  assert.equal(badParents.reason, 'operation-causal-parents-invalid');

  const unsupported = rawOperation('op:add', { action: 'add' });
  assert.throws(
    () => createProjectOperation(unsupported),
    (error) => error instanceof TypeError && error.message === 'operation-action-unsupported',
  );
  assert.deepEqual(
    log.applyOperation(unsupported),
    {
      status: 'rejected',
      reason: 'operation-action-unsupported',
      operationId: 'op:add',
      stateDigest: log.digest(),
    },
  );
  assert.equal(log.applyBatch([unsupported]).reason, 'operation-action-unsupported');
  assert.throws(() => orderOperations([unsupported]), /operation-action-unsupported/);
  assert.throws(() => mergeOperations([unsupported]), /operation-action-unsupported/);
  assert.equal(
    log.applyOperation(rawOperation('op:blank-action', { action: '' })).reason,
    'operation-action-unsupported',
    'versioned string actions retain the established apply-boundary rejection code',
  );
  assert.deepEqual(log.appliedOperationIds(), []);
});

test('T052 canonicalization preserves semantic collision and pending authority', () => {
  const log = new ChangeLog({ projectIdentity: base.projectIdentity });
  const pending = createProjectOperation({
    ...base,
    operationId: 'op:pending',
    causalParents: ['op:parent'],
  });
  assert.equal(log.applyOperation(pending).status, 'unresolved');

  const rawCollision = rawOperation('op:pending', {
    causalParents: ['op:parent'],
    payload: 'different',
  });
  const rejected = log.applyOperation(rawCollision);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason, 'operation-id-content-mismatch');
  assert.equal(log.pending.get('op:pending'), pending);

  const rawRetry = rawOperation('op:pending', { causalParents: ['op:parent'] });
  const parent = rawOperation('op:parent', { targetEntityId: 'entity:parent', payload: 'parent' });
  assert.equal(log.applyBatch([parent, rawRetry]).status, 'applied');
  assert.equal(log.operations.get('op:pending'), pending, 'the original pending operation remains authoritative');
  assert.deepEqual([...log.pending.keys()], []);
});

test('T052 constructor canonicalizes operations and pending hydration', () => {
  const rawParent = rawOperation('op:hydrated-parent', {
    targetEntityId: 'entity:hydrated-parent',
    payload: 'parent',
  });
  const rawPending = rawOperation('op:hydrated-child', {
    targetEntityId: 'entity:hydrated-child',
    causalParents: ['op:hydrated-parent'],
    payload: 'child',
  });
  const canonical = createProjectOperation({
    ...base,
    operationId: 'op:hydrated-canonical',
    targetEntityId: 'entity:hydrated-canonical',
  });
  const log = new ChangeLog({
    projectIdentity: base.projectIdentity,
    operations: [rawParent, canonical],
    pending: [['op:hydrated-child', rawPending]],
  });

  assert.equal(isCanonicalProjectOperation(rawParent), false);
  assert.equal(isCanonicalProjectOperation(rawPending), false);
  assert.notEqual(log.operations.get(rawParent.operationId), rawParent);
  assert.notEqual(log.pending.get(rawPending.operationId), rawPending);
  assert.equal(isCanonicalProjectOperation(log.operations.get(rawParent.operationId)), true);
  assert.equal(isCanonicalProjectOperation(log.pending.get(rawPending.operationId)), true);
  assert.equal(log.operations.get(canonical.operationId), canonical, 'already canonical hydration retains object identity');

  const trigger = rawOperation('op:hydration-trigger', {
    targetEntityId: 'entity:hydration-trigger',
    payload: 'trigger',
  });
  assert.equal(log.applyOperation(trigger).status, 'applied');
  assert.equal(log.pending.has(rawPending.operationId), false);
  assert.equal(log.operations.has(rawPending.operationId), true);
  assert.equal(log.snapshot().facts['entity:hydrated-child\u0000name'].values[0].value, 'child');
});

test('T052 constructor rejects malformed, colliding, and mismatched hydration', () => {
  assert.throws(
    () => new ChangeLog({
      projectIdentity: base.projectIdentity,
      operations: [rawOperation('op:hydrated-add', { action: 'add' })],
    }),
    (error) => error instanceof TypeError && error.message === 'operation-action-unsupported',
  );

  const malformedPending = rawOperation('op:hydrated-malformed');
  delete malformedPending.targetEntityId;
  assert.throws(
    () => new ChangeLog({
      projectIdentity: base.projectIdentity,
      pending: [['op:hydrated-malformed', malformedPending]],
    }),
    (error) => error instanceof TypeError && error.message === 'operation-target-entity-required',
  );

  assert.throws(
    () => new ChangeLog({
      projectIdentity: base.projectIdentity,
      pending: [['op:different-key', rawOperation('op:hydrated-key')]],
    }),
    (error) => error instanceof TypeError
      && /(?:operation|changelog)-pending-id-mismatch/.test(error.message),
  );

  assert.throws(
    () => new ChangeLog({
      projectIdentity: base.projectIdentity,
      operations: [
        rawOperation('op:hydrated-collision', { payload: 'alpha' }),
        rawOperation('op:hydrated-collision', { payload: 'beta' }),
      ],
    }),
    (error) => error instanceof TypeError && error.message === 'operation-id-content-mismatch',
  );
});
