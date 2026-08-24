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
  f6KnownImplementationGaps,
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
const f6EvidenceRows = [];
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
  assert.equal(oracleEvidence?.preservationEvidence?.complete, true, `${fixture.id}: independent full-report preservation proof`);
  assert.equal(oracleEvidence?.preservationEvidence?.sourceReportDigest, oracleEvidence?.preservationEvidence?.outputReportDigest);
  assert.deepEqual(oracleEvidence?.preservationEvidence?.units, [
    'layout-and-structure', 'relocations-and-bindings', 'branch-ranges',
    'unwind-and-debug', 'imports-and-exports', 'signature-consequence',
  ]);

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
  f6EvidenceRows.push({ transaction, validation, publication, fixture });
  proofRows.push({ fixture: fixture.id, format: fixture.format, architecture: fixture.architecture, sourceSha256: fixture.sha256, outputDigest: materialized.outputHash, mutation: transaction.expectedOriginalState.formatSafe.kind });
}

assert.deepEqual(proofRows.map((row) => row.architecture).sort(), ['x86', 'x86_64', 'x86_64', 'x86_64']);
assert.deepEqual(manifest.fixtures.map((fixture) => fixture.profile).sort(), ['elf:64', 'macho:64', 'pe:pe32', 'pe:pe32+']);
assert.equal(proofRows.filter((row) => row.format === 'elf').length, 1);
assert.equal(proofRows.filter((row) => row.format === 'macho').length, 1);
assert.equal(proofRows.filter((row) => row.format === 'pe').length, 2);

// A bounded production layout operation: append one non-loaded SHT_NOBITS
// section to the real ELF fixture. Both Hex's loader and llvm-readobj must
// observe the exact new section; parseability alone is insufficient.
const layoutFixture = manifest.fixtures.find((fixture) => fixture.profile === 'elf:64');
const layoutBytes = fixtureBytes(layoutFixture);
const layoutTransaction = createFormatSafeRebuildTransaction({
  binaryId: `fixture:${layoutFixture.id}:layout`,
  source: layoutBytes,
  sourceHash: digest(layoutBytes),
  format: 'elf',
  architecture: 'x86_64',
  loaderVersion,
  mutation: { kind: 'elf-add-nobits-section', name: '.bss', size: 16, alignment: 8 },
});
assert.equal(layoutTransaction.impact.layoutMoving, true);
assert.equal(layoutTransaction.sizeDelta, 64);
assert.equal(layoutTransaction.requiredValidators.includes('layout'), true);
const layoutMaterialized = await materializeRebuildTransaction(layoutTransaction, layoutBytes);
assert.equal(layoutMaterialized.status, 'materialized');
const layoutValidation = await validateRebuildTransaction(layoutTransaction, layoutMaterialized, {
  original: layoutBytes,
  loaderReparse,
  independentOracle,
  validators: {
    layout: validateFormatSafeMutation,
    'format-invariants': validateFormatSafeMutation,
  },
});
assert.equal(layoutValidation.status, 'valid', JSON.stringify(layoutValidation.failures));
for (const validator of ['layout', 'format-invariants', 'independent-differential']) {
  assert.deepEqual(layoutValidation.validators.find((item) => item.validator === validator)?.detail?.layoutEvidence, {
    sectionCount: 14,
    section: { name: '.bss', type: 'SHT_NOBITS', size: 16, alignment: 8 },
  }, `${validator}: exact ELF layout evidence`);
}
const layoutPublication = await publishRebuildTransaction(layoutMaterialized, layoutValidation, {
  atomicPromote: async (_candidate, identity) => ({
    atomic: true,
    committed: true,
    protocol: 'temp-then-atomic-rename',
    publicationIdentity: `fixture-publication:${layoutFixture.id}:layout`,
    transactionId: identity.materialized.transactionId,
    outputHash: identity.materialized.outputHash,
    outputIdentity: identity.materialized.outputIdentity,
  }),
});
assert.equal(layoutPublication.status, 'published');
const layoutStatus = evaluateF6RebuildDenominator({
  transaction: layoutTransaction,
  validation: layoutValidation,
  publication: layoutPublication,
  proof: {
    realFixture: true,
    realFixtureEvidence: true,
    negativeValidatorTest: true,
    staleIdentityTest: true,
    truncationTest: true,
    wrongIdentityTest: true,
  },
});
assert.equal(layoutStatus.cells['layout-and-structure'].status, 'blocking');
assert.equal(layoutStatus.cells['layout-and-structure'].reason, 'f6-layout-and-structure-profile-matrix-incomplete');
assert.equal(layoutStatus.cells['layout-and-structure'].evidence, 'elf64-terminal-section-table-nobits-adapter+llvm-readobj-section-oracle');
assert.equal(layoutStatus.blockingUnitIds.includes('elf:64:layout-and-structure'), true);
const boundedLayoutCell = layoutStatus.boundedOperationCells['elf:64:layout-and-structure:terminal-sht-nobits-append'];
assert.equal(boundedLayoutCell.status, 'closed', 'the exact ELF SHT_NOBITS operation is independently proven');
assert.equal(boundedLayoutCell.parentUnit, 'layout-and-structure');
assert.equal(boundedLayoutCell.operation, 'elf-add-nobits-section');
assert.equal(layoutStatus.boundedOperationClosedIds.includes(boundedLayoutCell.id), true);
assert.equal(layoutStatus.boundedOperationBlockingIds.includes(boundedLayoutCell.id), false);
assert.equal(boundedLayoutCell.evidence, 'format-safe-elf-add-nobits-section+hex-loader-reparse+llvm-readobj-independent-oracle+atomic-publication');
const incompleteLayoutStatus = evaluateF6RebuildDenominator({
  transaction: layoutTransaction,
  validation: layoutValidation,
  publication: layoutPublication,
  proof: { realFixture: true, realFixtureEvidence: true },
});
assert.equal(incompleteLayoutStatus.boundedOperationCells[boundedLayoutCell.id].status, 'blocking', 'bounded capability must fail closed without the complete negative corpus');
assert.equal(incompleteLayoutStatus.boundedOperationCells[boundedLayoutCell.id].reason, 'f6-bounded-elf-layout-proof-incomplete');
assert.equal(f6KnownImplementationGaps().length, 0, 'the unsigned preservation writer closes implementation gaps without promoting the independent bounded layout operation');
assert.throws(() => createFormatSafeRebuildTransaction({
  binaryId: 'negative:layout-name', source: layoutBytes, format: 'elf', architecture: 'x86_64', loaderVersion,
  mutation: { kind: 'elf-add-nobits-section', name: '.attacker', size: 16, alignment: 8 },
}), /format-safe-elf-nobits-name-unsupported/);
assert.throws(() => createFormatSafeRebuildTransaction({
  binaryId: 'negative:layout-alignment', source: layoutBytes, format: 'elf', architecture: 'x86_64', loaderVersion,
  mutation: { kind: 'elf-add-nobits-section', name: '.bss', size: 16, alignment: 3 },
}), /format-safe-elf-nobits-alignment-invalid/);
for (const alignment of [16, 64]) {
  assert.throws(() => createFormatSafeRebuildTransaction({
    binaryId: `negative:layout-offset-alignment:${alignment}`, source: layoutBytes, format: 'elf', architecture: 'x86_64', loaderVersion,
    mutation: { kind: 'elf-add-nobits-section', name: '.bss', size: 16, alignment },
  }), /format-safe-elf-nobits-offset-alignment-invalid/, `sh_offset must satisfy sh_addralign=${alignment}`);
}
const layoutTamper = layoutMaterialized.bytes.slice();
new DataView(layoutTamper.buffer).setBigUint64(layoutTamper.length - 32, 17n, true);
assert.equal(validateFormatSafeMutation({ transaction: layoutTransaction, original: layoutBytes, output: layoutTamper }).ok, false, 'changed appended section size is rejected');
assert.equal((await independentOracle({ transaction: layoutTransaction, original: layoutBytes, output: layoutTamper })).ok, false, 'independent oracle rejects changed appended section size');

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

const peSigned = Uint8Array.from(pe32Bytes);
const peSignedView = new DataView(peSigned.buffer, peSigned.byteOffset, peSigned.byteLength);
const peHeaderOffset = peSignedView.getUint32(0x3c, true);
const peOptionalOffset = peHeaderOffset + 24;
const peDataDirectoryOffset = peOptionalOffset + (peSignedView.getUint16(peOptionalOffset, true) === 0x10b ? 96 : 112);
peSignedView.setUint32(peDataDirectoryOffset + 4 * 8, peSigned.length - 8, true);
peSignedView.setUint32(peDataDirectoryOffset + 4 * 8 + 4, 8, true);
assert.throws(() => createFormatSafeRebuildTransaction({
  binaryId:'negative:pe-signed', source:peSigned, format:'pe', architecture:'x86', loaderVersion,
  mutation:{ kind:'pe-timestamp', timestamp:0x65f6a247 },
}), /format-safe-signed-or-build-identified-input-unsupported/);

const machoSigned = Uint8Array.from(machoBytes);
const machoSignedView = new DataView(machoSigned.buffer, machoSigned.byteOffset, machoSigned.byteLength);
let machoCommandOffset = 32;
const machoCommandCount = machoSignedView.getUint32(16, true);
let markedMachoSignature = false;
for (let index = 0; index < machoCommandCount; index++) {
  const command = machoSignedView.getUint32(machoCommandOffset, true);
  const size = machoSignedView.getUint32(machoCommandOffset + 4, true);
  if (command !== 0x24 && !markedMachoSignature) { machoSignedView.setUint32(machoCommandOffset, 0x1d, true); markedMachoSignature = true; }
  machoCommandOffset += size;
}
assert.equal(markedMachoSignature, true);
assert.throws(() => createFormatSafeRebuildTransaction({
  binaryId:'negative:macho-signed', source:machoSigned, format:'macho', architecture:'x86_64', loaderVersion,
  mutation:{ kind:'macho-min-version', version:0x000a0500 },
}), /format-safe-signed-or-build-identified-input-unsupported/);

const elfBuildIdentified = Uint8Array.from(elfNoOpBytes);
const elfBuildIdentifiedView = new DataView(elfBuildIdentified.buffer, elfBuildIdentified.byteOffset, elfBuildIdentified.byteLength);
const elfSectionTableOffset = Number(elfBuildIdentifiedView.getBigUint64(40, true));
elfBuildIdentifiedView.setUint32(elfSectionTableOffset + 64 + 4, 7, true);
assert.throws(() => createFormatSafeRebuildTransaction({
  binaryId:'negative:elf-build-identified', source:elfBuildIdentified, format:'elf', architecture:'x86_64', loaderVersion,
  mutation:{ kind:'elf-comment', tag:'Hex F6 signed negative' },
}), /format-safe-signed-or-build-identified-input-unsupported/);

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

const denominatorStatuses = f6EvidenceRows.map(({ transaction, validation, publication }) => evaluateF6RebuildDenominator({
  transaction,
  validation,
  publication,
  proof: {
    realFixture: true,
    realFixtureEvidence: true,
    negativeValidatorTest: true,
    staleIdentityTest: true,
    truncationTest: true,
    wrongIdentityTest: true,
  },
}));
const incompletePreservation = evaluateF6RebuildDenominator({
  ...f6EvidenceRows[0],
  proof:{ realFixture:true, realFixtureEvidence:true },
});
for (const unit of ['layout-and-structure','relocations-and-bindings','branch-ranges','unwind-and-debug','imports-and-exports','signature-consequence']) {
  assert.equal(incompletePreservation.cells[unit].status, 'blocking', `${unit}: negative proof corpus cannot be omitted`);
}
assert.equal(denominatorStatuses.length, 4);
for (const status of denominatorStatuses) {
  assert.equal(status.status, 'closed', 'the constrained unsigned preservation writer closes every locked invariant cell');
  for (const unit of ['transaction-identity', 'layout-and-structure', 'relocations-and-bindings', 'branch-ranges', 'unwind-and-debug', 'imports-and-exports', 'signature-consequence', 'loader-reparse', 'independent-differential-oracle', 'atomic-publication', 'real-fixture', 'negative-validator-corpus']) {
    assert.equal(status.cells[unit].status, 'closed');
  }
}
console.log(`F6_REAL_REBUILD_PROOF=${JSON.stringify({
  schemaVersion: FORMAT_SAFE_REBUILD_SCHEMA,
  fixtures: proofRows,
  oracle: { identity: oracleTool.identity, version: oracleTool.version },
  denominator: denominatorStatuses.map((status) => ({ profileId: status.profileId, status: status.status, closedUnitIds: status.closedUnitIds, blockingUnitIds: status.blockingUnitIds })),
  layout: { profileId: layoutStatus.profileId, closedUnitIds: layoutStatus.closedUnitIds, blockingUnitIds: layoutStatus.blockingUnitIds },
  negatives: ['no-op-rejected', 'synthetic-rejected', 'header-tamper-rejected', 'truncation-rejected', 'wrong-identity-rejected', 'signed-input-rejected'],
})}`);
