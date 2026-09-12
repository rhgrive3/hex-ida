import assert from 'node:assert/strict';
import test from 'node:test';

import {
  functionDiscoveryArtifact,
  discoveryArtifactForRebuild,
} from '../../../js/analysis/index.js';
import {
  discoveryReferencesFromImage,
  isFactoryIssuedDiscoveryArtifact,
} from '../../../js/analysis/discovery/artifact.js';
import { BinaryImage } from '../../../js/binary/index.js';

const SOURCE_HASH = 'bytes:0123456789abcdef0123456789abcdef';
const BINDING = Object.freeze({
  binaryId: 'binary:x03:fixture',
  sourceHash: SOURCE_HASH,
  snapshotId: 'snapshot:x03:source',
  architectureId: 'x86_64',
});

function discover(image, extra = {}) {
  return functionDiscoveryArtifact({
    input: { image, ...(extra.input ?? {}) },
    architectureId: BINDING.architectureId,
    binaryId: BINDING.binaryId,
    sourceHash: BINDING.sourceHash,
    snapshotId: BINDING.snapshotId,
    ...(extra.options ?? {}),
  });
}

function loaderFunction(address, sizeBytes = null) {
  return {
    address,
    source: 'function_starts',
    ...(sizeBytes == null ? {} : { sizeBytes }),
  };
}

function candidateAt(result, address) {
  return result.artifact.functionCandidates.find((candidate) => BigInt(candidate.start) === BigInt(address));
}

test('X-03 retains code/data overlap instead of choosing an owner', () => {
  const result = discover({
    functions: [loaderFunction(0x1000, 0x30)],
    byteIntervals: [
      { kind: 'data', start: 0x1010, end: 0x1020, producerId: 'loader.byte-classifier', origin: 'fixture:inline-data' },
    ],
  });
  assert.equal(result.artifact.publication.status, 'complete');
  const collision = result.artifact.collisionSets.find((item) => item.kind === 'code-data');
  assert.ok(collision, 'mixed code/data must remain an unresolved collision');
  assert.equal(collision.resolution, 'unresolved');
  assert.deepEqual(collision.range, { start: '4112', end: '4128' });
});

test('X-03 preserves function-boundary overlap even when the working view withdraws extents', () => {
  const result = discover({
    functions: [loaderFunction(0x2000, 0x30), loaderFunction(0x2020, 0x30)],
  });
  assert.equal(candidateAt(result, 0x2000).extentState, 'unknown');
  assert.equal(candidateAt(result, 0x2020).extentState, 'unknown');
  assert.ok(result.artifact.collisionSets.some((item) => item.kind === 'function-overlap'));
});

test('rank/confidence-like inputs never become a new X-03 exact-selection authority', () => {
  const result = discover({
    symbols: [{ address: 0x3000, name: 'looks_plausible', isFunction: true, score: 1e9, confidence: 1 }],
  });
  const candidate = candidateAt(result, 0x3000);
  assert.equal(candidate.startState, 'heuristic', 'one corroborating source is still heuristic');
  assert.equal(candidate.ambiguous, true);
  assert.equal(Object.hasOwn(candidate, 'exact'), false, 'artifact must not mint a second exact flag');
  assert.equal(Object.hasOwn(candidate, 'selected'), false, 'artifact must not pick a winner');
});

test('jump-table uncertainty is retained as a reference without manufacturing a function start', () => {
  const result = discover({
    jumpTableTargets: [
      { address: 0x4010, tableAddress: 0x5000, tableId: 'jt:0', symbolicExpression: { base: 'pc', scale: 4 } },
    ],
  });
  assert.equal(result.candidates.some((candidate) => BigInt(candidate.start) === 0x4010n), false);
  const reference = result.artifact.references.find((item) => item.kind === 'jump-table');
  assert.ok(reference);
  assert.equal(reference.address, '16400');
  assert.equal(reference.sourceAddress, '20480');
  assert.equal(reference.tableId, 'jt:0');
  assert.deepEqual(reference.symbolicExpression, { base: 'pc', scale: 4 });
});

test('relocation identity and symbolic expression survive beside code-reference ambiguity', () => {
  const result = discover({
    functions: [loaderFunction(0x6000, 0x40)],
    relocationTargets: [
      { address: 0x6018, sourceAddress: 0x7000, id: 'reloc:text:7', symbolicExpression: { symbol: 'target', addend: -4 } },
    ],
  });
  const reference = result.artifact.references.find((item) => item.kind === 'relocation');
  assert.equal(reference.relocationId, 'reloc:text:7');
  assert.equal(reference.sourceAddress, '28672');
  assert.deepEqual(reference.symbolicExpression, { addend: -4, symbol: 'target' });
  assert.ok(result.artifact.collisionSets.some((item) => item.kind === 'code-reference'));
});

test('malformed reference metadata fails closed without invoking an accessor', () => {
  let getterCalls = 0;
  const relocation = { address: 0x8000, id: 'reloc:malformed' };
  Object.defineProperty(relocation, 'symbolicExpression', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error('must-not-run');
    },
  });
  assert.throws(
    () => discoveryReferencesFromImage({ relocationTargets: [relocation] }),
    /discovery-artifact-relocation-reference-invalid/,
  );
  assert.equal(getterCalls, 0, 'descriptor validation must reject accessors without executing them');
});

test('stale artifact identity is withheld and cannot bind rebuild planning', () => {
  const result = functionDiscoveryArtifact({
    input: { image: { functions: [loaderFunction(0x9000, 0x20)] } },
    ...BINDING,
    expectedBinding: { ...BINDING, sourceHash: 'bytes:ffffffffffffffffffffffffffffffff' },
  });
  assert.equal(result.artifact.publication.status, 'withheld');
  assert.equal(result.artifact.publication.reason, 'stale-sourceHash');
  assert.throws(() => discoveryArtifactForRebuild(result.artifact, BINDING), /artifact-not-publishable/);
});

test('cancellation and candidate-fusion budget exhaustion remain non-publishable', () => {
  const controller = new AbortController();
  controller.abort();
  const cancelled = discover({ functions: [loaderFunction(0xa000, 0x20)] }, {
    options: { signal: controller.signal },
  });
  assert.equal(cancelled.status.stopReason, 'cancelled');
  assert.equal(cancelled.artifact.publication.status, 'withheld');
  assert.equal(cancelled.artifact.publication.reason, 'cancelled');

  const exhausted = discover({
    functions: [loaderFunction(0xb000), loaderFunction(0xb100)],
  }, {
    options: { budget: { maxCandidates: 1 } },
  });
  assert.equal(exhausted.status.completeness, 'truncated');
  assert.equal(exhausted.status.stopReason, 'budget-exhausted');
  assert.deepEqual(exhausted.candidates, []);
  assert.equal(exhausted.artifact.publication.status, 'withheld');
  assert.equal(exhausted.artifact.publication.reason, 'budget-exhausted');
});

test('artifact reference budget exhausts before publication instead of truncating silently', () => {
  const result = discover({
    relocationTargets: [
      { address: 0xc000, id: 'r0' },
      { address: 0xc100, id: 'r1' },
    ],
  }, {
    options: { artifactBudget: { maxReferences: 1 } },
  });
  assert.equal(result.artifact.publication.status, 'withheld');
  assert.equal(result.artifact.publication.reason, 'artifact-budget-exhausted:references');
  assert.equal(result.artifact.resource.ok, false);
});

test('candidate/reference/interval permutation replays to one deterministic artifact', () => {
  const functions = [loaderFunction(0xd000, 0x30), loaderFunction(0xd020, 0x20)];
  const byteIntervals = [
    { kind: 'data', start: 0xd008, end: 0xd010, producerId: 'fixture.bytes', origin: 'inline' },
    { kind: 'padding', start: 0xd100, end: 0xd110, producerId: 'fixture.bytes', origin: 'padding' },
  ];
  const relocations = [
    { address: 0xd018, sourceAddress: 0xe000, id: 'r:a', symbolicExpression: { addend: 4, symbol: 'A' } },
    { address: 0xd028, sourceAddress: 0xe008, id: 'r:b', symbolicExpression: { symbol: 'B', addend: 8 } },
  ];
  const forward = discover({ functions, byteIntervals, relocationTargets: relocations });
  const reverse = discover({
    functions: [...functions].reverse(),
    byteIntervals: [...byteIntervals].reverse(),
    relocationTargets: [...relocations].reverse(),
  });
  assert.equal(forward.artifact.artifactId, reverse.artifact.artifactId);
  assert.deepEqual(forward.artifact, reverse.artifact);
  assert.equal(isFactoryIssuedDiscoveryArtifact(forward.artifact), true);
});

test('adjacent functions do not create a false overlap collision', () => {
  const result = discover({
    functions: [loaderFunction(0xf000, 0x20), loaderFunction(0xf020, 0x20)],
  });
  assert.equal(result.artifact.collisionSets.some((item) => item.kind === 'function-overlap'), false);
});

test('X-03 external producer cannot mint authoritative exact truth', () => {
  const externalAuthority = Object.freeze({
    id: 'x03.external.authority',
    architectureId: null,
    produce() {
      return [{ kind: 'loader-function-start', start: 0x7100, evidenceIds: ['external:forged-exact'] }];
    },
  });
  assert.throws(() => functionDiscoveryArtifact({
    input: { image: {} },
    architectureId: 'x86_64',
    binaryId: 'binary:x03:external-authority',
    sourceHash: 'bytes:x03-external-authority',
    snapshotId: 'snapshot:x03-external-authority',
    producers: [externalAuthority],
  }), /discovery-artifact-authoritative-evidence-untrusted/);
});

test('production BinaryImage dataInCode becomes code/data ambiguity without an adapter copy', () => {
  const image = new BinaryImage(new Uint8Array(64), { format: 'macho', arch: 'x86_64' });
  image.functions.push({ address: 0x8000, source: 'function_starts', sizeBytes: 0x20, name: 'owner' });
  image.addDataInCodeEntry({ offset: 0x10, length: 4, kind: 1, kindName: 'data', address: 0x8010 });
  const result = functionDiscoveryArtifact({
    input: { image },
    architectureId: image.arch,
    binaryId: 'binary:x03:binary-image-data',
    sourceHash: 'bytes:x03-binary-image-data',
    snapshotId: 'snapshot:x03-binary-image-data',
  });
  assert.equal(result.artifact.publication.status, 'complete');
  assert.ok(result.artifact.intervalClaims.some((item) => item.kind === 'data' && item.start === '32784'));
  assert.ok(result.artifact.collisionSets.some((item) => item.kind === 'code-data'));
});
