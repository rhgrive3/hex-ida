import assert from 'node:assert/strict';
import fs from 'node:fs';

import { stableDigestBytes } from '../../js/core/identity/index.js';
import { openBinary } from '../../js/binary/index.js';
import {
  discoveryArtifactForRebuild,
  functionDiscoveryArtifact,
  verifyDiscoveryReparse,
} from '../../js/analysis/index.js';
import { createFormatSafeRebuildTransaction, inspectFormatSafeImage } from '../../js/rebuild/format-safe.js';
import {
  createRebuildTransaction,
  materializeRebuildTransaction,
  validateRebuildTransaction,
} from '../../js/rebuild/transaction-v2.js';

const source = Uint8Array.from([1, 2, 3, 4, 5, 6]);
const sourceHash = `bytes:${stableDigestBytes(source)}`;
const binaryId = 'binary:x03:rebuild';
const architectureId = 'x86_64';

const sourceImage = {
  functions: [{ address: 0x1000, source: 'function_starts', sizeBytes: 0x40 }],
  symbols: [{ address: 0x1100, name: 'ambiguous_candidate', isFunction: true }],
  byteIntervals: [{ kind: 'data', start: 0x1010, end: 0x1020, producerId: 'fixture.bytes', origin: 'inline-data' }],
  jumpTableTargets: [{ address: 0x1028, tableAddress: 0x2000, tableId: 'jt:rebuild' }],
};

function artifactFor(image, hash, snapshotId) {
  return functionDiscoveryArtifact({
    input: { image },
    architectureId,
    binaryId,
    sourceHash: hash,
    snapshotId,
  }).artifact;
}

function validatorsFor(transaction, outputHash) {
  const generic = async () => ({ ok: true, status: 'passed' });
  const validators = {};
  for (const name of transaction.requiredValidators) {
    if (['source-precondition', 'structure', 'unchanged-regions', 'evidence', 'loader-reparse', 'discovery-preservation'].includes(name)) continue;
    validators[name] = generic;
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
  };
}

const sourceArtifact = artifactFor(sourceImage, sourceHash, 'snapshot:x03:source');
assert.equal(sourceArtifact.schemaVersion, 'hex-discovery-ambiguity-artifact/v2');
assert.equal(sourceArtifact.publication.status, 'complete');
assert.ok(sourceArtifact.collisionSets.some((item) => item.kind === 'code-data'));
assert.ok(sourceArtifact.references.some((item) => item.kind === 'jump-table'));
const ambiguousCandidate = sourceArtifact.functionCandidates.find((item) => BigInt(item.start) === 0x1100n);
assert.ok(ambiguousCandidate, 'heuristic symbol candidate must remain represented');
assert.equal(ambiguousCandidate.exact, false);
assert.equal(ambiguousCandidate.startState, 'heuristic');

const transaction = createRebuildTransaction({
  binaryId,
  sourceHash,
  format: 'elf',
  architecture: architectureId,
  loaderVersion: 'loader:x03:test',
  snapshotId: 'snapshot:x03:source',
  discoveryArtifact: sourceArtifact,
  requireDiscoveryPreservation: true,
  operations: [{ id: 'x03:patch', offset: 1, before: [2], after: [9], provenance: { source: 'x03-test' } }],
});
assert.equal(transaction.discovery?.required, true);
assert.ok(transaction.requiredValidators.includes('discovery-preservation'));
assert.ok(transaction.requiredValidators.includes('loader-reparse'));
assert.equal(transaction.expectedOriginalState.discovery.artifactId, sourceArtifact.artifactId);

const materialized = await materializeRebuildTransaction(transaction, source, { maxOutputBytes: 1024 });
assert.equal(materialized.status, 'materialized');

const outputArtifact = artifactFor(sourceImage, materialized.outputHash, 'snapshot:x03:output');
const valid = await validateRebuildTransaction(transaction, materialized, {
  original: source,
  discoveryArtifact: outputArtifact,
  ...validatorsFor(transaction, materialized.outputHash),
});
assert.equal(valid.status, 'valid', JSON.stringify(valid.failures));
assert.equal(valid.discovery.comparison.ok, true);
assert.equal(valid.discovery.comparison.candidatesPreserved, true);
assert.equal(valid.discovery.comparison.intervalsPreserved, true);

const lostImage = {
  functions: [{ address: 0x1000, source: 'function_starts', sizeBytes: 0x40 }],
};
const lostArtifact = artifactFor(lostImage, materialized.outputHash, 'snapshot:x03:lost');
const lost = await validateRebuildTransaction(transaction, materialized, {
  original: source,
  discoveryArtifact: lostArtifact,
  ...validatorsFor(transaction, materialized.outputHash),
});
assert.equal(lost.status, 'invalid');
assert.equal(lost.discovery.comparison.reason, 'discovery-reparse-ambiguity-lost');
assert.equal(lost.discovery.comparison.candidatesPreserved, false, 'ambiguous candidate must not disappear');
assert.ok(lost.discovery.comparison.missingCollisionIds.length > 0, 'code/data collision must not disappear');
assert.ok(lost.discovery.comparison.missingReferenceIds.length > 0, 'jump-table evidence must not disappear');

const promotedImage = {
  ...sourceImage,
  symbols: [],
  functions: [
    ...sourceImage.functions,
    { address: 0x1100, source: 'function_starts', sizeBytes: 0x10 },
  ],
};
const promotedArtifact = artifactFor(promotedImage, materialized.outputHash, 'snapshot:x03:promoted');
const promotedCandidate = promotedArtifact.functionCandidates.find((item) => BigInt(item.start) === 0x1100n);
assert.equal(promotedCandidate?.exact, true);
const promoted = await validateRebuildTransaction(transaction, materialized, {
  original: source,
  discoveryArtifact: promotedArtifact,
  ...validatorsFor(transaction, materialized.outputHash),
});
assert.equal(promoted.status, 'invalid');
assert.equal(promoted.discovery.comparison.reason, 'discovery-reparse-ambiguity-lost');
assert.equal(promoted.discovery.comparison.candidatesPreserved, false, 'heuristic candidate must not silently become exact');

const staleArtifact = artifactFor(sourceImage, sourceHash, 'snapshot:x03:stale-output');
const stale = await validateRebuildTransaction(transaction, materialized, {
  original: source,
  discoveryArtifact: staleArtifact,
  ...validatorsFor(transaction, materialized.outputHash),
});
assert.equal(stale.status, 'invalid');
assert.equal(stale.discovery.comparison.reason, 'discovery-reparse-output-hash-mismatch');

const issuedBinding = discoveryArtifactForRebuild(sourceArtifact);
assert.throws(() => createRebuildTransaction({
  binaryId,
  sourceHash,
  format: 'elf',
  architecture: architectureId,
  loaderVersion: 'loader:x03:test',
  snapshotId: 'snapshot:x03:source',
  discoveryBinding: structuredClone(issuedBinding),
  requireDiscoveryPreservation: true,
  operations: [{ id: 'x03:forged-binding', offset: 1, before: [2], after: [9], provenance: { source: 'x03-test' } }],
}), /discovery-binding-unissued/);

// Production adapter wiring: format-safe planning binds the same v2 artifact
// and delegates ambiguity preservation to transaction-v2.
const formatFixture = new Uint8Array(fs.readFileSync(new URL('../phase5/corpus/fixtures/vertical-sysv-amd64.elf', import.meta.url)));
const formatImage = inspectFormatSafeImage(formatFixture);
assert.equal(formatImage.format, 'elf');
assert.equal(formatImage.architecture, 'x86_64');
const formatHash = `bytes:${stableDigestBytes(formatFixture)}`;
const formatSourceImage = openBinary(formatFixture);
const formatArtifact = functionDiscoveryArtifact({
  input: { image: formatSourceImage },
  architectureId: formatSourceImage.arch,
  binaryId: 'binary:x03:format-safe',
  sourceHash: formatHash,
  snapshotId: 'snapshot:x03:format-safe-source',
}).artifact;
assert.equal(formatArtifact.publication.status, 'complete');
const formatTransaction = createFormatSafeRebuildTransaction({
  binaryId: 'binary:x03:format-safe',
  source: formatFixture,
  sourceHash: formatHash,
  format: formatImage.format,
  architecture: formatImage.architecture,
  loaderVersion: 'loader:x03:format-safe',
  mutation: { kind: 'elf-comment', tag: 'Hex X03 local' },
  discoveryArtifact: formatArtifact,
});
assert.equal(formatTransaction.discovery?.required, true);
assert.equal(formatTransaction.requireIndependentOracle, true);
assert.equal(formatTransaction.expectedOriginalState.discovery.artifactId, formatArtifact.artifactId);
const formatMaterialized = await materializeRebuildTransaction(formatTransaction, formatFixture, { maxOutputBytes: 32 * 1024 * 1024 });
assert.equal(formatMaterialized.status, 'materialized');
const formatOutputImage = openBinary(formatMaterialized.bytes);
const formatOutputArtifact = functionDiscoveryArtifact({
  input: { image: formatOutputImage },
  architectureId: formatOutputImage.arch,
  binaryId: 'binary:x03:format-safe',
  sourceHash: formatMaterialized.outputHash,
  snapshotId: 'snapshot:x03:format-safe-output',
}).artifact;
const formatBinding = discoveryArtifactForRebuild(formatArtifact);
const formatReparse = verifyDiscoveryReparse(formatBinding, formatOutputArtifact, { expectedOutputHash: formatMaterialized.outputHash });
assert.equal(formatReparse.ok, true, JSON.stringify(formatReparse));

console.log('stage2 X-03 rebuild discovery v2: PASS');
