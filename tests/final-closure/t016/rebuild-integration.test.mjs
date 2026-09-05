import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { stableDigest } from '../../../js/core/identity/index.js';
import { functionCandidates, discoveryArtifactForRebuild } from '../../../js/analysis/index.js';
import { REBUILD_DISCOVERY_MAX_BYTES } from '../../../js/rebuild/transaction-v2.js';
import { openBinary } from '../../../js/binary/index.js';
import { createFormatSafeRebuildTransaction, validateFormatSafeMutation } from '../../../js/rebuild/format-safe.js';
import { createRebuildTransaction, materializeRebuildTransaction, validateRebuildTransaction, publishRebuildTransaction } from '../../../js/rebuild/transaction-v2.js';

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
  assert.equal(publication.reason, 'rebuild-v2-discovery-readback-required');
  assert.equal(promotions, 0, 'missing readback must be detected before any commit side effect');
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

// Positive proof uses tracked compiler-produced bytes, a real temporary file,
// atomic rename and bounded reads of that committed file, not a receipt cache.
async function filePublication(t, materialized, validation) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-t016-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'committed.bin');
  let reads = 0;
  const publication = await publishRebuildTransaction(materialized, validation, {
    atomicPromote: async (bytes, { materialized: m }) => {
      const temporary = path.join(directory, 'candidate.tmp');
      fs.writeFileSync(temporary, bytes);
      fs.renameSync(temporary, target);
      return { ...receipt(m, target), protocol: 'temp-then-atomic-rename' };
    },
    readCommitted: async (request) => {
      assert.equal(request.publicationIdentity, target);
      assert.equal(request.expectedLength, materialized.outputLength);
      assert.ok(request.expectedLength <= request.maxBytes);
      return {
        get size() { return BigInt(fs.statSync(target).size); },
        read: async (offset, length, limits) => {
          reads += 1;
          assert.equal(offset, 0n);
          assert.equal(length, request.expectedLength);
          assert.equal(limits.maxBytes, REBUILD_DISCOVERY_MAX_BYTES);
          const fd = fs.openSync(target, 'r');
          try {
            assert.equal(fs.fstatSync(fd).size, length);
            const bytes = new Uint8Array(length);
            const count = fs.readSync(fd, bytes, 0, length, 0);
            assert.equal(fs.fstatSync(fd).size, length);
            return bytes.subarray(0, count);
          } finally { fs.closeSync(fd); }
        },
      };
    },
  });
  assert.equal(publication.status, 'published', JSON.stringify(publication));
  assert.equal(publication.discovery.verified, true);
  assert.equal(reads, 1);
  assert.deepEqual(new Uint8Array(fs.readFileSync(target)), materialized.bytes);
  return publication;
}

test('T016 real ELF: source parse -> changed bytes -> fresh discovery -> rename -> committed readback', async (t) => {
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

const manifest = JSON.parse(fs.readFileSync(new URL('../../phase12/rebuild/fixtures/manifest.json', import.meta.url), 'utf8'));
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
      'rebuild-v2-discovery-readback-required');
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

test('T016 partial parser output and unsupported transformations stay rejected', async () => {
  const truncated = source.slice(0, -1);
  assert.equal((await materializeRebuildTransaction(rawTransaction(truncated), truncated)).reason, 'rebuild-v2-discovery-parser-incomplete');
  const tx = transaction({ impact: { layoutMoving: true } });
  const m = await materializeRebuildTransaction(tx, source);
  const v = await validateRebuildTransaction(tx, m, { ...validationOptions(), validators: { layout: () => ({ ok: true }), 'format-invariants': validateFormatSafeMutation } });
  assert.equal(discoveryFailure(v), 'rebuild-v2-discovery-transform-unsupported');
});

function memoryPublication(materialized, validation, { size = materialized.outputLength, raw = materialized.bytes.slice(), readCommitted, ...options } = {}) {
  return publishRebuildTransaction(materialized, validation, {
    atomicPromote: async (_bytes, { materialized: m }) => receipt(m),
    readCommitted: readCommitted ?? (async () => ({ size, read: async () => raw })), ...options,
  });
}

test('T016 different committed bytes cannot publish even with matching receipt identities', async () => {
  const { materialized, validation } = await prepare();
  const raw = materialized.bytes.slice(); raw[0] ^= 1;
  const result = await memoryPublication(materialized, validation, { raw });
  assert.equal(result.reason, 'rebuild-v2-discovery-committed-bytes-mismatch');
  assert.equal(result.commitState, 'unverified');
});

for (const delta of [-1, 1, REBUILD_DISCOVERY_MAX_BYTES]) {
  test(`T016 committed stat length N${delta < 0 ? '' : '+'}${delta} is rejected before read`, async () => {
    const { materialized, validation } = await prepare();
    let reads = 0;
    const result = await memoryPublication(materialized, validation, {
      readCommitted: async () => ({ size: materialized.outputLength + delta,
        get read() { reads += 1; throw new Error('unbounded read attempted'); } }),
    });
    assert.match(result.reason, /byte-(length-mismatch|budget-exceeded)/);
    assert.equal(reads, 0);
  });
  test(`T016 returned length N${delta < 0 ? '' : '+'}${delta} is rejected before element access/copy`, async () => {
    const { materialized, validation } = await prepare();
    let elements = 0;
    const raw = new Array(materialized.outputLength + delta);
    Object.defineProperty(raw, '0', { get() { elements += 1; throw new Error('unbounded copy attempted'); } });
    const result = await memoryPublication(materialized, validation, { raw });
    assert.match(result.reason, /byte-(length-mismatch|budget-exceeded)/);
    assert.equal(elements, 0);
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

test('T016 readback must be readable bytes, not a verified boolean or a hash string', async () => {
  const { materialized, validation } = await prepare();
  for (const raw of [true, materialized.outputHash, { verified: true, outputHash: materialized.outputHash }]) {
    assert.equal((await memoryPublication(materialized, validation, { raw })).reason, 'rebuild-v2-discovery-bytes-required');
  }
  assert.equal((await memoryPublication(materialized, validation, { readCommitted: async () => ({ size: materialized.outputLength, verified: true }) })).reason,
    'rebuild-v2-discovery-readback-unreadable');
});

test('T016 changed size during readback and mutated materialization cannot publish', async () => {
  const { materialized, validation } = await prepare();
  let read = false;
  const result = await memoryPublication(materialized, validation, { readCommitted: async () => ({
    get size() { return materialized.outputLength + (read ? 1 : 0); },
    read: async () => { read = true; return materialized.bytes.slice(); },
  }) });
  assert.equal(result.reason, 'rebuild-v2-discovery-byte-length-mismatch');
  materialized.bytes[0] ^= 1;
  assert.equal((await memoryPublication(materialized, validation)).reason, 'rebuild-v2-discovery-output-tampered');
});

test('T016 cancelled and expired stages never materialize, validate or publish successfully', async () => {
  const { tx, materialized, validation } = await prepare();
  const controller = new AbortController(); controller.abort();
  for (const options of [{ signal: controller.signal }, { deadline: Date.now() - 1 }]) {
    assert.notEqual((await materializeRebuildTransaction(tx, source, options)).status, 'materialized');
    assert.notEqual((await validateRebuildTransaction(tx, materialized, { ...validationOptions(), ...options })).status, 'valid');
    let commits = 0;
    const result = await memoryPublication(materialized, validation, { ...options, atomicPromote: () => { commits += 1; } });
    assert.notEqual(result.status, 'published');
    assert.equal(commits, 0);
  }
});

for (const stage of ['promote', 'open', 'read']) {
  test(`T016 cancellation interrupts a pending ${stage} without success`, async () => {
    const { materialized, validation } = await prepare();
    const controller = new AbortController();
    const pending = () => { setImmediate(() => controller.abort()); return new Promise(() => {}); };
    const result = await memoryPublication(materialized, validation, { signal: controller.signal,
      ...(stage === 'promote' ? { atomicPromote: pending } : {}),
      ...(stage === 'open' ? { readCommitted: pending } : {}),
      ...(stage === 'read' ? { readCommitted: async () => ({ size: materialized.outputLength, read: pending }) } : {}),
    });
    assert.equal(result.status, 'cancelled');
    assert.equal(result.reason, 'rebuild-v2-discovery-cancelled');
  });
}

test('T016 readback deadline also bounds an adapter that never resolves', async () => {
  const { materialized, validation } = await prepare();
  const result = await memoryPublication(materialized, validation, { deadline: Date.now() + 100,
    readCommitted: async () => ({ size: materialized.outputLength, read: () => new Promise(() => {}) }) });
  assert.equal(result.reason, 'rebuild-v2-discovery-deadline-exceeded');
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

test('T016 abort before the deferred adapter invocation prevents commit side effects', async () => {
  const { materialized, validation } = await prepare();
  const controller = new AbortController();
  let promotions = 0;
  const pending = memoryPublication(materialized, validation, { signal: controller.signal,
    atomicPromote: () => { promotions += 1; return receipt(materialized); } });
  controller.abort();
  assert.equal((await pending).status, 'cancelled');
  assert.equal(promotions, 0);
});
