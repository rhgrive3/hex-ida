/**
 * P7-3b — escape analysis.
 *
 * Escape is not a boolean (FM-3). Later analysis needs to know *why* a root
 * left the function and *across which boundary*, because different separation
 * proofs survive different escapes: a pointer that was only passed to a call
 * with a proven summary is not in the same situation as one stored into a
 * global.
 *
 * The result feeds A2 through `nonEscapingRoots`, which is the one hook that
 * lets alias analysis use escape evidence without A1/A2 growing a backwards
 * dependency on a later checkpoint (§7.2).
 *
 * This module is generic. Language and runtime captures (closures, ObjC/Swift
 * runtime publication, thread handoff) arrive through the `captureProviders`
 * hook rather than being decoded here, so no target-specific knowledge enters
 * the central solver (P7-INV-007).
 */

import { deepFreeze, stableStringify } from '../../core/identity/index.js';
import { createSemanticMachineType } from '../../semantics/ir/types.js';
import { createAnalysisStatus } from '../status.js';
import { provenSeparationAuthority } from '../pointsto/lattice.js';

export const ESCAPE_ANALYZER_ID = 'phase7.summary.escape';
export const ESCAPE_ANALYZER_VERSION = '1.1.0';

/** Why a root became visible outside the function. */
export const ESCAPE_REASONS = Object.freeze([
  'returned',
  'stored-to-global',
  'stored-through-argument',
  'passed-to-known-call',
  'passed-to-unknown-call',
  'captured-by-closure',
  'published-to-runtime-object',
  'published-to-thread',
  'stored-through-unknown-pointer',
  'unknown',
]);

/** Which boundary it crossed. Kept separate from the reason on purpose. */
export const ESCAPE_BOUNDARIES = Object.freeze([
  'return', 'global', 'argument', 'known-call', 'unknown-call', 'closure', 'runtime', 'thread', 'unknown',
]);

/**
 * Where a root came from.
 *
 * This matters as much as escape itself. Two roots that do not escape can only
 * be proven distinct when each was *created here* — two incoming pointer
 * parameters may alias each other no matter how little they escape.
 */
export const ROOT_ORIGINS = Object.freeze(['local-frame', 'local-allocation', 'incoming', 'global', 'unknown']);

const REASON_SET = new Set(ESCAPE_REASONS);
const BOUNDARY_SET = new Set(ESCAPE_BOUNDARIES);
const LOCALLY_CREATED = new Set(['local-frame', 'local-allocation']);
// Only canonical Semantic IR scalar kinds are proof that a value cannot carry
// a pointer. Missing, malformed, or future kinds remain unknown/fail-closed.
const NON_POINTER_MACHINE_TYPES = new Set(['bitvector', 'float', 'vector', 'predicate']);

function fail(code) { throw new TypeError(code); }

export function createEscapeRecord(input = {}) {
  const reason = typeof input.reason === 'string' ? input.reason : '';
  const boundary = typeof input.boundary === 'string' ? input.boundary : '';
  if (!REASON_SET.has(reason)) fail('escape-invalid-reason');
  if (!BOUNDARY_SET.has(boundary)) fail('escape-invalid-boundary');

  if (typeof input.rootKey !== 'string' || !input.rootKey.trim()) fail('escape-invalid-root-key');
  const rootKey = input.rootKey.trim();

  let siteId = null;
  if (input.siteId != null) {
    if (typeof input.siteId !== 'string' || !input.siteId.trim()) fail('escape-invalid-site-id');
    siteId = input.siteId.trim();
  }

  const evidenceIds = [];
  if (input.evidenceIds != null) {
    if (!Array.isArray(input.evidenceIds)) fail('escape-invalid-evidence-ids');
    for (const id of input.evidenceIds) {
      if (typeof id !== 'string' || !id.trim()) fail('escape-invalid-evidence-ids');
      evidenceIds.push(id.trim());
    }
  }

  return deepFreeze({
    rootKey,
    rootOrigin: ROOT_ORIGINS.includes(input.rootOrigin) ? input.rootOrigin : 'unknown',
    reason,
    boundary,
    siteId,
    evidenceIds: [...new Set(evidenceIds)].sort(),
  });
}

/**
 * Classifies a points-to target's root.
 *
 * The classification is derived from the canonical root kind supplied by the
 * address service, never from register names or mnemonics.
 */

/**
 * Published escape results are proof authority. `nonEscapingRoots` feeds the
 * strong `distinct-non-escaping-allocation` alias proof and `rootOrigins`
 * feeds every separation decision, so a consumer must never be able to forge
 * or revoke a proof by mutating the returned collection (#5274). The facades
 * expose the read-only view; every mutating operation fails closed.
 */
class PublishedRootSet {
  constructor(source) {
    this.#entries = new Set(source);
    Object.freeze(this);
  }
  #entries;
  get size() { return this.#entries.size; }
  has(value) { return this.#entries.has(value); }
  keys() { return this.#entries.keys(); }
  values() { return this.#entries.values(); }
  entries() { return this.#entries.entries(); }
  forEach(callback, thisArg) {
    return this.#entries.forEach((value) => Reflect.apply(callback, thisArg, [value, value, this]));
  }
  [Symbol.iterator]() { return this.#entries[Symbol.iterator](); }
  add() { fail('escape-result-immutable'); }
  delete() { fail('escape-result-immutable'); }
  clear() { fail('escape-result-immutable'); }
}

class PublishedRootOrigins {
  constructor(source) {
    this.#entries = new Map(source);
    Object.freeze(this);
  }
  #entries;
  get size() { return this.#entries.size; }
  has(key) { return this.#entries.has(key); }
  get(key) { return this.#entries.get(key); }
  keys() { return this.#entries.keys(); }
  values() { return this.#entries.values(); }
  entries() { return this.#entries.entries(); }
  forEach(callback, thisArg) {
    return this.#entries.forEach((value, key) => Reflect.apply(callback, thisArg, [value, key, this]));
  }
  [Symbol.iterator]() { return this.#entries[Symbol.iterator](); }
  set() { fail('escape-result-immutable'); }
  delete() { fail('escape-result-immutable'); }
  clear() { fail('escape-result-immutable'); }
}

export function classifyRootOrigin(target, { allocationRootKeys = new Set() } = {}) {
  if (!target) return 'unknown';
  if (allocationRootKeys.has(target.rootKey)) return 'local-allocation';
  if (target.rootKind === 'allocation') return 'local-allocation';
  if (target.rootKind === 'stack-like') return 'local-frame';
  if (target.rootKind === 'absolute') return 'global';
  /* The canonical root descriptor's storage class is producer-held evidence
   * (issue #5892): `global-like` normalizes to a `rooted` proof, but it is a
   * global storage root, not an incoming argument. Only descriptor-backed
   * authority counts — a `separationClass` without that authority must not
   * mint a global, so an ordinary `rooted` target stays `incoming`. The
   * authority is verified against the target's proof brand (#6066), not the
   * stored string. */
  if (provenSeparationAuthority(target) === 'root-descriptor'
    && target.separationClass === 'global-like') return 'global';
  if (target.rootKind === 'rooted') return 'incoming';
  return 'unknown';
}

// Escape-fact evidence follows the same canonical primitive non-empty string
// contract as the local summary's instruction origin (#5776): a structured
// value must never launder into an instruction evidence ID via String(), so
// malformed evidence fails closed instead of joining escape provenance.
function evidenceOf(node) {
  const raw = node.origin?.instructionIds ?? [];
  if (!Array.isArray(raw)) throw new TypeError('summary-invalid-instruction-evidence');
  const evidenceIds = [];
  for (const value of raw) {
    if (typeof value !== 'string' || !value) throw new TypeError('summary-invalid-instruction-evidence');
    if (!evidenceIds.includes(value)) evidenceIds.push(value);
  }
  return evidenceIds;
}

/**
 * Runs escape analysis over one function.
 *
 * Requires the A2 points-to result: escape is a question about which roots a
 * value can carry, and answering it without points-to would mean re-deriving
 * roots in a second place.
 */
export function analyzeEscape(ir, cfg, ssa, pointsToRun, options = {}) {
  const analyzerStatus = (completeness, stopReason) => createAnalysisStatus({
    snapshotId: options.snapshotId ?? 'snapshot-unbound',
    analyzerId: ESCAPE_ANALYZER_ID,
    analyzerVersion: ESCAPE_ANALYZER_VERSION,
    completeness,
    budgetClass: options.budgetClass ?? null,
    stopReason,
  });

  const cancelledResult = () => ({
    escapes: [], nonEscapingRoots: new PublishedRootSet([]), rootOrigins: new PublishedRootOrigins([]),
    status: analyzerStatus('partial', 'cancelled'),
  });
  if (options.signal?.aborted) return cancelledResult();
  if (!pointsToRun || pointsToRun.status.completeness === 'unsupported') {
    // Without points-to there is no root vocabulary to reason about. The only
    // sound report is "nothing is proven non-escaping".
    return { escapes: [], nonEscapingRoots: new PublishedRootSet([]), rootOrigins: new PublishedRootOrigins([]), status: analyzerStatus('unsupported', 'dependency-missing') };
  }

  const nodes = new Map((ir.nodes ?? []).map((node) => [String(node.id), node]));
  const values = new Map();
  const duplicateValueIds = new Set();
  for (const value of ir.values ?? []) {
    if (typeof value?.id !== 'string' || !value.id.trim() || value.id !== value.id.trim()) continue;
    if (values.has(value.id)) duplicateValueIds.add(value.id);
    else values.set(value.id, value);
  }
  const allocationRootKeys = new Set(options.allocationRootKeys ?? []);
  const escapes = [];
  const rootOrigins = new Map();
  const escapedRoots = new Set();
  const containment = new Map();
  let sawUnresolvedFlow = false;

  const valueFlowKinds = new Map();
  const valueFlowKind = (valueId) => {
    if (typeof valueId !== 'string' || duplicateValueIds.has(valueId)) return 'unknown';
    if (valueFlowKinds.has(valueId)) return valueFlowKinds.get(valueId);
    const value = values.get(valueId);
    if (!value) return 'unknown';
    let kind = null;
    try { kind = createSemanticMachineType(value.machineType).kind; } catch { /* malformed type stays unknown */ }
    const flowKind = kind === 'address'
      ? 'pointer'
      : NON_POINTER_MACHINE_TYPES.has(kind) ? 'non-pointer' : 'unknown';
    valueFlowKinds.set(valueId, flowKind);
    return flowKind;
  };

  const setsFor = (valueId) => {
    // Points-to map keys are canonical value ID strings. A non-string
    // reference is not an alias for some canonical value: String-coercion
    // would let a structured id like ['v1'] read 'v1''s points-to set and
    // turn another value's flow into escape evidence (#5783). Fail closed to
    // an unresolved flow instead.
    if (typeof valueId !== 'string') return null;
    return pointsToRun.pointsTo.get(valueId) ?? null;
  };

  const record = (set, { reason, boundary, siteId, evidenceIds }) => {
    if (!set) { sawUnresolvedFlow = true; return; }
    if (set.top) {
      // A value that may point anywhere carries every root out with it. There
      // is no root list to mark, so no root may be called non-escaping later.
      sawUnresolvedFlow = true;
      return;
    }
    for (const target of set.targets) {
      const origin = classifyRootOrigin(target, { allocationRootKeys });
      rootOrigins.set(target.rootKey, origin);
      escapedRoots.add(target.rootKey);
      escapes.push(createEscapeRecord({
        rootKey: target.rootKey, rootOrigin: origin, reason, boundary, siteId, evidenceIds,
      }));
    }
  };

  const recordValue = (valueId, details) => {
    if (valueFlowKind(valueId) === 'non-pointer') return;
    record(setsFor(valueId), details);
  };

  const observe = (set) => {
    if (!set || set.top) return;
    for (const target of set.targets) {
      if (!rootOrigins.has(target.rootKey)) {
        rootOrigins.set(target.rootKey, classifyRootOrigin(target, { allocationRootKeys }));
      }
    }
  };

  const observeValue = (valueId) => {
    if (valueFlowKind(valueId) === 'non-pointer') return;
    observe(setsFor(valueId));
  };

  for (const node of nodes.values()) {
    if (options.signal?.aborted) return cancelledResult();
    for (const input of node.inputs ?? []) observeValue(input);

    if (node.kind === 'return') {
      for (const input of node.inputs ?? []) {
        recordValue(input, { reason: 'returned', boundary: 'return', siteId: node.id, evidenceIds: evidenceOf(node) });
      }
      continue;
    }

    if (node.kind === 'store') {
      // A store publishes the *stored value's* roots wherever the *address*
      // points. The address decides the boundary.
      const storedValueId = (node.inputs ?? [])[1];
      if (storedValueId == null) continue;
      if (valueFlowKind(storedValueId) === 'non-pointer') continue;
      const storedSet = setsFor(storedValueId);
      if (!storedSet || storedSet.top || !storedSet.targets.length) { sawUnresolvedFlow = true; continue; }
      const addressSet = setsFor(node.memory?.addressExpr?.valueId);
      if (!addressSet || addressSet.top) {
        record(storedSet, {
          reason: 'stored-through-unknown-pointer', boundary: 'unknown', siteId: node.id, evidenceIds: evidenceOf(node),
        });
        continue;
      }
      const destinationOrigins = new Set(addressSet.targets.map((target) => classifyRootOrigin(target, { allocationRootKeys })));
      if (destinationOrigins.has('global')) {
        record(storedSet, { reason: 'stored-to-global', boundary: 'global', siteId: node.id, evidenceIds: evidenceOf(node) });
      }
      if (destinationOrigins.has('incoming')) {
        record(storedSet, { reason: 'stored-through-argument', boundary: 'argument', siteId: node.id, evidenceIds: evidenceOf(node) });
      }
      if (destinationOrigins.has('unknown')) {
        record(storedSet, { reason: 'stored-through-unknown-pointer', boundary: 'unknown', siteId: node.id, evidenceIds: evidenceOf(node) });
      }
      for (const destTarget of addressSet.targets) {
        const destOrigin = classifyRootOrigin(destTarget, { allocationRootKeys });
        if (LOCALLY_CREATED.has(destOrigin)) {
          if (!containment.has(destTarget.rootKey)) containment.set(destTarget.rootKey, new Set());
          for (const storedTarget of storedSet.targets) {
            containment.get(destTarget.rootKey).add(storedTarget.rootKey);
            observeValue(storedValueId);
          }
        }
      }
      continue;
    }

    if (node.kind === 'call') {
      const complete = node.call?.completeness === 'complete';
      const reason = complete ? 'passed-to-known-call' : 'passed-to-unknown-call';
      const boundary = complete ? 'known-call' : 'unknown-call';
      // Canonical arguments and target-only inputs are distinct roles (#3814).
      // Empty/absent argument lists retain the historical inputs fallback, but
      // known callee-target IDs are never inferred to be arguments. A target
      // explicitly present in a nonempty argument list still escapes normally.
      const explicitArguments = node.call?.arguments;
      const targetIds = new Set(
        (node.call?.targetValueIds ?? [])
          .map((target) => target?.valueId ?? target)
          .filter((value) => value != null),
      );
      const arguments_ = Array.isArray(explicitArguments) && explicitArguments.length
        ? explicitArguments
        : (node.inputs ?? []).filter((value) => !targetIds.has(value));
      if (explicitArguments != null && !Array.isArray(explicitArguments)) sawUnresolvedFlow = true;
      const argumentValueIds = [...new Set(arguments_.map((argument) =>
        argument && typeof argument === 'object' && !Array.isArray(argument)
          ? argument.valueId : argument,
      ))];
      for (const valueId of argumentValueIds) {
        recordValue(valueId, { reason, boundary, siteId: node.id, evidenceIds: evidenceOf(node) });
      }
      if (!complete) sawUnresolvedFlow = true;
      continue;
    }

    if (node.kind === 'unknown-memory-effect' || node.kind === 'unknown-state-write' || node.kind === 'incomplete') {
      sawUnresolvedFlow = true;
      continue;
    }
  }

  // Language and runtime capture providers contribute additional escapes
  // without the generic solver knowing anything about their languages.
  for (const provider of options.captureProviders ?? []) {
    if (options.signal?.aborted) return cancelledResult();
    const captures = provider({ ir, cfg, ssa, pointsToRun });
    if (options.signal?.aborted) return cancelledResult();
    for (const capture of captures ?? []) {
      // Iterators can be re-entrant too; cancellation must revoke publication.
      if (options.signal?.aborted) return cancelledResult();
      const record_ = createEscapeRecord(capture);
      escapes.push(record_);
      escapedRoots.add(record_.rootKey);
      if (!rootOrigins.has(record_.rootKey)) rootOrigins.set(record_.rootKey, record_.rootOrigin);
    }
    if (options.signal?.aborted) return cancelledResult();
  }

  // Fixed point over (root, escape fact), not over visited roots/edges (#6146).
  // A newly discovered reason/site/evidence fact must reach the descendants
  // even when they already escaped for a different reason. Each fact is
  // processed once per root, so cycles and diamonds terminate without losing
  // provenance or manufacturing an unbounded path-dependent identity.
  const factsByRoot = new Map();
  const worklist = [];
  const addFact = (record_) => {
    let facts = factsByRoot.get(record_.rootKey);
    if (!facts) { facts = new Set(); factsByRoot.set(record_.rootKey, facts); }
    const key = stableStringify([
      record_.reason, record_.boundary, record_.siteId, record_.evidenceIds,
    ]);
    if (facts.has(key)) return;
    facts.add(key);
    escapedRoots.add(record_.rootKey);
    worklist.push(record_);
  };
  for (const record_ of escapes) addFact(record_);
  for (let cursor = 0; cursor < worklist.length; cursor++) {
    if (options.signal?.aborted) return cancelledResult();
    const parent = worklist[cursor];
    for (const childRoot of containment.get(parent.rootKey) ?? []) {
      addFact(createEscapeRecord({
        rootKey: childRoot,
        rootOrigin: rootOrigins.get(childRoot) ?? 'unknown',
        reason: parent.reason, boundary: parent.boundary,
        siteId: parent.siteId, evidenceIds: parent.evidenceIds,
      }));
    }
  }
  const canonicalEscapes = worklist.map((record_) => [stableStringify(record_), record_])
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, record_]) => record_);

  /**
   * A root is proven non-escaping only when all three hold: it was created in
   * this function, nothing published it, and the analysis saw every flow. Any
   * unresolved flow at all voids the whole set — a value that may point
   * anywhere could have carried any root out.
   */
  if (options.signal?.aborted) return cancelledResult();
  const pointsToComplete = pointsToRun.status.completeness === 'complete';
  const nonEscapingRoots = new Set();
  if (pointsToComplete && !sawUnresolvedFlow) {
    for (const [rootKey, origin] of rootOrigins) {
      if (LOCALLY_CREATED.has(origin) && !escapedRoots.has(rootKey)) nonEscapingRoots.add(rootKey);
    }
  }

  if (options.signal?.aborted) return cancelledResult();
  const completeness = pointsToComplete && !sawUnresolvedFlow ? 'complete' : 'partial';
  return {
    escapes: deepFreeze(canonicalEscapes),
    nonEscapingRoots: new PublishedRootSet(nonEscapingRoots),
    rootOrigins: new PublishedRootOrigins(rootOrigins),
    sawUnresolvedFlow,
    status: analyzerStatus(completeness, completeness === 'complete' ? null : 'evidence-missing'),
  };
}

/**
 * Escape reasons that invalidate a separation proof which relied on a root not
 * being visible outside the function. Used by artifact invalidation so exactly
 * the affected proofs are dropped, and no more (§9.4).
 *
 * Full recompute treats every observed escape fact as revoking the root's
 * non-escape proof (`analyzeEscape()` adds every record's root to
 * `escapedRoots`, and `passed-to-known-call` is one of those records), so the
 * incremental policy must agree — a policy that spared the known-call reason
 * would let invalidation keep a proof a fresh analysis would withdraw (#5362).
 * If a proof-preserving known-call contract is ever introduced, both sides
 * must change together; until then every escape fact invalidates.
 */
export function invalidatesNonEscapeProof(record) {
  return record != null;
}
