import assert from 'node:assert/strict';
import { stableDigest } from '../../js/core/identity/index.js';
import {
  F6_REBUILD_UNITS,
  INDEPENDENT_ORACLE_RESULT_SCHEMA,
  createRebuildTransaction,
  evaluateF6RebuildDenominator,
  materializeRebuildTransaction,
  publishRebuildTransaction,
  rebuildProfileSupport,
  validateRebuildTransaction,
} from '../../js/rebuild/transaction-v2.js';
import { validatedCapabilityProofFixture } from './helpers/profile-proof-fixture.mjs';

const { proofs: profileProofs } = validatedCapabilityProofFixture();

assert.deepEqual([...F6_REBUILD_UNITS], [
  'transaction-identity', 'layout-and-structure', 'relocations-and-bindings', 'branch-ranges',
  'unwind-and-debug', 'imports-and-exports', 'signature-consequence', 'loader-reparse',
  'independent-differential-oracle', 'atomic-publication', 'real-fixture', 'negative-validator-corpus',
], 'canonical evaluator vocabulary must remain aligned with the locked F6 unit classes');

const source = Uint8Array.from([1, 2, 3, 4]);
const sourceHash = `bytes:${stableDigest(Array.from(source))}`;
function independentEvidence(output, ok = true, extra = {}) {
  return {
    schemaVersion: INDEPENDENT_ORACLE_RESULT_SCHEMA,
    ok,
    status: ok ? 'passed' : 'rejected',
    oracleIdentity: 'external:test-reparser',
    oracleVersion: 'test-reparser/1.0.0',
    oracleSource: 'tests/stage2/rebuild-transaction.test.mjs:test-reparser',
    sourceDigest: sourceHash,
    outputDigest: `bytes:${stableDigest(Array.from(output))}`,
    format: extra.format || 'macho',
    architecture: extra.architecture || 'arm64',
    ...extra,
  };
}
function transactionFor(format) {
  return createRebuildTransaction({
    binaryId: `binary:${format}:test`,
    sourceHash,
    format,
    architecture: format === 'pe' ? 'x86_64' : 'arm64',
    loaderVersion: `loader:${format}:test`,
    operations: [{ id: 'grow', offset: 1, before: [2], after: [9, 8], provenance: { source: 'test' } }],
    impact: { layoutMoving: true, relocations: true, branchRanges: true, unwind: true, importsExports: true, signature: true },
    requireIndependentOracle: true,
  });
}

const transaction = transactionFor('macho');
assert.equal(transaction.sizeDelta, 1);
assert.ok(transaction.requiredValidators.includes('relocations'));
assert.ok(transaction.requiredValidators.includes('independent-differential'));
assert.equal((await materializeRebuildTransaction(transaction, source, { maxOutputBytes: Number.NaN })).reason, 'rebuild-v2-max-output-budget-invalid');
assert.equal((await materializeRebuildTransaction(transaction, source, { maxOutputBytes: 4 })).reason, 'rebuild-v2-output-budget-exceeded');

const materialized = await materializeRebuildTransaction(transaction, source, { maxOutputBytes: 1024 });
assert.equal(materialized.status, 'materialized');
assert.deepEqual([...materialized.bytes], [1, 9, 8, 3, 4]);
assert.equal(materialized.outputLength, 5);
assert.equal(materialized.binaryId, transaction.binaryId);
assert.equal(materialized.format, transaction.format);
assert.equal(materialized.loaderVersion, transaction.loaderVersion);
assert.equal(materialized.outputIdentity, `rebuild-output:${transaction.transactionId}:${materialized.outputHash}`);

assert.throws(() => transactionFor('unknown'), /format-unsupported/);
assert.throws(() => createRebuildTransaction({
  binaryId: 'binary:macho:test', sourceHash, format: 'macho', architecture: 'arm64', loaderVersion: 'loader:macho:test',
  operations: [{ id: 'bad-byte', offset: 0, before: [2], after: [256], provenance: { source: 'test' } }],
}), /byte-invalid/);

const external = {
  layout: ({ materialized }) => ({ ok: materialized.outputLength === 5 }),
  relocations: () => ({ ok: true, checked: 1 }),
  'branch-ranges': () => ({ ok: true, checked: 1 }),
  unwind: () => ({ ok: true, checked: 1 }),
  'imports-exports': () => ({ ok: true, checked: 1 }),
  'signature-consequence': () => ({ ok: true, consequence: 'signature-invalidated-and-requires-resign' }),
};

const missingRelocation = await validateRebuildTransaction(transaction, materialized, {
  original: source,
  loaderReparse: () => ({ ok: true }),
  independentOracle: ({ output }) => independentEvidence(output),
  validators: { ...external, relocations: undefined },
});
assert.equal(missingRelocation.status, 'invalid');
const relocationFailure = missingRelocation.validators.find((item) => item.validator === 'relocations');
assert.equal(relocationFailure.executed, false);
assert.equal(relocationFailure.status, 'failed');
assert.equal(relocationFailure.reason, 'required-validator-unavailable');

const validation = await validateRebuildTransaction(transaction, materialized, {
  original: source,
  loaderReparse: ({ output }) => ({ ok: output.length === 5 }),
  independentOracle: ({ output }) => independentEvidence(output, output[1] === 9 && output[2] === 8),
  validators: external,
});
assert.equal(validation.status, 'valid');
assert.equal(validation.allRequiredExecuted, true);
assert.equal(validation.validators.every((item) => item.executed && item.status === 'passed'), true);
assert.equal(validation.validators.find((item) => item.validator === 'evidence').reason, null);
assert.equal(validation.outputIdentity, `rebuild-output:${transaction.transactionId}:${materialized.outputHash}`);

let independentCalls = 0;
const countedValidation = await validateRebuildTransaction(transaction, materialized, {
  original: source,
  loaderReparse: () => ({ ok: true }),
  independentOracle: ({ output }) => { independentCalls += 1; return independentEvidence(output); },
  validators: external,
});
assert.equal(countedValidation.status, 'valid');
assert.equal(independentCalls, 1, 'independent parser must execute exactly once');

const tamperedOutput = { ...materialized, bytes: Uint8Array.from(materialized.bytes) };
tamperedOutput.bytes[1] = 0;
assert.equal((await validateRebuildTransaction(transaction, tamperedOutput, {
  original: source, loaderReparse: () => ({ ok: true }), independentOracle: ({ output }) => independentEvidence(output), validators: external,
})).reason, 'rebuild-v2-materialization-identity-invalid');

const tamperedMappings = { ...materialized, mappings: materialized.mappings.map((item) => ({ ...item })) };
tamperedMappings.mappings[0].outputOffset += 1;
assert.equal((await validateRebuildTransaction(transaction, tamperedMappings, {
  original: source, loaderReparse: () => ({ ok: true }), independentOracle: ({ output }) => independentEvidence(output), validators: external,
})).reason, 'rebuild-v2-materialization-identity-invalid');

const loaderAndOracle = () => ({ ok: true });
assert.equal((await validateRebuildTransaction(transaction, materialized, {
  original: source, loaderReparse: loaderAndOracle, independentOracle: loaderAndOracle, validators: external,
})).reason, 'rebuild-v2-independent-oracle-reuses-loader');

const wrongFormat = await validateRebuildTransaction(transaction, materialized, {
  original: source,
  loaderReparse: () => ({ ok: true, format: 'elf' }),
  independentOracle: ({ output }) => independentEvidence(output),
  validators: external,
});
assert.equal(wrongFormat.status, 'invalid');
assert.equal(wrongFormat.validators.find((item) => item.validator === 'loader-reparse').reason, 'validator-format-mismatch');

const relocationMismatch = await validateRebuildTransaction(transaction, materialized, {
  original: source,
  loaderReparse: () => ({ ok: true }),
  independentOracle: ({ output }) => independentEvidence(output),
  validators: { ...external, relocations: () => ({ ok: true, bindingIntegrity: false }) },
});
assert.equal(relocationMismatch.status, 'invalid');
assert.equal(relocationMismatch.validators.find((item) => item.validator === 'relocations').reason, 'relocation-binding-mismatch');

const boundTransaction = createRebuildTransaction({
  ...transactionFor('elf'),
  relocationBindings: [{ id: 'reloc:tail', sourceOffset: 3, outputOffset: 4, width: 1 }],
});
const boundMaterialized = await materializeRebuildTransaction(boundTransaction, source, { maxOutputBytes: 1024 });
const boundExternal = { ...external, relocations: () => ({ ok: true, checked: 1 }) };
assert.equal((await validateRebuildTransaction(boundTransaction, boundMaterialized, {
  original: source, loaderReparse: () => ({ ok: true }), independentOracle: ({ output }) => independentEvidence(output, true, { format: 'elf' }), validators: boundExternal,
})).status, 'valid');
const badBindingTransaction = createRebuildTransaction({
  ...transactionFor('elf'),
  relocationBindings: [{ id: 'reloc:tail', sourceOffset: 3, outputOffset: 3, width: 1 }],
});
const badBindingMaterialized = await materializeRebuildTransaction(badBindingTransaction, source, { maxOutputBytes: 1024 });
assert.equal((await validateRebuildTransaction(badBindingTransaction, badBindingMaterialized, {
  original: source, loaderReparse: () => ({ ok: true }), independentOracle: ({ output }) => independentEvidence(output, true, { format: 'elf' }), validators: boundExternal,
})).reason, 'rebuild-v2-materialization-identity-invalid');

assert.equal((await validateRebuildTransaction(transaction, materialized, {
  loaderReparse: () => ({ ok: true }), independentOracle: ({ output }) => independentEvidence(output), validators: external,
})).reason, 'rebuild-v2-original-source-required');

// Distinct wrappers around one implementation are the self-oracle counterexample:
// function identity alone cannot prove that a second parser exists. The F6
// contract must reject this result before any profile can be promoted.
const sharedSelfOracle = () => ({ ok: true });
const wrappedSelfOracle = await validateRebuildTransaction(transaction, materialized, {
  original: source,
  loaderReparse: (context) => sharedSelfOracle(context),
  independentOracle: (context) => sharedSelfOracle(context),
  validators: external,
});
assert.equal(wrappedSelfOracle.status, 'invalid');
assert.equal(wrappedSelfOracle.validators.find((item) => item.validator === 'independent-differential').reason, 'independent-oracle-contract-invalid');

for (const [field, reason] of [
  ['oracleIdentity', 'independent-oracle-identity-required'],
  ['oracleVersion', 'independent-oracle-version-required'],
  ['oracleSource', 'independent-oracle-source-required'],
  ['sourceDigest', 'independent-oracle-source-digest-required'],
  ['outputDigest', 'independent-oracle-output-digest-required'],
]) {
  const incomplete = independentEvidence(materialized.bytes);
  delete incomplete[field];
  const rejected = await validateRebuildTransaction(transaction, materialized, {
    original: source,
    loaderReparse: () => ({ ok: true }),
    independentOracle: () => incomplete,
    validators: external,
  });
  assert.equal(rejected.validators.find((item) => item.validator === 'independent-differential').reason, reason, field);
}
for (const [field, reason] of [
  ['format', 'independent-oracle-format-required'],
  ['architecture', 'independent-oracle-architecture-required'],
]) {
  const incomplete = independentEvidence(materialized.bytes);
  delete incomplete[field];
  const rejected = await validateRebuildTransaction(transaction, materialized, {
    original: source,
    loaderReparse: () => ({ ok: true }),
    independentOracle: () => incomplete,
    validators: external,
  });
  assert.equal(rejected.validators.find((item) => item.validator === 'independent-differential').reason, reason, field);
}
const wrongOracleFormat = await validateRebuildTransaction(transaction, materialized, {
  original: source,
  loaderReparse: () => ({ ok: true }),
  independentOracle: ({ output }) => independentEvidence(output, true, { format: 'elf' }),
  validators: external,
});
assert.equal(wrongOracleFormat.validators.find((item) => item.validator === 'independent-differential').reason, 'independent-oracle-format-mismatch');
const wrongOracleArchitecture = await validateRebuildTransaction(transaction, materialized, {
  original: source,
  loaderReparse: () => ({ ok: true }),
  independentOracle: ({ output }) => independentEvidence(output, true, { architecture: 'x86_64' }),
  validators: external,
});
assert.equal(wrongOracleArchitecture.validators.find((item) => item.validator === 'independent-differential').reason, 'independent-oracle-architecture-mismatch');
const contradictoryOracleStatus = await validateRebuildTransaction(transaction, materialized, {
  original: source,
  loaderReparse: () => ({ ok: true }),
  independentOracle: ({ output }) => independentEvidence(output, true, { status: 'rejected' }),
  validators: external,
});
assert.equal(contradictoryOracleStatus.validators.find((item) => item.validator === 'independent-differential').reason, 'independent-oracle-contract-invalid');
const sameIdentity = await validateRebuildTransaction(transaction, materialized, {
  original: source,
  loaderReparse: () => ({ ok: true }),
  independentOracle: ({ output }) => independentEvidence(output, true, { oracleIdentity: transaction.loaderVersion }),
  validators: external,
});
assert.equal(sameIdentity.validators.find((item) => item.validator === 'independent-differential').reason, 'independent-oracle-identity-not-distinct');
const wrongDigest = await validateRebuildTransaction(transaction, materialized, {
  original: source,
  loaderReparse: () => ({ ok: true }),
  independentOracle: ({ output }) => independentEvidence(output, true, { outputDigest: sourceHash }),
  validators: external,
});
assert.equal(wrongDigest.validators.find((item) => item.validator === 'independent-differential').reason, 'independent-oracle-output-digest-mismatch');

assert.equal((await publishRebuildTransaction(materialized, validation)).reason, 'rebuild-v2-atomic-promotion-required');
assert.equal((await publishRebuildTransaction(materialized, validation, { atomicPromote: async () => ({ atomic: true }) })).reason, 'rebuild-v2-publication-not-atomic');
assert.equal((await publishRebuildTransaction(materialized, validation, { atomicPromote: async () => ({ atomic: true, committed: true, protocol: 'unsafe-copy', publicationIdentity: 'x' }) })).reason, 'rebuild-v2-publication-protocol-invalid');
assert.equal((await publishRebuildTransaction(materialized, validation, { atomicPromote: async () => ({ atomic: true, committed: true, protocol: 'transactional-store' }) })).reason, 'rebuild-v2-publication-identity-required');
const publication = await publishRebuildTransaction(materialized, validation, { atomicPromote: async (_bytes, { materialized: publishedMaterialized }) => ({
  atomic: true,
  committed: true,
  protocol: 'transactional-store',
  publicationIdentity: 'artifact:rebuilt:1',
  transactionId: publishedMaterialized.transactionId,
  outputHash: publishedMaterialized.outputHash,
  outputIdentity: publishedMaterialized.outputIdentity,
}) });
assert.equal(publication.status, 'published');
assert.equal(publication.atomic, true);
assert.equal(publication.committed, true);
assert.equal(publication.outputIdentity, materialized.outputIdentity);
assert.equal((await publishRebuildTransaction(materialized, { ...validation, transactionId: 'rebuild-transaction:stale' }, { atomicPromote: async () => ({ atomic: true, committed: true, protocol: 'transactional-store', publicationIdentity: 'x' }) })).reason, 'rebuild-v2-validation-transaction-mismatch');
assert.equal((await publishRebuildTransaction(materialized, validation, { atomicPromote: async (_bytes, { materialized: publishedMaterialized }) => ({
  atomic: true,
  committed: true,
  protocol: 'transactional-store',
  publicationIdentity: 'x',
  transactionId: publishedMaterialized.transactionId,
  outputHash: publishedMaterialized.outputHash,
  outputIdentity: 'wrong',
}) })).reason, 'rebuild-v2-publication-output-identity-mismatch');

assert.equal((await publishRebuildTransaction(materialized, validation, {
  atomicPromote: async (_bytes, { materialized: publishedMaterialized }) => ({
    atomic: true,
    committed: true,
    protocol: 'transactional-store',
    publicationIdentity: 'wrong-format',
    transactionId: publishedMaterialized.transactionId,
    outputHash: publishedMaterialized.outputHash,
    outputIdentity: publishedMaterialized.outputIdentity,
    format: 'elf',
  }),
})).reason, 'rebuild-v2-publication-identity-mismatch');

// A publication callback that reports commit without binding the persisted
// bytes to this transaction is partial evidence, not a successful publish.
assert.equal((await publishRebuildTransaction(materialized, validation, {
  atomicPromote: async () => ({ atomic: true, committed: true, protocol: 'transactional-store', publicationIdentity: 'partial' }),
})).reason, 'rebuild-v2-publication-identity-incomplete');

// Recomputed validation IDs do not authorize a different binary/format. The
// publication boundary must bind every source identity field to the materialized
// transaction before invoking the writer.
const forgedValidation = { ...validation, binaryId: 'binary:other' };
forgedValidation.validationId = `rebuild-validation:${stableDigest(Object.fromEntries(Object.entries(forgedValidation).filter(([key]) => key !== 'validationId')))}`;
assert.equal((await publishRebuildTransaction(materialized, forgedValidation, {
  atomicPromote: async (_bytes, { materialized: publishedMaterialized }) => ({
    atomic: true,
    committed: true,
    protocol: 'transactional-store',
    publicationIdentity: 'forged',
    transactionId: publishedMaterialized.transactionId,
    outputHash: publishedMaterialized.outputHash,
    outputIdentity: publishedMaterialized.outputIdentity,
  }),
})).reason, 'rebuild-v2-validation-identity-mismatch');

const incompleteTruth = rebuildProfileSupport({ transaction, validation, publication, proof: { exactHead: true, negativeValidatorTest: true, staleIdentityTest: true } });
assert.equal(incompleteTruth.status, 'unsupported', 'one green operation must not promote a whole format F6 profile');
const truth = rebuildProfileSupport({ transaction, validation, publication, proof: {
  exactHead: true,
  negativeValidatorTest: true,
  staleIdentityTest: true,
  formatSpecificValidatorTests: true,
  atomicInterruptionTest: true,
  realFixture: true,
  profileDenominatorComplete: true,
  formatProfileIds: ['macho:64'],
}, profileProof: profileProofs['S2-F6-MACHO'], expectedCommitSha: 'a'.repeat(40), expectedTreeSha: 'b'.repeat(40) });
assert.equal(truth.status, 'unsupported', 'generic validators must not promote broad F6 operation classes');
assert.equal(truth.formatCoverageComplete, true);
assert.equal(truth.f6Denominator.status, 'blocked');
assert.ok(truth.f6Denominator.blockingUnitIds.some((id) => id.endsWith(':relocations-and-bindings')));
assert.ok(truth.f6Denominator.blockingUnitIds.some((id) => id.endsWith(':branch-ranges')));
assert.ok(truth.f6Denominator.blockingUnitIds.some((id) => id.endsWith(':unwind-and-debug')));
assert.ok(truth.f6Denominator.blockingUnitIds.some((id) => id.endsWith(':imports-and-exports')));

const malformedDenominator = evaluateF6RebuildDenominator({ transaction, validation, publication, proof: {
  realFixture: true, realFixtureEvidence: true, negativeValidatorTest: true, staleIdentityTest: true,
  truncationTest: true, wrongIdentityTest: true,
} });
assert.equal(malformedDenominator.status, 'blocked');
assert.ok(malformedDenominator.blockingUnitIds.some((id) => id.endsWith(':signature-consequence')));
const forgedProfileProof = rebuildProfileSupport({ transaction, validation, publication, proof: {
  exactHead: true, negativeValidatorTest: true, staleIdentityTest: true, formatSpecificValidatorTests: true,
  atomicInterruptionTest: true, realFixture: true, profileDenominatorComplete: true, formatProfileIds: ['macho:64'],
}, profileProof: { ...profileProofs['S2-F6-MACHO'] }, expectedCommitSha: 'a'.repeat(40), expectedTreeSha: 'b'.repeat(40) });
assert.equal(forgedProfileProof.status, 'unsupported', 'a copied or caller-fabricated denominator proof must not promote F6');

for (const format of ['macho', 'elf', 'pe']) {
  const tx = transactionFor(format);
  const material = await materializeRebuildTransaction(tx, source, { maxOutputBytes: 1024 });
  assert.equal(material.status, 'materialized', `${format} transaction contract should materialize`);
  assert.equal(tx.format, format);
}

const stale = await materializeRebuildTransaction(transaction, Uint8Array.from([1, 7, 3, 4]));
assert.equal(stale.reason, 'rebuild-v2-source-identity-mismatch');
console.log('[stage2] validated size-changing rebuild tests passed');
