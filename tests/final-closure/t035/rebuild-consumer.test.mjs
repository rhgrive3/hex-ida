import assert from 'node:assert/strict';
import test from 'node:test';

import { stableDigest } from '../../../js/core/identity/index.js';
import {
  discoveryArtifactForRebuild,
  functionCandidates,
} from '../../../js/analysis/index.js';
import {
  createRebuildTransaction,
  materializeRebuildTransaction,
  validateRebuildTransaction,
} from '../../../js/rebuild/transaction-v2.js';

const original = Uint8Array.from([0x10, 0x20, 0x30, 0x40]);
const sourceHash = `bytes:${stableDigest(Array.from(original))}`;
const identity = {
  binaryId: 't035-public-rebuild',
  sourceHash,
  snapshotId: 't035-snapshot',
  architectureId: 'x86_64',
};

function discover(hash, sizeBytes = 4) {
  return functionCandidates({
    input: {
      image: {
        code: original,
        codeBaseAddress: 0x1000,
        functions: [{ address: 0x1000, source: 'function_starts', sizeBytes }],
      },
    },
    ...identity,
    sourceHash: hash,
  });
}

test('T035 public rebuild validation requires the canonical discovery reparse', async () => {
  const sourceResult = discover(sourceHash);
  const sourceBinding = discoveryArtifactForRebuild(sourceResult.artifact, identity);
  const transaction = createRebuildTransaction({
    ...identity,
    sourceHash,
    format: 'macho',
    architecture: 'x86_64',
    loaderVersion: 't035-loader-v1',
    operations: [{
      id: 'change-byte',
      offset: 0,
      before: [0x10],
      after: [0x11],
      provenance: { source: 't035-fixture' },
    }],
    discoveryRebuildBinding: sourceBinding,
  });
  assert.equal(transaction.requiredValidators.includes('discovery-reparse'), true);

  const materialized = await materializeRebuildTransaction(transaction, original);
  assert.equal(materialized.status, 'materialized');
  const outputResult = discover(materialized.outputHash);

  const valid = await validateRebuildTransaction(transaction, materialized, {
    original,
    loaderReparse: () => ({ ok: true }),
    discoveryReparse: () => outputResult.artifact,
  });
  assert.equal(valid.status, 'valid');
  assert.equal(valid.validators.find((item) => item.validator === 'discovery-reparse')?.status, 'passed');

  const missingReparse = await validateRebuildTransaction(transaction, materialized, {
    original,
    loaderReparse: () => ({ ok: true }),
    discoveryRebuildBinding: sourceBinding,
  });
  assert.equal(missingReparse.status, 'invalid');
  assert.equal(
    missingReparse.failures.find((item) => item.validator === 'discovery-reparse')?.reason,
    'discovery-reparse-artifact-unavailable',
  );

  const narrowed = discover(materialized.outputHash, 2);
  const narrowedValidation = await validateRebuildTransaction(transaction, materialized, {
    original,
    loaderReparse: () => ({ ok: true }),
    discoveryRebuildBinding: sourceBinding,
    discoveryReparse: () => narrowed.artifact,
  });
  assert.equal(narrowedValidation.status, 'invalid');
});
