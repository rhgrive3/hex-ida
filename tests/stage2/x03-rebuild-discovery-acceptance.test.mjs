import assert from 'node:assert/strict';

import { stableDigestBytes } from '../../js/core/identity/index.js';
import {
  discoveryArtifactForRebuild,
  functionDiscoveryArtifact,
} from '../../js/analysis/index.js';
import {
  isFactoryIssuedDiscoveryArtifact,
  isFactoryIssuedDiscoveryRebuildBinding,
} from '../../js/analysis/discovery/artifact.js';
import { canonicalTypedValue } from '../../js/analysis/discovery/canonical-value.js';
import {
  INDEPENDENT_ORACLE_RESULT_SCHEMA,
  createRebuildTransaction,
  materializeRebuildTransaction,
  registerCanonicalIndependentOracleProvider,
  validateRebuildTransaction,
} from '../../js/rebuild/transaction-v2.js';

const digest = (bytes) => `bytes:${stableDigestBytes(bytes)}`;
const source = Uint8Array.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
const sourceHash = digest(source);
const binaryId = 'binary:x03:rebuild-acceptance';
const architectureId = 'x86_64';

console.log('[x03-acceptance] verifying HEX-X-03 v2 ambiguity preservation...');

const sourceImage = {
  functions: [
    { address: 0x1000, source: 'function_starts', sizeBytes: 0x40 },
    { address: 0x2000, source: 'function_starts', sizeBytes: 0x30 },
    { address: 0x2020, source: 'function_starts', sizeBytes: 0x30 },
  ],
  symbols: [{ address: 0x1100, name: 'ambiguous_func', isFunction: true }],
  byteIntervals: [
    { kind: 'data', start: 0x1010, end: 0x1020, producerId: 'test.data-classifier', origin: 'fixture:inline-data' },
  ],
  jumpTableTargets: [
    { address: 0x1028, tableAddress: 0x2000, tableId: 'jt:rebuild:1', symbolicExpression: { base: 'pc', scale: 4 } },
  ],
};

function discover(image, hash, snapshotId) {
  return functionDiscoveryArtifact({
    input: { image },
    architectureId,
    binaryId,
    sourceHash: hash,
    snapshotId,
  });
}

// 1. Denominator: preserve code/data, function overlap, and heuristic candidates.
const sourceResult = discover(sourceImage, sourceHash, 'snapshot:x03:source-1');
const sourceArtifact = sourceResult.artifact;
assert.equal(isFactoryIssuedDiscoveryArtifact(sourceArtifact), true);
assert.equal(sourceArtifact.schemaVersion, 'hex-discovery-ambiguity-artifact/v2');
assert.equal(sourceArtifact.publication.status, 'complete');
assert.ok(sourceArtifact.collisionSets.some((item) => item.kind === 'code-data' && item.resolution === 'unresolved'));
assert.ok(sourceArtifact.collisionSets.some((item) => item.kind === 'function-overlap' && item.resolution === 'unresolved'));
const ambiguousCandidate = sourceArtifact.functionCandidates.find((item) => BigInt(item.start) === 0x1100n);
assert.ok(ambiguousCandidate);
assert.equal(ambiguousCandidate.startState, 'heuristic');
assert.equal(ambiguousCandidate.exact, false);
console.log('  ok 1: v2 denominator preserves ambiguity');

// 2. Rank/confidence cannot promote a speculative source into exact authority.
const highConfidenceArtifact = discover({
  symbols: [{ address: 0x3000, name: 'speculative_high_score', isFunction: true, score: 1e9, confidence: 1.0 }],
}, sourceHash, 'snapshot:x03:confidence-1').artifact;
const highConfidenceCandidate = highConfidenceArtifact.functionCandidates.find((item) => BigInt(item.start) === 0x3000n);
assert.ok(highConfidenceCandidate);
assert.equal(highConfidenceCandidate.startState, 'heuristic');
assert.equal(highConfidenceCandidate.exact, false);
assert.equal(Object.hasOwn(highConfidenceCandidate, 'selected'), false);
console.log('  ok 2: confidence/rank cannot mint exactness');

// 3. Preserve jump-table/relocation metadata without manufacturing jump-table starts.
const refResult = discover({
  functions: [{ address: 0x4000, source: 'function_starts', sizeBytes: 0x40 }],
  jumpTableTargets: [
    { address: 0x4010, tableAddress: 0x5000, tableId: 'jt:test', symbolicExpression: { base: 'pc', scale: 4 } },
  ],
  relocationTargets: [
    { address: 0x4020, sourceAddress: 0x6000, id: 'reloc:1', symbolicExpression: { symbol: 'external_fn', addend: 0 } },
  ],
}, sourceHash, 'snapshot:x03:refs-1');
assert.equal(refResult.candidates.some((candidate) => BigInt(candidate.start) === 0x4010n), false);
const jumpReference = refResult.artifact.references.find((item) => item.kind === 'jump-table');
assert.ok(jumpReference);
assert.equal(jumpReference.tableId, 'jt:test');
assert.deepEqual(jumpReference.symbolicExpression, canonicalTypedValue({ base: 'pc', scale: 4 }));
const relocationReference = refResult.artifact.references.find((item) => item.kind === 'relocation');
assert.ok(relocationReference);
assert.equal(relocationReference.relocationId, 'reloc:1');
assert.deepEqual(relocationReference.symbolicExpression, canonicalTypedValue({ symbol: 'external_fn', addend: 0 }));
assert.throws(() => discover({ jumpTableTargets: [{ address: 'not-a-number' }] }, sourceHash, 'snapshot:x03:bad-ref'), /TypeError/);
console.log('  ok 3: reference metadata preserved fail-closed');

// 4. Bind the factory-issued v2 artifact to rebuild validation. Independent
// authority remains explicit rather than being inferred from discovery alone.
const sourceBinding = discoveryArtifactForRebuild(sourceArtifact);
assert.equal(isFactoryIssuedDiscoveryRebuildBinding(sourceBinding), true);
const transaction = createRebuildTransaction({
  binaryId,
  sourceHash,
  format: 'elf',
  architecture: architectureId,
  loaderVersion: 'hex-loader:x03:v2',
  snapshotId: 'snapshot:x03:source-1',
  discoveryArtifact: sourceArtifact,
  requireDiscoveryPreservation: true,
  requireIndependentOracle: true,
  operations: [{ id: 'x03:patch', offset: 1, before: [0x02], after: [0x88], provenance: { source: 'x03-acceptance' } }],
});
assert.equal(transaction.discovery?.required, true);
assert.equal(transaction.requireIndependentOracle, true);
assert.ok(transaction.requiredValidators.includes('discovery-preservation'));
assert.ok(transaction.requiredValidators.includes('loader-reparse'));
assert.ok(transaction.requiredValidators.includes('independent-differential'));
assert.equal(transaction.expectedOriginalState.discovery.artifactId, sourceArtifact.artifactId);
assert.throws(() => createRebuildTransaction({
  binaryId,
  sourceHash,
  format: 'elf',
  architecture: architectureId,
  loaderVersion: 'hex-loader:x03:v2',
  snapshotId: 'snapshot:x03:source-1',
  discoveryBinding: structuredClone(sourceBinding),
  requireDiscoveryPreservation: true,
  operations: [{ id: 'x03:forged', offset: 1, before: [0x02], after: [0x88], provenance: { source: 'test' } }],
}), /discovery-binding-unissued/);
console.log('  ok 4: factory binding and explicit independent authority enforced');

const materialized = await materializeRebuildTransaction(transaction, source, { maxOutputBytes: 1024 });
assert.equal(materialized.status, 'materialized');

function makeOracleResult(output) {
  return {
    schemaVersion: INDEPENDENT_ORACLE_RESULT_SCHEMA,
    ok: true,
    status: 'passed',
    oracleIdentity: 'external:x03-acceptance-oracle',
    oracleVersion: '2.0.0',
    oracleSource: 'tests/stage2/x03-rebuild-discovery-acceptance.test.mjs',
    sourceDigest: sourceHash,
    outputDigest: digest(output),
    format: 'elf',
    architecture: architectureId,
  };
}
const independentOracle = registerCanonicalIndependentOracleProvider(async ({ output }) => makeOracleResult(output));

function validatorsFor(outputHash, { includeIndependent = true } = {}) {
  const validators = {};
  for (const name of transaction.requiredValidators) {
    if (['source-precondition', 'structure', 'unchanged-regions', 'evidence', 'loader-reparse', 'discovery-preservation', 'independent-differential'].includes(name)) continue;
    validators[name] = async () => ({ ok: true, status: 'passed' });
  }
  return {
    validators,
    loaderReparse: async () => ({
      ok: true,
      status: 'passed',
      format: transaction.format,
      architecture: transaction.architecture,
      loaderVersion: transaction.loaderVersion,
      sourceHash: transaction.sourceHash,
      outputHash,
    }),
    ...(includeIndependent ? { independentOracle } : {}),
  };
}

// 5. Honest reparse preserves the full v2 denominator.
const validOutputArtifact = discover(sourceImage, materialized.outputHash, 'snapshot:x03:output-valid').artifact;
const validValidation = await validateRebuildTransaction(transaction, materialized, {
  original: source,
  discoveryArtifact: validOutputArtifact,
  ...validatorsFor(materialized.outputHash),
});
assert.equal(validValidation.status, 'valid', JSON.stringify(validValidation.failures));
assert.equal(validValidation.discovery.comparison.ok, true);
assert.equal(validValidation.discovery.comparison.candidatesPreserved, true);
assert.equal(validValidation.discovery.comparison.intervalsPreserved, true);
assert.equal(validValidation.independentDifferential, 'executed');
console.log('  ok 5: honest reparse validates');

// 6. Loss, silent promotion, and stale output identity all fail closed.
const strippedArtifact = discover({
  functions: [{ address: 0x1000, source: 'function_starts', sizeBytes: 0x40 }],
}, materialized.outputHash, 'snapshot:x03:stripped').artifact;
const strippedValidation = await validateRebuildTransaction(transaction, materialized, {
  original: source,
  discoveryArtifact: strippedArtifact,
  ...validatorsFor(materialized.outputHash),
});
assert.equal(strippedValidation.status, 'invalid');
assert.equal(strippedValidation.discovery.comparison.reason, 'discovery-reparse-ambiguity-lost');
assert.equal(strippedValidation.discovery.comparison.candidatesPreserved, false);
assert.ok(strippedValidation.discovery.comparison.missingCollisionIds.length > 0);
assert.ok(strippedValidation.discovery.comparison.missingReferenceIds.length > 0);

const promotedImage = {
  ...sourceImage,
  symbols: [],
  functions: [...sourceImage.functions, { address: 0x1100, source: 'function_starts', sizeBytes: 0x20 }],
};
const promotedArtifact = discover(promotedImage, materialized.outputHash, 'snapshot:x03:promoted').artifact;
assert.equal(promotedArtifact.functionCandidates.find((item) => BigInt(item.start) === 0x1100n)?.exact, true);
const promotedValidation = await validateRebuildTransaction(transaction, materialized, {
  original: source,
  discoveryArtifact: promotedArtifact,
  ...validatorsFor(materialized.outputHash),
});
assert.equal(promotedValidation.status, 'invalid');
assert.equal(promotedValidation.discovery.comparison.reason, 'discovery-reparse-ambiguity-lost');
assert.equal(promotedValidation.discovery.comparison.candidatesPreserved, false);

const staleArtifact = discover(sourceImage, sourceHash, 'snapshot:x03:stale').artifact;
const staleValidation = await validateRebuildTransaction(transaction, materialized, {
  original: source,
  discoveryArtifact: staleArtifact,
  ...validatorsFor(materialized.outputHash),
});
assert.equal(staleValidation.status, 'invalid');
assert.equal(staleValidation.discovery.comparison.reason, 'discovery-reparse-output-hash-mismatch');

const missingIndependent = await validateRebuildTransaction(transaction, materialized, {
  original: source,
  discoveryArtifact: validOutputArtifact,
  ...validatorsFor(materialized.outputHash, { includeIndependent: false }),
});
assert.equal(missingIndependent.status, 'invalid');
assert.equal(missingIndependent.validators.find((item) => item.validator === 'independent-differential').reason, 'required-validator-unavailable');
console.log('  ok 6: anti-loss, anti-promotion, hash and independent gates fail closed');

console.log('[x03-acceptance] v2 acceptance passed.');
