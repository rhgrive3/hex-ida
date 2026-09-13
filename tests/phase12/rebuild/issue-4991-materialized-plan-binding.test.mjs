import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createRebuildPlan,
  materializeRebuildPlan,
  publishRebuildOutput,
  validateRebuildOutput,
} from '../../../js/rebuild/index.js';
import { stableDigest } from '../../../js/core/identity/index.js';

const digest = (bytes) => `bytes:${stableDigest(Array.from(bytes))}`;

function planFor(source, operations) {
  return createRebuildPlan({
    binaryId: 'binary:4991',
    sourceHash: digest(source),
    loaderVersion: 'issue-4991-test-loader',
    operations,
  });
}

async function greenishValidation(rebuildPlan, materialized, original) {
  return validateRebuildOutput(rebuildPlan, materialized, {
    original,
    loaderReparse: () => ({ ok: true }),
    validators: { evidence: () => ({ ok: true }) },
  });
}

test('a no-op plan cannot validate forged output bytes (#4991)', async () => {
  const original = Uint8Array.from([0x11, 0x22]);
  const rebuildPlan = planFor(original, []);
  const forgedBytes = Uint8Array.from([0xaa, 0xbb]);
  const forged = {
    status: 'materialized',
    planId: rebuildPlan.planId,
    sourceHash: rebuildPlan.sourceHash,
    outputHash: digest(forgedBytes),
    bytes: forgedBytes,
    touched: [{ offset: 0, length: 2 }],
  };

  const validation = await greenishValidation(rebuildPlan, forged, original);
  assert.equal(validation.status, 'invalid');
  const binding = validation.validators.find((entry) => entry.validator === 'unchanged-regions');
  assert.equal(binding?.status, 'failed');
  assert.notEqual(
    validation.validators.find((entry) => entry.validator === 'structure')?.status,
    'failed',
    'self-consistent hashes must not be the only line of defence',
  );
  const published = await publishRebuildOutput(forged, validation, { promote: () => { throw new Error('promotion must not run'); } });
  assert.notEqual(published.status, 'published');
});

test('self-declared full-range touched cannot void unchanged-regions (#4991)', async () => {
  const original = Uint8Array.from([0x11, 0x22, 0x33, 0x44]);
  const rebuildPlan = planFor(original, [{ offset: 1, before: [0x22], after: [0x99] }]);
  const tampered = Uint8Array.from([0x11, 0x99, 0x33, 0xff]);
  const forged = {
    status: 'materialized',
    planId: rebuildPlan.planId,
    sourceHash: rebuildPlan.sourceHash,
    outputHash: digest(tampered),
    bytes: tampered,
    touched: [{ offset: 0, length: 4 }],
  };

  const validation = await greenishValidation(rebuildPlan, forged, original);
  assert.equal(validation.status, 'invalid');
  assert.equal(validation.validators.find((entry) => entry.validator === 'unchanged-regions')?.status, 'failed');
  assert.equal((await publishRebuildOutput(forged, validation, { promote: () => 'bad' })).status, 'rejected');
});

test('extra byte changes outside plan operations are rejected (#4991)', async () => {
  const original = Uint8Array.from([0x11, 0x22, 0x33, 0x44]);
  const rebuildPlan = planFor(original, [{ offset: 1, before: [0x22], after: [0x99] }]);
  const materialized = await materializeRebuildPlan(rebuildPlan, original);
  assert.equal(materialized.status, 'materialized');
  materialized.bytes[3] = 0xff;
  materialized.outputHash = digest(materialized.bytes);

  const validation = await greenishValidation(rebuildPlan, materialized, original);
  assert.equal(validation.status, 'invalid');
  assert.equal(validation.validators.find((entry) => entry.validator === 'unchanged-regions')?.status, 'failed');
});

test('forged touched ranges are rejected even with matching bytes (#4991)', async () => {
  const original = Uint8Array.from([0x11, 0x22, 0x33, 0x44]);
  const rebuildPlan = planFor(original, [{ offset: 1, before: [0x22, 0x33], after: [0x99, 0x88] }]);
  const materialized = await materializeRebuildPlan(rebuildPlan, original);
  const mislabelled = { ...materialized, touched: [{ offset: 0, length: 2 }] };

  const validation = await greenishValidation(rebuildPlan, mislabelled, original);
  assert.equal(validation.status, 'invalid');
  assert.equal(validation.validators.find((entry) => entry.validator === 'unchanged-regions')?.status, 'failed');
});

test('plain objects copying planId/sourceHash/outputHash prove no plan origin (#4991)', async () => {
  const original = Uint8Array.from([0x11, 0x22]);
  const rebuildPlan = planFor(original, []);
  const materialized = await materializeRebuildPlan(rebuildPlan, original);
  const copied = {
    status: 'materialized',
    planId: materialized.planId,
    sourceHash: materialized.sourceHash,
    outputHash: materialized.outputHash,
    bytes: Uint8Array.from([0x11, 0x23]),
    touched: [],
  };
  assert.equal(copied.outputHash, materialized.outputHash, 'identity strings are attacker-recomputable');

  const validation = await greenishValidation(rebuildPlan, copied, original);
  assert.equal(validation.status, 'invalid');
  assert.equal((await publishRebuildOutput(copied, validation, { promote: () => 'bad' })).status, 'rejected');
});

test('legitimate materialized output still validates and publishes (#4991)', async () => {
  const original = Uint8Array.from([0x11, 0x22, 0x33, 0x44]);
  const rebuildPlan = planFor(original, [
    { offset: 0, before: [0x11], after: [0x77] },
    { offset: 2, before: [0x33, 0x44], after: [0x88, 0x99] },
  ]);
  const materialized = await materializeRebuildPlan(rebuildPlan, original);
  const validation = await greenishValidation(rebuildPlan, materialized, original);
  let promoted;

  assert.equal(validation.status, 'valid');
  assert.deepEqual(validation.failures, []);
  assert.deepEqual([...materialized.bytes], [0x77, 0x22, 0x88, 0x99]);
  assert.deepEqual(materialized.touched, [{ offset: 0, length: 1 }, { offset: 2, length: 2 }]);
  const published = await publishRebuildOutput(materialized, validation, { promote: (bytes) => { promoted = Array.from(bytes); return 'ok'; } });
  assert.equal(published.status, 'published');
  assert.deepEqual(published.result, 'ok');
  assert.deepEqual(promoted, [0x77, 0x22, 0x88, 0x99]);
});

test('an empty plan validates an untouched copy of the original (#4991)', async () => {
  const original = Uint8Array.from([0x11, 0x22]);
  const rebuildPlan = planFor(original, []);
  const materialized = await materializeRebuildPlan(rebuildPlan, original);

  const validation = await greenishValidation(rebuildPlan, materialized, original);
  assert.equal(validation.status, 'valid');
  assert.equal((await publishRebuildOutput(materialized, validation, { promote: () => 'ok' })).status, 'published');
});

console.log('issue #4991 rebuild materialized plan binding regressions: PASS');
