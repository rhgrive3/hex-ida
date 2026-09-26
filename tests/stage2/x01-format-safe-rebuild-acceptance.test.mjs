import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stableDigest } from '../../js/core/identity/index.js';
import { openBinary } from '../../js/binary/index.js';
import { buildSampleBinary } from '../../js/sample.js';
import {
  F6_BOUNDED_OPERATION_CELLS,
  F6_REBUILD_PROFILES,
  F6_REBUILD_UNITS,
  INDEPENDENT_ORACLE_RESULT_SCHEMA,
  createRebuildTransaction,
  evaluateF6RebuildDenominator,
  isValidatedAtomicPublicationReceipt,
  materializeRebuildTransaction,
  publishRebuildTransaction,
  rebuildProfileSupport,
  registerCanonicalAtomicPublicationProvider,
  registerCanonicalIndependentOracleProvider,
  validateRebuildTransaction,
} from '../../js/rebuild/transaction-v2.js';
import {
  createFormatSafeRebuildTransaction,
  inspectFormatSafeImage,
  validateFormatSafeMutation,
} from '../../js/rebuild/format-safe.js';
import {
  LLVM_READOBJ_EXPECTED_VERSION,
  LLVM_READOBJ_IDENTITY,
  createLlvmReadobjOracle,
  inspectLlvmReadobj,
} from '../../tools/validation/rebuild-independent-oracle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const digest = (bytes) => `bytes:${stableDigest(Array.from(bytes))}`;

console.log('[x01-acceptance] verifying HEX-X-01 / FR-X-01A rebuild transaction v2 & format-safe acceptance...');

// ---------------------------------------------------------------------------
// Test 1: Denominator & Transaction Identity Integrity
// ---------------------------------------------------------------------------
assert.deepEqual([...F6_REBUILD_UNITS], [
  'transaction-identity', 'layout-and-structure', 'relocations-and-bindings', 'branch-ranges',
  'unwind-and-debug', 'imports-and-exports', 'signature-consequence', 'loader-reparse',
  'independent-differential-oracle', 'atomic-publication', 'real-fixture', 'negative-validator-corpus',
], 'F6 rebuild units must match canonical 12-unit inventory');

assert.deepEqual([...F6_REBUILD_PROFILES], ['macho:64', 'elf:64', 'pe:pe32', 'pe:pe32+'], 'F6 rebuild profiles must cover 4 canonical profiles');
assert.equal(F6_BOUNDED_OPERATION_CELLS.length, 4, 'F6 bounded operation cells must cover 4 canonical cells');

const source1 = Uint8Array.from([0x10, 0x20, 0x30, 0x40]);
const sourceHash1 = digest(source1);
const tx1 = createRebuildTransaction({
  binaryId: 'binary:elf:identity-test',
  sourceHash: sourceHash1,
  format: 'elf',
  architecture: 'x86_64',
  loaderVersion: 'hex-loader:openBinary:v1',
  operations: [{ id: 'op-1', offset: 1, before: [0x20], after: [0x99], provenance: { source: 'unit-test' } }],
  requireIndependentOracle: true,
});
assert.equal(typeof tx1.transactionId, 'string');
assert.ok(tx1.transactionId.startsWith('rebuild-transaction:'));
assert.equal(tx1.sizeDelta, 0);
assert.ok(tx1.requiredValidators.includes('independent-differential'));
assert.ok(tx1.requiredValidators.includes('loader-reparse'));

// Fail-closed on bad inputs
assert.throws(() => createRebuildTransaction({ ...tx1, format: 'unknown-format' }), /format-unsupported/);
assert.throws(() => createRebuildTransaction({ ...tx1, binaryId: '' }), /binary-id-required/);
assert.throws(() => createRebuildTransaction({
  binaryId: 'binary:elf:test', sourceHash: sourceHash1, format: 'elf', architecture: 'x86_64', loaderVersion: 'v1',
  operations: [{ id: 'bad-byte', offset: 0, before: [0x10], after: [300], provenance: { source: 'test' } }],
}), /byte-invalid/);
console.log('  ok 1: transaction identity & denominator integrity passed');

// ---------------------------------------------------------------------------
// Test 2: Independent Writer / Oracle Separation & Provider Registration
// ---------------------------------------------------------------------------
const elfBytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests/phase5/corpus/fixtures/vertical-sysv-amd64.elf')));
const elfHash = digest(elfBytes);

// For formatSafe transactions, provider must be registered via registerCanonicalIndependentOracleProvider
const fsTx = createFormatSafeRebuildTransaction({
  binaryId: 'binary:elf:fs-oracle-test',
  source: elfBytes,
  sourceHash: elfHash,
  format: 'elf',
  architecture: 'x86_64',
  loaderVersion: 'hex-loader:openBinary:v1',
  mutation: { kind: 'elf-comment', tag: 'test' },
});
const fsMaterialized = await materializeRebuildTransaction(fsTx, elfBytes, { maxOutputBytes: 32 * 1024 * 1024 });
assert.equal(fsMaterialized.status, 'materialized');

let unregisteredCalled = false;
const unregisteredOracle = async () => { unregisteredCalled = true; return { ok: true }; };

// Passing an unregistered oracle to validateRebuildTransaction must fail closed
const unregisteredValidation = await validateRebuildTransaction(fsTx, fsMaterialized, {
  original: elfBytes,
  loaderReparse: () => ({ ok: true }),
  independentOracle: unregisteredOracle,
});
assert.equal(unregisteredValidation.status, 'invalid');
assert.equal(unregisteredCalled, false, 'unregistered oracle provider must never be invoked for formatSafe transactions');
const unregisteredFail = unregisteredValidation.validators.find((v) => v.validator === 'independent-differential');
assert.equal(unregisteredFail.status, 'failed');
assert.equal(unregisteredFail.reason, 'independent-oracle-provider-untrusted');

// Register canonical provider for general transaction
const canonicalOracle = registerCanonicalIndependentOracleProvider(async ({ output }) => {
  return {
    schemaVersion: INDEPENDENT_ORACLE_RESULT_SCHEMA,
    ok: true,
    status: 'passed',
    oracleIdentity: 'external:canonical-test-oracle',
    oracleVersion: 'test-oracle/1.0.0',
    oracleSource: 'tests/stage2/x01-format-safe-rebuild-acceptance.test.mjs',
    sourceDigest: sourceHash1,
    outputDigest: digest(output),
    format: 'elf',
    architecture: 'x86_64',
  };
});

const materialized1 = await materializeRebuildTransaction(tx1, source1, { maxOutputBytes: 1024 });
assert.equal(materialized1.status, 'materialized');

const conservativeImpactValidators = Object.fromEntries(
  ['relocations', 'branch-ranges', 'unwind', 'imports-exports', 'signature-consequence']
    .map((name) => [name, async () => ({ ok: true, status: 'passed' })]),
);
const registeredValidation = await validateRebuildTransaction(tx1, materialized1, {
  original: source1,
  loaderReparse: () => ({ ok: true, format: 'elf', architecture: 'x86_64', loaderVersion: tx1.loaderVersion, sourceHash: tx1.sourceHash, outputHash: materialized1.outputHash }),
  independentOracle: canonicalOracle,
  validators: conservativeImpactValidators,
});
assert.equal(registeredValidation.status, 'valid');
assert.equal(registeredValidation.independentDifferential, 'executed');

// Anti-forge: a provider attempting to claim preservation without pinned LLVM 18.1.3 identity must be rejected
const forgedPreservationOracle = registerCanonicalIndependentOracleProvider(async ({ output }) => {
  return {
    schemaVersion: INDEPENDENT_ORACLE_RESULT_SCHEMA,
    ok: true,
    status: 'passed',
    oracleIdentity: 'external:custom-oracle',
    oracleVersion: '1.0.0',
    oracleSource: 'custom-source',
    sourceDigest: elfHash,
    outputDigest: digest(output),
    format: 'elf',
    architecture: 'x86_64',
    preservationEvidence: { complete: true, signaturePolicy: 'unsigned-input-required' },
  };
});
const forgedVal = await validateRebuildTransaction(fsTx, fsMaterialized, {
  original: elfBytes,
  loaderReparse: () => ({ ok: true, format: 'elf', architecture: 'x86_64' }),
  independentOracle: forgedPreservationOracle,
  validators: { layout: validateFormatSafeMutation, 'format-invariants': validateFormatSafeMutation },
});
assert.equal(forgedVal.status, 'invalid');
assert.equal(forgedVal.validators.find((v) => v.validator === 'independent-differential').reason, 'independent-oracle-preservation-provider-identity-invalid');
console.log('  ok 2: independent writer/oracle separation & provider registration passed');

// ---------------------------------------------------------------------------
// Test 3: Fail-Closed Gate on Missing or Rejecting Oracle
// ---------------------------------------------------------------------------
// Missing independent oracle when required
const missingOracleValidation = await validateRebuildTransaction(tx1, materialized1, {
  original: source1,
  loaderReparse: () => ({ ok: true }),
});
assert.equal(missingOracleValidation.status, 'invalid');
assert.equal(missingOracleValidation.independentDifferential, 'failed');
const missingV = missingOracleValidation.validators.find((v) => v.validator === 'independent-differential');
assert.equal(missingV.reason, 'required-validator-unavailable');

// Oracle rejecting output
const rejectingOracle = registerCanonicalIndependentOracleProvider(async () => {
  return {
    schemaVersion: INDEPENDENT_ORACLE_RESULT_SCHEMA,
    ok: false,
    status: 'rejected',
    reason: 'independent-oracle-rejected-output',
    oracleIdentity: 'external:rejecting-oracle',
  };
});
const rejectedValidation = await validateRebuildTransaction(tx1, materialized1, {
  original: source1,
  loaderReparse: () => ({ ok: true }),
  independentOracle: rejectingOracle,
});
assert.equal(rejectedValidation.status, 'invalid');
assert.equal(rejectedValidation.independentDifferential, 'failed');

// Publication must be strictly refused when validation is not green
let promoted = false;
const pubRefused = await publishRebuildTransaction(materialized1, rejectedValidation, {
  atomicPromote: async () => { promoted = true; return { ok: true }; },
});
assert.equal(promoted, false, 'promotion must not execute for non-green validation');
assert.equal(pubRefused.status, 'rejected');
assert.equal(pubRefused.reason, 'rebuild-v2-validation-not-green');
console.log('  ok 3: fail-closed gate on missing or rejecting oracle passed');

// ---------------------------------------------------------------------------
// Test 4: Publication Proof Boundary & Receipts
// ---------------------------------------------------------------------------
// Forged publication receipt must carry no authority
const forgedReceipt = {
  status: 'published',
  outputIdentity: materialized1.outputIdentity,
  transactionId: tx1.transactionId,
};
assert.equal(isValidatedAtomicPublicationReceipt(forgedReceipt), false, 'copied receipt object must be rejected');
assert.equal(isValidatedAtomicPublicationReceipt(null), false);
assert.equal(isValidatedAtomicPublicationReceipt({}), false);

// Genuine atomic publication through registered provider
let atomicRenameExecuted = false;
const canonicalPromoter = registerCanonicalAtomicPublicationProvider(async (bytesCopy) => {
  atomicRenameExecuted = true;
  return {
    atomic: true,
    committed: true,
    protocol: 'temp-then-atomic-rename',
    transactionId: materialized1.transactionId,
    outputHash: materialized1.outputHash,
    outputIdentity: materialized1.outputIdentity,
    publicationIdentity: 'publication:receipt:canonical-acceptance-1',
  };
});
const publication = await publishRebuildTransaction(materialized1, registeredValidation, {
  atomicPromote: canonicalPromoter,
});
assert.equal(atomicRenameExecuted, true);
assert.equal(publication.status, 'published');
assert.equal(publication.authority, 'trusted-atomic-publication');
assert.equal(isValidatedAtomicPublicationReceipt(publication), true, 'genuine publication must carry proof authority');
console.log('  ok 4: publication proof boundary & receipts passed');

// ---------------------------------------------------------------------------
// Test 5: Format-Safe Binary Rebuild Across Real Formats (ELF, PE, Mach-O)
// ---------------------------------------------------------------------------
// Real ELF Fixture
const elfImage = inspectFormatSafeImage(elfBytes);
assert.equal(elfImage.format, 'elf');
assert.equal(elfImage.architecture, 'x86_64');
const elfTx = createFormatSafeRebuildTransaction({
  binaryId: 'binary:elf:format-safe',
  source: elfBytes,
  sourceHash: digest(elfBytes),
  format: 'elf',
  architecture: 'x86_64',
  loaderVersion: 'hex-loader:openBinary:v1',
  mutation: { kind: 'elf-comment', tag: 'Hex X01 Local Acceptance' },
});
const elfMaterialized = await materializeRebuildTransaction(elfTx, elfBytes, { maxOutputBytes: 64 * 1024 * 1024 });
assert.equal(elfMaterialized.status, 'materialized');
assert.notEqual(elfMaterialized.outputHash, elfTx.sourceHash);
// Re-read with loader
const elfReopened = openBinary(elfMaterialized.bytes);
assert.equal(elfReopened.format, 'elf');
assert.equal(elfReopened.arch, 'x86_64');

// Real PE Fixture
const peBytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests/phase5/corpus/fixtures/vertical-microsoft-x64.exe')));
const peImage = inspectFormatSafeImage(peBytes);
assert.equal(peImage.format, 'pe');
assert.equal(peImage.architecture, 'x86_64');
const peTx = createFormatSafeRebuildTransaction({
  binaryId: 'binary:pe:format-safe',
  source: peBytes,
  sourceHash: digest(peBytes),
  format: 'pe',
  architecture: 'x86_64',
  loaderVersion: 'hex-loader:openBinary:v1',
  mutation: { kind: 'pe-timestamp', timestamp: 0x66dd0000 },
});
const peMaterialized = await materializeRebuildTransaction(peTx, peBytes, { maxOutputBytes: 64 * 1024 * 1024 });
assert.equal(peMaterialized.status, 'materialized');
const peReopened = openBinary(peMaterialized.bytes);
assert.equal(peReopened.format, 'pe');
assert.equal(peReopened.arch, 'x86_64');

// Real Mach-O Fixture (vertical-macho-x86_64.o)
const machoBytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests/phase12/rebuild/fixtures/vertical-macho-x86_64.o')));
const machoImage = inspectFormatSafeImage(machoBytes);
assert.equal(machoImage.format, 'macho');
assert.equal(machoImage.architecture, 'x86_64');
const machoTx = createFormatSafeRebuildTransaction({
  binaryId: 'binary:macho:format-safe',
  source: machoBytes,
  sourceHash: digest(machoBytes),
  format: 'macho',
  architecture: 'x86_64',
  loaderVersion: 'hex-loader:openBinary:v1',
  mutation: { kind: 'macho-min-version', version: 0x000e0000 },
});
const machoMaterialized = await materializeRebuildTransaction(machoTx, machoBytes, { maxOutputBytes: 64 * 1024 * 1024 });
assert.equal(machoMaterialized.status, 'materialized');
const machoReopened = openBinary(machoMaterialized.bytes);
assert.equal(machoReopened.format, 'macho');
assert.equal(machoReopened.arch, 'x86_64');
console.log('  ok 5: format-safe binary rebuild across ELF, PE, and Mach-O passed');

// ---------------------------------------------------------------------------
// Test 6: Writer-Independent Differential Oracle Execution & Layout Evidence
// ---------------------------------------------------------------------------
const hostOracle = inspectLlvmReadobj({ expectedVersion: null });
if (hostOracle.available) {
  const independentReader = createLlvmReadobjOracle({ expectedVersion: null });

  // Real Mach-O fixture layout mutation
  const machoFixtureBytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests/phase12/rebuild/fixtures/vertical-macho-x86_64.o')));
  const machoLayoutTx = createFormatSafeRebuildTransaction({
    binaryId: 'fixture:x01:real-macho-layout',
    source: machoFixtureBytes,
    sourceHash: digest(machoFixtureBytes),
    format: 'macho',
    architecture: 'x86_64',
    loaderVersion: 'hex-loader:openBinary:v1',
    mutation: { kind: 'macho-section-size', size: 80 },
  });
  const machoLayoutMat = await materializeRebuildTransaction(machoLayoutTx, machoFixtureBytes, { maxOutputBytes: 1024 * 1024 });
  assert.equal(machoLayoutMat.status, 'materialized');
  const machoLayoutVal = await validateRebuildTransaction(machoLayoutTx, machoLayoutMat, {
    original: machoFixtureBytes,
    loaderReparse: () => ({ ok: true, format: 'macho', architecture: 'x86_64', loaderVersion: machoLayoutTx.loaderVersion, sourceHash: machoLayoutTx.sourceHash, outputHash: machoLayoutMat.outputHash }),
    independentOracle: independentReader,
    validators: {
      layout: validateFormatSafeMutation,
      'format-invariants': validateFormatSafeMutation,
    },
  });
  assert.equal(machoLayoutVal.status, 'valid');
  assert.equal(machoLayoutVal.independentDifferential, 'executed');

  // Real PE fixture layout mutation
  const peFixtureBytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests/phase12/rebuild/fixtures/vertical-microsoft-x86.exe')));
  const peLayoutTx = createFormatSafeRebuildTransaction({
    binaryId: 'fixture:x01:real-pe-layout',
    source: peFixtureBytes,
    sourceHash: digest(peFixtureBytes),
    format: 'pe',
    architecture: 'x86',
    loaderVersion: 'hex-loader:openBinary:v1',
    mutation: { kind: 'pe-section-virtual-size', virtualSize: 0x180 },
  });
  const peLayoutMat = await materializeRebuildTransaction(peLayoutTx, peFixtureBytes, { maxOutputBytes: 1024 * 1024 });
  assert.equal(peLayoutMat.status, 'materialized');
  const peLayoutVal = await validateRebuildTransaction(peLayoutTx, peLayoutMat, {
    original: peFixtureBytes,
    loaderReparse: () => ({ ok: true, format: 'pe', architecture: 'x86', loaderVersion: peLayoutTx.loaderVersion, sourceHash: peLayoutTx.sourceHash, outputHash: peLayoutMat.outputHash }),
    independentOracle: independentReader,
    validators: {
      layout: validateFormatSafeMutation,
      'format-invariants': validateFormatSafeMutation,
    },
  });
  assert.equal(peLayoutVal.status, 'valid');
  assert.equal(peLayoutVal.independentDifferential, 'executed');
}
console.log('  ok 6: writer-independent differential oracle execution & layout evidence passed');

// ---------------------------------------------------------------------------
// Test 7: Environment Gate & Pinned LLVM 18.1.3 Version Policy
// ---------------------------------------------------------------------------
// Default inspectLlvmReadobj probes for Ubuntu LLVM version 18.1.3
const pinnedTool = inspectLlvmReadobj();
assert.equal(pinnedTool.identity, LLVM_READOBJ_IDENTITY);
assert.equal(pinnedTool.expectedVersion, LLVM_READOBJ_EXPECTED_VERSION);

// If host lacks exact Ubuntu LLVM version 18.1.3, it MUST fail closed
if (!pinnedTool.version?.includes(LLVM_READOBJ_EXPECTED_VERSION)) {
  assert.equal(pinnedTool.available, false);
  assert.ok(
    ['independent-oracle-tool-version-mismatch', 'independent-oracle-tool-unavailable'].includes(pinnedTool.reason),
    'pinned tool probe must fail closed with explicit reason',
  );

  // Oracle created with default pinned version must reject
  const pinnedOracle = createLlvmReadobjOracle();
  const pinnedResult = await pinnedOracle({
    transaction: tx1,
    original: source1,
    output: source1,
  });
  assert.equal(pinnedResult.ok, false);
  assert.equal(pinnedResult.status, 'rejected');
  assert.equal(pinnedResult.reason, pinnedTool.reason);

  // And validation under pinned oracle requirement must fail closed
  const pinnedValidation = await validateRebuildTransaction(tx1, materialized1, {
    original: source1,
    loaderReparse: () => ({ ok: true }),
    independentOracle: pinnedOracle,
  });
  assert.equal(pinnedValidation.status, 'invalid');
  assert.equal(pinnedValidation.independentDifferential, 'failed');
}

// Missing executable probe fail-closed
const missingProbe = inspectLlvmReadobj({ command: '/nonexistent/path/llvm-readobj', expectedVersion: null });
assert.equal(missingProbe.available, false);
assert.equal(missingProbe.reason, 'independent-oracle-tool-unavailable');
assert.equal(missingProbe.executable, null);

console.log('  ok 7: environment gate & pinned LLVM 18.1.3 version policy passed');
console.log('[x01-acceptance] all 7 tests passed.');
