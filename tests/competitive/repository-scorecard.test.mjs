import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { captureTwinArtifacts } from '../../tools/validation/competitive/workload-twins.mjs';
import { measurePhase56Coverage } from '../../tools/validation/competitive/measurements.mjs';
import {
  currentCompetitiveGitIdentity,
  generateCompetitiveScorecardFromRepositoryEvidence,
} from '../../tools/validation/competitive/score.mjs';
import profileJson from '../../tools/validation/competitive/profile.json' with { type: 'json' };
import { buildTwinFixture, removeTwinFixture } from './twin-fixture.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const METRIC_ID = 'machine-effects-x86_64-coverage';

function tinyCapture(fixture) {
  return captureTwinArtifacts({
    metricId: METRIC_ID,
    workloadId: 'test-p56-tiny-corpus',
    producer: 'tests/competitive/repository-scorecard.test.mjs',
    kind: 'compiler-corpus',
    corpusId: fixture.context.corpusId,
    corpusVersion: fixture.context.corpusVersion,
    artifactRoot: fixture.root,
    stripTool: fixture.stripTool,
    stripCandidates: [fixture.stripTool],
    artifacts: [{ id: 'tiny-O0', path: fixture.debug.path, metadata: fixture.context }],
  });
}

function measuredLedger(fixture, capture) {
  const categoryMap = JSON.parse(fs.readFileSync(
    path.join(REPOSITORY_ROOT, 'tests/phase5/verification/manifests/p5-6-category-map.json'),
    'utf8',
  )).categories;
  const categories = JSON.parse(fs.readFileSync(
    path.join(REPOSITORY_ROOT, 'tests/phase5/corpus/manifest.json'),
    'utf8',
  )).mandatoryCategories;
  const artifact = capture.artifacts[0];
  const ledgerFixture = {
    id: artifact.id,
    target: 'tiny-target',
    targetTriple: 'x86_64-unknown-linux-gnu',
    optimization: 'O0',
    abiId: 'sysv-amd64',
    sha256: artifact.manifest.debugArtifactSha256,
  };
  return {
    productSha: 'cede2af69e446fdf628903881eb698c0ccad91f9',
    executionIdentity: { ...currentCompetitiveGitIdentity(), sourceStable: true },
    source: { sha256: fixture.context.sourceIdentity.sha256 },
    fixtures: [ledgerFixture],
    totals: { mandatory: categories.length, passed: categories.length, blocked: 0, notProven: 0 },
    ledger: categories.map((category) => ({
      fixture: artifact.id,
      target: ledgerFixture.target,
      optimization: ledgerFixture.optimization,
      category,
      function: categoryMap[category].symbol,
      sourceHash: fixture.context.sourceIdentity.sha256,
      binaryHash: ledgerFixture.sha256,
      compilerIdentity: fixture.context.compiler.version,
      status: 'PASS',
      instructionCount: 1,
      decodeMismatchCount: 0,
      completeness: { exact: 1, exactWithIntrinsic: 0, partial: 0, unknown: 0, unsupported: 0 },
      pipelineStatus: 'executed',
      differentialResult: 'LLVM-boundary-match',
      firstDivergence: null,
    })),
  };
}

function writeEvidence(root, { capture, measurement }) {
  fs.writeFileSync(path.join(root, 'p5-capture.json'), `${JSON.stringify(capture, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'measurements.json'), `${JSON.stringify({ [METRIC_ID]: measurement }, null, 2)}\n`);
}

function makeEvidence() {
  const fixture = buildTwinFixture();
  const capture = tinyCapture(fixture);
  const measurement = measurePhase56Coverage({
    metricId: METRIC_ID,
    capture,
    ledger: measuredLedger(fixture, capture),
  });
  assert.equal(measurement.status, 'MEASURED');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-t026-scorecard-'));
  writeEvidence(root, { capture, measurement });
  return { fixture, capture, measurement, root };
}

test('repository evidence promotes validated binary rows and preserves the frozen denominator', async () => {
  const evidence = makeEvidence();
  try {
    const result = await generateCompetitiveScorecardFromRepositoryEvidence({ outputRoot: evidence.root });
    const ids = result.scorecard.entries.map((entry) => entry.metricId);
    assert.deepEqual(ids, profileJson.denominator.metricIds);
    assert.equal(result.scorecard.entries.length, 10);
    const measuredEntry = result.scorecard.entries.find((entry) => entry.metricId === METRIC_ID);
    assert.equal(measuredEntry.groundTruthStatus, 'measured');
    assert.equal(measuredEntry.hexValue, evidence.measurement.candidateValue);
    assert.equal(measuredEntry.referenceValue, evidence.measurement.referenceValue);
    assert.equal(result.profile.metrics[METRIC_ID].corpusWorkloadIds[0], evidence.capture.corpusId);
    assert.equal(profileJson.metrics[METRIC_ID].groundTruth.status, 'UNMEASURED', 'static profile must remain unchanged');
    assert.equal(result.profile.metrics[METRIC_ID].regressionTolerance, profileJson.metrics[METRIC_ID].regressionTolerance);
    assert.equal(result.scorecard.summary.totalMetrics, 10);
    assert.equal(result.scorecard.summary.unmeasured, 9);
    assert.deepEqual(result.verification, { verified: true, totalEntries: 10, unmeasured: 9 });
  } finally {
    removeTwinFixture(evidence.fixture);
    fs.rmSync(evidence.root, { recursive: true, force: true });
  }
});

test('repository evidence rejects missing, stale, mutated, and wrongly keyed inputs', async () => {
  const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-t026-missing-'));
  try {
    await assert.rejects(
      () => generateCompetitiveScorecardFromRepositoryEvidence({ outputRoot: missingRoot }),
      /measurements-missing/,
    );
  } finally {
    fs.rmSync(missingRoot, { recursive: true, force: true });
  }

  const evidence = makeEvidence();
  try {
    const stale = structuredClone(evidence.measurement);
    stale.producerGitSha = '0'.repeat(40);
    writeEvidence(evidence.root, { capture: evidence.capture, measurement: stale });
    await assert.rejects(
      () => generateCompetitiveScorecardFromRepositoryEvidence({ outputRoot: evidence.root }),
      /producer-stale/,
    );

    const mutatedCapture = structuredClone(evidence.capture);
    mutatedCapture.artifacts[0].manifest.debugArtifactSha256 = '0'.repeat(64);
    writeEvidence(evidence.root, { capture: mutatedCapture, measurement: evidence.measurement });
    await assert.rejects(
      () => generateCompetitiveScorecardFromRepositoryEvidence({ outputRoot: evidence.root }),
      /capture-(identity-digest|replay|identity-mismatch)/,
    );

    const wrongMetric = structuredClone(evidence.measurement);
    writeEvidence(evidence.root, { capture: evidence.capture, measurement: wrongMetric });
    fs.writeFileSync(path.join(evidence.root, 'measurements.json'), JSON.stringify({
      'machine-effects-riscv64-coverage': wrongMetric,
    }));
    await assert.rejects(
      () => generateCompetitiveScorecardFromRepositoryEvidence({ outputRoot: evidence.root }),
      /metric-mismatch/,
    );

    writeEvidence(evidence.root, { capture: evidence.capture, measurement: evidence.measurement });
    const nonCanonicalProfile = structuredClone(profileJson);
    nonCanonicalProfile.metrics[METRIC_ID].regressionTolerance += 1;
    await assert.rejects(
      () => generateCompetitiveScorecardFromRepositoryEvidence({
        outputRoot: evidence.root,
        profile: nonCanonicalProfile,
      }),
      /profile-not-canonical/,
    );
  } finally {
    removeTwinFixture(evidence.fixture);
    fs.rmSync(evidence.root, { recursive: true, force: true });
  }
});
