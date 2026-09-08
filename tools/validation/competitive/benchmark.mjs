/**
 * Repository-owned universal-binary hot-path benchmark authority.
 *
 * The canonical producer remains tests/universal-binary-benchmark.mjs.  This
 * module binds its complete three-fixture output to the pinned fixture set,
 * same-binary twin capture, and the committed historical reference before a
 * measurement can enter the competitive scorecard.  Missing external binary
 * or debug identity inputs stay unmeasured at the collection boundary.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { stableDigest } from '../../../js/core/identity/index.js';
import { median, validateBaseline } from '../../benchmark/schema.mjs';
import { validateCompetitiveTwinCapture } from './workload-twins.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export const BENCHMARK_METRIC_ID = 'universal-binary-hotpath-ms';
export const BENCHMARK_WORKLOAD_ID = 'benchmark-baseline-real-binaries';
export const BENCHMARK_CORPUS_ID = BENCHMARK_WORKLOAD_ID;
export const BENCHMARK_CORPUS_VERSION = 1;
export const BENCHMARK_RUNNER_PATH = 'tests/universal-binary-benchmark.mjs';
export const BENCHMARK_BASELINE_PATH = 'tests/benchmark-baseline.json';
export const BENCHMARK_FIXTURE_MANIFEST_PATH = 'tests/fixtures/real-binaries.json';
export const BENCHMARK_SCHEMA = 'hex-competitive-benchmark-observation/v1';
export const BENCHMARK_AGGREGATION = 'max-of-target-loader-medians';
export const BENCHMARK_FIXTURE_IDS = Object.freeze(['battlecats', 'TsumTsum', 'YWP']);
const DETERMINISTIC_WORK_METRICS = Object.freeze(['rangeReads', 'totalRequestedBytes']);

const HEX40_RE = /^[0-9a-f]{40}$/i;
const HEX64_RE = /^[0-9a-f]{64}$/i;
const REQUIRED_SAMPLES = 3;

function fail(code, detail = '') {
  throw new TypeError(`competitive-benchmark-${code}${detail ? `:${detail}` : ''}`);
}

function object(value, code) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}

function finite(value, code) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(code);
  return value;
}

function safeInteger(value, code, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) fail(code);
  return value;
}

function text(value, code) {
  if (typeof value !== 'string' || value.trim() === '') fail(code);
  return value.trim();
}

function readJson(relativePath, code) {
  const filePath = path.join(ROOT, relativePath);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(code, `${relativePath}:${error.message}`);
  }
}

function sha256File(relativePath) {
  const filePath = path.join(ROOT, relativePath);
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch (error) {
    fail('source-file-unavailable', `${relativePath}:${error.message}`);
  }
}

function sourceFiles() {
  return [BENCHMARK_RUNNER_PATH, 'tools/benchmark/schema.mjs', BENCHMARK_BASELINE_PATH, BENCHMARK_FIXTURE_MANIFEST_PATH]
    .map((relativePath) => Object.freeze({ path: relativePath, sha256: sha256File(relativePath) }));
}

function exactIds(value, expected, code) {
  if (!Array.isArray(value)) fail(code);
  const observed = [...value].sort();
  const wanted = [...expected].sort();
  if (observed.length !== wanted.length || observed.some((item, index) => item !== wanted[index])) {
    fail(code, `${observed.join(',')}!=${wanted.join(',')}`);
  }
}

function fixtureRowsFromReference(baseline, fixtureManifest, requiredSamples = REQUIRED_SAMPLES) {
  const fixtureIds = Object.keys(fixtureManifest?.fixtures || {});
  exactIds(fixtureIds, BENCHMARK_FIXTURE_IDS, 'fixture-denominator');
  exactIds(Object.keys(baseline?.observations?.binary?.targets || {}), BENCHMARK_FIXTURE_IDS, 'reference-denominator');
  const rows = [];
  for (const id of BENCHMARK_FIXTURE_IDS) {
    const fixture = fixtureManifest.fixtures[id];
    const pinned = baseline.fixtures?.[id];
    if (fixture == null || pinned == null
        || fixture.size !== pinned.size || fixture.sha256 !== pinned.sha256
        || !Number.isSafeInteger(fixture.size) || fixture.size <= 0
        || !HEX64_RE.test(String(fixture.sha256 || ''))) {
      fail('fixture-reference-mismatch', id);
    }
    const target = baseline.observations.binary.targets[id];
    const samples = target?.timing?.loaderMsSamples;
    const value = target?.timing?.loaderMsMedian;
    if (!Array.isArray(samples) || samples.length !== requiredSamples || samples.some((sample) => finite(sample, `reference-sample:${id}`) <= 0)
        || finite(value, `reference-value:${id}`) <= 0
        || Number(value.toFixed(3)) !== Number(median(samples).toFixed(3))) {
      fail('reference-latency-invalid', id);
    }
    const work = object(target.work, `reference-work:${id}`);
    for (const key of ['rangeReads', 'totalRequestedBytes', 'largestSingleRead']) {
      safeInteger(work[key], `reference-work-${key}:${id}`);
    }
    rows.push(Object.freeze({
      id,
      fixture: Object.freeze({ size: fixture.size, sha256: fixture.sha256 }),
      value,
      samples: Object.freeze([...samples]),
      identity: Object.freeze({ ...(target.identity || {}) }),
      work: Object.freeze({ ...work }),
    }));
  }
  return Object.freeze(rows);
}

function deterministicWorkMaxRatio(baseline) {
  const policy = object(baseline.regressionPolicy?.deterministicWork, 'baseline-work-policy');
  if (policy.gate !== 'blocking') fail('baseline-work-policy-gate');
  exactIds(policy.metrics, DETERMINISTIC_WORK_METRICS, 'baseline-work-policy-metrics');
  const ratio = finite(policy.maxRatio, 'baseline-work-policy-ratio');
  if (ratio < 1) fail('baseline-work-policy-ratio');
  return ratio;
}

/** Load and validate the repository-owned benchmark reference and denominator. */
export function loadBenchmarkReference() {
  const baseline = readJson(BENCHMARK_BASELINE_PATH, 'baseline-unavailable');
  const fixtureManifest = readJson(BENCHMARK_FIXTURE_MANIFEST_PATH, 'fixture-manifest-unavailable');
  try { validateBaseline(baseline); } catch (error) { fail('baseline-invalid', error.message); }
  if (!HEX40_RE.test(String(baseline.baseline?.sourceCommit || ''))
      || !HEX40_RE.test(String(baseline.baseline?.sourceTree || ''))) {
    fail('baseline-identity');
  }
  const workMaxRatio = deterministicWorkMaxRatio(baseline);
  const requiredSamples = Math.max(REQUIRED_SAMPLES, baseline.baseline.environment?.binarySamplesPerTarget || 0);
  const referenceTargets = fixtureRowsFromReference(baseline, fixtureManifest, requiredSamples);
  const files = sourceFiles();
  return Object.freeze({
    baselineSourceCommit: baseline.baseline.sourceCommit,
    baselineSourceTree: baseline.baseline.sourceTree,
    baselineDigest: sha256File(BENCHMARK_BASELINE_PATH),
    fixtureManifestDigest: sha256File(BENCHMARK_FIXTURE_MANIFEST_PATH),
    sourceFiles: Object.freeze(files),
    sourceDigest: stableDigest(files),
    fixtureSetDigest: stableDigest(referenceTargets.map((row) => ({ id: row.id, fixture: row.fixture }))),
    referenceTargets,
    requiredSamples,
    deterministicWorkMaxRatio: workMaxRatio,
  });
}

function benchmarkTargetKeys(report) {
  exactIds(Object.keys(report.targets || {}), BENCHMARK_FIXTURE_IDS, 'candidate-denominator');
}

function normalizeCandidateTarget(id, target, reference, samplesPerTarget, workMaxRatio) {
  object(target, `candidate-target:${id}`);
  if (target.fixture?.size !== reference.fixture.size || target.fixture?.sha256 !== reference.fixture.sha256) {
    fail('candidate-fixture-identity', id);
  }
  const samples = target.timing?.loaderMs?.samples;
  const value = target.timing?.loaderMs?.median;
  if (!Array.isArray(samples) || samples.length !== samplesPerTarget || samples.some((sample) => finite(sample, `candidate-sample:${id}`) <= 0)) {
    fail('candidate-samples', id);
  }
  if (finite(value, `candidate-value:${id}`) <= 0 || Number(value.toFixed(3)) !== Number(median(samples).toFixed(3))) {
    fail('candidate-median', id);
  }
  if (target.sourceBacked !== true || target.auditErrors !== 0) fail('candidate-integrity', id);
  // universal-binary-benchmark.mjs emits identity fields on the target row
  // (the committed baseline stores the same fields under `identity`).
  const identity = object({
    bytes: target.bytes,
    format: target.format,
    arch: target.arch,
    sourceBacked: target.sourceBacked,
    sections: target.sections,
    imports: target.imports,
    importSites: target.importSites,
    functionSeeds: target.functionSeeds,
    symbols: target.symbols,
    exports: target.exports,
    auditErrors: target.auditErrors,
    auditWarnings: target.auditWarnings,
  }, `candidate-identity:${id}`);
  for (const key of ['bytes', 'sections', 'imports', 'importSites', 'functionSeeds', 'symbols', 'exports', 'auditErrors', 'auditWarnings']) {
    safeInteger(identity[key], `candidate-identity-${key}:${id}`);
  }
  if (identity.bytes <= 0 || identity.auditErrors !== 0) fail('candidate-identity-values', id);
  text(identity.format, `candidate-format:${id}`);
  text(identity.arch, `candidate-arch:${id}`);
  const work = object(target.work, `candidate-work:${id}`);
  for (const key of ['rangeReads', 'totalRequestedBytes', 'largestSingleRead']) safeInteger(work[key], `candidate-work-${key}:${id}`);
  for (const key of DETERMINISTIC_WORK_METRICS) {
    const limit = Math.ceil(reference.work[key] * workMaxRatio);
    if (work[key] > limit) fail('candidate-work-regression', `${id}:${key}:${work[key]}>${limit}`);
  }
  return Object.freeze({
    id,
    fixture: Object.freeze({ size: target.fixture.size, sha256: target.fixture.sha256 }),
    value,
    samples: Object.freeze([...samples]),
    identity: Object.freeze({ ...identity }),
    work: Object.freeze({ ...work }),
  });
}

function aggregate(rows) {
  return Math.max(...rows.map((row) => row.value));
}

function captureFixtureRows(capture) {
  if (capture?.metricId !== BENCHMARK_METRIC_ID || capture.workloadId !== BENCHMARK_WORKLOAD_ID
      || capture.kind !== 'benchmark-binary' || capture.status !== 'READY') {
    fail('capture-not-ready');
  }
  validateCompetitiveTwinCapture(capture, { replayArtifacts: false, expectedMetricId: BENCHMARK_METRIC_ID });
  exactIds(capture.artifacts.map((artifact) => artifact?.id), BENCHMARK_FIXTURE_IDS, 'capture-denominator');
  if (capture.corpusId !== BENCHMARK_CORPUS_ID || capture.corpusVersion !== BENCHMARK_CORPUS_VERSION) {
    fail('capture-corpus-identity');
  }
  const byId = new Map(capture.artifacts.map((artifact) => [artifact.id, artifact]));
  const reference = loadBenchmarkReference();
  for (const row of reference.referenceTargets) {
    const artifact = byId.get(row.id);
    if (artifact?.manifest?.strippedArtifactSha256 !== row.fixture.sha256) fail('capture-fixture-sha256', row.id);
  }
  return { reference, byId };
}

/** Normalize a complete canonical report against the repository reference. */
export function normalizeBenchmarkReport(report, { reference = loadBenchmarkReference() } = {}) {
  object(report, 'candidate-report');
  if (report.schema !== 1 || report.kind !== 'binary-benchmark') fail('candidate-schema');
  const samplesPerTarget = safeInteger(report.samplesPerTarget, 'candidate-sample-count', { positive: true });
  if (samplesPerTarget < REQUIRED_SAMPLES) fail('candidate-sample-count-too-small');
  if (samplesPerTarget !== reference.requiredSamples) fail('candidate-sample-count-locked', `${samplesPerTarget}!=${reference.requiredSamples}`);
  benchmarkTargetKeys(report);
  const candidateTargets = BENCHMARK_FIXTURE_IDS.map((id) => normalizeCandidateTarget(
    id,
    report.targets[id],
    reference.referenceTargets.find((row) => row.id === id),
    samplesPerTarget,
    reference.deterministicWorkMaxRatio,
  ));
  return Object.freeze({
    samplesPerTarget,
    candidateTargets,
    referenceTargets: reference.referenceTargets,
    candidateValue: aggregate(candidateTargets),
    referenceValue: aggregate(reference.referenceTargets),
    comparison: aggregate(candidateTargets) < aggregate(reference.referenceTargets)
      ? 'WIN'
      : aggregate(candidateTargets) === aggregate(reference.referenceTargets) ? 'TIE' : 'LOSS',
    reference,
    candidateObservationDigest: stableDigest({ samplesPerTarget, targets: candidateTargets }),
    referenceObservationDigest: stableDigest(reference.referenceTargets),
  });
}

/**
 * Normalize one complete canonical benchmark report and bind it to the exact
 * three-fixture capture.  This function has no fallback values and is also
 * used by the measurement verifier to recompute the scalar aggregate.
 */
export function benchmarkObservationFromReport(report, { capture } = {}) {
  const { reference } = captureFixtureRows(capture);
  return normalizeBenchmarkReport(report, { reference });
}

/** Execute the canonical three-fixture producer; callers must gate on READY capture first. */
export function runUniversalBinaryBenchmark({ node = process.execPath, env = process.env } = {}) {
  const result = spawnSync(node, [path.join(ROOT, BENCHMARK_RUNNER_PATH)], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fail('candidate-runner-failed', result.error?.message || result.stderr || String(result.status));
  }
  try { return JSON.parse(result.stdout); } catch (error) { fail('candidate-json-invalid', error.message); }
}

export function benchmarkEvidenceFromReport(report, { capture, producer } = {}) {
  const observation = benchmarkObservationFromReport(report, { capture });
  const { reference } = observation;
  const oracle = Object.freeze({
    schemaVersion: 'hex-competitive-semantic-oracle/v1',
    kind: 'frozen-benchmark-baseline',
    metricField: 'loaderMsMedian',
    aggregation: BENCHMARK_AGGREGATION,
    runnerPath: BENCHMARK_RUNNER_PATH,
    runnerSourceDigest: reference.sourceDigest,
    sourceFiles: reference.sourceFiles,
    baselinePath: BENCHMARK_BASELINE_PATH,
    baselineDigest: reference.baselineDigest,
    baselineSourceCommit: reference.baselineSourceCommit,
    baselineSourceTree: reference.baselineSourceTree,
    fixtureManifestPath: BENCHMARK_FIXTURE_MANIFEST_PATH,
    fixtureManifestDigest: reference.fixtureManifestDigest,
    fixtureSetDigest: reference.fixtureSetDigest,
    fixtureIdsDigest: stableDigest(BENCHMARK_FIXTURE_IDS),
    candidateObservationDigest: observation.candidateObservationDigest,
    referenceObservationDigest: observation.referenceObservationDigest,
  });
  return Object.freeze({
    corpusId: BENCHMARK_CORPUS_ID,
    corpusVersion: BENCHMARK_CORPUS_VERSION,
    candidateValue: observation.candidateValue,
    referenceValue: observation.referenceValue,
    comparison: observation.comparison,
    denominator: Object.freeze({
      kind: 'benchmark-three-fixture',
      artifactCount: BENCHMARK_FIXTURE_IDS.length,
      artifactIds: BENCHMARK_FIXTURE_IDS,
      artifactIdsDigest: capture.denominator.artifactIdsDigest,
      fixtureIdsDigest: stableDigest(BENCHMARK_FIXTURE_IDS),
      fixtureSetDigest: reference.fixtureSetDigest,
      aggregation: BENCHMARK_AGGREGATION,
      samplesPerTarget: observation.samplesPerTarget,
      candidateObservationDigest: observation.candidateObservationDigest,
      referenceObservationDigest: observation.referenceObservationDigest,
      candidateTargets: observation.candidateTargets,
      referenceTargets: observation.referenceTargets,
    }),
    semanticOracle: oracle,
    referenceTool: BENCHMARK_BASELINE_PATH,
    referenceVersion: reference.baselineSourceCommit,
    details: Object.freeze({
      samplesPerTarget: observation.samplesPerTarget,
      aggregation: BENCHMARK_AGGREGATION,
      candidateTargets: observation.candidateTargets,
      referenceTargets: observation.referenceTargets,
    }),
    producer,
    evidenceRefs: Object.freeze([
      BENCHMARK_RUNNER_PATH,
      BENCHMARK_BASELINE_PATH,
      BENCHMARK_FIXTURE_MANIFEST_PATH,
      `fixture-set:${reference.fixtureSetDigest}`,
      `candidate-observations:${observation.candidateObservationDigest}`,
      `reference-observations:${observation.referenceObservationDigest}`,
    ]),
  });
}

function sameDigest(actual, expected, code) {
  if (actual !== expected) fail(code);
}

/** Recheck the benchmark denominator/oracle from a persisted measurement. */
export function validateBenchmarkEvidence(value, { capture } = {}) {
  object(value, 'measurement-object');
  const { reference, byId } = captureFixtureRows(capture);
  if (value.corpusId !== BENCHMARK_CORPUS_ID
      || capture?.corpusId !== BENCHMARK_CORPUS_ID
      || capture?.corpusVersion !== BENCHMARK_CORPUS_VERSION) fail('measurement-corpus-identity');
  if (value.referenceTool !== BENCHMARK_BASELINE_PATH || value.referenceVersion !== reference.baselineSourceCommit) fail('measurement-reference-identity');
  const denominator = object(value.denominator, 'measurement-denominator');
  if (denominator.kind !== 'benchmark-three-fixture' || denominator.aggregation !== BENCHMARK_AGGREGATION
      || denominator.artifactCount !== BENCHMARK_FIXTURE_IDS.length
      || denominator.samplesPerTarget !== reference.requiredSamples) fail('measurement-denominator-shape');
  exactIds(denominator.artifactIds, BENCHMARK_FIXTURE_IDS, 'measurement-artifact-denominator');
  sameDigest(denominator.artifactIdsDigest, capture.denominator.artifactIdsDigest, 'measurement-artifact-digest');
  sameDigest(denominator.fixtureIdsDigest, stableDigest(BENCHMARK_FIXTURE_IDS), 'measurement-fixture-ids-digest');
  sameDigest(denominator.fixtureSetDigest, reference.fixtureSetDigest, 'measurement-fixture-set-digest');
  const details = object(value.details, 'measurement-details');
  if (details.aggregation !== BENCHMARK_AGGREGATION || details.samplesPerTarget !== denominator.samplesPerTarget) fail('measurement-details-shape');
  const candidateTargets = details.candidateTargets;
  const referenceTargets = details.referenceTargets;
  exactIds(candidateTargets?.map((row) => row?.id), BENCHMARK_FIXTURE_IDS, 'measurement-candidate-targets');
  exactIds(referenceTargets?.map((row) => row?.id), BENCHMARK_FIXTURE_IDS, 'measurement-reference-targets');
  const expectedCandidateDigest = stableDigest({ samplesPerTarget: details.samplesPerTarget, targets: candidateTargets });
  const expectedReferenceDigest = stableDigest(referenceTargets);
  sameDigest(denominator.candidateObservationDigest, expectedCandidateDigest, 'measurement-candidate-observation-digest');
  sameDigest(denominator.referenceObservationDigest, expectedReferenceDigest, 'measurement-reference-observation-digest');
  sameDigest(stableDigest(denominator.candidateTargets), stableDigest(candidateTargets), 'measurement-denominator-candidate-targets');
  sameDigest(stableDigest(denominator.referenceTargets), expectedReferenceDigest, 'measurement-denominator-reference-targets');
  sameDigest(expectedReferenceDigest, stableDigest(reference.referenceTargets), 'measurement-reference-values');
  for (const row of candidateTargets) {
    const fixture = reference.referenceTargets.find((candidate) => candidate.id === row.id);
    if (fixture == null || row.fixture?.sha256 !== fixture.fixture.sha256 || byId.get(row.id)?.manifest?.strippedArtifactSha256 !== fixture.fixture.sha256) {
      fail('measurement-candidate-fixture-identity', row.id);
    }
    const rowValue = finite(row.value, `measurement-candidate-value:${row.id}`);
    if (row.samples?.length !== details.samplesPerTarget || row.samples.some((sample) => finite(sample, `measurement-sample:${row.id}`) <= 0)
        || rowValue <= 0 || Number(rowValue.toFixed(3)) !== Number(median(row.samples).toFixed(3))) fail('measurement-candidate-samples', row.id);
  }
  // Replay the persisted normalized rows through the same candidate parser so
  // mutations to identity/work/source-backed fields cannot survive only by
  // preserving the scalar median.
  const replayReport = {
    schema: 1,
    kind: 'binary-benchmark',
    samplesPerTarget: details.samplesPerTarget,
    targets: Object.fromEntries(candidateTargets.map((row) => [row.id, {
      fixture: row.fixture,
      ...row.identity,
      timing: { loaderMs: { samples: row.samples, median: row.value } },
      work: row.work,
    }])),
  };
  let replayed;
  try { replayed = normalizeBenchmarkReport(replayReport, { reference }); }
  catch (error) { fail('measurement-candidate-replay', error.message); }
  sameDigest(stableDigest(replayed.candidateTargets), stableDigest(candidateTargets), 'measurement-candidate-replay-digest');
  for (const [index, row] of referenceTargets.entries()) {
    const expected = reference.referenceTargets[index];
    if (stableDigest(row) !== stableDigest(expected)) fail('measurement-reference-target', row.id);
  }
  if (value.candidateValue !== aggregate(candidateTargets) || value.referenceValue !== aggregate(referenceTargets)) fail('measurement-aggregate');
  const oracle = object(value.semanticOracle, 'measurement-oracle');
  if (oracle.schemaVersion !== 'hex-competitive-semantic-oracle/v1' || oracle.kind !== 'frozen-benchmark-baseline'
      || oracle.metricField !== 'loaderMsMedian' || oracle.aggregation !== BENCHMARK_AGGREGATION) fail('measurement-oracle-shape');
  if (oracle.runnerPath !== BENCHMARK_RUNNER_PATH || oracle.baselinePath !== BENCHMARK_BASELINE_PATH
      || oracle.fixtureManifestPath !== BENCHMARK_FIXTURE_MANIFEST_PATH) fail('measurement-oracle-path');
  sameDigest(oracle.runnerSourceDigest, reference.sourceDigest, 'measurement-oracle-runner-source');
  if (!Array.isArray(oracle.sourceFiles) || stableDigest(oracle.sourceFiles) !== stableDigest(reference.sourceFiles)) {
    fail('measurement-oracle-source-files');
  }
  sameDigest(oracle.baselineDigest, reference.baselineDigest, 'measurement-oracle-baseline');
  sameDigest(oracle.fixtureManifestDigest, reference.fixtureManifestDigest, 'measurement-oracle-fixture-manifest');
  if (oracle.baselineSourceCommit !== reference.baselineSourceCommit || oracle.baselineSourceTree !== reference.baselineSourceTree) fail('measurement-oracle-baseline-identity');
  sameDigest(oracle.fixtureSetDigest, reference.fixtureSetDigest, 'measurement-oracle-fixture-set');
  sameDigest(oracle.fixtureIdsDigest, stableDigest(BENCHMARK_FIXTURE_IDS), 'measurement-oracle-fixture-ids');
  sameDigest(oracle.candidateObservationDigest, expectedCandidateDigest, 'measurement-oracle-candidate');
  sameDigest(oracle.referenceObservationDigest, expectedReferenceDigest, 'measurement-oracle-reference');
  return Object.freeze({ verified: true, artifactCount: BENCHMARK_FIXTURE_IDS.length, candidateValue: value.candidateValue, referenceValue: value.referenceValue });
}
