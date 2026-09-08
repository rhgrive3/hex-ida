import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRebuildPlan,
  materializeRebuildPlan,
  publishRebuildOutput,
  validateRebuildOutput,
} from '../../../js/rebuild/index.js';
import { stableDigest } from '../../../js/core/identity/index.js';

function sourceHash(source) {
  return `bytes:${stableDigest(Array.from(source))}`;
}

function plan(binaryId, source) {
  return createRebuildPlan({
    binaryId,
    sourceHash: sourceHash(source),
    loaderVersion: 'issue-4516-test-loader',
    operations: [],
  });
}

async function validValidation(rebuildPlan, materialized) {
  return validateRebuildOutput(rebuildPlan, materialized, {
    original: Uint8Array.from(materialized.bytes),
    loaderReparse: () => ({ ok: true }),
    validators: { evidence: () => ({ ok: true }) },
  });
}

test('validation for one plan cannot publish a different materialized plan (#4516)', async () => {
  const source = Uint8Array.from([0x11]);
  const planA = plan('binary-A', source);
  const planB = plan('binary-B', source);
  const materializedA = await materializeRebuildPlan(planA, source);
  const materializedB = await materializeRebuildPlan(planB, source);
  const validationA = await validValidation(planA, materializedA);
  let promoted = false;

  const result = await publishRebuildOutput(materializedB, validationA, {
    promote: () => { promoted = true; },
  });

  assert.equal(validationA.status, 'valid');
  assert.equal(validationA.outputHash, materializedB.outputHash, 'this case isolates plan binding');
  assert.deepEqual(result, { status: 'rejected', reason: 'validation-target-mismatch' });
  assert.equal(promoted, false);
});

test('an output-hash mismatch is rejected even when plan identity matches (#4516)', async () => {
  const source = Uint8Array.from([0x11]);
  const rebuildPlan = plan('binary-A', source);
  const materialized = await materializeRebuildPlan(rebuildPlan, source);
  const validation = await validValidation(rebuildPlan, materialized);
  const mismatchedMaterialized = {
    ...materialized,
    outputHash: sourceHash(Uint8Array.from([0x22])),
  };

  const result = await publishRebuildOutput(mismatchedMaterialized, validation, {
    promote: () => { throw new Error('promotion must not run'); },
  });

  assert.equal(validation.planId, mismatchedMaterialized.planId);
  assert.notEqual(validation.outputHash, mismatchedMaterialized.outputHash);
  assert.deepEqual(result, { status: 'rejected', reason: 'validation-target-mismatch' });
});

test('a forged valid status cannot cross the publication boundary (#4516)', async () => {
  const source = Uint8Array.from([0x11]);
  const rebuildPlan = plan('binary-A', source);
  const materialized = await materializeRebuildPlan(rebuildPlan, source);
  const forgedValidation = {
    status: 'valid',
    planId: materialized.planId,
    outputHash: materialized.outputHash,
  };

  const result = await publishRebuildOutput(materialized, forgedValidation, {
    promote: () => { throw new Error('promotion must not run'); },
  });

  assert.deepEqual(result, { status: 'rejected', reason: 'validation-artifact-untrusted' });
});

test('matching canonical validation publishes an untampered detached byte copy (#4516)', async () => {
  const source = Uint8Array.from([0x11]);
  const rebuildPlan = plan('binary-A', source);
  const materialized = await materializeRebuildPlan(rebuildPlan, source);
  const validation = await validValidation(rebuildPlan, materialized);
  let promotedBytes;

  const result = await publishRebuildOutput(materialized, validation, {
    promote: (bytes) => {
      promotedBytes = bytes;
      bytes[0] = 0x22;
      return 'ok';
    },
  });

  assert.equal(result.status, 'published');
  assert.equal(result.outputHash, validation.outputHash);
  assert.deepEqual([...promotedBytes], [0x22]);
  assert.deepEqual([...materialized.bytes], [0x11]);
  assert.notEqual(promotedBytes, materialized.bytes);
});

test('bytes changed after validation are rejected before promotion (#4516)', async () => {
  const source = Uint8Array.from([0x11]);
  const rebuildPlan = plan('binary-A', source);
  const materialized = await materializeRebuildPlan(rebuildPlan, source);
  const validation = await validValidation(rebuildPlan, materialized);
  materialized.bytes[0] = 0x22;

  const result = await publishRebuildOutput(materialized, validation, {
    promote: () => { throw new Error('promotion must not run'); },
  });

  assert.deepEqual(result, { status: 'rejected', reason: 'materialized-output-tampered' });
});

console.log('issue #4516 rebuild publication binding regressions: PASS');
