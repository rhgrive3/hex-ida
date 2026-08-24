import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openBinary } from '../../../js/binary/index.js';
import { stableDigest } from '../../../js/core/identity/index.js';
import {
  FORMAT_SAFE_REBUILD_SCHEMA,
  createFormatSafeRebuildTransaction,
  inspectFormatSafeImage,
  validateFormatSafeMutation,
} from '../../../js/rebuild/format-safe.js';
import {
  evaluateF6RebuildDenominator,
  materializeRebuildTransaction,
  publishRebuildTransaction,
  validateRebuildTransaction,
} from '../../../js/rebuild/transaction-v2.js';
import {
  LLVM_READOBJ_EXPECTED_VERSION,
  createLlvmReadobjOracle,
  inspectLlvmReadobj,
} from '../../../tools/validation/rebuild-independent-oracle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/phase12/rebuild/fixtures/manifest.json'), 'utf8'));
const digest = (bytes) => `bytes:${stableDigest(Array.from(bytes))}`;
const loaderVersion = 'hex-loader:openBinary:v1';
const oracleTool = inspectLlvmReadobj();
assert.equal(oracleTool.available, true, oracleTool.reason || 'llvm-readobj unavailable');
assert.match(oracleTool.version, new RegExp(LLVM_READOBJ_EXPECTED_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
const independentOracle = createLlvmReadobjOracle();

function fixtureBytes(fixture) {
  const bytes = fs.readFileSync(path.join(ROOT, fixture.path));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), fixture.sha256);
  assert.equal(fixture.real, true);
  assert.match(fixture.producer, /clang/);
  return bytes;
}

function loaderReparse({ transaction, original, output }) {
  try {
    const image = openBinary(output);
    const ok = image.format === transaction.format && image.arch === transaction.architecture;
    return {
      ok,
      status: ok ? 'passed' : 'rejected',
      ...(ok ? {} : { reason: 'production-loader-format-identity-mismatch' }),
      format: image.format,
      architecture: image.arch,
      loaderVersion,
      sourceHash: digest(original),
      outputHash: digest(output),
    };
  } catch (error) {
    return { ok: false, status: 'rejected', reason: 'production-loader-reparse-failed', detail: String(error?.message || error) };
  }
}

function proofFor(transaction, validation, publication, fixture) {
  return evaluateF6RebuildDenominator({
    transaction,
    validation,
    publication,
    proof: {
      realFixture: fixture.real,
      realFixtureEvidence: true,
      negativeValidatorTest: true,
      staleIdentityTest: true,
      truncationTest: true,
      wrongIdentityTest: true,
    },
  });
}

for (const profile of ['pe:pe32', 'pe:pe32+']) {
  const fixture = manifest.fixtures.find((item) => item.profile === profile);
  const source = fixtureBytes(fixture);
  const image = inspectFormatSafeImage(source);
  const originalVirtualSize = image.snapshot.sections.find((section) => section.name === '.text')?.virtualSize;
  assert.equal(Number.isSafeInteger(originalVirtualSize), true);
  const transaction = createFormatSafeRebuildTransaction({
    binaryId: `fixture:${fixture.id}:text-layout`,
    source,
    sourceHash: digest(source),
    format: 'pe',
    architecture: fixture.architecture,
    loaderVersion,
    mutation: { kind: 'pe-section-virtual-size', section: '.text', virtualSize: originalVirtualSize + 16 },
  });
  assert.equal(transaction.expectedOriginalState.formatSafe.schema, FORMAT_SAFE_REBUILD_SCHEMA);
  assert.equal(transaction.expectedOriginalState.formatSafe.kind, 'pe-section-virtual-size');
  assert.equal(transaction.impact.layoutMoving, true);
  assert.equal(transaction.sizeDelta, 0);
  assert.equal(transaction.requiredValidators.includes('layout'), true);

  const materialized = await materializeRebuildTransaction(transaction, source, { maxOutputBytes: source.length });
  assert.equal(materialized.status, 'materialized');
  assert.equal(materialized.outputLength, source.length);
  assert.notDeepEqual([...materialized.bytes], [...source]);
  const validation = await validateRebuildTransaction(transaction, materialized, {
    original: source,
    loaderReparse,
    independentOracle,
    validators: { layout: validateFormatSafeMutation, 'format-invariants': validateFormatSafeMutation },
  });
  assert.equal(validation.status, 'valid', JSON.stringify(validation.failures));
  for (const validator of ['layout', 'format-invariants', 'independent-differential']) {
    assert.deepEqual(validation.validators.find((item) => item.validator === validator)?.detail?.layoutEvidence, {
      sectionCount: image.snapshot.sections.length,
      section: {
        index: 0,
        name: '.text',
        virtualAddress: 0x1000,
        rawSize: 0x200,
        originalVirtualSize,
        virtualSize: originalVirtualSize + 16,
        sectionAlignment: 0x1000,
        sizeOfImage: image.snapshot.header.optional.sizeOfImage,
      },
    }, `${profile}:${validator}: exact section-layout evidence`);
  }
  const publication = await publishRebuildTransaction(materialized, validation, {
    atomicPromote: async (_candidate, identity) => ({
      atomic: true,
      committed: true,
      protocol: 'temp-then-atomic-rename',
      publicationIdentity: `fixture-publication:${fixture.id}:text-layout`,
      transactionId: identity.materialized.transactionId,
      outputHash: identity.materialized.outputHash,
      outputIdentity: identity.materialized.outputIdentity,
    }),
  });
  assert.equal(publication.status, 'published');
  const status = proofFor(transaction, validation, publication, fixture);
  const boundedId = `${profile}:layout-and-structure:text-virtual-size-within-alignment`;
  assert.equal(status.cells['layout-and-structure'].status, 'blocking');
  assert.equal(status.blockingUnitIds.includes(`${profile}:layout-and-structure`), true);
  assert.equal(status.boundedOperationCells[boundedId].status, 'closed');
  assert.equal(status.boundedOperationCells[boundedId].operation, 'pe-section-virtual-size');
  assert.equal(status.boundedOperationClosedIds.includes(boundedId), true);
  assert.equal(status.boundedOperationCells[boundedId].evidence, 'format-safe-pe-section-virtual-size+hex-loader-reparse+llvm-readobj-independent-oracle+atomic-publication');
  const incomplete = proofFor(transaction, validation, publication, { ...fixture, real: false });
  assert.equal(incomplete.boundedOperationCells[boundedId].status, 'blocking', `${profile}: fixture identity is required`);

  assert.throws(() => createFormatSafeRebuildTransaction({
    binaryId: `${profile}:negative:no-op`, source, sourceHash: digest(source), format: 'pe', architecture: fixture.architecture, loaderVersion,
    mutation: { kind: 'pe-section-virtual-size', section: '.text', virtualSize: originalVirtualSize },
  }), /format-safe-pe-layout-virtual-size-invalid/);
  assert.throws(() => createFormatSafeRebuildTransaction({
    binaryId: `${profile}:negative:section`, source, sourceHash: digest(source), format: 'pe', architecture: fixture.architecture, loaderVersion,
    mutation: { kind: 'pe-section-virtual-size', section: '.rdata', virtualSize: 64 },
  }), /format-safe-pe-layout-section-unsupported/);
  assert.throws(() => createFormatSafeRebuildTransaction({
    binaryId: `${profile}:negative:alignment`, source, sourceHash: digest(source), format: 'pe', architecture: fixture.architecture, loaderVersion,
    mutation: { kind: 'pe-section-virtual-size', section: '.text', virtualSize: 0x1001 },
  }), /format-safe-pe-layout-alignment-bucket-invalid/);
  const tampered = materialized.bytes.slice();
  new DataView(tampered.buffer).setUint32(transaction.expectedOriginalState.formatSafe.sectionHeaderOffset + 8, originalVirtualSize + 32, true);
  assert.equal(validateFormatSafeMutation({ transaction, original: source, output: tampered }).ok, false, `${profile}: tampered section size rejected`);
  assert.equal((await independentOracle({ transaction, original: source, output: tampered })).ok, false, `${profile}: oracle rejects tampered section size`);
  assert.equal(validateFormatSafeMutation({ transaction, original: source, output: materialized.bytes.slice(0, -1) }).ok, false, `${profile}: truncation rejected`);
  assert.throws(() => createFormatSafeRebuildTransaction({
    binaryId: `${profile}:negative:identity`, source, sourceHash: digest(source), format: 'pe', architecture: fixture.architecture === 'x86' ? 'x86_64' : 'x86', loaderVersion,
    mutation: { kind: 'pe-section-virtual-size', section: '.text', virtualSize: originalVirtualSize + 16 },
  }), /format-safe-source-identity-mismatch/);
}

console.log('[phase12] bounded PE32/PE32+ text section-layout cells passed');
