import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import '../../../js/targets/architecture/index.js';
import { stableDigest } from '../../../js/core/identity/index.js';
import { ALIAS_QUERIES_V2, buildFixture, memoryAccessOf, regionOf, scoreAliasQueriesV2 } from '../phase7/scoring.mjs';
import { createPhase7AliasSolver } from '../../../js/analysis/alias/solver.js';
import { aliasMemoryRegions } from '../../../js/analysis/alias/legacy-safety-floor.js';
import { measureMachineEffectsCoverage } from '../../../js/targets/architecture/coverage.js';
import { validateTwinManifest } from './twin-manifest.mjs';
import { competitiveTwinWorkloadFor, validateCompetitiveTwinCapture } from './workload-twins.mjs';
import { captureContainsTwinManifest, validateCompetitiveMeasurement } from './measurements.mjs';
import { verifyCompetitiveProfile, verifyCompetitiveScorecard } from './verify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROFILE_PATH = path.join(ROOT, 'tools/validation/competitive/profile.json');
const REPORT_DIR = path.join(ROOT, 'reports/competitive');
const SCORECARD_PATH = path.join(REPORT_DIR, 'scorecard.json');
const REPOSITORY_CAPTURE_FILES = Object.freeze({
  'machine-effects-x86_64-coverage': 'p5-capture.json',
  'machine-effects-riscv64-coverage': 'p6-capture.json',
  'decompiler-quality-gotos': 'p8-gotos-capture.json',
  'decompiler-quality-assembly-fallbacks': 'p8-fallbacks-capture.json',
});
const SHARED_PHASE8_CAPTURE_METRIC = 'decompiler-quality-gotos';
const SHARED_PHASE8_FALLBACK_METRIC = 'decompiler-quality-assembly-fallbacks';

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', shell: false });
  const value = result.stdout?.trim() || '';
  if (result.error || result.status !== 0 || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`competitive-git-identity-unavailable:${args.join(' ')}`);
  }
  return value.toLowerCase();
}
export function currentCompetitiveGitIdentity() {
  return Object.freeze({
    gitSha: git(['rev-parse', 'HEAD']),
    treeSha: git(['rev-parse', 'HEAD^{tree}']),
  });
}
export function loadCompetitiveProfile() {
  if (!fs.existsSync(PROFILE_PATH)) throw new Error('competitive-profile-missing');
  return JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
}

function metricConfig(profile, metricId) {
  const config = profile.metrics?.[metricId];
  if (!config) throw new Error(`competitive-profile-metric-missing:${metricId}`);
  if (!config.groundTruth || typeof config.groundTruth !== 'object') {
    throw new Error(`competitive-profile-ground-truth-missing:${metricId}`);
  }
  return config;
}

function groundTruthFor(config, metricId) {
  const groundTruth = config.groundTruth;
  const allowedStatuses = new Set(['measured', 'legacy-unproven', 'UNMEASURED']);
  if (!allowedStatuses.has(groundTruth.status)) throw new Error(`competitive-profile-ground-truth-status-invalid:${metricId}`);
  if (typeof groundTruth.authority !== 'string' || !groundTruth.authority.trim()) throw new Error(`competitive-profile-ground-truth-authority-missing:${metricId}`);
  if (['competitor', 'hex', 'reference-tool'].includes(groundTruth.authority.toLowerCase())) {
    throw new Error(`competitive-profile-ground-truth-authority-forbidden:${metricId}`);
  }
  if (groundTruth.binaryScored === true && groundTruth.status === 'measured') {
    if (groundTruth.authority !== 'same-binary-twin') throw new Error(`competitive-profile-binary-ground-truth-authority:${metricId}`);
    if (groundTruth.twinManifest?.schemaVersion !== 'hex-competitive-twin-manifest/v1') {
      throw new Error(`competitive-profile-twin-manifest-full-required:${metricId}`);
    }
    try { validateTwinManifest(groundTruth.twinManifest); } catch (error) {
      throw new Error(`competitive-profile-twin-manifest-invalid:${metricId}:${error.message}`);
    }
  }
  if (groundTruth.binaryScored !== true && groundTruth.twinManifest != null) {
    throw new Error(`competitive-profile-nonbinary-twin-manifest:${metricId}`);
  }
  return {
    kind: String(groundTruth.kind || 'unspecified'),
    authority: groundTruth.authority,
    status: groundTruth.status,
    binaryScored: groundTruth.binaryScored === true,
    twinManifest: groundTruth.twinManifest ?? null,
  };
}

function comparisonFor(metricConfigValue, hexValue, referenceValue) {
  if (hexValue == null || referenceValue == null) return 'UNMEASURED';
  if (metricConfigValue.direction === 'exact-zero') {
    if (hexValue === 0 && referenceValue === 0) return 'TIE';
    if (hexValue === 0 && referenceValue > 0) return 'WIN';
    if (hexValue > 0) return 'LOSS';
    return 'TIE';
  }
  if (metricConfigValue.direction === 'higher') {
    if (hexValue > referenceValue) return 'WIN';
    if (hexValue === referenceValue) return 'TIE';
    return 'LOSS';
  }
  if (metricConfigValue.direction === 'lower') {
    if (hexValue < referenceValue) return 'WIN';
    if (hexValue === referenceValue) return 'TIE';
    return 'LOSS';
  }
  return 'UNMEASURED';
}

function runPolicyFor(config) {
  const policy = config.repetitionPolicy;
  if (!policy) return 'unmeasured';
  if (policy.coldWarm === 'both') return 'cold-and-warm';
  if (policy.coldWarm === 'none') return 'exact';
  return String(policy.coldWarm || 'exact');
}

function makeEntry(profile, metricId, fields) {
  const config = metricConfig(profile, metricId);
  const groundTruth = groundTruthFor(config, metricId);
  const measurement = fields.measurement ?? null;
  const hexValue = fields.hexValue ?? measurement?.candidateValue ?? null;
  const referenceValue = fields.referenceValue ?? measurement?.referenceValue ?? null;
  const historicalComparison = comparisonFor(config, hexValue, referenceValue);
  // Historical synthetic rows retain their old values only in an explicitly
  // non-authoritative object. Active UNMEASURED values must remain null.
  const comparable = groundTruth.status === 'measured'
    && (groundTruth.binaryScored === false || groundTruth.twinManifest != null);
  const comparison = comparable ? historicalComparison : 'UNMEASURED';
  const historical = comparable || (hexValue == null && referenceValue == null && historicalComparison === 'UNMEASURED')
    ? null
    : {
      nonAuthoritative: true,
      hexValue,
      referenceValue,
      comparison: historicalComparison,
    };
  return {
    metricId,
    corpusId: fields.corpusId ?? config.corpusWorkloadIds?.[0] ?? metricId,
    inputIdentity: fields.inputIdentity ?? measurement?.inputIdentity ?? `profile:${metricId}`,
    functionIdentity: fields.functionIdentity ?? null,
    hexVersion: fields.hexVersion,
    referenceTool: fields.referenceTool ?? measurement?.referenceTool ?? 'unmeasured',
    referenceVersion: fields.referenceVersion ?? measurement?.referenceVersion ?? 'unmeasured',
    configuration: fields.configuration ?? 'profile-default',
    runtimeClass: profile.runtimeHardwareClass,
    runPolicy: fields.runPolicy ?? runPolicyFor(config),
    hexValue: comparable ? hexValue : null,
    referenceValue: comparable ? referenceValue : null,
    comparison,
    historical,
    groundTruth,
    groundTruthAuthority: groundTruth.authority,
    groundTruthStatus: groundTruth.status,
    twinManifest: groundTruth.twinManifest,
    evidenceRefs: fields.evidenceRefs ?? [],
    ...(measurement == null ? {} : { measurement }),
  };
}

function fieldsWithMeasurement(metricId, fields, measurementsByMetric) {
  const measurement = measurementsByMetric[metricId] ?? null;
  if (measurement == null) return fields;
  const evidenceRefs = [
    ...(fields.evidenceRefs ?? []),
    `measurement:${stableDigest(measurement)}`,
    ...measurement.evidenceRefs,
  ];
  return {
    ...fields,
    corpusId: measurement.corpusId ?? fields.corpusId,
    inputIdentity: measurement.inputIdentity ?? fields.inputIdentity,
    referenceTool: measurement.referenceTool ?? fields.referenceTool,
    referenceVersion: measurement.referenceVersion ?? fields.referenceVersion,
    configuration: measurement.configuration ?? fields.configuration,
    runPolicy: measurement.runPolicy ?? fields.runPolicy,
    evidenceRefs,
    measurement,
    ...(measurement.status === 'MEASURED' ? {
      hexValue: measurement.candidateValue,
      referenceValue: measurement.referenceValue,
    } : {}),
  };
}

function atomicWriteJson(filePath, value) {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function repositoryEvidenceError(code, detail = '') {
  throw new TypeError(`competitive-repository-evidence-${code}${detail ? `:${detail}` : ''}`);
}

function readRepositoryEvidenceJson(filePath, code, { required = true } = {}) {
  if (!fs.existsSync(filePath)) {
    if (required) repositoryEvidenceError(`${code}-missing`, filePath);
    return null;
  }
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      repositoryEvidenceError(`${code}-object-required`, filePath);
    }
    return value;
  } catch (error) {
    if (error instanceof TypeError && String(error.message).startsWith('competitive-repository-evidence-')) throw error;
    repositoryEvidenceError(`${code}-json-invalid`, `${filePath}:${error.message}`);
  }
}

function sharedPhase8CaptureFor(metricId, capture) {
  return metricId === SHARED_PHASE8_FALLBACK_METRIC
    && capture?.metricId === SHARED_PHASE8_CAPTURE_METRIC;
}

function expectedCaptureMetricId(metricId, capture) {
  return sharedPhase8CaptureFor(metricId, capture) ? null : metricId;
}

function repositoryCapturePath(outputRoot, metricId) {
  const fileName = REPOSITORY_CAPTURE_FILES[metricId];
  if (fileName == null) return null;
  const direct = path.join(outputRoot, fileName);
  if (fs.existsSync(direct)) return direct;
  // Native paired Phase 8 measurements deliberately share one capture.  The
  // collector normally writes both names, but accepting the canonical source
  // name keeps this path bound to the exact capture rather than making a copy.
  if (metricId === SHARED_PHASE8_FALLBACK_METRIC) {
    const shared = path.join(outputRoot, REPOSITORY_CAPTURE_FILES[SHARED_PHASE8_CAPTURE_METRIC]);
    if (fs.existsSync(shared)) return shared;
  }
  return direct;
}

function loadRepositoryEvidence({ outputRoot, profile }) {
  if (typeof outputRoot !== 'string' || !outputRoot.trim()) repositoryEvidenceError('output-root-required');
  const resolvedRoot = path.resolve(outputRoot);
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
    repositoryEvidenceError('output-root-missing', resolvedRoot);
  }
  const measurements = readRepositoryEvidenceJson(path.join(resolvedRoot, 'measurements.json'), 'measurements');
  for (const metricId of Object.keys(measurements)) {
    if (!Object.prototype.hasOwnProperty.call(profile.metrics || {}, metricId)) {
      repositoryEvidenceError('measurement-metric-unknown', metricId);
    }
  }

  const captures = {};
  for (const metricId of Object.keys(profile.metrics || {})) {
    const capturePath = repositoryCapturePath(resolvedRoot, metricId);
    if (capturePath == null || !fs.existsSync(capturePath)) continue;
    captures[metricId] = readRepositoryEvidenceJson(capturePath, `capture-${metricId}`);
  }
  return Object.freeze({ outputRoot: resolvedRoot, captures, measurements });
}

function validateRepositoryEvidence({ profile, captures, measurements, expectedProducerIdentity }) {
  for (const [metricId, capture] of Object.entries(captures)) {
    validateCompetitiveTwinCapture(capture, {
      replayArtifacts: false,
      expectedMetricId: expectedCaptureMetricId(metricId, capture),
    });
  }
  for (const [metricId, measurement] of Object.entries(measurements)) {
    const capture = captures[metricId] ?? null;
    if (measurement?.status === 'MEASURED') {
      validateCompetitiveMeasurement(measurement, {
        expectedMetricId: metricId,
        capture,
        expectedProducerIdentity,
        replayArtifacts: true,
      });
    } else {
      validateCompetitiveMeasurement(measurement, { expectedMetricId: metricId });
    }
  }
}

function profileFromRepositoryEvidence(profile, captures, measurements) {
  const effectiveProfile = structuredClone(profile);
  for (const [metricId, measurement] of Object.entries(measurements)) {
    if (measurement.status !== 'MEASURED') continue;
    const config = effectiveProfile.metrics[metricId];
    const capture = captures[metricId];
    if (config.groundTruth?.binaryScored !== true) {
      const existingWorkloads = Array.isArray(config.corpusWorkloadIds) ? config.corpusWorkloadIds : [];
      config.corpusWorkloadIds = [
        measurement.corpusId,
        ...existingWorkloads.filter((workloadId) => workloadId !== measurement.corpusId),
      ];
      config.groundTruth = {
        ...config.groundTruth,
        status: 'measured',
        binaryScored: false,
        twinManifest: null,
      };
      continue;
    }
    if (capture?.status !== 'READY' || !Array.isArray(capture.artifacts) || capture.artifacts.length === 0) {
      repositoryEvidenceError('measured-capture-required', metricId);
    }
    const artifact = capture.artifacts[0];
    if (artifact?.manifest == null) repositoryEvidenceError('measured-manifest-required', metricId);
    const existingWorkloads = Array.isArray(config.corpusWorkloadIds) ? config.corpusWorkloadIds : [];
    config.corpusWorkloadIds = [
      capture.corpusId,
      ...existingWorkloads.filter((workloadId) => workloadId !== capture.corpusId),
    ];
    config.groundTruth = {
      kind: 'binary-corpus',
      authority: 'same-binary-twin',
      status: 'measured',
      binaryScored: true,
      twinManifest: structuredClone(artifact.manifest),
    };
  }
  return effectiveProfile;
}

function twinEvidenceFromRepositoryCaptures(measurements, captures) {
  const evidence = {};
  for (const [metricId, measurement] of Object.entries(measurements)) {
    if (measurement.status !== 'MEASURED') continue;
    const artifact = captures[metricId]?.artifacts?.[0];
    if (artifact == null) continue;
    evidence[metricId] = {
      debugArtifactPath: artifact.debugArtifactPath,
      strippedArtifactPath: artifact.strippedArtifactPath,
      expected: artifact.manifest,
    };
  }
  return evidence;
}

export async function generateCompetitiveScorecard({ profile = loadCompetitiveProfile(), twinCapturesByMetric = {}, measurementsByMetric = {} } = {}) {
  const { gitSha: headCommit, treeSha } = currentCompetitiveGitIdentity();

  if (twinCapturesByMetric == null || typeof twinCapturesByMetric !== 'object' || Array.isArray(twinCapturesByMetric)) {
    throw new TypeError('competitive-twin-captures-object-required');
  }
  for (const metricId of Object.keys(twinCapturesByMetric)) {
    if (!Object.prototype.hasOwnProperty.call(profile.metrics || {}, metricId)) {
      throw new TypeError(`competitive-twin-capture-metric-unknown:${metricId}`);
    }
    validateCompetitiveTwinCapture(twinCapturesByMetric[metricId], {
      replayArtifacts: false,
      expectedMetricId: expectedCaptureMetricId(metricId, twinCapturesByMetric[metricId]),
    });
  }
  if (measurementsByMetric == null || typeof measurementsByMetric !== 'object' || Array.isArray(measurementsByMetric)) {
    throw new TypeError('competitive-measurements-object-required');
  }
  for (const metricId of Object.keys(measurementsByMetric)) {
    if (!Object.prototype.hasOwnProperty.call(profile.metrics || {}, metricId)) {
      throw new TypeError(`competitive-measurement-metric-unknown:${metricId}`);
    }
    const measurement = measurementsByMetric[metricId];
    const capture = twinCapturesByMetric[metricId];
    validateCompetitiveMeasurement(measurement, {
      expectedMetricId: metricId,
      ...(measurement.status === 'MEASURED' ? {
        capture,
        expectedProducerIdentity: { gitSha: headCommit, treeSha },
        replayArtifacts: true,
      } : {}),
    });
    if (measurement.status === 'MEASURED' && profile.metrics[metricId].groundTruth?.binaryScored === true) {
      if (capture?.status !== 'READY') throw new TypeError(`competitive-measurement-capture-required:${metricId}`);
      if (measurement.captureDigest !== capture.captureDigest
          || measurement.artifactIdsDigest !== capture.denominator?.artifactIdsDigest) {
        throw new TypeError(`competitive-measurement-capture-mismatch:${metricId}`);
      }
      const groundTruth = profile.metrics[metricId].groundTruth;
      if (groundTruth?.binaryScored === true && groundTruth.status === 'measured'
          && !captureContainsTwinManifest(capture, groundTruth.twinManifest)) {
        throw new TypeError(`competitive-measurement-twin-manifest-mismatch:${metricId}`);
      }
    }
  }
  for (const [metricId, metric] of Object.entries(profile.metrics || {})) {
    const groundTruth = metric.groundTruth;
    if (groundTruth?.binaryScored !== true || groundTruth.status !== 'measured') continue;
    const measurement = measurementsByMetric[metricId];
    if (measurement?.status !== 'MEASURED') {
      throw new TypeError(`competitive-measurement-required:${metricId}`);
    }
    const capture = twinCapturesByMetric[metricId];
    if (!captureContainsTwinManifest(capture, groundTruth.twinManifest)) {
      throw new TypeError(`competitive-measurement-twin-manifest-mismatch:${metricId}`);
    }
  }

  // 1. Alias v2 candidate answerer
  const solverCache = new Map();
  function candidateAnswer(query) {
    const built = buildFixture(query.fixture);
    if (!solverCache.has(built)) {
      solverCache.set(built, createPhase7AliasSolver({
        ir: built.ir,
        cfg: built.cfg,
        ssa: built.ssa,
        options: built.rootDescriptors == null ? {} : { canonicalOptions: { rootDescriptors: built.rootDescriptors } },
      }));
    }
    const solver = solverCache.get(built);
    return solver.alias(regionOf(built, query.left), regionOf(built, query.right), {
      leftAccess: memoryAccessOf(built, query.left),
      rightAccess: memoryAccessOf(built, query.right),
    });
  }

  function baselineAnswer(query) {
    const built = buildFixture(query.fixture);
    return { relation: aliasMemoryRegions(regionOf(built, query.left), regionOf(built, query.right)) };
  }

  const aliasV2Candidate = scoreAliasQueriesV2(candidateAnswer, { queries: ALIAS_QUERIES_V2 });
  const aliasV2Baseline = scoreAliasQueriesV2(baselineAnswer, { queries: ALIAS_QUERIES_V2 });

  // 2. MachineEffects coverage
  const sampleInstruction = {
    instructionId: 'sample-arm64-b',
    mnemonic: 'b',
    operands: '#0x5000',
    ops: [{ type: 'imm', value: 0x5000n }],
    mode: 'a64',
    address: 0x4000n,
    origin: { instructionIds: ['sample-arm64-b'] },
    branchTarget: 0x5000n,
  };
  const arm64Coverage = measureMachineEffectsCoverage('arm64', [sampleInstruction]);

  // 3. Normalized metric comparisons. Source-fixture measurements replace
  // these rows only after their independent oracle is validated; absent rows
  // retain their historical values only as non-authoritative context.
  const entries = [
    makeEntry(profile, 'alias-v2-exact-precision', fieldsWithMeasurement('alias-v2-exact-precision', {
      corpusId: 'phase7-alias-memory-corpus-v2',
      inputIdentity: 'alias-v2-30-queries',
      hexVersion: headCommit,
      referenceTool: 'legacy-safety-floor',
      referenceVersion: '1.0.0',
      configuration: 'default',
      runPolicy: 'cold-and-warm',
      hexValue: aliasV2Candidate.exactPrecision ?? 0,
      referenceValue: aliasV2Baseline.exactPrecision ?? 0,
      evidenceRefs: ['tests/phase7/corpus/fixtures.mjs', 'tools/validation/phase7/scoring.mjs'],
    }, measurementsByMetric)),
    makeEntry(profile, 'alias-v2-exact-recall', fieldsWithMeasurement('alias-v2-exact-recall', {
      corpusId: 'phase7-alias-memory-corpus-v2',
      inputIdentity: 'alias-v2-30-queries',
      hexVersion: headCommit,
      referenceTool: 'legacy-safety-floor',
      referenceVersion: '1.0.0',
      configuration: 'default',
      runPolicy: 'cold-and-warm',
      hexValue: aliasV2Candidate.exactRecall ?? 0,
      referenceValue: aliasV2Baseline.exactRecall ?? 0,
      evidenceRefs: ['tests/phase7/corpus/fixtures.mjs', 'tools/validation/phase7/scoring.mjs'],
    }, measurementsByMetric)),
    makeEntry(profile, 'alias-v2-false-must-alias', fieldsWithMeasurement('alias-v2-false-must-alias', {
      corpusId: 'phase7-alias-memory-corpus-v2',
      inputIdentity: 'alias-v2-30-queries',
      hexVersion: headCommit,
      referenceTool: 'legacy-safety-floor',
      referenceVersion: '1.0.0',
      configuration: 'default',
      runPolicy: 'exact',
      hexValue: aliasV2Candidate.falseMustAlias,
      referenceValue: aliasV2Baseline.falseMustAlias,
      evidenceRefs: ['tests/phase7/corpus/fixtures.mjs', 'tools/validation/phase7/scoring.mjs'],
    }, measurementsByMetric)),
    makeEntry(profile, 'alias-v2-false-no-alias', fieldsWithMeasurement('alias-v2-false-no-alias', {
      corpusId: 'phase7-alias-memory-corpus-v2',
      inputIdentity: 'alias-v2-30-queries',
      hexVersion: headCommit,
      referenceTool: 'legacy-safety-floor',
      referenceVersion: '1.0.0',
      configuration: 'default',
      runPolicy: 'exact',
      hexValue: aliasV2Candidate.falseNoAlias,
      referenceValue: aliasV2Baseline.falseNoAlias,
      evidenceRefs: ['tests/phase7/corpus/fixtures.mjs', 'tools/validation/phase7/scoring.mjs'],
    }, measurementsByMetric)),
    makeEntry(profile, 'machine-effects-arm64-coverage', fieldsWithMeasurement('machine-effects-arm64-coverage', {
      corpusId: 'arm64-effects-corpus',
      inputIdentity: 'arm64-effects-sample',
      hexVersion: headCommit,
      referenceTool: 'capstone',
      referenceVersion: '5.0.1',
      configuration: 'default',
      runPolicy: 'exact',
      hexValue: arm64Coverage.coverageRate ?? 1.0,
      referenceValue: 0.0,
      evidenceRefs: ['tests/stage1/a2-machine-effects-coverage.test.mjs'],
    }, measurementsByMetric)),
  ];

  // The profile owns the denominator. Rows that do not yet have a measured
  // producer remain present as UNMEASURED placeholders rather than silently
  // disappearing from the scorecard.
  const known = new Set(entries.map((entry) => entry.metricId));
  for (const metricId of Object.keys(profile.metrics || {})) {
    if (known.has(metricId)) continue;
    const workload = competitiveTwinWorkloadFor(metricId);
    const twinCapture = twinCapturesByMetric[metricId] ?? null;
    const measurement = measurementsByMetric[metricId] ?? null;
    const evidenceRefs = [
      ...(profile.metrics[metricId].corpusWorkloadIds || []),
      ...(workload == null ? [] : [`${workload.producer}#${workload.workloadId}`]),
    ];
    if (twinCapture != null) {
      evidenceRefs.push(`capture:${twinCapture.captureDigest ?? twinCapture.status}`);
      if (twinCapture.denominator?.artifactIdsDigest) evidenceRefs.push(`capture-denominator:${twinCapture.denominator.artifactIdsDigest}`);
    }
    if (measurement != null) {
      evidenceRefs.push(`measurement:${stableDigest(measurement)}`);
      evidenceRefs.push(...measurement.evidenceRefs);
    }
    entries.push(makeEntry(profile, metricId, {
      corpusId: profile.metrics[metricId].corpusWorkloadIds?.[0] ?? metricId,
      inputIdentity: measurement?.inputIdentity
        ?? (twinCapture?.status === 'READY' ? `capture_${twinCapture.captureDigest}` : `unmeasured:${metricId}`),
      hexVersion: headCommit,
      referenceTool: measurement?.referenceTool ?? 'unmeasured',
      referenceVersion: measurement?.referenceVersion ?? 'unmeasured',
      configuration: 'profile-default',
      hexValue: measurement?.candidateValue ?? null,
      referenceValue: measurement?.referenceValue ?? null,
      evidenceRefs,
      measurement,
    }));
  }

  const scorecard = {
    schemaVersion: 'hex-competitive-scorecard/v2',
    profileId: profile.profileId,
    gitSha: headCommit,
    treeSha,
    generatedAt: new Date().toISOString(),
    runtimeHardwareClass: profile.runtimeHardwareClass,
    entries,
    summary: {
      totalMetrics: entries.length,
      wins: entries.filter((e) => e.comparison === 'WIN').length,
      ties: entries.filter((e) => e.comparison === 'TIE').length,
      losses: entries.filter((e) => e.comparison === 'LOSS').length,
      unmeasured: entries.filter((e) => e.comparison === 'UNMEASURED').length,
    },
  };

  atomicWriteJson(SCORECARD_PATH, scorecard);
  return Object.freeze(scorecard);
}

/**
 * Promote only validated repository measurement envelopes into an effective
 * scorecard profile.  This consumes collector output and never invokes the
 * expensive producers again.  The static profile remains the authority for
 * the frozen denominator, thresholds, and all rows without measured binary
 * evidence.
 */
export async function generateCompetitiveScorecardFromRepositoryEvidence({
  outputRoot,
  profile = loadCompetitiveProfile(),
} = {}) {
  const canonicalProfile = loadCompetitiveProfile();
  if (stableDigest(profile) !== stableDigest(canonicalProfile)) {
    repositoryEvidenceError('profile-not-canonical');
  }
  verifyCompetitiveProfile(profile);
  const expectedProducerIdentity = currentCompetitiveGitIdentity();
  const repositoryEvidence = loadRepositoryEvidence({ outputRoot, profile });
  validateRepositoryEvidence({
    profile,
    captures: repositoryEvidence.captures,
    measurements: repositoryEvidence.measurements,
    expectedProducerIdentity,
  });
  const effectiveProfile = profileFromRepositoryEvidence(
    profile,
    repositoryEvidence.captures,
    repositoryEvidence.measurements,
  );
  const scorecard = await generateCompetitiveScorecard({
    profile: effectiveProfile,
    twinCapturesByMetric: repositoryEvidence.captures,
    measurementsByMetric: repositoryEvidence.measurements,
  });
  if (scorecard.gitSha !== expectedProducerIdentity.gitSha || scorecard.treeSha !== expectedProducerIdentity.treeSha) {
    repositoryEvidenceError('source-changed-during-generation');
  }
  const verification = verifyCompetitiveScorecard(scorecard, effectiveProfile, {
    expectedGitSha: expectedProducerIdentity.gitSha,
    expectedTreeSha: expectedProducerIdentity.treeSha,
    measurementCapturesByMetric: repositoryEvidence.captures,
    twinEvidenceByMetric: twinEvidenceFromRepositoryCaptures(
      repositoryEvidence.measurements,
      repositoryEvidence.captures,
    ),
  });
  return Object.freeze({
    outputRoot: repositoryEvidence.outputRoot,
    profile: effectiveProfile,
    captures: repositoryEvidence.captures,
    measurements: repositoryEvidence.measurements,
    scorecard,
    verification,
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const repositoryIndex = process.argv.indexOf('--from-measurements');
    if (repositoryIndex >= 0) {
      const outputRoot = process.argv[repositoryIndex + 1];
      if (outputRoot == null || outputRoot.startsWith('--')) repositoryEvidenceError('output-root-required');
      const result = await generateCompetitiveScorecardFromRepositoryEvidence({ outputRoot });
      console.log(`Competitive Scorecard generated from ${result.outputRoot}: ${result.scorecard.summary.wins} WINS, ${result.scorecard.summary.ties} TIES, ${result.scorecard.summary.losses} LOSSES, ${result.scorecard.summary.unmeasured} UNMEASURED @ ${result.scorecard.gitSha}`);
    } else {
      const scorecard = await generateCompetitiveScorecard();
      console.log(`Competitive Scorecard generated: ${scorecard.summary.wins} WINS, ${scorecard.summary.ties} TIES, ${scorecard.summary.losses} LOSSES @ ${scorecard.gitSha}`);
    }
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}
