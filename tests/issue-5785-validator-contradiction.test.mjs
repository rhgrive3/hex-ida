import assert from 'node:assert/strict';
import {
  createRebuildTransaction,
  materializeRebuildTransaction,
  validateRebuildTransaction,
  publishRebuildTransaction,
} from '../js/rebuild/transaction-v2.js';
import { stableDigest } from '../js/core/identity/index.js';

// Issue #5785: an external validator answer containing an explicit failure
// token (`ok:false`) must fail even when a success token (`status:'passed'` /
// `'valid'`) coexists. The old OR-chain let `{ok:false,status:'passed'}` count
// as passed and drive a whole `valid` validation toward publication.

const source = Uint8Array.of(1, 2, 3, 4);
const digest = (bytes) => `bytes:${stableDigest(Array.from(bytes))}`;

async function transactionWithValidator(validatorFn) {
  const transaction = createRebuildTransaction({
    binaryId: 'binary:elf:issue-5785',
    sourceHash: digest(source),
    format: 'elf',
    architecture: 'arm64',
    loaderVersion: 'loader:elf:issue-5785',
    operations: [{ id: 'grow', offset: 1, before: [2], after: [9, 8], provenance: { source: 'test' } }],
    impact: { layoutMoving: true, relocations: true, branchRanges: true, unwind: true, importsExports: true, signature: true },
    requireIndependentOracle: false,
  });
  const materialized = await materializeRebuildTransaction(transaction, source, { maxOutputBytes: 1024 });
  assert.equal(materialized.status, 'materialized');
  const validation = await validateRebuildTransaction(transaction, materialized, {
    original: source,
    loaderReparse: validatorFn,
    validators: Object.fromEntries(
      ['layout', 'relocations', 'branch-ranges', 'unwind', 'imports-exports', 'signature-consequence']
        .map((name) => [name, () => ({ ok: true })]),
    ),
  });
  return { transaction, materialized, validation };
}

const contradictory = [
  ['{ok:false,status:passed}', () => ({ ok: false, status: 'passed', reason: 'reparse actually failed' })],
  ['{ok:false,status:valid}', () => ({ ok: false, status: 'valid', reason: 'valid wording, failed result' })],
  ['{ok:true,status:failed}', () => ({ ok: true, status: 'failed' })],
  ['{ok:true,status:invalid}', () => ({ ok: true, status: 'invalid' })],
];

for (const [label, impl] of contradictory) {
  const { materialized, validation } = await transactionWithValidator(impl);
  assert.equal(validation.status, 'invalid', `${label} must invalidate the whole validation`);
  assert.ok(validation.failures.length >= 1, `${label} must be counted as a failure`);
  const published = await publishRebuildTransaction(
    materialized,
    validation,
    { atomicPromote: async () => ({ atomic: true, committed: true, protocol: 'transactional-store', publicationIdentity: 'p', transactionId: 't', outputHash: 'h', outputIdentity: 'i', binaryId: 'b', format: 'elf', architecture: 'arm64', loaderVersion: 'l', sourceHash: 's' }) },
  );
  assert.equal(published.status, 'rejected', `${label} must not publish`);
}

// Consistent positive shapes stay accepted.
for (const [label, impl] of Object.entries({
  '{ok:true}': () => ({ ok: true }),
  '{status:passed}': () => ({ status: 'passed' }),
  '{ok:true,status:passed}': () => ({ ok: true, status: 'passed' }),
})) {
  const { validation } = await transactionWithValidator(impl);
  assert.equal(validation.status, 'valid', `${label} must remain a pass`);
}

console.log('issue-5785 validator failure tokens override success tokens: ok');
