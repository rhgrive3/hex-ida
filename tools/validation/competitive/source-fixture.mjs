/**
 * Repository-owned nonbinary competitive measurements.
 *
 * These rows are source-fixture measurements rather than binary-twin rows.
 * The expected side is generated from the frozen fixture truth declarations;
 * it never comes from the candidate implementation or a hand-entered number.
 * ARM64 coverage remains explicitly unmeasured because the existing sample
 * and A2 registry inventory do not define a complete scalar workload.
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
    corpusVersion: 1,
    field: 'coverageRate',
    direction: 'higher',
    runPolicy: 'exact',
    available: false,
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
  return ALIAS_SOURCE_FILES.map((relativePath) => {
    const filePath = path.join(ROOT, relativePath);
    if (!fs.existsSync(filePath)) sourceError('source-file-missing', relativePath);
    return Object.freeze({ path: relativePath, sha256: sha256Bytes(fs.readFileSync(filePath)) });
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

function arm64Unmeasured() {
  return Object.freeze({
    schemaVersion: 'hex-competitive-measurement/v1',
    metricId: ARM64_METRIC_ID,
    status: 'UNMEASURED',
    authority: 'deterministic-fixture',
    candidateValue: null,
    referenceValue: null,
    comparison: 'UNMEASURED',
    corpusId: 'arm64-effects-corpus',
    corpusVersion: 1,
    inputIdentity: 'unmeasured:machine-effects-arm64-coverage',
    referenceTool: 'unmeasured',
    referenceVersion: 'unmeasured',
    configuration: 'source-fixture',
    runPolicy: 'exact',
    evidenceRefs: [
      'tests/stage1/a2-machine-effects-coverage.test.mjs',
      'tests/machine-effects/a2-denominator-inventory.json',
    ],
    reason: 'canonical-arm64-coverage-denominator-is-not-a-scalar-measurement',
  });
}

export function collectCompetitiveSourceMeasurements({ producerIdentity = currentIdentity() } = {}) {
  const identity = sourceIdentity();
  const records = {};
  for (const metricId of Object.keys(ALIAS_SOURCE_METRIC_CONFIG)) {
    records[metricId] = aliasMeasurement(metricId, identity, producerIdentity);
  }
  records[ARM64_METRIC_ID] = arm64Unmeasured();
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
  if (value.metricId === ARM64_METRIC_ID) sourceError('metric-unavailable', value.metricId);
  if (value.status !== 'MEASURED') sourceError('status', value.metricId);
  return validateAliasMeasurement(value, options);
}

export function isSourceFixtureMetric(metricId) {
  return Object.prototype.hasOwnProperty.call(SOURCE_FIXTURE_METRIC_CONFIG, metricId);
}
