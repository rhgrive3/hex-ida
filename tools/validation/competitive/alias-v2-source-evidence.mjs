import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { stableDigest, stableStringify } from '../../../js/core/identity/index.js';
import { ALIAS_QUERIES_V2 } from '../phase7/scoring.mjs';
import {
  currentCompetitiveGitIdentity,
  loadCompetitiveProfile,
  measureAliasV2,
} from './score.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROFILE_RELATIVE_PATH = 'tools/validation/competitive/profile.json';
const FROZEN_ALIAS_METRIC_IDS = Object.freeze([
  'alias-v2-exact-precision',
  'alias-v2-exact-recall',
  'alias-v2-false-must-alias',
  'alias-v2-false-no-alias',
]);
const FROZEN_DENOMINATOR_METRIC_IDS = Object.freeze([
  ...FROZEN_ALIAS_METRIC_IDS,
  'machine-effects-arm64-coverage',
  'machine-effects-x86_64-coverage',
  'machine-effects-riscv64-coverage',
  'decompiler-quality-gotos',
  'decompiler-quality-assembly-fallbacks',
  'universal-binary-hotpath-ms',
]);
const EXPECTED_ALIAS_GROUND_TRUTH = Object.freeze({
  kind: 'nonbinary-source-fixture',
  authority: 'deterministic-fixture',
  status: 'legacy-unproven',
  binaryScored: false,
  twinManifest: null,
});
const SOURCE_RELATIVE_PATHS = Object.freeze({
  querySet: 'tests/phase7/corpus/fixtures.mjs',
  scorer: 'tools/validation/phase7/scoring.mjs',
  fixtureBuilder: 'tests/phase7/corpus/fixtures.mjs',
  canonicalMeasurement: 'tools/validation/competitive/score.mjs',
  candidateSolver: 'js/analysis/alias/solver.js',
  baselineReference: 'js/analysis/alias/legacy-safety-floor.js',
  profile: PROFILE_RELATIVE_PATH,
  producer: 'tools/validation/competitive/alias-v2-source-evidence.mjs',
});

function fail(code) {
  throw new Error(code);
}

function sha256File(relativePath) {
  const absolutePath = path.join(ROOT, relativePath);
  if (!fs.existsSync(absolutePath)) fail(`alias-v2-evidence-source-missing:${relativePath}`);
  return crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
}

function gitVersion() {
  const result = spawnSync('git', ['--version'], { cwd: ROOT, encoding: 'utf8', shell: false });
  if (result.error || result.status !== 0) fail('alias-v2-evidence-git-version-unavailable');
  return result.stdout.trim();
}

function assertCleanWorktree() {
  const result = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
  });
  if (result.error || result.status !== 0) fail('alias-v2-evidence-worktree-status-unavailable');
  if (result.stdout.trim()) fail('alias-v2-evidence-worktree-dirty');
}

function assertFrozenProfile(profile) {
  const denominator = profile?.denominator;
  if (denominator?.status !== 'frozen') fail('alias-v2-evidence-denominator-not-frozen');
  if (stableStringify(denominator.metricIds) !== stableStringify(FROZEN_DENOMINATOR_METRIC_IDS)) {
    fail('alias-v2-evidence-denominator-changed');
  }
  if (stableDigest(denominator.metricIds) !== denominator.metricIdsDigest) {
    fail('alias-v2-evidence-denominator-digest-mismatch');
  }
  for (const metricId of FROZEN_ALIAS_METRIC_IDS) {
    const groundTruth = profile.metrics?.[metricId]?.groundTruth;
    if (stableStringify(groundTruth) !== stableStringify(EXPECTED_ALIAS_GROUND_TRUTH)) {
      fail(`alias-v2-evidence-ground-truth-changed:${metricId}`);
    }
  }
}

function assertFrozenQueries() {
  if (ALIAS_QUERIES_V2.length !== 30) fail(`alias-v2-evidence-query-count:${ALIAS_QUERIES_V2.length}`);
  const ids = ALIAS_QUERIES_V2.map((query) => query.id);
  if (new Set(ids).size !== ids.length) fail('alias-v2-evidence-query-ids-not-unique');
  for (const query of ALIAS_QUERIES_V2) {
    for (const field of ['id', 'fixture', 'left', 'right', 'truth', 'truthSource', 'proofClass', 'category']) {
      if (typeof query[field] !== 'string' || query[field].length === 0) {
        fail(`alias-v2-evidence-query-field-missing:${query.id}:${field}`);
      }
    }
  }
}

function sourceBinding(relativePath, fields = {}) {
  return Object.freeze({
    path: relativePath,
    sha256: sha256File(relativePath),
    ...fields,
  });
}

function metricValue(score, field) {
  const value = score[field];
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
    fail(`alias-v2-evidence-metric-value-invalid:${field}`);
  }
  return value;
}

function joinQueryResults(candidate, baseline) {
  const candidateById = new Map(candidate.perQuery.map((query) => [query.id, query]));
  const baselineById = new Map(baseline.perQuery.map((query) => [query.id, query]));
  if (candidateById.size !== ALIAS_QUERIES_V2.length || baselineById.size !== ALIAS_QUERIES_V2.length) {
    fail('alias-v2-evidence-score-query-denominator-mismatch');
  }
  return ALIAS_QUERIES_V2.map((query, index) => {
    const candidateResult = candidateById.get(query.id);
    const baselineResult = baselineById.get(query.id);
    if (!candidateResult || !baselineResult) fail(`alias-v2-evidence-score-query-missing:${query.id}`);
    return {
      ordinal: index + 1,
      id: query.id,
      fixture: query.fixture,
      left: query.left,
      right: query.right,
      truth: query.truth,
      truthSource: query.truthSource,
      proofClass: query.proofClass,
      category: query.category,
      candidateRelation: candidateResult.relation,
      baselineRelation: baselineResult.relation,
    };
  });
}

/**
 * Build source-bound observations for the frozen nonbinary Alias v2 rows.
 * The profile's legacy-unproven status is deliberately required and retained;
 * this function records measurements without promoting the competitive profile.
 */
export function buildAliasV2SourceEvidence({ expectedGitSha = null, expectedTreeSha = null } = {}) {
  assertCleanWorktree();
  assertFrozenQueries();
  const profile = loadCompetitiveProfile();
  assertFrozenProfile(profile);

  const product = currentCompetitiveGitIdentity();
  if (expectedGitSha != null && product.gitSha !== expectedGitSha) fail('alias-v2-evidence-head-mismatch');
  if (expectedTreeSha != null && product.treeSha !== expectedTreeSha) fail('alias-v2-evidence-tree-mismatch');

  const measurement = measureAliasV2({ queries: ALIAS_QUERIES_V2 });
  const candidate = measurement.candidate;
  const baseline = measurement.baseline;
  if (candidate.queryCount !== ALIAS_QUERIES_V2.length || baseline.queryCount !== ALIAS_QUERIES_V2.length) {
    fail('alias-v2-evidence-score-query-count-mismatch');
  }

  const profilePath = path.join(ROOT, PROFILE_RELATIVE_PATH);
  const querySetDigestSha256 = crypto.createHash('sha256')
    .update(stableStringify(ALIAS_QUERIES_V2))
    .digest('hex');
  const metricFields = Object.freeze([
    ['alias-v2-exact-precision', 'exactPrecision'],
    ['alias-v2-exact-recall', 'exactRecall'],
    ['alias-v2-false-must-alias', 'falseMustAlias'],
    ['alias-v2-false-no-alias', 'falseNoAlias'],
  ]);
  const metricRows = metricFields.map(([metricId, field]) => ({
    metricId,
    direction: profile.metrics[metricId].direction,
    queryDenominator: ALIAS_QUERIES_V2.length,
    candidateValue: metricValue(candidate, field),
    differentialBaselineValue: metricValue(baseline, field),
    differentialBaselineRole: 'non-authoritative-legacy-safety-floor',
    groundTruth: { ...EXPECTED_ALIAS_GROUND_TRUTH },
    evidenceDisposition: 'observed-profile-unchanged',
  }));

  return {
    schemaVersion: 'hex-competitive-alias-v2-source-evidence/v1',
    recordType: 'ALIAS_V2_SOURCE_DETERMINISTIC_FIXTURE_EVIDENCE',
    product: {
      gitSha: product.gitSha,
      treeSha: product.treeSha,
      runtimeHardwareClass: profile.runtimeHardwareClass,
      cleanWorktree: true,
    },
    runtime: {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      gitVersion: gitVersion(),
    },
    profile: {
      path: PROFILE_RELATIVE_PATH,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(profilePath)).digest('hex'),
      profileId: profile.profileId,
      schemaVersion: profile.schemaVersion,
      denominatorStatus: profile.denominator.status,
      metricIds: [...profile.denominator.metricIds],
      metricIdsDigest: profile.denominator.metricIdsDigest,
      aliasGroundTruthStatus: 'legacy-unproven',
      aliasGroundTruthAuthority: 'deterministic-fixture',
      promotionPerformed: false,
    },
    groundTruth: { ...EXPECTED_ALIAS_GROUND_TRUTH },
    corpus: {
      id: 'phase7-alias-memory-corpus-v2',
      version: 2,
      queryCount: ALIAS_QUERIES_V2.length,
      querySetDigestSha256,
    },
    sources: {
      querySet: sourceBinding(SOURCE_RELATIVE_PATHS.querySet, {
        export: 'ALIAS_QUERIES_V2',
        querySetDigestSha256,
      }),
      scorer: sourceBinding(SOURCE_RELATIVE_PATHS.scorer, {
        export: 'scoreAliasQueriesV2',
        scoringId: candidate.scoringId,
        scoringVersion: candidate.scoringVersion,
        truthGeneratorId: candidate.truthGeneratorId,
        truthGeneratorVersion: candidate.truthGeneratorVersion,
      }),
      fixtureBuilder: sourceBinding(SOURCE_RELATIVE_PATHS.fixtureBuilder, {
        export: 'buildFixture',
        corpusId: 'phase7-alias-memory-corpus-v2',
        corpusVersion: 2,
      }),
      canonicalMeasurement: sourceBinding(SOURCE_RELATIVE_PATHS.canonicalMeasurement, {
        export: 'measureAliasV2',
      }),
      candidateSolver: sourceBinding(SOURCE_RELATIVE_PATHS.candidateSolver, {
        export: 'createPhase7AliasSolver',
        role: 'product-observation-answerer',
      }),
      baselineReference: sourceBinding(SOURCE_RELATIVE_PATHS.baselineReference, {
        export: 'aliasMemoryRegions',
        role: 'non-authoritative-differential-baseline',
      }),
      profile: sourceBinding(SOURCE_RELATIVE_PATHS.profile, {
        export: 'competitive-v2-master',
      }),
      producer: sourceBinding(SOURCE_RELATIVE_PATHS.producer, {
        export: 'buildAliasV2SourceEvidence',
      }),
    },
    metricRows,
    candidateResult: candidate,
    baselineResult: baseline,
    queryResults: joinQueryResults(candidate, baseline),
    disposition: {
      profileStatusUnchanged: true,
      acceptancePerformed: false,
      acceptance: false,
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const evidence = buildAliasV2SourceEvidence();
    if (process.argv.includes('--json')) console.log(JSON.stringify(evidence, null, 2));
    else console.log(`Alias v2 source evidence prepared: ${evidence.corpus.queryCount} queries @ ${evidence.product.gitSha}`);
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}
