import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stableDigest } from '../../js/core/identity/index.js';
import { functionCandidates } from '../../js/analysis/index.js';
import {
  F6_REBUILD_UNITS,
  INDEPENDENT_ORACLE_RESULT_SCHEMA,
  createRebuildTransaction,
  deriveCanonicalDiscoveryArtifact,
  evaluateF6RebuildDenominator,
  materializeRebuildTransaction,
  publishRebuildTransaction,
  rebuildProfileSupport,
  validateRebuildTransaction,
} from '../../js/rebuild/transaction-v2.js';
import {
  createFormatSafeRebuildTransaction,
  validateFormatSafeMutation,
} from '../../js/rebuild/format-safe.js';
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
const publication = await publishRebuildTransaction(materialized, validation, { atomicPromote: async (bytes, { materialized: publishedMaterialized }) => ({
  atomic: true,
  committed: true,
  protocol: 'transactional-store',
  publicationIdentity: 'artifact:rebuilt:1',
  transactionId: publishedMaterialized.transactionId,
  outputHash: publishedMaterialized.outputHash,
  outputIdentity: publishedMaterialized.outputIdentity,
  committedBytes: Uint8Array.from(bytes),
}) });
assert.equal(publication.status, 'published');
assert.equal(publication.atomic, true);
assert.equal(publication.committed, true);
assert.equal(publication.outputIdentity, materialized.outputIdentity);
const mutatingPromotion = await publishRebuildTransaction(materialized, validation, {
  atomicPromote: async (bytes, { materialized: publishedMaterialized }) => {
    assert.equal(Object.isFrozen(bytes), true);
    const committedBytes = Uint8Array.from(bytes);
    committedBytes[0] = 0xff;
    return {
      atomic: true, committed: true, protocol: 'transactional-store', publicationIdentity: 'mutated',
      transactionId: publishedMaterialized.transactionId, outputHash: publishedMaterialized.outputHash,
      outputIdentity: publishedMaterialized.outputIdentity, committedBytes,
    };
  },
});
assert.notEqual(mutatingPromotion.status, 'published');
assert.equal((await publishRebuildTransaction(materialized, validation, {
  atomicPromote: async (_bytes, { materialized: publishedMaterialized }) => ({
    atomic: true, committed: true, protocol: 'transactional-store', publicationIdentity: 'unverifiable',
    transactionId: publishedMaterialized.transactionId, outputHash: publishedMaterialized.outputHash,
    outputIdentity: publishedMaterialized.outputIdentity,
  }),
})).reason, 'rebuild-v2-publication-bytes-unverifiable');

const promotionAbort = new AbortController();
assert.equal((await publishRebuildTransaction(materialized, validation, {
  signal: promotionAbort.signal,
  atomicPromote: async (bytes, { materialized: publishedMaterialized }) => {
    promotionAbort.abort();
    return {
      atomic: true, committed: true, protocol: 'transactional-store', publicationIdentity: 'late',
      transactionId: publishedMaterialized.transactionId, outputHash: publishedMaterialized.outputHash,
      outputIdentity: publishedMaterialized.outputIdentity, committedBytes: Uint8Array.from(bytes),
    };
  },
})).status, 'cancelled');
const promotionPreAbort = new AbortController();
promotionPreAbort.abort();
let preAbortedPromotions = 0;
assert.equal((await publishRebuildTransaction(materialized, validation, {
  signal: promotionPreAbort.signal,
  atomicPromote: async () => { preAbortedPromotions += 1; return null; },
})).status, 'cancelled');
assert.equal(preAbortedPromotions, 0);
assert.equal((await publishRebuildTransaction(materialized, validation, {
  timeoutMs: 0,
  atomicPromote: async () => { preAbortedPromotions += 1; return null; },
})).reason, 'rebuild-v2-publication-deadline-exceeded');
assert.equal(preAbortedPromotions, 0);
let promotionDeadlineObserved = false;
const deadlinePromotion = await publishRebuildTransaction(materialized, validation, {
  timeoutMs: 20,
  atomicPromote: (bytes, { materialized: publishedMaterialized, signal }) => new Promise((resolve) => {
    const keepAlive = setTimeout(() => resolve({ ok: false }), 1000);
    signal.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      promotionDeadlineObserved = true;
      resolve({
        atomic: true, committed: true, protocol: 'transactional-store', publicationIdentity: 'deadline',
        transactionId: publishedMaterialized.transactionId, outputHash: publishedMaterialized.outputHash,
        outputIdentity: publishedMaterialized.outputIdentity, committedBytes: Uint8Array.from(bytes),
      });
    }, { once: true });
  }),
});
assert.equal(deadlinePromotion.reason, 'rebuild-v2-publication-deadline-exceeded');
assert.equal(promotionDeadlineObserved, true);
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
assert.ok(truth.f6Denominator.blockingUnitIds.some((id) => id.endsWith(':layout-and-structure')));
assert.ok(truth.f6Denominator.blockingUnitIds.some((id) => id.endsWith(':signature-consequence')));

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

// X-03 production path: the format-safe transaction factory binds discovery,
// and the canonical transaction validator derives output discovery internally
// without accepting a test-owned loader-reparse artifact.
const formatSource = new Uint8Array(readFileSync(new URL('../phase5/corpus/fixtures/vertical-sysv-amd64.elf', import.meta.url)));
const formatView = new DataView(formatSource.buffer, formatSource.byteOffset, formatSource.byteLength);
// Repair the fixture's deliberately overdeclared GNU symbol count so this
// positive lane is parser-complete; the unmodified fixture is the negative lane.
formatView.setUint32(660, 0, true);
const sourceFunctionSymbol = 12328 + 8 * 24;
const overlappingFunctionSymbol = 12328 + 7 * 24;
formatSource.copyWithin(overlappingFunctionSymbol, sourceFunctionSymbol, sourceFunctionSymbol + 24);
formatView.setBigUint64(overlappingFunctionSymbol + 8, 0x401008n, true);
formatView.setBigUint64(overlappingFunctionSymbol + 16, 8n, true);
const formatSourceHash = `bytes:${stableDigest(Array.from(formatSource))}`;
const sourceDiscoveryArtifact = deriveCanonicalDiscoveryArtifact({
  source: formatSource,
  binaryId: 'binary:format-safe:x03',
  sourceHash: formatSourceHash,
  snapshotId: 'snapshot:format-safe:source',
  format: 'elf',
  architecture: 'x86_64',
});
const formatTransaction = createFormatSafeRebuildTransaction({
  binaryId: 'binary:format-safe:x03',
  source: formatSource,
  sourceHash: formatSourceHash,
  format: 'elf',
  architecture: 'x86_64',
  loaderVersion: 'loader:format-safe:x03',
  mutation: { kind: 'elf-add-nobits-section', name: '.bss', size: 16, alignment: 8 },
  discoveryArtifact: sourceDiscoveryArtifact,
});
assert.equal(formatTransaction.expectedOriginalState.discoveryBinding.artifactId, sourceDiscoveryArtifact.artifactId);
const formatMaterialized = await materializeRebuildTransaction(formatTransaction, formatSource);
assert.equal(formatMaterialized.status, 'materialized');
const formatLoaderResult = {
  ok: true,
  format: 'elf',
  architecture: 'x86_64',
  loaderVersion: 'loader:format-safe:x03',
  sourceHash: formatSourceHash,
  outputHash: formatMaterialized.outputHash,
};
const syntheticDiscoveryValidation = await validateRebuildTransaction(formatTransaction, formatMaterialized, {
  original: formatSource,
  loaderReparse: () => ({ ...formatLoaderResult, discoveryArtifact: functionCandidates({ input: { image: {} } }).artifact }),
  validators: { layout: validateFormatSafeMutation, 'format-invariants': validateFormatSafeMutation },
});
assert.equal(
  syntheticDiscoveryValidation.validators.find((item) => item.validator === 'loader-reparse').status,
  'passed',
  'callback-authored discovery fields are ignored in favor of canonical output parsing',
);
const formatValidation = await validateRebuildTransaction(formatTransaction, formatMaterialized, {
  original: formatSource,
  loaderReparse: ({ output }) => ({ ...formatLoaderResult, ok: output === formatMaterialized.bytes }),
  validators: { layout: validateFormatSafeMutation, 'format-invariants': validateFormatSafeMutation },
});
assert.equal(formatValidation.validators.find((item) => item.validator === 'loader-reparse').status, 'passed');
const formatMissingDiscovery = await validateRebuildTransaction(formatTransaction, formatMaterialized, {
  original: formatSource,
  loaderReparse: () => ({ ...formatLoaderResult, discoveryArtifact: null }),
  validators: { layout: validateFormatSafeMutation, 'format-invariants': validateFormatSafeMutation },
});
assert.equal(formatMissingDiscovery.validators.find((item) => item.validator === 'loader-reparse').status, 'passed');

const unprovenSource = new Uint8Array(readFileSync(new URL('../phase12/rebuild/fixtures/vertical-macho-x86_64.o', import.meta.url)));
const unprovenSourceHash = `bytes:${stableDigest(Array.from(unprovenSource))}`;
const unprovenLayoutTransaction = createFormatSafeRebuildTransaction({
  binaryId: 'binary:format-safe:x03:unproven',
  source: unprovenSource,
  sourceHash: unprovenSourceHash,
  format: 'macho',
  architecture: 'x86_64',
  loaderVersion: 'loader:format-safe:x03',
  mutation: { kind: 'macho-section-size', segment: '__TEXT', section: '__text', size: 80 },
});
assert.equal(unprovenLayoutTransaction.expectedOriginalState.discoveryStatus, 'unproven');
const unprovenLayoutMaterialized = await materializeRebuildTransaction(unprovenLayoutTransaction, unprovenSource);
const unprovenLayoutValidation = await validateRebuildTransaction(unprovenLayoutTransaction, unprovenLayoutMaterialized, {
  original: unprovenSource,
  loaderReparse: ({ output }) => ({
    ok: output.length === unprovenSource.length,
    format: 'macho', architecture: 'x86_64', loaderVersion: 'loader:format-safe:x03',
    sourceHash: unprovenSourceHash, outputHash: unprovenLayoutMaterialized.outputHash,
  }),
  validators: { layout: validateFormatSafeMutation, 'format-invariants': validateFormatSafeMutation },
});
assert.equal(
  unprovenLayoutValidation.validators.find((item) => item.validator === 'loader-reparse').reason,
  'discovery-source-unproven',
);
console.log('[stage2] validated size-changing rebuild tests passed');
