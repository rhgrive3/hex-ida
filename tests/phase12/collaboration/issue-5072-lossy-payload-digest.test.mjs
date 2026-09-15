import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ChangeLog,
  createProjectOperation,
  replayOperations,
  restoreCheckpoint,
} from '../../../js/collaboration/index.js';

const NUL = String.fromCharCode(0);
const PROJECT = 'hex-project:5072';
const BINARY = 'hex-binary:5072';
const KEY = `type-1${NUL}type`;

const op = (overrides = {}) => createProjectOperation({
  projectIdentity: PROJECT,
  binaryIdentity: BINARY,
  targetEntityId: 'type-1',
  factKind: 'type',
  action: 'set',
  ...overrides,
});

const valuesOf = (log) => (log.snapshot().facts[KEY]?.values || []).map((entry) => entry.value);
const conflictTypes = (log) => log.snapshot().conflicts.map((entry) => entry.type);

test('#5072 BigInt and decimal-string payloads are not the same fact value', () => {
  const log = new ChangeLog({ projectIdentity: PROJECT, binaryIdentity: BINARY });
  assert.equal(log.applyOperation(op({ operationId: 'op-bigint', payload: { byteSize: 8n } })).effect, 'fact');
  const second = log.applyOperation(op({ operationId: 'op-string', payload: { byteSize: '8' } }));
  assert.equal(second.status, 'conflict');
  assert.equal(second.effect, 'preserved-competing-value');
  const values = valuesOf(log);
  assert.equal(values.length, 2);
  assert.equal(typeof values[0].byteSize, 'bigint');
  assert.equal(values[0].byteSize, 8n);
  assert.equal(typeof values[1].byteSize, 'string');
  assert.equal(values[1].byteSize, '8');
  assert.ok(conflictTypes(log).includes('meaningful-conflict'));
});

test('#5072 identical payloads stay idempotent and typed values survive restore', () => {
  const log = new ChangeLog({ projectIdentity: PROJECT, binaryIdentity: BINARY });
  assert.equal(log.applyOperation(op({ operationId: 'op-a', payload: { byteSize: 8n } })).status, 'applied');
  assert.equal(log.applyOperation(op({ operationId: 'op-b', payload: { byteSize: 8n } })).effect, 'idempotent-value');
  assert.equal(valuesOf(log).length, 1);
  assert.equal(conflictTypes(log).length, 0);
  const checkpoint = log.checkpoint();
  const restored = restoreCheckpoint(checkpoint, { projectIdentity: PROJECT, binaryIdentity: BINARY });
  assert.equal(restored.digest(), log.digest());
  assert.equal(valuesOf(restored)[0].byteSize, 8n);
  const replayed = replayOperations({
    projectIdentity: PROJECT,
    binaryIdentity: BINARY,
    checkpoint,
    operations: [op({ operationId: 'op-a', payload: { byteSize: 8n } }), op({ operationId: 'op-b', payload: { byteSize: 8n } })],
  });
  assert.equal(replayed.digest, log.digest());
});

test('#5072 nested and container type distinctions survive the digest', () => {
  const pairs = [
    [{ shape: { sizes: [16n] } }, { shape: { sizes: ['16'] } }],
    [{ bytes: new Uint8Array([1, 2, 3]) }, { bytes: [1, 2, 3] }],
    [{ offset: 0 }, { offset: '0' }],
    [{ marker: undefined }, {}],
    [{ value: null }, { value: 'null' }],
  ];
  for (const [left, right] of pairs) {
    assert.notEqual(op({ payload: left }).operationId, op({ payload: right }).operationId);
    const log = new ChangeLog({ projectIdentity: PROJECT, binaryIdentity: BINARY });
    const first = log.applyOperation(op({ payload: left }));
    const second = log.applyOperation(op({ payload: right }));
    assert.equal(first.effect, 'fact');
    assert.equal(second.effect, 'preserved-competing-value');
    assert.equal(valuesOf(log).length, 2);
    assert.notEqual(first.operationId, second.operationId);
  }
});

test('#5072 stateFingerprint and auto operation identity follow semantic value equality', () => {
  const bigintLog = new ChangeLog({ projectIdentity: PROJECT, binaryIdentity: BINARY });
  bigintLog.applyOperation(op({ operationId: 'op-x', payload: { byteSize: 8n } }));
  const stringLog = new ChangeLog({ projectIdentity: PROJECT, binaryIdentity: BINARY });
  stringLog.applyOperation(op({ operationId: 'op-x', payload: { byteSize: '8' } }));
  assert.notEqual(bigintLog.snapshot().facts[KEY].stateFingerprint, stringLog.snapshot().facts[KEY].stateFingerprint);
  assert.notEqual(bigintLog.digest(), stringLog.digest());
  assert.notEqual(op({ payload: { byteSize: 8n } }).operationId, op({ payload: { byteSize: '8' } }).operationId);
  assert.notEqual(op({ payload: new Uint8Array([1, 2, 3]) }).operationId, op({ payload: [1, 2, 3] }).operationId);
});
