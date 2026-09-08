/**
 * Bind repository-owned competitive measurements to independent evidence.
 *
 * A twin capture proves which bytes were built and stripped.  It does not by
 * itself prove a semantic score, so this module accepts the independent P5/P6
 * LLVM/Capstone ledgers and the frozen P8 observation ledger separately.  The
 * source-fixture rows use the same envelope with their declared truth and
 * source-content oracle. A failed identity check is represented as UNMEASURED
 * rather than being repaired with a guessed number.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { stableDigest } from '../../../js/core/identity/index.js';
import {
  capturePhase5TwinWorkload,
  capturePhase6TwinWorkload,
  capturePhase8TwinWorkload,
  validateCompetitiveTwinCapture,
} from './workload-twins.mjs';
import { extractElfFunctionBytes, loadCorpus } from '../phase8/build-corpus.mjs';
import { observeCorpus } from '../phase8/decompile-corpus.mjs';
import {
  loadFrozenBaseline,
  loadFrozenProvenance,
  loadNativeAuthority,
  nativeCaptureIdentity,
  PHASE8_NATIVE_ARM64_ADAPTER_IDENTITY,
  PHASE8_NATIVE_ARM64_OBSERVATION_METHOD,
  PHASE8_REFERENCE_MODES,
  qualityVector,
} from '../phase8/metrics.mjs';
import {
  SOURCE_FIXTURE_METRIC_CONFIG,
  collectCompetitiveSourceMeasurements,
  validateSourceFixtureMeasurement,
} from './source-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PHASE8_SOURCE_DIRECTORY = path.join(ROOT, 'tests/phase8/corpus/sources');

export const COMPETITIVE_MEASUREMENT_SCHEMA = 'hex-competitive-measurement/v1';
export const MEASURED_STATUS = 'MEASURED';
export const UNMEASURED_STATUS = 'UNMEASURED';
const AUTHORITY = 'same-binary-twin';
const COMPARISONS = new Set(['WIN', 'TIE', 'LOSS', UNMEASURED_STATUS]);
const BINARY_METRICS = Object.freeze([
  'machine-effects-x86_64-coverage',
  'machine-effects-riscv64-coverage',
  'decompiler-quality-gotos',
  'decompiler-quality-assembly-fallbacks',
]);
const MEASUREMENT_CONFIG = Object.freeze({
  'machine-effects-x86_64-coverage': Object.freeze({ direction: 'higher', kind: 'pipeline-tuples' }),
  'machine-effects-riscv64-coverage': Object.freeze({ direction: 'higher', kind: 'pipeline-tuples' }),
  'decompiler-quality-gotos': Object.freeze({ direction: 'lower', kind: 'phase8-frozen-function-corpus', field: 'gotos' }),
  'decompiler-quality-assembly-fallbacks': Object.freeze({ direction: 'lower', kind: 'phase8-frozen-function-corpus', field: 'rawAssemblyFallbacks' }),
  ...SOURCE_FIXTURE_METRIC_CONFIG,
});
const HEX32_RE = /^[0-9a-f]{32}$/i;
const HEX40_RE = /^[0-9a-f]{40}$/i;
const HEX64_RE = /^[0-9a-f]{64}$/i;
const PHASE8_QUALITY_METRICS = new Set(['decompiler-quality-gotos', 'decompiler-quality-assembly-fallbacks']);

function runtimeIdentity() {
  return {
    node: process.version,
    architecture: process.arch,
    platform: process.platform,
  };
}

/** Return the exact reviewed adapter source identity used by native collection. */
export function phase8NativeAdapterIdentity() {
  const sourcePath = path.join(ROOT, PHASE8_NATIVE_ARM64_ADAPTER_IDENTITY.sourcePath);
  const sourceSha256 = fs.existsSync(sourcePath) ? sha256Bytes(fs.readFileSync(sourcePath)) : null;
  return Object.freeze({
    ...PHASE8_NATIVE_ARM64_ADAPTER_IDENTITY,
    sourceSha256,
  });
}

function producerIdentity() {
  const read = (args) => {
    const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', shell: false });
    const value = result.stdout?.trim() || '';
    return result.error || result.status !== 0 ? null : value;
  };
  const gitSha = read(['rev-parse', 'HEAD']);
  const treeSha = read(['rev-parse', 'HEAD^{tree}']);
  if (!HEX40_RE.test(gitSha || '') || !HEX40_RE.test(treeSha || '')) return null;
  return { gitSha: gitSha.toLowerCase(), treeSha: treeSha.toLowerCase() };
}

function validatePipelineExecutionIdentity(ledger) {
  const execution = ledger?.executionIdentity;
  if (execution == null || typeof execution !== 'object' || Array.isArray(execution)) {
    return { ok: false, reason: 'ledger-execution-identity-missing' };
  }
  if (!HEX40_RE.test(String(execution.gitSha || '')) || !HEX40_RE.test(String(execution.treeSha || ''))
      || execution.sourceStable !== true) {
    return { ok: false, reason: 'ledger-execution-identity-invalid' };
  }
  const current = producerIdentity();
  if (current == null) return { ok: false, reason: 'ledger-execution-identity-unavailable' };
  if (execution.gitSha.toLowerCase() !== current.gitSha || execution.treeSha.toLowerCase() !== current.treeSha) {
    return {
      ok: false,
      reason: 'ledger-execution-identity-stale',
      expected: current,
      observed: { gitSha: execution.gitSha, treeSha: execution.treeSha },
    };
  }
  return {
    ok: true,
    identity: {
      gitSha: execution.gitSha.toLowerCase(),
      treeSha: execution.treeSha.toLowerCase(),
      sourceStable: true,
    },
  };
}

function measurementError(code, detail = '') {
  throw new TypeError(`competitive-measurement-${code}${detail ? `:${detail}` : ''}`);
}

/** Validate the value-bearing evidence envelope before it reaches a scorecard. */
export function validateCompetitiveMeasurement(value, {
  expectedMetricId = null,
  capture = null,
  expectedProducerIdentity = null,
  replayArtifacts = false,
} = {}) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) measurementError('object-required');
  if (value.schemaVersion !== COMPETITIVE_MEASUREMENT_SCHEMA) measurementError('schema-version');
  if (expectedMetricId != null && value.metricId !== expectedMetricId) measurementError('metric-mismatch', value.metricId);
  if (typeof value.metricId !== 'string' || !value.metricId.trim()) measurementError('metric-id');
  const metricConfig = MEASUREMENT_CONFIG[value.metricId];
  if (metricConfig == null) measurementError('metric-unsupported', value.metricId);
  if (![MEASURED_STATUS, UNMEASURED_STATUS].includes(value.status)) measurementError('status', String(value.status));
  const allowedAuthorities = metricConfig.kind === 'source-fixture'
    ? new Set(['deterministic-fixture', 'source-spec'])
    : new Set([AUTHORITY]);
  if (!allowedAuthorities.has(value.authority)) measurementError('authority', String(value.authority));
  if (!COMPARISONS.has(value.comparison)) measurementError('comparison', String(value.comparison));
  for (const key of ['candidateValue', 'referenceValue']) {
    if (value[key] != null && !finiteNumber(value[key])) measurementError('value', `${value.metricId}:${key}`);
  }
  if (value.status === MEASURED_STATUS) {
    if (!finiteNumber(value.candidateValue) || !finiteNumber(value.referenceValue)) measurementError('measured-values', value.metricId);
    if (value.comparison !== comparison(metricConfig.direction, value.candidateValue, value.referenceValue)) {
      measurementError('comparison-forged', value.metricId);
    }
    if (metricConfig.kind === 'source-fixture') {
      try {
        validateSourceFixtureMeasurement(value, { expectedMetricId, expectedProducerIdentity });
      } catch (error) {
        measurementError('source-fixture', `${value.metricId}:${error.message}`);
      }
      if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.some((entry) => typeof entry !== 'string' || !entry.trim())) {
        measurementError('evidence-refs', value.metricId);
      }
      return Object.freeze(value);
    }
    for (const key of ['corpusId', 'inputIdentity', 'referenceTool', 'referenceVersion', 'configuration', 'runPolicy', 'captureDigest', 'artifactIdsDigest', 'producerGitSha', 'producerTreeSha']) {
      if (typeof value[key] !== 'string' || !value[key].trim()) measurementError('identity', `${value.metricId}:${key}`);
    }
    if (!HEX32_RE.test(value.captureDigest) || !HEX32_RE.test(value.artifactIdsDigest)) measurementError('identity-digest', value.metricId);
    if (!HEX40_RE.test(value.producerGitSha) || !HEX40_RE.test(value.producerTreeSha)) measurementError('producer-identity', value.metricId);
    if (!capture || typeof capture !== 'object' || Array.isArray(capture)) measurementError('capture-required', value.metricId);
    if (replayArtifacts) {
      try {
        validateCompetitiveTwinCapture(capture, {
          replayArtifacts: true,
          expectedMetricId: value.referenceMode === PHASE8_REFERENCE_MODES.NATIVE_PAIRED ? null : value.metricId,
        });
      }
      catch (error) { measurementError('capture-replay', `${value.metricId}:${error.message}`); }
    }
    const captureIdentityValue = captureIdentity(capture, {
      expectedMetricId: value.metricId,
      allowSharedPhase8Capture: value.referenceMode === PHASE8_REFERENCE_MODES.NATIVE_PAIRED,
    });
    if (!captureIdentityValue.ok) measurementError('capture-invalid', `${value.metricId}:${captureIdentityValue.reason}`);
    if (value.captureDigest !== captureIdentityValue.captureDigest
        || value.artifactIdsDigest !== captureIdentityValue.artifactIdsDigest
        || value.inputIdentity !== `capture_${captureIdentityValue.captureDigest}`) {
      measurementError('capture-identity-mismatch', value.metricId);
    }
    if (expectedProducerIdentity != null
        && (value.producerGitSha !== expectedProducerIdentity.gitSha || value.producerTreeSha !== expectedProducerIdentity.treeSha)) {
      measurementError('producer-stale', value.metricId);
    }
    if (value.denominator == null || typeof value.denominator !== 'object' || Array.isArray(value.denominator)) measurementError('denominator', value.metricId);
    if (value.semanticOracle == null || typeof value.semanticOracle !== 'object' || Array.isArray(value.semanticOracle)) measurementError('oracle', value.metricId);
    validateMeasuredDenominator(value, metricConfig, capture);
    validateMeasuredOracle(value, metricConfig, capture);
    if (metricConfig.kind === 'phase8-frozen-function-corpus') {
      if (value.referenceMode === PHASE8_REFERENCE_MODES.NATIVE_PAIRED) validateMeasuredNativePhase8Authority(value);
      else validateMeasuredPhase8Authority(value);
    }
  } else {
    if (value.candidateValue !== null || value.referenceValue !== null || value.comparison !== UNMEASURED_STATUS) {
      measurementError('unmeasured-values', value.metricId);
    }
    if (metricConfig.kind === 'source-fixture') {
      try {
        validateSourceFixtureMeasurement(value, { expectedMetricId, expectedProducerIdentity });
      } catch (error) {
        measurementError('source-fixture', `${value.metricId}:${error.message}`);
      }
      if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.some((entry) => typeof entry !== 'string' || !entry.trim())) {
        measurementError('evidence-refs', value.metricId);
      }
      return Object.freeze(value);
    }
  }
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    measurementError('evidence-refs', value.metricId);
  }
  return Object.freeze(value);
}

const P56_METRIC = Object.freeze({
  'machine-effects-x86_64-coverage': Object.freeze({
    testPath: 'tests/phase5/verification/compiler-corpus-pipeline.test.mjs',
    marker: 'P5_6_PIPELINE_LEDGER=',
    producer: 'independent-llvm-boundaries-capstone-5.0.1',
    categoryProfilePath: 'tests/phase5/corpus/manifest.json',
    categoryMapPath: 'tests/phase5/verification/manifests/p5-6-category-map.json',
    producerProductSha: 'cede2af69e446fdf628903881eb698c0ccad91f9',
  }),
  'machine-effects-riscv64-coverage': Object.freeze({
    testPath: 'tests/phase6/verification/compiler-corpus-pipeline.test.mjs',
    marker: 'P6_PIPELINE_LEDGER=',
    producer: 'independent-llvm-boundaries-capstone-5.0.1',
    categoryProfilePath: 'tools/validation/phase6/profile.json',
    categoryMapPath: 'tests/phase6/verification/manifests/p6-category-map.json',
    producerProfileVersion: '1.1.0',
    producerCorpusId: 'phase6-riscv64-mandatory/v1',
  }),
});

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function safeCount(value, code, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) measurementError(code);
  return value;
}

function requiredDigest(value, regex, code) {
  if (typeof value !== 'string' || !regex.test(value)) measurementError(code);
  return value;
}

function validateMeasuredDenominator(value, metricConfig, capture) {
  const denominator = value.denominator;
  if (denominator.kind !== metricConfig.kind) measurementError('denominator-kind', value.metricId);
  if (metricConfig.kind === 'pipeline-tuples') {
    for (const key of ['artifactCount', 'categoryCount', 'tupleCount', 'candidatePasses', 'referenceOraclePasses']) {
      safeCount(denominator[key], `denominator-${key}:${value.metricId}`);
    }
    if (denominator.artifactCount !== capture.artifacts.length
        || denominator.artifactIdsDigest !== capture.denominator.artifactIdsDigest) {
      measurementError('denominator-capture-mismatch', value.metricId);
    }
    if (denominator.tupleCount !== denominator.artifactCount * denominator.categoryCount
        || denominator.tupleCount <= 0
        || denominator.candidatePasses > denominator.tupleCount
        || denominator.referenceOraclePasses > denominator.tupleCount) {
      measurementError('denominator-counts', value.metricId);
    }
    const canonical = canonicalPipelineCategories(value.metricId);
    if (!canonical.ok || denominator.categoryCount !== canonical.categories.length
        || denominator.categoryIdsDigest !== canonical.categoryIdsDigest) {
      measurementError('denominator-categories', value.metricId);
    }
    const expectedTuples = capture.artifacts
      .flatMap((artifact) => canonical.categories.map((category) => `${artifact.id}\u0000${category}`))
      .sort();
    if (denominator.tupleIdsDigest !== stableDigest(expectedTuples)) measurementError('denominator-tuples', value.metricId);
    if (!Array.isArray(denominator.artifactHashKinds) || denominator.artifactHashKinds.length === 0
        || denominator.artifactHashKinds.some((kind) => !['debug', 'stripped'].includes(kind))) {
      measurementError('denominator-artifact-hashes', value.metricId);
    }
    if (value.candidateValue !== denominator.candidatePasses / denominator.tupleCount
        || value.referenceValue !== denominator.referenceOraclePasses / denominator.tupleCount) {
      measurementError('denominator-values', value.metricId);
    }
    return;
  }

  if (metricConfig.kind !== 'phase8-frozen-function-corpus') measurementError('denominator-kind-unsupported', value.metricId);
  for (const key of ['functionCount', 'machineFunctionCount']) safeCount(denominator[key], `denominator-${key}:${value.metricId}`, { positive: true });
  for (const key of ['corpusDigest', 'sourceDigest', 'functionIdsDigest', 'machineFunctionBytesDigest', 'machineArtifactIdsDigest', 'nativeArtifactIdsDigest', 'candidateObservationsDigest', 'baselineObservationsDigest']) {
    requiredDigest(denominator[key], HEX32_RE, `denominator-${key}:${value.metricId}`);
  }
  requiredDigest(denominator.baselineProvenanceDigest, HEX32_RE, `denominator-baseline-provenance:${value.metricId}`);
  requiredDigest(denominator.baselineCommit, HEX40_RE, `denominator-baseline-commit:${value.metricId}`);
  if (denominator.candidateObservationsDigest !== value.semanticOracle?.candidateObservationDigest
      || denominator.baselineObservationsDigest !== value.semanticOracle?.baselineObservationDigest) {
    measurementError('denominator-observation-digest', value.metricId);
  }
  const candidateQuality = value.candidateQuality;
  const referenceQuality = value.referenceQuality;
  const field = metricConfig.field;
  if (candidateQuality == null || referenceQuality == null
      || !Number.isSafeInteger(candidateQuality[field]) || candidateQuality[field] < 0
      || !Number.isSafeInteger(referenceQuality[field]) || referenceQuality[field] < 0
      || value.candidateValue !== candidateQuality[field]
      || value.referenceValue !== referenceQuality[field]) {
    measurementError('quality-values', value.metricId);
  }
}

function validateMeasuredOracle(value, metricConfig, capture) {
  const oracle = value.semanticOracle;
  if (value.referenceMode === PHASE8_REFERENCE_MODES.NATIVE_PAIRED) {
    validateMeasuredNativeOracle(value, metricConfig, capture);
    return;
  }
  if (oracle.schemaVersion !== 'hex-competitive-semantic-oracle/v1') measurementError('oracle-schema', value.metricId);
  if (metricConfig.kind === 'pipeline-tuples') {
    if (oracle.kind !== 'llvm-boundary-and-capstone-differential') measurementError('oracle-kind', value.metricId);
    if (oracle.testPath !== P56_METRIC[value.metricId].testPath) measurementError('oracle-test-path', value.metricId);
    requiredDigest(oracle.sourceSha256, HEX64_RE, `oracle-source:${value.metricId}`);
    if (!Array.isArray(oracle.compilerIdentity) || oracle.compilerIdentity.length === 0
        || oracle.compilerIdentity.some((entry) => typeof entry !== 'string' || !entry.trim())) measurementError('oracle-compiler', value.metricId);
    if (!Array.isArray(oracle.linkerIdentity) || oracle.linkerIdentity.length === 0
        || oracle.linkerIdentity.some((entry) => typeof entry !== 'string' || !entry.trim())) measurementError('oracle-linker', value.metricId);
    const captureCompilers = sortedUnique(capture.artifacts.map((artifact) => firstLine(artifact.manifest?.compiler?.version)).filter(Boolean));
    const captureLinkers = sortedUnique(capture.artifacts.map((artifact) => firstLine(artifact.manifest?.linker?.version)).filter(Boolean));
    const oracleCompilers = sortedUnique(oracle.compilerIdentity.map(firstLine));
    const oracleLinkers = sortedUnique(oracle.linkerIdentity.map(firstLine));
    if (stableDigest(oracleCompilers) !== stableDigest(captureCompilers)
        || stableDigest(oracleLinkers) !== stableDigest(captureLinkers)) {
      measurementError('oracle-toolchain-mismatch', value.metricId);
    }
    const captureSources = sortedUnique(capture.artifacts.map((artifact) => artifact.manifest?.sourceIdentity?.sha256).filter(Boolean));
    if (captureSources.length !== 1 || oracle.sourceSha256 !== captureSources[0]) {
      measurementError('oracle-source-mismatch', value.metricId);
    }
    requiredDigest(oracle.corpusDigest, HEX32_RE, `oracle-corpus:${value.metricId}`);
    requiredDigest(oracle.ledgerDigest, HEX32_RE, `oracle-ledger:${value.metricId}`);
    const spec = P56_METRIC[value.metricId];
    if (spec.producerProductSha != null && oracle.producerHead !== spec.producerProductSha) measurementError('oracle-producer-head', value.metricId);
    if (spec.producerProfileVersion != null && oracle.producerProfileVersion !== spec.producerProfileVersion) measurementError('oracle-producer-profile', value.metricId);
    if (spec.producerCorpusId != null && oracle.producerCorpusId !== spec.producerCorpusId) measurementError('oracle-producer-corpus', value.metricId);
    return;
  }
  if (oracle.kind !== 'frozen-source-corpus-observation' || oracle.metricField !== metricConfig.field) {
    measurementError('oracle-kind', value.metricId);
  }
  if (oracle.corpusId !== capture.corpusId || oracle.corpusVersion !== capture.corpusVersion) {
    measurementError('oracle-corpus-mismatch', value.metricId);
  }
  for (const key of ['corpusId', 'corpusDigest', 'sourceDigest', 'functionIdsDigest', 'machineFunctionBytesDigest', 'candidateObservationDigest', 'baselineObservationDigest', 'baselineLedgerDigest']) {
    const regex = key === 'corpusId' ? null : HEX32_RE;
    if (regex == null) {
      if (typeof oracle[key] !== 'string' || !oracle[key].trim()) measurementError(`oracle-${key}`, value.metricId);
    } else requiredDigest(oracle[key], regex, `oracle-${key}:${value.metricId}`);
  }
  requiredDigest(oracle.baselineProvenanceDigest, HEX32_RE, `oracle-baseline-provenance:${value.metricId}`);
  requiredDigest(oracle.baselineCommit, HEX40_RE, `oracle-baseline-commit:${value.metricId}`);
  requiredDigest(oracle.provenanceBaseCommit, HEX40_RE, `oracle-provenance-base-commit:${value.metricId}`);
  if (!Number.isSafeInteger(oracle.corpusVersion) || oracle.corpusVersion < 0) measurementError('oracle-corpus-version', value.metricId);
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => String(left).localeCompare(String(right)));
}

function comparison(direction, candidateValue, referenceValue) {
  if (!finiteNumber(candidateValue) || !finiteNumber(referenceValue)) return UNMEASURED_STATUS;
  if (direction === 'higher') return candidateValue > referenceValue ? 'WIN' : candidateValue === referenceValue ? 'TIE' : 'LOSS';
  if (direction === 'lower') return candidateValue < referenceValue ? 'WIN' : candidateValue === referenceValue ? 'TIE' : 'LOSS';
  if (direction === 'exact-zero') return candidateValue === 0 && referenceValue === 0 ? 'TIE' : candidateValue === 0 ? 'WIN' : 'LOSS';
  return UNMEASURED_STATUS;
}

function captureIdentity(capture, { expectedMetricId = null, allowSharedPhase8Capture = false } = {}) {
  if (capture == null) return { ok: false, reason: 'twin-capture-missing' };
  try {
    validateCompetitiveTwinCapture(capture, {
      replayArtifacts: false,
      expectedMetricId: allowSharedPhase8Capture ? null : expectedMetricId,
    });
  } catch (error) {
    return { ok: false, reason: `twin-capture-invalid:${error.message}` };
  }
  if (allowSharedPhase8Capture && !PHASE8_QUALITY_METRICS.has(capture.metricId)) {
    return { ok: false, reason: `twin-capture-invalid:phase8-shared-capture-metric:${capture.metricId}` };
  }
  if (capture.status !== 'READY') return { ok: false, reason: `twin-capture-${String(capture.status).toLowerCase()}` };
  const artifacts = new Map((capture.artifacts || []).map((artifact) => [artifact.id, artifact]));
  return {
    ok: true,
    capture,
    artifacts,
    captureDigest: capture.captureDigest,
    artifactIdsDigest: capture.denominator.artifactIdsDigest,
    inputIdentity: `capture_${capture.captureDigest}`,
    evidenceRefs: [
      `capture:${capture.captureDigest}`,
      `capture-denominator:${capture.denominator.artifactIdsDigest}`,
    ],
  };
}

/** Return true only when the exact profile twin manifest is in this capture. */
export function captureContainsTwinManifest(capture, manifest) {
  if (capture == null || typeof capture !== 'object' || !Array.isArray(capture.artifacts)
      || manifest == null || typeof manifest !== 'object' || Array.isArray(manifest)) return false;
  return capture.artifacts.some((artifact) => artifact?.manifest?.manifestDigest === manifest.manifestDigest
    && stableDigest(artifact.manifest) === stableDigest(manifest));
}

function unmeasured(metricId, capture, reason, details = {}) {
  const allowSharedPhase8Capture = PHASE8_QUALITY_METRICS.has(metricId)
    && PHASE8_QUALITY_METRICS.has(capture?.metricId)
    && (String(reason).startsWith('phase8-native-') || reason === 'phase8-reference-method-mismatch');
  const identity = captureIdentity(capture, {
    expectedMetricId: metricId,
    allowSharedPhase8Capture,
  });
  return Object.freeze({
    schemaVersion: COMPETITIVE_MEASUREMENT_SCHEMA,
    metricId,
    status: UNMEASURED_STATUS,
    authority: AUTHORITY,
    candidateValue: null,
    referenceValue: null,
    comparison: UNMEASURED_STATUS,
    corpusId: identity.ok ? identity.capture.corpusId : null,
    inputIdentity: identity.ok ? identity.inputIdentity : `unmeasured:${metricId}`,
    referenceTool: 'unmeasured',
    referenceVersion: 'unmeasured',
    configuration: 'independent-oracle',
    runPolicy: 'exact',
    captureDigest: identity.ok ? identity.captureDigest : null,
    artifactIdsDigest: identity.ok ? identity.artifactIdsDigest : null,
    denominator: null,
    semanticOracle: null,
    evidenceRefs: identity.ok ? identity.evidenceRefs : [],
    reason,
    ...clone(details),
  });
}

function measured({
  metricId,
  capture,
  candidateValue,
  referenceValue,
  direction,
  corpusId,
  denominator,
  referenceTool,
  referenceVersion,
  semanticOracle,
  evidenceRefs = [],
  producer: producerOverride = null,
  referenceMode = PHASE8_REFERENCE_MODES.FROZEN_LEGACY,
  details = {},
}) {
  const identity = captureIdentity(capture, {
    expectedMetricId: metricId,
    allowSharedPhase8Capture: referenceMode === PHASE8_REFERENCE_MODES.NATIVE_PAIRED,
  });
  if (!identity.ok) return unmeasured(metricId, capture, identity.reason);
  if (!finiteNumber(candidateValue) || !finiteNumber(referenceValue)) {
    return unmeasured(metricId, capture, 'measurement-value-not-finite');
  }
  if (typeof corpusId !== 'string' || corpusId !== identity.capture.corpusId) {
    return unmeasured(metricId, capture, 'measurement-corpus-identity-mismatch', { observedCorpusId: corpusId ?? null });
  }
  if (semanticOracle == null || typeof semanticOracle !== 'object' || Array.isArray(semanticOracle)) {
    return unmeasured(metricId, capture, 'semantic-oracle-identity-missing');
  }
  const producer = producerOverride || producerIdentity();
  if (producer == null) return unmeasured(metricId, capture, 'producer-git-identity-unavailable');
  const result = {
    schemaVersion: COMPETITIVE_MEASUREMENT_SCHEMA,
    metricId,
    status: MEASURED_STATUS,
    authority: AUTHORITY,
    candidateValue,
    referenceValue,
    comparison: comparison(direction, candidateValue, referenceValue),
    corpusId,
    inputIdentity: identity.inputIdentity,
    referenceTool,
    referenceVersion,
    configuration: 'independent-oracle',
    runPolicy: 'exact',
    captureDigest: identity.captureDigest,
    artifactIdsDigest: identity.artifactIdsDigest,
    producerGitSha: producer.gitSha,
    producerTreeSha: producer.treeSha,
    denominator,
    semanticOracle,
    referenceMode,
    evidenceRefs: sortedUnique([...identity.evidenceRefs, ...evidenceRefs]),
    reason: 'independent-oracle-and-same-binary-twin-identity-bound',
    ...clone(details),
  };
  return Object.freeze(result);
}

function sameSourceHash(capture, ledger) {
  const sourceHash = ledger?.source?.sha256;
  if (typeof sourceHash !== 'string' || !sourceHash) return { ok: false, reason: 'ledger-source-identity-missing' };
  const hashes = sortedUnique((capture.artifacts || []).map((artifact) => artifact.manifest?.sourceIdentity?.sha256).filter(Boolean));
  if (hashes.length !== 1 || hashes[0] !== sourceHash) {
    return { ok: false, reason: 'ledger-source-identity-mismatch', observed: hashes, expected: sourceHash };
  }
  const supportHash = ledger.supportSource?.sha256;
  if (typeof supportHash === 'string') {
    const supportHashes = sortedUnique((capture.artifacts || [])
      .map((artifact) => artifact.manifest?.compileOptions?.supportSource?.sha256)
      .filter(Boolean));
    if (supportHashes.length !== 1 || supportHashes[0] !== supportHash) {
      return { ok: false, reason: 'ledger-support-source-identity-mismatch', observed: supportHashes, expected: supportHash };
    }
  }
  return { ok: true };
}

function sameFixtureHashes(capture, ledger) {
  const fixtureRows = new Map();
  const artifactHashKinds = new Map();
  for (const row of ledger?.fixtures || []) {
    if (typeof row?.id === 'string') {
      if (fixtureRows.has(row.id)) return { ok: false, reason: 'ledger-duplicate-fixture', fixture: row.id };
      fixtureRows.set(row.id, row);
    }
  }
  const captureIds = [...(capture.artifacts || [])].map((artifact) => artifact.id).sort();
  const ledgerIds = [...fixtureRows.keys()].sort();
  if (stableDigest(captureIds) !== stableDigest(ledgerIds)) {
    return { ok: false, reason: 'ledger-artifact-denominator-mismatch', captureIds, ledgerIds };
  }
  for (const id of captureIds) {
    const expected = fixtureRows.get(id)?.sha256;
    const manifest = capture.artifacts.find((artifact) => artifact.id === id)?.manifest || {};
    const debug = manifest.debugArtifactSha256;
    const stripped = manifest.strippedArtifactSha256;
    const artifactHashKind = expected === debug ? 'debug' : expected === stripped ? 'stripped' : null;
    if (typeof expected !== 'string' || artifactHashKind == null) {
      return { ok: false, reason: 'ledger-artifact-hash-mismatch', artifactId: id, ledgerHash: expected ?? null, debugHash: debug ?? null, strippedHash: stripped ?? null };
    }
    if (!fixtureRows.get(id)) return { ok: false, reason: 'ledger-row-fixture-missing', fixture: id };
    artifactHashKinds.set(id, artifactHashKind);
  }
  return { ok: true, fixtureRows, artifactHashKinds };
}

function canonicalPipelineCategories(metricId) {
  const spec = P56_METRIC[metricId];
  const profile = JSON.parse(fs.readFileSync(path.join(ROOT, spec.categoryProfilePath), 'utf8'));
  const categoryMap = JSON.parse(fs.readFileSync(path.join(ROOT, spec.categoryMapPath), 'utf8'));
  const profileCategories = metricId === 'machine-effects-riscv64-coverage'
    ? profile.corpus?.mandatoryCategories
    : profile.mandatoryCategories;
  const mappedCategories = Object.keys(categoryMap.categories || {});
  if (!Array.isArray(profileCategories) || profileCategories.length === 0
      || stableDigest(sortedUnique(profileCategories)) !== stableDigest(sortedUnique(mappedCategories))) {
    return { ok: false, reason: 'canonical-category-contract-invalid' };
  }
  return {
    ok: true,
    categories: sortedUnique(profileCategories),
    categoryIdsDigest: stableDigest(sortedUnique(profileCategories)),
    mappings: categoryMap.categories,
  };
}

function firstLine(value) {
  return String(value || '').split(/\r?\n/, 1)[0].trim();
}

function validPipelineStatus(value) {
  return value === 'executed' || value === 'NOT-PROVEN';
}

function validRowStatus(value) {
  return value === 'PASS' || value === 'FAIL' || value === 'NOT-PROVEN' || String(value).startsWith('BLOCKING-');
}

function validateCompleteness(value, metricId, row) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'ledger-completeness-invalid', metricId, fixture: row.fixture, category: row.category };
  for (const key of ['exact', 'exactWithIntrinsic', 'partial', 'unknown', 'unsupported']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) return { ok: false, reason: 'ledger-completeness-invalid', metricId, fixture: row.fixture, category: row.category };
  }
  const total = value.exact + value.exactWithIntrinsic + value.partial + value.unknown + value.unsupported;
  if (total <= 0) return { ok: false, reason: 'ledger-completeness-invalid', metricId, fixture: row.fixture, category: row.category };
  return { ok: true, total };
}

function validatePipelineRows(metricId, ledger, capture, canonical, fixtureRows) {
  const spec = P56_METRIC[metricId];
  if (metricId === 'machine-effects-x86_64-coverage' && ledger.productSha !== spec.producerProductSha) {
    return { ok: false, reason: 'ledger-producer-head-mismatch', expected: spec.producerProductSha, observed: ledger.productSha ?? null };
  }
  if (metricId === 'machine-effects-riscv64-coverage'
      && (ledger.profileVersion !== spec.producerProfileVersion || ledger.corpusId !== spec.producerCorpusId)) {
    return { ok: false, reason: 'ledger-producer-profile-mismatch', expectedProfileVersion: spec.producerProfileVersion, observedProfileVersion: ledger.profileVersion ?? null, expectedCorpusId: spec.producerCorpusId, observedCorpusId: ledger.corpusId ?? null };
  }
  if (!ledger.totals || typeof ledger.totals !== 'object' || Array.isArray(ledger.totals)) return { ok: false, reason: 'ledger-totals-missing' };
  for (const key of ['mandatory', 'passed', 'blocked', 'notProven']) {
    if (!Number.isSafeInteger(ledger.totals[key]) || ledger.totals[key] < 0) return { ok: false, reason: 'ledger-totals-invalid', field: key };
  }
  if (Object.prototype.hasOwnProperty.call(ledger.totals, 'failed')
      && (!Number.isSafeInteger(ledger.totals.failed) || ledger.totals.failed < 0)) return { ok: false, reason: 'ledger-totals-invalid', field: 'failed' };

  const observedCounts = {
    passed: 0,
    blocked: 0,
    notProven: 0,
    failed: 0,
  };
  const artifacts = new Map(capture.artifacts.map((artifact) => [artifact.id, artifact]));
  const expectedCompilerVersions = sortedUnique(capture.artifacts.map((artifact) => firstLine(artifact.manifest?.compiler?.version)).filter(Boolean));
  const expectedSourceHash = ledger.source?.sha256;
  if (typeof expectedSourceHash !== 'string' || !HEX64_RE.test(expectedSourceHash)) return { ok: false, reason: 'ledger-source-identity-invalid' };
  if (metricId === 'machine-effects-riscv64-coverage') {
    const compiler = firstLine(ledger.toolchain?.compiler);
    const linker = firstLine(ledger.toolchain?.linker);
    const expectedLinkers = sortedUnique(capture.artifacts.map((artifact) => firstLine(artifact.manifest?.linker?.version)).filter(Boolean));
    if (!compiler || !expectedCompilerVersions.includes(compiler) || !linker || !expectedLinkers.includes(linker)) {
      return { ok: false, reason: 'ledger-toolchain-identity-mismatch', expectedCompilerVersions, observedCompiler: compiler || null, expectedLinkers, observedLinker: linker || null };
    }
  }
  for (const row of ledger.ledger) {
    if (!validRowStatus(row.status)) return { ok: false, reason: 'ledger-row-status-invalid', fixture: row.fixture, category: row.category, status: row.status };
    if (!validPipelineStatus(row.pipelineStatus)) return { ok: false, reason: 'ledger-pipeline-status-invalid', fixture: row.fixture, category: row.category, pipelineStatus: row.pipelineStatus };
    const fixture = fixtureRows.get(row.fixture);
    const artifact = artifacts.get(row.fixture);
    const mapping = canonical.mappings?.[row.category];
    if (!fixture || !artifact || !mapping || typeof mapping.symbol !== 'string') return { ok: false, reason: 'ledger-row-identity-missing', fixture: row.fixture, category: row.category };
    if (row.target !== fixture.target || row.optimization !== fixture.optimization
        || row.binaryHash !== fixture.sha256
        || row.function !== mapping.symbol) {
      return { ok: false, reason: 'ledger-row-identity-mismatch', fixture: row.fixture, category: row.category };
    }
    if (fixture.elfType != null && row.elfType != null && row.elfType !== fixture.elfType) return { ok: false, reason: 'ledger-row-elf-type-mismatch', fixture: row.fixture, category: row.category };
    if (fixture.abiId != null && row.abiId != null && row.abiId !== fixture.abiId) return { ok: false, reason: 'ledger-row-abi-mismatch', fixture: row.fixture, category: row.category };
    if (metricId === 'machine-effects-x86_64-coverage'
        && (typeof row.sourceHash !== 'string' || row.sourceHash !== expectedSourceHash)) {
      return { ok: false, reason: 'ledger-row-source-mismatch', fixture: row.fixture, category: row.category };
    }
    if (row.sourceHash != null && row.sourceHash !== expectedSourceHash) return { ok: false, reason: 'ledger-row-source-mismatch', fixture: row.fixture, category: row.category };
    const manifest = artifact.manifest;
    if (manifest.compileOptions?.optimization !== row.optimization
        || (fixture.targetTriple != null && manifest.targetTriple !== fixture.targetTriple)) {
      return { ok: false, reason: 'ledger-capture-fixture-mismatch', fixture: row.fixture, category: row.category };
    }
    if (metricId === 'machine-effects-x86_64-coverage') {
      if (firstLine(row.compilerIdentity) !== firstLine(manifest.compiler?.version)) return { ok: false, reason: 'ledger-row-compiler-mismatch', fixture: row.fixture, category: row.category };
    }
    if (!Number.isSafeInteger(row.instructionCount) || row.instructionCount < 0
        || !Number.isSafeInteger(row.decodeMismatchCount) || row.decodeMismatchCount < 0) {
      return { ok: false, reason: 'ledger-row-count-invalid', fixture: row.fixture, category: row.category };
    }
    const completeness = validateCompleteness(row.completeness, metricId, row);
    if (!completeness.ok) return completeness;
    if (completeness.total !== row.instructionCount) return { ok: false, reason: 'ledger-completeness-count-mismatch', fixture: row.fixture, category: row.category };
    if (row.status === 'PASS') {
      if (row.pipelineStatus !== 'executed' || row.instructionCount <= 0 || row.decodeMismatchCount !== 0
          || completeness.total <= 0 || row.completeness.partial > 0 || row.completeness.unknown > 0 || row.completeness.unsupported > 0
          || row.firstDivergence != null) {
        return { ok: false, reason: 'ledger-pass-contract-invalid', fixture: row.fixture, category: row.category };
      }
      if (metricId === 'machine-effects-x86_64-coverage' && row.differentialResult !== 'LLVM-boundary-match') {
        return { ok: false, reason: 'ledger-pass-oracle-status-invalid', fixture: row.fixture, category: row.category };
      }
      if (metricId === 'machine-effects-riscv64-coverage' && row.capstoneDifferentialMismatchCount !== 0) {
        return { ok: false, reason: 'ledger-pass-differential-invalid', fixture: row.fixture, category: row.category };
      }
      observedCounts.passed += 1;
    } else if (row.status === 'FAIL') observedCounts.failed += 1;
    else if (row.status === 'NOT-PROVEN') observedCounts.notProven += 1;
    else observedCounts.blocked += 1;
  }
  if (ledger.totals.passed !== observedCounts.passed || ledger.totals.blocked !== observedCounts.blocked || ledger.totals.notProven !== observedCounts.notProven
      || (Object.prototype.hasOwnProperty.call(ledger.totals, 'failed')
        ? ledger.totals.failed !== observedCounts.failed
        : observedCounts.failed !== 0)) {
    return { ok: false, reason: 'ledger-totals-mismatch', expected: observedCounts, observed: ledger.totals };
  }
  return { ok: true };
}

function validatePipelineLedger(metricId, ledger, capture) {
  const execution = validatePipelineExecutionIdentity(ledger);
  if (!execution.ok) return execution;
  const identity = captureIdentity(capture, { expectedMetricId: metricId });
  if (!identity.ok) return { ok: false, reason: identity.reason };
  if (ledger == null || typeof ledger !== 'object' || Array.isArray(ledger)) return { ok: false, reason: 'ledger-object-missing' };
  if (!Array.isArray(ledger.ledger) || ledger.ledger.length === 0) return { ok: false, reason: 'ledger-rows-missing' };
  const source = sameSourceHash(capture, ledger);
  if (!source.ok) return source;
  const hashes = sameFixtureHashes(capture, ledger);
  if (!hashes.ok) return hashes;
  const mandatory = ledger.totals?.mandatory;
  if (!Number.isSafeInteger(mandatory) || mandatory !== ledger.ledger.length) return { ok: false, reason: 'ledger-denominator-invalid' };
  if (ledger.ledger.some((row) => row == null || typeof row !== 'object' || typeof row.fixture !== 'string' || typeof row.category !== 'string')) {
    return { ok: false, reason: 'ledger-row-invalid' };
  }
  const canonical = canonicalPipelineCategories(metricId);
  if (!canonical.ok) return canonical;
  const categories = canonical.categories;
  const expectedTuples = capture.artifacts.flatMap((artifact) => categories.map((category) => `${artifact.id}\u0000${category}`)).sort();
  const actualTuples = ledger.ledger.map((row) => `${row.fixture}\u0000${row.category}`).sort();
  if (mandatory !== expectedTuples.length || stableDigest(actualTuples) !== stableDigest(expectedTuples)) {
    return {
      ok: false,
      reason: 'ledger-canonical-tuple-denominator-mismatch',
      artifactCount: capture.artifacts.length,
      categoryIdsDigest: canonical.categoryIdsDigest,
      expectedTupleCount: expectedTuples.length,
      actualTupleCount: actualTuples.length,
      missingTuples: expectedTuples.filter((tuple) => !actualTuples.includes(tuple)).slice(0, 8),
      extraTuples: actualTuples.filter((tuple) => !expectedTuples.includes(tuple)).slice(0, 8),
    };
  }
  const tupleIds = new Set();
  for (const row of ledger.ledger) {
    const tuple = `${row.fixture}\u0000${row.category}`;
    if (tupleIds.has(tuple)) return { ok: false, reason: 'ledger-duplicate-tuple', tuple };
    tupleIds.add(tuple);
    if (!hashes.fixtureRows.has(row.fixture)) return { ok: false, reason: 'ledger-row-fixture-missing', fixture: row.fixture };
  }
  const rows = validatePipelineRows(metricId, ledger, capture, canonical, hashes.fixtureRows);
  if (!rows.ok) return rows;
  return {
    ok: true,
    identity,
    execution: execution.identity,
    categories,
    categoryIdsDigest: canonical.categoryIdsDigest,
    fixtureRows: hashes.fixtureRows,
    artifactHashKinds: sortedUnique([...hashes.artifactHashKinds.values()]),
  };
}

function referenceOraclePass(row, metricId) {
  if (!Number.isSafeInteger(row?.instructionCount) || row.instructionCount <= 0) return false;
  if (row.decodeMismatchCount !== 0) return false;
  if (metricId === 'machine-effects-riscv64-coverage' && row.capstoneDifferentialMismatchCount !== 0) return false;
  return true;
}

/**
 * Convert one P5/P6 independent ledger into a value-bearing evidence record.
 * Candidate coverage counts complete product tuples; reference coverage counts
 * tuples whose LLVM boundary and shipped Capstone differential were valid.
 */
export function measurePhase56Coverage({ metricId, ledger, capture, direction = 'higher' } = {}) {
  if (!P56_METRIC[metricId]) throw new TypeError(`competitive-p56-metric-unsupported:${metricId}`);
  const valid = validatePipelineLedger(metricId, ledger, capture);
  if (!valid.ok) return unmeasured(metricId, capture, valid.reason, { identityFailure: valid });
  const rows = ledger.ledger;
  const mandatory = rows.length;
  const passed = rows.filter((row) => row.status === 'PASS').length;
  const oraclePassed = rows.filter((row) => referenceOraclePass(row, metricId)).length;
  const compilerVersions = sortedUnique([
    ...rows.map((row) => row.compilerIdentity).filter(Boolean),
    ...(ledger.toolchain?.compiler ? [ledger.toolchain.compiler] : []),
  ]);
  const toolchain = ledger.toolchain || {};
  const referenceVersion = compilerVersions.join(',') || String(toolchain.compiler || 'unknown');
  return measured({
    metricId,
    capture,
    direction,
    corpusId: capture.corpusId,
    candidateValue: passed / mandatory,
    referenceValue: oraclePassed / mandatory,
    denominator: {
      kind: 'pipeline-tuples',
      artifactCount: capture.artifacts.length,
      categoryCount: valid.categories.length,
      categoryIdsDigest: valid.categoryIdsDigest,
      tupleCount: mandatory,
      artifactIdsDigest: capture.denominator.artifactIdsDigest,
      artifactHashKinds: valid.artifactHashKinds,
      tupleIdsDigest: stableDigest(rows.map((row) => `${row.fixture}\u0000${row.category}`).sort()),
      candidatePasses: passed,
      referenceOraclePasses: oraclePassed,
    },
    referenceTool: P56_METRIC[metricId].producer,
    referenceVersion,
    semanticOracle: {
      schemaVersion: 'hex-competitive-semantic-oracle/v1',
      kind: 'llvm-boundary-and-capstone-differential',
      testPath: P56_METRIC[metricId].testPath,
      sourceSha256: ledger.source.sha256,
      compilerIdentity: compilerVersions,
      linkerIdentity: sortedUnique(capture.artifacts.map((artifact) => artifact.manifest?.linker?.version).filter(Boolean)),
      runtime: runtimeIdentity(),
      producerHead: P56_METRIC[metricId].producerProductSha ?? null,
      producerProfileVersion: ledger.profileVersion ?? null,
      producerCorpusId: ledger.corpusId ?? null,
      corpusDigest: stableDigest({ source: ledger.source, fixtures: ledger.fixtures }),
      ledgerDigest: stableDigest({ totals: ledger.totals, ledger: rows }),
    },
    evidenceRefs: [P56_METRIC[metricId].testPath, P56_METRIC[metricId].producer],
    producer: valid.execution,
  });
}

function qualityMetric(metricId) {
  if (metricId === 'decompiler-quality-gotos') return 'gotos';
  if (metricId === 'decompiler-quality-assembly-fallbacks') return 'rawAssemblyFallbacks';
  throw new TypeError(`competitive-phase8-metric-unsupported:${metricId}`);
}

function observationIdentity(observations) {
  return {
    count: Array.isArray(observations) ? observations.length : 0,
    ids: (Array.isArray(observations) ? observations : []).map((row) => row?.id),
    digest: stableDigest(observations),
  };
}

function compilerVersionToken(value) {
  return String(value || '').match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null;
}

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(Buffer.from(value)).digest('hex');
}

function phase8ArtifactIdFor(entry) {
  if (typeof entry?.artifactId === 'string' && entry.artifactId.trim()) return entry.artifactId;
  if (entry?.architectureId == null || entry?.source == null || entry?.optimization == null) return null;
  return `${entry.architectureId}-${entry.source}-${String(entry.optimization).replace(/^-/, '')}`;
}

function phase8SourceRecords(corpus, sourceDirectory) {
  const names = sortedUnique((corpus.functions || []).map((entry) => entry?.source).filter((value) => typeof value === 'string' && value));
  const records = [];
  for (const name of names) {
    const sourcePath = path.resolve(sourceDirectory, name);
    const root = path.resolve(sourceDirectory);
    if (sourcePath !== root && !sourcePath.startsWith(`${root}${path.sep}`)) {
      return { ok: false, reason: 'phase8-corpus-source-path-invalid', source: name };
    }
    let text;
    try { text = fs.readFileSync(sourcePath, 'utf8'); } catch (error) {
      return { ok: false, reason: 'phase8-corpus-source-unavailable', source: name, detail: String(error?.message || error) };
    }
    const bytes = Buffer.from(text);
    records.push({ name, text, sha256: sha256Bytes(bytes) });
  }
  if (stableDigest(records.map(({ name, text }) => ({ name, text }))) !== corpus.sourceDigest) {
    return { ok: false, reason: 'phase8-corpus-source-digest-mismatch', observed: stableDigest(records.map(({ name, text }) => ({ name, text }))), expected: corpus.sourceDigest };
  }
  return { ok: true, records };
}

export function validatePhase8CaptureLineage(corpus, capture, { sourceDirectory = PHASE8_SOURCE_DIRECTORY } = {}) {
  if (!Array.isArray(corpus?.functions) || corpus.functions.length === 0 || typeof corpus.sourceDigest !== 'string') {
    return { ok: false, reason: 'phase8-corpus-byte-identity-missing' };
  }
  const sources = phase8SourceRecords(corpus, sourceDirectory);
  if (!sources.ok) return sources;
  const sourceByName = new Map(sources.records.map((record) => [record.name, record]));
  const sourceByIdentity = new Map(sources.records.map((record) => [path.relative(ROOT, path.resolve(sourceDirectory, record.name)).replaceAll('\\', '/'), record]));
  const manifestArtifacts = capture.artifacts || [];
  for (const artifact of manifestArtifacts) {
    const sourceIdentity = artifact.manifest?.sourceIdentity;
    const source = sourceByIdentity.get(sourceIdentity?.id) || sourceByName.get(sourceIdentity?.id);
    if (!source || sourceIdentity?.sha256 !== source.sha256) {
      return {
        ok: false,
        reason: 'phase8-capture-source-identity-mismatch',
        artifactId: artifact.id,
        observed: sourceIdentity || null,
        expected: source == null ? null : { id: path.relative(ROOT, path.resolve(sourceDirectory, source.name)).replaceAll('\\', '/'), sha256: source.sha256 },
      };
    }
  }

  const machineFunctions = corpus.functions.filter((entry) => entry?.representation === 'machine-bytes');
  if (machineFunctions.length === 0 || machineFunctions.some((entry) => typeof entry.bytes !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(entry.bytes))) {
    return { ok: false, reason: 'phase8-corpus-machine-function-bytes-missing' };
  }
  const expectedMachineArtifacts = sortedUnique(machineFunctions.map(phase8ArtifactIdFor).filter(Boolean));
  const machineArtifacts = manifestArtifacts
    .filter((artifact) => artifact.manifest?.compileOptions?.captureOnly !== true)
    .map((artifact) => artifact.id)
    .sort();
  if (stableDigest(machineArtifacts) !== stableDigest(expectedMachineArtifacts)) {
    return {
      ok: false,
      reason: 'phase8-capture-machine-denominator-mismatch',
      expectedArtifactIds: expectedMachineArtifacts,
      observedArtifactIds: machineArtifacts,
    };
  }

  // ARM64 remains assembly in the frozen public corpus.  A native ARM64 twin
  // is capture-only evidence and must cover exactly those source/optimization
  // pairs; it cannot silently replace the frozen assembly denominator.
  const expectedNativeArtifacts = sortedUnique(corpus.functions
    .filter((entry) => entry?.architectureId === 'arm64')
    .map((entry) => `arm64-native-${entry.source}-${String(entry.optimization).replace(/^-/, '')}`));
  const nativeArtifacts = manifestArtifacts
    .filter((artifact) => artifact.manifest?.compileOptions?.captureOnly === true)
    .map((artifact) => artifact.id)
    .sort();
  if (stableDigest(nativeArtifacts) !== stableDigest(expectedNativeArtifacts)) {
    return {
      ok: false,
      reason: 'phase8-capture-native-denominator-mismatch',
      expectedArtifactIds: expectedNativeArtifacts,
      observedArtifactIds: nativeArtifacts,
    };
  }

  const artifactById = new Map(manifestArtifacts.map((artifact) => [artifact.id, artifact]));
  const functionHashes = [];
  for (const entry of machineFunctions) {
    const artifactId = phase8ArtifactIdFor(entry);
    const artifact = artifactById.get(artifactId);
    if (!artifact || typeof artifact.debugArtifactPath !== 'string' || !fs.existsSync(artifact.debugArtifactPath)) {
      return { ok: false, reason: 'phase8-capture-artifact-unavailable', artifactId, functionId: entry.id };
    }
    let observed;
    try {
      observed = extractElfFunctionBytes(fs.readFileSync(artifact.debugArtifactPath), entry.function);
    } catch (error) {
      return { ok: false, reason: 'phase8-capture-function-bytes-unreadable', artifactId, functionId: entry.id, detail: String(error?.message || error) };
    }
    const expected = Buffer.from(entry.bytes, 'hex');
    if (!(observed instanceof Uint8Array) || !Buffer.from(observed).equals(expected)) {
      return {
        ok: false,
        reason: 'phase8-capture-function-bytes-mismatch',
        artifactId,
        functionId: entry.id,
        observedSha256: observed == null ? null : sha256Bytes(observed),
        expectedSha256: sha256Bytes(expected),
      };
    }
    functionHashes.push({ id: entry.id, sha256: sha256Bytes(expected) });
  }
  const functionIds = corpus.functions.map((entry) => entry?.id);
  if (functionIds.some((id) => typeof id !== 'string' || !id.trim())) return { ok: false, reason: 'phase8-corpus-function-id-invalid' };
  return {
    ok: true,
    sourceDigest: corpus.sourceDigest,
    functionCount: corpus.functions.length,
    functionIdsDigest: stableDigest(functionIds),
    machineFunctionCount: machineFunctions.length,
    machineFunctionBytesDigest: stableDigest(functionHashes),
    machineArtifactIdsDigest: stableDigest(expectedMachineArtifacts),
    nativeArtifactIdsDigest: stableDigest(expectedNativeArtifacts),
  };
}

function completePhase8CandidateObservations(observations, expectedFunctionIds) {
  if (!Array.isArray(observations) || observations.length !== expectedFunctionIds.length) {
    return { ok: false, reason: 'phase8-observation-denominator-mismatch' };
  }
  const seen = new Set();
  for (const [index, observation] of observations.entries()) {
    if (observation == null || typeof observation !== 'object' || Array.isArray(observation)) {
      return { ok: false, reason: 'phase8-observation-incomplete', index };
    }
    if (observation.id !== expectedFunctionIds[index] || seen.has(observation.id)) {
      return { ok: false, reason: 'phase8-observation-denominator-mismatch', index, observedId: observation.id ?? null };
    }
    seen.add(observation.id);
    if (observation.failure != null || observation.semantic !== true) {
      return { ok: false, reason: 'phase8-observation-incomplete', index, id: observation.id, kind: observation.failure != null ? 'failure' : 'nonsemantic' };
    }
    for (const field of ['gotos', 'rawAssemblyFallbacks']) {
      const value = observation.readability?.[field];
      if (!Number.isSafeInteger(value) || value < 0) {
        return { ok: false, reason: 'phase8-observation-nonfinite', index, id: observation.id, field };
      }
    }
  }
  return { ok: true };
}

/**
 * Compare two observation vectors without producing a measurement envelope.
 *
 * This small pure contract keeps fixture-level tests focused on candidate
 * completeness and metric-field independence.  The integrated measurement
 * path below supplies the immutable corpus IDs and the repository-owned frozen
 * baseline before it calls this helper.
 */
export function comparePhase8Quality({ metricId, observations, baselineObservations, expectedFunctionIds, direction = 'lower' } = {}) {
  const field = qualityMetric(metricId);
  if (!Array.isArray(expectedFunctionIds)
      || !Array.isArray(observations)
      || !Array.isArray(baselineObservations)
      || observations.length !== expectedFunctionIds.length
      || baselineObservations.length !== expectedFunctionIds.length
      || stableDigest(observations.map((row) => row?.id)) !== stableDigest(expectedFunctionIds)
      || stableDigest(baselineObservations.map((row) => row?.id)) !== stableDigest(expectedFunctionIds)) {
    return { ok: false, reason: 'phase8-observation-denominator-mismatch' };
  }
  const completeness = completePhase8CandidateObservations(observations, expectedFunctionIds);
  if (!completeness.ok) return { ok: false, reason: completeness.reason, identityFailure: completeness };
  let candidate;
  let reference;
  try {
    candidate = qualityVector(observations);
    reference = qualityVector(baselineObservations);
  } catch {
    return { ok: false, reason: 'phase8-quality-value-missing' };
  }
  const candidateValue = candidate[field];
  const referenceValue = reference[field];
  if (!finiteNumber(candidateValue) || !finiteNumber(referenceValue)) {
    return { ok: false, reason: 'phase8-quality-value-missing' };
  }
  return {
    ok: true,
    field,
    candidate,
    reference,
    candidateValue,
    referenceValue,
    comparison: comparison(direction, candidateValue, referenceValue),
    candidateIdentity: observationIdentity(observations),
    baselineIdentity: observationIdentity(baselineObservations),
  };
}

function digestOrNull(value) {
  try { return stableDigest(value); } catch { return null; }
}

/**
 * Load the repository-owned P8 authority as one identity-bearing unit.
 *
 * The historical observations are intentionally allowed to contain incomplete
 * rows.  Their semantic/readability shape is part of the frozen question, so
 * this boundary validates the file and sidecar identities without applying the
 * candidate completeness contract to the reference rows.
 */
function phase8FrozenAuthority() {
  try {
    const baseline = loadFrozenBaseline();
    const provenance = loadFrozenProvenance(undefined, baseline);
    const corpus = loadCorpus();
    const baselineObservationsDigest = digestOrNull(baseline.observations);
    if (baseline.schemaVersion !== 1 || corpus.schemaVersion !== 2
        || !HEX40_RE.test(String(baseline.baseCommit || ''))
        || !HEX40_RE.test(String(provenance.baseProductSha || ''))
        || baseline.baseCommit !== provenance.baseProductSha
        || stableDigest(baseline.toolchain) !== stableDigest(corpus.toolchain)
        || !Array.isArray(baseline.observations)
        || baselineObservationsDigest == null
        || baseline.observationsDigest !== baselineObservationsDigest) {
      return { ok: false, reason: 'phase8-frozen-baseline-invalid' };
    }
    if (baseline.corpusId !== corpus.corpusId
        || baseline.corpusVersion !== corpus.corpusVersion
        || baseline.corpusDigest !== corpus.corpusDigest) {
      return { ok: false, reason: 'phase8-frozen-authority-identity-mismatch' };
    }
    return {
      ok: true,
      baseline,
      baselineDigest: digestOrNull(baseline),
      provenance,
      provenanceDigest: digestOrNull(provenance),
      corpus,
      corpusDigest: digestOrNull(corpus),
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'phase8-frozen-authority-unavailable',
      detail: firstLine(error?.message || error),
    };
  }
}

function bindPhase8FrozenAuthority({ baseline, provenance, corpus }, authority) {
  if (!authority.ok) return authority;
  if (baseline !== undefined) {
    const observedDigest = digestOrNull(baseline);
    if (observedDigest == null || observedDigest !== authority.baselineDigest) {
      return {
        ok: false,
        reason: 'phase8-frozen-baseline-authority-mismatch',
        expectedDigest: authority.baselineDigest,
        observedDigest,
        expectedBaseCommit: authority.baseline.baseCommit,
        observedBaseCommit: baseline?.baseCommit ?? null,
      };
    }
  }
  // A provenance sidecar is not accepted because it is internally
  // self-consistent; it must be the committed sidecar bound to the committed
  // historical baseline.  The nested form is rejected as well so callers
  // cannot smuggle a second reference alongside an otherwise valid baseline.
  const suppliedProvenance = provenance !== undefined
    ? provenance
    : baseline != null && typeof baseline === 'object' && Object.prototype.hasOwnProperty.call(baseline, 'provenance')
      ? baseline.provenance
      : undefined;
  if (suppliedProvenance !== undefined) {
    const observedDigest = digestOrNull(suppliedProvenance);
    if (observedDigest == null || observedDigest !== authority.provenanceDigest) {
      return {
        ok: false,
        reason: 'phase8-frozen-provenance-authority-mismatch',
        expectedDigest: authority.provenanceDigest,
        observedDigest,
        expectedBaseCommit: authority.provenance.baseProductSha,
        observedBaseCommit: suppliedProvenance?.baseProductSha ?? null,
      };
    }
  }
  if (corpus !== undefined) {
    const observedDigest = digestOrNull(corpus);
    if (observedDigest == null || observedDigest !== authority.corpusDigest) {
      return {
        ok: false,
        reason: 'phase8-frozen-corpus-authority-mismatch',
        expectedDigest: authority.corpusDigest,
        observedDigest,
      };
    }
  }
  // Always return the loaded objects.  A caller may provide a deep clone of
  // the authority, but the score must read the repository-owned objects rather
  // than carrying caller-owned reference rows into the result.
  return {
    ok: true,
    baseline: authority.baseline,
    provenance: authority.provenance,
    corpus: authority.corpus,
  };
}

function phase8AuthorityLineage(authority) {
  const corpus = authority.corpus;
  const machineFunctions = corpus.functions.filter((entry) => entry?.representation === 'machine-bytes');
  const machineFunctionHashes = machineFunctions.map((entry) => ({
    id: entry.id,
    sha256: sha256Bytes(Buffer.from(entry.bytes, 'hex')),
  }));
  const machineArtifactIds = sortedUnique(machineFunctions.map(phase8ArtifactIdFor).filter(Boolean));
  const nativeArtifactIds = sortedUnique(corpus.functions
    .filter((entry) => entry?.architectureId === 'arm64')
    .map((entry) => `arm64-native-${entry.source}-${String(entry.optimization).replace(/^-/, '')}`));
  return {
    sourceDigest: corpus.sourceDigest,
    functionIdsDigest: stableDigest(corpus.functions.map((entry) => entry.id)),
    machineFunctionCount: machineFunctions.length,
    machineFunctionBytesDigest: stableDigest(machineFunctionHashes),
    machineArtifactIdsDigest: stableDigest(machineArtifactIds),
    nativeArtifactIdsDigest: stableDigest(nativeArtifactIds),
  };
}

function validateMeasuredPhase8Authority(value) {
  const authority = phase8FrozenAuthority();
  if (!authority.ok) measurementError('frozen-authority', value.metricId);
  const denominator = value.denominator;
  const oracle = value.semanticOracle;
  const lineage = phase8AuthorityLineage(authority);
  const referenceQuality = qualityVector(authority.baseline.observations);
  const referenceField = MEASUREMENT_CONFIG[value.metricId].field;
  if (value.referenceTool !== 'phase8-frozen-source-baseline'
      || value.referenceVersion !== authority.baseline.baseCommit) {
    measurementError('frozen-baseline-identity', value.metricId);
  }
  if (denominator.corpusDigest !== authority.corpus.corpusDigest
      || denominator.functionCount !== authority.corpus.functions.length
      || denominator.sourceDigest !== lineage.sourceDigest
      || denominator.functionIdsDigest !== lineage.functionIdsDigest
      || denominator.machineFunctionCount !== lineage.machineFunctionCount
      || denominator.machineFunctionBytesDigest !== lineage.machineFunctionBytesDigest
      || denominator.machineArtifactIdsDigest !== lineage.machineArtifactIdsDigest
      || denominator.nativeArtifactIdsDigest !== lineage.nativeArtifactIdsDigest
      || denominator.baselineObservationsDigest !== authority.baseline.observationsDigest
      || denominator.baselineProvenanceDigest !== authority.provenance.observationsDigest
      || denominator.baselineCommit !== authority.baseline.baseCommit) {
    measurementError('frozen-baseline-denominator', value.metricId);
  }
  if (value.referenceValue !== referenceQuality[referenceField]) {
    measurementError('frozen-baseline-value', value.metricId);
  }
  if (oracle.corpusDigest !== authority.corpus.corpusDigest
      || oracle.sourceDigest !== lineage.sourceDigest
      || oracle.functionIdsDigest !== lineage.functionIdsDigest
      || oracle.machineFunctionBytesDigest !== lineage.machineFunctionBytesDigest
      || oracle.baselineObservationDigest !== authority.baseline.observationsDigest
      || oracle.baselineLedgerDigest !== authority.baseline.observationsDigest
      || oracle.baselineProvenanceDigest !== authority.provenance.observationsDigest
      || oracle.baselineCommit !== authority.baseline.baseCommit
      || oracle.provenanceBaseCommit !== authority.provenance.baseProductSha) {
    measurementError('frozen-baseline-oracle', value.metricId);
  }
}

function validateMeasuredNativePhase8Authority(value) {
  let authority;
  try { authority = loadNativeAuthority(); }
  catch (error) { measurementError('native-authority', `${value.metricId}:${error?.message || String(error)}`); }
  const baseline = authority.baseline;
  const denominator = value.denominator;
  const oracle = value.semanticOracle;
  const lineage = phase8AuthorityLineage({ corpus:authority.corpus });
  const referenceQuality = qualityVector(baseline.observations);
  const referenceField = MEASUREMENT_CONFIG[value.metricId].field;
  if (value.referenceMode !== PHASE8_REFERENCE_MODES.NATIVE_PAIRED
      || value.referenceTool !== 'phase8-native-paired-baseline'
      || value.referenceVersion !== baseline.referenceDigest) {
    measurementError('native-baseline-identity', value.metricId);
  }
  if (denominator.corpusDigest !== authority.corpus.corpusDigest
      || denominator.functionCount !== authority.corpus.functions.length
      || denominator.sourceDigest !== lineage.sourceDigest
      || denominator.functionIdsDigest !== lineage.functionIdsDigest
      || denominator.machineFunctionCount !== lineage.machineFunctionCount
      || denominator.machineFunctionBytesDigest !== lineage.machineFunctionBytesDigest
      || denominator.machineArtifactIdsDigest !== lineage.machineArtifactIdsDigest
      || denominator.nativeArtifactIdsDigest !== lineage.nativeArtifactIdsDigest
      || denominator.baselineObservationsDigest !== baseline.observationsDigest
      || denominator.baselineProvenanceDigest !== authority.provenance.observationsDigest
      || denominator.baselineCommit !== baseline.baseCommit) {
    measurementError('native-baseline-denominator', value.metricId);
  }
  if (value.referenceValue !== referenceQuality[referenceField]) measurementError('native-baseline-value', value.metricId);
  if (oracle.nativeReferenceDigest !== baseline.referenceDigest
      || oracle.nativeAdapterId !== baseline.reference.adapter?.id
      || oracle.nativeAdapterSourceSha256 !== baseline.reference.adapter?.sourceSha256
      || oracle.nativeCaptureDigest !== baseline.reference.capture?.captureDigest
      || oracle.nativeArtifactIdentityDigest !== baseline.reference.capture?.artifactIdentityDigest
      || oracle.nativeCaptureMetricId !== baseline.reference.capture?.metricId) {
    measurementError('native-baseline-oracle', value.metricId);
  }
}

function validateMeasuredNativeOracle(value, metricConfig, capture) {
  const oracle = value.semanticOracle;
  if (oracle.schemaVersion !== 'hex-competitive-semantic-oracle/v1') measurementError('oracle-schema', value.metricId);
  if (oracle.kind !== 'native-paired-source-corpus-observation' || oracle.metricField !== metricConfig.field) {
    measurementError('native-oracle-kind', value.metricId);
  }
  if (oracle.referenceMode !== PHASE8_REFERENCE_MODES.NATIVE_PAIRED) measurementError('native-oracle-mode', value.metricId);
  const authority = loadNativeAuthority();
  const baseline = authority.baseline;
  const corpus = authority.corpus;
  if (capture.metricId !== baseline.reference.capture?.metricId) {
    measurementError('native-oracle-capture-metric', value.metricId);
  }
  if (oracle.corpusId !== capture.corpusId || oracle.corpusVersion !== capture.corpusVersion
      || oracle.corpusId !== corpus.corpusId || oracle.corpusDigest !== corpus.corpusDigest) {
    measurementError('native-oracle-corpus-mismatch', value.metricId);
  }
  for (const key of ['sourceDigest', 'functionIdsDigest', 'machineFunctionBytesDigest', 'candidateObservationDigest', 'baselineObservationDigest', 'baselineLedgerDigest', 'baselineProvenanceDigest']) {
    if (!HEX32_RE.test(String(oracle[key] || ''))) measurementError(`native-oracle-${key}`, value.metricId);
  }
  if (oracle.baselineObservationDigest !== baseline.observationsDigest
      || oracle.baselineLedgerDigest !== baseline.observationsDigest
      || oracle.baselineProvenanceDigest !== authority.provenance.observationsDigest
      || oracle.baselineCommit !== baseline.baseCommit
      || oracle.provenanceBaseCommit !== baseline.baseCommit
      || oracle.nativeReferenceDigest !== baseline.referenceDigest
      || oracle.nativeAdapterId !== baseline.reference.adapter?.id
      || oracle.nativeAdapterSourceSha256 !== baseline.reference.adapter?.sourceSha256
      || oracle.nativeCaptureDigest !== baseline.reference.capture?.captureDigest
      || oracle.nativeArtifactIdentityDigest !== baseline.reference.capture?.artifactIdentityDigest
      || oracle.nativeCaptureMetricId !== baseline.reference.capture?.metricId) {
    measurementError('native-oracle-identity', value.metricId);
  }
  if (!Array.isArray(oracle.nativeCaptureCompilerIdentities)
      || stableDigest(oracle.nativeCaptureCompilerIdentities) !== stableDigest(baseline.reference.capture?.compilerIdentities)
      || !Array.isArray(oracle.nativeCaptureSourceIdentities)
      || stableDigest(oracle.nativeCaptureSourceIdentities) !== stableDigest(baseline.reference.capture?.sourceIdentities)
      || !Array.isArray(oracle.nativeCaptureLinkerIdentities)
      || stableDigest(oracle.nativeCaptureLinkerIdentities) !== stableDigest(baseline.reference.capture?.linkerIdentities)) {
    measurementError('native-oracle-toolchain', value.metricId);
  }
  if (oracle.corpusVersion !== corpus.corpusVersion || !Number.isSafeInteger(oracle.corpusVersion) || oracle.corpusVersion < 0) {
    measurementError('oracle-corpus-version', value.metricId);
  }
}

/** Bind P8 candidate observations to the selected immutable source/corpus authority. */
export function measurePhase8Quality({ metricId, observations, baseline, provenance, corpus, capture, observationMethod = null, referenceMode = PHASE8_REFERENCE_MODES.FROZEN_LEGACY, nativeAdapterIdentity = null, direction = 'lower', sourceDirectory = PHASE8_SOURCE_DIRECTORY } = {}) {
  const field = qualityMetric(metricId);
  const nativeObservationRows = (Array.isArray(observations) ? observations : [])
    .filter((observation) => observation?.observationMethod === PHASE8_NATIVE_ARM64_OBSERVATION_METHOD);
  const nativeReference = referenceMode === PHASE8_REFERENCE_MODES.NATIVE_PAIRED;
  const nativeRequested = nativeReference
    || observationMethod === PHASE8_NATIVE_ARM64_OBSERVATION_METHOD
    || nativeObservationRows.length > 0;
  let binding;
  let nativeAuthority = null;
  let nativeAdapterBinding = null;
  if (nativeReference) {
    if (nativeObservationRows.length === 0) {
      return unmeasured(metricId, capture, 'phase8-native-observation-method-missing', {
        expectedObservationMethod: PHASE8_NATIVE_ARM64_OBSERVATION_METHOD,
      });
    }
    try {
      // Load the repository-owned corpus independently.  A caller-supplied
      // object is input evidence and must be compared against that authority;
      // passing it into the loader would make a mutated object self-authorize.
      nativeAuthority = loadNativeAuthority();
    } catch (error) {
      return unmeasured(metricId, capture, 'phase8-native-baseline-unavailable', {
        detail: firstLine(error?.message || error),
      });
    }
    if (baseline !== undefined && digestOrNull(baseline) !== digestOrNull(nativeAuthority.baseline)) {
      return unmeasured(metricId, capture, 'phase8-native-baseline-authority-mismatch', {
        expectedDigest: digestOrNull(nativeAuthority.baseline),
        observedDigest: digestOrNull(baseline),
        expectedBaseCommit: nativeAuthority.baseline.baseCommit,
        observedBaseCommit: baseline?.baseCommit ?? null,
      });
    }
    if (provenance !== undefined && digestOrNull(provenance) !== digestOrNull(nativeAuthority.provenance)) {
      return unmeasured(metricId, capture, 'phase8-native-provenance-authority-mismatch', {
        expectedDigest: digestOrNull(nativeAuthority.provenance),
        observedDigest: digestOrNull(provenance),
      });
    }
    if (corpus !== undefined && digestOrNull(corpus) !== digestOrNull(nativeAuthority.corpus)) {
      return unmeasured(metricId, capture, 'phase8-native-corpus-authority-mismatch', {
        expectedDigest: digestOrNull(nativeAuthority.corpus),
        observedDigest: digestOrNull(corpus),
      });
    }
    baseline = nativeAuthority.baseline;
    provenance = nativeAuthority.provenance;
    corpus = nativeAuthority.corpus;
    binding = { ok: true, baseline, provenance, corpus };
    nativeAdapterBinding = nativeAdapterIdentity;
    const expectedAdapter = baseline.reference?.adapter;
    const observedAdapter = nativeAdapterBinding;
    const observedAdapterCommit = observedAdapter?.captureOverlayCommit ?? observedAdapter?.commit;
    if (observedAdapter == null
        || observedAdapter.id !== expectedAdapter?.id
        || observedAdapter.sourcePath !== expectedAdapter?.sourcePath
        || observedAdapter.sourceSha256 !== expectedAdapter?.sourceSha256
        || observedAdapterCommit !== expectedAdapter?.commit) {
      return unmeasured(metricId, capture, 'phase8-native-adapter-identity-mismatch', {
        expectedAdapter: expectedAdapter ?? null,
        observedAdapter: observedAdapter ?? null,
      });
    }
    const expectedArmIds = corpus.functions
      .filter((entry) => entry?.architectureId === 'arm64')
      .map((entry) => entry.id);
    const observationsById = new Map((Array.isArray(observations) ? observations : [])
      .filter((observation) => observation?.id != null)
      .map((observation) => [observation.id, observation]));
    const missingNativeIds = expectedArmIds.filter((id) => observationsById.get(id)?.observationMethod !== PHASE8_NATIVE_ARM64_OBSERVATION_METHOD);
    const foreignNativeIds = (Array.isArray(observations) ? observations : [])
      .filter((observation) => observation?.observationMethod === PHASE8_NATIVE_ARM64_OBSERVATION_METHOD
        && !expectedArmIds.includes(observation.id))
      .map((observation) => observation.id);
    if (missingNativeIds.length > 0 || foreignNativeIds.length > 0) {
      return unmeasured(metricId, capture, 'phase8-native-observation-denominator-mismatch', {
        expectedNativeObservationCount: expectedArmIds.length,
        observedNativeObservationCount: nativeObservationRows.length,
        missingNativeIds,
        foreignNativeIds,
      });
    }
  } else {
    const authority = phase8FrozenAuthority();
    binding = bindPhase8FrozenAuthority({ baseline, provenance, corpus }, authority);
    if (!binding.ok) return unmeasured(metricId, capture, binding.reason, {
      expectedDigest: binding.expectedDigest,
      observedDigest: binding.observedDigest,
      expectedBaseCommit: binding.expectedBaseCommit,
      observedBaseCommit: binding.observedBaseCommit,
    });
    baseline = binding.baseline;
    provenance = binding.provenance;
    corpus = binding.corpus;
  }
  const identity = captureIdentity(capture, {
    expectedMetricId: metricId,
    allowSharedPhase8Capture: nativeReference,
  });
  if (!identity.ok) return unmeasured(metricId, capture, identity.reason);
  if (identity.capture.corpusId !== corpus.corpusId || identity.capture.corpusVersion !== corpus.corpusVersion) {
    return unmeasured(metricId, capture, 'phase8-corpus-identity-mismatch', { captureCorpusId: identity.capture.corpusId, corpusId: corpus.corpusId });
  }
  if (baseline?.corpusId !== corpus.corpusId || baseline?.corpusVersion !== corpus.corpusVersion || baseline?.corpusDigest !== corpus.corpusDigest) {
    return unmeasured(metricId, capture, nativeReference ? 'phase8-native-baseline-identity-mismatch' : 'phase8-frozen-baseline-identity-mismatch');
  }
  const frozenCompiler = compilerVersionToken(corpus.toolchain?.compiler);
  const capturedCompilers = sortedUnique((capture.artifacts || [])
    .map((artifact) => compilerVersionToken(artifact.manifest?.compiler?.version))
    .filter(Boolean));
  if (frozenCompiler != null && (capturedCompilers.length !== 1 || capturedCompilers[0] !== frozenCompiler)) {
    return unmeasured(metricId, capture, 'phase8-corpus-toolchain-mismatch', {
      frozenCompiler,
      capturedCompilers,
    });
  }
  const lineage = validatePhase8CaptureLineage(corpus, capture, { sourceDirectory });
  if (!lineage.ok) return unmeasured(metricId, capture, lineage.reason, { identityFailure: lineage });
  if (nativeReference) {
    const observedCapture = nativeCaptureIdentity(identity.capture);
    const expectedCapture = baseline.reference?.capture;
    if (observedCapture == null
        || observedCapture.captureDigest !== expectedCapture?.captureDigest
        || observedCapture.artifactIdsDigest !== expectedCapture?.artifactIdsDigest
        || observedCapture.artifactIdentityDigest !== expectedCapture?.artifactIdentityDigest
        || digestOrNull(observedCapture.compilerIdentities) !== digestOrNull(expectedCapture?.compilerIdentities)
        || digestOrNull(observedCapture.sourceIdentities) !== digestOrNull(expectedCapture?.sourceIdentities)
        || digestOrNull(observedCapture.linkerIdentities) !== digestOrNull(expectedCapture?.linkerIdentities)) {
      return unmeasured(metricId, capture, 'phase8-native-capture-authority-mismatch', {
        expectedCapture: expectedCapture ?? null,
        observedCapture,
      });
    }
  }
  const recomputedBaselineDigest = Array.isArray(baseline?.observations) ? stableDigest(baseline.observations) : null;
  if (typeof baseline?.observationsDigest !== 'string' || recomputedBaselineDigest == null || baseline.observationsDigest !== recomputedBaselineDigest) {
    return unmeasured(metricId, capture, nativeReference ? 'phase8-native-baseline-digest-mismatch' : 'phase8-frozen-baseline-digest-mismatch', {
      expected: recomputedBaselineDigest,
      observed: baseline?.observationsDigest ?? null,
    });
  }
  if (nativeRequested && !nativeReference) {
    return unmeasured(metricId, capture, 'phase8-reference-method-mismatch', {
      candidateObservationMethod: PHASE8_NATIVE_ARM64_OBSERVATION_METHOD,
      referenceObservationMethod: 'frozen-legacy-assembly',
      nativeObservationCount: nativeObservationRows.length,
      nativeObservationIds: nativeObservationRows.map((observation) => observation.id),
    });
  }
  const expectedFunctionIds = corpus.functions.map((row) => row?.id);
  const compared = comparePhase8Quality({
    metricId,
    observations,
    baselineObservations: baseline.observations,
    expectedFunctionIds,
    direction,
  });
  if (!compared.ok) return unmeasured(metricId, capture, compared.reason, { identityFailure: compared.identityFailure });
  const {
    candidate,
    reference,
    candidateValue,
    referenceValue,
    candidateIdentity,
    baselineIdentity,
  } = compared;
  const referenceTool = nativeReference
    ? 'phase8-native-paired-baseline'
    : 'phase8-frozen-source-baseline';
  const referenceVersion = nativeReference
    ? String(baseline.referenceDigest || 'unknown')
    : String(baseline.baseCommit || 'unknown');
  const semanticOracle = {
    schemaVersion: 'hex-competitive-semantic-oracle/v1',
    kind: nativeReference ? 'native-paired-source-corpus-observation' : 'frozen-source-corpus-observation',
    metricField: field,
    referenceMode,
    runtime: runtimeIdentity(),
    frozenCompiler,
    capturedCompilers,
    corpusId: corpus.corpusId,
    corpusVersion: corpus.corpusVersion,
    corpusDigest: corpus.corpusDigest,
    sourceDigest: lineage.sourceDigest,
    functionIdsDigest: lineage.functionIdsDigest,
    machineFunctionBytesDigest: lineage.machineFunctionBytesDigest,
    candidateObservationDigest: candidateIdentity.digest,
    baselineObservationDigest: baselineIdentity.digest,
    baselineLedgerDigest: baseline.observationsDigest,
    baselineProvenanceDigest: binding.provenance.observationsDigest,
    baselineCommit: baseline.baseCommit,
    provenanceBaseCommit: binding.provenance.baseProductSha ?? binding.provenance.baseCommit ?? baseline.baseCommit,
    ...(nativeReference ? {
      nativeReferenceDigest: baseline.referenceDigest,
      nativeAdapterId: nativeAdapterBinding.id,
      nativeAdapterSourceSha256: nativeAdapterBinding.sourceSha256,
      nativeCaptureDigest: baseline.reference.capture.captureDigest,
      nativeArtifactIdentityDigest: baseline.reference.capture.artifactIdentityDigest,
      nativeCaptureMetricId: baseline.reference.capture.metricId,
      nativeCaptureCompilerIdentities: baseline.reference.capture.compilerIdentities,
      nativeCaptureSourceIdentities: baseline.reference.capture.sourceIdentities,
      nativeCaptureLinkerIdentities: baseline.reference.capture.linkerIdentities,
    } : {}),
  };
  const evidenceRefs = nativeReference
    ? [
      'tests/phase8/corpus/pre-phase8-native-observations.json',
      'tests/phase8/corpus/pre-phase8-native-provenance.json',
      'tools/validation/phase8/decompile-corpus.mjs',
      'tools/validation/phase8/metrics.mjs',
    ]
    : [
      'tests/phase8/corpus/**',
      'tests/phase8/corpus/pre-phase8-provenance.json',
      'tools/validation/phase8/decompile-corpus.mjs',
      'tools/validation/phase8/metrics.mjs',
    ];
  return measured({
    metricId,
    capture,
    direction,
    corpusId: corpus.corpusId,
    candidateValue,
    referenceValue,
    denominator: {
      kind: 'phase8-frozen-function-corpus',
      functionCount: corpus.functions.length,
      corpusDigest: corpus.corpusDigest,
      sourceDigest: lineage.sourceDigest,
      functionIdsDigest: lineage.functionIdsDigest,
      machineFunctionCount: lineage.machineFunctionCount,
      machineFunctionBytesDigest: lineage.machineFunctionBytesDigest,
      machineArtifactIdsDigest: lineage.machineArtifactIdsDigest,
      nativeArtifactIdsDigest: lineage.nativeArtifactIdsDigest,
      candidateObservationsDigest: candidateIdentity.digest,
      baselineObservationsDigest: baseline.observationsDigest,
      baselineProvenanceDigest: binding.provenance.observationsDigest,
      baselineCommit: baseline.baseCommit,
    },
    referenceTool,
    referenceVersion,
    referenceMode,
    semanticOracle,
    evidenceRefs,
    details: { candidateQuality: candidate, referenceQuality: reference },
  });
}

/** Collect all four binary records from already captured evidence. */
export function collectCompetitiveMeasurements({ capturesByMetric = {}, phase5Ledger = null, phase6Ledger = null, phase8Observations = null, phase8Baseline = null, phase8Corpus = null, phase8ObservationMethod = null, phase8ReferenceMode = PHASE8_REFERENCE_MODES.FROZEN_LEGACY, phase8NativeAdapterIdentity = null } = {}) {
  const records = {};
  records['machine-effects-x86_64-coverage'] = measurePhase56Coverage({
    metricId: 'machine-effects-x86_64-coverage',
    ledger: phase5Ledger,
    capture: capturesByMetric['machine-effects-x86_64-coverage'],
  });
  records['machine-effects-riscv64-coverage'] = measurePhase56Coverage({
    metricId: 'machine-effects-riscv64-coverage',
    ledger: phase6Ledger,
    capture: capturesByMetric['machine-effects-riscv64-coverage'],
  });
  for (const metricId of ['decompiler-quality-gotos', 'decompiler-quality-assembly-fallbacks']) {
    const sharedNativeCapture = phase8ReferenceMode === PHASE8_REFERENCE_MODES.NATIVE_PAIRED
      ? capturesByMetric['decompiler-quality-gotos']
      : null;
    records[metricId] = measurePhase8Quality({
      metricId,
      observations: phase8Observations,
      baseline: phase8Baseline || undefined,
      corpus: phase8Corpus || undefined,
      // The paired authority is one exact native corpus capture shared by both
      // quality fields.  A native result may use that capture under either
      // quality metric only after the digest and artifact identity match.
      capture: sharedNativeCapture || capturesByMetric[metricId] || capturesByMetric['decompiler-quality-gotos'],
      observationMethod: phase8ObservationMethod,
      referenceMode: phase8ReferenceMode,
      nativeAdapterIdentity: phase8NativeAdapterIdentity,
    });
  }
  return Object.freeze(records);
}

/** Parse one machine-readable ledger emitted by the focused P5/P6 test. */
const TAP_LEDGER_TRAILER = /^(?:Subtest:|tests |suites |pass |fail |cancelled |skipped |todo |duration_ms )/;

export function parsePipelineLedgerOutput(output, marker) {
  const text = String(output || '');
  const lines = text.split(/\r?\n/);
  let markerLineIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].includes(marker)) {
      markerLineIndex = index;
      break;
    }
  }
  if (markerLineIndex < 0) throw new Error('competitive-ledger-marker-missing:' + marker);
  const markerLine = lines[markerLineIndex];
  const markerOffset = markerLine.indexOf(marker);
  const tapWrapped = markerLine.slice(0, markerOffset).trim() === '#';
  let payload = markerLine.slice(markerOffset + marker.length).trim();
  if (tapWrapped) {
    for (let index = markerLineIndex + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.startsWith('# ')) break;
      const continuation = line.slice(2);
      if (TAP_LEDGER_TRAILER.test(continuation)) break;
      payload += continuation;
    }
    // node --test escapes diagnostic backslashes once in TAP output.
    payload = payload.replaceAll('\\\\', '\\');
  } else {
    payload = payload.split(/\r?\n/, 1)[0];
  }
  try { return JSON.parse(payload.trim()); } catch (error) { throw new Error('competitive-ledger-json-invalid:' + error.message); }
}

/** Execute only the focused P5/P6 producer and return its ledger. */
export function runPipelineLedger(metricId, { env = {}, node = process.execPath } = {}) {
  const spec = P56_METRIC[metricId];
  if (!spec) throw new TypeError(`competitive-pipeline-metric-unsupported:${metricId}`);
  const executionBefore = producerIdentity();
  if (executionBefore == null) throw new Error(`competitive-pipeline-execution-identity-unavailable:${metricId}`);
  const result = spawnSync(node, ['--test', spec.testPath], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  const executionAfter = producerIdentity();
  if (executionAfter == null
      || executionBefore.gitSha !== executionAfter.gitSha
      || executionBefore.treeSha !== executionAfter.treeSha) {
    throw new Error(`competitive-pipeline-source-changed-during-run:${metricId}`);
  }
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const ledger = parsePipelineLedgerOutput(output, spec.marker);
  ledger.executionIdentity = Object.freeze({ ...executionBefore, sourceStable: true });
  if (result.status !== 0) {
    const error = new Error(`competitive-pipeline-failed:${metricId}:${result.status}`);
    error.ledger = ledger;
    throw error;
  }
  return ledger;
}

/**
 * Collect Phase 8 rows through the frozen assembly path by default. A
 * validated native capture is an explicit opt-in used for a later authority
 * migration; it never changes the frozen corpus IDs or denominator.
 */
export function phase8CurrentObservations({ corpus = loadCorpus(), nativeArm64Capture = null, capture = null, decompilerTimeBudgetMs = 20000 } = {}) {
  return observeCorpus({
    corpus,
    nativeArm64Capture:nativeArm64Capture ?? capture,
    decompilerTimeBudgetMs,
  });
}

function writeJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, filePath);
}

function readJsonInput(value, label) {
  if (value == null) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label}-path-invalid`);
  const target = path.resolve(value);
  if (!fs.existsSync(target)) throw new Error(`${label}-missing:${target}`);
  try { return JSON.parse(fs.readFileSync(target, 'utf8')); }
  catch (error) { throw new Error(`${label}-json-invalid:${error.message}`); }
}

function nativeCaptureAuthorityMatches(capture) {
  try {
    const authority = loadNativeAuthority();
    const observed = nativeCaptureIdentity(capture);
    const expected = authority.baseline.reference?.capture;
    return observed != null
      && observed.captureDigest === expected?.captureDigest
      && observed.artifactIdsDigest === expected?.artifactIdsDigest
      && observed.artifactIdentityDigest === expected?.artifactIdentityDigest
      && digestOrNull(observed.compilerIdentities) === digestOrNull(expected?.compilerIdentities)
      && digestOrNull(observed.sourceIdentities) === digestOrNull(expected?.sourceIdentities)
      && digestOrNull(observed.linkerIdentities) === digestOrNull(expected?.linkerIdentities);
  } catch {
    return false;
  }
}

/**
 * Run the bounded repository-owned collection path.  P5/P6 are built once as
 * debug twins and the focused oracle tests reuse those exact files.  P8 uses
 * the frozen function corpus; if its compiler identity differs, its records
 * remain UNMEASURED as required by the profile.
 */
export function collectCompetitiveMeasurementsFromRepository({
  outputRoot,
  p56ToolchainBin = process.env.HEX_P56_TOOLCHAIN_BIN || null,
  p8Clang = process.env.CLANG || 'clang',
  p8ExpectedCompilerVersion,
  p8NativeArm64 = true,
  p8UseNativeArm64 = null,
  p8ReferenceMode = process.env.HEX_PHASE8_REFERENCE_MODE || PHASE8_REFERENCE_MODES.NATIVE_PAIRED,
  p8NativeArm64Capture = process.env.HEX_PHASE8_NATIVE_CAPTURE || null,
  decompilerTimeBudgetMs = 20000,
} = {}) {
  if (typeof outputRoot !== 'string' || !outputRoot.trim()) throw new TypeError('competitive-measurement-output-root-required');
  if (![PHASE8_REFERENCE_MODES.FROZEN_LEGACY, PHASE8_REFERENCE_MODES.NATIVE_PAIRED].includes(p8ReferenceMode)) {
    throw new TypeError(`competitive-phase8-reference-mode-unsupported:${p8ReferenceMode}`);
  }
  const root = path.resolve(outputRoot);
  const corpus = loadCorpus();
  const useNativeReference = p8ReferenceMode === PHASE8_REFERENCE_MODES.NATIVE_PAIRED;
  const useNativeArm64 = p8UseNativeArm64 == null ? useNativeReference : p8UseNativeArm64 === true;
  const expectedCompilerVersion = p8ExpectedCompilerVersion
    ?? (useNativeReference ? compilerVersionToken(corpus.toolchain?.compiler) : undefined);
  const suppliedNativeCapture = readJsonInput(p8NativeArm64Capture, 'phase8-native-capture');
  const captures = {};
  const captureSpecs = [
    ['machine-effects-x86_64-coverage', capturePhase5TwinWorkload, 'p5'],
    ['machine-effects-riscv64-coverage', capturePhase6TwinWorkload, 'p6'],
  ];
  for (const [metricId, builder, name] of captureSpecs) {
    const artifactRoot = path.join(root, name);
    captures[metricId] = builder({ artifactRoot, outDir: path.join(artifactRoot, 'debug'), toolchainBin: p56ToolchainBin });
    writeJson(path.join(root, `${name}-capture.json`), captures[metricId]);
  }
  const ledgers = {};
  const ledgerMetrics = [
    ['machine-effects-x86_64-coverage', 'p5'],
    ['machine-effects-riscv64-coverage', 'p6'],
  ];
  for (const [metricId, name] of ledgerMetrics) {
    if (captures[metricId].status !== 'READY') continue;
    try {
      ledgers[metricId] = runPipelineLedger(metricId, {
        env: {
          HEX_P56_TOOLCHAIN_BIN: p56ToolchainBin || '',
          HEX_P56_CORPUS_DIR: path.join(root, name, 'debug'),
          HEX_P56_CORPUS_DEBUG: '1',
          HEX_P56_REUSE_CORPUS: '1',
        },
      });
      writeJson(path.join(root, `${name}-ledger.json`), ledgers[metricId]);
    } catch (error) {
      ledgers[metricId] = error.ledger || null;
    }
  }
  for (const [metricId, name] of [
    ['decompiler-quality-gotos', 'p8-gotos'],
    ['decompiler-quality-assembly-fallbacks', 'p8-fallbacks'],
  ]) {
    // Native bytes contain debug provenance whose hashes depend on the exact
    // capture.  A preserved capture is therefore consumed verbatim and
    // independently replayed by the adapter; rebuilding it in another
    // checkout would silently produce a different authority identity.
    captures[metricId] = useNativeReference && suppliedNativeCapture != null
      ? suppliedNativeCapture
      : capturePhase8TwinWorkload({
        metricId,
        artifactRoot: path.join(root, name),
        artifactDirectory: path.join(root, name, 'debug'),
        clang: p8Clang,
        ...(expectedCompilerVersion == null ? {} : { expectedCompilerVersion }),
        nativeArm64: p8NativeArm64,
      });
    writeJson(path.join(root, `${name}-capture.json`), captures[metricId]);
  }
  const p8ArtifactsReady = captures['decompiler-quality-gotos'].status === 'READY'
    || captures['decompiler-quality-assembly-fallbacks'].status === 'READY';
  const p8Ready = p8ArtifactsReady
    && (!useNativeReference || nativeCaptureAuthorityMatches(captures['decompiler-quality-gotos']));
  // Native paired authority is the normal T026 collection path now that its
  // historical baseline is repository-owned.  Callers can retain the original
  // frozen assembly question by selecting FROZEN_LEGACY explicitly.
  const nativeArm64Capture = suppliedNativeCapture
    ?? (useNativeArm64 ? captures['decompiler-quality-gotos'] : null);
  const phase8ObservationMethod = nativeArm64Capture == null
    ? null
    : PHASE8_NATIVE_ARM64_OBSERVATION_METHOD;
  const phase8NativeAdapterBinding = nativeArm64Capture == null
    ? null
    : phase8NativeAdapterIdentity();
  const observations = p8Ready ? phase8CurrentObservations({ corpus, nativeArm64Capture, decompilerTimeBudgetMs }) : null;
  const measurements = {
    ...collectCompetitiveMeasurements({
      capturesByMetric: captures,
      phase5Ledger: ledgers['machine-effects-x86_64-coverage'] || null,
      phase6Ledger: ledgers['machine-effects-riscv64-coverage'] || null,
      phase8Observations: observations,
      phase8Corpus: corpus,
      phase8ObservationMethod,
      phase8ReferenceMode: useNativeReference ? PHASE8_REFERENCE_MODES.NATIVE_PAIRED : PHASE8_REFERENCE_MODES.FROZEN_LEGACY,
      phase8NativeAdapterIdentity: phase8NativeAdapterBinding,
    }),
    ...collectCompetitiveSourceMeasurements(),
  };
  writeJson(path.join(root, 'measurements.json'), measurements);
  return Object.freeze({ captures, measurements, outputRoot: root });
}

export { BINARY_METRICS };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (!process.argv.includes('--collect')) {
    console.error('competitive measurements: import collectCompetitiveMeasurements or pass --collect --output <directory>');
    process.exitCode = 2;
  } else {
    const outputIndex = process.argv.indexOf('--output');
    const outputRoot = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
    try {
      const referenceMode = process.argv.includes('--legacy')
        ? PHASE8_REFERENCE_MODES.FROZEN_LEGACY
        : process.argv.includes('--native') || process.argv.includes('--native-capture')
          ? PHASE8_REFERENCE_MODES.NATIVE_PAIRED
          : process.env.HEX_PHASE8_REFERENCE_MODE || PHASE8_REFERENCE_MODES.NATIVE_PAIRED;
      const captureIndex = process.argv.indexOf('--native-capture');
      const nativeCapture = captureIndex >= 0 ? process.argv[captureIndex + 1] : null;
      const result = collectCompetitiveMeasurementsFromRepository({
        outputRoot,
        p8ReferenceMode:referenceMode,
        ...(nativeCapture == null ? {} : { p8NativeArm64Capture:nativeCapture }),
      });
      console.log(JSON.stringify({ outputRoot: result.outputRoot, measurements: Object.fromEntries(Object.entries(result.measurements).map(([metricId, measurement]) => [metricId, { status: measurement.status, candidateValue: measurement.candidateValue, referenceValue: measurement.referenceValue, comparison: measurement.comparison, reason: measurement.reason }])) }, null, 2));
    } catch (error) {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    }
  }
}
