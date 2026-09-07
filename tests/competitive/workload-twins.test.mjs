import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import profile from '../../tools/validation/competitive/profile.json' with { type: 'json' };
import {
  COMPETITIVE_TWIN_CAPTURE_SCHEMA,
  COMPETITIVE_TWIN_WORKLOADS,
  captureBenchmarkTwinWorkload,
  captureTwinArtifacts,
  competitiveTwinWorkloadFor,
  inspectBenchmarkTwinInputs,
  loadCompetitiveTwinCapture,
  validateCompetitiveTwinCapture,
  writeCompetitiveTwinCapture,
} from '../../tools/validation/competitive/workload-twins.mjs';
import { buildTwinFixture, removeTwinFixture } from './twin-fixture.mjs';
import { generateCompetitiveScorecard } from '../../tools/validation/competitive/score.mjs';

const BINARY_METRICS = Object.entries(profile.metrics)
  .filter(([, metric]) => metric.groundTruth?.binaryScored === true)
  .map(([metricId]) => metricId);

test('every binary competitive row is wired to a repository-owned twin producer', () => {
  assert.deepEqual(BINARY_METRICS.sort(), Object.keys(COMPETITIVE_TWIN_WORKLOADS).sort());
  for (const metricId of BINARY_METRICS) {
    const workload = competitiveTwinWorkloadFor(metricId);
    assert.equal(workload.metricId, metricId);
    assert.ok(workload.producer.includes('tools/validation/') || workload.producer.startsWith('tests/'));
    assert.ok(workload.workloadId);
    assert.ok(profile.metrics[metricId].corpusWorkloadIds.length > 0);
  }
});

test('benchmark baseline remains explicit until it supplies source and debug identities', () => {
  const capture = captureBenchmarkTwinWorkload();
  assert.equal(capture.schemaVersion, COMPETITIVE_TWIN_CAPTURE_SCHEMA);
  assert.equal(capture.status, 'NOT-INTEGRATED');
  assert.equal(capture.artifacts.length, 0);
  assert.match(capture.reason, /source-and-debug-artifact-identity/);
});

test('benchmark identity inspection preserves every pinned fixture and missing provenance', () => {
  const inspection = inspectBenchmarkTwinInputs({
    fixtureDirectory: fs.mkdtempSync(path.join(os.tmpdir(), 'hex-benchmark-identity-fixtures-')),
    identityManifestPath: path.join(os.tmpdir(), 'hex-missing-benchmark-identity.json'),
  });
  assert.equal(inspection.status, 'NOT-INTEGRATED');
  assert.equal(inspection.fixtureCount, 3);
  assert.deepEqual(inspection.rows.map((row) => row.fixtureId).sort(), ['TsumTsum', 'YWP', 'battlecats']);
  assert.ok(inspection.rows.every((row) => row.status === 'MISSING'));
  assert.ok(inspection.missing.some((entry) => entry.code === 'identity-manifest-unavailable'));
  assert.ok(inspection.missing.filter((entry) => entry.code === 'source-compiler-debug-identity').length === 3);
});

test('captureTwinArtifacts produces and replays a real same-artifact strip twin', () => {
  const fixture = buildTwinFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-competitive-capture-test-'));
  try {
    const capture = captureTwinArtifacts({
      metricId: 'machine-effects-x86_64-coverage',
      workloadId: 'test-real-twin',
      corpusId: fixture.context.corpusId,
      corpusVersion: fixture.context.corpusVersion,
      artifactRoot: root,
      artifacts: [{ id: 'fixture', path: fixture.debug.path, metadata: fixture.context }],
    });
    assert.equal(capture.status, 'READY');
    assert.equal(capture.artifacts.length, 1);
    assert.deepEqual(capture.denominator.artifactIds, ['fixture']);
    assert.equal(capture.denominator.artifactCount, 1);
    assert.equal(capture.truthBinding.authority, 'same-binary-twin');
    assert.equal(capture.truthBinding.status, 'UNMEASURED');
    assert.equal(capture.measurement.candidateValue, null);
    assert.equal(capture.measurement.referenceValue, null);
    assert.equal(capture.measurement.comparison, 'UNMEASURED');
    const [artifact] = capture.artifacts;
    assert.equal(artifact.manifest.lineage.relation, 'debug-artifact-strip-only');
    assert.equal(artifact.manifest.lineage.sourceArtifactSha256, artifact.manifest.debugArtifactSha256);
    assert.equal(artifact.manifest.lineage.strippedArtifactSha256, artifact.manifest.strippedArtifactSha256);
    assert.notEqual(artifact.manifest.debugArtifactSha256, artifact.manifest.strippedArtifactSha256);
    assert.doesNotThrow(() => validateCompetitiveTwinCapture(capture));
    assert.equal(capture.measurement.productionObservation.artifactCount, 1);
    assert.ok(capture.measurement.productionObservation.debugBytes > capture.measurement.productionObservation.strippedBytes);
  } finally {
    removeTwinFixture(fixture);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('capture rejects a binary whose producer metadata does not prove a debug build', () => {
  const fixture = buildTwinFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-competitive-capture-invalid-'));
  try {
    const metadata = { ...fixture.context, compileOptions: { ...fixture.context.compileOptions, debug: false } };
    const capture = captureTwinArtifacts({
      metricId: 'machine-effects-x86_64-coverage',
      workloadId: 'test-debug-required',
      corpusId: fixture.context.corpusId,
      corpusVersion: fixture.context.corpusVersion,
      artifactRoot: root,
      artifacts: [{ id: 'fixture', path: fixture.debug.path, metadata }],
    });
    assert.equal(capture.status, 'INVALID');
    assert.match(capture.reason, /debug-artifact-metadata-required/);
    assert.equal(capture.measurement.candidateValue, null);
    assert.equal(capture.measurement.referenceValue, null);
    assert.doesNotThrow(() => validateCompetitiveTwinCapture(capture));
  } finally {
    removeTwinFixture(fixture);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('capture digest excludes host-local artifact paths and binds each manifest', () => {
  const fixture = buildTwinFixture();
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-competitive-capture-a-'));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-competitive-capture-b-'));
  try {
    const options = {
      metricId: 'machine-effects-x86_64-coverage',
      workloadId: 'test-digest-stability',
      corpusId: fixture.context.corpusId,
      corpusVersion: fixture.context.corpusVersion,
      artifacts: [{ id: 'fixture', path: fixture.debug.path, metadata: fixture.context }],
    };
    const first = captureTwinArtifacts({ ...options, artifactRoot: rootA });
    const second = captureTwinArtifacts({ ...options, artifactRoot: rootB });
    assert.equal(first.status, 'READY');
    assert.equal(second.status, 'READY');
    assert.equal(first.captureDigest, second.captureDigest);
    assert.notEqual(first.artifacts[0].strippedArtifactPath, second.artifacts[0].strippedArtifactPath);
    assert.doesNotThrow(() => validateCompetitiveTwinCapture(second, { replayArtifacts: false }));
    const capturePath = path.join(rootB, 'capture.json');
    assert.equal(writeCompetitiveTwinCapture(second, capturePath), capturePath);
    assert.equal(loadCompetitiveTwinCapture(capturePath, { replayArtifacts: false }).captureDigest, second.captureDigest);
    const mutated = structuredClone(second);
    mutated.denominator.artifactIdsDigest = '0'.repeat(32);
    assert.throws(() => validateCompetitiveTwinCapture(mutated, { replayArtifacts: false }), /denominator-digest/);
    const observationMutation = structuredClone(second);
    observationMutation.measurement.productionObservation.debugBytes += 1;
    assert.throws(() => validateCompetitiveTwinCapture(observationMutation, { replayArtifacts: false }), /production-observation-total/);
  } finally {
    removeTwinFixture(fixture);
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});

test('scorecard binds a READY capture identity without promoting an unmeasured metric', async () => {
  const fixture = buildTwinFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-competitive-scorecard-capture-'));
  try {
    const metricId = 'machine-effects-x86_64-coverage';
    const capture = captureTwinArtifacts({
      metricId,
      workloadId: 'test-scorecard-binding',
      corpusId: fixture.context.corpusId,
      corpusVersion: fixture.context.corpusVersion,
      artifactRoot: root,
      artifacts: [{ id: 'fixture', path: fixture.debug.path, metadata: fixture.context }],
    });
    const scorecard = await generateCompetitiveScorecard({ twinCapturesByMetric: { [metricId]: capture } });
    const entry = scorecard.entries.find((candidate) => candidate.metricId === metricId);
    assert.equal(entry.inputIdentity, `capture_${capture.captureDigest}`);
    assert.equal(entry.hexValue, null);
    assert.equal(entry.referenceValue, null);
    assert.equal(entry.comparison, 'UNMEASURED');
    assert.ok(entry.evidenceRefs.includes(`capture:${capture.captureDigest}`));
  } finally {
    removeTwinFixture(fixture);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
