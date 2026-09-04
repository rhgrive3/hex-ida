/**
 * js/symbolic/verify/query.js
 *
 * Verification query schema, taxonomy, and factory for Hex Solver-backed Verification.
 * Provides deterministic hashing, explicit polarity, and structured targets.
 */

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

function identityChildren(value) {
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === 'symbol')) throw new TypeError('symbol-keyed-query-identity');
    let elementKeys = 0;
    for (const key of keys) {
      if (key === 'length') continue;
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) throw new TypeError('noncanonical-array-query-identity');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new TypeError('accessor-query-identity');
      elementKeys++;
    }
    if (elementKeys !== value.length) throw new TypeError('sparse-array-query-identity');
    return value;
  }
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('unsupported-query-identity-object');
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === 'symbol')) throw new TypeError('symbol-keyed-query-identity');
  return keys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) throw new TypeError('non-enumerable-query-identity');
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new TypeError('accessor-query-identity');
    return descriptor.value;
  });
}

function validateIdentityPrimitive(value) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return null;
  return 'unsupported-query-identity-value';
}

function validateBoundedIdentityValues(values, { maxIdentityNodes, maxIdentityEdges, maxIdentityDepth }) {
  const colors = new WeakMap();
  const heights = new WeakMap();
  let nodeCount = 0;
  let edgeCount = 0;
  let maximumDepth = 0;
  for (const root of values) {
    if (root == null || typeof root !== 'object') {
      const reason = validateIdentityPrimitive(root);
      if (reason) return { ok: false, reason };
      continue;
    }
    const stack = [{ value: root, entered: false, children: null, index: 0, childHeight: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (!frame.entered) {
        if (colors.get(frame.value) === 1) return { ok: false, reason: 'cyclic-query-identity' };
        if (colors.get(frame.value) === 2) { stack.pop(); continue; }
        if (stack.length > maxIdentityDepth) return { ok: false, reason: 'query-identity-depth-exceeded', limitExceeded: true };
        nodeCount++;
        if (nodeCount > maxIdentityNodes) return { ok: false, reason: 'query-identity-node-budget-exceeded', limitExceeded: true };
        colors.set(frame.value, 1);
        try { frame.children = identityChildren(frame.value); }
        catch (error) { return { ok: false, reason: error.message || 'malformed-query-identity' }; }
        frame.entered = true;
      }
      if (frame.index < frame.children.length) {
        edgeCount++;
        if (edgeCount > maxIdentityEdges) return { ok: false, reason: 'query-identity-edge-budget-exceeded', limitExceeded: true };
        const child = frame.children[frame.index++];
        if (child != null && typeof child === 'object') {
          if (colors.get(child) === 1) return { ok: false, reason: 'cyclic-query-identity' };
          if (colors.get(child) === 2) {
            const childHeight = heights.get(child) || 1;
            const combinedDepth = stack.length + childHeight;
            maximumDepth = Math.max(maximumDepth, combinedDepth);
            if (combinedDepth > maxIdentityDepth) return { ok: false, reason: 'query-identity-depth-exceeded', limitExceeded: true };
            frame.childHeight = Math.max(frame.childHeight, childHeight);
          } else {
            stack.push({ value: child, entered: false, children: null, index: 0, childHeight: 0 });
          }
        } else {
          const reason = validateIdentityPrimitive(child);
          if (reason) return { ok: false, reason };
        }
        continue;
      }
      const height = frame.childHeight + 1;
      heights.set(frame.value, height);
      maximumDepth = Math.max(maximumDepth, stack.length - 1 + height);
      if (stack.length - 1 + height > maxIdentityDepth) return { ok: false, reason: 'query-identity-depth-exceeded', limitExceeded: true };
      colors.set(frame.value, 2);
      stack.pop();
      if (stack.length > 0) stack[stack.length - 1].childHeight = Math.max(stack[stack.length - 1].childHeight, height);
    }
  }
  return { ok: true, nodeCount, edgeCount, maxDepth: maximumDepth };
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
  const seen = new WeakSet();
  const ordered = [];
  const stack = [...expressions];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    ordered.push(current);
    for (const child of Object.values(current)) stack.push(child);
  }
  for (let index = ordered.length - 1; index >= 0; index--) Object.freeze(ordered[index]);
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

function queryHashPayload(query, constraintHashes, assertionHash) {
  return {
    schemaVersion: QUERY_SCHEMA_VERSION,
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
    recomputedHash = stableDigest(queryHashPayload(query, constraintHashes, assertionHash));
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

  let normalizedConstraints = [];
  if (Array.isArray(constraints)) {
    normalizedConstraints = [...constraints].filter(Boolean);
  } else if (constraints) {
    normalizedConstraints = [constraints];
  }

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
