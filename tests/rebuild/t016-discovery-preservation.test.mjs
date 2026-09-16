import assert from 'node:assert/strict';
import test from 'node:test';
import { stableDigestBytes } from '../../js/core/identity/index.js';
import { functionCandidates, discoveryArtifactForRebuild } from '../../js/analysis/index.js';
import {
  createRebuildTransaction,
  materializeRebuildTransaction,
  validateRebuildTransaction,
  publishRebuildTransaction,
  registerCanonicalAtomicPublicationProvider,
} from '../../js/rebuild/transaction-v2.js';

const source = Uint8Array.from([1, 2, 3, 4]);
const sourceHash = `bytes:${stableDigestBytes(source)}`;
const binaryId = 't016:synthetic';
const architectureId = 'x86_64';

function discover(hash, snapshotId, sizeBytes = null) {
  const image = {
    functions: [{
      address: 0x1000,
      source: 'function_starts',
      confidence: 1,
      ...(sizeBytes == null ? {} : { sizeBytes }),
    }],
    functionStarts: [],
    unwindEntries: [],
    exports: [], symbols: [], relocationTargets: [], vtableEntries: [], exceptionMetadata: [],
    entrypoint: null,
  };
  return functionCandidates({
    input: { image },
    architectureId,
    binaryId,
    sourceHash: hash,
    snapshotId,
  }).artifact;
}

function transaction(sourceArtifact) {
  return createRebuildTransaction({
    binaryId,
    sourceHash,
    format: 'elf',
    architecture: architectureId,
    loaderVersion: 't016-loader-v1',
    snapshotId: 't016-source',
    operations: [{ id: 'replace-first-byte', offset: 0, before: [1], after: [9], provenance: { source: 't016-test' } }],
    discoveryArtifact: sourceArtifact,
    requireDiscoveryPreservation: true,
  });
}

function validatorsFor(tx, outputHash) {
  const generic = async () => ({ ok: true, status: 'passed' });
  const validators = {};
  for (const name of tx.requiredValidators) {
    if (['source-precondition', 'structure', 'unchanged-regions', 'evidence', 'loader-reparse', 'discovery-preservation'].includes(name)) continue;
    validators[name] = generic;
  }
  return {
    validators,
    loaderReparse: async () => ({
      ok: true,
      status: 'passed',
      format: tx.format,
      architecture: tx.architecture,
      loaderVersion: tx.loaderVersion,
      sourceHash: tx.sourceHash,
      outputHash,
    }),
  };
}

async function prepare(outputArtifact) {
  const sourceArtifact = discover(sourceHash, 't016-source');
  const tx = transaction(sourceArtifact);
  assert.ok(tx.requiredValidators.includes('discovery-preservation'));
  const materialized = await materializeRebuildTransaction(tx, source);
  assert.equal(materialized.status, 'materialized');
  const validation = await validateRebuildTransaction(tx, materialized, {
    original: source,
    discoveryArtifact: outputArtifact(materialized),
    ...validatorsFor(tx, materialized.outputHash),
  });
  return { tx, materialized, validation, sourceArtifact };
}

test('T016 factory-issued source binding is required and clones are rejected', () => {
  const artifact = discover(sourceHash, 't016-source');
  const binding = discoveryArtifactForRebuild(artifact);
  assert.throws(() => createRebuildTransaction({
    binaryId,
    sourceHash,
    format: 'elf',
    architecture: architectureId,
    loaderVersion: 't016-loader-v1',
    snapshotId: 't016-source',
    operations: [{ offset: 0, before: [1], after: [9] }],
    discoveryBinding: structuredClone(binding),
    requireDiscoveryPreservation: true,
  }), /discovery-binding-unissued/);
});

test('T016 fresh output artifact preserves unknown extent and validates', async () => {
  const { materialized, validation } = await prepare((m) => discover(m.outputHash, 't016-output'));
  assert.equal(validation.status, 'valid', JSON.stringify(validation));
  assert.equal(validation.discovery.comparison.ok, true);
  assert.equal(validation.discovery.comparison.candidatesPreserved, true);
  assert.equal(validation.discovery.comparison.intervalsPreserved, true);
  assert.notEqual(validation.discovery.sourceArtifactId, validation.discovery.outputArtifactId);
  assert.ok(materialized.outputHash !== sourceHash);
});

test('T016 stale snapshot and invented extent fail closed', async () => {
  const stale = await prepare((m) => discover(m.outputHash, 't016-source'));
  assert.equal(stale.validation.status, 'invalid');
  assert.equal(stale.validation.discovery.comparison.reason, 'discovery-reparse-stale-snapshot');

  const strengthened = await prepare((m) => discover(m.outputHash, 't016-output-extent', 16));
  assert.equal(strengthened.validation.status, 'invalid');
  assert.equal(strengthened.validation.discovery.comparison.ok, false);
  assert.equal(strengthened.validation.discovery.comparison.reason, 'discovery-reparse-ambiguity-lost');
});

test('T016 discovery-bound publication requires the existing trusted atomic authority', async () => {
  const { materialized, validation } = await prepare((m) => discover(m.outputHash, 't016-output-publish'));
  assert.equal(validation.status, 'valid');
  const receipt = (m) => ({
    atomic: true,
    committed: true,
    protocol: 'transactional-store',
    publicationIdentity: 't016:test-store',
    transactionId: m.transactionId,
    outputHash: m.outputHash,
    outputIdentity: m.outputIdentity,
  });
  const untrusted = await publishRebuildTransaction(materialized, validation, {
    atomicPromote: async () => receipt(materialized),
  });
  assert.equal(untrusted.status, 'not-published');
  assert.equal(untrusted.reason, 'rebuild-v2-canonical-atomic-publication-required');

  const trusted = registerCanonicalAtomicPublicationProvider(async () => receipt(materialized));
  const published = await publishRebuildTransaction(materialized, validation, { atomicPromote: trusted });
  assert.equal(published.status, 'published', JSON.stringify(published));
  assert.equal(published.authority, 'trusted-atomic-publication');
});
