import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
import profileJson from '../../tools/validation/competitive/profile.json' with { type: 'json' };
import { extractElfFunctionBytes } from '../../tools/validation/phase8/build-corpus.mjs';
import { stableDigest } from '../../js/core/identity/index.js';

function tinyCapture(fixture, { metricId = 'machine-effects-x86_64-coverage', corpusId = fixture.context.corpusId, corpusVersion = fixture.context.corpusVersion, sourceIdentityId = null } = {}) {
  const metadata = {
    ...fixture.context,
    corpusId,
    corpusVersion,
    ...(sourceIdentityId == null ? {} : { sourceIdentity: { ...fixture.context.sourceIdentity, id: sourceIdentityId } }),
  };
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
    const categoryMap = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/phase5/verification/manifests/p5-6-category-map.json'), 'utf8')).categories;
    const categories = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/phase5/corpus/manifest.json'), 'utf8')).mandatoryCategories;
    const ledgerFixture = { id: 'tiny-O0', target: 'tiny-target', targetTriple: 'x86_64-unknown-linux-gnu', optimization: 'O0', abiId: 'sysv-amd64', sha256: artifact.manifest.debugArtifactSha256 };
    const ledger = {
      productSha: 'cede2af69e446fdf628903881eb698c0ccad91f9',
      source: { sha256: fixture.context.sourceIdentity.sha256 },
      fixtures: [ledgerFixture],
      totals: { mandatory: categories.length, passed: categories.length, blocked: 0, notProven: 0 },
      ledger: categories.map((category) => ({ fixture: 'tiny-O0', target: ledgerFixture.target, optimization: ledgerFixture.optimization, category, function: categoryMap[category].symbol, sourceHash: fixture.context.sourceIdentity.sha256, binaryHash: ledgerFixture.sha256, compilerIdentity: fixture.context.compiler.version, status: 'PASS', instructionCount: 1, decodeMismatchCount: 0, completeness: { exact: 1, exactWithIntrinsic: 0, partial: 0, unknown: 0, unsupported: 0 }, pipelineStatus: 'executed', differentialResult: 'LLVM-boundary-match', firstDivergence: null })),
    };
    const measured = measurePhase56Coverage({ metricId: 'machine-effects-x86_64-coverage', capture, ledger });
    assert.equal(measured.status, 'MEASURED');
    assert.equal(measured.candidateValue, 1);
    assert.equal(measured.referenceValue, 1);
    assert.equal(measured.comparison, 'TIE');
    assert.deepEqual(measured.denominator.artifactHashKinds, ['debug']);
    assert.doesNotThrow(() => validateCompetitiveMeasurement(measured, { expectedMetricId: measured.metricId, capture }));
    const forgedValue = structuredClone(measured);
    forgedValue.candidateValue = 999;
    assert.throws(() => validateCompetitiveMeasurement(forgedValue, { expectedMetricId: measured.metricId, capture }), /comparison-forged|denominator-values/);
    const forgedDigest = structuredClone(measured);
    forgedDigest.captureDigest = '0'.repeat(32);
    assert.throws(() => validateCompetitiveMeasurement(forgedDigest, { expectedMetricId: measured.metricId, capture }), /capture-identity-mismatch/);

    const scorecard = await generateCompetitiveScorecard({
      twinCapturesByMetric: { 'machine-effects-x86_64-coverage': capture },
      measurementsByMetric: { 'machine-effects-x86_64-coverage': measured },
    });
    const entry = scorecard.entries.find((row) => row.metricId === 'machine-effects-x86_64-coverage');
    assert.equal(entry.measurement.status, 'MEASURED');
    assert.equal(entry.measurement.candidateValue, 1);
    assert.equal(entry.hexValue, null, 'profile UNMEASURED status must keep active score value null');
    assert.doesNotThrow(() => verifyCompetitiveScorecard(scorecard, undefined, { measurementCapturesByMetric: { 'machine-effects-x86_64-coverage': capture } }));

    const staleMeasurement = structuredClone(measured);
    staleMeasurement.producerGitSha = '0'.repeat(40);
    await assert.rejects(() => generateCompetitiveScorecard({
      twinCapturesByMetric: { 'machine-effects-x86_64-coverage': capture },
      measurementsByMetric: { 'machine-effects-x86_64-coverage': staleMeasurement },
    }), /producer-stale/);

    const mutated = structuredClone(ledger);
    mutated.fixtures[0].sha256 = '0'.repeat(64);
    const blocked = measurePhase56Coverage({ metricId: 'machine-effects-x86_64-coverage', capture, ledger: mutated });
    assert.equal(blocked.status, 'UNMEASURED');
    assert.equal(blocked.candidateValue, null);
    assert.match(blocked.reason, /artifact-hash-mismatch/);

    const omittedCategory = structuredClone(ledger);
    omittedCategory.ledger.pop();
    omittedCategory.totals.mandatory -= 1;
    const denominatorBlocked = measurePhase56Coverage({ metricId: 'machine-effects-x86_64-coverage', capture, ledger: omittedCategory });
    assert.equal(denominatorBlocked.status, 'UNMEASURED');
    assert.match(denominatorBlocked.reason, /canonical-tuple-denominator-mismatch/);

    const candidateOnly = structuredClone(ledger);
    candidateOnly.ledger[0].status = 'FAIL';
    candidateOnly.totals.passed -= 1;
    candidateOnly.totals.failed = 1;
    const oracleIndependent = measurePhase56Coverage({ metricId: 'machine-effects-x86_64-coverage', capture, ledger: candidateOnly });
    assert.equal(oracleIndependent.status, 'MEASURED');
    assert.equal(oracleIndependent.candidateValue, (categories.length - 1) / categories.length);
    assert.equal(oracleIndependent.referenceValue, 1, 'reference value must come from LLVM/Capstone fields, not candidate status');

    const bogusStatus = structuredClone(ledger);
    bogusStatus.ledger[0].status = 'BOGUS-STATUS';
    const statusBlocked = measurePhase56Coverage({ metricId: 'machine-effects-x86_64-coverage', capture, ledger: bogusStatus });
    assert.equal(statusBlocked.status, 'UNMEASURED');
    assert.match(statusBlocked.reason, /row-status-invalid/);
    const wrongRowHash = structuredClone(ledger);
    wrongRowHash.ledger[0].binaryHash = '0'.repeat(64);
    const rowHashBlocked = measurePhase56Coverage({ metricId: 'machine-effects-x86_64-coverage', capture, ledger: wrongRowHash });
    assert.equal(rowHashBlocked.status, 'UNMEASURED');
    assert.match(rowHashBlocked.reason, /row-identity-mismatch/);
    const staleProducer = structuredClone(ledger);
    staleProducer.productSha = '0'.repeat(40);
    const producerBlocked = measurePhase56Coverage({ metricId: 'machine-effects-x86_64-coverage', capture, ledger: staleProducer });
    assert.equal(producerBlocked.status, 'UNMEASURED');
    assert.match(producerBlocked.reason, /producer-head-mismatch/);
  } finally {
    removeTwinFixture(fixture);
  }
});

test('measured binary scorecards require a replayed measurement capture and numeric values', async () => {
  const fixture = buildTwinFixture();
  try {
    const capture = tinyCapture(fixture);
    const artifact = capture.artifacts[0];
    const categoryMap = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/phase5/verification/manifests/p5-6-category-map.json'), 'utf8')).categories;
    const categories = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/phase5/corpus/manifest.json'), 'utf8')).mandatoryCategories;
    const ledgerFixture = { id: 'tiny-O0', target: 'tiny-target', targetTriple: 'x86_64-unknown-linux-gnu', optimization: 'O0', sha256: artifact.manifest.debugArtifactSha256 };
    const ledger = {
      productSha: 'cede2af69e446fdf628903881eb698c0ccad91f9',
      source: { sha256: fixture.context.sourceIdentity.sha256 },
      fixtures: [ledgerFixture],
      totals: { mandatory: categories.length, passed: categories.length, failed: 0, blocked: 0, notProven: 0 },
      ledger: categories.map((category) => ({ fixture: 'tiny-O0', target: ledgerFixture.target, optimization: ledgerFixture.optimization, category, function: categoryMap[category].symbol, sourceHash: fixture.context.sourceIdentity.sha256, binaryHash: ledgerFixture.sha256, compilerIdentity: fixture.context.compiler.version, status: 'PASS', instructionCount: 1, decodeMismatchCount: 0, completeness: { exact: 1, exactWithIntrinsic: 0, partial: 0, unknown: 0, unsupported: 0 }, pipelineStatus: 'executed', differentialResult: 'LLVM-boundary-match', firstDivergence: null })),
    };
    const measurement = measurePhase56Coverage({ metricId: 'machine-effects-x86_64-coverage', capture, ledger });
    const profile = structuredClone(profileJson);
    const metricId = 'machine-effects-x86_64-coverage';
    profile.metrics[metricId].corpusWorkloadIds = [capture.corpusId];
    profile.metrics[metricId].groundTruth = {
      kind: 'binary-corpus',
      authority: 'same-binary-twin',
      status: 'measured',
      binaryScored: true,
      twinManifest: artifact.manifest,
    };
    const scorecard = await generateCompetitiveScorecard({
      profile,
      twinCapturesByMetric: { [metricId]: capture },
      measurementsByMetric: { [metricId]: measurement },
    });
    const evidence = {
      [metricId]: {
        debugArtifactPath: artifact.debugArtifactPath,
        strippedArtifactPath: artifact.strippedArtifactPath,
        expected: artifact.manifest,
      },
    };
    assert.doesNotThrow(() => verifyCompetitiveScorecard(scorecard, profile, {
      measurementCapturesByMetric: { [metricId]: capture },
      twinEvidenceByMetric: evidence,
    }));
    const nullScoreValues = structuredClone(scorecard);
    const nullScoreEntry = nullScoreValues.entries.find((entry) => entry.metricId === metricId);
    nullScoreEntry.hexValue = null;
    nullScoreEntry.referenceValue = null;
    nullScoreEntry.comparison = 'UNMEASURED';
    nullScoreValues.summary = {
      ...nullScoreValues.summary,
      unmeasured: nullScoreValues.summary.unmeasured + 1,
      ties: nullScoreValues.summary.ties - 1,
    };
    assert.throws(() => verifyCompetitiveScorecard(nullScoreValues, profile, {
      measurementCapturesByMetric: { [metricId]: capture },
      twinEvidenceByMetric: evidence,
    }), /binary-measurement-values-required/);

    const missingMeasurement = structuredClone(scorecard);
    delete missingMeasurement.entries.find((entry) => entry.metricId === metricId).measurement;
    assert.throws(() => verifyCompetitiveScorecard(missingMeasurement, profile, { twinEvidenceByMetric: evidence }), /binary-measurement-required/);
    assert.throws(() => verifyCompetitiveScorecard(scorecard, profile, { twinEvidenceByMetric: evidence }), /capture-required/);
  } finally {
    removeTwinFixture(fixture);
  }
});

test('P8 value binding compares the frozen function denominator and keeps metric fields separate', () => {
  const fixture = buildTwinFixture();
  try {
    const functionBytes = Buffer.from(extractElfFunctionBytes(fs.readFileSync(fixture.debug.path), 'twin_add')).toString('hex');
    const corpusDigest = stableDigest('phase8-test-corpus');
    const corpus = {
      corpusId: 'phase8-decompiler-quality-corpus',
      corpusVersion: 2,
      corpusDigest,
      sourceDigest: stableDigest([{ name: 'fixture.c', text: fixture.sourceText }]),
      functions: [{ id: 'f1', source: 'fixture.c', function: 'twin_add', optimization: '-O0', architectureId: 'x86_64', representation: 'machine-bytes', bytes: functionBytes, artifactId: 'tiny-O0' }],
    };
    const baseline = {
      corpusId: corpus.corpusId,
      corpusVersion: corpus.corpusVersion,
      corpusDigest,
      baseCommit: 'b'.repeat(40),
      observationsDigest: stableDigest([{ id: 'f1', semantic: true, readability: { gotos: 3, rawAssemblyFallbacks: 4 } }]),
      observations: [
        { id: 'f1', semantic: true, readability: { gotos: 3, rawAssemblyFallbacks: 4 } },
      ],
    };
    const candidate = [
      { id: 'f1', semantic: true, readability: { gotos: 2, rawAssemblyFallbacks: 3 } },
    ];
    const capture = tinyCapture(fixture, { metricId: 'decompiler-quality-gotos', corpusId: corpus.corpusId, corpusVersion: corpus.corpusVersion, sourceIdentityId: 'fixture.c' });
    const gotos = measurePhase8Quality({ metricId: 'decompiler-quality-gotos', observations: candidate, baseline, corpus, capture, sourceDirectory: fixture.root });
    assert.equal(gotos.status, 'MEASURED');
    assert.equal(gotos.candidateValue, 2);
    assert.equal(gotos.referenceValue, 3);
    assert.equal(gotos.comparison, 'WIN');
    assert.doesNotThrow(() => validateCompetitiveMeasurement(gotos, {
      expectedMetricId: gotos.metricId,
      capture,
    }));
    const partial = measurePhase8Quality({ metricId: 'decompiler-quality-gotos', observations: [{ ...candidate[0], semantic: false }], baseline, corpus, capture, sourceDirectory: fixture.root });
    assert.equal(partial.status, 'UNMEASURED');
    assert.match(partial.reason, /observation-incomplete/);
    const nonfinite = measurePhase8Quality({ metricId: 'decompiler-quality-gotos', observations: [{ ...candidate[0], readability: { ...candidate[0].readability, gotos: Number.NaN } }], baseline, corpus, capture, sourceDirectory: fixture.root });
    assert.equal(nonfinite.status, 'UNMEASURED');
    assert.match(nonfinite.reason, /observation-nonfinite/);
    const fallbacks = measurePhase8Quality({ metricId: 'decompiler-quality-assembly-fallbacks', observations: candidate, baseline, corpus, capture: { ...capture, metricId: 'decompiler-quality-assembly-fallbacks' }, sourceDirectory: fixture.root });
    // Mutating the capture metric without recomputing its digest is rejected;
    // a second metric-specific capture is required for the second score row.
    assert.equal(fallbacks.status, 'UNMEASURED');
    assert.match(fallbacks.reason, /capture-invalid|identity/);

    const mutatedCorpus = structuredClone(corpus);
    mutatedCorpus.functions[0].bytes = `${mutatedCorpus.functions[0].bytes.slice(0, -2)}00`;
    const stale = measurePhase8Quality({ metricId: 'decompiler-quality-gotos', observations: candidate, baseline, corpus: mutatedCorpus, capture, sourceDirectory: fixture.root });
    assert.equal(stale.status, 'UNMEASURED');
    assert.match(stale.reason, /function-bytes-mismatch/);

    const mutatedBaseline = { ...baseline, observationsDigest: '0'.repeat(32) };
    const baselineBlocked = measurePhase8Quality({ metricId: 'decompiler-quality-gotos', observations: candidate, baseline: mutatedBaseline, corpus, capture, sourceDirectory: fixture.root });
    assert.equal(baselineBlocked.status, 'UNMEASURED');
    assert.match(baselineBlocked.reason, /baseline-digest-mismatch/);

    fs.writeFileSync(fixture.source, `${fixture.sourceText}\n/* source drift */\n`);
    const sourceBlocked = measurePhase8Quality({ metricId: 'decompiler-quality-gotos', observations: candidate, baseline, corpus, capture, sourceDirectory: fixture.root });
    assert.equal(sourceBlocked.status, 'UNMEASURED');
    assert.match(sourceBlocked.reason, /source-digest-mismatch/);
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
