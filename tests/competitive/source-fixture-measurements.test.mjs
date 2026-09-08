import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  collectCompetitiveSourceMeasurements,
} from '../../tools/validation/competitive/source-fixture.mjs';
import {
  generateCompetitiveScorecardFromRepositoryEvidence,
} from '../../tools/validation/competitive/score.mjs';
import profileJson from '../../tools/validation/competitive/profile.json' with { type: 'json' };

const ALIAS_METRICS = [
  'alias-v2-exact-precision',
  'alias-v2-exact-recall',
  'alias-v2-false-must-alias',
  'alias-v2-false-no-alias',
];
const ARM64_METRIC = 'machine-effects-arm64-coverage';

function writeMeasurements(root, measurements) {
  fs.writeFileSync(path.join(root, 'measurements.json'), `${JSON.stringify(measurements, null, 2)}\n`);
}

function sourceEvidence() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-t026-source-'));
  const measurements = structuredClone(collectCompetitiveSourceMeasurements());
  writeMeasurements(root, measurements);
  return { root, measurements };
}

test('source-fixture evidence promotes all four aliases over the complete V2 query corpus', async () => {
  const evidence = sourceEvidence();
  try {
    const result = await generateCompetitiveScorecardFromRepositoryEvidence({ outputRoot: evidence.root });
    assert.deepEqual(result.scorecard.entries.map((entry) => entry.metricId), profileJson.denominator.metricIds);
    for (const metricId of ALIAS_METRICS) {
      const measurement = evidence.measurements[metricId];
      const entry = result.scorecard.entries.find((candidate) => candidate.metricId === metricId);
      assert.equal(measurement.denominator.queryCount, 30);
      assert.equal(measurement.denominator.queryIdsDigest, measurement.semanticOracle.queryIdsDigest);
      assert.equal(measurement.denominator.truthDigest, measurement.semanticOracle.truthDigest);
      assert.equal(entry.groundTruthStatus, 'measured');
      assert.equal(entry.measurement.status, 'MEASURED');
      assert.equal(entry.hexValue, measurement.candidateValue);
      assert.equal(entry.referenceValue, measurement.referenceValue);
      assert.equal(entry.comparison, measurement.comparison);
    }
    const arm64 = result.scorecard.entries.find((entry) => entry.metricId === ARM64_METRIC);
    assert.equal(evidence.measurements[ARM64_METRIC].status, 'MEASURED');
    assert.equal(arm64.groundTruthStatus, 'measured');
    assert.equal(arm64.measurement.status, 'MEASURED');
    assert.equal(arm64.hexValue, evidence.measurements[ARM64_METRIC].candidateValue);
    assert.equal(arm64.referenceValue, evidence.measurements[ARM64_METRIC].referenceValue);
    assert.equal(arm64.comparison, evidence.measurements[ARM64_METRIC].comparison);
  } finally {
    fs.rmSync(evidence.root, { recursive: true, force: true });
  }
});

test('source-fixture promotion preserves unknown rows and rejects provenance/value/denominator mutations', async () => {
  const missing = sourceEvidence();
  try {
    delete missing.measurements['alias-v2-exact-recall'];
    writeMeasurements(missing.root, missing.measurements);
    const result = await generateCompetitiveScorecardFromRepositoryEvidence({ outputRoot: missing.root });
    const omitted = result.scorecard.entries.find((entry) => entry.metricId === 'alias-v2-exact-recall');
    assert.equal(omitted.groundTruthStatus, 'legacy-unproven');
    assert.equal(omitted.hexValue, null);
    assert.equal(omitted.referenceValue, null);
  } finally {
    fs.rmSync(missing.root, { recursive: true, force: true });
  }

  for (const [label, mutate, pattern] of [
    ['stale producer identity', (row) => { row.producerGitSha = '0'.repeat(40); }, /producer-stale/],
    ['wrong source content identity', (row) => { row.semanticOracle.sourceFiles[0].sha256 = '0'.repeat(64); }, /source-files-mismatch/],
    ['candidate value', (row) => { row.candidateValue += 0.01; }, /comparison-forged|candidate-value-mismatch/],
    ['denominator', (row) => { row.denominator.queryCount += 1; }, /denominator-mismatch|oracle-denominator-mismatch/],
  ]) {
    const evidence = sourceEvidence();
    try {
      mutate(evidence.measurements['alias-v2-exact-precision']);
      writeMeasurements(evidence.root, evidence.measurements);
      await assert.rejects(
        () => generateCompetitiveScorecardFromRepositoryEvidence({ outputRoot: evidence.root }),
        pattern,
        label,
      );
    } finally {
      fs.rmSync(evidence.root, { recursive: true, force: true });
    }
  }

  for (const [label, mutate] of [
    ['ARM64 candidate value', (row) => { row.candidateValue += 0.01; }],
    ['ARM64 denominator', (row) => { row.denominator.rawCaseCount += 1; }],
    ['ARM64 source file', (row) => { row.semanticOracle.sourceFiles[0].sha256 = '0'.repeat(64); }],
  ]) {
    const evidence = sourceEvidence();
    try {
      mutate(evidence.measurements[ARM64_METRIC]);
      writeMeasurements(evidence.root, evidence.measurements);
      await assert.rejects(
        () => generateCompetitiveScorecardFromRepositoryEvidence({ outputRoot: evidence.root }),
        /arm64-provenance-or-value-mismatch/,
        label,
      );
    } finally {
      fs.rmSync(evidence.root, { recursive: true, force: true });
    }
  }
});

test('ARM64 missing evidence remains explicitly unmeasured', async () => {
  const evidence = sourceEvidence();
  try {
    delete evidence.measurements[ARM64_METRIC];
    writeMeasurements(evidence.root, evidence.measurements);
    const result = await generateCompetitiveScorecardFromRepositoryEvidence({ outputRoot: evidence.root });
    const arm64 = result.scorecard.entries.find((entry) => entry.metricId === ARM64_METRIC);
    assert.equal(arm64.groundTruthStatus, 'legacy-unproven');
    assert.equal(arm64.hexValue, null);
    assert.equal(arm64.referenceValue, null);
  } finally {
    fs.rmSync(evidence.root, { recursive: true, force: true });
  }
});
