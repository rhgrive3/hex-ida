/**
 * js/symbolic/verify/query.js
 *
 * Verification query schema, taxonomy, and factory for Hex Solver-backed Verification.
 * Provides deterministic hashing, explicit polarity, and structured targets.
 */

import { stableDigest } from '../../core/identity/index.js';
import { computeStructuralHashesBounded } from '../expr/hash.js';
import { EXPR_KIND } from '../expr/kinds.js';
import { createCompleteness } from '../translate/completeness.js';

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

// Identity metadata and semantic expressions have separate bounded walkers.
// Metadata is canonical JSON data. Expressions are canonicalized by their
// solver-visible fields and use a larger iterative depth ceiling.
export const QUERY_METADATA_MAX_DEPTH = 512;
export const QUERY_METADATA_MAX_NODES = 65536;
const QUERY_IDENTITY_MAX_EDGES = 65536;
const QUERY_IDENTITY_MAX_SERIALIZED_UNITS = 100000;
const QUERY_EXPRESSION_HASH_MAX_NODES = 100000;
const QUERY_EXPRESSION_HASH_MAX_DEPTH = 32768;

function typeError(message) {
  return new TypeError(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function ownDescriptors(value, name) {
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    throw typeError(`${name}: unreadable or proxy-backed data`);
  }
}

function plainRecord(value) {
  if (!isObject(value) || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function recordDataEntries(value, name) {
  if (!plainRecord(value)) throw typeError(`${name}: expected a plain object`);
  const descriptors = ownDescriptors(value, name);
  const entries = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw typeError(`${name}: symbol keys are not canonical data`);
    const descriptor = descriptors[key];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw typeError(`${name}: accessor field '${key}' is not supported`);
    }
    if (!descriptor.enumerable) throw typeError(`${name}: non-enumerable field '${key}' is not canonical data`);
    entries.push([key, descriptor.value]);
  }
  entries.sort((left, right) => left[0].localeCompare(right[0]));
  return entries;
}

function recordDataMap(value, name) {
  return new Map(recordDataEntries(value, name));
}

function arrayDataValues(value, name) {
  if (!Array.isArray(value)) throw typeError(`${name}: expected a canonical array`);
  const descriptors = ownDescriptors(value, name);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value') ||
      !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
    throw typeError(`${name}: invalid array length`);
  }
  const length = lengthDescriptor.value;
  const values = new Array(length);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) {
      throw typeError(`${name}: symbol or non-index array data is not canonical`);
    }
    const descriptor = descriptors[key];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || !descriptor.enumerable) {
      throw typeError(`${name}: array accessors and hidden values are not supported`);
    }
    values[Number(key)] = descriptor.value;
  }
  for (let index = 0; index < length; index++) {
    if (!Object.prototype.hasOwnProperty.call(descriptors, String(index))) {
      throw typeError(`${name}: array holes are not canonical`);
    }
  }
  return values;
}

function identityEntries(value, name) {
  if (Array.isArray(value)) {
    const values = arrayDataValues(value, name);
    return values.map((entry, index) => [String(index), entry]);
  }
  return recordDataEntries(value, name);
}

function measureIdentityData(root, {
  name = 'query identity',
  maxNodes = QUERY_METADATA_MAX_NODES,
  maxDepth = QUERY_METADATA_MAX_DEPTH,
  maxEdges = QUERY_IDENTITY_MAX_EDGES,
  maxSerializedUnits = QUERY_IDENTITY_MAX_SERIALIZED_UNITS,
} = {}) {
  const uniqueNodes = new WeakSet();
  const active = new WeakSet();
  const descriptorCache = new WeakMap();
  const stack = [{ value: root, depth: 1, exit: false }];
  let nodes = 0;
  let edges = 0;
  let serializedUnits = 0;
  let serializedExceeded = false;

  const chargeText = (text) => {
    serializedUnits = Math.min(maxSerializedUnits + 1, serializedUnits + text.length);
    if (serializedUnits > maxSerializedUnits) serializedExceeded = true;
  };

  while (stack.length) {
    const frame = stack.pop();
    const { value, depth } = frame;
    if (frame.exit) {
      active.delete(value);
      continue;
    }
    if (depth > maxDepth) throw typeError(`${name}: depth budget exceeded`);
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'string') { chargeText(value); continue; }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw typeError(`${name}: non-finite numbers are not canonical`);
      chargeText(String(value));
      continue;
    }
    if (!isObject(value)) throw typeError(`${name}: unsupported-query-identity-object`);
    if (active.has(value)) throw typeError(`${name}: query identity cycle is not supported`);
    if (!uniqueNodes.has(value)) {
      uniqueNodes.add(value);
      nodes++;
      if (nodes > maxNodes) throw typeError(`${name}: node budget exceeded`);
    }
    active.add(value);
    let entries = descriptorCache.get(value);
    if (!entries) {
      entries = identityEntries(value, name);
      descriptorCache.set(value, entries);
    }
    stack.push({ value, depth, exit: true });
    for (let index = entries.length - 1; index >= 0; index--) {
      const [key, child] = entries[index];
      chargeText(key);
      // Count a newly discovered object before charging its incoming edge.
      // A wide tree that exceeds both ceilings should report the node limit;
      // repeated/shared edges still reach the independent edge limit.
      if (isObject(child) && !uniqueNodes.has(child)) {
        uniqueNodes.add(child);
        nodes++;
        if (nodes > maxNodes) throw typeError(`${name}: node budget exceeded`);
      }
      edges++;
      if (edges > maxEdges) throw typeError(`${name}: edge budget exceeded`);
      stack.push({ value: child, depth: depth + 1, exit: false });
    }
  }
  if (serializedExceeded) throw typeError(`${name}: serialized-work budget exceeded`);
  return Object.freeze({ nodes, edges, serializedUnits });
}

function cloneIdentityData(value, copies = new WeakMap(), name = 'query identity') {
  if (!isObject(value)) return value;
  const prior = copies.get(value);
  if (prior) return prior;
  const entries = identityEntries(value, name);
  const clone = Array.isArray(value)
    ? new Array(entries.length)
    : Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype);
  copies.set(value, clone);
  for (const [key, child] of entries) {
    if (Array.isArray(clone)) clone[Number(key)] = cloneIdentityData(child, copies, name);
    else Object.defineProperty(clone, key, {
      value: cloneIdentityData(child, copies, name),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return clone;
}

function deepFreezeData(root) {
  if (!isObject(root)) return root;
  const visited = new WeakSet();
  const stack = [{ value: root, exit: false }];
  while (stack.length) {
    const frame = stack.pop();
    if (frame.exit) {
      Object.freeze(frame.value);
      continue;
    }
    if (!isObject(frame.value) || visited.has(frame.value)) continue;
    visited.add(frame.value);
    stack.push({ value: frame.value, exit: true });
    const entries = identityEntries(frame.value, 'normalized query identity');
    for (let index = entries.length - 1; index >= 0; index--) {
      const child = entries[index][1];
      if (isObject(child) && !visited.has(child)) stack.push({ value: child, exit: false });
    }
  }
  return root;
}

function snapshotIdentityData(value, name = 'query identity', limits = {}) {
  measureIdentityData(value, { name, ...limits });
  return deepFreezeData(cloneIdentityData(value, new WeakMap(), name));
}

function normalizeTargetEntity(value, limits = {}) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (!plainRecord(value)) throw typeError('unsupported-query-identity-object: targetEntity must be null, string, or plain object');
  return snapshotIdentityData(value, 'targetEntity', limits);
}

function readExpressionField(descriptors, key, { required = false, fallback = undefined } = {}) {
  const descriptor = descriptors[key];
  if (!descriptor) {
    if (required) throw typeError(`query expression field '${key}' is missing`);
    return fallback;
  }
  if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    throw typeError(`query expression ${key === 'detail' ? 'detail ' : ''}accessor '${key}' is not supported`);
  }
  return descriptor.value;
}

function snapshotExpressionSort(value) {
  if (!plainRecord(value)) throw typeError('query expression sort must be a plain data object');
  const descriptors = ownDescriptors(value, 'query expression sort');
  const kind = readExpressionField(descriptors, 'kind', { required: true });
  const width = readExpressionField(descriptors, 'width', { fallback: undefined });
  if (typeof kind !== 'string' || (width !== undefined && (!Number.isSafeInteger(width) || width <= 0))) {
    throw typeError('query expression sort is malformed');
  }
  const sort = width === undefined ? { kind } : { kind, width };
  return Object.freeze(sort);
}

function expressionPlan(source) {
  if (!plainRecord(source)) throw typeError('query expression node must be a plain object');
  const descriptors = ownDescriptors(source, 'query expression');
  const kind = readExpressionField(descriptors, 'kind', { required: true });
  const sort = snapshotExpressionSort(readExpressionField(descriptors, 'sort', { required: true }));
  if (typeof kind !== 'string') throw typeError('query expression kind must be a primitive string');
  const fields = [['kind', kind], ['sort', sort]];
  const children = [];
  const scalar = (key, required = false, fallback = undefined) => {
    const value = readExpressionField(descriptors, key, { required, fallback });
    fields.push([key, value]);
  };
  const child = (key) => {
    const value = readExpressionField(descriptors, key, { required: true });
    if (!isObject(value) || Array.isArray(value)) throw typeError(`query expression child '${key}' is malformed`);
    children.push({ key, source: value });
  };
  switch (kind) {
    case EXPR_KIND.CONST:
      scalar('value', true);
      break;
    case EXPR_KIND.FRESH_SYMBOL:
      scalar('name', true);
      if (descriptors.symbolId) scalar('symbolId');
      break;
    case EXPR_KIND.UNKNOWN_SEMANTIC: {
      scalar('reason', false, null);
      const detail = readExpressionField(descriptors, 'detail', { fallback: null });
      let safeDetail;
      try { safeDetail = snapshotIdentityData(detail, 'query expression detail'); }
      catch (error) { throw typeError(`query expression detail is unsafe: ${error.message}`); }
      fields.push(['detail', safeDetail]);
      break;
    }
    case EXPR_KIND.UNARY:
      scalar('op', true); child('arg');
      break;
    case EXPR_KIND.BINARY:
    case EXPR_KIND.COMPARE:
      scalar('op', true); child('left'); child('right');
      break;
    case EXPR_KIND.CONNECTIVE: {
      scalar('op', true);
      const args = arrayDataValues(readExpressionField(descriptors, 'args', { required: true }), 'query expression args');
      if (args.some((entry) => !isObject(entry) || Array.isArray(entry))) throw typeError('query expression args contain a malformed child');
      children.push(...args.map((entry, index) => ({ key: `args:${index}`, source: entry })));
      fields.push(['args', new Array(args.length)]);
      break;
    }
    case EXPR_KIND.ITE:
      child('cond'); child('thenExpr'); child('elseExpr');
      break;
    case EXPR_KIND.EXTRACT:
      scalar('high', true); scalar('low', true); child('arg');
      break;
    case EXPR_KIND.CONCAT:
      child('left'); child('right');
      break;
    case EXPR_KIND.CAST:
      scalar('op', true); scalar('targetWidth', true); child('arg');
      break;
    default:
      // Unknown semantics remain explicit and will be refused by the solver.
      break;
  }
  return { fields, children };
}

function cloneExpression(root) {
  if (root == null) return null;
  if (!isObject(root) || Array.isArray(root)) throw typeError('query assertion must be an expression node or null');
  const copies = new WeakMap();
  const plans = new WeakMap();
  const colors = new WeakMap();
  const stack = [{ source: root, exit: false, depth: 1 }];
  let nodes = 0;
  while (stack.length) {
    const frame = stack.pop();
    const { source, depth } = frame;
    if (frame.exit) {
      const target = copies.get(source);
      const plan = plans.get(source);
      for (const item of plan.children) {
        const childCopy = copies.get(item.source);
        if (!childCopy) throw typeError('query expression child snapshot is incomplete');
        if (item.key.startsWith('args:')) target.args[Number(item.key.slice(5))] = childCopy;
        else target[item.key] = childCopy;
      }
      if (Array.isArray(target.args)) Object.freeze(target.args);
      Object.freeze(target);
      colors.set(source, 2);
      continue;
    }
    if (depth > QUERY_EXPRESSION_HASH_MAX_DEPTH) throw typeError('query expression depth budget exceeded');
    if (colors.get(source) === 1) throw typeError('cyclic query expression');
    if (colors.get(source) === 2) continue;
    nodes++;
    if (nodes > QUERY_EXPRESSION_HASH_MAX_NODES) throw typeError('query expression node budget exceeded');
    const plan = expressionPlan(source);
    const target = {};
    copies.set(source, target);
    plans.set(source, plan);
    colors.set(source, 1);
    for (const [key, value] of plan.fields) target[key] = value;
    stack.push({ source, exit: true, depth });
    for (let index = plan.children.length - 1; index >= 0; index--) {
      const child = plan.children[index].source;
      if (colors.get(child) === 1) throw typeError('cyclic query expression');
      if (colors.get(child) !== 2) stack.push({ source: child, exit: false, depth: depth + 1 });
    }
  }
  return copies.get(root);
}

function expressionChildren(node) {
  switch (node.kind) {
    case EXPR_KIND.UNARY:
    case EXPR_KIND.EXTRACT:
    case EXPR_KIND.CAST: return [node.arg];
    case EXPR_KIND.BINARY:
    case EXPR_KIND.COMPARE:
    case EXPR_KIND.CONCAT: return [node.left, node.right];
    case EXPR_KIND.CONNECTIVE: return node.args;
    case EXPR_KIND.ITE: return [node.cond, node.thenExpr, node.elseExpr];
    default: return [];
  }
}

function expressionBounds(roots, maxNodes, maxDepth) {
  const colors = new WeakMap();
  const heights = new WeakMap();
  let uniqueNodes = 0;
  let expandedNodes = 0;
  let longestDepth = 0;
  for (const root of roots) {
    expandedNodes++;
    if (expandedNodes > maxNodes) return { ok: false, reason: 'expression-node-budget-exceeded', limitExceeded: true, nodeCount: uniqueNodes, maxDepth: longestDepth };
    if (colors.get(root) === 2) {
      longestDepth = Math.max(longestDepth, heights.get(root));
      continue;
    }
    const stack = [{ node: root, exit: false }];
    while (stack.length) {
      const frame = stack.pop();
      if (frame.exit) {
        let childHeight = 0;
        for (const child of expressionChildren(frame.node)) childHeight = Math.max(childHeight, heights.get(child) || 0);
        const height = childHeight + 1;
        heights.set(frame.node, height);
        colors.set(frame.node, 2);
        longestDepth = Math.max(longestDepth, height);
        if (height > maxDepth) return { ok: false, reason: 'expression-depth-budget-exceeded', limitExceeded: true, nodeCount: uniqueNodes, maxDepth: height };
        continue;
      }
      if (colors.get(frame.node) === 1) return { ok: false, reason: 'cyclic-expression-dag', nodeCount: uniqueNodes, maxDepth: longestDepth };
      if (colors.get(frame.node) === 2) continue;
      colors.set(frame.node, 1);
      uniqueNodes++;
      if (uniqueNodes > maxNodes) return { ok: false, reason: 'expression-node-budget-exceeded', limitExceeded: true, nodeCount: uniqueNodes, maxDepth: longestDepth };
      stack.push({ node: frame.node, exit: true });
      const children = expressionChildren(frame.node);
      for (let index = children.length - 1; index >= 0; index--) {
        const child = children[index];
        expandedNodes++;
        if (expandedNodes > maxNodes) return { ok: false, reason: 'expression-node-budget-exceeded', limitExceeded: true, nodeCount: uniqueNodes, maxDepth: longestDepth };
        if (colors.get(child) === 1) return { ok: false, reason: 'cyclic-expression-dag', nodeCount: uniqueNodes, maxDepth: longestDepth };
        if (colors.get(child) !== 2) stack.push({ node: child, exit: false });
      }
    }
  }
  return { ok: true, nodeCount: uniqueNodes, maxDepth: longestDepth };
}

// A constraint/assertion entry is either
//   (a) a canonical expression node, identified by its string `kind`
//       discriminator. It is strictly cloned (accessors, hidden fields, cyclic
//       DAGs and malformed child fields are refused before any structural
//       hashing), or
//   (b) an opaque payload without an expression discriminator (for example the
//       legacy `{ id, expression }` constraint descriptors). Opaque payloads
//       carry module-unknown semantics, so they are never guessed at: they are
//       snapshotted under the shared metadata budget and bound into the query
//       identity by their canonical content, which is why two different
//       payloads can never share one identity (#5643).
// Unknown shapes (null, arrays, primitives, unreadable or non-plain objects)
// still fail closed.
function expressionKindDeclared(value) {
  if (!plainRecord(value)) return false;
  const descriptor = ownDescriptors(value, 'query expression').kind;
  return !!descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') && typeof descriptor.value === 'string';
}

function normalizeExpressionEntry(value, name) {
  if (expressionKindDeclared(value)) return cloneExpression(value);
  if (!isObject(value) || Array.isArray(value)) {
    throw typeError(`${name} must be an expression node or an opaque payload object`);
  }
  return snapshotIdentityData(value, `${name} metadata`);
}

function normalizeExpressionArray(value, name) {
  if (value == null || value === false) return [];
  const inputs = Array.isArray(value) ? arrayDataValues(value, name) : [value];
  if (inputs.some((entry) => !isObject(entry) || Array.isArray(entry))) throw typeError(`${name}: every constraint must be an expression`);
  return inputs.map((entry) => normalizeExpressionEntry(entry, name));
}

function preflightMalformedExpressionMetadata(value, name) {
  const candidates = Array.isArray(value) ? arrayDataValues(value, name)
    : value == null || value === false ? [] : [value];
  for (const candidate of candidates) {
    if (!plainRecord(candidate)) continue;
    const descriptors = ownDescriptors(candidate, name);
    const kind = descriptors.kind;
    if (!kind || !Object.prototype.hasOwnProperty.call(kind, 'value') || typeof kind.value !== 'string') {
      // Legacy callers may provide deeply nested metadata where an expression
      // is required. Apply the shared metadata limits first so malformed deep
      // input fails with its bounded-domain reason without relaxing the
      // canonical expression shape checks.
      measureIdentityData(candidate, { name: `${name} metadata` });
    }
  }
}

function requireIdentityString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw typeError(`createVerificationQuery: ${name} must be a non-empty string`);
  }
  return value;
}

function normalizeBitWidth(value) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw typeError('createVerificationQuery: bitWidth must be a positive safe integer or null');
  }
  return value;
}

function expressionHashes(constraints, assertion, maxNodes = QUERY_EXPRESSION_HASH_MAX_NODES) {
  const roots = [...constraints, ...(assertion ? [assertion] : [])];
  if (!roots.length) return { constraints: [], assertion: null };
  const result = computeStructuralHashesBounded(roots, { maxNodes });
  if (!result.ok) throw typeError(`unhashable-query-expression:${result.reason}`);
  return {
    constraints: result.hashes.slice(0, constraints.length),
    assertion: assertion ? result.hashes[result.hashes.length - 1] : null,
  };
}

function metadataLimits(options = {}) {
  const values = recordDataMap(options, 'query validation options');
  const maxIdentityNodes = values.has('maxIdentityNodes') ? values.get('maxIdentityNodes') : QUERY_METADATA_MAX_NODES;
  const maxIdentityDepth = values.has('maxIdentityDepth') ? values.get('maxIdentityDepth') : QUERY_METADATA_MAX_DEPTH;
  const maxIdentityEdges = values.has('maxIdentityNodes') ? maxIdentityNodes : QUERY_IDENTITY_MAX_EDGES;
  const maxIdentitySerializedUnits = values.has('maxIdentitySerializedUnits') ? values.get('maxIdentitySerializedUnits') : QUERY_IDENTITY_MAX_SERIALIZED_UNITS;
  for (const [name, value] of Object.entries({ maxIdentityNodes, maxIdentityDepth, maxIdentityEdges, maxIdentitySerializedUnits })) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw typeError(`invalid ${name}`);
  }
  return { maxNodes: maxIdentityNodes, maxDepth: maxIdentityDepth, maxEdges: maxIdentityEdges, maxSerializedUnits: maxIdentitySerializedUnits };
}

function queryDataMap(query, name = 'verification query') {
  return recordDataMap(query, name);
}

function canonicalQueryHashPayload(query, identityLimits = {}) {
  const data = query instanceof Map ? query : queryDataMap(query);
  const constraints = normalizeExpressionArray(data.get('constraints'), 'constraints');
  const assertionInput = data.get('assertion') ?? null;
  const assertion = assertionInput == null ? null : normalizeExpressionEntry(assertionInput, 'assertion');
  const normalizedTargetEntity = normalizeTargetEntity(data.get('targetEntity') ?? null, identityLimits);
  const assumptions = snapshotIdentityData(data.get('assumptions') ?? [], 'assumptions', identityLimits);
  const completeness = snapshotIdentityData(data.get('completeness') ?? createCompleteness(), 'completeness', identityLimits);
  const requestedOutputs = snapshotIdentityData(data.get('requestedOutputs') ?? [], 'requestedOutputs', identityLimits);
  const proofScope = snapshotIdentityData(data.get('proofScope') ?? null, 'proofScope', identityLimits);
  const semanticIrVersion = requireIdentityString(data.get('semanticIrVersion') ?? SEMANTIC_IR_VERSION, 'semanticIrVersion');
  const translatorVersion = requireIdentityString(data.get('translatorVersion') ?? TRANSLATOR_VERSION, 'translatorVersion');
  const architecture = requireIdentityString(data.get('architecture') ?? 'generic', 'architecture');
  const bitWidth = normalizeBitWidth(data.get('bitWidth') ?? null);
  const hashes = expressionHashes(constraints, assertion);
  return {
    schemaVersion: QUERY_SCHEMA_VERSION,
    kind: data.get('kind'),
    claimKind: data.get('claimKind'),
    targetEntity: normalizedTargetEntity,
    // The published record and its hash material share one constraint
    // representation (#5779): every entry carries the exact frozen
    // expression/opaque payload the record returns next to its structural hash.
    constraints: constraints.map((entry, index) => ({ hash: hashes.constraints[index], expression: entry })),
    assertion: assertion ? { hash: hashes.assertion, expression: assertion } : null,
    assumptions,
    completeness,
    requestedOutputs,
    semanticIrVersion,
    translatorVersion,
    architecture,
    bitWidth,
    proofScope,
  };
}

export function computeCanonicalQueryHash(query) {
  return stableDigest(canonicalQueryHashPayload(query));
}

export function verifyVerificationQueryIdentity(query) {
  if (!query || typeof query !== 'object') return 'not-an-object';
  let data;
  try { data = queryDataMap(query); } catch { return 'unhashable-query-content'; }
  if (typeof data.get('kind') !== 'string' || !Object.values(VERIFICATION_QUERY_KIND).includes(data.get('kind'))) return 'unknown-query-kind';
  if (typeof data.get('claimKind') !== 'string' || !Object.values(CLAIM_KIND).includes(data.get('claimKind'))) return 'unknown-claim-kind';
  if (!Array.isArray(data.get('constraints'))) return 'constraints-not-array';
  if (data.get('schemaVersion') !== QUERY_SCHEMA_VERSION) return 'schema-version-mismatch';
  if (typeof data.get('queryHash') !== 'string' || data.get('queryHash').length === 0) return 'missing-query-hash';
  let canonical;
  try { canonical = stableDigest(canonicalQueryHashPayload(data)); }
  catch { return 'unhashable-query-content'; }
  if (canonical !== data.get('queryHash')) return 'query-hash-identity-mismatch';
  return null;
}

function identityShapeIsValid(value) {
  if (value == null || typeof value === 'string') return true;
  return plainRecord(value);
}

export function validateVerificationQuery(query, options = {}) {
  let limits;
  let optionData;
  let data;
  try {
    optionData = recordDataMap(options, 'query validation options');
    limits = metadataLimits(options);
    data = queryDataMap(query);
  } catch {
    return Object.freeze({ valid: false, reason: 'invalid-verification-query-shape' });
  }
  const maxExprNodes = optionData.has('maxExprNodes') ? optionData.get('maxExprNodes') : 100000;
  const maxExprDepth = optionData.has('maxExprDepth') ? optionData.get('maxExprDepth') : 1024;
  if (typeof maxExprNodes !== 'number' || !Number.isSafeInteger(maxExprNodes) || maxExprNodes <= 0 ||
      typeof maxExprDepth !== 'number' || !Number.isSafeInteger(maxExprDepth) || maxExprDepth <= 0) {
    return Object.freeze({ valid: false, reason: 'invalid-query-validation-budget', invalidBudget: true });
  }
  if (!Object.values(VERIFICATION_QUERY_KIND).includes(data.get('kind')) ||
      !Object.values(CLAIM_KIND).includes(data.get('claimKind')) ||
      data.get('schemaVersion') !== QUERY_SCHEMA_VERSION ||
      !Array.isArray(data.get('constraints')) || !identityShapeIsValid(data.get('targetEntity') ?? null) ||
      typeof data.get('semanticIrVersion') !== 'string' || data.get('semanticIrVersion').trim().length === 0 ||
      typeof data.get('translatorVersion') !== 'string' || data.get('translatorVersion').trim().length === 0 ||
      typeof data.get('architecture') !== 'string' || data.get('architecture').trim().length === 0 ||
      !Array.isArray(data.get('assumptions')) || !Array.isArray(data.get('requestedOutputs')) ||
      (data.get('assertion') != null && (!isObject(data.get('assertion')) || Array.isArray(data.get('assertion'))))) {
    return Object.freeze({ valid: false, reason: 'invalid-verification-query-shape' });
  }
  let identityMetrics;
  try {
    const identityValues = [
      ['targetEntity', data.get('targetEntity') ?? null],
      ['proofScope', data.get('proofScope') ?? null],
      ['assumptions', data.get('assumptions')],
      ['completeness', data.get('completeness') ?? createCompleteness()],
      ['requestedOutputs', data.get('requestedOutputs')],
    ];
    identityMetrics = { nodes: 0, edges: 0, serializedUnits: 0 };
    for (const [name, value] of identityValues) {
      const measured = measureIdentityData(value, { name, ...limits });
      identityMetrics.nodes += measured.nodes;
      identityMetrics.edges += measured.edges;
      identityMetrics.serializedUnits += measured.serializedUnits;
      if (identityMetrics.nodes > limits.maxNodes) throw typeError('query identity node budget exceeded');
      if (identityMetrics.edges > limits.maxEdges) throw typeError('query identity edge budget exceeded');
      if (identityMetrics.serializedUnits > limits.maxSerializedUnits) throw typeError('query identity serialized-work budget exceeded');
    }
  } catch (error) {
    const message = String(error?.message || 'query-identity-invalid');
    const reason = message.replace(/^.*?: /, '');
    const limitExceeded = /budget exceeded/.test(String(error?.message || ''));
    const normalizedReason = /depth budget exceeded/.test(message) ? 'query-identity-depth-exceeded'
      : reason.startsWith('query identity') ? reason.replaceAll(' ', '-')
        : `query-identity-${reason.replaceAll(' ', '-')}`;
    return Object.freeze({ valid: false, reason: normalizedReason, limitExceeded });
  }
  let constraints;
  try { constraints = arrayDataValues(data.get('constraints'), 'constraints'); }
  catch { return Object.freeze({ valid: false, reason: 'invalid-verification-query-shape' }); }
  if (constraints.some((expression) => !isObject(expression) || Array.isArray(expression))) {
    return Object.freeze({ valid: false, reason: 'invalid-verification-query-shape' });
  }
  const assertion = data.get('assertion') ?? null;
  let safeConstraints, safeAssertion;
  try {
    safeConstraints = constraints.map((expression) => normalizeExpressionEntry(expression, 'constraints'));
    safeAssertion = assertion ? normalizeExpressionEntry(assertion, 'assertion') : null;
  } catch {
    return Object.freeze({ valid: false, reason: 'invalid-verification-query-shape' });
  }
  const roots = [...safeConstraints, ...(safeAssertion ? [safeAssertion] : [])];
  const bounds = expressionBounds(roots, maxExprNodes, maxExprDepth);
  if (!bounds.ok) return Object.freeze({ valid: false, reason: bounds.reason, limitExceeded: bounds.limitExceeded === true });
  let reason;
  try { reason = verifyVerificationQueryIdentity(query); } catch { reason = 'unhashable-query-content'; }
  if (reason) return Object.freeze({ valid: false,
    reason: reason === 'query-hash-identity-mismatch' ? 'query-hash-content-mismatch' : reason });
  return Object.freeze({ valid: true, nodeCount: bounds.nodeCount, maxDepth: bounds.maxDepth,
    identity: identityMetrics, recomputedHash: data.get('queryHash') });
}

export function isVerificationQuery(query) {
  return verifyVerificationQueryIdentity(query) === null;
}

export function createVerificationQuery(input = {}) {
  const data = recordDataMap(input, 'createVerificationQuery request');
  const get = (key, fallback = undefined) => data.has(key) ? data.get(key) : fallback;
  const kind = get('kind');
  const claimKind = get('claimKind');
  if (!Object.values(VERIFICATION_QUERY_KIND).includes(kind)) {
    throw typeError(`createVerificationQuery: invalid query kind '${kind}'`);
  }
  if (!Object.values(CLAIM_KIND).includes(claimKind)) {
    throw typeError(`createVerificationQuery: invalid claim kind '${claimKind}'`);
  }
  const semanticIrVersion = requireIdentityString(get('semanticIrVersion', SEMANTIC_IR_VERSION) ?? SEMANTIC_IR_VERSION, 'semanticIrVersion');
  const translatorVersion = requireIdentityString(get('translatorVersion', TRANSLATOR_VERSION) ?? TRANSLATOR_VERSION, 'translatorVersion');
  const architecture = requireIdentityString(get('architecture', 'generic') ?? 'generic', 'architecture');
  const bitWidth = normalizeBitWidth(get('bitWidth', null) ?? null);
  const normalizedTargetEntity = normalizeTargetEntity(get('targetEntity', null) ?? null);
  const constraintsInput = get('constraints', []);
  preflightMalformedExpressionMetadata(constraintsInput, 'constraints');
  const constraints = normalizeExpressionArray(constraintsInput, 'constraints');
  const assertionInput = get('assertion', null);
  preflightMalformedExpressionMetadata(assertionInput, 'assertion');
  const assertion = assertionInput == null ? null : normalizeExpressionEntry(assertionInput, 'assertion');
  const assumptionsInput = get('assumptions', []);
  const requestedOutputsInput = get('requestedOutputs', []);
  const assumptions = snapshotIdentityData(Array.isArray(assumptionsInput) ? assumptionsInput : [], 'assumptions');
  const completeness = snapshotIdentityData(get('completeness', null) ?? createCompleteness(), 'completeness');
  const requestedOutputs = snapshotIdentityData(Array.isArray(requestedOutputsInput) ? requestedOutputsInput : [], 'requestedOutputs');
  const proofScope = snapshotIdentityData(get('proofScope', null) ?? null, 'proofScope');
  const roots = [...constraints, ...(assertion ? [assertion] : [])];
  const bounds = expressionBounds(roots, QUERY_EXPRESSION_HASH_MAX_NODES, QUERY_EXPRESSION_HASH_MAX_DEPTH);
  if (!bounds.ok) throw typeError(`createVerificationQuery: ${bounds.reason}`);
  const record = {
    schemaVersion: QUERY_SCHEMA_VERSION,
    kind,
    claimKind,
    targetEntity: normalizedTargetEntity,
    constraints: Object.freeze(constraints),
    assertion,
    assumptions,
    completeness,
    requestedOutputs,
    semanticIrVersion,
    translatorVersion,
    architecture,
    bitWidth,
    proofScope,
  };
  const queryHash = computeCanonicalQueryHash(record);
  return Object.freeze({ ...record, queryHash });
}
