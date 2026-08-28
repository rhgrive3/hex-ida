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
  const diagnostics = Array.isArray(value.diagnostics) ? value.diagnostics.map((item) => String(item).slice(0, ORACLE_BUDGETS.maxDiagnosticBytes)) : [];
  return {
    identity: nonEmpty(value.identity, 'report-toolchain-identity'),
    ...(value.version == null ? {} : { version: nonEmpty(value.version, 'report-toolchain-version') }),
    ...(value.command == null ? {} : { command: nonEmpty(value.command, 'report-toolchain-command') }),
    ...(value.target == null ? {} : { target: nonEmpty(value.target, 'report-toolchain-target') }),
    ...(value.status == null ? {} : { status: nonEmpty(value.status, 'report-toolchain-status') }),
    diagnostics,
  };
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
  const normalizedResults = results.map((result) => {
    if (!result || typeof result !== 'object' || !RESULT_STATUSES.includes(result.status)) fail('report-result-invalid');
    return validateOracleResult(result, casesById.get(result.caseId) ?? null);
  });
  if (!Array.isArray(externalEvidence)) fail('report-external-evidence-invalid');
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
    externalEvidence,
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
  const allowed = new Set([
    'schemaVersion', 'reportId', 'productSha', 'baseSha', 'candidateTreeSha', 'verifierIdentity', 'verifierVersion',
    'corpusId', 'generatorIdentity', 'generatorVersion', 'oracleIdentity', 'oracleVersion', 'toolchain',
    'generatedArtifactIdentity', 'profileSummaries', 'counts', 'comparisonCounts', 'passCount', 'totalCount',
    'nonPassReasons', 'blockingCount', 'explicitGapCount', 'a2Preservation', 'externalEvidence', 'policy',
  ]);
  for (const key of Object.keys(report)) if (!allowed.has(key)) fail('report-unknown-field', key);
  for (const key of ['schemaVersion', 'reportId', 'productSha', 'baseSha', 'verifierIdentity', 'verifierVersion', 'corpusId', 'generatorIdentity', 'generatorVersion', 'oracleIdentity', 'oracleVersion', 'counts', 'comparisonCounts', 'passCount', 'totalCount', 'blockingCount', 'a2Preservation', 'policy']) {
    if (!(key in report)) fail('report-missing-field', key);
  }
  if (report.schemaVersion !== REPORT_SCHEMA_VERSION) fail('report-schema-version');
  sha(report.productSha, 'report-product-sha');
  sha(report.baseSha, 'report-base-sha');
  if (report.candidateTreeSha != null) sha(report.candidateTreeSha, 'report-candidate-tree-sha');
  if (report.oracleIdentity !== INDEPENDENT_ORACLE_IDENTITY || report.oracleVersion !== INDEPENDENT_ORACLE_VERSION) fail('report-oracle-identity-invalid');
  if (report.policy.productionEvaluatorIsOracle !== false || report.policy.denominatorAuthoritySeparate !== true) fail('report-authority-policy-invalid');
  if (!report.counts || typeof report.counts !== 'object' || Object.keys(report.counts).some((status) => !RESULT_STATUSES.includes(status))) fail('report-status-counts-invalid');
  if (!report.comparisonCounts || typeof report.comparisonCounts !== 'object') fail('report-comparison-counts-invalid');
  if (!Number.isSafeInteger(report.totalCount) || report.totalCount < 0 || !Number.isSafeInteger(report.blockingCount) || report.blockingCount < 0 || !Number.isSafeInteger(report.explicitGapCount) || report.explicitGapCount < 0) fail('report-counts-invalid');
  if (!Array.isArray(report.profileSummaries) || report.profileSummaries.length !== ORACLE_PROFILE_INVENTORY.length) fail('report-profile-summaries-invalid');
  if (!report.a2Preservation || typeof report.a2Preservation !== 'object' || typeof report.a2Preservation.preserved !== 'boolean') fail('report-a2-preservation-invalid');
  if (report.passCount !== Object.entries(report.counts).filter(([status]) => PASS_STATUSES.includes(status)).reduce((sum, [, count]) => sum + count, 0)) fail('report-pass-count-invalid');
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
