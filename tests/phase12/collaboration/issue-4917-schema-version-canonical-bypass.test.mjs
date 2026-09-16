import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHANGELOG_SCHEMA_VERSION,
  ChangeLog,
  createProjectOperation,
  mergeOperations,
  orderOperations,
  restoreCheckpoint,
} from '../../../js/collaboration/index.js';

const NUL = String.fromCharCode(0);
const PROJECT = 'hex-project:4917';
const CANONICAL_KEY = `entity-A${NUL}name`;

const rawOperation = (overrides = {}) => ({
  schemaVersion: CHANGELOG_SCHEMA_VERSION,
  operationId: 'malformed-4917',
  projectIdentity: PROJECT,
  binaryIdentity: null,
  causalParents: [],
  targetEntityId: ['entity-A'],
  factKind: 'name',
  action: 'set',
  payload: 'forged',
  provenance: { source: 'local' },
  ...overrides,
});

const canonical = (overrides = {}) => createProjectOperation({
  projectIdentity: PROJECT,
  binaryIdentity: null,
  targetEntityId: 'entity-A',
  factKind: 'name',
  action: 'set',
  payload: 'canonical',
  ...overrides,
});

const stateOf = (log) => Object.keys(log.snapshot().facts).sort();

function expectNotIngressed(label, run) {
  let outcome;
  try { outcome = run(); } catch (error) {
    assert.ok(error instanceof TypeError, `${label}: expected a fail-closed TypeError, got ${String(error)}`);
    return;
  }
  const statuses = [];
  const collect = (value) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.status === 'string') statuses.push(value.status);
    if (Array.isArray(value.results)) value.results.forEach(collect);
  };
  collect(outcome);
  assert.ok(!statuses.includes('applied'), `${label}: malformed input reached applied state`);
  const published = Array.isArray(outcome) ? outcome : outcome?.ordered;
  if (Array.isArray(published)) {
    assert.equal(published.every((operation) => operation.targetEntityId === 'entity-A'
      && operation.factKind === 'name' && typeof operation.operationId === 'string'), true,
      `${label}: malformed raw input was published as a canonical operation`);
  }
  if (outcome instanceof ChangeLog) {
    const stored = [...outcome.operations.values(), ...outcome.pending.values()];
    assert.equal(stored.every((operation) => operation.targetEntityId === 'entity-A'
      && operation.factKind === 'name' && operation.action === 'set'
      && typeof operation.operationId === 'string' && typeof operation.projectIdentity === 'string'), true,
      `${label}: malformed raw input was retained as a canonical operation`);
  }
}

test('#4917 schemaVersion tag alone never bypasses the canonical constructor at any ingress', () => {
  expectNotIngressed('applyOperation', () => new ChangeLog({ projectIdentity: PROJECT }).applyOperation(rawOperation()));
  expectNotIngressed('applyBatch', () => new ChangeLog({ projectIdentity: PROJECT }).applyBatch([rawOperation()]));
  expectNotIngressed('orderOperations', () => orderOperations([rawOperation()]).ordered);
  expectNotIngressed('mergeOperations left', () => mergeOperations([rawOperation()], []));
  expectNotIngressed('mergeOperations right', () => mergeOperations([], [rawOperation()]));
  expectNotIngressed('restore operations', () => new ChangeLog({ projectIdentity: PROJECT, operations: [rawOperation()] }));
  expectNotIngressed('restore pending', () => new ChangeLog({ projectIdentity: PROJECT, pending: [['malformed-4917', rawOperation()]] }));
});

test('#4917 structured target cannot alias the canonical fact key or mutate state', () => {
  const log = new ChangeLog({ projectIdentity: PROJECT });
  const before = log.digest();
  expectNotIngressed('applyOperation', () => log.applyOperation(rawOperation()));
  assert.equal(log.digest(), before, 'rejected ingress must not move the state digest');
  assert.deepEqual(stateOf(log), []);
  assert.deepEqual(log.appliedOperationIds(), []);
  assert.equal(log.state.facts[CANONICAL_KEY], undefined);
  log.applyOperation(canonical({ operationId: 'op-canonical' }));
  assert.deepEqual(stateOf(log), [CANONICAL_KEY]);
  assert.equal(log.snapshot().facts[CANONICAL_KEY].values.length, 1);
});

test('#4917 malformed identity fields keep the constructor contract on the tagged path', () => {
  const cases = [
    ['factKind', rawOperation({ targetEntityId: 'entity-A', factKind: ['name'] })],
    ['factKind-empty', rawOperation({ targetEntityId: 'entity-A', factKind: 7 })],
    ['operationId', rawOperation({ targetEntityId: 'entity-A', operationId: ['op'] })],
    ['projectIdentity', rawOperation({ targetEntityId: 'entity-A', projectIdentity: ['p'] })],
    ['binaryIdentity', rawOperation({ targetEntityId: 'entity-A', binaryIdentity: { id: 'b' } })],
    ['causalParents', rawOperation({ targetEntityId: 'entity-A', causalParents: { 0: 'op' } })],
    ['causalParent-entry', rawOperation({ targetEntityId: 'entity-A', causalParents: [['op']] })],
    ['action', rawOperation({ targetEntityId: 'entity-A', action: 'forge' })],
  ];
  for (const [label, input] of cases) {
    expectNotIngressed(`applyOperation/${label}`, () => new ChangeLog({ projectIdentity: PROJECT }).applyOperation(input));
    expectNotIngressed(`applyBatch/${label}`, () => new ChangeLog({ projectIdentity: PROJECT }).applyBatch([input]));
    expectNotIngressed(`orderOperations/${label}`, () => orderOperations([input]).ordered);
    expectNotIngressed(`mergeOperations/${label}`, () => mergeOperations([input], []));
    expectNotIngressed(`restore/${label}`, () => new ChangeLog({ projectIdentity: PROJECT, operations: [input] }));
  }
});

test('#4917 already canonical operations preserve identity, payload, digest and merge results', () => {
  const first = canonical({ operationId: 'op-4917-a', payload: { note: 'a' } });
  const second = canonical({ operationId: 'op-4917-b', targetEntityId: 'entity-B', payload: 'b' });
  const viaFactory = new ChangeLog({ projectIdentity: PROJECT });
  const viaRawTag = new ChangeLog({ projectIdentity: PROJECT });
  for (const operation of [first, second]) {
    assert.equal(viaFactory.applyOperation(operation).status, 'applied');
    assert.equal(viaRawTag.applyOperation({ ...operation }).status, 'applied');
  }
  assert.equal(viaRawTag.digest(), viaFactory.digest());
  assert.deepEqual(stateOf(viaRawTag), stateOf(viaFactory));
  assert.deepEqual(JSON.parse(JSON.stringify(viaRawTag.snapshot().facts)), JSON.parse(JSON.stringify(viaFactory.snapshot().facts)));
  assert.deepEqual(orderOperations([first, second]).ordered.map((operation) => operation.operationId),
    orderOperations([{ ...first }, { ...second }]).ordered.map((operation) => operation.operationId));
  assert.deepEqual(mergeOperations([first], [{ ...second }]).map((operation) => operation.operationId),
    [first.operationId, second.operationId].sort());
  const restored = restoreCheckpoint(viaFactory.checkpoint(), { projectIdentity: PROJECT });
  assert.equal(restored.digest(), viaFactory.digest());
  const replayed = restoreCheckpoint(viaFactory.checkpoint(), { projectIdentity: PROJECT, operations: [first, second] });
  assert.equal(replayed.digest(), viaFactory.digest());
});
