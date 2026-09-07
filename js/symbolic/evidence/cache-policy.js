/**
 * js/symbolic/evidence/cache-policy.js
 *
 * Verifier fingerprinting and version-safe cache policy for Phase 9 symbolic proofs.
 * Binds queryKind, exprSchemaVersion, exprDagVersion, translatorVersion, backendId,
 * backendVersion, and solverOptions into a deterministic SHA-256 fingerprint.
 * Enforces fail-closed proof cacheability (only clean PROVED/REFUTED results with complete translation).
 * Provides proof tool cache options for ToolRegistry / ObservationStore.
 */

import { stableDigest } from '../../core/identity/index.js';
import { SOLVER_STATUS } from '../solver/result.js';
import { PROOF_AUTHORITY } from '../solver/backend.js';
import { EXPR_SCHEMA_VERSION, EXPR_DAG_VERSION } from '../expr/serialize.js';
import { COMPLETENESS_STATUS } from '../translate/support-matrix.js';

export const VERIFIER_FINGERPRINT_SCHEMA_VERSION = '1.1.0';

function sha256Hex(data) {
  return stableDigest(data);
}

function canonicalizeValue(val) {
  if (val === null || typeof val !== 'object') {
    if (typeof val === 'bigint') return `0x${val.toString(16)}`;
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(canonicalizeValue);
  }
  const sorted = {};
  for (const k of Object.keys(val).sort()) {
    sorted[k] = canonicalizeValue(val[k]);
  }
  return sorted;
}

export function computeVerifierFingerprint({
  queryKind,
  exprSchemaVersion = EXPR_SCHEMA_VERSION,
  exprDagVersion = EXPR_DAG_VERSION,
  translatorVersion = '1.0.0',
  semanticIrVersion = '2.0.0',
  backendId,
  backendVersion = '0.0.0',
  proofAuthority = PROOF_AUTHORITY.NONE,
  capabilityFingerprint = null,
  architecture = 'generic',
  bitWidth = null,
  assumptionsFingerprint = null,
  proofScope = null,
  solverOptions = null,
} = {}) {
  if (!queryKind || typeof queryKind !== 'string' || queryKind.trim() === '') {
    throw new TypeError('computeVerifierFingerprint: queryKind is required and must be a non-empty string');
  }
  if (!backendId || typeof backendId !== 'string' || backendId.trim() === '') {
    throw new TypeError('computeVerifierFingerprint: backendId is required and must be a non-empty string');
  }
  if (!exprSchemaVersion || typeof exprSchemaVersion !== 'string') {
    throw new TypeError('computeVerifierFingerprint: exprSchemaVersion is required and must be a string');
  }
  if (!exprDagVersion || typeof exprDagVersion !== 'string') {
    throw new TypeError('computeVerifierFingerprint: exprDagVersion is required and must be a string');
  }
  if (!translatorVersion || typeof translatorVersion !== 'string') {
    throw new TypeError('computeVerifierFingerprint: translatorVersion is required and must be a string');
  }
  if (!backendVersion || typeof backendVersion !== 'string') {
    throw new TypeError('computeVerifierFingerprint: backendVersion is required and must be a string');
  }
  if (!Object.values(PROOF_AUTHORITY).includes(proofAuthority)) {
    throw new TypeError(`computeVerifierFingerprint: invalid proofAuthority '${proofAuthority}'`);
  }
  if (proofAuthority === PROOF_AUTHORITY.EXACT && (!capabilityFingerprint || typeof capabilityFingerprint !== 'string')) {
    throw new TypeError('computeVerifierFingerprint: exact authority requires capabilityFingerprint');
  }
  if (typeof architecture !== 'string' || architecture.trim() === '') {
    throw new TypeError('computeVerifierFingerprint: architecture must be a non-empty string');
  }
  if (bitWidth != null && (!Number.isSafeInteger(bitWidth) || bitWidth <= 0)) {
    throw new TypeError('computeVerifierFingerprint: bitWidth must be a positive safe integer or null');
  }

  const payload = {
    backendId: String(backendId),
    backendVersion: String(backendVersion),
    exprDagVersion: String(exprDagVersion),
    exprSchemaVersion: String(exprSchemaVersion),
    semanticIrVersion: String(semanticIrVersion),
    queryKind: String(queryKind),
    proofAuthority: String(proofAuthority),
    capabilityFingerprint: capabilityFingerprint == null ? null : String(capabilityFingerprint),
    architecture: String(architecture),
    bitWidth: bitWidth == null ? null : bitWidth,
    assumptionsFingerprint: assumptionsFingerprint == null ? null : String(assumptionsFingerprint),
    proofScope: proofScope ? canonicalizeValue(proofScope) : null,
    solverOptions: solverOptions ? canonicalizeValue(solverOptions) : null,
    translatorVersion: String(translatorVersion),
  };

  const canonicalJson = JSON.stringify(canonicalizeValue(payload));
  return sha256Hex(canonicalJson);
}

export function isCacheableProof({
  verdict,
  solverStatus,
  completeness = null,
  hasUnresolvedUnknowns = false,
  preconditionStatus = null,
  validationStatus = null,
  proofAuthority = PROOF_AUTHORITY.NONE,
  capabilityFingerprint = null,
  backendId = null,
  backendVersion = null,
} = {}) {
  // 1. Only clean PROVED or REFUTED verdicts may be cached
  if (verdict !== 'proved' && verdict !== 'refuted') {
    return false;
  }

  if (proofAuthority !== PROOF_AUTHORITY.EXACT || !capabilityFingerprint || !backendId || !backendVersion) return false;

  // 2. Check solver status: must be clean SAT or UNSAT, not failure/timeout/cancelled/etc.
  if (
    !solverStatus ||
    solverStatus === SOLVER_STATUS.TIMEOUT ||
    solverStatus === SOLVER_STATUS.RESOURCE_LIMIT ||
    solverStatus === SOLVER_STATUS.UNSUPPORTED ||
    solverStatus === SOLVER_STATUS.CANCELLED ||
    solverStatus === SOLVER_STATUS.PROVIDER_FAILURE ||
    solverStatus === SOLVER_STATUS.INVALID_QUERY ||
    solverStatus === SOLVER_STATUS.UNKNOWN
  ) {
    return false;
  }

  // 3. Unresolved unknowns cannot produce cacheable proofs
  if (hasUnresolvedUnknowns === true) {
    return false;
  }

  // 4. Cacheable proofs require complete five-axis completeness. The proof
  // mint contract (createSymbolicEvidence) requires translation, controlFlow,
  // memoryEffects, pathCoverage, and queryScope to all be complete; the cache
  // gate must be at least as strong, and missing completeness fails closed.
  if (
    !completeness ||
    typeof completeness !== 'object' ||
    completeness.translation !== COMPLETENESS_STATUS.COMPLETE ||
    completeness.controlFlow !== COMPLETENESS_STATUS.COMPLETE ||
    completeness.memoryEffects !== COMPLETENESS_STATUS.COMPLETE ||
    completeness.pathCoverage !== COMPLETENESS_STATUS.COMPLETE ||
    completeness.queryScope !== COMPLETENESS_STATUS.COMPLETE
  ) {
    return false;
  }

  // 5. Inconsistent or unknown preconditions cannot produce cacheable proofs
  if (preconditionStatus === 'inconsistent' || preconditionStatus === 'unknown') {
    return false;
  }

  if (verdict === 'proved' && solverStatus !== SOLVER_STATUS.UNSAT) return false;
  if (verdict === 'refuted' && solverStatus !== SOLVER_STATUS.SAT) return false;

  // 6. Fail-closed validation gate for refuted verdicts. A REFUTED proof is
  // admitted to the cache only when its SAT counterexample was positively
  // validated; null/unvalidated/not-applicable/refuted/failed all reject.
  // This matches the REFUTED validation invariant shared with evidence
  // admission (createSymbolicEvidence / isRefutedEvidence) so a refutation
  // cannot enter the proof cache on an unverified solver witness.
  if (verdict === 'refuted' && validationStatus !== 'validated') {
    return false;
  }

  return true;
}

export function getProofToolCacheOptions(options = {}) {
  const verifierFingerprint = options?.verifierFingerprint ? String(options.verifierFingerprint) : null;
  return Object.freeze({
    storeResult: true,
    deterministic: false,
    verifierFingerprint,
  });
}

export function computeProofCacheKey({
  baseKey = 'proof',
  queryHash,
  verifierFingerprint,
  binaryIdentity = null,
  analysisRevision = null,
} = {}) {
  if (!queryHash || typeof queryHash !== 'string') {
    throw new TypeError('computeProofCacheKey: queryHash is required and must be a string');
  }
  if (!verifierFingerprint || typeof verifierFingerprint !== 'string') {
    throw new TypeError('computeProofCacheKey: verifierFingerprint is required and must be a string');
  }

  const parts = [
    String(baseKey),
    binaryIdentity ? String(binaryIdentity) : 'binary:unknown',
    analysisRevision ? String(analysisRevision) : 'analysis:0',
    String(verifierFingerprint),
    String(queryHash),
  ];
  return parts.join('::');
}
