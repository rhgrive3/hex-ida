/**
 * P7-3a — FunctionSummary contract.
 *
 * A summary is immutable derived analysis about what a function does to state
 * and memory. Every consumer of call effects reads one of these rather than
 * re-deriving effects at the call site, so the shape has to make the dangerous
 * case impossible to spell.
 *
 * The dangerous case is P7-INV-004: a missing, stale, partial, cancelled or
 * identity-mismatched summary must never be equivalent to purity. So this
 * contract refuses to build a summary that claims no memory effects while also
 * admitting it did not resolve every call — `unknownCallEffects` and
 * `completeness: 'complete'` cannot coexist.
 */

import { deepFreeze, stableDigest } from '../../core/identity/index.js';
import { createAnalysisStatus, isCompleteStatus } from '../status.js';

export const FUNCTION_SUMMARY_SCHEMA_VERSION = 2;
export const FUNCTION_SUMMARY_CONTRACT_VERSION = '1.1.1';

/**
 * Where an effect's authority comes from, in the priority order P7-INV-004
 * fixes: a proven summary beats a versioned library model, which beats an
 * ABI/runtime rule, which beats the conservative unknown-call fallback.
 */
export const EFFECT_SOURCES = Object.freeze([
  'proven-summary',
  'library-model',
  'abi-rule',
  'unknown-call-fallback',
]);

export const UNKNOWN_CALL_REASONS = Object.freeze([
  'unresolved-target',
  'indirect-incomplete-target-set',
  'summary-missing',
  'summary-stale',
  'summary-incomplete',
  'summary-cancelled',
  'library-model-missing',
  'recursion-unconverged',
]);

const SOURCE_SET = new Set(EFFECT_SOURCES);
const REASON_SET = new Set(UNKNOWN_CALL_REASONS);
const RETURN_PROVENANCE_KINDS = new Set(['arg', 'root', 'allocation', 'unknown']);
const RETURN_PROVENANCE_FIELDS = Object.freeze([
  'kind', 'argIndex', 'returnIndex', 'offset', 'rootEntityId', 'allocationSiteId',
]);
// Only immutable objects built here may bypass repeat schema validation.
// A copied or deserialized envelope never inherits this producer binding.
const CANONICAL_SUMMARIES = new WeakSet();

function fail(code) { throw new TypeError(code); }

function nonEmpty(value, code) {
  if (typeof value !== 'string') fail(code);
  const text = value.trim();
  if (!text) fail(code);
  return text;
}

function record(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  return value;
}

function optionalIndex(value, code) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function optionalInteger(value, code) {
  if (value == null) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^(?:[+-]?[0-9]+|0[xX][0-9a-fA-F]+)$/.test(text)) return BigInt(text);
  }
  fail(code);
  return null;
}

function optionalBoolean(value, code) {
  if (value == null) return false;
  if (typeof value !== 'boolean') fail(code);
  return value;
}

// Compare schema-normalized fields without JSON/String/Number coercion. This
// also detects missing/defaulted fields and extension fields that a consumer
// might otherwise interpret as additional authority (#4314, #4320).
function sameCanonicalValue(raw, canonical) {
  if (raw === canonical) return true;
  if (!raw || !canonical || typeof raw !== 'object' || typeof canonical !== 'object') return false;
  if (Array.isArray(raw) !== Array.isArray(canonical)) return false;
  if (Array.isArray(raw)) {
    if (raw.length !== canonical.length) return false;
  } else {
    record(raw, 'function-summary-invalid-record');
  }
  const keys = Object.keys(canonical);
  return Object.keys(raw).length === keys.length
    && keys.every((key) => Object.hasOwn(raw, key) && sameCanonicalValue(raw[key], canonical[key]));
}

function canonicalEffectSource(value, fallback) {
  const source = value ?? fallback;
  if (typeof source !== 'string') fail('function-summary-invalid-effect-source');
  const text = source.trim();
  if (!text || !SOURCE_SET.has(text)) fail('function-summary-invalid-effect-source');
  return text;
}

function optionalReturnIdentity(value) {
  if (value == null) return null;
  if (typeof value !== 'string') fail('function-summary-invalid-return-provenance-identity');
  const text = value.trim();
  if (!text) fail('function-summary-invalid-return-provenance-identity');
  return text;
}

function list(values, code) {
  if (values == null) return [];
  if (!Array.isArray(values)) fail(code);
  for (let index = 0; index < values.length; index++) {
    if (!Object.hasOwn(values, index)) fail(code);
  }
  return values;
}

function sortedIds(values, code) {
  return [...new Set(list(values, code).map((value) => nonEmpty(value, code)))].sort();
}

function booleanKnowledge(value, code) {
  if (value === true || value === false || value === 'unknown') return value;
  fail(code);
  return null;
}

/**
 * Canonical proof classification for a semantic call target universe.
 *
 * A singleton candidate is not proof that the universe is singleton. Direct
 * identity is exact when there is no runtime target value. An indirect target
 * set is exact only when the semantic call itself is complete; a partial call
 * must retain an unknown target outside the currently recovered candidates.
 * Summary construction and points-to recovery share this helper so the two
 * consumers cannot disagree about when a callee may be treated as exact.
 */
export function classifyCallTargetProof(call = {}) {
  if (!call || typeof call !== 'object' || Array.isArray(call)) {
    return deepFreeze({ kind: 'unknown', candidateEntityIds: [], exhaustive: false, exactSingletonEntityId: null });
  }
  const candidates = [];
  let malformedIdentity = false;
  const addIdentity = (value, target) => {
    if (value == null) return;
    if (typeof value !== 'string' || !value.trim()) {
      malformedIdentity = true;
      return;
    }
    target.push(value.trim());
  };
  if (call.targetEntityIds != null) {
    if (!Array.isArray(call.targetEntityIds)) malformedIdentity = true;
    else for (const value of call.targetEntityIds) addIdentity(value, candidates);
  }
  for (const value of [call.targetEntityId, call.callee, call.target]) addIdentity(value, candidates);
  const candidateEntityIds = [...new Set(candidates)].sort();
  const targetValueIds = [];
  if (call.targetValueIds != null) {
    if (!Array.isArray(call.targetValueIds)) malformedIdentity = true;
    else for (const value of call.targetValueIds) addIdentity(value, targetValueIds);
  }
  const canonicalTargetValueIds = [...new Set(targetValueIds)].sort();
  const indirect = canonicalTargetValueIds.length > 0;
  const kind = indirect ? 'indirect' : candidateEntityIds.length ? 'direct' : 'unknown';
  const exhaustive = !malformedIdentity && (kind === 'direct'
    ? candidateEntityIds.length === 1
    : kind === 'indirect' && candidateEntityIds.length > 0 && call.completeness === 'complete');
  return deepFreeze({
    kind,
    candidateEntityIds,
    exhaustive,
    exactSingletonEntityId: exhaustive && candidateEntityIds.length === 1 ? candidateEntityIds[0] : null,
  });
}

/** One memory region a function reads or writes, with why we believe it. */
export function createMemoryEffect(input = {}) {
  record(input, 'function-summary-invalid-memory-effect');
  const source = canonicalEffectSource(input.source, 'proven-summary');
  return deepFreeze({
    regionId: input.regionId == null ? null : nonEmpty(input.regionId, 'function-summary-invalid-region-id'),
    regionKind: nonEmpty(input.regionKind ?? 'unknown', 'function-summary-invalid-region-kind'),
    // A `broad` effect covers every region in its address spaces. It is what an
    // unresolved call contributes, and it is deliberately not expressible as a
    // list of specific regions.
    broad: optionalBoolean(input.broad, 'function-summary-invalid-broad-effect'),
    addressSpaces: sortedIds(input.addressSpaces, 'function-summary-invalid-address-spaces'),
    source,
    evidenceIds: sortedIds(input.evidenceIds, 'function-summary-invalid-evidence-ids'),
  });
}

/** A call whose effects could not be resolved. Never silently dropped. */
export function createUnknownCallEffect(input = {}) {
  record(input, 'function-summary-invalid-unknown-call');
  const reason = nonEmpty(input.reason, 'function-summary-unknown-call-reason-required');
  if (!REASON_SET.has(reason)) fail('function-summary-invalid-unknown-call-reason');
  return deepFreeze({
    callSiteId: nonEmpty(input.callSiteId, 'function-summary-unknown-call-site-required'),
    reason,
    targetEntityIds: sortedIds(input.targetEntityIds, 'function-summary-invalid-target-ids'),
    evidenceIds: sortedIds(input.evidenceIds, 'function-summary-invalid-evidence-ids'),
  });
}

export function createDirectCall(input = {}) {
  record(input, 'function-summary-invalid-direct-call');
  return deepFreeze({
    callSiteId: nonEmpty(input.callSiteId, 'function-summary-call-site-required'),
    targetEntityIds: sortedIds(input.targetEntityIds, 'function-summary-invalid-target-ids'),
    summaryId: input.summaryId == null ? null : nonEmpty(input.summaryId, 'function-summary-invalid-summary-id'),
    effectSource: canonicalEffectSource(input.effectSource, 'unknown-call-fallback'),
  });
}

export function createIndirectCallSet(input = {}) {
  record(input, 'function-summary-invalid-indirect-call');
  return deepFreeze({
    callSiteId: nonEmpty(input.callSiteId, 'function-summary-call-site-required'),
    candidateEntityIds: sortedIds(input.candidateEntityIds, 'function-summary-invalid-target-ids'),
    // A candidate set that is not proven exhaustive contributes unknown-call
    // effects on top of its candidates. Averaging the candidates and calling it
    // the answer is exactly the mistake §9.4 names.
    exhaustive: optionalBoolean(input.exhaustive, 'function-summary-invalid-exhaustive'),
    evidenceIds: sortedIds(input.evidenceIds, 'function-summary-invalid-evidence-ids'),
  });
}

function createReturnProvenance(input = {}) {
  record(input, 'function-summary-invalid-return-provenance');
  const kind = nonEmpty(input.kind, 'function-summary-invalid-return-provenance-kind');
  if (!RETURN_PROVENANCE_KINDS.has(kind)) fail('function-summary-invalid-return-provenance-kind');
  const argIndex = optionalIndex(input.argIndex, 'function-summary-invalid-return-provenance-arg-index');
  const returnIndex = optionalIndex(input.returnIndex, 'function-summary-invalid-return-provenance-return-index');
  const offset = optionalInteger(input.offset, 'function-summary-invalid-return-provenance-offset');
  const rootEntityId = optionalReturnIdentity(input.rootEntityId);
  const allocationSiteId = optionalReturnIdentity(input.allocationSiteId);
  if (kind === 'arg' && argIndex == null) fail('function-summary-invalid-return-provenance-arg-index');
  if ((kind === 'root' || kind === 'allocation') && rootEntityId == null && allocationSiteId == null) {
    fail('function-summary-invalid-return-provenance-identity');
  }
  const out = {
    kind,
    argIndex: Number.isSafeInteger(argIndex) && argIndex >= 0 ? argIndex : null,
    offset: offset == null ? null : offset.toString(10),
    rootEntityId,
  };
  if (input.allocationSiteId != null) out.allocationSiteId = allocationSiteId;
  // Keep old summaries wire-compatible: an omitted returnIndex still means the
  // primary return position. New producers set it explicitly for multi-return
  // ABIs so alternatives from different return positions never get joined.
  if (returnIndex != null) out.returnIndex = returnIndex;
  return deepFreeze(out);
}

function canonicalReturnProvenance(values) {
  const byKey = new Map();
  for (const value of values) {
    const key = [
      value.returnIndex ?? 0,
      value.kind,
      value.argIndex ?? '',
      value.offset ?? '',
      value.rootEntityId ?? '',
      value.allocationSiteId ?? '',
    ].join('\u0000');
    if (!byKey.has(key)) byKey.set(key, value);
  }
  return [...byKey.values()].sort((left, right) => {
    const leftKey = [left.returnIndex ?? 0, left.kind, left.argIndex ?? -1, left.offset ?? '', left.rootEntityId ?? '', left.allocationSiteId ?? ''].join('\u0000');
    const rightKey = [right.returnIndex ?? 0, right.kind, right.argIndex ?? -1, right.offset ?? '', right.rootEntityId ?? '', right.allocationSiteId ?? ''].join('\u0000');
    return leftKey.localeCompare(rightKey);
  });
}

/**
 * Canonical return provenance shape, shared by the producer and consumer
 * identity gate. This preserves the public #5956 validator while the stricter
 * full-summary normalizer below also checks every nested authority field.
 */
export function isCanonicalReturnProvenance(value) {
  try {
    record(value, 'function-summary-invalid-return-provenance');
    if (!RETURN_PROVENANCE_KINDS.has(value.kind)) return false;
    if (Object.keys(value).some((key) => !RETURN_PROVENANCE_FIELDS.includes(key))) return false;
    const canonical = createReturnProvenance(value);
    return sameCanonicalValue(value, canonical);
  } catch {
    return false;
  }
}

/**
 * Checks the identity envelope before a consumer treats a summary as current.
 * Completeness is intentionally separate: a current partial summary is still
 * not an exact answer, while a complete summary from another snapshot is
 * stale evidence and must not be consumed at all.
 */
export function summaryIdentityMatches(summary, {
  functionId = null,
  snapshotId = null,
  analyzerId = null,
  analyzerVersion = null,
} = {}) {
  try {
    record(summary, 'function-summary-invalid');
    if (summary.schemaVersion !== FUNCTION_SUMMARY_SCHEMA_VERSION
      || summary.contractVersion !== FUNCTION_SUMMARY_CONTRACT_VERSION) return false;
    if (!CANONICAL_SUMMARIES.has(summary)) {
      // Normalize using the same constructors and consistency rules as the
      // producer, but never freeze/mutate a caller's serialized artifact.
      const normalized = normalizeFunctionSummary(summary);
      for (const field of Object.keys(normalized)) {
        if (!Object.hasOwn(summary, field) || !sameCanonicalValue(summary[field], normalized[field])) return false;
      }
    }
    if (functionId != null && (typeof functionId !== 'string' || summary.functionId !== functionId)) return false;
    const status = summary.status;
    if (snapshotId != null && (typeof snapshotId !== 'string' || status.snapshotId !== snapshotId)) return false;
    if (analyzerId != null && (typeof analyzerId !== 'string' || status.analyzerId !== analyzerId)) return false;
    if (analyzerVersion != null && (typeof analyzerVersion !== 'string' || status.analyzerVersion !== analyzerVersion)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds one function summary.
 *
 * The consistency checks at the end are the contract's whole point: they make
 * "we did not look" structurally distinguishable from "there is nothing there".
 */
function normalizeFunctionSummary(input) {
  record(input, 'function-summary-invalid');
  // A schema marker is not proof that the envelope came through the canonical
  // constructor. Rebuild it here so forged/future-shaped objects cannot bypass
  // completeness and stop-reason consistency checks at the summary boundary.
  const status = createAnalysisStatus(input.status ?? {});

  const unknownCallEffects = list(input.unknownCallEffects, 'function-summary-invalid-unknown-calls').map(createUnknownCallEffect);
  const memoryReadRegions = list(input.memoryReadRegions, 'function-summary-invalid-read-regions').map(createMemoryEffect);
  const memoryWriteRegions = list(input.memoryWriteRegions, 'function-summary-invalid-write-regions').map(createMemoryEffect);
  const returnProvenance = canonicalReturnProvenance(
    list(input.returnProvenance, 'function-summary-invalid-return-provenance').map(createReturnProvenance),
  );

  const summary = {
    schemaVersion: FUNCTION_SUMMARY_SCHEMA_VERSION,
    contractVersion: FUNCTION_SUMMARY_CONTRACT_VERSION,
    functionId: nonEmpty(input.functionId, 'function-summary-function-id-required'),
    inputs: sortedIds(input.inputs, 'function-summary-invalid-inputs'),
    returnValues: sortedIds(input.returnValues, 'function-summary-invalid-return-values'),
    returnProvenance: deepFreeze(returnProvenance),
    registerEffects: sortedIds(input.registerEffects, 'function-summary-invalid-register-effects'),
    memoryReadRegions: deepFreeze(memoryReadRegions),
    memoryWriteRegions: deepFreeze(memoryWriteRegions),
    escapes: list(input.escapes, 'function-summary-invalid-escapes').slice(),
    allocations: sortedIds(input.allocations, 'function-summary-invalid-allocations'),
    frees: sortedIds(input.frees, 'function-summary-invalid-frees'),
    directCalls: deepFreeze(list(input.directCalls, 'function-summary-invalid-direct-calls').map(createDirectCall)),
    indirectCallSets: deepFreeze(list(input.indirectCallSets, 'function-summary-invalid-indirect-calls').map(createIndirectCallSet)),
    unknownCallEffects: deepFreeze(unknownCallEffects),
    noreturn: booleanKnowledge(input.noreturn ?? 'unknown', 'function-summary-invalid-noreturn'),
    mayThrow: booleanKnowledge(input.mayThrow ?? 'unknown', 'function-summary-invalid-may-throw'),
    stackDelta: optionalInteger(input.stackDelta, 'function-summary-invalid-stack-delta')?.toString() ?? null,
    semanticFacts: list(input.semanticFacts, 'function-summary-invalid-semantic-facts').slice(),
    status,
  };

  for (const effect of [...memoryReadRegions, ...memoryWriteRegions]) {
    if (!effect.broad && effect.regionId == null) fail('function-summary-unresolved-memory-region');
  }

  // An unresolved call is not purity. A summary that carries one may not also
  // claim it looked at everything.
  if (unknownCallEffects.length > 0 && isCompleteStatus(status)) {
    fail('function-summary-unknown-call-cannot-be-complete');
  }
  // ...and it must actually contribute a broad effect, or downstream code that
  // reads only the region lists would treat the call as harmless.
  if (unknownCallEffects.length > 0
    && !memoryWriteRegions.some((effect) => effect.broad)) {
    fail('function-summary-unknown-call-requires-broad-write-effect');
  }
  if (unknownCallEffects.length > 0 && summary.noreturn !== 'unknown' && summary.mayThrow !== 'unknown') {
    // Control-flow facts are as unresolvable as memory facts when the callee is
    // unknown; claiming both are settled contradicts the unresolved call.
    fail('function-summary-unknown-call-cannot-settle-control-facts');
  }
  const nonExhaustiveIndirect = summary.indirectCallSets.some((set) => !set.exhaustive);
  if (nonExhaustiveIndirect && unknownCallEffects.length === 0) {
    fail('function-summary-nonexhaustive-indirect-requires-unknown-effect');
  }

  return summary;
}

export function createFunctionSummary(input = {}) {
  const summary = deepFreeze(normalizeFunctionSummary(input));
  CANONICAL_SUMMARIES.add(summary);
  return summary;
}

/** Stable identity for dependency edges between caller and callee summaries. */
export function functionSummaryDigest(summary) {
  // The digest is the semantic dependency identity. Every consumer-visible
  // FunctionSummary field belongs here; otherwise a callee can change meaning
  // without invalidating callers or advancing a recursive fixed point.
  return stableDigest({
    schemaVersion: summary.schemaVersion,
    contractVersion: summary.contractVersion,
    functionId: summary.functionId,
    inputs: summary.inputs,
    returnValues: summary.returnValues,
    returnProvenance: summary.returnProvenance,
    registerEffects: summary.registerEffects,
    memoryReadRegions: summary.memoryReadRegions,
    memoryWriteRegions: summary.memoryWriteRegions,
    escapes: summary.escapes,
    allocations: summary.allocations,
    frees: summary.frees,
    directCalls: summary.directCalls,
    indirectCallSets: summary.indirectCallSets,
    unknownCallEffects: summary.unknownCallEffects,
    noreturn: summary.noreturn,
    mayThrow: summary.mayThrow,
    stackDelta: summary.stackDelta,
    semanticFacts: summary.semanticFacts,
    completeness: summary.status.completeness,
    stopReason: summary.status.stopReason,
    analyzerId: summary.status.analyzerId,
    analyzerVersion: summary.status.analyzerVersion,
  });
}

/**
 * The only sanctioned way to ask "does this function write memory I care
 * about?". It answers `true` whenever the summary cannot prove otherwise,
 * which is what keeps an incomplete summary from reading as pure.
 */
export function summaryMayWriteRegion(summary, regionId) {
  if (!summaryIdentityMatches(summary)) return true;
  if (!isCompleteStatus(summary.status)) return true;
  if (summary.unknownCallEffects.length > 0) return true;
  if (summary.memoryWriteRegions.some((effect) => effect.broad)) return true;
  if (regionId == null) return summary.memoryWriteRegions.length > 0;
  return summary.memoryWriteRegions.some((effect) => effect.regionId === regionId);
}

export function summaryIsPure(summary) {
  return summaryIdentityMatches(summary) && isCompleteStatus(summary.status)
    && summary.unknownCallEffects.length === 0
    && summary.memoryWriteRegions.length === 0
    && summary.memoryReadRegions.length === 0
    && summary.escapes.length === 0;
}
