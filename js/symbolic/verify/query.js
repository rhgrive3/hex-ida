/**
 * js/symbolic/verify/query.js
 *
 * Verification query schema, taxonomy, and factory for Hex Solver-backed Verification.
 * Provides deterministic hashing, explicit polarity, and structured targets.
 */

import { stableDigest } from '../../core/identity/index.js';
import { computeStructuralHash } from '../expr/hash.js';
import { createCompleteness } from '../translate/support-matrix.js';

export const VERIFICATION_QUERY_KIND = Object.freeze({
  CONDITIONAL_EDGE_FEASIBILITY: 'conditional_edge_feasibility',
  BOUNDED_EQUIVALENCE: 'bounded_equivalence',
  GLOBAL_EDGE_REACHABILITY: 'global_edge_reachability',
});

export const QUERY_SCHEMA_VERSION = '1.1.0';
export const SEMANTIC_IR_VERSION = '2.0.0';
export const TRANSLATOR_VERSION = '1.1.0';

export const CLAIM_KIND = Object.freeze({
  EDGE_INFEASIBLE: 'edge_infeasible',
  GLOBAL_EDGE_UNREACHABLE: 'global_edge_unreachable',
  EDGE_FEASIBLE: 'edge_feasible',
  EQUIVALENT: 'equivalent',
  DIFFERENT: 'different',
});

export const VERDICT = Object.freeze({
  PROVED: 'proved',
  REFUTED: 'refuted',
  UNKNOWN: 'unknown',
});

function freezeDeep(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeDeep(child, seen);
  return Object.freeze(value);
}

function requireIdentityString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`createVerificationQuery: ${name} must be a non-empty string`);
  }
  return value;
}

function normalizeBitWidth(value) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('createVerificationQuery: bitWidth must be a positive safe integer or null');
  }
  return value;
}

function normalizeTargetEntity(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('createVerificationQuery: targetEntity must be null, string, or plain object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('createVerificationQuery: targetEntity must be null, string, or plain object');
  }
  // Copy once so hash material and the returned record share the same
  // canonical target representation, including null-prototype records.
  const normalized = Object.create(null);
  for (const key of Object.keys(value)) normalized[key] = value[key];
  return normalized;
}

export function isVerificationQuery(query) {
  if (
    !query ||
    typeof query !== 'object' ||
    typeof query.kind !== 'string' ||
    typeof query.claimKind !== 'string' ||
    !Array.isArray(query.constraints) ||
    query.schemaVersion !== QUERY_SCHEMA_VERSION ||
    typeof query.queryHash !== 'string'
  ) {
    return false;
  }
  // The canonical factory rejects unknown kinds/claim kinds, so the validator
  // must reject them too; a producer/validator contract split would let forged
  // queries reach the exact solver backend and the proof eligibility gate
  // (#5643).
  if (!Object.values(VERIFICATION_QUERY_KIND).includes(query.kind)) return false;
  if (!Object.values(CLAIM_KIND).includes(query.claimKind)) return false;

  // queryHash is the content identity of the query: it must be exactly the
  // digest the factory would have computed for this shape. Accepting an
  // unverified string lets two queries with different constraints share one
  // identity. Non-query-shaped hash material simply hashes as-is, so this
  // cannot throw on adversarial input.
  try {
    const recomputed = stableDigest(buildHashPayload(query));
    return recomputed === query.queryHash;
  } catch {
    return false;
  }
}

function buildHashPayload(query) {
  return {
    schemaVersion: QUERY_SCHEMA_VERSION,
    kind: query.kind,
    claimKind: query.claimKind,
    targetEntity: query.targetEntity ?? null,
    constraints: (Array.isArray(query.constraints) ? query.constraints : []).map((c) => ({ hash: computeStructuralHash(c), expression: c })),
    assertion: query.assertion ? { hash: computeStructuralHash(query.assertion), expression: query.assertion } : null,
    assumptions: Array.isArray(query.assumptions) ? [...query.assumptions] : [],
    completeness: query.completeness || createCompleteness(),
    requestedOutputs: Array.isArray(query.requestedOutputs) ? [...query.requestedOutputs] : [],
    semanticIrVersion: query.semanticIrVersion,
    translatorVersion: query.translatorVersion,
    architecture: query.architecture,
    bitWidth: query.bitWidth ?? null,
    proofScope: query.proofScope || null,
  };
}

export function createVerificationQuery({
  kind,
  claimKind,
  targetEntity = null,
  constraints = [],
  assertion = null,
  assumptions = [],
  completeness = null,
  requestedOutputs = [],
  semanticIrVersion = SEMANTIC_IR_VERSION,
  translatorVersion = TRANSLATOR_VERSION,
  architecture = 'generic',
  bitWidth = null,
  proofScope = null,
}) {
  if (!Object.values(VERIFICATION_QUERY_KIND).includes(kind)) {
    throw new TypeError(`createVerificationQuery: invalid query kind '${kind}'`);
  }
  if (!Object.values(CLAIM_KIND).includes(claimKind)) {
    throw new TypeError(`createVerificationQuery: invalid claim kind '${claimKind}'`);
  }

  const normalizedSemanticIrVersion = requireIdentityString(semanticIrVersion, 'semanticIrVersion');
  const normalizedTranslatorVersion = requireIdentityString(translatorVersion, 'translatorVersion');
  const normalizedArchitecture = requireIdentityString(architecture, 'architecture');
  const normalizedBitWidth = normalizeBitWidth(bitWidth);
  const normalizedTargetEntity = normalizeTargetEntity(targetEntity);

  let normalizedConstraints = [];
  if (Array.isArray(constraints)) {
    normalizedConstraints = [...constraints].filter(Boolean);
  } else if (constraints) {
    normalizedConstraints = [constraints];
  }

  const normalizedAssumptions = Array.isArray(assumptions) ? [...assumptions] : [];
  const normalizedOutputs = Array.isArray(requestedOutputs) ? [...requestedOutputs] : [];
  const normalizedCompleteness = completeness || createCompleteness();
  freezeDeep(normalizedTargetEntity);
  freezeDeep(normalizedConstraints);
  freezeDeep(assertion);
  freezeDeep(normalizedAssumptions);
  freezeDeep(normalizedOutputs);
  freezeDeep(normalizedCompleteness);
  freezeDeep(proofScope);

  const record = {
    schemaVersion: QUERY_SCHEMA_VERSION,
    kind,
    claimKind,
    targetEntity: normalizedTargetEntity,
    constraints: Object.freeze(normalizedConstraints),
    assertion: assertion || null,
    assumptions: Object.freeze(normalizedAssumptions),
    completeness: normalizedCompleteness,
    requestedOutputs: Object.freeze(normalizedOutputs),
    semanticIrVersion: normalizedSemanticIrVersion,
    translatorVersion: normalizedTranslatorVersion,
    architecture: normalizedArchitecture,
    bitWidth: normalizedBitWidth,
    proofScope: proofScope || null,
  };

  // The record itself is the hash material: the validator recomputes the
  // digest from the exact same payload builder, so factory and validator
  // cannot drift apart (#5643).
  const queryHash = stableDigest(buildHashPayload(record));

  return Object.freeze({ ...record, queryHash });
}
