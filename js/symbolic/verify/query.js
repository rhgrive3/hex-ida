/**
 * js/symbolic/verify/query.js
 *
 * Verification query schema, taxonomy, and factory for Hex Solver-backed Verification.
 * Provides deterministic hashing, explicit polarity, and structured targets.
 */

import { ownDataEntries, inspectCanonicalData } from '../expr/data-boundary.js';
import { stableDigest } from '../../core/identity/index.js';
import { computeStructuralHashesBounded } from '../expr/hash.js';
import { createCompleteness } from '../translate/support-matrix.js';

export const VERIFICATION_QUERY_KIND = Object.freeze({
  CONDITIONAL_EDGE_FEASIBILITY: 'conditional_edge_feasibility',
  BOUNDED_EQUIVALENCE: 'bounded_equivalence',
  GLOBAL_EDGE_REACHABILITY: 'global_edge_reachability',
});

export const QUERY_SCHEMA_VERSION = '1.2.0';
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

const DEFAULT_QUERY_HASH_LIMITS = Object.freeze({
  maxExprNodes: 100000,
  maxIdentityNodes: 10000,
  maxIdentityEdges: 40000,
  maxIdentityDepth: 64,
});

function requirePositiveSafeInteger(value, name) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a primitive positive safe integer`);
  }
  return value;
}

function validateBoundedIdentityValues(values, { maxIdentityNodes, maxIdentityEdges, maxIdentityDepth }) {
  const result = inspectCanonicalData(values, { maxNodes: maxIdentityNodes, maxEdges: maxIdentityEdges,
    maxDepth: maxIdentityDepth, maxExpansion: maxIdentityEdges });
  if (!result.ok) {
    const compatibility = { 'noncanonical-data-prototype':'unsupported-query-identity-object',
      'data-depth-budget-exceeded':'query-identity-depth-exceeded', 'data-entry-budget-exceeded':'query-identity-edge-budget-exceeded',
      'accessor-data':'accessor-query-identity', 'symbol-keyed-data':'symbol-keyed-query-identity',
      'non-enumerable-data':'non-enumerable-query-identity', 'unsupported-data-value':'unsupported-query-identity-value' };
    return { ...result, reason: compatibility[result.reason] ?? result.reason.replaceAll('data', 'query-identity') };
  }
  const { objects, ...counts } = result;
  return counts;
}

function immutableIdentitySnapshot(value, memo = new WeakMap()) {
  if (value == null || typeof value !== 'object') return value;
  if (memo.has(value)) return memo.get(value);
  const output = Array.isArray(value) ? [] : Object.create(null);
  memo.set(value, output);
  if (Array.isArray(value)) {
    for (const child of value) output.push(immutableIdentitySnapshot(child, memo));
  } else {
    for (const key of Object.keys(value)) output[key] = immutableIdentitySnapshot(value[key], memo);
  }
  return Object.freeze(output);
}

function freezeExpressionDag(expressions) {
  // Only semantic fields participate in this query. Do not recurse through
  // ignored provenance metadata, accessors, or arbitrary caller-owned graphs.
  const seen = new WeakSet(), stack = [...expressions];
  while (stack.length) {
    const node = stack.pop();
    if (seen.has(node)) continue;
    seen.add(node);
    switch (node.kind) {
      case 'unary': case 'extract': case 'cast': stack.push(node.arg); break;
      case 'binary': case 'compare': case 'concat': stack.push(node.left, node.right); break;
      case 'ite': stack.push(node.cond, node.thenExpr, node.elseExpr); break;
      case 'connective': for (const child of node.args) stack.push(child); Object.freeze(node.args); break;
      case 'unknown_semantic': {
        const detail = inspectCanonicalData([node.detail], {maxNodes:4096, maxEdges:16384, maxExpansion:16384});
        if (!detail.ok) throw new TypeError(detail.reason);
        for (const object of detail.objects) Object.freeze(object);
        break;
      }
    }
    Object.freeze(node.sort); Object.freeze(node);
  }
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

function queryHashPayload(query, constraintHashes, assertionHash, symbolBindings) {
  return {
    schemaVersion: QUERY_SCHEMA_VERSION,
    symbolBindings,
    kind: query.kind,
    claimKind: query.claimKind,
    targetEntity: query.targetEntity ?? null,
    constraints: constraintHashes.map((hash) => ({ hash })),
    assertion: assertionHash ? { hash: assertionHash } : null,
    assumptions: query.assumptions,
    completeness: query.completeness,
    requestedOutputs: query.requestedOutputs,
    semanticIrVersion: query.semanticIrVersion,
    translatorVersion: query.translatorVersion,
    architecture: query.architecture,
    bitWidth: query.bitWidth,
    proofScope: query.proofScope ?? null,
  };
}

export function validateVerificationQuery(query, options = {}) {
  try { return validateVerificationQueryData(query, options); }
  catch (error) { return Object.freeze({ valid: false, reason: error.message || 'malformed-query-data' }); }
}

function validateVerificationQueryData(query, options = {}) {
  ownDataEntries(query, 64); ownDataEntries(options, 16);
  let limits;
  try {
    limits = {
      maxExprNodes: requirePositiveSafeInteger(Object.prototype.hasOwnProperty.call(options, 'maxExprNodes') ? options.maxExprNodes : DEFAULT_QUERY_HASH_LIMITS.maxExprNodes, 'maxExprNodes'),
      maxIdentityNodes: requirePositiveSafeInteger(Object.prototype.hasOwnProperty.call(options, 'maxIdentityNodes') ? options.maxIdentityNodes : DEFAULT_QUERY_HASH_LIMITS.maxIdentityNodes, 'maxIdentityNodes'),
      maxIdentityEdges: requirePositiveSafeInteger(Object.prototype.hasOwnProperty.call(options, 'maxIdentityEdges') ? options.maxIdentityEdges : Math.min(DEFAULT_QUERY_HASH_LIMITS.maxIdentityEdges, (Object.prototype.hasOwnProperty.call(options, 'maxIdentityNodes') ? options.maxIdentityNodes : DEFAULT_QUERY_HASH_LIMITS.maxIdentityNodes) * 4), 'maxIdentityEdges'),
      maxIdentityDepth: requirePositiveSafeInteger(Object.prototype.hasOwnProperty.call(options, 'maxIdentityDepth') ? options.maxIdentityDepth : DEFAULT_QUERY_HASH_LIMITS.maxIdentityDepth, 'maxIdentityDepth'),
    };
  } catch (error) {
    return Object.freeze({ valid: false, reason: error.message, invalidBudget: true });
  }
  if (!query || typeof query !== 'object' || query.schemaVersion !== QUERY_SCHEMA_VERSION ||
      !Object.values(VERIFICATION_QUERY_KIND).includes(query.kind) || !Object.values(CLAIM_KIND).includes(query.claimKind) ||
      !Array.isArray(query.constraints) || !Array.isArray(query.assumptions) || !Array.isArray(query.requestedOutputs) ||
      typeof query.semanticIrVersion !== 'string' || !query.semanticIrVersion.trim() ||
      typeof query.translatorVersion !== 'string' || !query.translatorVersion.trim() ||
      typeof query.architecture !== 'string' || !query.architecture.trim() ||
      !(query.bitWidth == null || (typeof query.bitWidth === 'number' && Number.isSafeInteger(query.bitWidth) && query.bitWidth > 0)) ||
      typeof query.queryHash !== 'string' || !query.queryHash.trim()) {
    return Object.freeze({ valid: false, reason: 'invalid-verification-query-shape' });
  }
  if (query.constraints.length + (query.assertion ? 1 : 0) > limits.maxExprNodes) {
    return Object.freeze({ valid: false, reason: 'expression-node-budget-exceeded', limitExceeded: true });
  }
  ownDataEntries(query.constraints, limits.maxExprNodes);
  const expressions = query.constraints.slice();
  if (query.assertion) expressions.push(query.assertion);
  const structural = computeStructuralHashesBounded(expressions, { maxNodes: limits.maxExprNodes });
  if (!structural.ok) return Object.freeze({ valid: false, reason: structural.reason, limitExceeded: structural.limitExceeded === true });
  const identities = validateBoundedIdentityValues([
    query.targetEntity,
    query.assumptions,
    query.completeness,
    query.requestedOutputs,
    query.proofScope,
  ], limits);
  if (!identities.ok) return Object.freeze({ valid: false, ...identities });
  let recomputedHash;
  try {
    const constraintHashes = structural.hashes.slice(0, query.constraints.length);
    const assertionHash = query.assertion ? structural.hashes[structural.hashes.length - 1] : null;
    recomputedHash = stableDigest(queryHashPayload(query, constraintHashes, assertionHash, structural.symbolBindings));
  } catch {
    return Object.freeze({ valid: false, reason: 'malformed-query-identity' });
  }
  if (recomputedHash !== query.queryHash) {
    return Object.freeze({ valid: false, reason: 'query-hash-content-mismatch', recomputedHash, nodeCount: structural.nodeCount });
  }
  return Object.freeze({ valid: true, recomputedHash, nodeCount: structural.nodeCount });
}

export function isVerificationQuery(query, options = {}) {
  return validateVerificationQuery(query, options).valid;
}

export function createVerificationQuery(input = {}) {
  ownDataEntries(input, 64);
  const {
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
  } = input;
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

  let normalizedConstraints = [];
  if (Array.isArray(constraints)) {
    ownDataEntries(constraints, DEFAULT_QUERY_HASH_LIMITS.maxExprNodes);
    normalizedConstraints = [...constraints];
  } else if (constraints) {
    normalizedConstraints = [constraints];
  }

  if (Array.isArray(assumptions)) ownDataEntries(assumptions, DEFAULT_QUERY_HASH_LIMITS.maxIdentityEdges);
  if (Array.isArray(requestedOutputs)) ownDataEntries(requestedOutputs, DEFAULT_QUERY_HASH_LIMITS.maxIdentityEdges);
  const normalizedAssumptions = Array.isArray(assumptions) ? [...assumptions] : [];
  const normalizedOutputs = Array.isArray(requestedOutputs) ? [...requestedOutputs] : [];
  const normalizedCompleteness = completeness || createCompleteness();
  const identities = validateBoundedIdentityValues([
    targetEntity,
    normalizedAssumptions,
    normalizedCompleteness,
    normalizedOutputs,
    proofScope,
  ], DEFAULT_QUERY_HASH_LIMITS);
  if (!identities.ok) throw new TypeError(`createVerificationQuery: ${identities.reason}`);
  const normalizedTargetEntity = immutableIdentitySnapshot(targetEntity);
  const normalizedAssumptionIdentity = immutableIdentitySnapshot(normalizedAssumptions);
  const normalizedCompletenessIdentity = immutableIdentitySnapshot(normalizedCompleteness);
  const normalizedOutputIdentity = immutableIdentitySnapshot(normalizedOutputs);
  const normalizedProofScope = immutableIdentitySnapshot(proofScope);
  const unhashedQuery = {
    schemaVersion: QUERY_SCHEMA_VERSION,
    kind,
    claimKind,
    targetEntity: normalizedTargetEntity,
    constraints: normalizedConstraints,
    assertion,
    assumptions: normalizedAssumptionIdentity,
    completeness: normalizedCompletenessIdentity,
    requestedOutputs: normalizedOutputIdentity,
    semanticIrVersion: normalizedSemanticIrVersion,
    translatorVersion: normalizedTranslatorVersion,
    architecture: normalizedArchitecture,
    bitWidth: normalizedBitWidth,
    proofScope: normalizedProofScope,
  };
  const expressions = [...normalizedConstraints, ...(assertion ? [assertion] : [])];
  const structural = computeStructuralHashesBounded(expressions, { maxNodes: DEFAULT_QUERY_HASH_LIMITS.maxExprNodes });
  if (!structural.ok) throw new TypeError(`createVerificationQuery: ${structural.reason}`);
  const queryHash = stableDigest(queryHashPayload(
    unhashedQuery,
    structural.hashes.slice(0, normalizedConstraints.length),
    assertion ? structural.hashes[structural.hashes.length - 1] : null,
    structural.symbolBindings,
  ));
  freezeExpressionDag(expressions);

  return Object.freeze({
    schemaVersion: QUERY_SCHEMA_VERSION,
    kind,
    claimKind,
    targetEntity: normalizedTargetEntity,
    constraints: Object.freeze(normalizedConstraints),
    assertion: assertion || null,
    assumptions: normalizedAssumptionIdentity,
    completeness: normalizedCompletenessIdentity,
    requestedOutputs: normalizedOutputIdentity,
    semanticIrVersion: normalizedSemanticIrVersion,
    translatorVersion: normalizedTranslatorVersion,
    architecture: normalizedArchitecture,
    bitWidth: normalizedBitWidth,
    proofScope: normalizedProofScope,
    queryHash,
  });
}
