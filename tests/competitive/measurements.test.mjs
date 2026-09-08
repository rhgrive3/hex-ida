import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  captureTwinArtifacts,
  validateCompetitiveTwinCapture,
} from '../../tools/validation/competitive/workload-twins.mjs';
import { createTwinManifest } from '../../tools/validation/competitive/twin-manifest.mjs';
import {
  comparePhase8Quality,
  measurePhase56Coverage,
  parsePipelineLedgerOutput,
  measurePhase8Quality,
  validatePhase8CaptureLineage,
  validateCompetitiveMeasurement,
} from '../../tools/validation/competitive/measurements.mjs';
import { buildTwinFixture, removeTwinFixture } from './twin-fixture.mjs';
import { currentCompetitiveGitIdentity, generateCompetitiveScorecard } from '../../tools/validation/competitive/score.mjs';
import { verifyCompetitiveScorecard } from '../../tools/validation/competitive/verify.mjs';
import profileJson from '../../tools/validation/competitive/profile.json' with { type: 'json' };
import { extractElfFunctionBytes, loadCorpus } from '../../tools/validation/phase8/build-corpus.mjs';
import { loadFrozenBaseline, loadFrozenProvenance, qualityVector } from '../../tools/validation/phase8/metrics.mjs';
import { stableDigest } from '../../js/core/identity/index.js';

function currentExecutionIdentity() {
  return { ...currentCompetitiveGitIdentity(), sourceStable: true };
}

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

test('P5/P6 ledger parser accepts wrapped Node TAP diagnostics', () => {
  const marker = 'P5_6_PIPELINE_LEDGER=';
  const expected = {
    totals: { mandatory: 1, passed: 1, blocked: 0, notProven: 0 },
    compilerIdentity: 'Ubuntu clang version 18.1.3 (1)\nTarget: x86_64-pc-linux-gnu',
  };
  const tapEscaped = JSON.stringify(expected).replaceAll('\\', '\\\\');
  const splitAt = tapEscaped.indexOf('Target');
  const wrapped = [
    'TAP version 13',
    '# ' + marker + tapEscaped.slice(0, splitAt),
    '# ' + tapEscaped.slice(splitAt),
    '# Subtest: producer',
    '# tests 1',
  ].join('\n');
  assert.deepEqual(parsePipelineLedgerOutput(wrapped, marker), expected);
  assert.deepEqual(parsePipelineLedgerOutput('noise\n' + marker + JSON.stringify(expected) + '\n', marker), expected);
});

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
      executionIdentity: currentExecutionIdentity(),
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
    const historicalLedger = structuredClone(ledger);
    delete historicalLedger.executionIdentity;
    const historical = measurePhase56Coverage({ metricId: 'machine-effects-x86_64-coverage', capture, ledger: historicalLedger });
    assert.equal(historical.status, 'UNMEASURED');
    assert.match(historical.reason, /execution-identity-missing/);
    const staleExecution = structuredClone(ledger);
    staleExecution.executionIdentity.gitSha = '0'.repeat(40);
    const staleExecutionMeasurement = measurePhase56Coverage({ metricId: 'machine-effects-x86_64-coverage', capture, ledger: staleExecution });
    assert.equal(staleExecutionMeasurement.status, 'UNMEASURED');
    assert.match(staleExecutionMeasurement.reason, /execution-identity-stale/);
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
      executionIdentity: currentExecutionIdentity(),
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
    await assert.rejects(() => generateCompetitiveScorecard({
      profile,
      twinCapturesByMetric: { [metricId]: capture },
    }), /measurement-required/);

    const foreignProfile = structuredClone(profile);
    foreignProfile.metrics[metricId].groundTruth.twinManifest = createTwinManifest({
      ...artifact.manifest,
      corpusId: 'foreign-corpus',
    });
    await assert.rejects(() => generateCompetitiveScorecard({
      profile: foreignProfile,
      twinCapturesByMetric: { [metricId]: capture },
      measurementsByMetric: { [metricId]: measurement },
    }), /twin-manifest-mismatch/);

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

test('P8 reference binding requires the committed baseline/provenance authority', () => {
  const baseline = loadFrozenBaseline();
  const provenance = loadFrozenProvenance(undefined, baseline);
  const corpus = loadCorpus();

  const productionPath = measurePhase8Quality({
    metricId: 'decompiler-quality-gotos',
    observations: [],
    baseline: structuredClone(baseline),
    provenance: structuredClone(provenance),
    corpus: structuredClone(corpus),
  });
  assert.equal(productionPath.status, 'UNMEASURED');
  assert.equal(productionPath.reason, 'twin-capture-missing', 'canonical production references must remain usable by the collector');

  const wrongHead = structuredClone(baseline);
  wrongHead.baseCommit = '0'.repeat(40);
  const wrongHeadResult = measurePhase8Quality({ metricId: 'decompiler-quality-gotos', observations: [], baseline: wrongHead, corpus });
  assert.equal(wrongHeadResult.status, 'UNMEASURED');
  assert.match(wrongHeadResult.reason, /frozen-baseline-authority-mismatch/);

  const changedBaseline = structuredClone(baseline);
  const changedObservation = changedBaseline.observations.find((observation) => observation.semantic === true);
  changedObservation.readability.gotos += 1;
  changedBaseline.observationsDigest = stableDigest(changedBaseline.observations);
  const changedBaselineResult = measurePhase8Quality({ metricId: 'decompiler-quality-gotos', observations: [], baseline: changedBaseline, corpus });
  assert.equal(changedBaselineResult.status, 'UNMEASURED');
  assert.match(changedBaselineResult.reason, /frozen-baseline-authority-mismatch/);

  const malformedCounts = structuredClone(baseline);
  const malformedObservation = malformedCounts.observations.find((observation) => observation.semantic === true);
  malformedObservation.readability.gotos = -1;
  malformedCounts.observationsDigest = stableDigest(malformedCounts.observations);
  const malformedResult = measurePhase8Quality({ metricId: 'decompiler-quality-gotos', observations: [], baseline: malformedCounts, corpus });
  assert.equal(malformedResult.status, 'UNMEASURED');
  assert.match(malformedResult.reason, /frozen-baseline-authority-mismatch/);

  const wrongProvenance = structuredClone(provenance);
  wrongProvenance.observations[0].available = !wrongProvenance.observations[0].available;
  wrongProvenance.observationsDigest = stableDigest(wrongProvenance.observations);
  const wrongProvenanceResult = measurePhase8Quality({
    metricId: 'decompiler-quality-gotos',
    observations: [],
    baseline,
    provenance: wrongProvenance,
    corpus,
  });
  assert.equal(wrongProvenanceResult.status, 'UNMEASURED');
  assert.match(wrongProvenanceResult.reason, /frozen-provenance-authority-mismatch/);

  const changedCorpus = structuredClone(corpus);
  changedCorpus.functions[0].id = `${changedCorpus.functions[0].id}.changed`;
  const changedCorpusResult = measurePhase8Quality({ metricId: 'decompiler-quality-gotos', observations: [], baseline, corpus: changedCorpus });
  assert.equal(changedCorpusResult.status, 'UNMEASURED');
  assert.match(changedCorpusResult.reason, /frozen-corpus-authority-mismatch/);

  // The historical baseline is intentionally incomplete.  The candidate
  // completeness rule must not be applied to those rows while the reference
  // itself remains bound to the immutable file above.
  assert.ok(baseline.observations.some((observation) => observation.semantic === false));
});

test('P8 comparison and capture-lineage helpers retain fixture coverage', () => {
  const fixture = buildTwinFixture();
  try {
    const functionBytes = Buffer.from(extractElfFunctionBytes(fs.readFileSync(fixture.debug.path), 'twin_add')).toString('hex');
    const corpus = {
      corpusId: 'phase8-decompiler-quality-corpus',
      corpusVersion: 2,
      corpusDigest: stableDigest('phase8-test-corpus'),
      sourceDigest: stableDigest([{ name: 'fixture.c', text: fixture.sourceText }]),
      functions: [{ id: 'f1', source: 'fixture.c', function: 'twin_add', optimization: '-O0', architectureId: 'x86_64', representation: 'machine-bytes', bytes: functionBytes, artifactId: 'tiny-O0' }],
    };
    const baselineObservations = [
      { id: 'f1', semantic: true, readability: { gotos: 3, rawAssemblyFallbacks: 4 } },
    ];
    const candidate = [
      { id: 'f1', semantic: true, readability: { gotos: 2, rawAssemblyFallbacks: 3 } },
    ];
    const gotos = comparePhase8Quality({
      metricId: 'decompiler-quality-gotos',
      observations: candidate,
      baselineObservations,
      expectedFunctionIds: ['f1'],
    });
    assert.equal(gotos.ok, true);
    assert.equal(gotos.candidateValue, 2);
    assert.equal(gotos.referenceValue, 3);
    assert.equal(gotos.comparison, 'WIN');
    const fallbacks = comparePhase8Quality({
      metricId: 'decompiler-quality-assembly-fallbacks',
      observations: candidate,
      baselineObservations,
      expectedFunctionIds: ['f1'],
    });
    assert.equal(fallbacks.ok, true);
    assert.equal(fallbacks.candidateValue, 3);
    assert.equal(fallbacks.referenceValue, 4);
    assert.equal(fallbacks.comparison, 'WIN');

    const partial = comparePhase8Quality({
      metricId: 'decompiler-quality-gotos',
      observations: [{ ...candidate[0], semantic: false }],
      baselineObservations,
      expectedFunctionIds: ['f1'],
    });
    assert.equal(partial.ok, false);
    assert.match(partial.reason, /observation-incomplete/);
    const nonfinite = comparePhase8Quality({
      metricId: 'decompiler-quality-gotos',
      observations: [{ ...candidate[0], readability: { ...candidate[0].readability, gotos: Number.NaN } }],
      baselineObservations,
      expectedFunctionIds: ['f1'],
    });
    assert.equal(nonfinite.ok, false);
    assert.match(nonfinite.reason, /observation-nonfinite/);

    const capture = tinyCapture(fixture, {
      metricId: 'decompiler-quality-gotos',
      corpusId: corpus.corpusId,
      corpusVersion: corpus.corpusVersion,
      sourceIdentityId: 'fixture.c',
    });
    assert.deepEqual(validatePhase8CaptureLineage(corpus, capture, { sourceDirectory: fixture.root }), {
      ok: true,
      sourceDigest: corpus.sourceDigest,
      functionCount: 1,
      functionIdsDigest: stableDigest(['f1']),
      machineFunctionCount: 1,
      machineFunctionBytesDigest: stableDigest([{ id: 'f1', sha256: crypto.createHash('sha256').update(Buffer.from(functionBytes, 'hex')).digest('hex') }]),
      machineArtifactIdsDigest: stableDigest(['tiny-O0']),
      nativeArtifactIdsDigest: stableDigest([]),
    });

    const mutatedCorpus = structuredClone(corpus);
    mutatedCorpus.functions[0].bytes = `${mutatedCorpus.functions[0].bytes.slice(0, -2)}00`;
    const stale = validatePhase8CaptureLineage(mutatedCorpus, capture, { sourceDirectory: fixture.root });
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, 'phase8-capture-function-bytes-mismatch');

    fs.writeFileSync(fixture.source, `${fixture.sourceText}\n/* source drift */\n`);
    const sourceBlocked = validatePhase8CaptureLineage(corpus, capture, { sourceDirectory: fixture.root });
    assert.equal(sourceBlocked.ok, false);
    assert.equal(sourceBlocked.reason, 'phase8-corpus-source-digest-mismatch');
  } finally {
    removeTwinFixture(fixture);
  }
});

const trustedP8CaptureFixture = process.env.HEX_COMPETITIVE_P8_CAPTURE_FIXTURE;
test('P8 integrated measurement accepts the canonical frozen reference', { skip: trustedP8CaptureFixture == null ? 'trusted P8 capture fixture not configured' : false }, () => {
  const baseline = loadFrozenBaseline();
  const candidate = baseline.observations.map((observation) => ({
    ...observation,
    failure: null,
    semantic: true,
    readability: {
      ...observation.readability,
      gotos: Number.isSafeInteger(observation.readability?.gotos) ? observation.readability.gotos : 0,
      rawAssemblyFallbacks: Number.isSafeInteger(observation.readability?.rawAssemblyFallbacks) ? observation.readability.rawAssemblyFallbacks : 0,
    },
  }));
  const capture = JSON.parse(fs.readFileSync(trustedP8CaptureFixture, 'utf8'));
  const measured = measurePhase8Quality({ metricId: 'decompiler-quality-gotos', observations: candidate, capture });
  assert.equal(measured.status, 'MEASURED');
  const frozenReferenceGotos = qualityVector(baseline.observations).gotos;
  assert.equal(measured.referenceValue, frozenReferenceGotos);
  assert.equal(measured.candidateValue, frozenReferenceGotos);
  assert.equal(measured.comparison, 'TIE');
  assert.doesNotThrow(() => validateCompetitiveMeasurement(measured, { expectedMetricId: measured.metricId, capture }));
  const forgedReference = structuredClone(measured);
  forgedReference.referenceValue += 1;
  forgedReference.comparison = 'WIN';
  forgedReference.referenceQuality.gotos += 1;
  assert.throws(() => validateCompetitiveMeasurement(forgedReference, {
    expectedMetricId: measured.metricId,
    capture,
  }), /frozen-baseline-value/);
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
