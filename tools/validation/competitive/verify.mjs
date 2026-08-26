import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stableDigest, stableStringify } from '../../../js/core/identity/index.js';
import {
  validateTwinManifest,
  validateTwinManifestReference,
} from './twin-manifest.mjs';
import { currentCompetitiveGitIdentity, loadCompetitiveProfile, generateCompetitiveScorecard } from './score.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROFILE_SCHEMA = 'hex-competitive-profile/v2';
const SCORECARD_SCHEMA = 'hex-competitive-scorecard/v2';
const GROUND_TRUTH_SCHEMA = 'hex-competitive-ground-truth/v1';
const ALLOWED_STATUSES = new Set(['measured', 'legacy-unproven', 'UNMEASURED']);
const ALLOWED_COMPARISONS = new Set(['WIN', 'TIE', 'LOSS', 'UNMEASURED']);
const HEX_SHA_RE = /^[0-9a-f]{40}$/i;
const DENOMINATOR_SCHEMA = 'hex-competitive-denominator/v1';
export const COMPETITIVE_METRIC_IDS = Object.freeze([
  'alias-v2-exact-precision',
  'alias-v2-exact-recall',
  'alias-v2-false-must-alias',
  'alias-v2-false-no-alias',
  'machine-effects-arm64-coverage',
  'machine-effects-x86_64-coverage',
  'machine-effects-riscv64-coverage',
  'decompiler-quality-gotos',
  'decompiler-quality-assembly-fallbacks',
  'universal-binary-hotpath-ms',
]);
const DENOMINATOR_DIGEST = '175cc1cf6bd8b24b7ec4df49516a428c';

function fail(code, detail = '') {
  throw new TypeError(`competitive-verifier-${code}${detail ? `:${detail}` : ''}`);
}

function object(value, code) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}

function requiredText(value, code) {
  if (typeof value !== 'string' || !value.trim()) fail(code);
  return value.trim();
}

function verifyGroundTruth(value, metricId, contract, { profile = false } = {}) {
  object(value, `ground-truth-object:${metricId}`);
  const expectedKeys = new Set(['kind', 'authority', 'status', 'binaryScored', 'twinManifest']);
  for (const key of Object.keys(value)) if (!expectedKeys.has(key)) fail(`ground-truth-unknown-field:${metricId}`, key);
  for (const key of expectedKeys) if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`ground-truth-missing-field:${metricId}`, key);
  requiredText(value.kind, `ground-truth-kind:${metricId}`);
  const authority = requiredText(value.authority, `ground-truth-authority:${metricId}`);
  const authorityLower = authority.toLowerCase();
  if (['competitor', 'hex', 'reference-tool'].includes(authorityLower)
      || authorityLower.includes('competitor') || authorityLower === 'hex-output') {
    fail(`ground-truth-authority-forbidden:${metricId}`);
  }
  if (Array.isArray(contract?.allowedAuthorities) && !contract.allowedAuthorities.includes(authority)) {
    fail(`ground-truth-authority-not-allowlisted:${metricId}`, authority);
  }
  if (!ALLOWED_STATUSES.has(value.status)) fail(`ground-truth-status:${metricId}`, String(value.status));
  if (typeof value.binaryScored !== 'boolean') fail(`ground-truth-binary-flag:${metricId}`);

  let twinManifest = null;
  const fullTwinManifest = value.twinManifest?.schemaVersion === 'hex-competitive-twin-manifest/v1';
  if (value.twinManifest != null) {
    if (fullTwinManifest) {
      try { validateTwinManifest(value.twinManifest); } catch (error) { fail(`ground-truth-twin-invalid:${metricId}`, error.message); }
      twinManifest = value.twinManifest;
    } else {
      // A digest-only reference is useful while a binary lane is explicitly
      // migrating, but it cannot authorize a measured binary result: replay
      // must have the complete manifest contract available.
      if (value.binaryScored === true && value.status === 'measured') fail(`binary-ground-truth-twin-full-required:${metricId}`);
      try { twinManifest = validateTwinManifestReference(value.twinManifest); } catch (error) { fail(`ground-truth-twin-reference-invalid:${metricId}`, error.message); }
    }
  }

  if (!value.binaryScored) {
    if (value.status !== 'measured' && !['legacy-unproven', 'UNMEASURED'].includes(value.status)) fail(`nonbinary-ground-truth-status:${metricId}`);
    if (value.status === 'measured' && !['source-spec', 'deterministic-fixture'].includes(authority)) fail(`nonbinary-ground-truth-authority:${metricId}`);
    if (twinManifest != null) fail(`nonbinary-ground-truth-twin:${metricId}`);
  } else if (value.status === 'measured') {
    if (authority !== 'same-binary-twin') fail(`binary-ground-truth-authority-required:${metricId}`);
    if (twinManifest == null || !fullTwinManifest) fail(`binary-ground-truth-twin-required:${metricId}`);
  }
  return {
    kind: value.kind,
    authority,
    status: value.status,
    binaryScored: value.binaryScored,
    twinManifest,
  };
}

function verifyProfileMetric(metricId, metric, contract) {
  object(metric, `metric-object:${metricId}`);
  const validDirections = new Set(['higher', 'lower', 'exact-zero']);
  if (!validDirections.has(metric.direction)) fail(`metric-direction:${metricId}`, String(metric.direction));
  if (typeof metric.regressionTolerance !== 'number' || !Number.isFinite(metric.regressionTolerance) || metric.regressionTolerance < 0) {
    fail(`metric-regression-tolerance:${metricId}`);
  }
  if (metric.direction === 'exact-zero' && metric.regressionTolerance !== 0) fail(`metric-exact-zero-tolerance:${metricId}`);
  if (!Array.isArray(metric.corpusWorkloadIds) || metric.corpusWorkloadIds.length === 0) fail(`metric-corpus-workload:${metricId}`);
  const groundTruth = verifyGroundTruth(metric.groundTruth, metricId, contract, { profile: true });
  return { ...groundTruth };
}

export function verifyCompetitiveProfile(profile = loadCompetitiveProfile()) {
  object(profile, 'profile-object');
  if (profile.schemaVersion !== PROFILE_SCHEMA) fail('invalid-schema-version', String(profile.schemaVersion));
  for (const key of ['profileId', 'baselineCommit', 'baselineTree', 'specificationBlobSha', 'runtimeHardwareClass']) requiredText(profile[key], `profile-${key}`);
  for (const key of ['baselineCommit', 'baselineTree', 'specificationBlobSha']) if (!HEX_SHA_RE.test(profile[key])) fail(`profile-${key}-invalid`);
  object(profile.groundTruthContract, 'ground-truth-contract-missing');
  if (profile.groundTruthContract.schemaVersion !== GROUND_TRUTH_SCHEMA) fail('ground-truth-contract-schema');
  if (profile.groundTruthContract.binaryRowsRequireSameBinaryTwin !== true) fail('binary-twin-requirement-disabled');
  if (profile.groundTruthContract.competitorOutputIsNeverAuthority !== true) fail('competitor-authority-policy-disabled');
  if (!Array.isArray(profile.groundTruthContract.allowedAuthorities) || profile.groundTruthContract.allowedAuthorities.length === 0) fail('ground-truth-authority-list-missing');
  object(profile.denominator, 'denominator-missing');
  if (profile.denominator.schemaVersion !== DENOMINATOR_SCHEMA || profile.denominator.status !== 'frozen') fail('denominator-contract-invalid');
  if (!Array.isArray(profile.denominator.metricIds) || stableStringify(profile.denominator.metricIds) !== stableStringify(COMPETITIVE_METRIC_IDS)) fail('denominator-metric-ids-mismatch');
  if (profile.denominator.metricIdsDigest !== DENOMINATOR_DIGEST || profile.denominator.metricIdsDigest !== stableDigest(profile.denominator.metricIds)) fail('denominator-digest-mismatch');
  object(profile.metrics, 'missing-profile-metrics');
  const metricIds = Object.keys(profile.metrics);
  if (metricIds.length === 0) fail('missing-profile-metrics');
  if (stableStringify(metricIds) !== stableStringify(COMPETITIVE_METRIC_IDS)) fail('profile-metric-order-mismatch');
  const groundTruth = Object.fromEntries(metricIds.map((id) => [id, verifyProfileMetric(id, profile.metrics[id], profile.groundTruthContract)]));
  return { verified: true, metricCount: metricIds.length, groundTruth };
}

function verifyEntryShape(entry, metricId) {
  object(entry, `entry-object:${metricId}`);
  const expectedKeys = new Set([
    'metricId', 'corpusId', 'inputIdentity', 'functionIdentity', 'hexVersion',
    'referenceTool', 'referenceVersion', 'configuration', 'runtimeClass',
    'runPolicy', 'hexValue', 'referenceValue', 'comparison', 'historical',
    'groundTruth', 'groundTruthAuthority', 'groundTruthStatus', 'twinManifest', 'evidenceRefs',
  ]);
  for (const key of Object.keys(entry)) if (!expectedKeys.has(key)) fail(`entry-unknown-field:${metricId}`, key);
  for (const key of expectedKeys) if (!Object.prototype.hasOwnProperty.call(entry, key)) fail(`entry-missing-field:${metricId}`, key);
  if (entry.metricId !== metricId) fail(`entry-id-mismatch:${metricId}`);
  for (const key of ['corpusId', 'inputIdentity', 'hexVersion', 'referenceTool', 'referenceVersion', 'configuration', 'runtimeClass', 'runPolicy', 'groundTruthAuthority', 'groundTruthStatus']) requiredText(entry[key], `entry-${key}:${metricId}`);
  if (entry.functionIdentity != null && typeof entry.functionIdentity !== 'string') fail(`entry-function-identity:${metricId}`);
  for (const key of ['hexValue', 'referenceValue']) {
    if (entry[key] != null && (typeof entry[key] !== 'number' || !Number.isFinite(entry[key]))) fail(`entry-value:${metricId}:${key}`);
  }
  if (!ALLOWED_COMPARISONS.has(entry.comparison)) fail(`entry-comparison:${metricId}`);
  if (entry.historical != null) {
    object(entry.historical, `entry-historical:${metricId}`);
    const historicalKeys = new Set(['nonAuthoritative', 'hexValue', 'referenceValue', 'comparison']);
    for (const key of Object.keys(entry.historical)) if (!historicalKeys.has(key)) fail(`entry-historical-unknown-field:${metricId}`, key);
    for (const key of historicalKeys) if (!Object.prototype.hasOwnProperty.call(entry.historical, key)) fail(`entry-historical-missing-field:${metricId}`, key);
    if (entry.historical.nonAuthoritative !== true) fail(`entry-historical-authority:${metricId}`);
    for (const key of ['hexValue', 'referenceValue']) {
      if (entry.historical[key] != null && (typeof entry.historical[key] !== 'number' || !Number.isFinite(entry.historical[key]))) fail(`entry-historical-value:${metricId}:${key}`);
    }
    if (!ALLOWED_COMPARISONS.has(entry.historical.comparison)) fail(`entry-historical-comparison:${metricId}`);
  }
  if (!Array.isArray(entry.evidenceRefs) || entry.evidenceRefs.some((ref) => typeof ref !== 'string' || !ref.trim())) fail(`entry-evidence-refs:${metricId}`);
}

function verifyMeasuredBinaryEvidence(metricId, entry, manifest, twinEvidenceByMetric) {
  if (twinEvidenceByMetric == null || typeof twinEvidenceByMetric !== 'object' || Array.isArray(twinEvidenceByMetric)) {
    fail('binary-twin-evidence-required', metricId);
  }
  const evidence = twinEvidenceByMetric[metricId];
  object(evidence, `binary-twin-evidence-object:${metricId}`);
  for (const key of ['debugArtifactPath', 'strippedArtifactPath', 'expected']) {
    if (typeof evidence[key] !== 'string' && key !== 'expected') fail('binary-twin-evidence-path-required', `${metricId}:${key}`);
    if (key === 'expected') object(evidence[key], `binary-twin-evidence-context-required:${metricId}`);
  }
  if (typeof evidence.debugArtifactPath !== 'string' || !evidence.debugArtifactPath.trim()
      || typeof evidence.strippedArtifactPath !== 'string' || !evidence.strippedArtifactPath.trim()) {
    fail('binary-twin-evidence-path-required', metricId);
  }
  let replay;
  try {
    replay = validateTwinManifest(manifest, {
      debugArtifactPath: evidence.debugArtifactPath,
      strippedArtifactPath: evidence.strippedArtifactPath,
      expected: evidence.expected,
    });
  } catch (error) {
    fail('binary-twin-evidence-invalid', `${metricId}:${error.message}`);
  }
  if (replay.replayedStrip !== true || replay.manifestDigest !== manifest.manifestDigest) fail('binary-twin-evidence-replay-required', metricId);
  if (entry.corpusId !== manifest.corpusId) fail('binary-twin-entry-corpus-mismatch', metricId);
  const expectedInputIdentity = `bin_sha256_${manifest.strippedArtifactSha256}`;
  if (entry.inputIdentity !== expectedInputIdentity) fail('binary-twin-entry-input-mismatch', metricId);
}

export function verifyCompetitiveScorecard(scorecard, profile = loadCompetitiveProfile(), options = {}) {
  verifyCompetitiveProfile(profile);
  object(scorecard, 'scorecard-object');
  if (scorecard.schemaVersion !== SCORECARD_SCHEMA) fail('invalid-scorecard-schema', String(scorecard.schemaVersion));
  if (scorecard.profileId !== profile.profileId) fail('scorecard-profile-mismatch');
  for (const key of ['gitSha', 'treeSha', 'runtimeHardwareClass']) requiredText(scorecard[key], `scorecard-${key}`);
  if (!HEX_SHA_RE.test(scorecard.gitSha) || !HEX_SHA_RE.test(scorecard.treeSha)) fail('scorecard-identity-invalid');
  const expectedIdentity = options.expectedGitSha || options.expectedTreeSha
    ? { gitSha: options.expectedGitSha, treeSha: options.expectedTreeSha }
    : currentCompetitiveGitIdentity();
  if (!HEX_SHA_RE.test(expectedIdentity.gitSha || '') || !HEX_SHA_RE.test(expectedIdentity.treeSha || '')) fail('expected-identity-invalid');
  if (scorecard.gitSha.toLowerCase() !== expectedIdentity.gitSha.toLowerCase() || scorecard.treeSha.toLowerCase() !== expectedIdentity.treeSha.toLowerCase()) fail('scorecard-identity-mismatch');
  if (scorecard.runtimeHardwareClass !== profile.runtimeHardwareClass) fail('scorecard-runtime-class-mismatch');
  if (!Array.isArray(scorecard.entries)) fail('scorecard-entries-missing');
  object(scorecard.summary, 'scorecard-summary-missing');
  const metricIds = Object.keys(profile.metrics);
  if (scorecard.entries.length !== metricIds.length) fail('scorecard-denominator-shrunk', `${scorecard.entries.length}!=${metricIds.length}`);
  const entries = new Map();
  for (const entry of scorecard.entries) {
    if (entries.has(entry?.metricId)) fail('scorecard-duplicate-metric', String(entry?.metricId));
    const metricId = requiredText(entry?.metricId, 'scorecard-entry-metric-id');
    if (!Object.prototype.hasOwnProperty.call(profile.metrics, metricId)) fail('scorecard-unknown-metric', metricId);
    verifyEntryShape(entry, metricId);
    entries.set(metricId, entry);
  }
  for (const metricId of metricIds) if (!entries.has(metricId)) fail('scorecard-metric-missing', metricId);

  for (const [metricId, entry] of entries) {
    const metric = profile.metrics[metricId];
    const expectedGroundTruth = verifyGroundTruth(metric.groundTruth, metricId, profile.groundTruthContract, { profile: true });
    const actualGroundTruth = verifyGroundTruth(entry.groundTruth, metricId, profile.groundTruthContract);
    if (stableStringify(actualGroundTruth) !== stableStringify(expectedGroundTruth)) fail('scorecard-ground-truth-profile-mismatch', metricId);
    if (entry.groundTruthAuthority !== actualGroundTruth.authority || entry.groundTruthStatus !== actualGroundTruth.status) fail('scorecard-ground-truth-alias-mismatch', metricId);
    if (stableStringify(entry.twinManifest) !== stableStringify(actualGroundTruth.twinManifest)) fail('scorecard-twin-manifest-alias-mismatch', metricId);
    if (entry.hexVersion !== scorecard.gitSha) fail('scorecard-entry-identity-mismatch', metricId);
    if (entry.runtimeClass !== profile.runtimeHardwareClass) fail('scorecard-entry-runtime-mismatch', metricId);
    if (!profile.metrics[metricId].corpusWorkloadIds.includes(entry.corpusId)) fail('scorecard-entry-corpus-undeclared', metricId);
    if (actualGroundTruth.binaryScored === true && actualGroundTruth.status === 'measured') {
      verifyMeasuredBinaryEvidence(metricId, entry, actualGroundTruth.twinManifest, options.twinEvidenceByMetric);
    }

    // Ensure a hard alias invariant cannot be hidden behind an unmeasured flag
    // when a candidate value was actually produced.
    if (metricId === 'alias-v2-false-must-alias' && entry.hexValue != null && entry.hexValue !== 0) fail(`competitive-hard-invariant-failed:false-must-alias:${entry.hexValue}`);
    if (metricId === 'alias-v2-false-no-alias' && entry.hexValue != null && entry.hexValue !== 0) fail(`competitive-hard-invariant-failed:false-no-alias:${entry.hexValue}`);
    if (metric.regressionTolerance === 0 && entry.comparison === 'LOSS' && metricId.startsWith('alias-v2-false-')) fail(`competitive-zero-tolerance-loss:${metricId}`);
    if (actualGroundTruth.status !== 'measured') {
      if (entry.hexValue !== null || entry.referenceValue !== null) fail('scorecard-unmeasured-value-nonnull', metricId);
      if (entry.comparison !== 'UNMEASURED') fail('scorecard-unproven-comparison', metricId);
    }
  }

  const expectedSummary = {
    totalMetrics: scorecard.entries.length,
    wins: scorecard.entries.filter((entry) => entry.comparison === 'WIN').length,
    ties: scorecard.entries.filter((entry) => entry.comparison === 'TIE').length,
    losses: scorecard.entries.filter((entry) => entry.comparison === 'LOSS').length,
    unmeasured: scorecard.entries.filter((entry) => entry.comparison === 'UNMEASURED').length,
  };
  if (stableStringify(scorecard.summary) !== stableStringify(expectedSummary)) fail('scorecard-summary-mismatch');
  return { verified: true, totalEntries: scorecard.entries.length, unmeasured: expectedSummary.unmeasured };
}

export async function verifyCompetitive({ profile = loadCompetitiveProfile(), scorecard = null, options = {}, twinEvidenceByMetric } = {}) {
  verifyCompetitiveProfile(profile);
  const card = scorecard ?? await generateCompetitiveScorecard({ profile });
  verifyCompetitiveScorecard(card, profile, {
    ...options,
    ...(twinEvidenceByMetric == null ? {} : { twinEvidenceByMetric }),
  });
  return { status: 'PASS', scorecard: card };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = await verifyCompetitive();
    console.log(`Competitive verification: ${result.status}`);
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}
