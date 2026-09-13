import assert from 'node:assert/strict';
import {
  createRebuildTransaction,
  materializeRebuildTransaction,
  validateRebuildTransaction,
  publishRebuildTransaction,
} from '../js/rebuild/transaction-v2.js';
import { stableDigest } from '../js/core/identity/index.js';

// Issue #4134: publishRebuildTransaction must accept only primitive strings
// for protocol and every publication/identity field. The old String()
// coercion let a promoter launder 1-element arrays into canonical publication
// proof. Explicit strict-boolean atomic/committed and the omission contracts
// keep their existing semantics.

const source = Uint8Array.of(1, 2, 3, 4);
const digest = (bytes) => `bytes:${stableDigest(Array.from(bytes))}`;

const transaction = createRebuildTransaction({
  binaryId: 'binary:elf:issue-4134',
  sourceHash: digest(source),
  format: 'elf',
  architecture: 'arm64',
  loaderVersion: 'loader:elf:issue-4134',
  operations: [{ id: 'grow', offset: 1, before: [2], after: [9, 8], provenance: { source: 'test' } }],
  impact: { layoutMoving: true, relocations: true, branchRanges: true, unwind: true, importsExports: true, signature: true },
  requireIndependentOracle: false,
});
const materialized = await materializeRebuildTransaction(transaction, source, { maxOutputBytes: 1024 });
assert.equal(materialized.status, 'materialized');
const validation = await validateRebuildTransaction(transaction, materialized, {
  original: source,
  loaderReparse: () => ({ ok: true }),
  validators: Object.fromEntries(
    ['layout', 'relocations', 'branch-ranges', 'unwind', 'imports-exports', 'signature-consequence']
      .map((name) => [name, () => ({ ok: true })]),
  ),
});
assert.equal(validation.status, 'valid');

async function publish(resultFields) {
  return await publishRebuildTransaction(materialized, validation, { atomicPromote: async () => resultFields });
}

const validStrings = (over = {}) => ({
  atomic: true,
  committed: true,
  protocol: 'transactional-store',
  publicationIdentity: 'artifact:rebuilt:issue-4134',
  transactionId: materialized.transactionId,
  outputHash: materialized.outputHash,
  outputIdentity: materialized.outputIdentity,
  ...over,
});

// Acceptance 1-3/5: structured protocol/identity values never publish.
const malformed = [
  ['protocol array', validStrings({ protocol: ['transactional-store'] }), 'rebuild-v2-publication-protocol-invalid'],
  ['protocol boolean', validStrings({ protocol: true }), 'rebuild-v2-publication-protocol-invalid'],
  ['protocol numeric', validStrings({ protocol: 1 }), 'rebuild-v2-publication-protocol-invalid'],
  ['publicationIdentity array', validStrings({ publicationIdentity: ['publish-1'] }), 'rebuild-v2-publication-identity-invalid'],
  ['transactionId array', validStrings({ transactionId: [materialized.transactionId] }), 'rebuild-v2-publication-identity-invalid'],
  ['outputHash array', validStrings({ outputHash: [materialized.outputHash] }), 'rebuild-v2-publication-identity-invalid'],
  ['outputIdentity array', validStrings({ outputIdentity: [`rebuild-output:${materialized.transactionId}:${materialized.outputHash}`] }), 'rebuild-v2-publication-identity-invalid'],
  ['optional format array', validStrings({ format: ['elf'] }), 'rebuild-v2-publication-identity-invalid'],
  ['optional architecture object', validStrings({ architecture: { toString: () => 'arm64' } }), 'rebuild-v2-publication-identity-invalid'],
  ['optional sourceHash numeric', validStrings({ sourceHash: 1 }), 'rebuild-v2-publication-identity-invalid'],
];

for (const [label, promoterResult, expectedReason] of malformed) {
  const published = await publish(promoterResult);
  assert.notEqual(published.status, 'published', `${label}: structured value must not reach published`);
  assert.equal(published.status, 'rejected', `${label}: expected rejected, got ${published.status}`);
  assert.equal(published.reason, expectedReason, `${label}: expected ${expectedReason}, got ${published.reason}`);
}

// Acceptance 4 + existing contracts: omission reasons and the strict
// boolean gates are unchanged.
assert.equal((await publish({ atomic: true, committed: true, protocol: 'transactional-store' })).reason, 'rebuild-v2-publication-identity-required');
assert.equal((await publish({ atomic: true, committed: true, protocol: 'transactional-store', publicationIdentity: 'partial' })).reason, 'rebuild-v2-publication-identity-incomplete');
assert.equal((await publish(validStrings({ transactionId: 'rebuild-transaction:wrong' }))).reason, 'rebuild-v2-publication-transaction-mismatch');
assert.equal((await publish(validStrings({ outputHash: 'bytes:00000000000000000000000000000000' }))).reason, 'rebuild-v2-publication-output-mismatch');
assert.equal((await publish(validStrings({ outputIdentity: 'rebuild-output:wrong:wrong' }))).reason, 'rebuild-v2-publication-output-identity-mismatch');
assert.equal((await publish(validStrings({ format: 'macho' }))).reason, 'rebuild-v2-publication-identity-mismatch');
assert.equal((await publish({ atomic: 'true', committed: true, protocol: 'transactional-store', publicationIdentity: 'p' })).reason, 'rebuild-v2-publication-not-atomic');
assert.equal((await publish(validStrings({ committed: 'true' }))).reason, 'rebuild-v2-publication-not-atomic');

// Acceptance 4: valid primitive-string promoter keeps publication semantics.
{
  const published = await publish(validStrings({ publicationIdentity: '  artifact:rebuilt:issue-4134  ' }));
  assert.equal(published.status, 'published');
  assert.equal(published.atomic, true);
  assert.equal(published.committed, true);
  assert.equal(published.protocol, 'transactional-store');
  assert.equal(published.publicationIdentity, 'artifact:rebuilt:issue-4134', 'trimmed proof string must persist');
  assert.equal(published.transactionId, materialized.transactionId);
  assert.equal(published.outputHash, materialized.outputHash);
  assert.equal(published.outputIdentity, materialized.outputIdentity);
}

console.log('issue-4134 publication protocol/identity require primitive strings before binding: ok');
