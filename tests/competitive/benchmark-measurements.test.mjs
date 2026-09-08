import assert from 'node:assert/strict';
import test from 'node:test';

import baseline from '../benchmark-baseline.json' with { type: 'json' };
import {
  BENCHMARK_FIXTURE_IDS,
  benchmarkEvidenceFromReport,
  loadBenchmarkReference,
  normalizeBenchmarkReport,
  benchmarkObservationFromReport,
} from '../../tools/validation/competitive/benchmark.mjs';
import {
  captureBenchmarkTwinWorkload,
} from '../../tools/validation/competitive/workload-twins.mjs';
import {
  collectCompetitiveMeasurements,
  measureBenchmarkLatency,
  validateCompetitiveMeasurement,
} from '../../tools/validation/competitive/measurements.mjs';
import { stableDigest } from '../../js/core/identity/index.js';
import { createTwinManifest } from '../../tools/validation/competitive/twin-manifest.mjs';

function canonicalReport() {
  const targets = {};
  for (const [id, row] of Object.entries(baseline.observations.binary.targets)) {
    targets[id] = {
      fixture: { ...baseline.fixtures[id] },
      ...row.identity,
      timing: {
        loaderMs: {
          samples: [...row.timing.loaderMsSamples],
          median: row.timing.loaderMsMedian,
        },
      },
      work: { ...row.work },
      sourceBacked: true,
      auditErrors: 0,
    };
  }
  return { schema: 1, kind: 'binary-benchmark', samplesPerTarget: 3, targets };
}

// Unit-only READY capture: it exercises the envelope/replay guards without
// presenting synthetic bytes as release measurement evidence.
function syntheticReadyCapture() {
  const artifacts = BENCHMARK_FIXTURE_IDS.map((id, index) => {
    const debugHash = String.fromCharCode(97 + index).repeat(64);
    const manifest = createTwinManifest({
      corpusId: 'benchmark-baseline-real-binaries',
      corpusVersion: 1,
      sourceIdentity: { id: `${id}.c`, sha256: 'b'.repeat(64) },
      compiler: { id: 'clang', version: 'test' },
      targetTriple: 'arm64',
      architecture: { id: 'arm64', profile: 'arm64' },
      profile: 'test',
      compileArgs: ['-g'],
      compileOptions: { debug: true, generator: 'test' },
      linker: { id: 'ld', version: 'test', options: {} },
      buildIdentity: `build-${id}`,
      debugArtifactSha256: debugHash,
      stripTool: { id: 'strip', version: 'test' },
      stripArgv: ['--strip-debug'],
      stripConfig: { mode: 'debug-only', inPlace: true },
      strippedArtifactSha256: baseline.fixtures[id].sha256,
      lineage: {
        relation: 'debug-artifact-strip-only',
        immutable: true,
        sourceArtifactSha256: debugHash,
        strippedArtifactSha256: baseline.fixtures[id].sha256,
      },
    });
    return {
      id,
      debugArtifactPath: '/tmp/benchmark-debug',
      strippedArtifactPath: '/tmp/benchmark-stripped',
      debugSidecars: [],
      manifest,
    };
  });
  const identityArtifacts = artifacts.map(({ id, manifest }) => ({
    id,
    corpusId: manifest.corpusId,
    corpusVersion: manifest.corpusVersion,
    sourceIdentity: manifest.sourceIdentity,
    compiler: manifest.compiler,
    targetTriple: manifest.targetTriple,
    architecture: manifest.architecture,
    profile: manifest.profile,
    compileArgs: manifest.compileArgs,
    compileOptions: manifest.compileOptions,
    linker: manifest.linker,
    buildIdentity: manifest.buildIdentity,
    debugArtifactSha256: manifest.debugArtifactSha256,
    strippedArtifactSha256: manifest.strippedArtifactSha256,
    manifestDigest: manifest.manifestDigest,
    debugSidecars: [],
  })).sort((left, right) => left.id.localeCompare(right.id));
  const identity = {
    schemaVersion: 'hex-competitive-twin-capture/v1',
    metricId: 'universal-binary-hotpath-ms',
    workloadId: 'benchmark-baseline-real-binaries',
    producer: 'tests/benchmark-baseline.mjs',
    kind: 'benchmark-binary',
    corpusId: 'benchmark-baseline-real-binaries',
    corpusVersion: 1,
    artifactIds: identityArtifacts.map((artifact) => artifact.id),
    artifactIdsDigest: stableDigest(identityArtifacts.map((artifact) => artifact.id)),
    sourceIdentities: [...new Set(identityArtifacts.map((artifact) => stableDigest(artifact.sourceIdentity)))].sort(),
    compilerIdentities: [...new Set(identityArtifacts.map((artifact) => stableDigest(artifact.compiler)))].sort(),
    linkerIdentities: [...new Set(identityArtifacts.map((artifact) => stableDigest(artifact.linker)))].sort(),
    buildIdentities: identityArtifacts.map((artifact) => artifact.buildIdentity),
    artifacts: identityArtifacts,
  };
  const productionRows = artifacts.map(({ id, manifest }) => ({
    id,
    debugBytes: 1,
    strippedBytes: 1,
    debugArtifactSha256: manifest.debugArtifactSha256,
    strippedArtifactSha256: manifest.strippedArtifactSha256,
    debugSidecars: [],
  })).sort((left, right) => left.id.localeCompare(right.id));
  return {
    schemaVersion: 'hex-competitive-twin-capture/v1',
    metricId: 'universal-binary-hotpath-ms',
    workloadId: 'benchmark-baseline-real-binaries',
    producer: 'tests/benchmark-baseline.mjs',
    kind: 'benchmark-binary',
    status: 'READY',
    corpusId: 'benchmark-baseline-real-binaries',
    corpusVersion: 1,
    denominator: { artifactCount: 3, artifactIds: [...BENCHMARK_FIXTURE_IDS], artifactIdsDigest: stableDigest([...BENCHMARK_FIXTURE_IDS]) },
    identity,
    captureDigest: stableDigest(identity),
    truthBinding: {
      schemaVersion: 'hex-competitive-twin-truth/v1',
      metricId: 'universal-binary-hotpath-ms',
      workloadId: 'benchmark-baseline-real-binaries',
      corpusId: 'benchmark-baseline-real-binaries',
      corpusVersion: 1,
      authority: 'same-binary-twin',
      status: 'UNMEASURED',
      competitorOutputIsNeverAuthority: true,
      manifestDigests: identityArtifacts.map((artifact) => artifact.manifestDigest),
      semanticOracle: null,
      reason: 'same-binary-twin-binds-artifact-identity-only',
    },
    measurement: {
      status: 'UNMEASURED',
      candidateValue: null,
      referenceValue: null,
      comparison: 'UNMEASURED',
      reason: 'independent-semantic-oracle-not-captured',
      productionObservation: {
        artifactCount: 3,
        debugBytes: 3,
        strippedBytes: 3,
        rows: productionRows,
        digest: stableDigest(productionRows),
      },
    },
    artifacts,
  };
}

test('canonical three-fixture report normalizes to the frozen aggregate', () => {
  const reference = loadBenchmarkReference();
  const observation = normalizeBenchmarkReport(canonicalReport(), { reference });
  assert.deepEqual(observation.candidateTargets.map((row) => row.id), [...BENCHMARK_FIXTURE_IDS]);
  assert.equal(observation.candidateValue, observation.referenceValue);
  assert.equal(observation.comparison, 'TIE');
  assert.equal(observation.samplesPerTarget, 3);
});

test('benchmark normalization rejects incomplete, altered, and under-sampled reports', () => {
  const reference = loadBenchmarkReference();
  const missingTarget = canonicalReport();
  delete missingTarget.targets.YWP;
  assert.throws(() => normalizeBenchmarkReport(missingTarget, { reference }), /candidate-denominator/);

  const alteredFixture = canonicalReport();
  alteredFixture.targets.battlecats.fixture.sha256 = '0'.repeat(64);
  assert.throws(() => normalizeBenchmarkReport(alteredFixture, { reference }), /candidate-fixture-identity/);

  const alteredMedian = canonicalReport();
  alteredMedian.targets.TsumTsum.timing.loaderMs.median += 1;
  assert.throws(() => normalizeBenchmarkReport(alteredMedian, { reference }), /candidate-median/);

  const underSampled = canonicalReport();
  underSampled.samplesPerTarget = 2;
  assert.throws(() => normalizeBenchmarkReport(underSampled, { reference }), /candidate-sample-count-too-small/);

  const overSampled = canonicalReport();
  overSampled.samplesPerTarget = 4;
  assert.throws(() => normalizeBenchmarkReport(overSampled, { reference }), /candidate-sample-count-locked/);
});

test('benchmark normalization enforces deterministic work limits per fixture', () => {
  const reference = loadBenchmarkReference();
  const baselineTarget = reference.referenceTargets.find((row) => row.id === 'battlecats');
  for (const metric of ['rangeReads', 'totalRequestedBytes']) {
    const regressed = canonicalReport();
    regressed.targets.battlecats.work[metric] = Math.ceil(
      baselineTarget.work[metric] * reference.deterministicWorkMaxRatio,
    ) + 1;
    assert.throws(() => normalizeBenchmarkReport(regressed, { reference }), new RegExp(`candidate-work-regression:.*battlecats:${metric}`));
  }
});

test('missing real twin inputs remain explicitly unmeasured and never invoke the runner', () => {
  const capture = captureBenchmarkTwinWorkload();
  assert.equal(capture.status, 'NOT-INTEGRATED');
  const measurement = measureBenchmarkLatency({ capture });
  assert.equal(measurement.status, 'UNMEASURED');
  assert.equal(measurement.candidateValue, null);
  assert.equal(measurement.referenceValue, null);
  assert.equal(measurement.comparison, 'UNMEASURED');
  assert.doesNotThrow(() => validateCompetitiveMeasurement(measurement, {
    expectedMetricId: 'universal-binary-hotpath-ms',
  }));
  const records = collectCompetitiveMeasurements();
  assert.equal(records['universal-binary-hotpath-ms'].status, 'UNMEASURED');
});

test('a complete READY envelope validates and rejects target mutations', () => {
  const capture = syntheticReadyCapture();
  const evidence = benchmarkEvidenceFromReport(canonicalReport(), {
    capture,
    producer: { gitSha: 'f'.repeat(40), treeSha: 'e'.repeat(40) },
  });
  const measurement = {
    schemaVersion: 'hex-competitive-measurement/v1',
    metricId: 'universal-binary-hotpath-ms',
    status: 'MEASURED',
    authority: 'same-binary-twin',
    candidateValue: evidence.candidateValue,
    referenceValue: evidence.referenceValue,
    comparison: evidence.comparison,
    corpusId: evidence.corpusId,
    inputIdentity: `capture_${capture.captureDigest}`,
    referenceTool: evidence.referenceTool,
    referenceVersion: evidence.referenceVersion,
    configuration: 'independent-oracle',
    runPolicy: 'exact',
    captureDigest: capture.captureDigest,
    artifactIdsDigest: capture.denominator.artifactIdsDigest,
    producerGitSha: 'f'.repeat(40),
    producerTreeSha: 'e'.repeat(40),
    denominator: evidence.denominator,
    semanticOracle: evidence.semanticOracle,
    evidenceRefs: evidence.evidenceRefs,
    details: evidence.details,
  };
  assert.doesNotThrow(() => validateCompetitiveMeasurement(measurement, {
    expectedMetricId: measurement.metricId,
    capture,
  }));
  const forged = structuredClone(measurement);
  forged.details.candidateTargets[0].identity.bytes += 1;
  assert.throws(() => validateCompetitiveMeasurement(forged, {
    expectedMetricId: forged.metricId,
    capture,
  }), /benchmark|candidate/);

  const workRegression = structuredClone(measurement);
  workRegression.details.candidateTargets[0].work.totalRequestedBytes = Math.ceil(
    baseline.observations.binary.targets.battlecats.work.totalRequestedBytes * 1.05,
  ) + 1;
  workRegression.denominator.candidateTargets = structuredClone(workRegression.details.candidateTargets);
  const candidateDigest = stableDigest({
    samplesPerTarget: workRegression.details.samplesPerTarget,
    targets: workRegression.details.candidateTargets,
  });
  workRegression.denominator.candidateObservationDigest = candidateDigest;
  workRegression.semanticOracle.candidateObservationDigest = candidateDigest;
  assert.throws(() => validateCompetitiveMeasurement(workRegression, {
    expectedMetricId: workRegression.metricId,
    capture,
  }), /candidate-work-regression/);
});

test('report binding rejects a non-ready or stale capture before values are accepted', () => {
  const report = canonicalReport();
  const blocked = captureBenchmarkTwinWorkload();
  assert.throws(() => benchmarkObservationFromReport(report, { capture: blocked }), /capture-not-ready/);
  const stale = structuredClone(blocked);
  stale.status = 'READY';
  assert.throws(() => benchmarkObservationFromReport(report, { capture: stale }), /capture|identity|schema/);
});
