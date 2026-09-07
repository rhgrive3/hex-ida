import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import '../../../js/targets/architecture/index.js';
import { ALIAS_QUERIES_V2, buildFixture, memoryAccessOf, regionOf, scoreAliasQueriesV2 } from '../phase7/scoring.mjs';
import { createPhase7AliasSolver } from '../../../js/analysis/alias/solver.js';
import { aliasMemoryRegions } from '../../../js/analysis/alias/legacy-safety-floor.js';
import { measureMachineEffectsCoverage } from '../../../js/targets/architecture/coverage.js';
import { validateTwinManifest } from './twin-manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROFILE_PATH = path.join(ROOT, 'tools/validation/competitive/profile.json');
const REPORT_DIR = path.join(ROOT, 'reports/competitive');
const SCORECARD_PATH = path.join(REPORT_DIR, 'scorecard.json');

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
  const hexValue = fields.hexValue ?? null;
  const referenceValue = fields.referenceValue ?? null;
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
    inputIdentity: fields.inputIdentity ?? `profile:${metricId}`,
    functionIdentity: fields.functionIdentity ?? null,
    hexVersion: fields.hexVersion,
    referenceTool: fields.referenceTool ?? 'unmeasured',
    referenceVersion: fields.referenceVersion ?? 'unmeasured',
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

export async function generateCompetitiveScorecard({ profile = loadCompetitiveProfile() } = {}) {
  const { gitSha: headCommit, treeSha } = currentCompetitiveGitIdentity();

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

  // 3. Normalized metric comparisons. These five historical rows retain
  // their old values. makeEntry marks their synthetic/legacy comparisons as
  // UNMEASURED until a real same-binary twin is bound in the profile.
  const entries = [
    makeEntry(profile, 'alias-v2-exact-precision', {
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
    }),
    makeEntry(profile, 'alias-v2-exact-recall', {
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
    }),
    makeEntry(profile, 'alias-v2-false-must-alias', {
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
    }),
    makeEntry(profile, 'alias-v2-false-no-alias', {
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
    }),
    makeEntry(profile, 'machine-effects-arm64-coverage', {
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
    }),
  ];

  // The profile owns the denominator. Rows that do not yet have a measured
  // producer remain present as UNMEASURED placeholders rather than silently
  // disappearing from the scorecard.
  const known = new Set(entries.map((entry) => entry.metricId));
  for (const metricId of Object.keys(profile.metrics || {})) {
    if (known.has(metricId)) continue;
    entries.push(makeEntry(profile, metricId, {
      corpusId: profile.metrics[metricId].corpusWorkloadIds?.[0] ?? metricId,
      inputIdentity: `unmeasured:${metricId}`,
      hexVersion: headCommit,
      referenceTool: 'unmeasured',
      referenceVersion: 'unmeasured',
      configuration: 'profile-default',
      hexValue: null,
      referenceValue: null,
      evidenceRefs: profile.metrics[metricId].corpusWorkloadIds || [],
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

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const scorecard = await generateCompetitiveScorecard();
    console.log(`Competitive Scorecard generated: ${scorecard.summary.wins} WINS, ${scorecard.summary.ties} TIES, ${scorecard.summary.losses} LOSSES @ ${scorecard.gitSha}`);
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}
