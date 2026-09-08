/**
 * Repository-owned nonbinary competitive measurements.
 *
 * These rows are source-fixture measurements rather than binary-twin rows.
 * The expected side is generated from frozen fixture/denominator truth;
 * it never comes from the candidate implementation or a hand-entered number.
 * ARM64 coverage is measured from the complete repository-owned A2 registry
 * denominator. The historical one-branch sample is never used as evidence.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { stableDigest } from '../../../js/core/identity/index.js';
import {
  ALIAS_QUERIES_V2,
  buildFixture,
  memoryAccessOf,
  regionOf,
  scoreAliasQueriesV2,
} from '../phase7/scoring.mjs';
import { CORPUS_V2_ID, CORPUS_V2_VERSION } from '../../../tests/phase7/corpus/fixtures.mjs';
import { createPhase7AliasSolver } from '../../../js/analysis/alias/solver.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCE_FIXTURE_SCHEMA = 'hex-competitive-source-oracle/v1';
const ARM64_RUNNER_SCHEMA = 'hex-competitive-arm64-source-runner/v1';
const HEX40_RE = /^[0-9a-f]{40}$/i;
const ALIAS_SOURCE_FILES = Object.freeze([
  'tests/phase7/corpus/fixtures.mjs',
  'tools/validation/phase7/scoring.mjs',
]);
const ALIAS_SOURCE_METRIC_CONFIG = Object.freeze({
  'alias-v2-exact-precision': Object.freeze({ field: 'exactPrecision', direction: 'higher', runPolicy: 'cold-and-warm' }),
  'alias-v2-exact-recall': Object.freeze({ field: 'exactRecall', direction: 'higher', runPolicy: 'cold-and-warm' }),
  'alias-v2-false-must-alias': Object.freeze({ field: 'falseMustAlias', direction: 'exact-zero', runPolicy: 'exact' }),
  'alias-v2-false-no-alias': Object.freeze({ field: 'falseNoAlias', direction: 'exact-zero', runPolicy: 'exact' }),
});
const ARM64_METRIC_ID = 'machine-effects-arm64-coverage';
const ARM64_REFERENCE_TOOL = 'arm64-a64-canonical-denominator';
const ARM64_REFERENCE_VERSION = 'machine-effects-a2-denominator/v1';
const ARM64_CONFIGURATION = 'arm64-a64-complete-registry-v1';
const ARM64_SOURCE_FILES = Object.freeze([
  'js/targets/architecture/coverage.js',
  'js/targets/architecture/registry.js',
  'js/arm64.js',
  'js/semantics/effects/index.js',
  'js/targets/architecture/arm64/effects/index.js',
  'js/targets/architecture/arm64/effects/common.js',
  'js/targets/architecture/arm64/effects/bti-guard-state.js',
  'js/targets/architecture/arm64/effects/control.js',
  'js/targets/architecture/arm64/effects/flags.js',
  'js/targets/architecture/arm64/effects/fp.js',
  'js/targets/architecture/arm64/effects/integer.js',
  'js/targets/architecture/arm64/effects/memory.js',
  'js/targets/architecture/arm64/effects/simd.js',
  'js/targets/architecture/arm64/effects/system.js',
  'tools/validation/machine-effects/a2-denominator.mjs',
  'tools/validation/machine-effects/arm64-a64-control-denominator.mjs',
  'tools/validation/machine-effects/arm64-a64-decoder-denominator.mjs',
  'tools/validation/machine-effects/arm64-a64-flags-denominator.mjs',
  'tools/validation/machine-effects/arm64-a64-fp-denominator.mjs',
  'tools/validation/machine-effects/arm64-a64-integer-denominator.mjs',
  'tools/validation/machine-effects/arm64-a64-memory-denominator.mjs',
  'tools/validation/machine-effects/arm64-a64-simd-denominator.mjs',
  'tools/validation/machine-effects/arm64-a64-system-denominator.mjs',
  'tests/machine-effects/a2-denominator-inventory.json',
  'tests/machine-effects/helpers/arm64-capstone-session.mjs',
  'tests/machine-effects/helpers/llvm-toolchain.mjs',
  'tools/validation/competitive/arm64-source-runner.mjs',
  'capstone.js',
  'capstone.wasm',
]);

export const SOURCE_FIXTURE_METRIC_CONFIG = Object.freeze({
  ...Object.fromEntries(Object.entries(ALIAS_SOURCE_METRIC_CONFIG).map(([metricId, config]) => [metricId, Object.freeze({
    kind: 'source-fixture',
    authority: 'deterministic-fixture',
    corpusId: CORPUS_V2_ID,
    corpusVersion: CORPUS_V2_VERSION,
    ...config,
    available: true,
  })])),
  [ARM64_METRIC_ID]: Object.freeze({
    kind: 'source-fixture',
    authority: 'deterministic-fixture',
    corpusId: 'arm64-effects-corpus',
    corpusVersion: 2,
    field: 'coverageRate',
    direction: 'higher',
    runPolicy: 'exact',
    available: true,
  }),
});

export const SOURCE_FIXTURE_METRIC_IDS = Object.freeze(Object.keys(SOURCE_FIXTURE_METRIC_CONFIG));

function sourceError(code, detail = '') {
  throw new TypeError(`competitive-source-measurement-${code}${detail ? `:${detail}` : ''}`);
}

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', shell: false });
  const value = result.stdout?.trim() || '';
  if (result.error || result.status !== 0 || !HEX40_RE.test(value)) sourceError('git-identity-unavailable', args.join(' '));
  return value.toLowerCase();
}

function currentIdentity() {
  return Object.freeze({ gitSha: git(['rev-parse', 'HEAD']), treeSha: git(['rev-parse', 'HEAD^{tree}']) });
}

function sourceFiles() {
  return sourceFilesFor(ALIAS_SOURCE_FILES);
}

function sourceFilesFor(relativePaths) {
  return relativePaths.map((relativePath) => {
    const filePath = path.join(ROOT, relativePath);
    if (!fs.existsSync(filePath)) sourceError('source-file-missing', relativePath);
    return Object.freeze({ path: relativePath, sha256: sha256Bytes(fs.readFileSync(filePath)) });
  });
}

function arm64SourceIdentity() {
  const files = sourceFilesFor(ARM64_SOURCE_FILES);
  return Object.freeze({
    files,
    sourceDigest: stableDigest(files),
    corpusId: 'arm64-effects-corpus',
    corpusVersion: 2,
  });
}

function queryRows() {
  return ALIAS_QUERIES_V2.map((query) => ({
    id: query.id,
    fixture: query.fixture,
    left: query.left,
    right: query.right,
    truth: query.truth,
    truthSource: query.truthSource,
    proofClass: query.proofClass,
    category: query.category,
  }));
}

function sourceIdentity() {
  const files = sourceFiles();
  const rows = queryRows();
  return Object.freeze({
    files,
    sourceDigest: stableDigest(files),
    corpusId: CORPUS_V2_ID,
    corpusVersion: CORPUS_V2_VERSION,
    queryCount: rows.length,
    queryIdsDigest: stableDigest(rows.map((row) => row.id)),
    truthDigest: stableDigest(rows),
  });
}

function truthRelation(query) {
  if (query.truth === 'must' || query.truth === 'no' || query.truth === 'may') return query.truth;
  if (query.truth === 'may-or-weaker') return 'may';
  sourceError('truth-invalid', `${query.id}:${query.truth}`);
}

function expectedTruthAnswer(query) {
  return { relation: truthRelation(query) };
}

function aliasCandidateScore() {
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
  return scoreAliasQueriesV2(candidateAnswer, { queries: ALIAS_QUERIES_V2 });
}

function aliasTruthScore() {
  return scoreAliasQueriesV2(expectedTruthAnswer, { queries: ALIAS_QUERIES_V2 });
}

function finite(value, code) {
  if (typeof value !== 'number' || !Number.isFinite(value)) sourceError(code);
  return value;
}

function comparison(direction, candidateValue, referenceValue) {
  if (direction === 'higher') return candidateValue > referenceValue ? 'WIN' : candidateValue === referenceValue ? 'TIE' : 'LOSS';
  if (direction === 'exact-zero') return candidateValue === 0 && referenceValue === 0 ? 'TIE' : candidateValue === 0 ? 'WIN' : 'LOSS';
  sourceError('direction-unsupported', direction);
}

let arm64RunnerCache = null;

function runArm64SourceRunner(identity, producer = currentIdentity()) {
  const cacheKey = `${identity.sourceDigest}:${producer.gitSha}:${producer.treeSha}`;
  if (arm64RunnerCache?.key === cacheKey) return arm64RunnerCache.value;
  const runnerPath = path.join(ROOT, 'tools/validation/competitive/arm64-source-runner.mjs');
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    sourceError('arm64-runner-failed', `${result.error?.message || result.stderr || result.status}`);
  }
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch (error) {
    sourceError('arm64-runner-json-invalid', error.message);
  }
  if (value?.schemaVersion !== ARM64_RUNNER_SCHEMA || value.metricId !== ARM64_METRIC_ID) {
    sourceError('arm64-runner-schema');
  }
  const sourceFilesByPath = new Map(identity.files.map((file) => [file.path, file.sha256]));
  for (const [pathName, digest] of Object.entries(value.denominator?.capstoneIdentity?.artifacts || {})) {
    if (sourceFilesByPath.get(pathName) !== digest) sourceError('arm64-runner-capstone-source-mismatch', pathName);
  }
  arm64RunnerCache = Object.freeze({ key: cacheKey, value: Object.freeze(value) });
  return value;
}

function arm64ExpectedParts(identity, producer = currentIdentity()) {
  const runner = runArm64SourceRunner(identity, producer);
  const candidateValue = finite(runner.candidate?.coverageRate, `${ARM64_METRIC_ID}:candidate-value`);
  const referenceValue = finite(runner.reference?.coverageRate, `${ARM64_METRIC_ID}:reference-value`);
  const inventoryDigest = runner.denominator?.inventoryDigest;
  if (typeof inventoryDigest !== 'string' || !inventoryDigest.trim()) sourceError('arm64-runner-inventory-digest');
  const denominator = Object.freeze({
    kind: 'source-fixture',
    corpusId: identity.corpusId,
    corpusVersion: identity.corpusVersion,
    candidate: runner.candidate,
    reference: runner.reference,
    familyCounts: runner.familyCounts,
    inventorySchema: runner.denominator.inventorySchema,
    inventoryDigest,
    fullIsaCoverageIncluded: runner.denominator.fullIsaCoverageIncluded,
    candidateCorpus: runner.denominator.candidateCorpus,
    rawCaseCount: runner.denominator.rawCaseCount,
    memoryCaseCount: runner.denominator.memoryCaseCount,
    memoryCorpusSha256: runner.denominator.memoryCorpusSha256,
    simdCaseCount: runner.denominator.simdCaseCount,
    simdCorpusSha256: runner.denominator.simdCorpusSha256,
    capstoneIdentity: runner.denominator.capstoneIdentity,
    decoderIdentity: runner.denominator.decoderIdentity,
    decoderAudit: runner.denominator.decoderAudit,
    terminalDecoderDenominator: runner.denominator.terminalDecoderDenominator,
    assemblerTools: runner.assemblerTools,
  });
  const semanticOracle = Object.freeze({
    schemaVersion: SOURCE_FIXTURE_SCHEMA,
    kind: 'arm64-a64-canonical-denominator',
    sourceDigest: identity.sourceDigest,
    sourceFiles: identity.files,
    inventoryDigest,
    denominatorDigest: stableDigest(denominator),
    candidateScoreDigest: stableDigest(runner.candidate),
    referenceScoreDigest: stableDigest(runner.reference),
    runnerSchemaVersion: runner.schemaVersion,
    semanticVersion: runner.semanticVersion,
    familyCounts: runner.familyCounts,
    candidateCorpus: runner.denominator.candidateCorpus,
    decoderIdentity: runner.denominator.decoderIdentity,
    decoderAudit: runner.denominator.decoderAudit,
    terminalDecoderDenominator: runner.denominator.terminalDecoderDenominator,
    memoryCorpusSha256: runner.denominator.memoryCorpusSha256,
    simdCorpusSha256: runner.denominator.simdCorpusSha256,
    assemblerTools: runner.assemblerTools,
  });
  return Object.freeze({
    runner,
    candidateValue,
    referenceValue,
    denominator,
    semanticOracle,
    comparison: comparison('higher', candidateValue, referenceValue),
  });
}

function arm64Measurement(identity, producer = currentIdentity()) {
  const expected = arm64ExpectedParts(identity, producer);
  return Object.freeze({
    schemaVersion: 'hex-competitive-measurement/v1',
    metricId: ARM64_METRIC_ID,
    status: 'MEASURED',
    authority: 'deterministic-fixture',
    candidateValue: expected.candidateValue,
    referenceValue: expected.referenceValue,
    comparison: expected.comparison,
    corpusId: identity.corpusId,
    corpusVersion: identity.corpusVersion,
    inputIdentity: `source_${identity.sourceDigest}`,
    referenceTool: ARM64_REFERENCE_TOOL,
    referenceVersion: ARM64_REFERENCE_VERSION,
    configuration: ARM64_CONFIGURATION,
    runPolicy: 'exact',
    producerGitSha: producer.gitSha,
    producerTreeSha: producer.treeSha,
    sourceDigest: identity.sourceDigest,
    denominator: expected.denominator,
    semanticOracle: expected.semanticOracle,
    evidenceRefs: [
      ...ARM64_SOURCE_FILES,
      `corpus:${identity.corpusId}@${identity.corpusVersion}`,
      `inventory:${expected.denominator.inventoryDigest}`,
      `decoder-audit:${expected.denominator.decoderAudit.decoderAuditSha256}`,
    ],
  });
}

function scoreDigest(score) {
  return stableDigest(score);
}

function aliasMeasurement(metricId, identity = sourceIdentity(), producer = currentIdentity()) {
  const config = ALIAS_SOURCE_METRIC_CONFIG[metricId];
  if (config == null) sourceError('metric-unsupported', metricId);
  const candidate = aliasCandidateScore();
  const reference = aliasTruthScore();
  const candidateValue = finite(candidate[config.field], `${metricId}:candidate-value`);
  const referenceValue = finite(reference[config.field], `${metricId}:reference-value`);
  const semanticOracle = {
    schemaVersion: SOURCE_FIXTURE_SCHEMA,
    kind: 'phase7-alias-declared-truth',
    scoringId: candidate.scoringId,
    scoringVersion: candidate.scoringVersion,
    truthGeneratorId: candidate.truthGeneratorId,
    truthGeneratorVersion: candidate.truthGeneratorVersion,
    sourceDigest: identity.sourceDigest,
    sourceFiles: identity.files,
    corpusId: identity.corpusId,
    corpusVersion: identity.corpusVersion,
    queryCount: identity.queryCount,
    queryIdsDigest: identity.queryIdsDigest,
    truthDigest: identity.truthDigest,
    candidateScoreDigest: scoreDigest(candidate),
    referenceScoreDigest: scoreDigest(reference),
  };
  return Object.freeze({
    schemaVersion: 'hex-competitive-measurement/v1',
    metricId,
    status: 'MEASURED',
    authority: 'deterministic-fixture',
    candidateValue,
    referenceValue,
    comparison: comparison(config.direction, candidateValue, referenceValue),
    corpusId: identity.corpusId,
    corpusVersion: identity.corpusVersion,
    inputIdentity: `source_${identity.sourceDigest}`,
    referenceTool: 'phase7-declared-fixture-truth',
    referenceVersion: `${candidate.truthGeneratorId}:${candidate.truthGeneratorVersion}`,
    configuration: 'phase7-v2-default',
    runPolicy: config.runPolicy,
    producerGitSha: producer.gitSha,
    producerTreeSha: producer.treeSha,
    sourceDigest: identity.sourceDigest,
    denominator: {
      kind: 'source-fixture',
      corpusId: identity.corpusId,
      corpusVersion: identity.corpusVersion,
      queryCount: identity.queryCount,
      exactAvailable: candidate.exactAvailable,
      queryIdsDigest: identity.queryIdsDigest,
      truthDigest: identity.truthDigest,
      candidateScoreDigest: scoreDigest(candidate),
      referenceScoreDigest: scoreDigest(reference),
    },
    semanticOracle,
    evidenceRefs: [
      ...ALIAS_SOURCE_FILES,
      `corpus:${identity.corpusId}@${identity.corpusVersion}`,
      `queries:${identity.queryIdsDigest}`,
      `truth:${identity.truthDigest}`,
    ],
  });
}

function arm64Unmeasured(reason = 'arm64-source-runner-unavailable') {
  return Object.freeze({
    schemaVersion: 'hex-competitive-measurement/v1',
    metricId: ARM64_METRIC_ID,
    status: 'UNMEASURED',
    authority: 'deterministic-fixture',
    candidateValue: null,
    referenceValue: null,
    comparison: 'UNMEASURED',
    corpusId: 'arm64-effects-corpus',
    corpusVersion: 2,
    inputIdentity: 'unmeasured:machine-effects-arm64-coverage',
    referenceTool: 'unmeasured',
    referenceVersion: 'unmeasured',
    configuration: 'source-fixture',
    runPolicy: 'exact',
    evidenceRefs: [
      'tests/stage1/a2-machine-effects-coverage.test.mjs',
      ...ARM64_SOURCE_FILES,
    ],
    reason: 'arm64-source-measurement-unavailable',
    missingInput: reason,
  });
}

export function collectCompetitiveSourceMeasurements({ producerIdentity = currentIdentity() } = {}) {
  const identity = sourceIdentity();
  const arm64Identity = arm64SourceIdentity();
  const records = {};
  for (const metricId of Object.keys(ALIAS_SOURCE_METRIC_CONFIG)) {
    records[metricId] = aliasMeasurement(metricId, identity, producerIdentity);
  }
  try {
    records[ARM64_METRIC_ID] = arm64Measurement(arm64Identity, producerIdentity);
  } catch (error) {
    records[ARM64_METRIC_ID] = arm64Unmeasured(error?.message || String(error));
  }
  return Object.freeze(records);
}

function assertSourceFiles(observed, expected) {
  if (!Array.isArray(observed) || stableDigest(observed) !== stableDigest(expected)) sourceError('source-files-mismatch');
}

function validateAliasMeasurement(value, { expectedMetricId, expectedProducerIdentity } = {}) {
  const config = ALIAS_SOURCE_METRIC_CONFIG[value.metricId];
  if (config == null) sourceError('metric-unsupported', value.metricId);
  if (expectedMetricId != null && value.metricId !== expectedMetricId) sourceError('metric-mismatch', value.metricId);
  if (value.authority !== 'deterministic-fixture') sourceError('authority', value.metricId);
  if (expectedProducerIdentity != null
      && (value.producerGitSha !== expectedProducerIdentity.gitSha || value.producerTreeSha !== expectedProducerIdentity.treeSha)) {
    sourceError('producer-stale', value.metricId);
  }
  if (!HEX40_RE.test(value.producerGitSha || '') || !HEX40_RE.test(value.producerTreeSha || '')) sourceError('producer-identity', value.metricId);
  const identity = sourceIdentity();
  if (value.sourceDigest !== identity.sourceDigest) sourceError('source-digest-mismatch', value.metricId);
  if (value.inputIdentity !== `source_${identity.sourceDigest}`) sourceError('input-identity-mismatch', value.metricId);
  if (value.corpusId !== identity.corpusId || value.corpusVersion !== identity.corpusVersion) sourceError('corpus-mismatch', value.metricId);
  const oracle = value.semanticOracle;
  if (oracle == null || typeof oracle !== 'object' || Array.isArray(oracle)) sourceError('oracle-object', value.metricId);
  if (oracle.schemaVersion !== SOURCE_FIXTURE_SCHEMA || oracle.kind !== 'phase7-alias-declared-truth') sourceError('oracle-schema', value.metricId);
  if (oracle.sourceDigest !== identity.sourceDigest || oracle.corpusId !== identity.corpusId || oracle.corpusVersion !== identity.corpusVersion) sourceError('oracle-source-mismatch', value.metricId);
  assertSourceFiles(oracle.sourceFiles, identity.files);
  if (oracle.queryCount !== identity.queryCount || oracle.queryIdsDigest !== identity.queryIdsDigest || oracle.truthDigest !== identity.truthDigest) {
    sourceError('oracle-denominator-mismatch', value.metricId);
  }
  const candidate = aliasCandidateScore();
  const reference = aliasTruthScore();
  if (oracle.scoringId !== candidate.scoringId
      || oracle.scoringVersion !== candidate.scoringVersion
      || oracle.truthGeneratorId !== candidate.truthGeneratorId
      || oracle.truthGeneratorVersion !== candidate.truthGeneratorVersion) {
    sourceError('oracle-scoring-identity', value.metricId);
  }
  const candidateValue = finite(candidate[config.field], `${value.metricId}:candidate-value`);
  const referenceValue = finite(reference[config.field], `${value.metricId}:reference-value`);
  if (value.candidateValue !== candidateValue) sourceError('candidate-value-mismatch', value.metricId);
  if (value.referenceValue !== referenceValue) sourceError('reference-value-mismatch', value.metricId);
  if (value.comparison !== comparison(config.direction, candidateValue, referenceValue)) sourceError('comparison-mismatch', value.metricId);
  if (value.referenceTool !== 'phase7-declared-fixture-truth'
      || value.referenceVersion !== `${candidate.truthGeneratorId}:${candidate.truthGeneratorVersion}`
      || value.configuration !== 'phase7-v2-default'
      || value.runPolicy !== config.runPolicy) {
    sourceError('configuration-mismatch', value.metricId);
  }
  const denominator = value.denominator;
  if (denominator == null || typeof denominator !== 'object' || Array.isArray(denominator)) sourceError('denominator-object', value.metricId);
  if (denominator.kind !== 'source-fixture'
      || denominator.corpusId !== identity.corpusId
      || denominator.corpusVersion !== identity.corpusVersion
      || denominator.queryCount !== identity.queryCount
      || denominator.exactAvailable !== candidate.exactAvailable
      || denominator.queryIdsDigest !== identity.queryIdsDigest
      || denominator.truthDigest !== identity.truthDigest
      || denominator.candidateScoreDigest !== scoreDigest(candidate)
      || denominator.referenceScoreDigest !== scoreDigest(reference)) {
    sourceError('denominator-mismatch', value.metricId);
  }
  if (oracle.candidateScoreDigest !== scoreDigest(candidate) || oracle.referenceScoreDigest !== scoreDigest(reference)) {
    sourceError('oracle-score-mismatch', value.metricId);
  }
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length === 0) sourceError('evidence-refs', value.metricId);
  return Object.freeze(value);
}

export function validateSourceFixtureMeasurement(value, options = {}) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) sourceError('object-required');
  if (value.metricId === ARM64_METRIC_ID) {
    const identity = arm64SourceIdentity();
    if (value.status === 'UNMEASURED') {
      if (value.corpusId !== identity.corpusId || value.corpusVersion !== identity.corpusVersion
          || value.inputIdentity !== 'unmeasured:machine-effects-arm64-coverage'
          || typeof value.reason !== 'string' || !value.reason.trim()
          || typeof value.missingInput !== 'string' || !value.missingInput.trim()) {
        sourceError('arm64-unmeasured-contract');
      }
      if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length === 0) sourceError('evidence-refs', value.metricId);
      return Object.freeze(value);
    }
    if (value.status !== 'MEASURED') sourceError('status', value.metricId);
    const expected = arm64ExpectedParts(identity, options.expectedProducerIdentity || currentIdentity());
    if (options.expectedProducerIdentity != null
        && (value.producerGitSha !== options.expectedProducerIdentity.gitSha
          || value.producerTreeSha !== options.expectedProducerIdentity.treeSha)) {
      sourceError('producer-stale', value.metricId);
    }
    if (value.authority !== 'deterministic-fixture'
        || value.sourceDigest !== identity.sourceDigest
        || value.inputIdentity !== `source_${identity.sourceDigest}`
        || value.corpusId !== identity.corpusId
        || value.corpusVersion !== identity.corpusVersion
        || value.referenceTool !== ARM64_REFERENCE_TOOL
        || value.referenceVersion !== ARM64_REFERENCE_VERSION
        || value.configuration !== ARM64_CONFIGURATION
        || value.runPolicy !== 'exact'
        || value.candidateValue !== expected.candidateValue
        || value.referenceValue !== expected.referenceValue
        || value.comparison !== expected.comparison
        || stableDigest(value.denominator) !== stableDigest(expected.denominator)
        || stableDigest(value.semanticOracle) !== stableDigest(expected.semanticOracle)) {
      sourceError('arm64-provenance-or-value-mismatch', value.metricId);
    }
    if (!HEX40_RE.test(value.producerGitSha || '') || !HEX40_RE.test(value.producerTreeSha || '')) {
      sourceError('producer-identity', value.metricId);
    }
    if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.some((entry) => typeof entry !== 'string' || !entry.trim())) {
      sourceError('evidence-refs', value.metricId);
    }
    return Object.freeze(value);
  }
  if (value.status !== 'MEASURED') sourceError('status', value.metricId);
  return validateAliasMeasurement(value, options);
}

export function isSourceFixtureMetric(metricId) {
  return Object.prototype.hasOwnProperty.call(SOURCE_FIXTURE_METRIC_CONFIG, metricId);
}
