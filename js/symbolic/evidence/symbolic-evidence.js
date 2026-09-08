/**
 * js/symbolic/evidence/symbolic-evidence.js
 *
 * Deterministic SymbolicEvidence schema builder and validator.
 * Binds queryKind, claimKind, proofStatement, targetEntities, exact versioned hashes,
 * backend info, assumptions, completeness, and validation state into an immutable record.
 * Fails closed on invalid shapes, inconsistent preconditions, or solver failures.
 */

import { stableDigest } from '../../core/identity/index.js';
import { SOLVER_STATUS, isSolverFailure } from '../solver/result.js';
import { PROOF_AUTHORITY } from '../solver/backend.js';
import { EXPR_SCHEMA_VERSION } from '../expr/serialize.js';
import { COMPLETENESS_STATUS, createCompleteness } from '../translate/support-matrix.js';

export const EVIDENCE_SCHEMA_VERSION = '1.1.0';

export const EVIDENCE_VERDICT = Object.freeze({
  PROVED: 'proved',
  REFUTED: 'refuted',
  UNKNOWN: 'unknown',
});

export const CLAIM_KIND = Object.freeze({
  EDGE_FEASIBILITY: 'edge-feasibility',
  GLOBAL_EDGE_REACHABILITY: 'global-edge-reachability',
  BOUNDED_EQUIVALENCE: 'bounded-equivalence',
  PATCH_INVARIANT: 'patch-invariant',
  SYMBOLIC_QUERY: 'symbolic-query',
});

export const PRECONDITION_STATUS = Object.freeze({
  SATISFIABLE: 'satisfiable',
  INCONSISTENT: 'inconsistent',
  UNKNOWN: 'unknown',
  NONE: 'none',
});

export const VALIDATION_STATUS = Object.freeze({
  VALIDATED: 'validated',
  REJECTED: 'rejected',
  UNVALIDATED: 'unvalidated',
  NOT_APPLICABLE: 'not-applicable',
  FAILED: 'failed',
});

function sha256Hex(data) {
  return stableDigest(data);
}

function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = obj[key];
    if (val !== null && (typeof val === 'object' || typeof val === 'function') && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

/*
 * Dynamic keys are stored as own data properties. Assigning with `out[k] = ...`
 * routes the key `'__proto__'` through the prototype setter, so an own
 * `__proto__` target silently disappears and distinct targets normalize to the
 * same canonical form — and therefore to the same Evidence ID (#5903).
 */
function canonicalOwn(out, key, value) {
  Object.defineProperty(out, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return out;
}

/* Host-locale independent total order over string keys (UTF-16 code units).
 * Map entries must project into canonical records by key/value content only;
 * insertion history and ICU collation differences must not leak (#5774). */
function compareCanonicalKey(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedMapEntries(map) {
  const entries = [...map.entries()]
    .map(([key, value]) => ({ key: String(key), value }))
    .sort((a, b) => compareCanonicalKey(a.key, b.key));
  for (let i = 1; i < entries.length; i += 1) {
    if (entries[i - 1].key === entries[i].key) {
      throw new TypeError('createSymbolicEvidence: map key projection collision');
    }
  }
  return entries;
}

function canonicalize(val) {
  if (val === null || typeof val !== 'object') {
    if (typeof val === 'bigint') return `0x${val.toString(16)}`;
    return val;
  }
  if (val instanceof Map) {
    let out = {};
    for (const { key, value } of sortedMapEntries(val)) {
      out = canonicalOwn(out, key, canonicalize(value));
    }
    return out;
  }
  if (Array.isArray(val)) {
    return val.map(canonicalize);
  }
  let sorted = {};
  for (const k of Object.keys(val).sort()) {
    sorted = canonicalOwn(sorted, k, canonicalize(val[k]));
  }
  return sorted;
}

export function computeEvidenceId({
  schemaVersion = EVIDENCE_SCHEMA_VERSION,
  queryKind,
  claimKind,
  queryHash,
  backendId,
  backendVersion,
  solverStatus,
  verdict,
  targetEntities = [],
  proofAuthority = PROOF_AUTHORITY.NONE,
  capabilityFingerprint = null,
}) {
  const canonicalPayload = canonicalize({
    schemaVersion,
    queryKind: String(queryKind),
    claimKind: String(claimKind),
    queryHash: String(queryHash),
    backendId: String(backendId),
    backendVersion: String(backendVersion),
    solverStatus: String(solverStatus),
    verdict: String(verdict),
    proofAuthority: String(proofAuthority),
    capabilityFingerprint: capabilityFingerprint == null ? null : String(capabilityFingerprint),
    targetEntities: Array.isArray(targetEntities) ? targetEntities.map(String).sort() : [],
  });
  const digest = sha256Hex(JSON.stringify(canonicalPayload));
  return `ev_${digest.slice(0, 32)}`;
}

export function createSymbolicEvidence({
  queryKind,
  claimKind,
  proofStatement,
  targetEntities,
  queryHash,
  exprSchemaVersion = EXPR_SCHEMA_VERSION,
  translatorVersion = '1.0.0',
  semanticIrVersion = '2.0.0',
  backendId,
  backendVersion = '0.0.0',
  proofAuthority = PROOF_AUTHORITY.NONE,
  capabilityFingerprint = null,
  solverStatus,
  preconditionStatus = PRECONDITION_STATUS.NONE,
  validationStatus = VALIDATION_STATUS.NOT_APPLICABLE,
  assumptions = [],
  completeness = null,
  origins = {},
  verdict,
  witnessModel = null,
  limits = null,
  architecture = 'generic',
  bitWidth = null,
  proofScope = null,
  metadata = null,
}) {
  // Required string validations
  if (!queryKind || typeof queryKind !== 'string' || queryKind.trim() === '') {
    throw new TypeError('createSymbolicEvidence: queryKind must be a non-empty string');
  }
  if (!claimKind || typeof claimKind !== 'string' || claimKind.trim() === '') {
    throw new TypeError('createSymbolicEvidence: claimKind must be a non-empty string');
  }
  if (!proofStatement || typeof proofStatement !== 'string' || proofStatement.trim() === '') {
    throw new TypeError('createSymbolicEvidence: proofStatement must be a non-empty string');
  }
  if (!targetEntities || !Array.isArray(targetEntities)) {
    throw new TypeError('createSymbolicEvidence: targetEntities must be an array');
  }
  if (!queryHash || typeof queryHash !== 'string' || queryHash.trim() === '') {
    throw new TypeError('createSymbolicEvidence: queryHash must be a non-empty string');
  }
  if (!exprSchemaVersion || typeof exprSchemaVersion !== 'string') {
    throw new TypeError('createSymbolicEvidence: exprSchemaVersion must be a string');
  }
  if (!translatorVersion || typeof translatorVersion !== 'string') {
    throw new TypeError('createSymbolicEvidence: translatorVersion must be a string');
  }
  if (!semanticIrVersion || typeof semanticIrVersion !== 'string') {
    throw new TypeError('createSymbolicEvidence: semanticIrVersion must be a string');
  }
  if (!backendId || typeof backendId !== 'string' || backendId.trim() === '') {
    throw new TypeError('createSymbolicEvidence: backendId must be a non-empty string');
  }
  if (!backendVersion || typeof backendVersion !== 'string') {
    throw new TypeError('createSymbolicEvidence: backendVersion must be a string');
  }
  if (!Object.values(PROOF_AUTHORITY).includes(proofAuthority)) {
    throw new TypeError(`createSymbolicEvidence: invalid proofAuthority '${proofAuthority}'`);
  }

  // Validate solver status
  if (!solverStatus || !Object.values(SOLVER_STATUS).includes(solverStatus)) {
    throw new TypeError(`createSymbolicEvidence: invalid solverStatus '${solverStatus}'`);
  }

  // Validate verdict
  if (!verdict || !Object.values(EVIDENCE_VERDICT).includes(verdict)) {
    throw new TypeError(`createSymbolicEvidence: invalid verdict '${verdict}'`);
  }

  // Validate precondition status if specified
  if (typeof preconditionStatus !== 'string' || !Object.values(PRECONDITION_STATUS).includes(preconditionStatus)) {
    throw new TypeError(`createSymbolicEvidence: invalid preconditionStatus '${preconditionStatus}'`);
  }
  const normPreconditionStatus = preconditionStatus;

  // Validate validation status if specified
  if (typeof validationStatus !== 'string' || !Object.values(VALIDATION_STATUS).includes(validationStatus)) {
    throw new TypeError(`createSymbolicEvidence: invalid validationStatus '${validationStatus}'`);
  }
  const normValidationStatus = validationStatus;

  // Invariant 1: Inconsistent preconditions cannot mint confirmed proved evidence (prevent vacuous truth)
  if (verdict === EVIDENCE_VERDICT.PROVED && normPreconditionStatus === PRECONDITION_STATUS.INCONSISTENT) {
    throw new Error('createSymbolicEvidence: cannot mint proved evidence when preconditions are inconsistent');
  }

  // Invariant 2: Solver failures cannot mint proved evidence
  if (verdict === EVIDENCE_VERDICT.PROVED && isSolverFailure({ status: solverStatus })) {
    throw new Error(`createSymbolicEvidence: cannot mint proved evidence with solver failure status '${solverStatus}'`);
  }

  // Invariant 3: Unsupported translation completeness cannot mint proved evidence
  const normCompleteness = completeness
    ? createCompleteness(completeness)
    : createCompleteness();

  if (
    verdict === EVIDENCE_VERDICT.PROVED &&
    (normCompleteness.translation === COMPLETENESS_STATUS.UNSUPPORTED || normCompleteness.translation === 'unsupported')
  ) {
    throw new Error('createSymbolicEvidence: cannot mint proved evidence with unsupported translation completeness');
  }

  if (verdict === EVIDENCE_VERDICT.PROVED) {
    if (solverStatus !== SOLVER_STATUS.UNSAT) {
      throw new Error('createSymbolicEvidence: proved evidence requires an UNSAT solver result');
    }
    if (proofAuthority !== PROOF_AUTHORITY.EXACT) {
      throw new Error('createSymbolicEvidence: only exact proof authority can mint proved evidence');
    }
    if (!capabilityFingerprint || typeof capabilityFingerprint !== 'string') {
      throw new Error('createSymbolicEvidence: exact proof evidence requires a capability fingerprint');
    }
    if (normPreconditionStatus !== PRECONDITION_STATUS.SATISFIABLE) {
      throw new Error('createSymbolicEvidence: proved evidence requires satisfiable preconditions');
    }
    for (const key of ['translation', 'controlFlow', 'memoryEffects', 'pathCoverage', 'queryScope']) {
      if (normCompleteness[key] !== COMPLETENESS_STATUS.COMPLETE) {
        throw new Error(`createSymbolicEvidence: proved evidence requires complete ${key} scope`);
      }
    }
  }

  if (verdict === EVIDENCE_VERDICT.REFUTED && solverStatus !== SOLVER_STATUS.SAT) {
    throw new Error('createSymbolicEvidence: refuted evidence requires a SAT solver result');
  }

  // Invariant 4: Refuted verdict with rejected witness model is invalid
  if (verdict === EVIDENCE_VERDICT.REFUTED && normValidationStatus === VALIDATION_STATUS.REJECTED) {
    throw new Error('createSymbolicEvidence: cannot mint refuted evidence when witness model validation was rejected');
  }

  // Normalize targetEntities
  const normalizedTargets = targetEntities.map((t) => (typeof t === 'string' ? t : JSON.stringify(canonicalize(t))));

  // Normalize assumptions
  const normalizedAssumptions = Array.isArray(assumptions)
    ? assumptions.map((a) => (typeof a === 'object' && a !== null ? { ...a } : a))
    : [];

  // Normalize witnessModel
  let normalizedWitness = null;
  if (witnessModel) {
    if (witnessModel instanceof Map) {
      normalizedWitness = {};
      // Deterministic code-unit order for Map projection; canonicalOwn keeps
      // proto-like keys as own data properties (#5774/#5903).
      for (const { key, value } of sortedMapEntries(witnessModel)) {
        canonicalOwn(
          normalizedWitness,
          key,
          typeof value === 'bigint' ? `0x${value.toString(16)}` : canonicalize(value)
        );
      }
    } else if (typeof witnessModel === 'object') {
      normalizedWitness = canonicalize(witnessModel);
    }
  }

  // Normalize origins
  let normalizedOrigins = origins;
  if (origins instanceof Map) {
    normalizedOrigins = {};
    // Deterministic code-unit order for Map projection; retain canonical values.
    for (const { key, value: rawValue } of sortedMapEntries(origins)) {
      const value = Array.isArray(rawValue) || rawValue instanceof Set
        ? [...rawValue].map(String).sort()
        : canonicalize(rawValue);
      canonicalOwn(
        normalizedOrigins,
        key,
        value
      );
    }
  } else if (typeof origins === 'object' && origins !== null) {
    normalizedOrigins = canonicalize(origins);
  }

  const id = computeEvidenceId({
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    queryKind,
    claimKind,
    queryHash,
    backendId,
    backendVersion,
    proofAuthority,
    capabilityFingerprint,
    solverStatus,
    verdict,
    targetEntities: normalizedTargets,
  });

  const record = {
    id,
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    queryKind: String(queryKind),
    claimKind: String(claimKind),
    proofStatement: String(proofStatement),
    targetEntities: normalizedTargets,
    queryHash: String(queryHash),
    exprSchemaVersion: String(exprSchemaVersion),
    translatorVersion: String(translatorVersion),
    semanticIrVersion: String(semanticIrVersion),
    backendId: String(backendId),
    backendVersion: String(backendVersion),
    proofAuthority,
    capabilityFingerprint: capabilityFingerprint == null ? null : String(capabilityFingerprint),
    capabilityFingerprintHash: capabilityFingerprint ? stableDigest(String(capabilityFingerprint)) : null,
    solverStatus,
    preconditionStatus: normPreconditionStatus,
    validationStatus: normValidationStatus,
    assumptions: normalizedAssumptions,
    completeness: normCompleteness,
    origins: normalizedOrigins,
    verdict,
    witnessModel: normalizedWitness,
    limits: limits ? canonicalize(limits) : null,
    architecture: String(architecture),
    bitWidth: bitWidth == null ? null : Number(bitWidth),
    proofScope: proofScope ? canonicalize(proofScope) : null,
    assumptionsFingerprint: stableDigest(normalizedAssumptions),
    metadata: metadata ? canonicalize(metadata) : null,
  };

  return deepFreeze(record);
}

export function isProvedEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return false;
  return (
    isCanonicalSymbolicEvidence(evidence) &&
    evidence.verdict === EVIDENCE_VERDICT.PROVED &&
    evidence.proofAuthority === PROOF_AUTHORITY.EXACT &&
    typeof evidence.capabilityFingerprint === 'string' &&
    evidence.capabilityFingerprint.length > 0 &&
    evidence.preconditionStatus !== PRECONDITION_STATUS.INCONSISTENT &&
    evidence.preconditionStatus === PRECONDITION_STATUS.SATISFIABLE &&
    evidence.completeness?.translation === COMPLETENESS_STATUS.COMPLETE &&
    evidence.completeness?.controlFlow === COMPLETENESS_STATUS.COMPLETE &&
    evidence.completeness?.memoryEffects === COMPLETENESS_STATUS.COMPLETE &&
    evidence.completeness?.pathCoverage === COMPLETENESS_STATUS.COMPLETE &&
    evidence.completeness?.queryScope === COMPLETENESS_STATUS.COMPLETE &&
    evidence.solverStatus === SOLVER_STATUS.UNSAT &&
    !isSolverFailure({ status: evidence.solverStatus })
  );
}

export function isRefutedEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return false;
  return (
    isCanonicalSymbolicEvidence(evidence) &&
    evidence.verdict === EVIDENCE_VERDICT.REFUTED &&
    evidence.solverStatus === SOLVER_STATUS.SAT &&
    evidence.validationStatus !== VALIDATION_STATUS.REJECTED &&
    !isSolverFailure({ status: evidence.solverStatus })
  );
}

/**
 * Authority predicate boundary (#5400): field values alone cannot carry proof
 * authority — the record must be canonical. The evidence id must be exactly
 * the digest `computeEvidenceId` derives from the identity-bearing fields, so
 * forged plain objects and tampered clones (queryHash/backend/fingerprint
 * swaps) fail closed instead of laundering into PROVED/REFUTED authority.
 */
function isCanonicalSymbolicEvidence(evidence) {
  if (evidence.schemaVersion !== EVIDENCE_SCHEMA_VERSION) return false;
  if (typeof evidence.id !== 'string' || evidence.id.length === 0) return false;
  if (typeof evidence.queryKind !== 'string' || evidence.queryKind.length === 0) return false;
  if (typeof evidence.claimKind !== 'string' || evidence.claimKind.length === 0) return false;
  if (typeof evidence.queryHash !== 'string' || evidence.queryHash.length === 0) return false;
  if (typeof evidence.backendId !== 'string' || evidence.backendId.length === 0) return false;
  if (typeof evidence.backendVersion !== 'string' || evidence.backendVersion.length === 0) return false;
  if (evidence.capabilityFingerprint !== null && typeof evidence.capabilityFingerprint !== 'string') return false;
  if (evidence.capabilityFingerprintHash !== (evidence.capabilityFingerprint ? stableDigest(String(evidence.capabilityFingerprint)) : null)) return false;
  if (!Array.isArray(evidence.targetEntities) || evidence.targetEntities.some((entity) => typeof entity !== 'string')) return false;
  if (typeof evidence.proofStatement !== 'string' || evidence.proofStatement.length === 0) return false;
  return computeEvidenceId({
    schemaVersion: evidence.schemaVersion,
    queryKind: evidence.queryKind,
    claimKind: evidence.claimKind,
    queryHash: evidence.queryHash,
    backendId: evidence.backendId,
    backendVersion: evidence.backendVersion,
    solverStatus: evidence.solverStatus,
    verdict: evidence.verdict,
    targetEntities: evidence.targetEntities,
    proofAuthority: evidence.proofAuthority,
    capabilityFingerprint: evidence.capabilityFingerprint,
  }) === evidence.id;
}
