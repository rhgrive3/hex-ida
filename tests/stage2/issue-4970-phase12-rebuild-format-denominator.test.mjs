import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stableDigest } from '../../js/core/identity/index.js';
import {
  stage2FormatMaturity,
  stage2Phase12Maturity,
  stage2SupportMatrix,
} from '../../js/platform/stage2-capability-maturity.js';
import {
  createFormatSafeRebuildTransaction,
  inspectFormatSafeImage,
  validateFormatSafeMutation,
} from '../../js/rebuild/format-safe.js';
import {
  INDEPENDENT_ORACLE_RESULT_SCHEMA,
  isValidatedRebuildProfileSupport,
  materializeRebuildTransaction,
  publishRebuildTransaction,
  rebuildProfileSupport,
  registerCanonicalIndependentOracleProvider,
  validateRebuildTransaction,
} from '../../js/rebuild/transaction-v2.js';
import { validatedCapabilityProofFixture } from './helpers/profile-proof-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COMMIT_SHA = 'a'.repeat(40);
const TREE_SHA = 'b'.repeat(40);
const LOADER_VERSION = 'hex-loader:issue-4970:v1';
const PRESERVATION_UNITS = Object.freeze([
  'layout-and-structure',
  'relocations-and-bindings',
  'branch-ranges',
  'unwind-and-debug',
  'imports-and-exports',
  'signature-consequence',
]);
const EXECUTABLE_DIGEST = `sha256:${'1'.repeat(64)}`;
const REPORT_DIGEST = `sha256:${'2'.repeat(64)}`;
const ORACLE_OUTPUT_DIGEST = `sha256:${'3'.repeat(64)}`;
const digest = (bytes) => `bytes:${stableDigest(Array.from(bytes))}`;

const fixtures = Object.freeze({
  macho: Object.freeze({
    path: 'tests/phase12/rebuild/fixtures/vertical-macho-x86_64.o',
    mutation: Object.freeze({ kind: 'macho-min-version', version: 0x000a0500 }),
    itemId: 'S2-F6-MACHO',
  }),
  elf: Object.freeze({
    path: 'tests/phase5/corpus/fixtures/vertical-sysv-amd64.elf',
    mutation: Object.freeze({ kind: 'elf-comment', tag: 'Hex F6 issue 4970 v1' }),
    itemId: 'S2-F6-ELF',
  }),
  pe: Object.freeze({
    path: 'tests/phase5/corpus/fixtures/vertical-microsoft-x64.exe',
    mutation: Object.freeze({ kind: 'pe-timestamp', timestamp: 0x65f6a245 }),
    itemId: 'S2-F6-PE',
  }),
});

const independentOracle = registerCanonicalIndependentOracleProvider(async ({ transaction, original, output }) => ({
  schemaVersion: INDEPENDENT_ORACLE_RESULT_SCHEMA,
  ok: true,
  status: 'passed',
  oracleIdentity: 'external:llvm-readobj',
  oracleVersion: 'Ubuntu LLVM version 18.1.3 (test authority adapter)',
  oracleSource: `/usr/bin/llvm-readobj@${EXECUTABLE_DIGEST} --all`,
  oracleExecutableDigest: EXECUTABLE_DIGEST,
  oracleOutputDigest: ORACLE_OUTPUT_DIGEST,
  sourceDigest: digest(original),
  outputDigest: digest(output),
  format: transaction.format,
  architecture: transaction.architecture,
  preservationEvidence: {
    complete: true,
    signaturePolicy: 'unsigned-input-required',
    sourceReportDigest: REPORT_DIGEST,
    outputReportDigest: REPORT_DIGEST,
    units: [...PRESERVATION_UNITS],
  },
}));

function loaderReparse({ transaction, original, output, expectedOutputHash }) {
  const image = inspectFormatSafeImage(output);
  const ok = image.format === transaction.format && image.architecture === transaction.architecture;
  return {
    ok,
    status: ok ? 'passed' : 'rejected',
    format: image.format,
    architecture: image.architecture,
    loaderVersion: transaction.loaderVersion,
    sourceHash: digest(original),
    outputHash: digest(output),
    expectedOutputHash,
  };
}

async function validatedFormatSupport(format, profileProof) {
  const fixture = fixtures[format];
  const source = new Uint8Array(fs.readFileSync(path.join(ROOT, fixture.path)));
  const inspected = inspectFormatSafeImage(source);
  assert.equal(inspected.format, format);

  const transaction = createFormatSafeRebuildTransaction({
    binaryId: `fixture:issue-4970:${format}`,
    source,
    sourceHash: digest(source),
    format,
    architecture: inspected.architecture,
    loaderVersion: LOADER_VERSION,
    mutation: fixture.mutation,
  });
  const materialized = await materializeRebuildTransaction(transaction, source, { maxOutputBytes: source.length });
  assert.equal(materialized.status, 'materialized');

  const validation = await validateRebuildTransaction(transaction, materialized, {
    original: source,
    loaderReparse,
    independentOracle,
    validators: { 'format-invariants': validateFormatSafeMutation },
  });
  assert.equal(validation.status, 'valid', `${format}: ${JSON.stringify(validation.failures)}`);

  const publication = await publishRebuildTransaction(materialized, validation, {
    atomicPromote: async (_bytes, identity) => ({
      atomic: true,
      committed: true,
      protocol: 'temp-then-atomic-rename',
      publicationIdentity: `fixture-publication:issue-4970:${format}`,
      transactionId: identity.materialized.transactionId,
      outputHash: identity.materialized.outputHash,
      outputIdentity: identity.materialized.outputIdentity,
    }),
  });
  assert.equal(publication.status, 'published');

  const support = rebuildProfileSupport({
    transaction,
    validation,
    publication,
    proof: {
      exactHead: true,
      negativeValidatorTest: true,
      staleIdentityTest: true,
      formatSpecificValidatorTests: true,
      atomicInterruptionTest: true,
      realFixture: true,
      realFixtureEvidence: true,
      truncationTest: true,
      wrongIdentityTest: true,
    },
    profileProof,
    expectedCommitSha: COMMIT_SHA,
    expectedTreeSha: TREE_SHA,
  });
  assert.equal(support.status, 'supported-for-exact-rebuild-profile', `${format}: ${JSON.stringify(support.f6Denominator)}`);
  assert.equal(isValidatedRebuildProfileSupport(support), true);
  return support;
}

const { proofs } = validatedCapabilityProofFixture();
const supports = {};
for (const format of ['macho', 'elf', 'pe']) {
  supports[format] = await validatedFormatSupport(format, proofs[fixtures[format].itemId]);
}

// A single format-bound rebuild proof cannot establish the all-format Phase12 denominator.
for (const format of ['macho', 'elf', 'pe']) {
  assert.equal(stage2Phase12Maturity({ profileProofs: proofs, rebuildProof: supports[format] }).rebuild.status, 'partial');
  assert.equal(stage2Phase12Maturity({ profileProofs: proofs, rebuildProofs: { [format]: supports[format] } }).rebuild.status, 'partial');
}
assert.equal(stage2Phase12Maturity({ profileProofs: proofs }).rebuild.status, 'partial');

const complete = stage2Phase12Maturity({ profileProofs: proofs, rebuildProofs: supports });
assert.equal(complete.rebuild.status, 'supported');
assert.equal(complete.rebuild.authority, 'validated-atomic-profile');
assert.deepEqual(complete.rebuild.limitations, []);

assert.equal(stage2Phase12Maturity({
  profileProofs: proofs,
  rebuildProofs: { macho: supports.elf, elf: supports.macho, pe: supports.pe },
}).rebuild.status, 'partial', 'format-key swaps cannot satisfy the aggregate denominator');
assert.equal(stage2Phase12Maturity({
  profileProofs: proofs,
  rebuildProofs: { macho: supports.macho, elf: supports.macho, pe: supports.macho },
}).rebuild.status, 'partial', 'duplicate proof reuse cannot satisfy other formats');
assert.equal(stage2Phase12Maturity({
  profileProofs: proofs,
  rebuildProofs: { ...supports, pe: { ...supports.pe } },
}).rebuild.status, 'partial', 'copied proof cannot retain rebuild authority');
assert.equal(stage2Phase12Maturity({
  profileProofs: proofs,
  rebuildProofs: [supports.macho, supports.elf, supports.pe],
}).rebuild.status, 'partial', 'an array is not a format-indexed proof record');
assert.equal(stage2Phase12Maturity({
  profileProofs: proofs,
  rebuildProofs: 'macho,elf,pe',
}).rebuild.status, 'partial', 'structured proof maps are required');
const nullPrototypeProofs = Object.assign(Object.create(null), supports);
assert.equal(
  stage2Phase12Maturity({ profileProofs: proofs, rebuildProofs: nullPrototypeProofs }).rebuild.status,
  'supported',
  'proof records must not depend on Object prototypes or instanceof checks',
);

const matrix = stage2SupportMatrix({ profileProofs: proofs, rebuildProofs: supports });
assert.equal(matrix.phase12.rebuild.status, 'supported', 'support matrix must pass its format-indexed rebuild proofs to Phase12');
assert.equal(stage2SupportMatrix({ profileProofs: proofs, rebuildProofs: { macho: supports.macho } }).phase12.rebuild.status, 'partial');
assert.equal(stage2SupportMatrix({
  profileProofs: proofs,
  rebuildProofs: { macho: supports.macho },
  phase12: { rebuildProofs: supports },
}).phase12.rebuild.status, 'partial', 'nested Phase12 input cannot override the support matrix format authority');
assert.equal(stage2SupportMatrix({
  profileProofs: proofs,
  rebuildProofs: supports,
  phase12: { rebuildProofs: { macho: supports.macho } },
}).phase12.rebuild.status, 'supported', 'support matrix must use the same canonical rebuild proof map for formats and Phase12');

for (const format of ['macho', 'elf', 'pe']) {
  const perFormat = stage2FormatMaturity(format, {
    rebuildProof: supports[format],
    profileProof: proofs[fixtures[format].itemId],
  });
  assert.equal(perFormat.features.validatedRebuildPatch, 'supported', `${format}: format-level promotion must remain intact`);
}

console.log('[stage2] issue #4970 Phase12 rebuild format denominator regression passed');
