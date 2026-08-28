import {
  BLOCKING_STATUSES,
  INDEPENDENT_GENERATOR_IDENTITY,
  INDEPENDENT_ORACLE_IDENTITY,
  INDEPENDENT_ORACLE_VERSION,
  ORACLE_BUDGETS,
  ORACLE_PROFILE_INVENTORY,
  PASS_STATUSES,
  REPORT_SCHEMA_VERSION,
  RESULT_STATUSES,
  assertIndependentText,
  validateOraclePolicy,
} from './oracle-policy.mjs';
import {
  canonicalStringify,
  sha256Digest,
  validateOracleResult,
} from './oracle-schema.mjs';
import { validateCorpus } from './oracle-corpus.mjs';
import {
  a2DenominatorReport,
  loadA2DenominatorInventory,
  validateA2DenominatorInventory,
} from './a2-denominator.mjs';

export const A2_SNAPSHOT_SCHEMA_VERSION = 'machine-effects-a2-denominator-snapshot/v1';

function fail(code, detail = null) {
  throw new TypeError(detail == null ? code : `${code}:${detail}`);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function nonEmpty(value, code) {
  if (typeof value !== 'string' || value.trim() === '') fail(code);
  return value.trim();
}

function sha(value, code) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/i.test(value)) fail(code);
  return value.toLowerCase();
}

function identity(value, code) {
  if (typeof value !== 'string' || value.trim() === '') fail(code);
  return value.trim();
}

function digest(value, code) {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) fail(code);
  return value;
}

function safeCount(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function exactKeys(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail(code);
}

const REPORT_COUNT_KEYS = Object.freeze([...RESULT_STATUSES]);
const COMPARISON_COUNT_KEYS = Object.freeze(['registers', 'flags', 'vectors', 'memory', 'outcome', 'total']);
const POLICY_KEYS = Object.freeze([
  'networkAllowed',
  'productionEvaluatorIsOracle',
  'productionSemanticsOwnedHere',
  'denominatorAuthoritySeparate',
]);
const EXTERNAL_EVIDENCE_KEYS = Object.freeze(['profileId', 'authorityId', 'reference', 'toolchainIdentity', 'status']);

function statusCounts(results) {
  const counts = Object.fromEntries(RESULT_STATUSES.map((status) => [status, 0]));
  for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1;
  return counts;
}

function denominatorRows(inventory) {
  const rows = [];
  for (const architecture of inventory.architectures ?? []) {
    rows.push(`architecture:${architecture.id}`);
    for (const unit of architecture.decoder?.units ?? architecture.decoder?.missingUnits ?? []) rows.push(`decoder:${unit}`);
    for (const family of architecture.effectRegistry?.families ?? []) rows.push(`effect:${architecture.id}:${family.id}`);
    for (const exclusion of architecture.exclusions ?? []) rows.push(`exclusion:${architecture.id}:${exclusion.id}`);
  }
  return rows.sort();
}

export function createA2DenominatorSnapshot(inventory = loadA2DenominatorInventory()) {
  const validation = validateA2DenominatorInventory(inventory);
  const report = a2DenominatorReport(inventory);
  const rows = denominatorRows(inventory);
  return deepFreeze({
    schemaVersion: A2_SNAPSHOT_SCHEMA_VERSION,
    oracleRole: inventory.oracleRole,
    validation: {
      valid: validation.valid,
      architectureCount: validation.architectureCount,
      blockingGapCount: validation.blockingGapCount,
    },
    rowIds: rows,
    rowCount: rows.length,
    architectureIds: inventory.architectures.map((architecture) => architecture.id).sort(),
    denominatorDigest: sha256Digest(inventory),
    reportSchemaVersion: report.schemaVersion,
  });
}

export function compareA2DenominatorSnapshots(before, after) {
  if (!before || !after) return Object.freeze({ preserved: false, reason: 'snapshot-missing' });
  const sameRows = canonicalStringify(before.rowIds) === canonicalStringify(after.rowIds);
  const sameArchitectures = canonicalStringify(before.architectureIds) === canonicalStringify(after.architectureIds);
  const preserved = before.denominatorDigest === after.denominatorDigest
    && before.rowCount === after.rowCount
    && sameRows
    && sameArchitectures
    && before.oracleRole === after.oracleRole;
  return Object.freeze({
    preserved,
    reason: preserved ? null : 'a2-denominator-changed',
    beforeDigest: before.denominatorDigest,
    afterDigest: after.denominatorDigest,
    beforeRowCount: before.rowCount,
    afterRowCount: after.rowCount,
  });
}

function profileSummaries(corpus, results) {
  const casesByProfile = new Map();
  for (const item of corpus?.cases ?? []) {
    const list = casesByProfile.get(item.profileId) ?? [];
    list.push(item);
    casesByProfile.set(item.profileId, list);
  }
  const resultsByCase = new Map(results.map((result) => [result.caseId, result]));
  return ORACLE_PROFILE_INVENTORY.map((profile) => {
    const cases = casesByProfile.get(profile.profileId) ?? [];
    const profileResults = cases.map((item) => resultsByCase.get(item.caseId)).filter(Boolean);
    const gaps = profileResults
      .filter((result) => !PASS_STATUSES.includes(result.status))
      .map((result) => ({ status: result.status, caseId: result.caseId }));
    if (cases.length === 0) gaps.push({ status: 'not-integrated', caseId: null });
    return {
      profileId: profile.profileId,
      architecture: profile.architecture,
      isa: profile.isa,
      authorityId: profile.authorityId,
      reference: profile.reference,
      revision: profile.revision,
      toolchainIdentity: profile.toolchainIdentity,
      caseCount: cases.length,
      resultCount: profileResults.length,
      passCount: profileResults.filter((result) => PASS_STATUSES.includes(result.status)).length,
      gapCount: gaps.length,
      gaps,
    };
  });
}

function aggregateComparisonCounts(results) {
  const aggregate = { registers: 0, flags: 0, vectors: 0, memory: 0, outcome: 0, total: 0 };
  for (const result of results) for (const key of Object.keys(aggregate)) aggregate[key] += result.comparisonCounts[key] ?? 0;
  return aggregate;
}

function normalizeToolchain(value) {
  if (typeof value === 'string') return { identity: nonEmpty(value, 'report-toolchain-identity') };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('report-toolchain-required');
  const allowed = new Set(['identity', 'version', 'command', 'target', 'status', 'diagnostics']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail('report-toolchain-unknown-field', key);
  if (value.diagnostics != null && !Array.isArray(value.diagnostics)) fail('report-toolchain-diagnostics-invalid');
  const diagnostics = (value.diagnostics ?? []).map((item) => String(item).slice(0, ORACLE_BUDGETS.maxDiagnosticBytes));
  if (diagnostics.length > ORACLE_BUDGETS.maxDiagnostics) fail('report-toolchain-diagnostics-count');
  return {
    identity: nonEmpty(value.identity, 'report-toolchain-identity'),
    ...(value.version == null ? {} : { version: nonEmpty(value.version, 'report-toolchain-version') }),
    ...(value.command == null ? {} : { command: nonEmpty(value.command, 'report-toolchain-command') }),
    ...(value.target == null ? {} : { target: nonEmpty(value.target, 'report-toolchain-target') }),
    ...(value.status == null ? {} : { status: nonEmpty(value.status, 'report-toolchain-status') }),
    diagnostics,
  };
}

function normalizeExternalEvidence(value) {
  if (!Array.isArray(value)) fail('report-external-evidence-invalid');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('report-external-evidence-entry-invalid');
    exactKeys(entry, EXTERNAL_EVIDENCE_KEYS, 'report-external-evidence-keys');
    if (!ORACLE_PROFILE_INVENTORY.some((profile) => profile.profileId === entry.profileId)) fail('report-external-evidence-profile-invalid');
    return {
      profileId: identity(entry.profileId, 'report-external-evidence-profile'),
      authorityId: assertIndependentText(entry.authorityId, 'report-external-evidence-authority'),
      reference: assertIndependentText(entry.reference, 'report-external-evidence-reference'),
      toolchainIdentity: assertIndependentText(entry.toolchainIdentity, 'report-external-evidence-toolchain'),
      status: identity(entry.status, 'report-external-evidence-status'),
    };
  });
}

export function createOracleReport({
  productSha,
  baseSha,
  candidateTreeSha = null,
  verifierIdentity = 'hex-independent-machine-effects-verifier',
  verifierVersion = '1.0.0',
  corpus,
  results = [],
  toolchain = null,
  generatedArtifactIdentity = null,
  a2Before = null,
  a2After = null,
  externalEvidence = [],
} = {}) {
  validateOraclePolicy();
  if (!corpus || typeof corpus !== 'object') fail('report-corpus-required');
  const normalizedCorpus = validateCorpus(corpus);
  sha(productSha, 'report-product-sha');
  sha(baseSha, 'report-base-sha');
  if (candidateTreeSha != null) sha(candidateTreeSha, 'report-candidate-tree-sha');
  const normalizedVerifierIdentity = identity(verifierIdentity, 'report-verifier-identity');
  const normalizedVerifierVersion = identity(verifierVersion, 'report-verifier-version');
  if (!Array.isArray(results)) fail('report-results-required');
  const casesById = new Map(normalizedCorpus.cases.map((item) => [item.caseId, item]));
  const seenResultCases = new Set();
  const normalizedResults = results.map((result) => {
    if (!result || typeof result !== 'object' || !RESULT_STATUSES.includes(result.status)) fail('report-result-invalid');
    const caseValue = casesById.get(result.caseId);
    if (!caseValue) fail('report-result-case-unknown', result.caseId);
    if (seenResultCases.has(result.caseId)) fail('report-result-case-duplicate', result.caseId);
    seenResultCases.add(result.caseId);
    return validateOracleResult(result, caseValue);
  });
  const normalizedExternalEvidence = normalizeExternalEvidence(externalEvidence);
  const a2 = a2Before && a2After
    ? compareA2DenominatorSnapshots(a2Before, a2After)
    : { preserved: false, reason: 'a2-snapshot-not-provided' };
  const counts = statusCounts(normalizedResults);
  const profiles = profileSummaries(normalizedCorpus, normalizedResults);
  const passCount = normalizedResults.filter((result) => PASS_STATUSES.includes(result.status)).length;
  const blockingResults = normalizedResults.filter((result) => BLOCKING_STATUSES.includes(result.status));
  const reportWithoutId = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    productSha: productSha.toLowerCase(),
    baseSha: baseSha.toLowerCase(),
    candidateTreeSha: candidateTreeSha == null ? null : candidateTreeSha.toLowerCase(),
    verifierIdentity: normalizedVerifierIdentity,
    verifierVersion: normalizedVerifierVersion,
    corpusId: normalizedCorpus.corpusId,
    generatorIdentity: normalizedCorpus.generatorIdentity,
    generatorVersion: normalizedCorpus.generatorVersion,
    oracleIdentity: INDEPENDENT_ORACLE_IDENTITY,
    oracleVersion: INDEPENDENT_ORACLE_VERSION,
    toolchain: toolchain == null ? null : normalizeToolchain(toolchain),
    generatedArtifactIdentity: generatedArtifactIdentity == null ? null : identity(generatedArtifactIdentity, 'report-generated-identity'),
    profileSummaries: profiles,
    counts,
    comparisonCounts: aggregateComparisonCounts(normalizedResults),
    passCount,
    totalCount: results.length,
    nonPassReasons: normalizedResults.flatMap((result) => result.diagnostics.map((item) => ({ caseId: result.caseId, status: result.status, code: item.code }))),
    blockingCount: blockingResults.length,
    explicitGapCount: normalizedResults.filter((result) => ['unsupported', 'unavailable'].includes(result.status)).length,
    a2Preservation: a2,
    externalEvidence: normalizedExternalEvidence,
    policy: {
      networkAllowed: false,
      productionEvaluatorIsOracle: false,
      productionSemanticsOwnedHere: false,
      denominatorAuthoritySeparate: true,
    },
  };
  const reportId = sha256Digest(reportWithoutId);
  return deepFreeze({ ...reportWithoutId, reportId });
}

export function validateOracleReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) fail('report-invalid');
  validateOraclePolicy();
  const allowed = new Set([
    'schemaVersion', 'reportId', 'productSha', 'baseSha', 'candidateTreeSha', 'verifierIdentity', 'verifierVersion',
    'corpusId', 'generatorIdentity', 'generatorVersion', 'oracleIdentity', 'oracleVersion', 'toolchain',
    'generatedArtifactIdentity', 'profileSummaries', 'counts', 'comparisonCounts', 'passCount', 'totalCount',
    'nonPassReasons', 'blockingCount', 'explicitGapCount', 'a2Preservation', 'externalEvidence', 'policy',
  ]);
  for (const key of Object.keys(report)) if (!allowed.has(key)) fail('report-unknown-field', key);
  for (const key of ['schemaVersion', 'reportId', 'productSha', 'baseSha', 'verifierIdentity', 'verifierVersion', 'corpusId', 'generatorIdentity', 'generatorVersion', 'oracleIdentity', 'oracleVersion', 'profileSummaries', 'counts', 'comparisonCounts', 'passCount', 'totalCount', 'nonPassReasons', 'blockingCount', 'explicitGapCount', 'a2Preservation', 'externalEvidence', 'policy']) {
    if (!(key in report)) fail('report-missing-field', key);
  }
  if (report.schemaVersion !== REPORT_SCHEMA_VERSION) fail('report-schema-version');
  digest(report.reportId, 'report-id');
  sha(report.productSha, 'report-product-sha');
  sha(report.baseSha, 'report-base-sha');
  if (report.candidateTreeSha != null) sha(report.candidateTreeSha, 'report-candidate-tree-sha');
  identity(report.verifierIdentity, 'report-verifier-identity');
  identity(report.verifierVersion, 'report-verifier-version');
  digest(report.corpusId, 'report-corpus-id');
  assertIndependentText(report.generatorIdentity, 'report-generator-identity');
  identity(report.generatorVersion, 'report-generator-version');
  if (report.oracleIdentity !== INDEPENDENT_ORACLE_IDENTITY || report.oracleVersion !== INDEPENDENT_ORACLE_VERSION) fail('report-oracle-identity-invalid');
  exactKeys(report.policy, POLICY_KEYS, 'report-policy-invalid');
  if (Object.values(report.policy).some((value) => typeof value !== 'boolean')
    || report.policy.productionEvaluatorIsOracle !== false
    || report.policy.productionSemanticsOwnedHere !== false
    || report.policy.denominatorAuthoritySeparate !== true
    || report.policy.networkAllowed !== false) fail('report-authority-policy-invalid');
  exactKeys(report.counts, REPORT_COUNT_KEYS, 'report-status-counts-invalid');
  for (const status of REPORT_COUNT_KEYS) safeCount(report.counts[status], 'report-status-count-value');
  const countedResults = REPORT_COUNT_KEYS.reduce((sum, status) => sum + report.counts[status], 0);
  safeCount(report.totalCount, 'report-total-count');
  if (countedResults !== report.totalCount) fail('report-status-total-mismatch');
  exactKeys(report.comparisonCounts, COMPARISON_COUNT_KEYS, 'report-comparison-counts-invalid');
  for (const key of COMPARISON_COUNT_KEYS) safeCount(report.comparisonCounts[key], 'report-comparison-count-value');
  if (report.comparisonCounts.total !== report.comparisonCounts.registers
    + report.comparisonCounts.flags + report.comparisonCounts.vectors
    + report.comparisonCounts.memory + report.comparisonCounts.outcome) fail('report-comparison-total-mismatch');
  safeCount(report.passCount, 'report-pass-count');
  safeCount(report.blockingCount, 'report-blocking-count');
  safeCount(report.explicitGapCount, 'report-explicit-gap-count');
  const computedPassCount = PASS_STATUSES.reduce((sum, status) => sum + report.counts[status], 0);
  if (report.passCount !== computedPassCount) fail('report-pass-count-invalid');
  const computedBlockingCount = BLOCKING_STATUSES.reduce((sum, status) => sum + report.counts[status], 0);
  if (report.blockingCount !== computedBlockingCount) fail('report-blocking-count-invalid');
  const computedGapCount = ['unsupported', 'unavailable'].reduce((sum, status) => sum + report.counts[status], 0);
  if (report.explicitGapCount !== computedGapCount) fail('report-explicit-gap-count-invalid');
  if (!Array.isArray(report.profileSummaries) || report.profileSummaries.length !== ORACLE_PROFILE_INVENTORY.length) fail('report-profile-summaries-invalid');
  const profileIds = new Set();
  const profileSummaryKeys = ['profileId', 'architecture', 'isa', 'authorityId', 'reference', 'revision', 'toolchainIdentity', 'caseCount', 'resultCount', 'passCount', 'gapCount', 'gaps'];
  for (const summary of report.profileSummaries) {
    exactKeys(summary, profileSummaryKeys, 'report-profile-summary-keys');
    const profile = ORACLE_PROFILE_INVENTORY.find((item) => item.profileId === summary.profileId);
    if (!profile || profileIds.has(summary.profileId)) fail('report-profile-summary-profile-invalid');
    profileIds.add(summary.profileId);
    for (const key of ['architecture', 'isa', 'authorityId', 'reference', 'revision', 'toolchainIdentity']) {
      if (summary[key] !== profile[key]) fail('report-profile-summary-identity-invalid', key);
    }
    for (const key of ['caseCount', 'resultCount', 'passCount', 'gapCount']) safeCount(summary[key], 'report-profile-summary-count');
    if (summary.resultCount > summary.caseCount || summary.passCount > summary.resultCount) fail('report-profile-summary-count-inconsistent');
    if (!Array.isArray(summary.gaps) || summary.gapCount !== summary.gaps.length) fail('report-profile-summary-gaps-invalid');
    for (const gap of summary.gaps) {
      exactKeys(gap, ['status', 'caseId'], 'report-profile-gap-keys');
      if (!RESULT_STATUSES.includes(gap.status) || PASS_STATUSES.includes(gap.status)) fail('report-profile-gap-status-invalid');
      if (gap.caseId != null) digest(gap.caseId, 'report-profile-gap-case-id');
    }
  }
  if (profileIds.size !== ORACLE_PROFILE_INVENTORY.length) fail('report-profile-summary-profile-count');
  if (!Array.isArray(report.nonPassReasons)) fail('report-non-pass-reasons-invalid');
  for (const reason of report.nonPassReasons) {
    exactKeys(reason, ['caseId', 'status', 'code'], 'report-non-pass-reason-keys');
    digest(reason.caseId, 'report-non-pass-reason-case-id');
    if (!RESULT_STATUSES.includes(reason.status) || PASS_STATUSES.includes(reason.status)) fail('report-non-pass-reason-status');
    identity(reason.code, 'report-non-pass-reason-code');
  }
  normalizeExternalEvidence(report.externalEvidence);
  if (report.toolchain != null) normalizeToolchain(report.toolchain);
  if (report.generatedArtifactIdentity != null) identity(report.generatedArtifactIdentity, 'report-generated-identity');
  const a2Keys = new Set(['preserved', 'reason', 'beforeDigest', 'afterDigest', 'beforeRowCount', 'afterRowCount']);
  if (!report.a2Preservation || typeof report.a2Preservation !== 'object' || Array.isArray(report.a2Preservation)) fail('report-a2-preservation-invalid');
  for (const key of Object.keys(report.a2Preservation)) if (!a2Keys.has(key)) fail('report-a2-preservation-unknown-field', key);
  if (typeof report.a2Preservation.preserved !== 'boolean') fail('report-a2-preservation-invalid');
  for (const key of ['beforeDigest', 'afterDigest']) if (report.a2Preservation[key] != null) digest(report.a2Preservation[key], 'report-a2-digest');
  for (const key of ['beforeRowCount', 'afterRowCount']) if (report.a2Preservation[key] != null) safeCount(report.a2Preservation[key], 'report-a2-row-count');
  const payload = { ...report };
  delete payload.reportId;
  if (sha256Digest(payload) !== report.reportId) fail('report-stale-identity');
  return deepFreeze(report);
}

export function assertReleaseReady(report, {
  expectedProductSha = null,
  expectedBaseSha = null,
  expectedCandidateTreeSha = null,
  requireCandidateTree = false,
  requireA2Preservation = true,
} = {}) {
  const normalized = validateOracleReport(report);
  if (expectedProductSha != null && normalized.productSha !== sha(expectedProductSha, 'expected-product-sha')) fail('report-product-sha-mismatch');
  if (expectedBaseSha != null && normalized.baseSha !== sha(expectedBaseSha, 'expected-base-sha')) fail('report-base-sha-mismatch');
  if (requireCandidateTree && normalized.candidateTreeSha == null) fail('report-candidate-tree-required');
  if (expectedCandidateTreeSha != null && normalized.candidateTreeSha !== sha(expectedCandidateTreeSha, 'expected-candidate-tree-sha')) fail('report-candidate-tree-mismatch');
  if (requireA2Preservation && normalized.a2Preservation.preserved !== true) fail('report-a2-denominator-not-preserved');
  if (!normalized.toolchain || typeof normalized.toolchain.identity !== 'string' || normalized.toolchain.identity === '') fail('report-toolchain-required');
  if (normalized.blockingCount !== 0) fail('report-blocking-results', normalized.blockingCount);
  if (normalized.profileSummaries.some((profile) => profile.caseCount === 0 || profile.passCount < profile.caseCount)) fail('report-profile-gap');
  if (normalized.totalCount !== normalized.passCount + normalized.explicitGapCount + Object.entries(normalized.counts).filter(([status]) => !PASS_STATUSES.includes(status) && !['unsupported', 'unavailable'].includes(status)).reduce((sum, [, count]) => sum + count, 0)) fail('report-result-count-inconsistent');
  return true;
}
