import assert from 'node:assert/strict';
import test from 'node:test';
import { functionCandidates, discoveryArtifactForRebuild, verifyDiscoveryReparse } from '../../../js/analysis/index.js';
import { buildDiscoveryCase } from '../../phase7/corpus/discovery.mjs';

// Canonical-comparator boundary tests use the existing neutral discovery corpus.
// These objects are NOT parser evidence. The separate rebuild-integration test
// proves real bytes, and rejects caller-created observations absent in a parse.
const identity = { binaryId: 't016:corpus', architectureId: 'x86_64' };
function input() {
  const disputed = buildDiscoveryCase('contradictory-extents');
  disputed.image.functionStarts.push(...buildDiscoveryCase('start-without-extent').image.functionStarts,
    { address: 0x8010, name: 'overlapping-start', sizeBytes: 0x20 });
  disputed.image.relocationTargets = [{ address: 0x8018, id: 'reloc:ambiguous', sourceAddress: 0x9000,
    symbolicExpression: { symbol: 'target', addend: 4n } }];
  disputed.image.byteIntervals = [
    { start: 0x8010, end: 0x8020, kind: 'data', evidenceIds: ['data:overlap'], producerId: 'discovery.references', producerVersion: '2' },
    { start: 0xa000, end: 0xa010, kind: 'data', evidenceIds: ['data:isolated'], producerId: 'discovery.references', producerVersion: '2' },
  ];
  return disputed;
}
function discover(sourceHash, change = () => {}) {
  const value = input(); change(value.image);
  return functionCandidates({ input: value, ...identity, sourceHash, snapshotId: `snapshot:${sourceHash}` }).artifact;
}
const collisionIds = (artifact) => artifact.collisionSets.map((item) => item.collisionId);
function compare(output) {
  const source = discoveryArtifactForRebuild(discover('source'));
  return verifyDiscoveryReparse(source, output, { expectedOutputHash: 'output' });
}

test('T016 canonical comparison preserves unresolved overlap/code-data/reference claims across a new sourceHash', () => {
  const source = discover('source');
  const output = discover('output');
  assert.ok(source.collisionSets.some((item) => item.kind === 'function-overlap'));
  assert.ok(source.collisionSets.some((item) => item.kind === 'code-data'));
  assert.ok(source.collisionSets.some((item) => item.kind === 'code-data-reference'));
  assert.ok(source.collisionSets.every((item) => item.resolution === 'unresolved'));
  assert.notEqual(source.artifactId, output.artifactId);
  assert.notEqual(source.functionCandidates[0].digest, output.functionCandidates[0].digest);
  assert.deepEqual(collisionIds(source), collisionIds(output));
  assert.equal(compare(output).ok, true);
});

test('T016 nonempty identical collision IDs do not permit unknown -> exact extent', () => {
  const source = discover('source');
  const output = discover('output', (image) => { image.functionStarts.find((item) => item.address === 0x6000).sizeBytes = 16; });
  const candidate = (artifact) => artifact.functionCandidates.find((item) => item.start === String(0x6000));
  assert.equal(candidate(source).extentState, 'unknown');
  assert.equal(candidate(output).extentState, 'exact');
  assert.ok(collisionIds(source).length > 0);
  assert.deepEqual(collisionIds(source), collisionIds(output));
  const result = compare(output);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'discovery-reparse-ambiguity-lost');
  assert.equal(result.candidatesPreserved, false);
});

test('T016 dropped code/data conflicts are rejected by canonical authority', () => {
  const output = discover('output', (image) => { image.byteIntervals = image.byteIntervals.filter((item) => item.start !== 0x8010); });
  const result = compare(output);
  assert.equal(result.ok, false);
  assert.ok(result.missingCollisionIds.length > 0);
});

test('T016 missing relocation/reference ambiguity is rejected by canonical authority', () => {
  for (const change of [
    (image) => { image.relocationTargets = []; },
    (image) => { image.relocationTargets[0].symbolicExpression.addend = 5n; },
  ]) {
    const result = compare(discover('output', change));
    assert.equal(result.ok, false);
    assert.ok(result.missingReferenceIds.length > 0);
  }
});

test('T016 interval loss without any change to collision IDs or candidates is rejected', () => {
  const output = discover('output', (image) => { image.byteIntervals = image.byteIntervals.filter((item) => item.start !== 0xa000); });
  assert.deepEqual(collisionIds(discover('source')), collisionIds(output));
  const result = compare(output);
  assert.equal(result.ok, false);
  assert.equal(result.candidatesPreserved, true);
  assert.equal(result.intervalsPreserved, false);
  assert.deepEqual(result.missingCollisionIds, []);
  assert.deepEqual(result.missingReferenceIds, []);
});

test('T016 uncovered partial extent cannot supply a complete reparse', () => {
  const partial = buildDiscoveryCase('non-contiguous');
  partial.image.unwindEntries = partial.image.unwindEntries.filter((entry) => entry.primary === false);
  const output = functionCandidates({ input: partial, ...identity, sourceHash: 'output', snapshotId: 'snapshot:output' }).artifact;
  assert.equal(output.publication.status, 'withheld');
  assert.match(output.publication.reason, /extent-coverage-incomplete/);
  assert.throws(() => discoveryArtifactForRebuild(output), /not-publishable/);
  assert.equal(compare(output).reason, 'discovery-reparse-artifact-invalid');
});
