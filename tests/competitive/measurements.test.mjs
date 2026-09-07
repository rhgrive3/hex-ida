import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureTwinArtifacts,
  validateCompetitiveTwinCapture,
} from '../../tools/validation/competitive/workload-twins.mjs';
import {
  measurePhase56Coverage,
  measurePhase8Quality,
  validateCompetitiveMeasurement,
} from '../../tools/validation/competitive/measurements.mjs';
import { buildTwinFixture, removeTwinFixture } from './twin-fixture.mjs';
import { generateCompetitiveScorecard } from '../../tools/validation/competitive/score.mjs';
import { verifyCompetitiveScorecard } from '../../tools/validation/competitive/verify.mjs';

function tinyCapture(fixture, { metricId = 'machine-effects-x86_64-coverage', corpusId = fixture.context.corpusId, corpusVersion = fixture.context.corpusVersion } = {}) {
  const metadata = { ...fixture.context, corpusId, corpusVersion };
  return captureTwinArtifacts({
    metricId,
    workloadId: 'test-p56-tiny-corpus',
    producer: 'tests/competitive/measurements.test.mjs',
    kind: 'compiler-corpus',
    corpusId,
    corpusVersion,
    artifactRoot: fixture.root,
    stripTool: fixture.stripTool,
    stripCandidates: [fixture.stripTool],
    artifacts: [{ id: 'tiny-O0', path: fixture.debug.path, metadata }],
  });
}

test('P5/P6 value binding requires the exact captured artifact bytes', async () => {
  const fixture = buildTwinFixture();
  try {
    const capture = tinyCapture(fixture);
    assert.doesNotThrow(() => validateCompetitiveTwinCapture(capture, { replayArtifacts: true }));
    const artifact = capture.artifacts[0];
    const ledger = {
      source: { sha256: fixture.context.sourceIdentity.sha256 },
      fixtures: [{ id: 'tiny-O0', sha256: artifact.manifest.debugArtifactSha256 }],
      totals: { mandatory: 1, passed: 1, blocked: 0, notProven: 0 },
      ledger: [{ fixture: 'tiny-O0', category: 'tiny', status: 'PASS', instructionCount: 1, decodeMismatchCount: 0 }],
    };
    const measured = measurePhase56Coverage({ metricId: 'machine-effects-x86_64-coverage', capture, ledger });
    assert.equal(measured.status, 'MEASURED');
    assert.equal(measured.candidateValue, 1);
    assert.equal(measured.referenceValue, 1);
    assert.equal(measured.comparison, 'TIE');
    assert.deepEqual(measured.denominator.artifactHashKinds, ['debug']);

    const scorecard = await generateCompetitiveScorecard({
      twinCapturesByMetric: { 'machine-effects-x86_64-coverage': capture },
      measurementsByMetric: { 'machine-effects-x86_64-coverage': measured },
    });
    const entry = scorecard.entries.find((row) => row.metricId === 'machine-effects-x86_64-coverage');
    assert.equal(entry.measurement.status, 'MEASURED');
    assert.equal(entry.measurement.candidateValue, 1);
    assert.equal(entry.hexValue, null, 'profile UNMEASURED status must keep active score value null');
    assert.doesNotThrow(() => verifyCompetitiveScorecard(scorecard));

    const mutated = structuredClone(ledger);
    mutated.fixtures[0].sha256 = '0'.repeat(64);
    const blocked = measurePhase56Coverage({ metricId: 'machine-effects-x86_64-coverage', capture, ledger: mutated });
    assert.equal(blocked.status, 'UNMEASURED');
    assert.equal(blocked.candidateValue, null);
    assert.match(blocked.reason, /artifact-hash-mismatch/);
  } finally {
    removeTwinFixture(fixture);
  }
});

test('P8 value binding compares the frozen function denominator and keeps metric fields separate', () => {
  const fixture = buildTwinFixture();
  try {
    const corpus = {
      corpusId: 'phase8-decompiler-quality-corpus',
      corpusVersion: 2,
      corpusDigest: 'phase8-test-corpus',
      functions: [{ id: 'f1' }, { id: 'f2' }],
    };
    const baseline = {
      corpusId: corpus.corpusId,
      corpusVersion: corpus.corpusVersion,
      corpusDigest: corpus.corpusDigest,
      baseCommit: 'b'.repeat(40),
      observationsDigest: 'baseline-observations',
      observations: [
        { id: 'f1', semantic: true, readability: { gotos: 3, rawAssemblyFallbacks: 4 } },
        { id: 'f2', semantic: true, readability: { gotos: 1, rawAssemblyFallbacks: 2 } },
      ],
    };
    const candidate = [
      { id: 'f1', semantic: true, readability: { gotos: 2, rawAssemblyFallbacks: 3 } },
      { id: 'f2', semantic: true, readability: { gotos: 1, rawAssemblyFallbacks: 1 } },
    ];
    const capture = tinyCapture(fixture, { metricId: 'decompiler-quality-gotos', corpusId: corpus.corpusId, corpusVersion: corpus.corpusVersion });
    const gotos = measurePhase8Quality({ metricId: 'decompiler-quality-gotos', observations: candidate, baseline, corpus, capture });
    assert.equal(gotos.status, 'MEASURED');
    assert.equal(gotos.candidateValue, 3);
    assert.equal(gotos.referenceValue, 4);
    assert.equal(gotos.comparison, 'WIN');
    const fallbacks = measurePhase8Quality({ metricId: 'decompiler-quality-assembly-fallbacks', observations: candidate, baseline, corpus, capture: { ...capture, metricId: 'decompiler-quality-assembly-fallbacks' } });
    // Mutating the capture metric without recomputing its digest is rejected;
    // a second metric-specific capture is required for the second score row.
    assert.equal(fallbacks.status, 'UNMEASURED');
    assert.match(fallbacks.reason, /capture-invalid|identity/);
  } finally {
    removeTwinFixture(fixture);
  }
});

test('measurement validation keeps unmeasured values null and rejects forged measured envelopes', () => {
  const unmeasured = {
    schemaVersion: 'hex-competitive-measurement/v1',
    metricId: 'decompiler-quality-gotos',
    status: 'UNMEASURED',
    authority: 'same-binary-twin',
    candidateValue: null,
    referenceValue: null,
    comparison: 'UNMEASURED',
    corpusId: null,
    inputIdentity: 'unmeasured:decompiler-quality-gotos',
    referenceTool: 'unmeasured',
    referenceVersion: 'unmeasured',
    configuration: 'independent-oracle',
    runPolicy: 'exact',
    captureDigest: null,
    artifactIdsDigest: null,
    denominator: null,
    semanticOracle: null,
    evidenceRefs: [],
    reason: 'fixture-not-captured',
  };
  assert.doesNotThrow(() => validateCompetitiveMeasurement(unmeasured, { expectedMetricId: unmeasured.metricId }));
  const forged = { ...unmeasured, status: 'MEASURED', candidateValue: 1, referenceValue: 1, comparison: 'TIE' };
  assert.throws(() => validateCompetitiveMeasurement(forged), /measured-values|identity|denominator|oracle/);
});
