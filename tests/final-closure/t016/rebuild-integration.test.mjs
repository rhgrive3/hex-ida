import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { stableDigest } from '../../../js/core/identity/index.js';
import { functionCandidates, discoveryArtifactForRebuild } from '../../../js/analysis/index.js';
import { REBUILD_DISCOVERY_MAX_BYTES, registerCanonicalRebuildPublicationAdapter } from '../../../js/rebuild/transaction-v2.js';
import { openBinary } from '../../../js/binary/index.js';
import { createFormatSafeRebuildTransaction, validateFormatSafeMutation } from '../../../js/rebuild/format-safe.js';
import { createRebuildTransaction, evaluateF6RebuildDenominator, materializeRebuildTransaction,
  publishRebuildTransaction, rebuildProfileSupport, validateRebuildTransaction } from '../../../js/rebuild/transaction-v2.js';
import { createNodeAtomicPublicationAdapter } from '../../../tools/validation/discovery/node-atomic-publication.mjs';

const source = new Uint8Array(fs.readFileSync(new URL('../../phase5/corpus/fixtures/vertical-sysv-amd64.elf', import.meta.url)));
function transaction(overrides = {}) {
  const planned = createFormatSafeRebuildTransaction({
    binaryId: 't016:real-elf', source, format: 'elf', architecture: 'x86_64',
    loaderVersion: 'hex-loader:openBinary:v1', mutation: { kind: 'elf-comment', tag: 'T016 discovery roundtrip' },
  });
  // This test exercises the discovery contract, not the independent LLVM/F6
  // denominator. The real format validator is retained; no oracle is forged.
  return createRebuildTransaction({ ...planned, additionalValidators: ['format-invariants'],
    requireIndependentOracle: false, requireDiscoveryPreservation: true,
    sourceLength: source.length, snapshotId: 't016:source', ...overrides });
}
async function prepare(overrides = {}, options = {}) {
  const tx = transaction(overrides);
  const materialized = await materializeRebuildTransaction(tx, source, options);
  assert.equal(materialized.status, 'materialized', JSON.stringify(materialized));
  const validation = await validateRebuildTransaction(tx, materialized, {
    original: source,
    loaderReparse: ({ output }) => ({ ok: openBinary(output).format === 'elf' }),
    validators: { 'format-invariants': validateFormatSafeMutation }, ...options,
  });
  assert.equal(validation.status, 'valid', JSON.stringify(validation));
  return { tx, materialized, validation };
}
function receipt(materialized, publicationIdentity = 't016:committed') {
  return { atomic: true, committed: true, protocol: 'transactional-store', publicationIdentity,
    transactionId: materialized.transactionId, outputHash: materialized.outputHash, outputIdentity: materialized.outputIdentity };
}

test('T016 counterexample: a discovery-required publication cannot succeed on an identity-only receipt', async () => {
  const { materialized, validation } = await prepare();
  let promotions = 0;
  const publication = await publishRebuildTransaction(materialized, validation, {
    atomicPromote: async (_bytes, { materialized: m }) => { promotions += 1; return receipt(m); },
  });
  assert.equal(publication.status, 'not-published');
  assert.equal(publication.reason, 'rebuild-v2-canonical-publication-adapter-required');
  assert.equal(promotions, 0, 'missing readback must be detected before any commit side effect');
});

test('T016 arbitrary callback receipts cannot mint discovery publication proof', async () => {
  const { materialized, validation } = await prepare();
  let promotions = 0;
  const publication = await publishRebuildTransaction(materialized, validation, {
    atomicPromote: async (_bytes, { materialized: m }) => { promotions += 1; return receipt(m); },
    readCommitted: async () => ({ size: materialized.outputLength, read: async () => materialized.bytes.slice() }),
  });
  assert.equal(publication.status, 'not-published');
  assert.equal(publication.reason, 'rebuild-v2-canonical-publication-adapter-required');
  assert.equal(promotions, 0);
});

test('T016 an untrusted delayed callback is never invoked and cannot publish stale bytes', async (t) => {
  const { materialized, validation } = await prepare();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-t016-late-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'committed.bin');
  const controller = new AbortController();
  const publication = publishRebuildTransaction(materialized, validation, {
    signal: controller.signal,
    atomicPromote: () => new Promise((resolve) => setTimeout(() => {
      fs.writeFileSync(target, materialized.bytes);
      resolve(receipt(materialized, target));
    }, 20)),
    readCommitted: async () => ({ size: materialized.outputLength, read: async () => materialized.bytes.slice() }),
  });
  setImmediate(() => controller.abort());
  assert.equal((await publication).reason, 'rebuild-v2-canonical-publication-adapter-required');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(fs.existsSync(target), false, 'cancelled publication must not commit later');
});


const digest = (bytes) => `bytes:${stableDigest(Array.from(bytes))}`;
const identity = { binaryId: 't016:real-elf', sourceHash: digest(source), snapshotId: 't016:source', architectureId: 'x86_64' };
function sourceArtifact(overrides = {}, image = openBinary(source)) {
  return functionCandidates({ input: { image }, ...identity, ...overrides }).artifact;
}
function validationOptions(original = source) {
  return { original, validators: { 'format-invariants': validateFormatSafeMutation } };
}
function discoveryFailure(validation) {
  assert.notEqual(validation.status, 'valid');
  return validation.failures?.find((item) => item.validator === 'discovery-preservation')?.reason ?? validation.reason;
}
function rawTransaction(bytes, overrides = {}) {
  return createRebuildTransaction({ binaryId: identity.binaryId, sourceHash: digest(bytes), sourceLength: bytes.length,
    format: 'elf', architecture: 'x86_64', loaderVersion: 'hex-loader:openBinary:v1', snapshotId: identity.snapshotId,
    requireDiscoveryPreservation: true, operations: [{ offset: 0, before: [bytes[0]], after: [bytes[0]] }], ...overrides });
}

// Positive proof uses tracked compiler-produced bytes, bounded readback of a
// real same-directory temporary, and atomic rename, not a receipt cache.
async function filePublication(t, materialized, validation) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-t016-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'committed.bin');
  const publication = await publishRebuildTransaction(materialized, validation, {
    publicationAdapter: createNodeAtomicPublicationAdapter({ targetPath: target }),
  });
  assert.equal(publication.status, 'published', JSON.stringify(publication));
  assert.equal(publication.discovery.verified, true);
  assert.equal(publication.publicationIdentity, path.resolve(target));
  assert.deepEqual(new Uint8Array(fs.readFileSync(target)), materialized.bytes);
  assert.deepEqual(fs.readdirSync(directory), ['committed.bin']);
  return publication;
}

test('T016 real ELF: source parse -> changed bytes -> fresh discovery -> verified temporary -> atomic rename', async (t) => {
  const { tx, materialized, validation } = await prepare({}, { loaderReparse: undefined });
  assert.ok(tx.requiredValidators.includes('discovery-preservation'));
  assert.notEqual(materialized.outputHash, tx.sourceHash);
  assert.notDeepEqual(materialized.bytes, source);
  assert.equal(materialized.discovery.sourceBinding.binding.sourceHash, tx.sourceHash);
  assert.ok(materialized.discovery.sourceBinding.functionCandidates.some((candidate) => candidate.extentState === 'unknown'));
  assert.equal(validation.discovery.outputBinding.sourceHash, materialized.outputHash);
  assert.equal(validation.discovery.outputBinding.architectureId, tx.architecture);
  assert.notEqual(validation.discovery.outputBinding.snapshotId, tx.discovery.snapshotId);
  assert.notEqual(validation.discovery.sourceArtifactId, validation.discovery.outputArtifactId);
  assert.equal(validation.discovery.comparison.candidatesPreserved, true);
  assert.equal(validation.discovery.comparison.intervalsPreserved, true);
  const independent = sourceArtifact({ sourceHash: materialized.outputHash,
    snapshotId: validation.discovery.outputBinding.snapshotId }, openBinary(materialized.bytes));
  assert.equal(independent.artifactId, validation.discovery.outputArtifactId);
  await filePublication(t, materialized, validation);
});

test('T016 discovery publication authority is bound to the exact issued receipt and validation', async (t) => {
  const { tx, materialized, validation } = await prepare();
  const publication = await filePublication(t, materialized, validation);
  const actual = evaluateF6RebuildDenominator({ transaction: tx, validation, publication });
  assert.equal(actual.cells['atomic-publication'].status, 'closed');
  assert.equal(rebuildProfileSupport({ transaction: tx, validation, publication }).f6Denominator
    .cells['atomic-publication'].status, 'closed');

  for (const forged of [{ ...publication }, structuredClone(publication)]) {
    assert.equal(evaluateF6RebuildDenominator({ transaction: tx, validation, publication: forged })
      .cells['atomic-publication'].status, 'blocking');
    assert.equal(rebuildProfileSupport({ transaction: tx, validation, publication: forged }).f6Denominator
      .cells['atomic-publication'].status, 'blocking');
  }
  const other = await prepare();
  assert.equal(other.tx.transactionId, tx.transactionId);
  assert.equal(other.validation.validationId, validation.validationId);
  assert.equal(evaluateF6RebuildDenominator({ transaction: tx, validation: other.validation, publication })
    .cells['atomic-publication'].status, 'blocking');
  assert.equal(evaluateF6RebuildDenominator({ transaction: other.tx, validation: other.validation, publication })
    .cells['atomic-publication'].status, 'blocking');
});

const manifest = JSON.parse(fs.readFileSync(new URL('../../phase12/rebuild/fixtures/manifest.json', import.meta.url), 'utf8'));
test('T016 discovery preservation composes with required LLVM proof and real committed readback', async (t) => {
  const { createLlvmReadobjOracle } = await import('../../../tools/validation/rebuild-independent-oracle.mjs');
  const tx = transaction({ requireIndependentOracle: true });
  const materialized = await materializeRebuildTransaction(tx, source);
  assert.equal(materialized.status, 'materialized');
  const missingOracle = await validateRebuildTransaction(tx, materialized, validationOptions());
  assert.equal(missingOracle.status, 'invalid', 'discovery proof must not replace the required independent oracle');
  const validation = await validateRebuildTransaction(tx, materialized, {
    ...validationOptions(), independentOracle: createLlvmReadobjOracle(),
  });
  assert.equal(validation.status, 'valid', JSON.stringify(validation));
  assert.equal(validation.independentDifferential, 'executed');
  assert.equal(validation.validators.find((row) => row.validator === 'discovery-preservation')?.status, 'passed');
  const oracle = validation.validators.find((row) => row.validator === 'independent-differential');
  assert.equal(oracle?.status, 'passed');
  assert.equal(oracle.detail.outputDigest, materialized.outputHash);
  await filePublication(t, materialized, validation);
});

for (const fixture of manifest.fixtures) {
  test(`T016 tracked ${fixture.profile} metadata roundtrip retains parser discovery`, async (t) => {
    const bytes = new Uint8Array(fs.readFileSync(new URL(`../../../${fixture.path}`, import.meta.url)));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), fixture.sha256);
    const mutation = fixture.format === 'elf' ? { kind: 'elf-comment', tag: 'T016 compiler fixture' }
      : fixture.format === 'pe' ? { kind: 'pe-timestamp', timestamp: 0x65f6a245 }
        : { kind: 'macho-min-version', version: 0x000a0500 };
    const planned = createFormatSafeRebuildTransaction({ binaryId: `t016:${fixture.id}`, source: bytes,
      format: fixture.format, architecture: fixture.architecture, loaderVersion: 'hex-loader:openBinary:v1', mutation });
    const tx = createRebuildTransaction({ ...planned, requireIndependentOracle: false,
      additionalValidators: ['format-invariants'], requireDiscoveryPreservation: true,
      sourceLength: bytes.length, snapshotId: `t016:${fixture.id}:source` });
    const materialized = await materializeRebuildTransaction(tx, bytes);
    assert.equal(materialized.status, 'materialized', JSON.stringify(materialized));
    const validation = await validateRebuildTransaction(tx, materialized, validationOptions(bytes));
    assert.equal(validation.status, 'valid', JSON.stringify(validation));
    assert.notEqual(materialized.outputHash, tx.sourceHash);
    await filePublication(t, materialized, validation);
  });
}

for (const [name, change] of [
  ['artifact', () => ({ discoveryArtifact: sourceArtifact() })],
  ['binding', () => ({ discoveryBinding: discoveryArtifactForRebuild(sourceArtifact()) })],
  ['expected state binding', () => ({ expectedOriginalState: { ...transaction().expectedOriginalState,
    discovery: discoveryArtifactForRebuild(sourceArtifact()) } })],
  ['transaction impact', () => ({ impact: { discovery: true } })],
  ['operation impact', () => ({ operations: transaction().operations.map((operation) => ({ ...operation, impact: { discovery: true } })) })],
  ['explicit validator', () => ({ additionalValidators: ['discovery-preservation'] })],
]) {
  test(`T016 ${name} requires discovery despite caller false`, async () => {
    const { tx, materialized, validation } = await prepare({ requireDiscoveryPreservation: false, ...change() },
      { requireDiscoveryPreservation: false, loaderReparse: undefined });
    assert.equal(tx.discovery.required, true);
    assert.equal(materialized.discovery.contract, tx.discovery);
    assert.equal(validation.discovery.contract.required, true);
    assert.equal((await publishRebuildTransaction(materialized, validation, { requireDiscoveryPreservation: false })).reason,
      'rebuild-v2-canonical-publication-adapter-required');
  });
}

test('T016 forged and cloned artifact/binding cannot supply source authority', () => {
  const artifact = sourceArtifact();
  const binding = discoveryArtifactForRebuild(artifact);
  for (const discoveryBinding of [false, {}, { ...binding }, structuredClone(binding)]) {
    assert.throws(() => transaction({ requireDiscoveryPreservation: false, discoveryBinding }), /binding-unissued/);
  }
  for (const discoveryArtifact of [{ ...artifact }, structuredClone(artifact), { publication: { status: 'complete' } }]) {
    assert.throws(() => transaction({ discoveryArtifact }), /artifact-identity-invalid/);
  }
});

for (const field of ['binaryId', 'sourceHash', 'snapshotId', 'architectureId']) {
  test(`T016 supplied canonical binding ${field} mismatch is rejected`, () => {
    const binding = discoveryArtifactForRebuild(sourceArtifact({ [field]: `different:${field}` }));
    assert.throws(() => transaction({ discoveryBinding: binding }), new RegExp(`${field}-mismatch`));
  });
}

test('T016 caller function list and metadata complete do not replace actual source parse', async () => {
  const malformed = source.slice(); malformed[0] = 0;
  const tx = rawTransaction(malformed);
  const result = await materializeRebuildTransaction(tx, malformed, {
    image: openBinary(source), functions: openBinary(source).functions, metadata: { complete: true },
    discoveryArtifact: sourceArtifact(), complete: true,
  });
  assert.notEqual(result.status, 'materialized');
});

test('T016 actual source bytes and parsed architecture must match transaction identity', async () => {
  const wrongHash = transaction({ sourceHash: `bytes:${'0'.repeat(32)}`, expectedOriginalState: {} });
  assert.equal((await materializeRebuildTransaction(wrongHash, source)).reason, 'rebuild-v2-source-identity-mismatch');
  const wrongArch = transaction({ architecture: 'arm64' });
  assert.equal((await materializeRebuildTransaction(wrongArch, source)).reason, 'rebuild-v2-discovery-parser-identity-mismatch');
});

test('T016 canonical but invented source observations fail against the production parser', async () => {
  const image = openBinary(source);
  image.functionStarts = [{ address: 0x123456 }];
  const binding = discoveryArtifactForRebuild(sourceArtifact({}, image));
  const tx = transaction({ discoveryBinding: binding });
  assert.equal((await materializeRebuildTransaction(tx, source)).reason, 'discovery-reparse-ambiguity-lost');
});

test('T016 public false and rehashed stripped transaction cannot remove an issued obligation', async () => {
  const tx = transaction();
  const reissued = createRebuildTransaction({ ...tx, requireDiscoveryPreservation: false });
  assert.equal(reissued.discovery.required, true);
  const stripped = structuredClone(tx);
  delete stripped.discovery;
  stripped.requiredValidators = stripped.requiredValidators.filter((name) => name !== 'discovery-preservation');
  stripped.transactionId = null;
  stripped.transactionId = `rebuild-transaction:${stableDigest(stripped)}`;
  assert.equal((await materializeRebuildTransaction(stripped, source)).reason, 'rebuild-v2-transaction-identity-invalid');
});

test('T016 cloned/stripped validation and stale same-transaction receipts cannot publish', async () => {
  const { tx, materialized, validation } = await prepare();
  let promotions = 0;
  const options = { atomicPromote: () => { promotions += 1; throw new Error('must not promote'); } };
  assert.equal((await publishRebuildTransaction(materialized, { ...validation }, options)).reason, 'rebuild-v2-validation-unissued-or-stale');
  const again = await materializeRebuildTransaction(tx, source);
  assert.equal(again.outputIdentity, materialized.outputIdentity);
  assert.equal((await publishRebuildTransaction(again, validation, options)).reason, 'rebuild-v2-validation-unissued-or-stale');
  const strippedMaterialized = { ...materialized };
  const strippedValidation = structuredClone(validation);
  for (const value of [strippedMaterialized, strippedValidation]) {
    delete value.discovery;
    value.requiredValidators = value.requiredValidators.filter((name) => name !== 'discovery-preservation');
  }
  strippedValidation.validators = strippedValidation.validators.filter((item) => item.validator !== 'discovery-preservation');
  delete strippedValidation.validationId;
  strippedValidation.validationId = `rebuild-validation:${stableDigest(strippedValidation)}`;
  assert.equal((await publishRebuildTransaction(strippedMaterialized, strippedValidation, options)).reason, 'rebuild-v2-validation-unissued-or-stale');
  assert.equal(promotions, 0);
});

test('T016 writer and callback success cannot validate malformed output', async () => {
  const tx = transaction({ operations: [{ offset: 0, before: [source[0]], after: [0] }] });
  const materialized = await materializeRebuildTransaction(tx, source);
  assert.equal(materialized.status, 'materialized');
  const validation = await validateRebuildTransaction(tx, materialized, {
    original: source, loaderReparse: () => ({ ok: true, complete: true }),
    validators: { 'format-invariants': () => ({ ok: true }), 'discovery-preservation': () => ({ ok: true }) },
  });
  assert.notEqual(validation.status, 'valid');
  assert.ok(validation.failures.some((item) => item.validator === 'discovery-preservation'));
  assert.notEqual((await publishRebuildTransaction(materialized, validation)).status, 'published');
});

for (const [field, value] of [
  ['complete', 'partial'],
  ['complete', undefined],
  ['cancelled', 'no'],
  ['cancelled', undefined],
  ['partial', 'no'],
  ['partial', undefined],
]) {
  test(`T016 malformed discovery validator ${field} field cannot become valid`, async () => {
    const tx = transaction();
    const materialized = await materializeRebuildTransaction(tx, source);
    assert.equal(materialized.status, 'materialized');
    const validation = await validateRebuildTransaction(tx, materialized, {
      ...validationOptions(),
      loaderReparse: () => ({ ok: true, status: 'passed', [field]: value }),
    });
    assert.notEqual(validation.status, 'valid');
    assert.equal(validation.failures.find((item) => item.validator === 'loader-reparse')?.reason,
      'validator-incomplete');
  });
}

test('T016 explicit complete discovery validator fields retain a valid result', async () => {
  const tx = transaction();
  const materialized = await materializeRebuildTransaction(tx, source);
  assert.equal(materialized.status, 'materialized');
  const validation = await validateRebuildTransaction(tx, materialized, {
    ...validationOptions(),
    loaderReparse: () => ({ ok: true, status: 'passed', completeness: 'complete', complete: true, cancelled: false, partial: false }),
  });
  assert.equal(validation.status, 'valid', JSON.stringify(validation));
});

test('T016 independent output parser rejects a changed architecture', async () => {
  const tx = transaction({ operations: [{ offset: 18, before: [source[18], source[19]], after: [183, 0] }] });
  const m = await materializeRebuildTransaction(tx, source);
  assert.equal(m.status, 'materialized');
  const result = await validateRebuildTransaction(tx, m, { ...validationOptions(), loaderReparse: () => ({ ok: true }) });
  assert.equal(discoveryFailure(result), 'rebuild-v2-discovery-parser-identity-mismatch');
});

for (const [name, options] of [
  ['parser budget', { discoveryMetadataLimits: { records: 1 } }],
  ['discovery budget', { discoveryBudget: { maxCandidates: 1 } }],
  ['artifact budget', { discoveryArtifactBudget: { maxTotalEvidence: 1 } }],
]) {
  test(`T016 ${name} cannot become complete source or output proof`, async () => {
    const tx = transaction();
    assert.notEqual((await materializeRebuildTransaction(tx, source, options)).status, 'materialized');
    const m = await materializeRebuildTransaction(tx, source);
    const validation = await validateRebuildTransaction(tx, m, { ...validationOptions(), ...options });
    assert.notEqual(validation.status, 'valid');
  });
}

for (const [name, options] of [
  ['metadata limit string', { discoveryMetadataLimits: { records: 'not-a-number' } }],
  ['metadata limit array shape', { discoveryMetadataLimits: [] }],
  ['discovery budget undefined field', { discoveryBudget: { maxCandidates: undefined } }],
  ['discovery budget unknown field', { discoveryBudget: { unknown: 1 } }],
  ['artifact budget undefined field', { discoveryArtifactBudget: { maxTotalEvidence: undefined } }],
  ['artifact budget unknown field', { discoveryArtifactBudget: { unknown: 1 } }],
]) {
  test(`T016 malformed ${name} cannot become complete source or output proof`, async () => {
    const tx = transaction();
    const malformedMaterialized = await materializeRebuildTransaction(tx, source, options);
    assert.notEqual(malformedMaterialized.status, 'materialized');
    const materialized = await materializeRebuildTransaction(tx, source);
    assert.equal(materialized.status, 'materialized');
    const validation = await validateRebuildTransaction(tx, materialized, { ...validationOptions(), ...options });
    assert.notEqual(validation.status, 'valid');
  });
}

test('T016 conflicting issued discovery bindings cannot authorize one transaction', () => {
  const alternateImage = openBinary(source);
  alternateImage.functionStarts = [{ address: 0x123456 }];
  const explicitBinding = discoveryArtifactForRebuild(sourceArtifact());
  const expectedBinding = discoveryArtifactForRebuild(sourceArtifact({}, alternateImage));
  assert.notEqual(explicitBinding.digest, expectedBinding.digest);
  assert.throws(() => transaction({
    discoveryBinding: explicitBinding,
    expectedOriginalState: { sourceHash: digest(source), discovery: expectedBinding },
  }), /binding-mismatch/);
  assert.doesNotThrow(() => transaction({
    discoveryBinding: explicitBinding,
    expectedOriginalState: { sourceHash: digest(source), discovery: explicitBinding },
  }));
});

test('T016 partial parser output and unsupported transformations stay rejected', async () => {
  const truncated = source.slice(0, -1);
  assert.equal((await materializeRebuildTransaction(rawTransaction(truncated), truncated)).reason, 'rebuild-v2-discovery-parser-incomplete');
  const tx = transaction({ impact: { layoutMoving: true } });
  const m = await materializeRebuildTransaction(tx, source);
  const v = await validateRebuildTransaction(tx, m, { ...validationOptions(), validators: { layout: () => ({ ok: true }), 'format-invariants': validateFormatSafeMutation } });
  assert.equal(discoveryFailure(v), 'rebuild-v2-discovery-transform-unsupported');
});

function guardedPublication(materialized, validation, { stagedBytes = materialized.bytes.slice(), commit = () => {}, adapter, ...options } = {}) {
  const publicationAdapter = adapter ?? registerCanonicalRebuildPublicationAdapter((request) => request.authorizeCommit({
    stagedBytes, protocol: 'temp-then-atomic-rename', publicationIdentity: 't016:test-target', commit,
  }));
  return publishRebuildTransaction(materialized, validation, { publicationAdapter, ...options });
}

test('T016 wrong staged bytes cannot reach the guarded commit', async () => {
  const { materialized, validation } = await prepare();
  const raw = materialized.bytes.slice(); raw[0] ^= 1;
  let commits = 0;
  const result = await guardedPublication(materialized, validation, { stagedBytes: raw, commit: () => { commits += 1; } });
  assert.equal(result.reason, 'rebuild-v2-discovery-staged-bytes-mismatch');
  assert.equal(result.commitState, 'not-committed');
  assert.equal(commits, 0);
});

test('T016 unavailable discovery publication protocols remain unsupported', async () => {
  const { materialized, validation } = await prepare();
  let commits = 0;
  const adapter = registerCanonicalRebuildPublicationAdapter((request) => request.authorizeCommit({
    stagedBytes: materialized.bytes, protocol: 'transactional-store',
    publicationIdentity: 't016:unsupported-store', commit: () => { commits += 1; },
  }));
  const result = await guardedPublication(materialized, validation, { adapter });
  assert.equal(result.reason, 'rebuild-v2-publication-protocol-unsupported');
  assert.equal(result.commitState, 'not-committed');
  assert.equal(commits, 0);
});

for (const delta of [-1, 1, REBUILD_DISCOVERY_MAX_BYTES]) {
  test(`T016 staged length N${delta < 0 ? '' : '+'}${delta} is rejected before element access or commit`, async () => {
    const { materialized, validation } = await prepare();
    let elements = 0;
    const raw = new Array(materialized.outputLength + delta);
    Object.defineProperty(raw, '0', { get() { elements += 1; throw new Error('unbounded copy attempted'); } });
    let commits = 0;
    const result = await guardedPublication(materialized, validation, { stagedBytes: raw, commit: () => { commits += 1; } });
    assert.match(result.reason, /byte-(length-mismatch|budget-exceeded)/);
    assert.equal(elements, 0);
    assert.equal(commits, 0);
  });
}

test('T016 source bounds precede copying, and declared byte ceiling cannot be raised', async () => {
  const tx = transaction();
  for (const length of [source.length - 1, source.length + 1, 1_000_000_000]) {
    const bytes = new Array(length);
    Object.defineProperty(bytes, '0', { get() { throw new Error('source-copy-before-preflight'); } });
    assert.match((await materializeRebuildTransaction(tx, bytes)).reason, /byte-(length-mismatch|budget-exceeded)/);
    const m = await materializeRebuildTransaction(tx, source);
    assert.match((await validateRebuildTransaction(tx, m, { original: bytes })).reason, /byte-(length-mismatch|budget-exceeded)/);
  }
  assert.throws(() => transaction({ sourceLength: REBUILD_DISCOVERY_MAX_BYTES + 1 }), /byte-budget-exceeded/);
});

test('T016 staged proof must contain readable bytes, not a verified boolean or hash', async () => {
  for (const stagedBytes of [true, 'bytes:forged', { verified: true }]) {
    const { materialized, validation } = await prepare();
    assert.equal((await guardedPublication(materialized, validation, { stagedBytes })).reason,
      'rebuild-v2-discovery-bytes-required');
  }
});

test('T016 mutated materialization cannot publish', async () => {
  const { materialized, validation } = await prepare();
  materialized.bytes[0] ^= 1;
  assert.equal((await guardedPublication(materialized, validation)).reason, 'rebuild-v2-discovery-output-tampered');
});

test('T016 cancelled and expired stages never materialize, validate or publish successfully', async () => {
  const { tx, materialized, validation } = await prepare();
  const controller = new AbortController(); controller.abort();
  for (const options of [{ signal: controller.signal }, { deadline: Date.now() - 1 }]) {
    assert.notEqual((await materializeRebuildTransaction(tx, source, options)).status, 'materialized');
    assert.notEqual((await validateRebuildTransaction(tx, materialized, { ...validationOptions(), ...options })).status, 'valid');
    let commits = 0;
    const result = await guardedPublication(materialized, validation, { ...options, commit: () => { commits += 1; } });
    assert.notEqual(result.status, 'published');
    assert.equal(commits, 0);
  }
});

test('T016 cancellation revokes a canonical delayed attempt before commit', async (t) => {
  const { materialized, validation } = await prepare();
  const controller = new AbortController();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-t016-cancel-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'committed.bin');
  let lateAttempt;
  let commits = 0;
  const adapter = registerCanonicalRebuildPublicationAdapter((request) => {
    lateAttempt = () => request.authorizeCommit({ stagedBytes: materialized.bytes,
      protocol: 'temp-then-atomic-rename', publicationIdentity: target, commit: () => {
        commits += 1;
        fs.writeFileSync(target, materialized.bytes);
      } });
    controller.abort();
  });
  const result = await guardedPublication(materialized, validation, { adapter, signal: controller.signal });
  assert.equal(result.status, 'cancelled');
  assert.throws(lateAttempt, /capability-revoked/);
  assert.equal(commits, 0);
  assert.equal(fs.existsSync(target), false);
});

test('T016 deadline is rechecked after synchronous staging and before commit', async (t) => {
  const { materialized, validation } = await prepare();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-t016-deadline-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'committed.bin');
  let commits = 0;
  const adapter = registerCanonicalRebuildPublicationAdapter((request) => {
    while (Date.now() < request.deadline) { /* deterministic deadline crossing */ }
    request.authorizeCommit({ stagedBytes: materialized.bytes, protocol: 'temp-then-atomic-rename',
      publicationIdentity: target, commit: () => {
        commits += 1;
        fs.writeFileSync(target, materialized.bytes);
      } });
  });
  const result = await guardedPublication(materialized, validation, { adapter, deadline: Date.now() + 25 });
  assert.equal(result.reason, 'rebuild-v2-discovery-deadline-exceeded');
  assert.equal(commits, 0);
  assert.equal(fs.existsSync(target), false);
});

test('T016 commit wins when cancellation follows the synchronous linearization point', async () => {
  const { materialized, validation } = await prepare();
  const controller = new AbortController();
  let commits = 0;
  const result = await guardedPublication(materialized, validation, { signal: controller.signal, commit: () => {
    commits += 1;
    controller.abort();
  } });
  assert.equal(result.status, 'published');
  assert.equal(commits, 1);
});

test('T016 commit-wins consumes a rejecting adapter thenable', async () => {
  const { materialized, validation } = await prepare();
  let consumed = 0;
  const rejection = new Error('adapter-cleanup-failed-after-commit');
  const adapter = registerCanonicalRebuildPublicationAdapter((request) => {
    request.authorizeCommit({ stagedBytes: materialized.bytes, protocol: 'temp-then-atomic-rename',
      publicationIdentity: 't016:thenable', commit: () => {} });
    return { then(_resolve, reject) { consumed += 1; reject(rejection); } };
  });
  const result = await guardedPublication(materialized, validation, { adapter });
  assert.equal(result.status, 'published');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(consumed, 1);
});

test('T016 commit-wins handles an adapter Promise rejection', async (t) => {
  const { materialized, validation } = await prepare();
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.prependListener('unhandledRejection', onUnhandled);
  t.after(() => process.removeListener('unhandledRejection', onUnhandled));
  const adapter = registerCanonicalRebuildPublicationAdapter((request) => {
    request.authorizeCommit({ stagedBytes: materialized.bytes, protocol: 'temp-then-atomic-rename',
      publicationIdentity: 't016:rejected-promise', commit: () => {} });
    return Promise.reject(new Error('adapter-cleanup-failed-after-commit'));
  });
  assert.equal((await guardedPublication(materialized, validation, { adapter })).status, 'published');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
});

test('T016 one issued validation authorizes exactly one publication attempt', async () => {
  const { materialized, validation } = await prepare();
  let retry;
  const adapter = registerCanonicalRebuildPublicationAdapter((request) => {
    retry = guardedPublication(materialized, validation);
    request.authorizeCommit({ stagedBytes: materialized.bytes, protocol: 'temp-then-atomic-rename',
      publicationIdentity: 't016:first', commit: () => {} });
  });
  assert.equal((await guardedPublication(materialized, validation, { adapter })).status, 'published');
  assert.equal((await retry).reason, 'rebuild-v2-validation-unissued-or-stale');
  assert.equal((await guardedPublication(materialized, validation)).reason, 'rebuild-v2-validation-unissued-or-stale');
});

for (const status of ['cancelled', 'deadline', 'resource-limit', 'partial', 'unsupported']) {
  test(`T016 external validator ok:true with ${status} is not green`, async () => {
    const tx = transaction();
    const m = await materializeRebuildTransaction(tx, source);
    const v = await validateRebuildTransaction(tx, m, { ...validationOptions(), loaderReparse: () => ({ ok: true, status }) });
    assert.notEqual(v.status, 'valid');
    assert.equal(v.failures.find((item) => item.validator === 'loader-reparse').reason, 'validator-incomplete');
  });
}

test('T016 external callback cannot mutate the bytes that are being attested', async () => {
  const tx = transaction();
  const m = await materializeRebuildTransaction(tx, source);
  const v = await validateRebuildTransaction(tx, m, { ...validationOptions(), loaderReparse: () => { m.bytes[0] ^= 1; return { ok: true }; } });
  assert.equal(v.reason, 'rebuild-v2-discovery-output-tampered');
});

test('T016 removing loader entrypoint evidence from real output is caught before transform permission', async () => {
  const tx = transaction({ operations: [{ offset: 24, before: Array.from(source.subarray(24, 32)), after: Array(8).fill(0) }] });
  const m = await materializeRebuildTransaction(tx, source);
  assert.equal(m.status, 'materialized');
  assert.doesNotThrow(() => openBinary(m.bytes));
  const v = await validateRebuildTransaction(tx, m, { ...validationOptions(), loaderReparse: () => ({ ok: true }) });
  assert.equal(discoveryFailure(v), 'discovery-reparse-ambiguity-lost');
});

test('T016 a caller claiming unsigned cannot authorize a signed PE input', async () => {
  const fixture = manifest.fixtures.find((item) => item.profile === 'pe:pe32+');
  const bytes = new Uint8Array(fs.readFileSync(new URL(`../../../${fixture.path}`, import.meta.url)));
  const planned = createFormatSafeRebuildTransaction({ binaryId: 't016:signed-pe-negative', source: bytes,
    format: 'pe', architecture: 'x86_64', loaderVersion: 'hex-loader:openBinary:v1',
    mutation: { kind: 'pe-timestamp', timestamp: 0x65f6a245 } });
  const view = new DataView(bytes.buffer);
  const certificateDirectory = view.getUint32(0x3c, true) + 24 + 112 + 4 * 8;
  view.setUint32(certificateDirectory, bytes.length - 8, true);
  view.setUint32(certificateDirectory + 4, 8, true);
  const sourceHash = digest(bytes);
  const tx = createRebuildTransaction({ ...planned, sourceHash,
    expectedOriginalState: { sourceHash, formatSafe: planned.expectedOriginalState.formatSafe },
    requireIndependentOracle: false, requireDiscoveryPreservation: true,
    sourceLength: bytes.length, snapshotId: 't016:signed-pe-negative' });
  const m = await materializeRebuildTransaction(tx, bytes);
  assert.equal(m.status, 'materialized');
  const v = await validateRebuildTransaction(tx, m, { original: bytes });
  assert.equal(discoveryFailure(v), 'rebuild-v2-discovery-signed-input-unsupported');
});

test('T016 abort before adapter invocation prevents commit side effects', async () => {
  const { materialized, validation } = await prepare();
  const controller = new AbortController();
  controller.abort();
  let commits = 0;
  const result = await guardedPublication(materialized, validation, { signal: controller.signal,
    commit: () => { commits += 1; } });
  assert.equal(result.status, 'cancelled');
  assert.equal(commits, 0);
});
