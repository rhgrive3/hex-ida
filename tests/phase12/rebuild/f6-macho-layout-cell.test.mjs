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
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/phase12/rebuild/fixtures/manifest.json'), 'utf8')).fixtures.find((item) => item.profile === 'macho:64');
const source = fs.readFileSync(path.join(ROOT, fixture.path));
const digest = (bytes) => `bytes:${stableDigest(Array.from(bytes))}`;
const loaderVersion = 'hex-loader:openBinary:v1';
assert.equal(crypto.createHash('sha256').update(source).digest('hex'), fixture.sha256);
assert.equal(fixture.real, true);
assert.match(fixture.producer, /clang/);
const oracleTool = inspectLlvmReadobj();
assert.equal(oracleTool.available, true, oracleTool.reason || 'llvm-readobj unavailable');
assert.match(oracleTool.version, new RegExp(LLVM_READOBJ_EXPECTED_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
const independentOracle = createLlvmReadobjOracle();

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

const image = inspectFormatSafeImage(source);
const textSection = image.snapshot.sections.find((section) => section.name === '__text');
assert.deepEqual({ name: textSection.name, segment: '__TEXT', offset: textSection.offset, size: textSection.size }, { name: '__text', segment: '__TEXT', offset: 384, size: 77 });
const transaction = createFormatSafeRebuildTransaction({
  binaryId: 'fixture:phase12-vertical-macho64-object:text-layout',
  source,
  sourceHash: digest(source),
  format: 'macho',
  architecture: 'x86_64',
  loaderVersion,
  mutation: { kind: 'macho-section-size', segment: '__TEXT', section: '__text', size: 80 },
});
assert.equal(transaction.expectedOriginalState.formatSafe.schema, FORMAT_SAFE_REBUILD_SCHEMA);
assert.equal(transaction.expectedOriginalState.formatSafe.kind, 'macho-section-size');
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
    sectionCount: 2,
    segment: { commandIndex: 0, name: '__TEXT', fileOffset: 384, fileSize: 144, sectionCount: 2 },
    section: { index: 0, segment: '__TEXT', name: '__text', offset: 384, originalSize: 77, size: 80, nextSectionOffset: 464 },
  }, `${validator}: exact Mach-O section-layout evidence`);
}

const rejectedPublication = await publishRebuildTransaction(materialized, validation, { atomicPromote: async () => ({ atomic: true }) });
assert.equal(rejectedPublication.reason, 'rebuild-v2-publication-not-atomic');
const publication = await publishRebuildTransaction(materialized, validation, {
  atomicPromote: async (_candidate, identity) => ({
    atomic: true,
    committed: true,
    protocol: 'temp-then-atomic-rename',
    publicationIdentity: 'fixture-publication:phase12-vertical-macho64-object:text-layout',
    transactionId: identity.materialized.transactionId,
    outputHash: identity.materialized.outputHash,
    outputIdentity: identity.materialized.outputIdentity,
  }),
});
assert.equal(publication.status, 'published');
const proof = { realFixture: true, realFixtureEvidence: true, negativeValidatorTest: true, staleIdentityTest: true, truncationTest: true, wrongIdentityTest: true };
const status = evaluateF6RebuildDenominator({ transaction, validation, publication, proof });
const boundedId = 'macho:64:layout-and-structure:text-section-size-within-file-gap';
assert.equal(status.cells['layout-and-structure'].status, 'blocking');
assert.equal(status.blockingUnitIds.includes('macho:64:layout-and-structure'), true);
assert.equal(status.boundedOperationCells[boundedId].status, 'closed');
assert.equal(status.boundedOperationCells[boundedId].operation, 'macho-section-size');
assert.equal(status.boundedOperationClosedIds.includes(boundedId), true);
assert.equal(status.boundedOperationCells[boundedId].evidence, 'format-safe-macho-section-size+hex-loader-reparse+llvm-readobj-independent-oracle+atomic-publication');
const incomplete = evaluateF6RebuildDenominator({ transaction, validation, publication, proof: { ...proof, realFixture: false } });
assert.equal(incomplete.boundedOperationCells[boundedId].status, 'blocking');

assert.throws(() => createFormatSafeRebuildTransaction({
  binaryId: 'negative:macho-layout:no-op', source, sourceHash: digest(source), format: 'macho', architecture: 'x86_64', loaderVersion,
  mutation: { kind: 'macho-section-size', segment: '__TEXT', section: '__text', size: 77 },
}), /format-safe-macho-layout-size-invalid/);
assert.throws(() => createFormatSafeRebuildTransaction({
  binaryId: 'negative:macho-layout:gap-overrun', source, sourceHash: digest(source), format: 'macho', architecture: 'x86_64', loaderVersion,
  mutation: { kind: 'macho-section-size', segment: '__TEXT', section: '__text', size: 81 },
}), /format-safe-macho-layout-size-invalid/);
assert.throws(() => createFormatSafeRebuildTransaction({
  binaryId: 'negative:macho-layout:section', source, sourceHash: digest(source), format: 'macho', architecture: 'x86_64', loaderVersion,
  mutation: { kind: 'macho-section-size', segment: '__TEXT', section: '__cstring', size: 80 },
}), /format-safe-macho-layout-section-unsupported/);
const tampered = materialized.bytes.slice();
new DataView(tampered.buffer).setBigUint64(transaction.expectedOriginalState.formatSafe.sectionHeaderOffset + 40, 79n, true);
assert.equal(validateFormatSafeMutation({ transaction, original: source, output: tampered }).ok, false, 'tampered section size rejected');
assert.equal((await independentOracle({ transaction, original: source, output: tampered })).ok, false, 'LLVM rejects tampered section size evidence');
assert.equal(validateFormatSafeMutation({ transaction, original: source, output: materialized.bytes.slice(0, -1) }).ok, false, 'truncated output rejected');
assert.throws(() => createFormatSafeRebuildTransaction({
  binaryId: 'negative:macho-layout:identity', source, sourceHash: digest(source), format: 'macho', architecture: 'arm64', loaderVersion,
  mutation: { kind: 'macho-section-size', segment: '__TEXT', section: '__text', size: 80 },
}), /format-safe-source-identity-mismatch/);

console.log('[phase12] bounded Mach-O section-layout cell passed');
