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
const MANIFEST_PATH = path.join(ROOT, 'tests/phase12/rebuild/fixtures/manifest.json');
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const sourcePath = path.join(ROOT, manifest.provenance.sourcePath);
const sourceBytes = fs.readFileSync(sourcePath);
const sourceSha256 = crypto.createHash('sha256').update(sourceBytes).digest('hex');
const digest = (bytes) => `bytes:${stableDigest(Array.from(bytes))}`;
const loaderVersion = 'hex-loader:openBinary:v1';

assert.equal(manifest.schemaVersion, 'f6-real-rebuild-fixtures/v1');
assert.equal(sourceSha256, manifest.provenance.sourceSha256);
assert.equal(manifest.provenance.policy, 'tracked compiler-produced fixture; no synthetic or unchanged-copy proof');

const oracleTool = inspectLlvmReadobj();
assert.equal(oracleTool.available, true, `llvm-readobj is required: ${oracleTool.reason || 'unavailable'}`);
assert.match(oracleTool.version, new RegExp(LLVM_READOBJ_EXPECTED_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
const independentOracle = createLlvmReadobjOracle();

function fixtureBytes(fixture) {
  const bytes = fs.readFileSync(path.join(ROOT, fixture.path));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), fixture.sha256, `${fixture.id}: tracked bytes changed`);
  assert.equal(fixture.real, true, `${fixture.id}: fixture must be explicitly compiler-produced`);
  assert.equal(fixture.producer.includes('clang'), true, `${fixture.id}: missing compiler provenance`);
  return bytes;
}

function appendNonZeroNobitsSection(value) {
  const bytes = new Uint8Array(value);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectionTableOffset = Number(view.getBigUint64(40, true));
  const sectionHeaderSize = view.getUint16(58, true);
  const sectionCount = view.getUint16(60, true);
  const sectionNameIndex = view.getUint16(62, true);
  assert.equal(sectionHeaderSize, 64);
  assert.equal(sectionTableOffset + sectionCount * sectionHeaderSize, bytes.length);
  const namesHeader = sectionTableOffset + sectionNameIndex * sectionHeaderSize;
  const namesOffset = Number(view.getBigUint64(namesHeader + 24, true));
  const namesSize = Number(view.getBigUint64(namesHeader + 32, true));
  const sectionName = new TextEncoder().encode('.bss\0');
  assert.equal(namesOffset + namesSize + sectionName.length, sectionTableOffset);

  const extended = new Uint8Array(bytes.length + sectionHeaderSize);
  extended.set(bytes);
  extended.set(sectionName, namesOffset + namesSize);
  const output = new DataView(extended.buffer);
  output.setBigUint64(namesHeader + 32, BigInt(namesSize + sectionName.length), true);
  output.setUint16(60, sectionCount + 1, true);
  const header = sectionTableOffset + sectionCount * sectionHeaderSize;
  output.setUint32(header, namesSize, true);
  output.setUint32(header + 4, 8, true); // SHT_NOBITS
  output.setBigUint64(header + 8, 3n, true); // SHF_WRITE | SHF_ALLOC
  output.setBigUint64(header + 24, BigInt(extended.length), true);
  output.setBigUint64(header + 32, 16n, true);
  output.setBigUint64(header + 48, 4n, true);
  return extended;
}

function loaderReparse({ transaction, original, output, expectedOutputHash }) {
  try {
    const image = openBinary(output);
    const identityOk = image.format === transaction.format && image.arch === transaction.architecture;
    return {
      ok: identityOk,
      status: identityOk ? 'passed' : 'rejected',
      ...(identityOk ? {} : { reason: 'production-loader-format-identity-mismatch' }),
      format: image.format,
      architecture: image.arch,
      loaderVersion,
      sourceHash: digest(original),
      outputHash: digest(output),
      expectedOutputHash,
      entrypoint: image.entrypoint == null ? null : String(image.entrypoint),
    };
  } catch (error) {
    return { ok: false, status: 'rejected', reason: 'production-loader-reparse-failed', detail: String(error?.message || error) };
  }
}

const proofRows = [];
for (const fixture of manifest.fixtures) {
  const bytes = fixtureBytes(fixture);
  const image = inspectFormatSafeImage(bytes);
  assert.equal(image.format, fixture.format, `${fixture.id}: format identity`);
  assert.equal(image.architecture, fixture.architecture, `${fixture.id}: architecture identity`);
  assert.equal(fixture.profile, fixture.format === 'elf' ? 'elf:64' : fixture.format === 'macho' ? 'macho:64' : fixture.architecture === 'x86' ? 'pe:pe32' : 'pe:pe32+');
  const mutation = fixture.format === 'elf'
    ? { kind: 'elf-comment', tag: 'Hex F6 real rebuild v1' }
    : fixture.format === 'macho'
      ? { kind: 'macho-min-version', version: 0x000a0500 }
      : { kind: 'pe-timestamp', timestamp: fixture.architecture === 'x86' ? 0x65f6a246 : 0x65f6a245 };
  const transaction = createFormatSafeRebuildTransaction({
    binaryId: `fixture:${fixture.id}`,
    source: bytes,
    sourceHash: digest(bytes),
    format: fixture.format,
    architecture: fixture.architecture,
    loaderVersion,
    mutation,
  });
  assert.equal(transaction.schemaVersion, 'hex-rebuild-transaction-v2');
  assert.equal(transaction.expectedOriginalState.formatSafe.schema, FORMAT_SAFE_REBUILD_SCHEMA);
  assert.equal(transaction.requiredValidators.includes('format-invariants'), true);
  assert.equal(transaction.requiredValidators.includes('independent-differential'), true);

  const materialized = await materializeRebuildTransaction(transaction, bytes, { maxOutputBytes: bytes.length });
  assert.equal(materialized.status, 'materialized', `${fixture.id}: materialization`);
  assert.equal(materialized.sizeDelta, 0);
  assert.notDeepEqual([...materialized.bytes], [...bytes], `${fixture.id}: mutation must change bytes`);

  const validation = await validateRebuildTransaction(transaction, materialized, {
    original: bytes,
    loaderReparse,
    independentOracle,
    validators: { 'format-invariants': validateFormatSafeMutation },
  });
  assert.equal(validation.status, 'valid', `${fixture.id}: ${JSON.stringify(validation.failures)}`);
  assert.equal(validation.independentDifferential, 'executed');
  assert.equal(validation.validators.find((item) => item.validator === 'format-invariants')?.status, 'passed');
  assert.equal(validation.validators.find((item) => item.validator === 'independent-differential')?.status, 'passed');
  const oracleEvidence = validation.validators.find((item) => item.validator === 'independent-differential')?.detail;
  assert.equal(oracleEvidence?.outputDigest, materialized.outputHash);
  assert.match(oracleEvidence?.oracleOutputDigest || '', /^sha256:[0-9a-f]{64}$/);

  const publication = await publishRebuildTransaction(materialized, validation, {
    atomicPromote: async (candidate, identity) => {
      assert.notDeepEqual([...candidate], [...bytes], `${fixture.id}: publication cannot receive an unchanged copy`);
      return {
        atomic: true,
        committed: true,
        protocol: 'temp-then-atomic-rename',
        publicationIdentity: `fixture-publication:${fixture.id}`,
        transactionId: identity.materialized.transactionId,
        outputHash: identity.materialized.outputHash,
        outputIdentity: identity.materialized.outputIdentity,
      };
    },
  });
  assert.equal(publication.status, 'published', `${fixture.id}: publication`);
  proofRows.push({ fixture: fixture.id, format: fixture.format, architecture: fixture.architecture, sourceSha256: fixture.sha256, outputDigest: materialized.outputHash, mutation: transaction.expectedOriginalState.formatSafe.kind });
}

assert.deepEqual(proofRows.map((row) => row.architecture).sort(), ['x86', 'x86_64', 'x86_64', 'x86_64']);
assert.deepEqual(manifest.fixtures.map((fixture) => fixture.profile).sort(), ['elf:64', 'macho:64', 'pe:pe32', 'pe:pe32+']);
assert.equal(proofRows.filter((row) => row.format === 'elf').length, 1);
assert.equal(proofRows.filter((row) => row.format === 'macho').length, 1);
assert.equal(proofRows.filter((row) => row.format === 'pe').length, 2);

// A no-op and a synthetic label are both rejected before they can become proof.
const pe32Fixture = manifest.fixtures.find((fixture) => fixture.architecture === 'x86');
const pe32Bytes = fixtureBytes(pe32Fixture);
const pe32Image = inspectFormatSafeImage(pe32Bytes);
const originalTimestamp = new DataView(pe32Bytes.buffer, pe32Bytes.byteOffset, pe32Bytes.byteLength).getUint32(pe32Image.target.offset, true);
assert.throws(() => createFormatSafeRebuildTransaction({
  binaryId: 'negative:no-op', source: pe32Bytes, format: 'pe', architecture: 'x86', loaderVersion, mutation: { kind: 'pe-timestamp', timestamp: originalTimestamp },
}), /format-safe-mutation-no-change/);
const elfNoOp = manifest.fixtures.find((fixture) => fixture.format === 'elf');
const elfNoOpBytes = fixtureBytes(elfNoOp);
const elfNoOpImage = inspectFormatSafeImage(elfNoOpBytes);
const elfComment = new TextDecoder().decode(elfNoOpBytes.slice(elfNoOpImage.target.offset, elfNoOpImage.target.offset + elfNoOpImage.target.size)).replace(/\0+$/, '');
assert.throws(() => createFormatSafeRebuildTransaction({
  binaryId: 'negative:elf-no-op', source: elfNoOpBytes, format: 'elf', architecture: 'x86_64', loaderVersion, mutation: { kind: 'elf-comment', tag: elfComment },
}), /format-safe-mutation-no-change/);
assert.throws(() => createFormatSafeRebuildTransaction({
  binaryId: 'negative:synthetic', source: Uint8Array.from([0x7f, 0x45, 0x4c, 0x46]), format: 'elf', architecture: 'x86_64', loaderVersion, mutation: { kind: 'elf-comment', tag: 'fake' },
}), /format-safe-elf-header-truncated|format-safe-image-format-unrecognized/);
const machoFixture = manifest.fixtures.find((fixture) => fixture.format === 'macho');
const machoBytes = fixtureBytes(machoFixture);
const machoImage = inspectFormatSafeImage(machoBytes);
const originalMinVersion = new DataView(machoBytes.buffer, machoBytes.byteOffset, machoBytes.byteLength).getUint32(machoImage.target.offset, true);
assert.throws(() => createFormatSafeRebuildTransaction({
  binaryId: 'negative:macho-no-op', source: machoBytes, format: 'macho', architecture: 'x86_64', loaderVersion, mutation: { kind: 'macho-min-version', version: originalMinVersion },
}), /format-safe-mutation-no-change/);
assert.throws(() => createFormatSafeRebuildTransaction({
  binaryId: 'negative:macho-architecture-swap', source: machoBytes, format: 'macho', architecture: 'arm64', loaderVersion, mutation: { kind: 'macho-min-version', version: 0x000a0500 },
}), /format-safe-source-identity-mismatch/);

const elfFixture = manifest.fixtures.find((fixture) => fixture.format === 'elf');
const elfBytes = fixtureBytes(elfFixture);
const elfWithBss = inspectFormatSafeImage(appendNonZeroNobitsSection(elfBytes));
assert.equal(elfWithBss.format, 'elf');
assert.equal(elfWithBss.snapshot.sections.find((section) => section.name === '.bss')?.size, 16);
const elfTransaction = createFormatSafeRebuildTransaction({
  binaryId: 'negative:tamper', source: elfBytes, format: 'elf', architecture: 'x86_64', loaderVersion, mutation: { kind: 'elf-comment', tag: 'Hex F6 tamper probe' },
});
const elfMaterialized = await materializeRebuildTransaction(elfTransaction, elfBytes);
const tampered = elfMaterialized.bytes.slice();
tampered[0] = 0;
const invariantFailure = validateFormatSafeMutation({ transaction: elfTransaction, original: elfBytes, output: tampered });
assert.equal(invariantFailure.ok, false);
const oracleFailure = await independentOracle({ transaction: elfTransaction, original: elfBytes, output: tampered });
assert.equal(oracleFailure.ok, false);
const truncatedOutput = elfMaterialized.bytes.slice(0, -1);
const truncationFailure = validateFormatSafeMutation({ transaction: elfTransaction, original: elfBytes, output: truncatedOutput });
assert.equal(truncationFailure.ok, false, 'truncated output must never pass format validation');

const machoTransaction = createFormatSafeRebuildTransaction({
  binaryId: 'negative:macho-wrong-identity',
  source: machoBytes,
  format: 'macho',
  architecture: 'x86_64',
  loaderVersion,
  mutation: { kind: 'macho-min-version', version: 0x000a0500 },
});
const wrongIdentityOutput = (await materializeRebuildTransaction(machoTransaction, machoBytes, { maxOutputBytes: machoBytes.length })).bytes.slice();
new DataView(wrongIdentityOutput.buffer).setUint32(4, 0x0100000c, true); // arm64 header with an x86_64 transaction
const wrongIdentityFailure = validateFormatSafeMutation({ transaction: machoTransaction, original: machoBytes, output: wrongIdentityOutput });
assert.equal(wrongIdentityFailure.ok, false, 'wrong architecture identity must never pass format validation');
console.log(`F6_REAL_REBUILD_PROOF=${JSON.stringify({ schemaVersion: FORMAT_SAFE_REBUILD_SCHEMA, fixtures: proofRows, oracle: { identity: oracleTool.identity, version: oracleTool.version }, negatives: ['no-op-rejected', 'synthetic-rejected', 'header-tamper-rejected', 'truncation-rejected', 'wrong-identity-rejected'] })}`);
