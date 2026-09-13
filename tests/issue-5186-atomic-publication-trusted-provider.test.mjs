import assert from 'node:assert/strict';
import { stableDigest } from '../js/core/identity/index.js';
import {
  evaluateF6RebuildDenominator,
  materializeRebuildTransaction,
  publishRebuildTransaction,
  registerCanonicalAtomicPublicationProvider,
  isValidatedAtomicPublicationReceipt,
  validateRebuildTransaction,
  createRebuildTransaction,
} from '../js/rebuild/transaction-v2.js';

// Issue #5186: a caller-supplied atomicPromote() must not be able to prove an
// atomic publication / F6 closure by self-reporting atomic:true + committed:true
// + echoed identity. Only a host-registered trusted publication provider may mint
// a publication receipt, and the F6 denominator must verify that receipt's
// host-private authenticity.

const source = Uint8Array.of(1, 2, 3, 4);
const digest = (bytes) => `bytes:${stableDigest(Array.from(bytes))}`;

async function greenFixture() {
  const transaction = createRebuildTransaction({
    binaryId: 'binary:macho:issue-5186',
    sourceHash: digest(source),
    format: 'macho',
    architecture: 'x86_64',
    loaderVersion: 'loader:macho:issue-5186',
    operations: [{ id: 'grow', offset: 1, before: [2], after: [9, 8], provenance: { source: 'test' } }],
    impact: { layoutMoving: true, relocations: true, branchRanges: true, unwind: true, importsExports: true, signature: true },
    requireIndependentOracle: false,
  });
  const materialized = await materializeRebuildTransaction(transaction, source, { maxOutputBytes: 1024 });
  assert.equal(materialized.status, 'materialized');
  const validators = Object.fromEntries(
    ['layout', 'relocations', 'branch-ranges', 'unwind', 'imports-exports', 'signature-consequence']
      .map((name) => [name, () => ({ ok: true })]),
  );
  const validation = await validateRebuildTransaction(transaction, materialized, {
    original: source,
    loaderReparse: () => ({ ok: true }),
    validators,
  });
  assert.equal(validation.status, 'valid', JSON.stringify(validation.failures));
  return { transaction, materialized, validation };
}

const echoResult = (identity) => ({
  atomic: true,
  committed: true,
  protocol: 'transactional-store',
  publicationIdentity: 'fake-publication',
  transactionId: identity.materialized.transactionId,
  outputHash: identity.materialized.outputHash,
  outputIdentity: identity.materialized.outputIdentity,
});

const { transaction, materialized, validation } = await greenFixture();
const proof = { realFixture: true, realFixtureEvidence: true, negativeValidatorTest: true, staleIdentityTest: true, truncationTest: true, wrongIdentityTest: true };

// (1) A caller-supplied arbitrary callback that echoes atomic/committed/identity
//     must not mint a trusted publication authority, and must not close F6.
const untrusted = await publishRebuildTransaction(materialized, validation, {
  atomicPromote: async (_bytes, identity) => echoResult(identity),
});
assert.equal(untrusted.authority, 'untrusted-atomic-promotion', 'arbitrary callback is explicitly untrusted');
assert.equal(isValidatedAtomicPublicationReceipt(untrusted), false, 'untrusted callback output is not a receipt');
const untrustedDenominator = evaluateF6RebuildDenominator({ transaction, validation, publication: untrusted, proof });
assert.notEqual(untrustedDenominator.cells['atomic-publication'].status, 'closed', 'untrusted callback must not close F6 atomic-publication');
assert.equal(untrustedDenominator.blockingUnitIds.includes('macho:64:atomic-publication'), true);

// (2) A registered trusted provider may mint the atomic publication receipt.
const trusted = await publishRebuildTransaction(materialized, validation, {
  atomicPromote: registerCanonicalAtomicPublicationProvider(async (_bytes, identity) => ({
    atomic: true,
    committed: true,
    protocol: 'temp-then-atomic-rename',
    publicationIdentity: 'artifact:macho:issue-5186',
    transactionId: identity.materialized.transactionId,
    outputHash: identity.materialized.outputHash,
    outputIdentity: identity.materialized.outputIdentity,
  })),
});
assert.equal(trusted.status, 'published', 'registered trusted provider mints published');
assert.equal(isValidatedAtomicPublicationReceipt(trusted), true, 'trusted provider mints a host receipt');

// (3) A hand-fabricated receipt-shaped object cannot close the F6 atomic-publication unit.
const forged = { ...trusted, publicationIdentity: 'hand-forged' };
assert.equal(isValidatedAtomicPublicationReceipt(forged), false, 'copied/forged receipt object is not host-authenticated');
const forgedDenominator = evaluateF6RebuildDenominator({ transaction, validation, publication: forged, proof });
assert.notEqual(forgedDenominator.cells['atomic-publication'].status, 'closed', 'forged receipt object must not close F6 atomic-publication');
assert.equal(forgedDenominator.blockingUnitIds.includes('macho:64:atomic-publication'), true);

// (2b) The genuine trusted receipt closes the F6 atomic-publication unit.
const trustedDenominator = evaluateF6RebuildDenominator({ transaction, validation, publication: trusted, proof });
assert.equal(trustedDenominator.cells['atomic-publication'].status, 'closed', 'trusted receipt closes F6 atomic-publication');

// (4) An interruption / commit failure is never laundered into committed:true.
const aborted = await publishRebuildTransaction(materialized, validation, {
  atomicPromote: registerCanonicalAtomicPublicationProvider(async (_bytes, identity) => ({
    ...echoResult(identity), committed: false,
  })),
});
assert.equal(aborted.status, 'rejected');
assert.equal(aborted.reason, 'rebuild-v2-publication-not-atomic');
const thrown = await publishRebuildTransaction(materialized, validation, {
  atomicPromote: registerCanonicalAtomicPublicationProvider(async () => { throw new Error('commit failed'); }),
});
assert.equal(thrown.status, 'rejected');
assert.equal(thrown.reason, 'rebuild-v2-publication-failed');

// (5) Output hash / transaction / output-identity binding is still enforced for a
//     trusted provider: a trusted provider that lies about identity is rejected.
const mismatched = await publishRebuildTransaction(materialized, validation, {
  atomicPromote: registerCanonicalAtomicPublicationProvider(async (_bytes, identity) => ({
    ...echoResult(identity), outputHash: `bytes:${'0'.repeat(32)}`,
  })),
});
assert.equal(mismatched.status, 'rejected');
assert.equal(mismatched.reason, 'rebuild-v2-publication-output-mismatch');

console.log('issue-5186 atomic publication trusted-provider authority regression: ok');
