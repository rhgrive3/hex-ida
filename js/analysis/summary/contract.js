/**
 * Hardening boundary for the Phase 7 FunctionSummary wire contract.
 * The implementation below delegates canonical construction to the existing
 * core, then applies the stricter serialized-envelope rules added by
 * #4314/#4320/#4695 without weakening any upstream checks.
 */
import { deepFreeze } from '../../core/identity/index.js';
import { isCompleteStatus } from '../status.js';
import * as core from './contract-core.js';
import { canonicalReturnEquations } from './return-equations.js';

export * from './contract-core.js';

// Single contract-version source of truth: the core canonical constructor owns
// the version identity (the #5242 root/allocation `addressSpace` requirement
// bumped it to 1.3.0). Redeclaring a stale constant here re-stamped core-built
// summaries with an older wire version while identity validation compared
// against the same stale value — version-keyed cache/consumer layers could not
// distinguish the incompatible envelope from a legacy 1.2 summary.
export const FUNCTION_SUMMARY_CONTRACT_VERSION = core.FUNCTION_SUMMARY_CONTRACT_VERSION;
const CANONICAL_SUMMARIES = new WeakSet();
const RETURN_PROVENANCE_FIELDS = new Set([
  'kind', 'argIndex', 'returnIndex', 'offset', 'rootEntityId', 'allocationSiteId',
  'addressSpace',
]);
const RETURN_PROVENANCE_KINDS = new Set(['arg', 'root', 'allocation', 'unknown']);

function plainRecord(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(code);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new TypeError(code);
  return value;
}
function denseArray(value, code) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError(code);
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) throw new TypeError(code);
  return value;
}
function nonEmptyString(value, code) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(code);
  return value.trim();
}
function optionalBoolean(value, code) {
  if (value == null) return false;
  if (typeof value !== 'boolean') throw new TypeError(code);
  return value;
}
function optionalIndex(value, code) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError(code);
  return value;
}
function optionalInteger(value, code) {
  if (value == null) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^(?:[+-]?[0-9]+|0[xX][0-9a-fA-F]+)$/.test(value.trim())) return BigInt(value.trim());
  throw new TypeError(code);
}
function strictProvenanceOffset(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    try { return BigInt(text); } catch { return null; }
  }
  return null;
}
function sameCanonicalValue(raw, canonical) {
  if (raw === canonical) return true;
  if (!raw || !canonical || typeof raw !== 'object' || typeof canonical !== 'object') return false;
  if (Array.isArray(raw) !== Array.isArray(canonical)) return false;
  if (Array.isArray(raw)) {
    if (raw.length !== canonical.length) return false;
    for (let i = 0; i < raw.length; i++) if (!Object.hasOwn(raw, i) || !sameCanonicalValue(raw[i], canonical[i])) return false;
    return true;
  }
  try { plainRecord(raw, 'function-summary-invalid-record'); } catch { return false; }
  const keys = Object.keys(canonical);
  return Object.keys(raw).length === keys.length
    && keys.every((key) => Object.hasOwn(raw, key) && sameCanonicalValue(raw[key], canonical[key]));
}
function validateStringList(values, code) {
  return denseArray(values, code).map((value) => nonEmptyString(value, code));
}
function validateReturnProvenance(value) {
  plainRecord(value, 'function-summary-invalid-return-provenance');
  if (Object.keys(value).some((key) => !RETURN_PROVENANCE_FIELDS.has(key))) throw new TypeError('function-summary-invalid-return-provenance');
  const kind = nonEmptyString(value.kind, 'function-summary-invalid-return-provenance-kind');
  if (!RETURN_PROVENANCE_KINDS.has(kind)) throw new TypeError('function-summary-invalid-return-provenance-kind');
  // #4314 pin: digit strings are laundering for argIndex/returnIndex. The
  // canonical offset is the only field whose wire spelling is a string.
  if (value.argIndex != null && typeof value.argIndex !== 'number') {
    throw new TypeError('function-summary-invalid-return-provenance-arg-index');
  }
  if (value.returnIndex != null && typeof value.returnIndex !== 'number') {
    throw new TypeError('function-summary-invalid-return-provenance-return-index');
  }
  if (value.addressSpace != null) {
    nonEmptyString(value.addressSpace, 'function-summary-invalid-return-provenance-address-space');
  }
  const argIndex = optionalIndex(value.argIndex, 'function-summary-invalid-return-provenance-arg-index');
  const returnIndex = optionalIndex(value.returnIndex, 'function-summary-invalid-return-provenance-return-index');
  const offset = value.offset == null ? null : strictProvenanceOffset(value.offset);
  const root = value.rootEntityId == null ? null : nonEmptyString(value.rootEntityId, 'function-summary-invalid-return-provenance-identity');
  const allocation = value.allocationSiteId == null ? null : nonEmptyString(value.allocationSiteId, 'function-summary-invalid-return-provenance-identity');
  if (value.argIndex != null && (!Number.isSafeInteger(argIndex) || argIndex < 0)) {
    throw new TypeError('function-summary-invalid-return-provenance-arg-index');
  }
  if (value.returnIndex != null && (!Number.isSafeInteger(returnIndex) || returnIndex < 0)) {
    throw new TypeError('function-summary-invalid-return-provenance-return-index');
  }
  if (value.offset != null && offset == null) {
    throw new TypeError('function-summary-invalid-return-provenance-offset');
  }
  if (kind === 'arg' && argIndex == null) throw new TypeError('function-summary-invalid-return-provenance-arg-index');
  if ((kind === 'root' || kind === 'allocation') && root == null && allocation == null) throw new TypeError('function-summary-invalid-return-provenance-identity');
  // Storage space is required canonical identity on root/allocation facts
  // (#5242); checked after the identity code so malformed identities keep
  // their original error precedence.
  if ((kind === 'root' || kind === 'allocation') && value.addressSpace == null) {
    throw new TypeError('function-summary-invalid-return-provenance-address-space');
  }
  return true;
}
function validateMemoryEffectInput(input) {
  plainRecord(input, 'function-summary-invalid-memory-effect');
  if (input.regionId != null) nonEmptyString(input.regionId, 'function-summary-invalid-region-id');
  if (input.regionKind != null) nonEmptyString(input.regionKind, 'function-summary-invalid-region-kind');
  optionalBoolean(input.broad, 'function-summary-invalid-broad-effect');
  validateStringList(input.addressSpaces, 'function-summary-invalid-address-spaces');
  validateStringList(input.evidenceIds, 'function-summary-invalid-evidence-ids');
}
function validateUnknownCallInput(input) {
  plainRecord(input, 'function-summary-invalid-unknown-call');
  nonEmptyString(input.callSiteId, 'function-summary-unknown-call-site-required');
  nonEmptyString(input.reason, 'function-summary-unknown-call-reason-required');
  validateStringList(input.targetEntityIds, 'function-summary-invalid-target-ids');
  validateStringList(input.evidenceIds, 'function-summary-invalid-evidence-ids');
}
function validateDirectCallInput(input) {
  plainRecord(input, 'function-summary-invalid-direct-call');
  nonEmptyString(input.callSiteId, 'function-summary-call-site-required');
  // A direct call with zero targets is an unresolved call, not a no-op: it
  // must be carried as an unknown-call effect with the broad boundary, never
  // as a direct-call record (#5328).
  if (validateStringList(input.targetEntityIds, 'function-summary-invalid-target-ids').length === 0) {
    throw new TypeError('function-summary-direct-call-target-required');
  }
  if (input.summaryId != null) nonEmptyString(input.summaryId, 'function-summary-invalid-summary-id');
}
function validateIndirectCallInput(input) {
  plainRecord(input, 'function-summary-invalid-indirect-call');
  nonEmptyString(input.callSiteId, 'function-summary-call-site-required');
  validateStringList(input.candidateEntityIds, 'function-summary-invalid-target-ids');
  optionalBoolean(input.exhaustive, 'function-summary-invalid-exhaustive');
  // `exhaustive:true` claims the candidate universe is complete and lets the
  // summary omit the unknown-call fallback. That claim is only meaningful for
  // a non-empty universe: an empty "exhaustive" set describes an indirect call
  // with no possible target yet still publishes complete/pure (#5346).
  if (input.exhaustive === true && input.candidateEntityIds.length === 0) {
    throw new TypeError('function-summary-exhaustive-indirect-requires-candidates');
  }
}
function detached(value, seen = new WeakMap()) {
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const out = []; seen.set(value, out);
    for (let i = 0; i < value.length; i++) if (Object.hasOwn(value, i)) out[i] = detached(value[i], seen);
    return out;
  }
  const out = {}; seen.set(value, out);
  for (const key of Object.keys(value)) out[key] = detached(value[key], seen);
  return out;
}
function validateSummaryInput(input) {
  plainRecord(input, 'function-summary-invalid');
  if (input.functionId != null) nonEmptyString(input.functionId, 'function-summary-function-id-required');
  for (const field of ['inputs','returnValues','registerEffects','allocations','frees']) validateStringList(input[field], `function-summary-invalid-${field}`);
  for (const value of denseArray(input.returnProvenance, 'function-summary-invalid-return-provenance')) validateReturnProvenance(value);
  canonicalReturnEquations(input.returnEquations, input, value => { validateReturnProvenance(value); return value; });
  for (const value of denseArray(input.memoryReadRegions, 'function-summary-invalid-read-regions')) {
    validateMemoryEffectInput(value);
    if (value.broad !== true && value.regionId == null) throw new TypeError('function-summary-unresolved-memory-region');
  }
  for (const value of denseArray(input.memoryWriteRegions, 'function-summary-invalid-write-regions')) {
    validateMemoryEffectInput(value);
    if (value.broad !== true && value.regionId == null) throw new TypeError('function-summary-unresolved-memory-region');
  }
  for (const value of denseArray(input.directCalls, 'function-summary-invalid-direct-calls')) validateDirectCallInput(value);
  for (const value of denseArray(input.indirectCallSets, 'function-summary-invalid-indirect-calls')) validateIndirectCallInput(value);
  for (const value of denseArray(input.unknownCallEffects, 'function-summary-invalid-unknown-calls')) validateUnknownCallInput(value);
  denseArray(input.escapes, 'function-summary-invalid-escapes');
  denseArray(input.semanticFacts, 'function-summary-invalid-semantic-facts');
  if (input.stackDelta != null) optionalInteger(input.stackDelta, 'function-summary-invalid-stack-delta');
}

// Bound newly consumed return-summary universes without confusing the number
// of callees with the number of distinct points-to roots after their union.
export const RETURN_SUMMARY_CANDIDATE_LIMIT = 256;

export function classifyCallTargetProof(call = {}) {
  const result = core.classifyCallTargetProof(call);
  if (result.kind !== 'indirect' || result.candidateEntityIds.length > 0 || !result.exhaustive) return result;
  return deepFreeze({ ...result, exhaustive:false, exactSingletonEntityId:null });
}
export function createMemoryEffect(input = {}) {
  validateMemoryEffectInput(input);
  return core.createMemoryEffect(input);
}
export function createUnknownCallEffect(input = {}) {
  validateUnknownCallInput(input);
  return core.createUnknownCallEffect(input);
}
export function createDirectCall(input = {}) {
  validateDirectCallInput(input);
  return core.createDirectCall(input);
}
export function createIndirectCallSet(input = {}) {
  validateIndirectCallInput(input);
  return core.createIndirectCallSet(input);
}
export function isCanonicalReturnProvenance(value) {
  try {
    validateReturnProvenance(value);
    const summary = core.createFunctionSummary({
      functionId:'probe', returnProvenance:[value], unknownCallEffects:[], memoryReadRegions:[], memoryWriteRegions:[],
      status:{ snapshotId:'probe', analyzerId:'probe', analyzerVersion:'1', completeness:'complete' },
    });
    return summary.returnProvenance.length === 1 && sameCanonicalValue(value, summary.returnProvenance[0]);
  } catch { return false; }
}
export function createFunctionSummary(input = {}) {
  validateSummaryInput(input);
  const base = core.createFunctionSummary(detached(input));
  const summary = deepFreeze({ ...base, contractVersion:FUNCTION_SUMMARY_CONTRACT_VERSION });
  CANONICAL_SUMMARIES.add(summary);
  return summary;
}
export function summaryIdentityMatches(summary, expected = {}) {
  try {
    plainRecord(summary, 'function-summary-invalid');
    if (summary.schemaVersion !== core.FUNCTION_SUMMARY_SCHEMA_VERSION
      || summary.contractVersion !== FUNCTION_SUMMARY_CONTRACT_VERSION) return false;
    let canonical = summary;
    if (!CANONICAL_SUMMARIES.has(summary)) {
      canonical = createFunctionSummary(summary);
      if (!sameCanonicalValue(summary, canonical)) return false;
    }
    if (expected.functionId != null && (typeof expected.functionId !== 'string' || canonical.functionId !== expected.functionId)) return false;
    const status = canonical.status;
    if (expected.snapshotId != null && (typeof expected.snapshotId !== 'string' || status.snapshotId !== expected.snapshotId)) return false;
    if (expected.analyzerId != null && (typeof expected.analyzerId !== 'string' || status.analyzerId !== expected.analyzerId)) return false;
    if (expected.analyzerVersion != null && (typeof expected.analyzerVersion !== 'string' || status.analyzerVersion !== expected.analyzerVersion)) return false;
    return true;
  } catch { return false; }
}
export function functionSummaryDigest(summary) { return core.functionSummaryDigest(summary); }
export function summaryMayWriteRegion(summary, regionOrId) {
  if (!summaryIdentityMatches(summary)) return true;
  return core.summaryMayWriteRegion(summary, regionOrId);
}
export function summaryIsPure(summary) {
  // Allocations and frees are canonical effect dimensions of their own: a
  // `free` ends an object's lifetime even when no memory region read/write is
  // recorded, so a summary carrying either is not pure (#5734).
  return summaryIdentityMatches(summary) && isCompleteStatus(summary.status)
    && summary.unknownCallEffects.length === 0
    && summary.memoryWriteRegions.length === 0
    && summary.memoryReadRegions.length === 0
    && summary.escapes.length === 0
    && summary.allocations.length === 0
    && summary.frees.length === 0;
}
