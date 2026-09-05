/**
 * HEX-C3-03 — Unified Language & Runtime Metadata Provider Boundary.
 *
 * Provides a canonical, versioned, fail-closed boundary for language and runtime
 * metadata across Go, Rust, Swift, Objective-C, and related ecosystems.
 *
 * Core rule:
 * Metadata is evidence, not authority unless its identity is proven.
 * Only `matched-authoritative` and the explicitly covered parts of `matched-partial`
 * may produce hard constraints into the canonical TypeConstraintGraph.
 */

import { deepFreeze, stableDigest } from '../core/identity/index.js';
import { createAnalysisStatus, isCompleteStatus, ANALYSIS_STATUS_SCHEMA_VERSION } from '../analysis/status.js';

export const METADATA_PROVIDER_CONTRACT_VERSION = '1.0.0';
export const METADATA_PROVIDER_SCHEMA_VERSION = 1;

export function isCanonicalAnalysisStatus(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) return false;
  if (status.schemaVersion !== ANALYSIS_STATUS_SCHEMA_VERSION) return false;
  try {
    const canonical = createAnalysisStatus(status);
    const keys = Object.keys(canonical);
    if (Object.keys(status).length !== keys.length) return false;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(status, key)) return false;
      if (Array.isArray(canonical[key])) {
        if (!Array.isArray(status[key]) || status[key].length !== canonical[key].length) return false;
        if (canonical[key].some((value, index) => status[key][index] !== value)) return false;
      } else if (status[key] !== canonical[key]) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Identity verdicts. Only `matched-authoritative` and covered `matched-partial`
 * are permitted to produce hard type constraints.
 */
export const METADATA_IDENTITY_VERDICTS = Object.freeze([
  'matched-authoritative',
  'matched-partial',
  'identity-unavailable',
  'identity-mismatch',
  'unsupported',
  'malformed',
  'ambiguous',
]);

const AUTHORITATIVE_VERDICTS = new Set(['matched-authoritative', 'matched-partial']);
const VERDICT_SET = new Set(METADATA_IDENTITY_VERDICTS);

export const METADATA_RECORD_KINDS = Object.freeze([
  'symbol',
  'type',
  'vtable',
  'conformance',
  'field',
  'method',
  'module',
]);

const KIND_SET = new Set(METADATA_RECORD_KINDS);

export const METADATA_DEFAULT_PAGE_SIZE = 512;
export const METADATA_DEFAULT_BUDGET = Object.freeze({
  maxBytesScanned: 64 * 1024 * 1024,
  maxRecords: 200000,
  maxDepth: 64,
});

function fail(code) { throw new TypeError(code); }

function nonEmpty(value, code) {
  if (typeof value !== 'string') fail(code);
  const text = value.trim();
  if (!text) fail(code);
  return text;
}

function strictNonEmptyString(value, code) {
  if (typeof value !== 'string') fail(code);
  const text = value.trim();
  if (!text) fail(code);
  return text;
}

function arrayField(value, code) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail(code);
  return value;
}

function optionalSizeBytes(value) {
  if (value == null) return null;
  if (typeof value !== 'number' && typeof value !== 'string') fail('metadata-record-invalid-size');
  if (typeof value === 'string' && !value.trim()) fail('metadata-record-invalid-size');
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) fail('metadata-record-invalid-size');
  return size;
}

function cloneCoverage(value) {
  if (Array.isArray(value)) return value.map(cloneCoverage);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneCoverage(item)]));
  }
  return value;
}

function nonNegativeSafeInteger(value, code) {
  if (value == null) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

/**
 * Creates a versioned language metadata identity.
 */
export function createLanguageMetadataIdentity(input = {}) {
  const verdict = nonEmpty(input.verdict, 'metadata-identity-verdict-required');
  if (!VERDICT_SET.has(verdict)) fail('metadata-identity-invalid-verdict');

  const identity = {
    verdict,
    providerId: nonEmpty(input.providerId, 'metadata-identity-provider-required'),
    providerVersion: nonEmpty(input.providerVersion, 'metadata-identity-provider-version-required'),
    ecosystem: nonEmpty(input.ecosystem, 'metadata-identity-ecosystem-required'),
    toolchainVersion: input.toolchainVersion == null ? null : strictNonEmptyString(input.toolchainVersion, 'metadata-identity-invalid-toolchain-version'),
    binaryIdentity: input.binaryIdentity == null ? null : strictNonEmptyString(input.binaryIdentity, 'metadata-identity-invalid-binary-identity'),
    architecture: input.architecture == null ? null : strictNonEmptyString(input.architecture, 'metadata-identity-invalid-architecture'),
    platform: input.platform == null ? null : strictNonEmptyString(input.platform, 'metadata-identity-invalid-platform'),
    expected: input.expected == null ? null : strictNonEmptyString(input.expected, 'metadata-identity-invalid-expected'),
    observed: input.observed == null ? null : strictNonEmptyString(input.observed, 'metadata-identity-invalid-observed'),
    method: nonEmpty(input.method ?? 'runtime-metadata', 'metadata-identity-method-required'),
    detail: input.detail == null ? null : String(input.detail),
    coverage: input.coverage == null ? null : cloneCoverage(input.coverage),
  };

  if (identity.method === 'filename') fail('metadata-identity-filename-is-not-authority');
  if (AUTHORITATIVE_VERDICTS.has(verdict) && (identity.observed == null || identity.expected == null) && identity.toolchainVersion == null && identity.binaryIdentity == null) {
    fail('metadata-identity-match-requires-compared-identities');
  }
  if (verdict === 'matched-authoritative' && identity.expected != null && identity.observed != null && identity.expected !== identity.observed) {
    fail('metadata-identity-authoritative-requires-equal-identities');
  }

  identity.digest = stableDigest({
    verdict: identity.verdict,
    providerId: identity.providerId,
    providerVersion: identity.providerVersion,
    ecosystem: identity.ecosystem,
    toolchainVersion: identity.toolchainVersion,
    binaryIdentity: identity.binaryIdentity,
    observed: identity.observed,
    expected: identity.expected,
  });

  const frozen = deepFreeze(identity);
  CANONICAL_IDENTITIES.add(frozen);
  return frozen;
}

const CANONICAL_IDENTITIES = new WeakSet();

export function isCanonicalLanguageIdentity(identity) {
  return !!identity && typeof identity === 'object' && CANONICAL_IDENTITIES.has(identity);
}

/** True when this identity may create authoritative (hard) facts. */
export function isAuthoritative(identity) {
  return isCanonicalLanguageIdentity(identity) && AUTHORITATIVE_VERDICTS.has(identity.verdict);
}

function coverageList(value) {
  if (value == null) return null;
  if (!Array.isArray(value)) return null;
  if (value.some((item) => typeof item !== 'string' || !item.trim())) return null;
  return new Set(value.map((item) => item.trim()));
}

function languageRecordMatchesIdentitySource(identity, record) {
  if (!identity || !record) return false;
  if (record.providerId !== identity.providerId) return false;
  if (record.providerVersion !== identity.providerVersion) return false;
  if (record.ecosystem !== identity.ecosystem) return false;
  if (record.buildIdentity != null && identity.observed != null && record.buildIdentity !== identity.observed) return false;
  return true;
}

/**
 * True only when one record is explicitly covered by a partial identity.
 * Conjunctive and fail-closed: unverified selectors never become authority.
 */
export function isLanguageRecordAuthoritative(result, record) {
  const identity = result?.identity;
  if (!identity || !record || !isCanonicalLanguageIdentity(identity)) return false;
  if (!isCanonicalLanguageRecord(record)) return false;
  if (!languageRecordMatchesIdentitySource(identity, record)) return false;
  if (result?.completeness?.complete !== true || !isCompleteStatus(result?.status) || !isCanonicalAnalysisStatus(result?.status)) return false;
  if (identity.verdict === 'matched-authoritative') return true;
  if (identity.verdict !== 'matched-partial') return false;

  const coverage = identity.coverage;
  if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) return false;
  const known = new Set(['entityIds', 'recordKinds', 'addresses', 'buildIdentities', 'modules', 'module', 'ecosystem']);
  const keys = Object.keys(coverage);
  if (keys.length === 0 || keys.some((key) => !known.has(key))) return false;

  let constrained = false;
  const entityIds = coverageList(coverage.entityIds);
  if (entityIds) {
    constrained = true;
    if (typeof record.entityId !== 'string' || !entityIds.has(record.entityId)) return false;
  } else if (coverage.entityIds != null) return false;

  const recordKinds = coverageList(coverage.recordKinds);
  if (recordKinds) {
    constrained = true;
    if (typeof record.kind !== 'string' || !recordKinds.has(record.kind)) return false;
  } else if (coverage.recordKinds != null) return false;

  const addresses = coverageList(coverage.addresses);
  if (addresses) {
    constrained = true;
    if (typeof record.address !== 'string' || !addresses.has(record.address)) return false;
  } else if (coverage.addresses != null) return false;

  const buildIdentities = coverageList(coverage.buildIdentities);
  if (buildIdentities) {
    constrained = true;
    if (typeof record.buildIdentity !== 'string' || !buildIdentities.has(record.buildIdentity)) return false;
  } else if (coverage.buildIdentities != null) return false;

  const modules = coverageList(coverage.modules);
  if (modules) {
    constrained = true;
    const moduleId = record.descriptor?.module ?? record.descriptor?.moduleId ?? null;
    if (typeof moduleId !== 'string' || !modules.has(moduleId)) return false;
  } else if (coverage.modules != null) return false;

  if (coverage.module != null) {
    constrained = true;
    const moduleId = record.descriptor?.module ?? record.descriptor?.moduleId ?? null;
    if (typeof coverage.module !== 'string' || !coverage.module.trim()) return false;
    if (typeof moduleId !== 'string' || moduleId !== coverage.module.trim()) return false;
  }

  if (coverage.ecosystem != null) {
    constrained = true;
    if (typeof coverage.ecosystem !== 'string' || coverage.ecosystem.trim() !== identity.ecosystem) return false;
  }

  return constrained;
}

const CANONICAL_RECORDS = new WeakSet();

export function isCanonicalLanguageRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (CANONICAL_RECORDS.has(record)) return true;
  if (typeof record.kind !== 'string' || !KIND_SET.has(record.kind)) return false;
  if (typeof record.entityId !== 'string' || !record.entityId.trim()) return false;
  if (typeof record.providerId !== 'string' || !record.providerId.trim()) return false;
  if (typeof record.providerVersion !== 'string' || !record.providerVersion.trim()) return false;
  if (typeof record.ecosystem !== 'string' || !record.ecosystem.trim()) return false;
  if (!Array.isArray(record.evidenceIds)) return false;
  if (record.evidenceIds.some((id) => typeof id !== 'string' || !id.trim())) return false;
  if (record.address != null && (typeof record.address !== 'string' || !record.address.trim())) return false;
  if (record.buildIdentity != null && (typeof record.buildIdentity !== 'string' || !record.buildIdentity.trim())) return false;
  if (record.sizeBytes != null && (!Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 0)) return false;
  return true;
}

/** One record from a language metadata provider. */
export function createLanguageMetadataRecord(input = {}) {
  const kind = nonEmpty(input.kind, 'metadata-record-kind-required');
  if (!KIND_SET.has(kind)) fail('metadata-record-invalid-kind');
  const record = deepFreeze({
    kind,
    entityId: strictNonEmptyString(input.entityId, 'metadata-record-entity-required'),
    name: input.name == null ? null : String(input.name),
    address: input.address == null ? null : strictNonEmptyString(input.address, 'metadata-record-invalid-address'),
    sizeBytes: optionalSizeBytes(input.sizeBytes),
    descriptor: input.descriptor ?? null,
    providerId: nonEmpty(input.providerId, 'metadata-record-provider-required'),
    providerVersion: nonEmpty(input.providerVersion, 'metadata-record-provider-version-required'),
    ecosystem: nonEmpty(input.ecosystem ?? 'generic', 'metadata-record-ecosystem-required'),
    buildIdentity: input.buildIdentity == null ? null : strictNonEmptyString(input.buildIdentity, 'metadata-record-invalid-build-identity'),
    evidenceIds: [...new Set((input.evidenceIds ?? []).map((value) => strictNonEmptyString(value, 'metadata-record-invalid-evidence-id')))].sort(),
  });
  CANONICAL_RECORDS.add(record);
  return record;
}

/** One page of records. */
export function createLanguageMetadataPage(input = {}) {
  return deepFreeze({
    records: deepFreeze([...arrayField(input.records, 'metadata-page-records-must-be-array')]),
    nextCursor: input.nextCursor == null ? null : String(input.nextCursor),
    truncated: input.truncated === true,
  });
}

/** The unified provider result. */
export function createLanguageMetadataResult(input = {}) {
  const identity = createLanguageMetadataIdentity(input.identity ?? {
    providerId: input.providerId,
    providerVersion: input.providerVersion,
    ecosystem: input.ecosystem,
    verdict: input.verdict ?? 'identity-unavailable',
  });
  const sections = arrayField(input.sections, 'metadata-result-sections-must-be-array');
  const reasons = arrayField(input.completeness?.reasons, 'metadata-result-reasons-must-be-array');
  const diagnostics = arrayField(input.diagnostics, 'metadata-result-diagnostics-must-be-array');
  const defaultCompleteness = input.completeness?.complete === true ? 'complete' : 'partial';
  const defaultStopReason = defaultCompleteness === 'complete' ? null : (input.completeness?.capped ? 'budget-exhausted' : 'evidence-missing');
  if (input.status != null && input.status.schemaVersion != null && input.status.schemaVersion !== ANALYSIS_STATUS_SCHEMA_VERSION) {
    fail('metadata-result-invalid-status-schema');
  }
  const status = input.status != null
    ? createAnalysisStatus(input.status)
    : createAnalysisStatus({
      snapshotId: input.snapshotId ?? 'metadata-unbound',
      analyzerId: identity.providerId,
      analyzerVersion: identity.providerVersion,
      completeness: defaultCompleteness,
      stopReason: defaultStopReason,
    });
  return deepFreeze({
    schemaVersion: METADATA_PROVIDER_SCHEMA_VERSION,
    contractVersion: METADATA_PROVIDER_CONTRACT_VERSION,
    providerId: identity.providerId,
    providerVersion: identity.providerVersion,
    ecosystem: identity.ecosystem,
    identity,
    authoritative: isAuthoritative(identity),
    sections: deepFreeze([...sections].map(String).sort()),
    counts: deepFreeze({ ...(input.counts ?? {}) }),
    completeness: deepFreeze({
      present: input.completeness?.present ?? (sections.length > 0),
      declared: nonNegativeSafeInteger(input.completeness?.declared, 'metadata-result-invalid-declared'),
      scanned: nonNegativeSafeInteger(input.completeness?.scanned, 'metadata-result-invalid-scanned'),
      parsed: nonNegativeSafeInteger(input.completeness?.parsed, 'metadata-result-invalid-parsed'),
      capped: input.completeness?.capped === true,
      unreadableEntries: nonNegativeSafeInteger(input.completeness?.unreadableEntries, 'metadata-result-invalid-unreadable-entries'),
      invalidEntries: nonNegativeSafeInteger(input.completeness?.invalidEntries, 'metadata-result-invalid-invalid-entries'),
      complete: input.completeness?.complete === true,
      reasons: deepFreeze([...reasons].map(String)),
    }),
    diagnostics: deepFreeze([...diagnostics].map(String)),
    status,
  });
}

/**
 * Base abstract language metadata provider class.
 */
export class LanguageMetadataProvider {
  constructor({ id, version, ecosystem }) {
    this.id = nonEmpty(id, 'metadata-provider-id-required');
    this.version = nonEmpty(version, 'metadata-provider-version-required');
    this.ecosystem = nonEmpty(ecosystem, 'metadata-provider-ecosystem-required');
  }

  /** Must return a `LanguageMetadataResult`. */
  probe() { fail('metadata-provider-probe-not-implemented'); }

  symbols() { return createLanguageMetadataPage({}); }
  types() { return createLanguageMetadataPage({}); }
  vtables() { return createLanguageMetadataPage({}); }
  conformances() { return createLanguageMetadataPage({}); }
  methods() { return createLanguageMetadataPage({}); }

  authoritativeRecords(result, reader, scope, options = {}) {
    if (!result.authoritative) return createLanguageMetadataPage({ records: [], truncated: false });
    const page = reader.call(this, scope, options);
    return createLanguageMetadataPage({
      records: (page.records ?? []).filter((record) => isLanguageRecordAuthoritative(result, record)),
      nextCursor: page.nextCursor,
      truncated: page.truncated,
    });
  }
}

/**
 * Applies language metadata type records to TypeConstraintGraph.
 * Only authoritative identity matches may emit hard constraints.
 */
export function applyLanguageMetadataTypesToGraph(graph, result, page) {
  if (!graph) fail('metadata-apply-graph-required');
  const applied = { hard: 0, soft: 0, skipped: 0 };
  for (const record of page?.records ?? []) {
    if (record.kind !== 'type') { applied.skipped += 1; continue; }
    const claim = {
      layer: record.descriptor?.layer ?? 'nominal',
      entityId: record.entityId,
      descriptor: record.descriptor?.claim ?? record.descriptor,
    };
    if (isLanguageRecordAuthoritative(result, record)) {
      graph.addHardConstraint({
        kind: 'runtime-metadata-type',
        origin: 'runtime-verified',
        claim,
        evidenceIds: record.evidenceIds,
        providerVersion: record.providerVersion,
        buildIdentity: record.buildIdentity,
      });
      applied.hard += 1;
      continue;
    }
    graph.addSoftEvidence({
      kind: 'signature-candidate',
      origin: 'runtime-observed',
      weight: 0.35,
      claim,
      evidenceIds: record.evidenceIds,
    });
    applied.soft += 1;
  }
  return applied;
}

/**
 * Converts language metadata symbol/function records into discovery evidence.
 */
export function languageMetadataFunctionEvidence(result, page) {
  return (page?.records ?? [])
    .filter((record) => (record.kind === 'symbol' || record.kind === 'method') && record.address != null)
    .map((record) => ({
      kind: `${result.ecosystem}-function`,
      address: record.address,
      sizeBytes: record.sizeBytes ?? null,
      name: record.name,
      confidence: isLanguageRecordAuthoritative(result, record) ? 'exact' : 'heuristic',
      providerId: record.providerId,
      providerVersion: record.providerVersion,
      ecosystem: result.ecosystem,
      buildIdentity: record.buildIdentity,
      evidenceIds: record.evidenceIds,
    }));
}
