import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ChangeLog,
  createCheckpoint,
  createProjectOperation,
  restoreCheckpoint,
} from '../../../js/collaboration/index.js';

// Keep the original #5538 regression corpus in the required Phase12
// denominator without duplicating or weakening any of its assertions.
import '../../issue-5538-resolve-convergence.mjs';

const base = Object.freeze({ projectIdentity: 'project-5538-integrity', binaryIdentity: null });

function operation(operationId, action, payload = null, causalParents = [], extra = {}) {
  return createProjectOperation({
    ...base,
    operationId,
    targetEntityId: 'entity-5538-integrity',
    factKind: 'name',
    action,
    payload,
    causalParents,
    ...extra,
  });
}

function checkpointWithResolution() {
  const log = new ChangeLog(base);
  assert.equal(log.applyOperation(operation('value-a', 'set', 'A')).status, 'applied');
  assert.equal(log.applyOperation(operation('value-b', 'set', 'B')).status, 'conflict');
  assert.equal(log.applyOperation(operation(
    'resolve-z',
    'resolve',
    { operationId: 'value-a' },
    ['value-a'],
    {
      authorIdentity: 'alice',
      deviceIdentity: 'device-a',
      timestampHint: '2026-09-10T00:00:00Z',
      provenance: { source: 'fixture', proofIdentity: 'proof-a' },
    },
  )).status, 'applied');
  return { log, checkpoint: createCheckpoint(log) };
}

test('#5538 checkpoint digest binds the full restored resolution operation authority', () => {
  const { checkpoint } = checkpointWithResolution();
  assert.equal(checkpoint.resolutionOperations.length, 1);

  const mutations = [
    ['causalParents', (record) => { record.causalParents = ['value-b']; }],
    ['beforeFingerprint', (record) => { record.beforeFingerprint = 'tampered-fingerprint'; }],
    ['provenance', (record) => { record.provenance = { source: 'tampered', proofIdentity: 'proof-b' }; }],
    ['authorIdentity', (record) => { record.authorIdentity = 'mallory'; }],
  ];

  for (const [label, mutate] of mutations) {
    const tampered = structuredClone(checkpoint);
    mutate(tampered.resolutionOperations[0]);
    assert.equal(tampered.digest, checkpoint.digest, `${label}: fixture keeps the persisted digest unchanged`);
    assert.throws(
      () => restoreCheckpoint(tampered, base),
      /checkpoint-digest-mismatch/,
      `${label}: restored resolution authority must be integrity-bound`,
    );
  }
});

test('#5538 checkpoints without resolution provenance retain the legacy digest contract', () => {
  const log = new ChangeLog(base);
  assert.equal(log.applyOperation(operation('value-only', 'set', 'A')).status, 'applied');
  const checkpoint = createCheckpoint(log);
  assert.deepEqual(checkpoint.resolutionOperations, []);
  assert.equal(checkpoint.digest, log.digest());

  const legacy = structuredClone(checkpoint);
  delete legacy.resolutionOperations;
  const restored = restoreCheckpoint(legacy, base);
  assert.deepEqual(restored.snapshot(), log.snapshot());
  assert.equal(restored.digest(), log.digest());
});
