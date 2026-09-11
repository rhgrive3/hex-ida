// Regression for #5978: materialized operation regions must equal the
// transaction-approved `after` payloads byte for byte. Output self-hashes
// (outputHash/outputIdentity) are attacker-recomputable and prove nothing
// about what the operation regions contain.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { stableDigest } from '../../../js/core/identity/index.js';
import {
  createRebuildTransaction,
  materializeRebuildTransaction,
  validateRebuildTransaction,
} from '../../../js/rebuild/transaction-v2.js';

const source = Uint8Array.from([1, 2, 3, 4]);
const sourceHash = `bytes:${stableDigest(Array.from(source))}`;

function transactionFor() {
  return createRebuildTransaction({
    binaryId: 'binary:macho:5978',
    sourceHash,
    format: 'macho',
    architecture: 'arm64',
    loaderVersion: 'loader:macho:test',
    operations: [{ id: 'grow', offset: 1, before: [2], after: [9, 8], provenance: { source: 'test' } }],
    impact: { layoutMoving: true, relocations: true, branchRanges: true, unwind: true, importsExports: true, signature: true },
  });
}

async function forgedMaterialized() {
  const transaction = transactionFor();
  const materialized = await materializeRebuildTransaction(transaction, source, { maxOutputBytes: 1024 });
  // Swap the operation region [9,8] -> [7,7], then recompute the output
  // self-consistency fields exactly like an attacker would.
  const forgedBytes = Uint8Array.from([1, 7, 7, 3, 4]);
  return {
    transaction,
    materialized,
    forged: {
      ...materialized,
      bytes: forgedBytes,
      outputLength: forgedBytes.length,
      outputHash: `bytes:${stableDigest(Array.from(forgedBytes))}`,
      outputIdentity: `rebuild-output:${transaction.transactionId}:bytes:${stableDigest(Array.from(forgedBytes))}`,
    },
  };
}

test('#5978 a swapped operation region with recomputed hashes is rejected', async () => {
  const { transaction, forged } = await forgedMaterialized();
  const result = await validateRebuildTransaction(transaction, forged, { original: source });
  assert.equal(result.status, 'invalid');
  assert.equal(result.reason, 'rebuild-v2-materialization-identity-invalid');
});

test('#5978 the honest materialization passes the identity gate', async () => {
  const { transaction, materialized } = await forgedMaterialized();
  const result = await validateRebuildTransaction(transactionFor(), materialized, { original: source });
  assert.equal(result.status, 'invalid');
  // The only failures must be the unavailable external validators, not any
  // structural/unchanged/operation-byte gate.
  const structuralFailures = (result.validators ?? []).filter((validator) =>
    validator.status !== 'passed' && !['required-validator-unavailable'].includes(validator.reason ?? ''));
  assert.deepEqual(structuralFailures, []);
  for (const name of ['source-precondition', 'structure', 'unchanged-regions', 'evidence']) {
    const validator = (result.validators ?? []).find((item) => item.validator === name);
    assert.equal(validator?.status, 'passed', `${name} must pass for the honest materialization`);
  }
});
