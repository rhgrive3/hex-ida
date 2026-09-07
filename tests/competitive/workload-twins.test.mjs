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
} from '../../tools/validation/competitive/workload-twins.mjs';
import { buildTwinFixture, removeTwinFixture } from './twin-fixture.mjs';

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
    const [artifact] = capture.artifacts;
    assert.equal(artifact.manifest.lineage.relation, 'debug-artifact-strip-only');
    assert.equal(artifact.manifest.lineage.sourceArtifactSha256, artifact.manifest.debugArtifactSha256);
    assert.equal(artifact.manifest.lineage.strippedArtifactSha256, artifact.manifest.strippedArtifactSha256);
    assert.notEqual(artifact.manifest.debugArtifactSha256, artifact.manifest.strippedArtifactSha256);
  } finally {
    removeTwinFixture(fixture);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
