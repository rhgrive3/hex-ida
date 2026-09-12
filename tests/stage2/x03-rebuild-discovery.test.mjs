import assert from 'node:assert/strict';
import fs from 'node:fs';

import { stableDigest } from '../../js/core/identity/index.js';
import { openBinary } from '../../js/binary/index.js';
import { functionDiscoveryArtifact, verifyDiscoveryReparse } from '../../js/analysis/index.js';
import { createFormatSafeRebuildTransaction, inspectFormatSafeImage } from '../../js/rebuild/format-safe.js';
import {
  INDEPENDENT_ORACLE_RESULT_SCHEMA,
  createRebuildTransaction,
  materializeRebuildTransaction,
  validateRebuildTransaction,
} from '../../js/rebuild/transaction-v2.js';

const source = Uint8Array.from([1, 2, 3, 4, 5, 6]);
const sourceHash = `bytes:${stableDigest(Array.from(source))}`;
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

const sourceArtifact = artifactFor(sourceImage, sourceHash, 'snapshot:x03:source');
assert.equal(sourceArtifact.publication.status, 'complete');
assert.ok(sourceArtifact.collisionSets.some((item) => item.kind === 'code-data'));
assert.ok(sourceArtifact.references.some((item) => item.kind === 'jump-table'));
assert.ok(sourceArtifact.functionCandidates.some((item) => item.ambiguous));

const transaction = createRebuildTransaction({
  binaryId,
  sourceHash,
  format: 'elf',
  architecture: architectureId,
  loaderVersion: 'loader:x03:test',
  discoveryArtifact: sourceArtifact,
  operations: [{ id: 'x03:patch', offset: 1, before: [2], after: [9], provenance: { source: 'x03-test' } }],
});
assert.equal(transaction.discoveryRequired, true);
assert.equal(transaction.requireIndependentOracle, true, 'X-03 binding must reuse X-01 independent authority');
assert.ok(transaction.requiredValidators.includes('loader-reparse'));
assert.ok(transaction.requiredValidators.includes('independent-differential'));
assert.ok(transaction.expectedOriginalState.discoveryBinding);

const materialized = await materializeRebuildTransaction(transaction, source, { maxOutputBytes: 1024 });
assert.equal(materialized.status, 'materialized');

function oracleResult(output) {
  return {
    schemaVersion: INDEPENDENT_ORACLE_RESULT_SCHEMA,
    ok: true,
    status: 'passed',
    oracleIdentity: 'external:x03-independent-parser',
    oracleVersion: 'x03-test/1',
    oracleSource: 'tests/stage2/x03-rebuild-discovery.test.mjs',
    sourceDigest: sourceHash,
    outputDigest: `bytes:${stableDigest(Array.from(output))}`,
    format: 'elf',
    architecture: architectureId,
  };
}

const outputArtifact = artifactFor(sourceImage, materialized.outputHash, 'snapshot:x03:output');
const valid = await validateRebuildTransaction(transaction, materialized, {
  original: source,
  loaderReparse: () => ({ ok: true, discoveryArtifact: outputArtifact }),
  independentOracle: ({ output }) => oracleResult(output),
});
assert.equal(valid.status, 'valid', JSON.stringify(valid.failures));
assert.equal(valid.validators.find((item) => item.validator === 'loader-reparse').status, 'passed');
assert.equal(valid.validators.find((item) => item.validator === 'independent-differential').status, 'passed');

const lostImage = {
  functions: [{ address: 0x1000, source: 'function_starts', sizeBytes: 0x40 }],
};
const lostArtifact = artifactFor(lostImage, materialized.outputHash, 'snapshot:x03:lost');
const lost = await validateRebuildTransaction(transaction, materialized, {
  original: source,
  loaderReparse: () => ({ ok: true, discoveryArtifact: lostArtifact }),
  independentOracle: ({ output }) => oracleResult(output),
});
assert.equal(lost.status, 'invalid');
const lostLoader = lost.validators.find((item) => item.validator === 'loader-reparse');
assert.equal(lostLoader.reason, 'discovery-reparse-ambiguity-lost');
assert.ok(lostLoader.detail.missingCandidateIds.length > 0, 'ambiguous entry must not disappear');
assert.ok(lostLoader.detail.missingCollisionIds.length > 0, 'code/data collision must not disappear');
assert.ok(lostLoader.detail.missingReferenceIds.length > 0, 'jump-table evidence must not disappear');

const promotedImage = {
  ...sourceImage,
  symbols: [],
  functions: [
    ...sourceImage.functions,
    { address: 0x1100, source: 'function_starts', sizeBytes: 0x10 },
  ],
};
const promotedArtifact = artifactFor(promotedImage, materialized.outputHash, 'snapshot:x03:promoted');
const promoted = await validateRebuildTransaction(transaction, materialized, {
  original: source,
  loaderReparse: () => ({ ok: true, discoveryArtifact: promotedArtifact }),
  independentOracle: ({ output }) => oracleResult(output),
});
assert.equal(promoted.status, 'invalid');
const promotedLoader = promoted.validators.find((item) => item.validator === 'loader-reparse');
assert.equal(promotedLoader.reason, 'discovery-reparse-ambiguity-lost');
assert.ok(promotedLoader.detail.promotedCandidateIds.length > 0, 'heuristic/probable source candidate must not silently become exact');

const staleArtifact = artifactFor(sourceImage, sourceHash, 'snapshot:x03:stale-output');
const stale = await validateRebuildTransaction(transaction, materialized, {
  original: source,
  loaderReparse: () => ({ ok: true, discoveryArtifact: staleArtifact }),
  independentOracle: ({ output }) => oracleResult(output),
});
assert.equal(stale.status, 'invalid');
assert.equal(stale.validators.find((item) => item.validator === 'loader-reparse').reason, 'discovery-reparse-output-hash-mismatch');

const missingIndependent = await validateRebuildTransaction(transaction, materialized, {
  original: source,
  loaderReparse: () => ({ ok: true, discoveryArtifact: outputArtifact }),
});
assert.equal(missingIndependent.status, 'invalid');
assert.equal(missingIndependent.validators.find((item) => item.validator === 'independent-differential').reason, 'required-validator-unavailable');

assert.throws(() => createRebuildTransaction({
  binaryId,
  sourceHash,
  format: 'elf',
  architecture: architectureId,
  loaderVersion: 'loader:x03:test',
  discoveryRequired: true,
  operations: [{ id: 'x03:no-binding', offset: 1, before: [2], after: [9], provenance: { source: 'x03-test' } }],
}), /discovery-binding-required/);

const forgedBinding = { ...transaction.expectedOriginalState.discoveryBinding };
assert.throws(() => createRebuildTransaction({
  binaryId,
  sourceHash,
  format: 'elf',
  architecture: architectureId,
  loaderVersion: 'loader:x03:test',
  expectedOriginalState: { sourceHash, discoveryBinding: forgedBinding },
  operations: [{ id: 'x03:forged-binding', offset: 1, before: [2], after: [9], provenance: { source: 'x03-test' } }],
}), /discovery-binding-untrusted/);


// Production adapter wiring: format-safe planning may bind the same X-03
// artifact, but the adapter must delegate authority to transaction-v2 rather
// than inventing a second rebuild/reparse path.
const formatFixture = new Uint8Array(fs.readFileSync(new URL('../phase5/corpus/fixtures/vertical-sysv-amd64.elf', import.meta.url)));
const formatImage = inspectFormatSafeImage(formatFixture);
assert.equal(formatImage.format, 'elf');
assert.equal(formatImage.architecture, 'x86_64');
const formatHash = `bytes:${stableDigest(Array.from(formatFixture))}`;
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
assert.equal(formatTransaction.discoveryRequired, true);
assert.equal(formatTransaction.requireIndependentOracle, true);
assert.equal(formatTransaction.expectedOriginalState.discoveryBinding.artifactId, formatArtifact.artifactId);
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
const formatReparse = verifyDiscoveryReparse(
  formatTransaction.expectedOriginalState.discoveryBinding,
  formatOutputArtifact,
  { expectedOutputHash: formatMaterialized.outputHash },
);
assert.equal(formatReparse.ok, true, JSON.stringify(formatReparse));

console.log('stage2 X-03 rebuild discovery: PASS');
