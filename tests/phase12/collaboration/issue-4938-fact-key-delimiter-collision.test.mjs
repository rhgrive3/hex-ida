import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHANGELOG_SCHEMA_VERSION,
  ChangeLog,
  createProjectOperation,
  mergeOperations,
  orderOperations,
  replayOperations,
  restoreCheckpoint,
} from '../../../js/collaboration/index.js';

const NUL = String.fromCharCode(0);
const PROJECT = 'hex-project:4938';
const COLLIDING_KEY = `entity${NUL}x${NUL}name`;

const collidingTarget = `entity${NUL}x`;
const collidingKind = `x${NUL}name`;

const op = (overrides = {}) => createProjectOperation({
  projectIdentity: PROJECT,
  binaryIdentity: null,
  targetEntityId: 'entity',
  factKind: 'name',
  action: 'set',
  payload: 'value',
  ...overrides,
});

const tagged = (overrides = {}) => ({
  schemaVersion: CHANGELOG_SCHEMA_VERSION,
  operationId: 'op-4938-tagged',
  projectIdentity: PROJECT,
  binaryIdentity: null,
  causalParents: [],
  targetEntityId: collidingTarget,
  factKind: 'name',
  action: 'set',
  payload: 'collision',
  provenance: { source: 'local' },
  ...overrides,
});

function separatorFree(operation) {
  return String(operation.targetEntityId).includes(NUL) === false
    && String(operation.factKind).includes(NUL) === false;
}

function expectFailClosed(label, run) {
  let outcome;
  try { outcome = run(); } catch (error) {
    assert.ok(error instanceof TypeError, `${label}: expected TypeError, got ${String(error)}`);
    return;
  }
  const status = outcome && typeof outcome.status === 'string' ? outcome.status : null;
  assert.notEqual(status, 'applied', `${label}: delimiter-injected tuple reached applied state`);
  const published = Array.isArray(outcome) ? outcome : outcome?.ordered;
  if (Array.isArray(published)) {
    assert.equal(published.every(separatorFree), true, `${label}: delimiter-injected tuple was published as canonical`);
  }
  if (outcome instanceof ChangeLog) {
    assert.equal([...outcome.operations.values(), ...outcome.pending.values()].every(separatorFree), true,
      `${label}: delimiter-injected tuple was retained as canonical`);
    assert.deepEqual(Object.keys(outcome.snapshot().facts), [], `${label}: delimiter-injected tuple allocated a slot`);
  }
}

test('#4938 constructor rejects the fact-key separator in identity components', () => {
  assert.throws(() => op({ targetEntityId: collidingTarget }), TypeError);
  assert.throws(() => op({ factKind: collidingKind }), TypeError);
  assert.throws(() => op({ targetEntityId: collidingTarget, factKind: collidingKind }), TypeError);
  assert.throws(() => op({ targetEntityId: `  ${collidingTarget}  ` }), TypeError);
});

test('#4938 colliding tuples are rejected at every ingress and never allocate a slot', () => {
  for (const [label, input] of [['target', tagged()], ['kind', tagged({ targetEntityId: 'entity', factKind: collidingKind })]]) {
    expectFailClosed(`applyOperation/${label}`, () => new ChangeLog({ projectIdentity: PROJECT }).applyOperation(input));
    expectFailClosed(`applyBatch/${label}`, () => new ChangeLog({ projectIdentity: PROJECT }).applyBatch([input]));
    expectFailClosed(`orderOperations/${label}`, () => orderOperations([input]).ordered);
    expectFailClosed(`mergeOperations/${label}`, () => mergeOperations([input], []));
    expectFailClosed(`restore-operations/${label}`, () => new ChangeLog({ projectIdentity: PROJECT, operations: [input] }));
    expectFailClosed(`restore-pending/${label}`, () => new ChangeLog({ projectIdentity: PROJECT, pending: [[input.operationId, input]] }));
    expectFailClosed(`replay/${label}`, () => replayOperations({ projectIdentity: PROJECT, operations: [input] }));
    const log = new ChangeLog({ projectIdentity: PROJECT });
    const before = log.digest();
    expectFailClosed(`direct/${label}`, () => log.applyOperation(input));
    assert.equal(log.digest(), before);
    assert.equal(log.snapshot().facts[COLLIDING_KEY], undefined);
    assert.deepEqual(log.snapshot().tombstones, []);
  }
});

test('#4938 one tuple can not delete, tombstone or conflict another tuple', () => {
  const log = new ChangeLog({ projectIdentity: PROJECT });
  expectFailClosed('cross-set/target', () => log.applyOperation(tagged({ operationId: 'op-a', targetEntityId: collidingTarget, factKind: 'name', payload: 'Alice' })));
  expectFailClosed('cross-delete/kind', () => log.applyOperation(tagged({ operationId: 'op-b', targetEntityId: 'entity', factKind: collidingKind, action: 'remove', payload: null })));
  assert.deepEqual(Object.keys(log.snapshot().facts), []);
  assert.deepEqual(log.snapshot().tombstones, []);
  assert.equal(log.applyOperation(op({ operationId: 'op-keep', targetEntityId: 'entity', factKind: 'name', payload: 'Alice' })).status, 'applied');
  assert.deepEqual(Object.keys(log.snapshot().facts), [`entity${NUL}name`]);
  assert.equal(log.state.conflicts.length, 0);
  expectFailClosed('cross-delete-suffix', () => log.applyOperation(tagged({ operationId: 'op-del', targetEntityId: 'entity', factKind: `other${NUL}name`, action: 'remove', payload: null })));
  assert.deepEqual(Object.keys(log.snapshot().facts), [`entity${NUL}name`]);
  assert.equal(log.applyOperation(op({ operationId: 'op-again', targetEntityId: 'entity', factKind: 'name', payload: 'Alice' })).status, 'applied');
  assert.equal(log.snapshot().facts[`entity${NUL}name`].values.length, 1);
});

test('#4938 distinct ASCII tuples keep separate slots across checkpoint and replay', () => {
  const log = new ChangeLog({ projectIdentity: PROJECT });
  const left = op({ operationId: 'op-left', targetEntityId: 'entity', factKind: 'name', payload: 'L' });
  const right = op({ operationId: 'op-right', targetEntityId: 'entityx', factKind: 'name', payload: 'R' });
  const ambiguousKind = op({ operationId: 'op-kind', targetEntityId: 'entity', factKind: 'xname', payload: 'K' });
  log.applyBatch([left, right, ambiguousKind]);
  assert.deepEqual(Object.keys(log.snapshot().facts).sort(), [
    `entity${NUL}name`,
    `entity${NUL}xname`,
    `entityx${NUL}name`,
  ]);
  const checkpoint = log.checkpoint();
  const restored = restoreCheckpoint(checkpoint, { projectIdentity: PROJECT });
  assert.equal(restored.digest(), log.digest());
  assert.equal(restored.applyOperation(op({ operationId: 'op-erase', targetEntityId: 'entityx', factKind: 'name', action: 'remove', payload: null })).status, 'applied');
  assert.deepEqual(Object.keys(restored.snapshot().facts).sort(), [`entity${NUL}name`, `entity${NUL}xname`]);
  assert.equal(restored.snapshot().facts[`entity${NUL}name`].values[0].value, 'L');
  const replayed = replayOperations({ projectIdentity: PROJECT, checkpoint, operations: [left, right, ambiguousKind] });
  assert.deepEqual(Object.keys(replayed.state.facts).sort(), [`entity${NUL}name`, `entity${NUL}xname`, `entityx${NUL}name`]);
});

test('#4938 restored state carrying a delimiter-injected fact key is rejected', () => {
  const record = {
    key: COLLIDING_KEY,
    targetEntityId: collidingTarget,
    factKind: 'name',
    values: [{ operationId: 'op-forged', value: 'forged' }],
    resolvedOperationId: null,
    stateFingerprint: null,
  };
  const state = {
    schemaVersion: CHANGELOG_SCHEMA_VERSION,
    projectIdentity: PROJECT,
    binaryIdentity: null,
    facts: { [COLLIDING_KEY]: record },
    conflicts: [],
    tombstones: [],
    unresolved: [],
  };
  assert.throws(() => new ChangeLog({ projectIdentity: PROJECT, state }), TypeError);
  assert.throws(() => new ChangeLog({ projectIdentity: PROJECT, state: {
    ...state,
    facts: {},
    tombstones: [{ key: COLLIDING_KEY, operationId: 'op-forged', targetEntityId: collidingTarget, factKind: 'name' }],
  } }), TypeError);
});
