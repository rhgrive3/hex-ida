import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stableDigest } from '../../js/core/identity/index.js';
import { openBinary } from '../../js/binary/index.js';
import {
  functionDiscoveryArtifact,
  verifyDiscoveryReparse,
} from '../../js/analysis/index.js';
import {
  isFactoryIssuedDiscoveryArtifact,
  isFactoryIssuedDiscoveryRebuildBinding,
} from '../../js/analysis/discovery/artifact.js';
import {
  createFormatSafeRebuildTransaction,
  inspectFormatSafeImage,
  validateFormatSafeMutation,
} from '../../js/rebuild/format-safe.js';
import {
  INDEPENDENT_ORACLE_RESULT_SCHEMA,
  createRebuildTransaction,
  materializeRebuildTransaction,
  registerCanonicalIndependentOracleProvider,
  validateRebuildTransaction,
} from '../../js/rebuild/transaction-v2.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const digest = (bytes) => `bytes:${stableDigest(Array.from(bytes))}`;

console.log('[x03-acceptance] verifying HEX-X-03 / FR-X-03A ambiguity-preserving discovery & rebuild acceptance...');

const source = Uint8Array.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
const sourceHash = digest(source);
const binaryId = 'binary:x03:rebuild-acceptance';
const architectureId = 'x86_64';

// ---------------------------------------------------------------------------
// Test 1: Discovery Denominator & Ambiguity Preservation (Code/Data & Overlap)
// ---------------------------------------------------------------------------
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

const sourceArtifactResult = functionDiscoveryArtifact({
  input: { image: sourceImage },
  architectureId,
  binaryId,
  sourceHash,
  snapshotId: 'snapshot:x03:source-1',
});
const sourceArtifact = sourceArtifactResult.artifact;

assert.equal(isFactoryIssuedDiscoveryArtifact(sourceArtifact), true);
assert.equal(sourceArtifact.schemaVersion, 'hex-discovery-ambiguity-artifact/v1');
assert.equal(sourceArtifact.publication.status, 'complete');

// Code-data collision must be retained with resolution: 'unresolved'
const codeDataCollision = sourceArtifact.collisionSets.find((c) => c.kind === 'code-data');
assert.ok(codeDataCollision, 'code/data collision must be preserved');
assert.equal(codeDataCollision.resolution, 'unresolved');

// Function overlap collision must be retained
const funcOverlapCollision = sourceArtifact.collisionSets.find((c) => c.kind === 'function-overlap');
assert.ok(funcOverlapCollision, 'function-overlap collision must be preserved');

// Ambiguous candidate must be retained
const ambigCandidate = sourceArtifact.functionCandidates.find((c) => BigInt(c.start) === 0x1100n);
assert.ok(ambigCandidate, 'ambiguous candidate must exist');
assert.equal(ambigCandidate.ambiguous, true);
assert.equal(ambigCandidate.startState, 'heuristic');

console.log('  ok 1: discovery denominator & ambiguity preservation passed');

// ---------------------------------------------------------------------------
// Test 2: Anti-Promotion & Rank / Confidence Neutrality
// ---------------------------------------------------------------------------
const highConfidenceResult = functionDiscoveryArtifact({
  input: {
    image: {
      symbols: [{ address: 0x3000, name: 'speculative_high_score', isFunction: true, score: 1e9, confidence: 1.0 }],
    },
  },
  architectureId,
  binaryId,
  sourceHash,
  snapshotId: 'snapshot:x03:confidence-1',
});
const highConfCandidate = highConfidenceResult.artifact.functionCandidates.find((c) => BigInt(c.start) === 0x3000n);
assert.ok(highConfCandidate);
assert.equal(highConfCandidate.startState, 'heuristic', 'confidence/score must not promote to exact');
assert.equal(highConfCandidate.ambiguous, true);
assert.equal(Object.hasOwn(highConfCandidate, 'exact'), false, 'artifact must not mint an exact authority flag');
assert.equal(Object.hasOwn(highConfCandidate, 'selected'), false, 'artifact must not pick a speculative winner');
console.log('  ok 2: anti-promotion & rank/confidence neutrality passed');

// ---------------------------------------------------------------------------
// Test 3: Reference Preservation & Symbolic Metadata
// ---------------------------------------------------------------------------
const refResult = functionDiscoveryArtifact({
  input: {
    image: {
      functions: [{ address: 0x4000, source: 'function_starts', sizeBytes: 0x40 }],
      jumpTableTargets: [
        { address: 0x4010, tableAddress: 0x5000, tableId: 'jt:test', symbolicExpression: { base: 'pc', scale: 4 } },
      ],
      relocationTargets: [
        { address: 0x4020, sourceAddress: 0x6000, id: 'reloc:1', symbolicExpression: { symbol: 'external_fn', addend: 0 } },
      ],
    },
  },
  architectureId,
  binaryId,
  sourceHash,
  snapshotId: 'snapshot:x03:refs-1',
});
assert.equal(refResult.candidates.some((c) => BigInt(c.start) === 0x4010n), false, 'jump-table must not manufacture a false function start');
const jtRef = refResult.artifact.references.find((r) => r.kind === 'jump-table');
assert.ok(jtRef);
assert.equal(jtRef.tableId, 'jt:test');
assert.deepEqual(jtRef.symbolicExpression, { base: 'pc', scale: 4 });

const relocRef = refResult.artifact.references.find((r) => r.kind === 'relocation');
assert.ok(relocRef);
assert.equal(relocRef.relocationId, 'reloc:1');
assert.deepEqual(relocRef.symbolicExpression, { symbol: 'external_fn', addend: 0 });

// Malformed reference fails closed
assert.throws(() => functionDiscoveryArtifact({
  input: { image: { jumpTableTargets: [{ address: 'not-a-number' }] } },
  architectureId, binaryId, sourceHash, snapshotId: 'snapshot:bad',
}), /TypeError/);
console.log('  ok 3: reference preservation & symbolic metadata passed');

// ---------------------------------------------------------------------------
// Test 4: Discovery Rebuild Transaction Binding
// ---------------------------------------------------------------------------
const tx = createRebuildTransaction({
  binaryId,
  sourceHash,
  format: 'elf',
  architecture: architectureId,
  loaderVersion: 'hex-loader:x03:v1',
  discoveryArtifact: sourceArtifact,
  operations: [{ id: 'x03:patch', offset: 1, before: [0x02], after: [0x88], provenance: { source: 'x03-acceptance' } }],
});
assert.equal(tx.discoveryRequired, true);
assert.equal(tx.requireIndependentOracle, true, 'discovery-bound transaction reuses X-01 independent oracle authority');
assert.ok(tx.requiredValidators.includes('loader-reparse'));
assert.ok(tx.requiredValidators.includes('independent-differential'));
assert.ok(isFactoryIssuedDiscoveryRebuildBinding(tx.expectedOriginalState.discoveryBinding));

// Missing discovery binding when discoveryRequired is asserted
assert.throws(() => createRebuildTransaction({
  binaryId, sourceHash, format: 'elf', architecture: architectureId, loaderVersion: 'v1',
  discoveryRequired: true,
  operations: [{ id: 'x03:no-binding', offset: 1, before: [0x02], after: [0x88], provenance: { source: 'test' } }],
}), /discovery-binding-required/);

// Forged discovery binding
const forgedBinding = { ...tx.expectedOriginalState.discoveryBinding };
assert.throws(() => createRebuildTransaction({
  binaryId, sourceHash, format: 'elf', architecture: architectureId, loaderVersion: 'v1',
  expectedOriginalState: { sourceHash, discoveryBinding: forgedBinding },
  operations: [{ id: 'x03:forged', offset: 1, before: [0x02], after: [0x88], provenance: { source: 'test' } }],
}), /discovery-binding-untrusted/);
console.log('  ok 4: discovery rebuild transaction binding passed');

// ---------------------------------------------------------------------------
// Test 5: Reparse Gate — Anti-Loss Validation
// ---------------------------------------------------------------------------
const materialized = await materializeRebuildTransaction(tx, source, { maxOutputBytes: 1024 });
assert.equal(materialized.status, 'materialized');

function makeOracleResult(output) {
  return {
    schemaVersion: INDEPENDENT_ORACLE_RESULT_SCHEMA,
    ok: true,
    status: 'passed',
    oracleIdentity: 'external:x03-acceptance-oracle',
    oracleVersion: '1.0.0',
    oracleSource: 'tests/stage2/x03-rebuild-discovery-acceptance.test.mjs',
    sourceDigest: sourceHash,
    outputDigest: digest(output),
    format: 'elf',
    architecture: architectureId,
  };
}
const testOracle = registerCanonicalIndependentOracleProvider(async ({ output }) => makeOracleResult(output));

// Honest output artifact (retaining all candidates, collisions, and references)
const validOutputArtifact = functionDiscoveryArtifact({
  input: { image: sourceImage },
  architectureId,
  binaryId,
  sourceHash: materialized.outputHash,
  snapshotId: 'snapshot:x03:output-valid',
}).artifact;

const validValidation = await validateRebuildTransaction(tx, materialized, {
  original: source,
  loaderReparse: () => ({ ok: true, discoveryArtifact: validOutputArtifact }),
  independentOracle: testOracle,
});
assert.equal(validValidation.status, 'valid');

// Negative: Loss of ambiguous candidate, collision, or reference
const strippedImage = {
  functions: [{ address: 0x1000, source: 'function_starts', sizeBytes: 0x40 }],
};
const strippedArtifact = functionDiscoveryArtifact({
  input: { image: strippedImage },
  architectureId,
  binaryId,
  sourceHash: materialized.outputHash,
  snapshotId: 'snapshot:x03:stripped',
}).artifact;

const strippedValidation = await validateRebuildTransaction(tx, materialized, {
  original: source,
  loaderReparse: () => ({ ok: true, discoveryArtifact: strippedArtifact }),
  independentOracle: testOracle,
});
assert.equal(strippedValidation.status, 'invalid');
const strippedLoader = strippedValidation.validators.find((v) => v.validator === 'loader-reparse');
assert.equal(strippedLoader.reason, 'discovery-reparse-ambiguity-lost');
assert.ok(strippedLoader.detail.missingCandidateIds.length > 0, 'missing candidates must be caught');
assert.ok(strippedLoader.detail.missingCollisionIds.length > 0, 'missing collisions must be caught');
assert.ok(strippedLoader.detail.missingReferenceIds.length > 0, 'missing references must be caught');
console.log('  ok 5: reparse gate anti-loss validation passed');

// ---------------------------------------------------------------------------
// Test 6: Reparse Gate — Anti-Silent Promotion & Hash Synchronization
// ---------------------------------------------------------------------------
// Negative: Silent promotion of heuristic candidate to exact function_starts
const promotedImage = {
  ...sourceImage,
  symbols: [],
  functions: [
    ...sourceImage.functions,
    { address: 0x1100, source: 'function_starts', sizeBytes: 0x20 },
  ],
};
const promotedArtifact = functionDiscoveryArtifact({
  input: { image: promotedImage },
  architectureId,
  binaryId,
  sourceHash: materialized.outputHash,
  snapshotId: 'snapshot:x03:promoted',
}).artifact;

const promotedValidation = await validateRebuildTransaction(tx, materialized, {
  original: source,
  loaderReparse: () => ({ ok: true, discoveryArtifact: promotedArtifact }),
  independentOracle: testOracle,
});
assert.equal(promotedValidation.status, 'invalid');
const promotedLoader = promotedValidation.validators.find((v) => v.validator === 'loader-reparse');
assert.equal(promotedLoader.reason, 'discovery-reparse-ambiguity-lost');
assert.ok(promotedLoader.detail.promotedCandidateIds.length > 0, 'silent promotion must be caught');

// Negative: Stale output artifact sourceHash
const staleArtifact = functionDiscoveryArtifact({
  input: { image: sourceImage },
  architectureId,
  binaryId,
  sourceHash: sourceHash, // stale hash!
  snapshotId: 'snapshot:x03:stale',
}).artifact;
const staleValidation = await validateRebuildTransaction(tx, materialized, {
  original: source,
  loaderReparse: () => ({ ok: true, discoveryArtifact: staleArtifact }),
  independentOracle: testOracle,
});
assert.equal(staleValidation.status, 'invalid');
assert.equal(staleValidation.validators.find((v) => v.validator === 'loader-reparse').reason, 'discovery-reparse-output-hash-mismatch');
console.log('  ok 6: reparse gate anti-silent promotion & hash synchronization passed');

// ---------------------------------------------------------------------------
// Test 7: End-to-End Format-Safe Rebuild with Discovery Binding
// ---------------------------------------------------------------------------
const elfFixture = new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests/phase5/corpus/fixtures/vertical-sysv-amd64.elf')));
const elfImage = inspectFormatSafeImage(elfFixture);
const elfHash = digest(elfFixture);
const elfBinaryImage = openBinary(elfFixture);

const elfArtifact = functionDiscoveryArtifact({
  input: { image: elfBinaryImage },
  architectureId: elfBinaryImage.arch,
  binaryId: 'binary:elf:x03-format-safe',
  sourceHash: elfHash,
  snapshotId: 'snapshot:elf:source',
}).artifact;
assert.equal(elfArtifact.publication.status, 'complete');

const elfFsTx = createFormatSafeRebuildTransaction({
  binaryId: 'binary:elf:x03-format-safe',
  source: elfFixture,
  sourceHash: elfHash,
  format: elfImage.format,
  architecture: elfImage.architecture,
  loaderVersion: 'hex-loader:openBinary:v1',
  mutation: { kind: 'elf-comment', tag: 'Hex X03 Local Acceptance' },
  discoveryArtifact: elfArtifact,
});
assert.equal(elfFsTx.discoveryRequired, true);
assert.equal(elfFsTx.requireIndependentOracle, true);
assert.equal(elfFsTx.expectedOriginalState.discoveryBinding.artifactId, elfArtifact.artifactId);

const elfFsMaterialized = await materializeRebuildTransaction(elfFsTx, elfFixture, { maxOutputBytes: 32 * 1024 * 1024 });
assert.equal(elfFsMaterialized.status, 'materialized');

const elfOutputBinaryImage = openBinary(elfFsMaterialized.bytes);
const elfOutputArtifact = functionDiscoveryArtifact({
  input: { image: elfOutputBinaryImage },
  architectureId: elfOutputBinaryImage.arch,
  binaryId: 'binary:elf:x03-format-safe',
  sourceHash: elfFsMaterialized.outputHash,
  snapshotId: 'snapshot:elf:output',
}).artifact;

const reparseCheck = verifyDiscoveryReparse(
  elfFsTx.expectedOriginalState.discoveryBinding,
  elfOutputArtifact,
  { expectedOutputHash: elfFsMaterialized.outputHash },
);
assert.equal(reparseCheck.ok, true, JSON.stringify(reparseCheck));

console.log('  ok 7: end-to-end format-safe rebuild with discovery binding passed');
console.log('[x03-acceptance] all 7 tests passed.');
