import assert from 'node:assert/strict';
import {
  createRebuildTransaction,
  materializeRebuildTransaction,
  validateRebuildTransaction,
  publishRebuildTransaction,
} from '../js/rebuild/transaction-v2.js';
import { stableDigest } from '../js/core/identity/index.js';

// Issue #4130: an external validator identity field must be a primitive string
// before it can bind to the transaction/output identity. The old String()
// coercion let 1-element arrays (and other structured values) alias the
// canonical identity, so a malformed validator result passed the identity
// gate. Omission stays allowed; an explicit malformed value fails closed.

const source = Uint8Array.of(1, 2, 3, 4);
const digest = (bytes) => `bytes:${stableDigest(Array.from(bytes))}`;

async function runValidator(resultFn) {
  const transaction = createRebuildTransaction({
    binaryId: 'binary:elf:issue-4130',
    sourceHash: digest(source),
    format: 'elf',
    architecture: 'arm64',
    loaderVersion: 'loader:elf:issue-4130',
    operations: [{ id: 'grow', offset: 1, before: [2], after: [9, 8], provenance: { source: 'test' } }],
    impact: { layoutMoving: true, relocations: true, branchRanges: true, unwind: true, importsExports: true, signature: true },
    requireIndependentOracle: false,
  });
  const materialized = await materializeRebuildTransaction(transaction, source, { maxOutputBytes: 1024 });
  assert.equal(materialized.status, 'materialized');
  const validation = await validateRebuildTransaction(transaction, materialized, {
    original: source,
    loaderReparse: (context) => resultFn(context, transaction, materialized),
    validators: Object.fromEntries(
      ['layout', 'relocations', 'branch-ranges', 'unwind', 'imports-exports', 'signature-consequence']
        .map((name) => [name, () => ({ ok: true })]),
    ),
  });
  return { transaction, materialized, validation };
}

function loaderResult(validation) {
  return validation.validators.find((item) => item.validator === 'loader-reparse');
}

const structured = [
  ['format array', (ctx, t) => ({ ok: true, format: ['elf'] }), 'validator-format-invalid'],
  ['architecture array', (ctx, t) => ({ ok: true, architecture: ['x86_64'] }), 'validator-architecture-invalid'],
  ['loaderVersion array', (ctx, t) => ({ ok: true, loaderVersion: [t.loaderVersion] }), 'validator-loader-identity-invalid'],
  ['sourceHash array aliasing transaction hash', (ctx, t) => ({ ok: true, sourceHash: [t.sourceHash] }), 'validator-source-identity-invalid'],
  ['outputHash array aliasing expected hash', (ctx, tm, m) => ({ ok: true, outputHash: [m.outputHash] }), 'validator-output-identity-invalid'],
  ['inputHash array', (ctx, t) => ({ ok: true, inputHash: [t.sourceHash] }), 'validator-source-identity-invalid'],
  ['bytesHash array', (ctx, tm, m) => ({ ok: true, bytesHash: [m.outputHash] }), 'validator-output-identity-invalid'],
  ['parserVersion array', (ctx, t) => ({ ok: true, parserVersion: [t.loaderVersion] }), 'validator-loader-identity-invalid'],
  ['nested image format array', (ctx, t) => ({ ok: true, image: { format: ['elf'] } }), 'validator-format-invalid'],
  ['nested image outputHash array', (ctx, tm, m) => ({ ok: true, image: { outputHash: [m.outputHash] } }), 'validator-output-identity-invalid'],
  ['numeric format', () => ({ ok: true, format: 1 }), 'validator-format-invalid'],
  ['boolean architecture', () => ({ ok: true, architecture: true }), 'validator-architecture-invalid'],
  ['plain object sourceHash', (ctx, t) => ({ ok: true, sourceHash: { value: t.sourceHash } }), 'validator-source-identity-invalid'],
];

for (const [label, impl, expectedReason] of structured) {
  const { validation } = await runValidator(impl);
  const result = loaderResult(validation);
  assert.equal(result.status, 'failed', `${label}: malformed identity must fail the validator`);
  assert.equal(result.reason, expectedReason, `${label}: expected ${expectedReason}, got ${result.reason}`);
  assert.equal(validation.status, 'invalid', `${label}: malformed identity must invalidate the validation`);
}

// Acceptance 3/5: valid primitive string identities and explicit omission keep
// their existing semantics.
{
  const { materialized, validation } = await runValidator((ctx, t, m) => ({
    ok: true,
    format: 'ELF',
    architecture: 'ARM64',
    loaderVersion: t.loaderVersion,
    sourceHash: t.sourceHash.toUpperCase(),
    outputHash: m.outputHash.toUpperCase(),
  }));
  assert.equal(validation.status, 'valid', 'valid primitive string identities must still pass');
  const published = await publishRebuildTransaction(materialized, validation, {
    atomicPromote: async (_bytes, { materialized: pub }) => ({
      atomic: true,
      committed: true,
      protocol: 'transactional-store',
      publicationIdentity: 'artifact:rebuilt:issue-4130',
      transactionId: pub.transactionId,
      outputHash: pub.outputHash,
      outputIdentity: pub.outputIdentity,
    }),
  });
  assert.equal(published.status, 'published', 'the positive path must still publish');
}
{
  const { validation } = await runValidator(() => ({ ok: true }));
  assert.equal(loaderResult(validation).status, 'passed', 'omitted identity fields stay allowed');
  assert.equal(validation.status, 'valid', 'omitted identity must not regress to invalid');
}

console.log('issue-4130 external validator identity fields are typed before binding: ok');
