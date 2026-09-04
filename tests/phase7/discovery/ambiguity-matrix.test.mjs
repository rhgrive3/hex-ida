import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { makeElf64Fixture, makeMachO64Fixture, makePe64Fixture } from '../../universal-binary.mjs';

import { createHexToolRegistry } from '../../../js/ai/tools/index.js';
import { openBinary } from '../../../js/binary/index.js';
import { functionCandidates } from '../../../js/analysis/index.js';
import { stableDigest } from '../../../js/core/identity/index.js';
import {
  createDiscoveryArtifact,
  DISCOVERY_ARTIFACT_DEFAULT_BUDGET,
  normalizeDiscoveryArtifactBudget,
  discoveryArtifactForRebuild,
  verifyDiscoveryReparse,
} from '../../../js/analysis/discovery/artifact.js';
import { createDiscoveryEvidence, createFunctionCandidate } from '../../../js/analysis/discovery/candidates.js';
import {
  canonicalTypedDigest,
  canonicalTypedString,
  canonicalTypedValue,
} from '../../../js/analysis/discovery/canonical-value.js';
import { DiscoveryProducerRegistry, fuseFunctionCandidates } from '../../../js/analysis/discovery/fusion.js';
import {
  createRebuildTransaction,
  deriveCanonicalDiscoveryArtifact,
  materializeRebuildTransaction,
  publishRebuildTransaction,
  validateRebuildTransaction,
} from '../../../js/rebuild/transaction-v2.js';

const SOURCE_BYTES = Uint8Array.from([1, 2, 3, 4]);
const SOURCE_HASH = `bytes:${stableDigest(Array.from(SOURCE_BYTES))}`;
const BINDING = Object.freeze({
  binaryId: 'bin-x03-matrix',
  sourceHash: SOURCE_HASH,
  snapshotId: 'snapshot-x03-1',
  architectureId: 'arm64',
});

function matrixInput(reverse = false) {
  const functions = [
    { address: 0x1000, source: 'function_starts', name: 'outer', sizeBytes: 0x100 },
    { address: 0x1080, source: 'function_starts', name: 'inner', sizeBytes: 0x40 },
    { address: 0x1100, source: 'function_starts', name: 'adjacent', sizeBytes: 0x20 },
  ];
  const relocationTargets = [{
    id: 'reloc.literal.1',
    address: 0x1060,
    sourceAddress: 0x1200,
    symbolicExpression: { kind: 'symbol-plus-addend', symbol: 'payload', addend: 8 },
  }];
  const vtableEntries = [{ address: 0x1070 }];
  const jumpTableTargets = [{ address: 0x1090, tableAddress: 0x1300, tableId: 'jt.1' }];
  const byteIntervals = [
    { start: 0x1040, end: 0x1050, kind: 'data', producerId: 'discovery.loader', producerVersion: '1', evidenceIds: ['section:mixed'] },
    { start: 0x1050, end: 0x1060, kind: 'padding', producerId: 'discovery.loader', producerVersion: '1', evidenceIds: ['section:padding'] },
    { start: 0x1200, end: 0x1210, kind: 'unsupported', producerId: 'discovery.loader', producerVersion: '1', evidenceIds: ['section:unknown'] },
  ];
  if (reverse) {
    functions.reverse();
    relocationTargets.reverse();
    vtableEntries.reverse();
    jumpTableTargets.reverse();
    byteIntervals.reverse();
  }
  return { image: {
    functions,
    symbols: [{ address: 0x1000, name: 'outer', isFunction: true }],
    relocationTargets,
    vtableEntries,
    jumpTableTargets,
    byteIntervals,
  } };
}

function runMatrix(reverse = false, options = {}) {
  return functionCandidates({ input: matrixInput(reverse), ...BINDING, ...options });
}

function overlappingElfFixture() {
  const bytes = makeElf64Fixture();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Turn the existing undefined `puts` symbol into a second, canonically parsed
  // STT_FUNC whose range overlaps `myfunc` at 0x401000..0x401010.
  view.setUint16(0x178 + 6, 1, true);
  view.setBigUint64(0x178 + 8, 0x401008n, true);
  view.setBigUint64(0x178 + 16, 8n, true);
  return bytes;
}

test('X-03 positive/adversarial: one artifact retains overlapping functions, code/data, references, and producer provenance', () => {
  const result = runMatrix();
  assert.equal(result.status.completeness, 'complete');
  assert.equal(result.artifact.publication.status, 'complete');
  assert.deepEqual(result.artifact.binding, BINDING);
  assert.ok(result.artifact.producerRuns.every((run) => run.id && run.version && run.completeness === 'complete'));
  assert.ok(result.artifact.collisionSets.some((item) => item.kind === 'function-overlap'));
  assert.ok(result.artifact.collisionSets.some((item) => item.kind === 'code-data'));
  assert.ok(result.artifact.collisionSets.some((item) => item.kind === 'code-data-reference'));
  assert.ok(result.artifact.intervalClaims.some((item) => item.kind === 'data'));
  assert.ok(result.artifact.intervalClaims.some((item) => item.kind === 'padding'));
  assert.ok(result.artifact.intervalClaims.some((item) => item.kind === 'unsupported'));

  const relocation = result.artifact.references.find((item) => item.relocationId === 'reloc.literal.1');
  assert.deepEqual(
    relocation.symbolicExpression,
    canonicalTypedValue({ addend: 8, kind: 'symbol-plus-addend', symbol: 'payload' }),
  );
  assert.equal(relocation.referenceAddress, '4608');
  assert.ok(relocation.producerId);
  assert.ok(relocation.producerVersion);
  assert.ok(result.artifact.references.some((item) => item.kind === 'jump-table-reference'));
  assert.ok(result.artifact.references.some((item) => item.kind === 'data-reference'));

  const outer = result.candidates.find((item) => item.start === '4096');
  const inner = result.candidates.find((item) => item.start === '4224');
  assert.equal(outer.extentState, 'unknown');
  assert.equal(inner.extentState, 'unknown');
  assert.equal(outer.startState, 'exact');
  assert.ok(result.artifact.functionCandidates.find((item) => item.start === outer.start).collisionIds.length > 0);
});

test('X-03 negative: references and ranks never mint exact function truth', () => {
  const result = runMatrix();
  for (const start of ['4192', '4208', '4240']) {
    const candidate = result.candidates.find((item) => item.start === start);
    assert.ok(candidate, `reference candidate ${start} survives`);
    assert.equal(candidate.startState, 'heuristic');
  }
  const probable = fuseFunctionCandidates([
    createDiscoveryEvidence({ kind: 'symbol-table', start: 0x2000, producerId: 'symbols' }),
    createDiscoveryEvidence({ kind: 'direct-call-target', start: 0x2000, producerId: 'calls' }),
  ]);
  assert.equal(probable.candidates[0].startState, 'probable');
  assert.notEqual(probable.candidates[0].startState, 'exact');
});

test('X-03 boundary: adjacent function ranges do not collide', () => {
  const evidence = [
    createDiscoveryEvidence({ kind: 'loader-function-start', start: 0x3000, producerId: 'a', regions: [{ start: 0x3000, end: 0x3040 }] }),
    createDiscoveryEvidence({ kind: 'loader-function-start', start: 0x3040, producerId: 'b', regions: [{ start: 0x3040, end: 0x3080 }] }),
  ];
  const result = fuseFunctionCandidates(evidence, { ...BINDING });
  assert.equal(result.artifact.collisionSets.length, 0);
  assert.ok(result.candidates.every((candidate) => candidate.extentState === 'exact'));
});

test('X-03 contained start-only candidates remain collision-visible to every consumer', async () => {
  const result = functionCandidates({
    input: { image: { functions: [
      { address: 0x6000, source: 'function_starts', name: 'outer-only-extent', sizeBytes: 0x100 },
      { address: 0x6080, source: 'function_starts', name: 'inner-start-only' },
    ] } },
    ...BINDING,
  });
  const contained = result.artifact.collisionSets.find((item) => item.kind === 'function-contained-start');
  assert.ok(contained);
  assert.equal(contained.at, '24704');
  for (const start of ['24576', '24704']) {
    assert.ok(result.artifact.functionCandidates.find((item) => item.start === start).collisionIds.includes(contained.collisionId));
  }
  const registry = createHexToolRegistry({
    discoveryArtifact: result.artifact,
    searchFunctions: async () => ({
      results: [{ addr: 0x6000n }, { addr: 0x6080n }], total: 2, complete: true,
    }),
  });
  const rows = (await registry.execute('search_functions', { query: 'function', limit: 10 }, { scope: 'binary' })).result.results;
  assert.ok(rows.every((row) => row.discovery.collisionIds.includes(contained.collisionId)));
  assert.ok(discoveryArtifactForRebuild(result.artifact, BINDING).collisionSets.some(
    (item) => item.collisionId === contained.collisionId,
  ));
});

test('X-03 partial-only unwind ranges never claim an exact or publishable extent', () => {
  const result = functionCandidates({
    input: { image: { unwindEntries: [{
      primary: false, ownerStart: 0x1800, start: 0x1810, end: 0x1820,
    }] } },
    ...BINDING,
  });
  assert.equal(result.candidates[0].extentState, 'heuristic');
  assert.notEqual(result.candidates[0].extentState, 'exact');
  assert.equal(result.artifact.publication.status, 'withheld');
  assert.equal(result.artifact.publication.reason, 'extent-coverage-incomplete:6144');
});

test('X-03 determinism/regression: candidate, collision, and artifact identity are permutation-stable', () => {
  const forward = runMatrix(false);
  const reverse = runMatrix(true);
  assert.deepEqual(forward, reverse);
  assert.equal(forward.artifact.artifactId, reverse.artifact.artifactId);
});

test('X-03 typed evidence order and symbolic identity are total, framed, and JSON-safe', () => {
  const hole = [];
  hole.length = 1;
  const values = [1n, '1', -0, 0, hole, [null]];
  assert.equal(new Set(values.map((value) => canonicalTypedDigest(value))).size, values.length);
  for (const value of values) {
    const framed = canonicalTypedValue(value);
    assert.deepEqual(JSON.parse(JSON.stringify(framed)), framed);
  }
  assert.notEqual(canonicalTypedString(1n), canonicalTypedString('1'));
  assert.notEqual(canonicalTypedString(-0), canonicalTypedString(0));
  assert.notEqual(canonicalTypedString(hole), canonicalTypedString([null]));

  const evidence = [
    createDiscoveryEvidence({
      kind: 'symbol-table', start: 0x7100, producerId: 'typed', producerVersion: '1',
      confidence: 0.5, symbolicExpression: { value: 1n }, evidenceIds: ['typed:a'],
    }),
    createDiscoveryEvidence({
      kind: 'symbol-table', start: 0x7100, producerId: 'typed', producerVersion: '1',
      confidence: '0.5', symbolicExpression: { value: '1' }, evidenceIds: ['typed:b'],
    }),
  ];
  const forward = fuseFunctionCandidates(evidence, BINDING);
  const reverse = fuseFunctionCandidates([...evidence].reverse(), BINDING);
  assert.deepEqual(forward, reverse, 'every retained field participates in total evidence ordering');
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(forward.artifact)));
  const reparsedEvidence = createDiscoveryEvidence(JSON.parse(JSON.stringify(evidence[0])));
  assert.deepEqual(reparsedEvidence, evidence[0]);
  assert.equal(canonicalTypedDigest(reparsedEvidence.symbolicExpression), canonicalTypedDigest(evidence[0].symbolicExpression));
});

test('X-03 malformed inputs fail before artifact authority is created', () => {
  assert.throws(() => fuseFunctionCandidates({}), /discovery-fusion-evidence-invalid/);
  assert.throws(() => createDiscoveryArtifact({ evidence: [], candidates: [], status: {}, byteIntervals: 'data' }), /byte-intervals-invalid/);
  assert.throws(() => createDiscoveryArtifact({
    evidence: [], candidates: [], status: runMatrix().status,
    byteIntervals: [{ start: 1, end: 1, kind: 'data' }],
  }), /byte-interval-empty/);
  const cyclic = { kind: 'symbol' };
  cyclic.self = cyclic;
  assert.throws(() => createDiscoveryEvidence({ kind: 'relocation-target', start: 1, symbolicExpression: cyclic }), /typed-value-invalid/);

  const registry = new DiscoveryProducerRegistry();
  registry.register({ id: 'bad', produce: () => ({ evidence: 'not-an-array' }) });
  assert.throws(() => registry.collect({}, 'arm64'), /producer-result-invalid/);
});

test('X-03 interval identities are canonical, unique, and permutation-total', () => {
  const complete = runMatrix();
  const base = {
    evidence: [], candidates: [], status: complete.status, binding: BINDING,
    producerRuns: [{ id: 'intervals', version: '1', completeness: 'complete', evidenceCount: 0, intervalCount: 1 }],
  };
  assert.throws(() => createDiscoveryArtifact({
    ...base,
    byteIntervals: [{ intervalId: 'caller:exact', start: 1, end: 2, kind: 'data', producerId: 'intervals', producerVersion: '1' }],
  }), /interval-id-caller-controlled/);
  assert.throws(() => createDiscoveryArtifact({
    ...base,
    producerRuns: [{ ...base.producerRuns[0], intervalCount: 2 }],
    byteIntervals: [
      { start: 1, end: 2, kind: 'data', producerId: 'intervals', producerVersion: '1' },
      { start: 1, end: 2, kind: 'data', producerId: 'intervals', producerVersion: '1' },
    ],
  }), /interval-id-duplicate/);
  const claims = [
    { start: 1, end: 2, kind: 'data', evidenceIds: ['b'], producerId: 'intervals', producerVersion: '1' },
    { start: 1, end: 2, kind: 'data', evidenceIds: ['a'], producerId: 'intervals', producerVersion: '1' },
  ];
  const orderedBase = {
    ...base,
    producerRuns: [{ ...base.producerRuns[0], intervalCount: 2 }],
  };
  assert.deepEqual(
    createDiscoveryArtifact({ ...orderedBase, byteIntervals: claims }),
    createDiscoveryArtifact({ ...orderedBase, byteIntervals: [...claims].reverse() }),
  );
});

test('X-03 evidence snapshot rejects accessors, proxy coercion, and structured scalar facts', () => {
  for (const field of ['architectureId', 'name', 'confidence']) {
    assert.throws(
      () => createDiscoveryEvidence({ kind: 'symbol-table', start: 1, [field]: { toString: () => 'forged' } }),
      new RegExp(`invalid-${field === 'architectureId' ? 'architecture-id' : field}`),
    );
  }
  let reads = 0;
  const accessor = { kind: 'symbol-table', start: 1 };
  Object.defineProperty(accessor, 'name', { get() { reads += 1; return 'forged'; } });
  assert.throws(() => createDiscoveryEvidence(accessor), /name-accessor-invalid/);
  assert.equal(reads, 0);

  const candidate = {};
  Object.defineProperty(candidate, 'start', { get() { reads += 1; return 1; } });
  assert.throws(() => createFunctionCandidate(candidate), /candidate-start-accessor-invalid/);
  assert.equal(reads, 0);
  for (const field of ['name', 'architectureId']) {
    assert.throws(
      () => createFunctionCandidate({ start: 1, [field]: { toString: () => 'forged' } }),
      new RegExp(`candidate-invalid-${field === 'architectureId' ? 'architecture-id' : field}`),
    );
  }

  const nested = {};
  Object.defineProperty(nested, 'value', { get() { reads += 1; return 1n; }, enumerable: true });
  assert.throws(
    () => createDiscoveryEvidence({ kind: 'relocation-target', start: 1, symbolicExpression: nested }),
    /typed-value-accessor-invalid/,
  );
  assert.equal(reads, 0);

  const proxy = new Proxy({}, { get() { reads += 1; return 'loader-function-start'; } });
  assert.throws(() => createDiscoveryEvidence(proxy), /unknown-kind/);
  assert.equal(reads, 0);

  const options = { ...BINDING };
  Object.defineProperty(options, 'budget', { get() { reads += 1; return { maxCandidates: 1 }; } });
  assert.throws(() => fuseFunctionCandidates([], options), /fusion-budget-invalid/);
  assert.equal(reads, 0);

  const producerWithAccessor = {};
  Object.defineProperty(producerWithAccessor, 'id', { get() { reads += 1; return 'forged'; } });
  Object.defineProperty(producerWithAccessor, 'produce', { value: () => [] });
  assert.throws(() => new DiscoveryProducerRegistry().register(producerWithAccessor), /producer-id-required/);
  assert.equal(reads, 0);

  const evidenceArray = [];
  evidenceArray.length = 1;
  Object.defineProperty(evidenceArray, '0', { get() { reads += 1; return { kind: 'prologue-candidate', start: 1 }; } });
  const registry = new DiscoveryProducerRegistry();
  registry.register({ id: 'external.accessor', produce: () => evidenceArray });
  assert.throws(() => registry.collect({}, 'arm64'), /evidence-descriptor-invalid/);
  assert.equal(reads, 0);

  const statusRegistry = new DiscoveryProducerRegistry();
  const status = {};
  Object.defineProperty(status, 'completeness', { get() { reads += 1; return 'complete'; } });
  statusRegistry.register({ id: 'external.status-accessor', produce: () => ({ evidence: [], status }) });
  assert.throws(() => statusRegistry.collect({}, 'arm64'), /producer-completeness-invalid/);
  assert.equal(reads, 0);
});

test('X-03 public custom producers cannot claim authoritative evidence kinds', () => {
  assert.throws(() => functionCandidates({
    input: { image: {} },
    producers: [{
      id: 'external.authority-forgery', version: '1',
      produce: () => [{ kind: 'loader-function-start', start: 0x7200 }],
    }],
    ...BINDING,
  }), /authoritative-evidence-untrusted/);

  const claimedRun = fuseFunctionCandidates([
    createDiscoveryEvidence({
      kind: 'loader-function-start', start: 0x7200,
      producerId: 'external.raw-claim', producerVersion: '1', ...BINDING,
    }),
  ], {
    ...BINDING,
    producerRuns: [{
      id: 'external.raw-claim', version: '1', completeness: 'complete', stopReason: null,
      evidenceCount: 1, intervalCount: 0, authorityClass: 'canonical',
    }],
  });
  assert.equal(claimedRun.artifact.publication.reason, 'producer-authority-untrusted');
  assert.throws(() => discoveryArtifactForRebuild(claimedRun.artifact), /not-publishable/);

  const heuristic = functionCandidates({
    input: { image: {} },
    producers: [{
      id: 'external.heuristic', version: '1',
      produce: () => [{ kind: 'prologue-candidate', start: 0x7200 }],
    }],
    ...BINDING,
  });
  assert.equal(heuristic.candidates[0].startState, 'heuristic');
  assert.equal(heuristic.artifact.publication.status, 'complete');
});

test('X-03 adversarial candidate views cannot forge digest, evidence, or exact authority', () => {
  const result = runMatrix();
  const base = {
    evidence: result.artifact.evidence,
    candidates: result.candidates,
    producerRuns: result.artifact.producerRuns,
    status: result.status,
    binding: BINDING,
    byteIntervals: matrixInput().image.byteIntervals,
  };
  const referenceIndex = result.candidates.findIndex((candidate) => candidate.start === '4192');
  const reference = result.candidates[referenceIndex];

  assert.throws(() => createDiscoveryArtifact({
    ...base,
    candidates: base.candidates.map((candidate, index) => index === referenceIndex
      ? { ...candidate, digest: 'fabricated-exact-digest', startState: 'exact' }
      : candidate),
  }), /candidate-view-mismatch/);

  const digestIgnored = createDiscoveryArtifact({
    ...base,
    candidates: base.candidates.map((candidate) => ({ ...candidate, digest: 'caller-checksum-is-not-authority' })),
  });
  assert.equal(digestIgnored.publication.status, 'complete');
  assert.deepEqual(
    digestIgnored.functionCandidates.map((candidate) => candidate.digest),
    result.candidates.map((candidate) => candidate.digest),
  );

  const recomputedForgery = createFunctionCandidate({ ...reference, startState: 'exact' });
  assert.throws(() => createDiscoveryArtifact({
    ...base,
    candidates: base.candidates.map((candidate, index) => index === referenceIndex ? recomputedForgery : candidate),
  }), /candidate-view-mismatch/);

  const invented = createDiscoveryEvidence({
    kind: 'loader-function-start', start: reference.start,
    producerId: 'discovery.loader', producerVersion: '1',
    binaryId: BINDING.binaryId, sourceHash: BINDING.sourceHash,
    snapshotId: BINDING.snapshotId, evidenceIds: ['invented'],
  });
  const evidenceForgery = createFunctionCandidate({
    ...reference,
    startEvidence: [invented],
    extentEvidence: [],
    startState: 'exact',
  });
  assert.throws(() => createDiscoveryArtifact({
    ...base,
    candidates: base.candidates.map((candidate, index) => index === referenceIndex ? evidenceForgery : candidate),
  }), /candidate-view-mismatch/);

  const outerIndex = result.candidates.findIndex((candidate) => candidate.start === '4096');
  const outer = result.candidates[outerIndex];
  const adjacentIndex = result.candidates.findIndex((candidate) => candidate.start === '4352');
  const adjacent = result.candidates[adjacentIndex];
  for (const forged of [
    createFunctionCandidate({ ...outer, name: 'invented-name' }),
    createFunctionCandidate({
      ...reference,
      regions: [{ start: reference.start, end: BigInt(reference.start) + 32n }],
      extentState: 'exact',
    }),
    createFunctionCandidate({ ...outer, conflicts: [] }),
    createFunctionCandidate({
      ...adjacent,
      regions: adjacent.regions.map((region) => ({ ...region, ownership: 'shared' })),
    }),
  ]) {
    const index = forged.start === outer.start ? outerIndex
      : forged.start === adjacent.start ? adjacentIndex : referenceIndex;
    assert.throws(() => createDiscoveryArtifact({
      ...base,
      candidates: base.candidates.map((candidate, candidateIndex) => candidateIndex === index ? forged : candidate),
    }), /candidate-view-mismatch/);
  }
});

test('X-03 producer accounting rejects null, duplicate, version/count mismatch, and evidence-free authority', () => {
  const complete = runMatrix();
  const base = {
    evidence: complete.artifact.evidence,
    candidates: complete.candidates,
    producerRuns: complete.artifact.producerRuns,
    status: complete.status,
    binding: BINDING,
    byteIntervals: matrixInput().image.byteIntervals,
  };
  assert.throws(() => createDiscoveryArtifact({
    evidence: [], candidates: [], status: complete.status, binding: BINDING,
    producerRuns: [{ id: null, version: '1', completeness: 'complete', evidenceCount: 0 }],
  }), /producer-id-required/);

  const evidenceFree = createDiscoveryArtifact({
    evidence: [], candidates: [], status: complete.status, binding: BINDING,
    producerRuns: [{ id: 'empty', version: '1', completeness: 'complete', evidenceCount: 0, intervalCount: 0 }],
  });
  assert.deepEqual(evidenceFree.publication, { status: 'withheld', reason: 'discovery-evidence-absent' });

  const duplicate = createDiscoveryArtifact({
    ...base,
    producerRuns: [...base.producerRuns, { ...base.producerRuns[0] }],
  });
  assert.equal(duplicate.publication.reason, 'producer-identity-duplicate');

  const countMismatch = createDiscoveryArtifact({
    ...base,
    producerRuns: base.producerRuns.map((run, index) => index === 0 ? { ...run, evidenceCount: run.evidenceCount + 1 } : run),
  });
  assert.match(countMismatch.publication.reason, /producer-evidence-count-mismatch/);

  const versionMismatch = createDiscoveryArtifact({
    ...base,
    producerRuns: base.producerRuns.map((run) => run.evidenceCount > 0
      ? { ...run, version: 'forged-version' }
      : run),
  });
  assert.equal(versionMismatch.publication.reason, 'producer-identity-mismatch');

  const intervalOnly = createDiscoveryArtifact({
    evidence: [], candidates: [], status: complete.status, binding: BINDING,
    producerRuns: [{ id: 'intervals', version: '1', completeness: 'complete', evidenceCount: 0, intervalCount: 1 }],
    byteIntervals: [{ start: 1, end: 2, kind: 'data', producerId: 'intervals', producerVersion: '1' }],
  });
  assert.equal(intervalOnly.publication.status, 'complete');
});

test('X-03 architecture identity binds evidence and producer runs', () => {
  const evidence = createDiscoveryEvidence({
    kind: 'loader-function-start', start: 0x5000,
    producerId: 'arch-source', producerVersion: '1', architectureId: 'x86_64',
    binaryId: BINDING.binaryId, sourceHash: BINDING.sourceHash, snapshotId: BINDING.snapshotId,
  });
  const candidate = createFunctionCandidate({
    start: evidence.start, startEvidence: [evidence], extentEvidence: [], startState: 'exact', architectureId: 'x86_64',
  });
  const evidenceMismatch = createDiscoveryArtifact({
    evidence: [evidence], candidates: [candidate], status: runMatrix().status, binding: BINDING,
    producerRuns: [{
      id: 'arch-source', version: '1', completeness: 'complete', evidenceCount: 1,
      intervalCount: 0, authorityClass: 'canonical',
    }],
  });
  assert.equal(evidenceMismatch.publication.reason, 'stale-evidence-architectureId');

  const complete = runMatrix();
  const producerMismatch = createDiscoveryArtifact({
    evidence: complete.artifact.evidence,
    candidates: complete.candidates,
    status: complete.status,
    binding: BINDING,
    byteIntervals: matrixInput().image.byteIntervals,
    producerRuns: complete.artifact.producerRuns.map((run, index) => index === 0
      ? { ...run, architectureId: 'x86_64' }
      : run),
  });
  assert.equal(producerMismatch.publication.reason, 'stale-producer-architectureId');
});

test('X-03 artifact resource authority fails closed before unbounded evidence or collision work', () => {
  assert.ok(Object.isFrozen(DISCOVERY_ARTIFACT_DEFAULT_BUDGET));
  for (const [name, hardCeiling] of Object.entries(DISCOVERY_ARTIFACT_DEFAULT_BUDGET)) {
    assert.throws(
      () => normalizeDiscoveryArtifactBudget({ [name]: hardCeiling + 1 }),
      new RegExp(`${name}-exceeds-default`),
    );
    for (const coerced of [String(hardCeiling), [hardCeiling], true, { valueOf: () => hardCeiling }]) {
      assert.throws(() => normalizeDiscoveryArtifactBudget({ [name]: coerced }), new RegExp(`${name}-invalid`));
    }
    let getterReads = 0;
    const accessorBudget = {};
    Object.defineProperty(accessorBudget, name, { get() { getterReads += 1; return hardCeiling; } });
    assert.throws(() => normalizeDiscoveryArtifactBudget(accessorBudget), new RegExp(`${name}-invalid`));
    assert.equal(getterReads, 0, 'budget authority never invokes accessors');
  }
  const complete = runMatrix();
  const limitedEvidence = createDiscoveryArtifact({
    evidence: complete.artifact.evidence.slice(0, 2), candidates: [], status: complete.status, binding: BINDING,
    artifactBudget: { maxTotalEvidence: 1 },
  });
  assert.equal(limitedEvidence.publication.reason, 'artifact-budget-exhausted:total-evidence');
  assert.equal(limitedEvidence.evidence.length, 0);
  assert.equal(limitedEvidence.resource.ok, false);

  const interval = (start) => ({
    start, end: start + 2, kind: 'data', producerId: 'intervals', producerVersion: '1',
  });
  const limitedIntervals = createDiscoveryArtifact({
    evidence: [], candidates: [], status: complete.status, binding: BINDING,
    producerRuns: [{ id: 'intervals', version: '1', completeness: 'complete', evidenceCount: 0, intervalCount: 2 }],
    byteIntervals: [interval(10), interval(20)],
    artifactBudget: { maxIntervalClaims: 1 },
  });
  assert.equal(limitedIntervals.publication.reason, 'artifact-budget-exhausted:interval-claims');

  const limitedWork = createDiscoveryArtifact({
    evidence: [], candidates: [], status: complete.status, binding: BINDING,
    producerRuns: [{ id: 'intervals', version: '1', completeness: 'complete', evidenceCount: 0, intervalCount: 3 }],
    byteIntervals: [interval(10), interval(20), interval(30)],
    artifactBudget: { maxCollisionWork: 1 },
  });
  assert.equal(limitedWork.publication.reason, 'artifact-budget-exhausted:collision-work');

  const hugeSparseEvidence = new Array(DISCOVERY_ARTIFACT_DEFAULT_BUDGET.maxTotalEvidence + 1);
  const sparseLimited = createDiscoveryArtifact({
    evidence: hugeSparseEvidence, candidates: [], status: complete.status, binding: BINDING,
  });
  assert.equal(sparseLimited.publication.reason, 'artifact-budget-exhausted:total-evidence');

  let getterReads = 0;
  const getterEvidence = {};
  Object.defineProperty(getterEvidence, 'regions', { get() { getterReads += 1; return []; } });
  Object.defineProperty(getterEvidence, 'kind', { get() { getterReads += 1; return 'loader-function-start'; } });
  const descriptorRejected = createDiscoveryArtifact({
    evidence: [getterEvidence], candidates: [], status: complete.status, binding: BINDING,
  });
  assert.equal(getterReads, 0, 'preflight never invokes evidence getters');
  assert.equal(descriptorRejected.publication.status, 'withheld');
  assert.match(descriptorRejected.publication.reason, /malformed-evidence-descriptor/);

  const fusionLimited = fuseFunctionCandidates([
    createDiscoveryEvidence({ kind: 'loader-function-start', start: 1, producerId: 'a' }),
    createDiscoveryEvidence({ kind: 'loader-function-start', start: 2, producerId: 'a' }),
  ], { ...BINDING, artifactBudget: { maxTotalEvidence: 1 } });
  assert.equal(fusionLimited.status.stopReason, 'budget-exhausted');
  assert.equal(fusionLimited.artifact.evidence.length, 0);
  assert.equal(fusionLimited.artifact.publication.status, 'withheld');

  const registryLimited = functionCandidates({
    input: { image: {} },
    producers: [{
      id: 'oversized.raw-producer', version: '1',
      produce: () => [{ malformed: true }, { malformed: true }],
    }],
    ...BINDING,
    artifactBudget: { maxTotalEvidence: 1 },
  });
  assert.equal(registryLimited.status.stopReason, 'budget-exhausted');
  assert.equal(registryLimited.artifact.publication.reason, 'artifact-budget-exhausted:total-evidence');
  assert.equal(registryLimited.artifact.evidence.length, 0, 'registry gates total count before evidence canonicalization');

  const perCandidate = fuseFunctionCandidates([
    createDiscoveryEvidence({ kind: 'loader-function-start', start: 1, producerId: 'a' }),
    createDiscoveryEvidence({ kind: 'symbol-table', start: 1, producerId: 'b' }),
  ], { ...BINDING, budget: { maxEvidencePerCandidate: 1 } });
  assert.equal(perCandidate.artifact.evidence.length, 1, 'omitted per-candidate evidence is not retained as complete');
  assert.equal(perCandidate.artifact.publication.status, 'withheld');
});

test('X-03 consumers reject self-hashed artifacts that were not factory-issued', () => {
  const artifact = runMatrix().artifact;
  const payload = { ...artifact };
  delete payload.artifactId;
  const forged = { artifactId: `discovery-artifact:${stableDigest(payload)}`, ...payload };
  assert.equal(forged.artifactId, artifact.artifactId, 'the public checksum can be reproduced');
  assert.throws(() => discoveryArtifactForRebuild(forged, BINDING), /artifact-identity-invalid/);

  const sourceBinding = discoveryArtifactForRebuild(artifact, BINDING);
  const reparse = verifyDiscoveryReparse(sourceBinding, forged, { expectedOutputHash: BINDING.sourceHash });
  assert.deepEqual(reparse, { ok: false, reason: 'discovery-reparse-artifact-invalid' });

  const emptyPayload = {
    schemaVersion: 'hex-discovery-rebuild-binding/v1',
    artifactId: 'discovery-artifact:self-hashed-empty',
    binding: BINDING,
    collisionSets: [],
    references: [],
  };
  const selfHashedEmpty = { ...emptyPayload, digest: stableDigest(emptyPayload) };
  assert.deepEqual(
    verifyDiscoveryReparse(selfHashedEmpty, artifact, { expectedOutputHash: BINDING.sourceHash }),
    { ok: false, reason: 'discovery-reparse-source-binding-invalid' },
  );
  assert.throws(() => createRebuildTransaction({
    binaryId: BINDING.binaryId, sourceHash: SOURCE_HASH, format: 'elf',
    architecture: BINDING.architectureId, loaderVersion: 'x03-loader-v1',
    expectedOriginalState: { sourceHash: SOURCE_HASH, discoveryBinding: selfHashedEmpty },
    operations: [{ id: 'forged-binding', offset: 0, before: [1], after: [2], provenance: { source: 'test' } }],
  }), /discovery-binding-untrusted/);
  assert.throws(() => createRebuildTransaction({
    binaryId: 'different-binary', sourceHash: SOURCE_HASH, format: 'elf',
    architecture: BINDING.architectureId, loaderVersion: 'x03-loader-v1',
    expectedOriginalState: { sourceHash: SOURCE_HASH, discoveryBinding: sourceBinding },
    operations: [{ id: 'stale-binding', offset: 0, before: [1], after: [2], provenance: { source: 'test' } }],
  }), /discovery-binding-mismatch/);
});

test('X-03 stale identity cannot publish complete or bind a rebuild', () => {
  const result = runMatrix(false, { expectedBinding: { ...BINDING, snapshotId: 'snapshot-x03-new' } });
  assert.equal(result.status.completeness, 'complete', 'analysis completed for its observed snapshot');
  assert.equal(result.artifact.publication.status, 'withheld');
  assert.equal(result.artifact.publication.reason, 'stale-snapshotId');
  assert.throws(() => discoveryArtifactForRebuild(result.artifact), /not-publishable/);

  const fresh = runMatrix();
  assert.throws(
    () => discoveryArtifactForRebuild(fresh.artifact, { binaryId: 'different-binary' }),
    /binaryId-mismatch/,
  );
});

test('X-03 cancellation, candidate budget, evidence budget, and partial producers never publish complete', () => {
  const controller = new AbortController();
  controller.abort('matrix-cancel');
  const cancelled = runMatrix(false, { signal: controller.signal });
  assert.equal(cancelled.status.stopReason, 'cancelled');
  assert.equal(cancelled.artifact.publication.status, 'withheld');

  const candidateBudget = runMatrix(false, { budget: { maxCandidates: 1 } });
  assert.equal(candidateBudget.status.stopReason, 'budget-exhausted');
  assert.equal(candidateBudget.artifact.publication.status, 'withheld');

  const evidenceBudget = runMatrix(false, { budget: { maxEvidencePerCandidate: 1 } });
  assert.equal(evidenceBudget.status.stopReason, 'budget-exhausted');
  assert.equal(evidenceBudget.artifact.publication.status, 'withheld');

  const partialProducer = {
    id: 'discovery.partial-test',
    version: '1',
    produce: () => ({
      evidence: [createDiscoveryEvidence({ kind: 'symbol-table', start: 0x4000 })],
      status: { completeness: 'partial', stopReason: 'evidence-missing' },
    }),
  };
  const partial = functionCandidates({ input: { image: {} }, producers: [partialProducer], ...BINDING });
  assert.equal(partial.status.completeness, 'partial');
  assert.equal(partial.artifact.publication.status, 'withheld');
  assert.ok(partial.artifact.producerRuns.some((run) => run.id === partialProducer.id && run.completeness === 'partial'));
});

test('X-03 production ToolRegistry projection carries ambiguity without selecting a winner', async () => {
  const artifact = runMatrix().artifact;
  const registry = createHexToolRegistry({
    discoveryArtifact: artifact,
    searchFunctions: async () => ({ results: [
      { addr: 0x1000n, name: 'outer', discovery: { startState: 'backend-exact' } },
      { addr: 0xdeadn, name: 'unmatched', discovery: { ambiguous: true } },
    ], total: 2, complete: true }),
  });
  const observed = await registry.execute('search_functions', { query: 'outer', limit: 10 }, { scope: 'binary' });
  const row = observed.result.results[0];
  assert.equal(row.discovery.artifactId, artifact.artifactId);
  assert.equal(row.discovery.startState, 'exact');
  assert.equal(row.discovery.ambiguous, true);
  assert.ok(row.discovery.collisionIds.length > 0);
  assert.equal(observed.modelData.results[0].discovery.ambiguous, true);
  assert.deepEqual(observed.modelData.results[0].discovery.collisionIds, row.discovery.collisionIds);
  assert.equal(Object.hasOwn(observed.result.results[1], 'discovery'), false, 'unmatched backend claims are scrubbed');

  const payload = { ...artifact };
  delete payload.artifactId;
  const forged = { artifactId: `discovery-artifact:${stableDigest(payload)}`, ...payload };
  const invalidRegistry = createHexToolRegistry({
    discoveryArtifact: forged,
    searchFunctions: async () => ({
      results: [{ addr: 0x1000n, discovery: { ambiguous: true } }],
      discoveryArtifact: { publication: { status: 'complete' } }, total: 1, complete: true,
    }),
  });
  const scrubbed = await invalidRegistry.execute('search_functions', { query: 'outer', limit: 10 }, { scope: 'binary' });
  assert.equal(Object.hasOwn(scrubbed.result.results[0], 'discovery'), false);
  assert.equal(Object.hasOwn(scrubbed.result, 'discoveryArtifact'), false);

  const absentRegistry = createHexToolRegistry({
    searchFunctions: async () => ({
      results: [{ addr: 0x1000n, discovery: { startState: 'backend-exact' } }],
      discoveryArtifact: { publication: { status: 'complete' } }, total: 1, complete: true,
    }),
  });
  const absent = await absentRegistry.execute('search_functions', { query: 'outer', limit: 10 }, { scope: 'binary' });
  assert.equal(Object.hasOwn(absent.result.results[0], 'discovery'), false);
  assert.equal(Object.hasOwn(absent.result, 'discoveryArtifact'), false);

  let backendGetterReads = 0;
  const accessorRow = { addr: 0x1000n };
  Object.defineProperty(accessorRow, 'discovery', {
    enumerable: true,
    get() { backendGetterReads += 1; return { startState: 'forged' }; },
  });
  const accessorRegistry = createHexToolRegistry({
    discoveryArtifact: artifact,
    searchFunctions: async () => ({ results: [accessorRow], total: 1, complete: true }),
  });
  await assert.rejects(
    () => accessorRegistry.execute('search_functions', { query: 'outer', limit: 10 }, { scope: 'binary' }),
    /search-page-envelope-invalid/,
  );
  assert.equal(backendGetterReads, 0);

  for (const field of ['offset', 'total', 'complete', 'truncated']) {
    let reads = 0;
    const envelope = { results: [{ addr: 0x1000n }] };
    Object.defineProperty(envelope, field, { enumerable: true, get() { reads += 1; return field === 'complete' ? true : 0; } });
    const hostile = createHexToolRegistry({ searchFunctions: async () => envelope });
    await assert.rejects(
      () => hostile.execute('search_functions', { query: 'outer', limit: 10 }, { scope: 'binary' }),
      /search-page-envelope-invalid/,
    );
    assert.equal(reads, 0, `${field} accessor is never invoked`);
  }

  let nestedReads = 0;
  const nestedCompleteness = {};
  Object.defineProperty(nestedCompleteness, 'complete', { enumerable: true, get() { nestedReads += 1; return true; } });
  const nestedHostile = createHexToolRegistry({
    searchFunctions: async () => ({ results: [], completeness: nestedCompleteness }),
  });
  await assert.rejects(
    () => nestedHostile.execute('search_functions', { query: 'outer', limit: 10 }, { scope: 'binary' }),
    /search-page-completeness-invalid/,
  );
  assert.equal(nestedReads, 0);

  let paginationReads = 0;
  const nestedPagination = {};
  Object.defineProperty(nestedPagination, 'offset', { enumerable: true, get() { paginationReads += 1; return 0; } });
  const paginationHostile = createHexToolRegistry({
    searchFunctions: async () => ({ results: [], pagination: nestedPagination }),
  });
  await assert.rejects(
    () => paginationHostile.execute('search_functions', { query: 'outer', limit: 10 }, { scope: 'binary' }),
    /search-page-pagination-invalid/,
  );
  assert.equal(paginationReads, 0);

  let resultReads = 0;
  const hostileResults = [];
  Object.defineProperty(hostileResults, '0', { configurable: true, get() { resultReads += 1; return { addr: 0x1000n }; } });
  hostileResults.length = 1;
  const resultsHostile = createHexToolRegistry({
    searchFunctions: async () => ({ results: hostileResults }),
  });
  await assert.rejects(
    () => resultsHostile.execute('search_functions', { query: 'outer', limit: 10 }, { scope: 'binary' }),
    /search-page-results-invalid/,
  );
  assert.equal(resultReads, 0);

  let proxyReads = 0;
  const proxiedResults = new Proxy([{ addr: 0x1000n }], {
    get(target, key, receiver) { proxyReads += 1; return Reflect.get(target, key, receiver); },
  });
  const proxyHostile = createHexToolRegistry({
    searchFunctions: async () => ({ results: proxiedResults, total: 1, complete: true }),
  });
  await assert.rejects(
    () => proxyHostile.execute('search_functions', { query: 'outer', limit: 10 }, { scope: 'binary' }),
    /search-page-envelope-invalid/,
  );
  assert.equal(proxyReads, 0, 'page snapshot does not invoke proxy get traps');

  let metaTraps = 0;
  const fabricatedEnvelope = new Proxy({}, {
    ownKeys() { metaTraps += 1; return ['results', 'total', 'complete']; },
    getOwnPropertyDescriptor(_target, key) {
      metaTraps += 1;
      return { configurable: true, enumerable: true, writable: true, value: key === 'results' ? [] : key === 'complete' ? true : 0 };
    },
  });
  const fabricatedHostile = createHexToolRegistry({ searchFunctions: async () => fabricatedEnvelope });
  await assert.rejects(
    () => fabricatedHostile.execute('search_functions', { query: 'outer', limit: 10 }, { scope: 'binary' }),
    /search-page-envelope-invalid/,
  );
  assert.ok(metaTraps > 0, 'fabricated descriptors were inspected but never established completeness');

  let rowMetaTraps = 0;
  const fabricatedRow = new Proxy({}, {
    ownKeys() { rowMetaTraps += 1; return ['addr', 'score']; },
    getOwnPropertyDescriptor(_target, key) {
      rowMetaTraps += 1;
      return { configurable: true, enumerable: true, writable: true, value: key === 'addr' ? 0x1000n : 1 };
    },
  });
  const fabricatedRowHostile = createHexToolRegistry({
    searchFunctions: async () => ({ results: [fabricatedRow], total: 1, complete: true }),
  });
  await assert.rejects(
    () => fabricatedRowHostile.execute('search_functions', { query: 'outer', limit: 10 }, { scope: 'binary' }),
    /search-page-envelope-invalid/,
  );
  assert.ok(rowMetaTraps > 0, 'nested row meta traps cannot establish page completeness');

  let coercions = 0;
  const structuredScalar = new Proxy({}, {
    get() { coercions += 1; return () => 1; },
  });
  const structuredHostile = createHexToolRegistry({
    searchFunctions: async () => ({ results: [], total: structuredScalar }),
  });
  await assert.rejects(
    () => structuredHostile.execute('search_functions', { query: 'outer', limit: 10 }, { scope: 'binary' }),
    /search-page-total-invalid/,
  );
  assert.equal(coercions, 0);
});

test('X-03 rebuild/reparse derives collision preservation from exact output bytes', async () => {
  const source = overlappingElfFixture();
  const sourceHash = `bytes:${stableDigest(Array.from(source))}`;
  const binaryId = 'bin-x03-canonical-elf';
  const artifact = deriveCanonicalDiscoveryArtifact({
    source, binaryId, sourceHash, snapshotId: 'snapshot-x03-source', format: 'elf', architecture: 'x86_64',
  });
  assert.equal(artifact.publication.status, 'complete');
  assert.ok(artifact.collisionSets.some((item) => item.kind === 'function-overlap'));
  const discoveryBinding = discoveryArtifactForRebuild(artifact, {
    binaryId, sourceHash, snapshotId: 'snapshot-x03-source', architectureId: 'x86_64',
  });
  const transaction = createRebuildTransaction({
    binaryId,
    sourceHash,
    format: 'elf',
    architecture: 'x86_64',
    loaderVersion: 'x03-loader-v1',
    discoveryArtifact: artifact,
    expectedOriginalState: { sourceHash },
    operations: [{
      id: 'replace-one-code-byte', offset: 0x100, before: [0x90], after: [0x91],
      provenance: { discoveryDomain: 'code', discoveryArtifactId: artifact.artifactId, collisionIds: artifact.collisionSets.map((item) => item.collisionId) },
    }],
  });
  const materialized = await materializeRebuildTransaction(transaction, source);
  assert.equal(materialized.status, 'materialized');
  let received = null;
  const validation = await validateRebuildTransaction(transaction, materialized, {
    original: source,
    loaderReparse: ({ transaction: observed, output }) => {
      received = observed.expectedOriginalState.discoveryBinding;
      return {
        ok: output === materialized.bytes,
        sourceHash,
        outputHash: materialized.outputHash,
        format: 'elf',
        architecture: 'x86_64',
        loaderVersion: 'x03-loader-v1',
      };
    },
  });
  assert.equal(validation.status, 'valid');
  assert.equal(validation.validators.find((item) => item.validator === 'loader-reparse').status, 'passed');
  assert.equal(received.artifactId, artifact.artifactId);
  assert.deepEqual(received.collisionSets, artifact.collisionSets);
  assert.deepEqual(received.references, artifact.references);

  const invalidatingTransaction = createRebuildTransaction({
    binaryId,
    sourceHash,
    format: 'elf',
    architecture: 'x86_64',
    loaderVersion: 'x03-loader-v1',
    discoveryArtifact: artifact,
    operations: [{
      id: 'destroy-elf-magic', offset: 0, before: [0x7f], after: [0],
      provenance: { discoveryDomain: 'function-identity', source: 'negative-test' },
    }],
  });
  const invalidatingMaterialized = await materializeRebuildTransaction(invalidatingTransaction, source);
  const synthetic = await validateRebuildTransaction(invalidatingTransaction, invalidatingMaterialized, {
    original: source,
    loaderReparse: () => ({
      ok: true, sourceHash, outputHash: invalidatingMaterialized.outputHash,
      format: 'elf', architecture: 'x86_64', loaderVersion: 'x03-loader-v1',
      discoveryArtifact: runMatrix(false, {
        sourceHash: invalidatingMaterialized.outputHash, snapshotId: 'synthetic-copy',
      }).artifact,
    }),
  });
  assert.equal(
    synthetic.validators.find((item) => item.validator === 'loader-reparse').reason,
    'discovery-canonical-parse-unavailable',
  );

  const noAmbiguity = functionCandidates({
    input: { image: { functions: [{ address: 0x9000, source: 'function_starts' }] } },
    binaryId, sourceHash,
    architectureId: 'x86_64',
    sourceHash: materialized.outputHash,
    snapshotId: 'snapshot-x03-reparsed',
  });
  const missingOutputHash = verifyDiscoveryReparse(discoveryBinding, noAmbiguity.artifact);
  assert.equal(missingOutputHash.reason, 'discovery-reparse-output-hash-required');
  const staleOutputHash = verifyDiscoveryReparse(discoveryBinding, noAmbiguity.artifact, { expectedOutputHash: 'bytes:stale' });
  assert.equal(staleOutputHash.reason, 'discovery-reparse-output-hash-mismatch');
  const lost = verifyDiscoveryReparse(discoveryBinding, noAmbiguity.artifact, { expectedOutputHash: materialized.outputHash });
  assert.equal(lost.ok, false);
  assert.equal(lost.reason, 'discovery-reparse-ambiguity-lost');
  assert.ok(lost.missingCollisionIds.length > 0);
  assert.deepEqual(lost.missingReferenceIds, []);
});

test('X-03 canonical reparse rejects real parser-partial output and cancellation', async () => {
  const partial = new Uint8Array(readFileSync(new URL('../../phase5/corpus/fixtures/vertical-sysv-amd64.elf', import.meta.url)));
  const parsed = openBinary(partial);
  assert.equal(parsed.metadata.elfMetadata.complete, true);
  assert.equal(parsed.metadata.programDynamicPartial, true);
  assert.throws(() => deriveCanonicalDiscoveryArtifact({
    source: partial, binaryId: 'bin-x03-partial-real', snapshotId: 'snapshot-x03-partial-real',
    format: 'elf', architecture: 'x86_64',
  }), /discovery-canonical-analysis-incomplete/);
  const partialMachO = makeMachO64Fixture();
  partialMachO[0x283] = 0x80;
  assert.equal(openBinary(partialMachO).metadata.functionStarts.complete, false);
  assert.throws(() => deriveCanonicalDiscoveryArtifact({
    source: partialMachO, binaryId: 'bin-x03-partial-macho', snapshotId: 'snapshot-x03-partial-macho',
    format: 'macho', architecture: 'arm64',
  }), /discovery-canonical-analysis-incomplete/);
  const partialPe = makePe64Fixture();
  const partialPeView = new DataView(partialPe.buffer, partialPe.byteOffset, partialPe.byteLength);
  partialPeView.setUint32(0x8c, 0x100, true);
  partialPeView.setUint32(0x90, 10_000_000, true);
  assert.equal(openBinary(partialPe).metadata.peMetadata.complete, false);
  assert.throws(() => deriveCanonicalDiscoveryArtifact({
    source: partialPe, binaryId: 'bin-x03-partial-pe', snapshotId: 'snapshot-x03-partial-pe',
    format: 'pe', architecture: 'x86_64',
  }), /discovery-canonical-analysis-incomplete/);
  const canonicalAbort = new AbortController();
  canonicalAbort.abort();
  assert.throws(() => deriveCanonicalDiscoveryArtifact({
    source: partial, binaryId: 'bin-x03-partial-aborted', snapshotId: 'snapshot-x03-partial-aborted',
    format: 'elf', architecture: 'x86_64', signal: canonicalAbort.signal,
  }), /discovery-canonical-cancelled/);

  const validSource = overlappingElfFixture();
  const sourceHash = `bytes:${stableDigest(Array.from(validSource))}`;
  const artifact = deriveCanonicalDiscoveryArtifact({
    source: validSource, binaryId: 'bin-x03-partial-validation', sourceHash,
    snapshotId: 'snapshot-x03-partial-source', format: 'elf', architecture: 'x86_64',
  });
  const transaction = createRebuildTransaction({
    binaryId: 'bin-x03-partial-validation', sourceHash, format: 'elf', architecture: 'x86_64',
    loaderVersion: 'x03-partial-loader', discoveryArtifact: artifact,
    operations: [{
      id: 'replace-with-real-parser-partial', offset: 0,
      before: Array.from(validSource), after: Array.from(partial),
      provenance: { source: 'real-parser-partial-regression', discoveryDomain: 'code' },
    }],
  });
  const materialized = await materializeRebuildTransaction(transaction, validSource);
  const invalid = await validateRebuildTransaction(transaction, materialized, {
    original: validSource,
    loaderReparse: () => ({ ok: true }),
    validators: { layout: () => ({ ok: true }) },
  });
  assert.equal(invalid.status, 'invalid');
  assert.equal(invalid.validators.find((item) => item.validator === 'loader-reparse').reason, 'discovery-canonical-analysis-incomplete');
  assert.equal((await publishRebuildTransaction(materialized, invalid, {
    atomicPromote: async () => { throw new Error('must-not-promote'); },
  })).reason, 'rebuild-v2-validation-not-green');

  const preAborted = new AbortController();
  preAborted.abort();
  let calls = 0;
  const cancelledBefore = await validateRebuildTransaction(transaction, materialized, {
    original: validSource, signal: preAborted.signal,
    loaderReparse: () => { calls += 1; return { ok: true }; },
    validators: { layout: () => ({ ok: true }) },
  });
  assert.equal(cancelledBefore.status, 'cancelled');
  assert.equal(calls, 0);

  const midFlight = new AbortController();
  const cancelledDuring = await validateRebuildTransaction(transaction, materialized, {
    original: validSource, signal: midFlight.signal,
    validators: { layout: () => ({ ok: true }) },
    loaderReparse: () => { calls += 1; midFlight.abort(); return { ok: true }; },
  });
  assert.equal(cancelledDuring.status, 'cancelled');
  assert.equal((await validateRebuildTransaction(transaction, materialized, {
    original: validSource, timeoutMs: 0,
    loaderReparse: () => ({ ok: true }), validators: { layout: () => ({ ok: true }) },
  })).reason, 'rebuild-v2-validation-deadline-exceeded');
  let deadlineObserved = false;
  const deadlineDuring = await validateRebuildTransaction(transaction, materialized, {
    original: validSource, timeoutMs: 20,
    validators: { layout: () => ({ ok: true }) },
    loaderReparse: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        deadlineObserved = true;
        resolve({ ok: true });
      }, { once: true });
    }),
  });
  assert.equal(deadlineDuring.reason, 'rebuild-v2-validation-deadline-exceeded');
  assert.equal(deadlineObserved, true);
  assert.equal((await validateRebuildTransaction(transaction, materialized, {
    original: validSource, maxValidatorExecutions: 0,
    loaderReparse: () => ({ ok: true }), validators: { layout: () => ({ ok: true }) },
  })).reason, 'rebuild-v2-validation-budget-exceeded');
});

test('X-03 rebuild discovery policy gates fact-bearing domains but not data-only metadata', async () => {
  const source = Uint8Array.from([1, 2, 3, 4]);
  const sourceHash = `bytes:${stableDigest(Array.from(source))}`;
  const create = (discoveryDomain) => createRebuildTransaction({
    binaryId: `bin-x03-policy:${discoveryDomain}`,
    sourceHash,
    format: 'elf',
    architecture: 'x86_64',
    loaderVersion: 'x03-policy-loader',
    operations: [{
      id: `replace:${discoveryDomain}`, offset: 1, before: [2], after: [9],
      provenance: { source: 'x03-policy-test', discoveryDomain },
    }],
  });

  let loaderCalls = 0;
  const referenceFacts = create('reference-facts');
  assert.equal(referenceFacts.discoveryRequired, true);
  assert.equal(referenceFacts.expectedOriginalState.discoveryStatus, 'unproven');
  const referenceOutput = await materializeRebuildTransaction(referenceFacts, source);
  const referenceValidation = await validateRebuildTransaction(referenceFacts, referenceOutput, {
    original: source,
    loaderReparse: () => { loaderCalls += 1; return { ok: true }; },
  });
  assert.equal(referenceValidation.validators.find((item) => item.validator === 'loader-reparse').reason, 'discovery-source-unproven');
  assert.equal(loaderCalls, 0);

  const metadata = create('data-only-metadata');
  assert.equal(metadata.discoveryRequired, false);
  assert.equal(metadata.expectedOriginalState.discoveryStatus, 'not-required');
  const metadataOutput = await materializeRebuildTransaction(metadata, source);
  const metadataValidation = await validateRebuildTransaction(metadata, metadataOutput, {
    original: source,
    loaderReparse: ({ output }) => { loaderCalls += 1; return { ok: output[1] === 9 }; },
  });
  assert.equal(metadataValidation.status, 'valid');
  assert.equal(loaderCalls, 1);

  const impactGated = createRebuildTransaction({
    binaryId: 'bin-x03-policy:impact', sourceHash, format: 'elf', architecture: 'x86_64',
    loaderVersion: 'x03-policy-loader', impact: { discoveryExtents: true },
    operations: [{
      id: 'impact-gated', offset: 1, before: [2], after: [9],
      provenance: { source: 'x03-policy-test' },
    }],
  });
  assert.equal(impactGated.discoveryRequired, true);
  assert.equal(impactGated.expectedOriginalState.discoveryStatus, 'unproven');

  const metadataLayout = createRebuildTransaction({
    binaryId: 'bin-x03-policy:data-layout', sourceHash, format: 'elf', architecture: 'x86_64',
    loaderVersion: 'x03-policy-loader',
    expectedOriginalState: { sourceHash, formatSafe: { kind: 'elf-add-nobits-section' } },
    operations: [{
      id: 'metadata-layout', offset: 1, before: [2], after: [9, 10],
      provenance: { source: 'x03-policy-test', discoveryDomain: 'data-only-metadata' },
    }],
  });
  assert.equal(metadataLayout.impact.layoutMoving, true);
  assert.equal(metadataLayout.discoveryRequired, false);
  assert.equal((await materializeRebuildTransaction(metadataLayout, source)).status, 'materialized');

  assert.throws(() => create('made-up-domain'), /discovery-domain-invalid/);
  assert.throws(() => createRebuildTransaction({
    binaryId: 'bin-x03-policy:invalid-late', sourceHash, format: 'elf', architecture: 'x86_64',
    loaderVersion: 'x03-policy-loader',
    operations: [
      { id: 'affecting-first', offset: 0, before: [1], after: [5], provenance: { discoveryDomain: 'code' } },
      { id: 'invalid-late', offset: 2, before: [3], after: [6], provenance: { discoveryDomain: 'made-up-domain' } },
    ],
  }), /discovery-domain-invalid/);
});
