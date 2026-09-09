/**
 * P7-2 — points-to lattice: offset ranges and points-to sets.
 *
 * Everything expensive about A2 lives in this file's join and widening rules,
 * so they are stated explicitly rather than emerging from the solver's control
 * flow.
 *
 * Lattice, top-down:
 *   TOP    = "may point anywhere" (`top: true`) — the conservative answer.
 *   sets   = a finite union of (root, offset-range) targets.
 *   BOTTOM = the empty set — "no value reaches here yet", used only as the
 *            fixed-point seed. It is never a published answer, because an
 *            empty points-to set would falsely prove separation from everything.
 *
 * Offsets are *signed mathematical* offsets relative to a canonical root, which
 * is the same convention `canonical-address-v2-core.js` uses. They are not
 * machine addresses, so they are never reduced modulo the pointer width: a
 * wrapped interval compares as if it were small and would manufacture a false
 * `NoAlias`. Any arithmetic that could wrap is therefore widened to unbounded
 * instead (see `addRange`).
 */

import { canonicalAddress, deepFreeze, stableDigest, stableStringify } from '../../core/identity/index.js';
import { isCanonicalRootDescriptorProof } from '../alias/canonical-address-v2.js';

export const POINTS_TO_LATTICE_VERSION = '1.0.0';

/** Default iteration/size limits. Termination never relies on these alone. */
export const POINTS_TO_DEFAULT_BUDGET = Object.freeze({
  maxTargetsPerSet: 8,
  maxIterations: 32,
  widenAfterIterations: 3,
  maxValues: 65536,
});

export const PROVENANCE_LOSS_REASONS = Object.freeze([
  'integer-to-pointer',
  'width-overflow',
  'non-linear-arithmetic',
  'unresolved-load',
  'unresolved-call',
  'widened',
  'target-cap',
  'unsupported-operation',
]);

function fail(code) { throw new TypeError(code); }

function maxTargetsPerSet(budget) {
  const value = budget?.maxTargetsPerSet ?? POINTS_TO_DEFAULT_BUDGET.maxTargetsPerSet;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    fail('points-to-invalid-max-targets-per-set');
  }
  return value;
}

function big(value) {
  if (value == null) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return null;
    return BigInt(value);
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  try { return BigInt(text); }
  catch { return null; }
}

/**
 * Canonical proof-bearing concrete address.
 *
 * Reuse the repository's canonical address grammar as the authority boundary,
 * while preserving valid decimal/hex spelling so existing target identities
 * do not change merely because this proof check was tightened.
 */
export function canonicalPointsToAddress(value) {
  try {
    canonicalAddress(value);
  } catch {
    return null;
  }
  return typeof value === 'string' ? value.trim() : String(value);
}

/**
 * A closed signed interval, or an unbounded end when a bound is `null`.
 * `exact` records that the range is a single proven value, which is what
 * `must` answers require.
 */
export function createOffsetRange(min, max) {
  const lo = big(min);
  const hi = big(max);
  if (lo != null && hi != null && lo > hi) fail('points-to-invalid-offset-range');
  return deepFreeze({ min: lo, max: hi, exact: lo != null && lo === hi });
}

export const UNBOUNDED_RANGE = createOffsetRange(null, null);

/**
 * Canonical offset-range view for a points-to target (#6068).
 *
 * A caller-supplied `{min, max, exact:true}` would otherwise smuggle an
 * internal invariant violation past `rangeRelation()`, which trusts `exact`
 * and ignores `max` — manufacturing strong NoAlias for overlapping ranges or
 * MustAlias for non-single locations. The range is rebuilt through
 * `createOffsetRange`, so `exact` is re-derived from `min === max` instead of
 * being taken on faith. End values pass through unchanged: a `null` end stays
 * unbounded toward that side, so widening results are preserved.
 */
function canonicalOffsetRange(range) {
  if (range == null) return UNBOUNDED_RANGE;
  if (range === UNBOUNDED_RANGE) return range;
  return createOffsetRange(range.min ?? null, range.max ?? null);
}

export function exactRange(value) {
  const v = big(value);
  if (v == null) return UNBOUNDED_RANGE;
  return createOffsetRange(v, v);
}

function rangeIsUnbounded(range) {
  return range.min == null || range.max == null;
}

export function joinRange(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  const min = a.min == null || b.min == null ? null : (a.min < b.min ? a.min : b.min);
  const max = a.max == null || b.max == null ? null : (a.max > b.max ? a.max : b.max);
  return createOffsetRange(min, max);
}

/**
 * Widening: any end that moved outward since the previous iteration is thrown
 * to infinity. This is what guarantees termination for loop-carried pointer
 * phis, and it always loses precision in the safe direction.
 */
export function widenRange(previous, next) {
  if (previous == null) return next;
  let min = next.min;
  let max = next.max;
  if (previous.min == null || min == null || min < previous.min) min = null;
  if (previous.max == null || max == null || max > previous.max) max = null;
  return createOffsetRange(min, max);
}

/**
 * Signed bounds representable at `widthBits`. Used to detect the case where a
 * machine-width add could have wrapped; a wrapped offset cannot be compared as
 * an interval.
 */
function signedBounds(widthBits) {
  if (typeof widthBits !== 'number' || !Number.isSafeInteger(widthBits) || widthBits <= 1 || widthBits > 512) return null;
  const half = 1n << BigInt(widthBits - 1);
  return { min: -half, max: half - 1n };
}

/**
 * Checked range addition.
 *
 * Returns `{ range, lost }`. `lost` is set when the result could have wrapped
 * at the pointer width, in which case the range is unbounded and the caller
 * must record provenance loss instead of silently keeping a small interval.
 */
export function addRange(range, delta, widthBits) {
  const d = big(delta);
  if (d == null) return { range: UNBOUNDED_RANGE, lost: 'non-linear-arithmetic' };
  if (rangeIsUnbounded(range)) {
    const min = range.min == null ? null : range.min + d;
    const max = range.max == null ? null : range.max + d;
    return { range: createOffsetRange(min, max), lost: null };
  }
  const min = range.min + d;
  const max = range.max + d;
  const bounds = signedBounds(widthBits);
  if (!bounds || min < bounds.min || max > bounds.max) {
    return { range: UNBOUNDED_RANGE, lost: 'width-overflow' };
  }
  return { range: createOffsetRange(min, max), lost: null };
}

/** Adds two ranges (pointer + ranged index). */
export function addRanges(a, b, widthBits) {
  if (rangeIsUnbounded(a) || rangeIsUnbounded(b)) {
    return { range: UNBOUNDED_RANGE, lost: null };
  }
  const min = a.min + b.min;
  const max = a.max + b.max;
  const bounds = signedBounds(widthBits);
  if (!bounds || min < bounds.min || max > bounds.max) {
    return { range: UNBOUNDED_RANGE, lost: 'width-overflow' };
  }
  return { range: createOffsetRange(min, max), lost: null };
}

/**
 * Interval relation between two accesses at the same root.
 *
 * `sizeA`/`sizeB` are access widths in bytes. Anything unbounded is `may`; an
 * exact match of both position and width is `must`; provable non-overlap is
 * `no`.
 */
export function rangeRelation(a, sizeA, b, sizeB) {
  const wa = big(sizeA);
  const wb = big(sizeB);
  if (wa == null || wb == null || wa <= 0n || wb <= 0n) return 'unknown';
  if (rangeIsUnbounded(a) || rangeIsUnbounded(b)) return 'may';
  if (a.exact && b.exact) {
    if (a.min === b.min && wa === wb) return 'must';
    if (a.min + wa <= b.min || b.min + wb <= a.min) return 'no';
    return 'may';
  }
  // Non-exact ranges: separation needs the whole spans to miss each other.
  if (a.max + wa <= b.min || b.max + wb <= a.min) return 'no';
  return 'may';
}

/** Storage classes whose separation may be proven by a canonical root descriptor. */
export const PROVEN_SEPARATION_CLASSES = Object.freeze(['global-like', 'heap-like', 'tls-like']);

/**
 * Module-private brand for canonical root-descriptor separation proofs.
 *
 * The symbol carries the exact proof object returned by the canonical address
 * producer. It may survive internal object-spread reconstructions, but the
 * target's root identity and storage class must still match that proof.
 */
const ROOT_DESCRIPTOR_PROOF = Symbol('phase7.pointsto.root-descriptor-proof');

function rootKeyOf(target) {
  // Root identity is storage identity only (space/kind/identity/entity/address).
  // separationClass/separationAuthority are *proofs about* the root, not what
  // storage it designates: the same allocation observed through a producing
  // path that attached a proof and one that did not must share one rootKey, or
  // pointsToAlias() treats identical storage as distinct roots and can mint a
  // false strong NoAlias off escape evidence keyed on the forked key (#5261).
  // Consumers that need the proof read it from the target boundary
  // (provenSeparationAuthority()/target.separationClass), never from this key.
  return stableStringify({
    addressSpace: target.addressSpace,
    rootKind: target.rootKind,
    rootIdentity: target.rootIdentity ?? null,
    rootEntityId: target.rootEntityId ?? null,
    address: target.address ?? null,
  });
}

function proofRootKind(proof) {
  return proof?.kind === 'root-only' ? proof.rootKind : proof?.kind;
}

function canonicalProofMetadataIsValid(proof) {
  return isCanonicalRootDescriptorProof(proof)
    && proofRootKind(proof) === 'rooted'
    && proof.separationAuthority === 'root-descriptor'
    && PROVEN_SEPARATION_CLASSES.includes(proof.separationClass);
}

/**
 * Canonical address-space identity for a points-to target (#5717).
 *
 * `addressSpace` backs a strong `NoAlias` authority (distinct spaces cannot
 * alias), so a non-canonical notation must never become its own space:
 * surrounding whitespace on 'memory ' would manufacture a space the storage
 * never had. The value is trimmed; a whitespace-only value degrades to
 * 'unknown', which alias separation never treats as proven.
 */
function canonicalAddressSpace(value) {
  if (value == null) return 'memory';
  if (typeof value !== 'string') return 'unknown';
  const text = value.trim();
  return text ? text : 'unknown';
}

function targetMatchesCanonicalProof(input, proof) {
  if (!canonicalProofMetadataIsValid(proof)) return false;
  const addressSpace = canonicalAddressSpace(input.addressSpace);
  const rootKind = typeof input.rootKind === 'string' ? input.rootKind : 'unknown';
  const rootEntityId = typeof input.rootEntityId === 'string' && input.rootEntityId.trim()
    ? input.rootEntityId : null;
  return addressSpace === canonicalAddressSpace(proof.addressSpace)
    && rootKind === proofRootKind(proof)
    && stableStringify(input.rootIdentity ?? null) === stableStringify(proof.rootIdentity ?? null)
    && rootEntityId === (proof.rootEntityId ?? null)
    && input.separationClass === proof.separationClass
    && input.separationAuthority === 'root-descriptor';
}

function inputMatchesCanonicalProof(input, proof) {
  if (!canonicalProofMetadataIsValid(proof)) return false;
  const expectedRootKind = proofRootKind(proof);
  const checks = [
    ['addressSpace', canonicalAddressSpace(proof.addressSpace)],
    ['rootKind', expectedRootKind],
    ['rootIdentity', proof.rootIdentity ?? null],
    ['rootEntityId', proof.rootEntityId ?? null],
    ['separationClass', proof.separationClass],
    ['separationAuthority', 'root-descriptor'],
  ];
  for (const [key, expected] of checks) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const actual = key === 'addressSpace'
      ? canonicalAddressSpace(input[key])
      : key === 'rootEntityId' && input[key] != null
        ? String(input[key]) : (input[key] ?? null);
    if (key === 'rootIdentity') {
      if (stableStringify(actual) !== stableStringify(expected)) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

/** One (root, offset-range) member of a points-to set. */
export function createPointsToTarget(input = {}) {
  // A plain object can never mint authority. Internal copies are accepted only
  // when the exact canonical proof object and its root identity are preserved.
  const proof = input[ROOT_DESCRIPTOR_PROOF];
  const proven = targetMatchesCanonicalProof(input, proof);
  const target = {
    addressSpace: canonicalAddressSpace(input.addressSpace),
    rootKind: typeof input.rootKind === 'string' ? input.rootKind : 'unknown',
    rootIdentity: input.rootIdentity ?? null,
    // Canonical root token, not the raw spelling (#6063): 'A' and '  A  ' are
    // the same root, and storing the raw string split one root into two
    // identities — a false strong NoAlias between them.
    rootEntityId: typeof input.rootEntityId === 'string' && input.rootEntityId.trim() ? input.rootEntityId.trim() : null,
    separationClass: typeof input.separationClass === 'string' ? input.separationClass : null,
    separationAuthority: proven ? 'root-descriptor' : null,
    address: canonicalPointsToAddress(input.address),
    offsetRange: canonicalOffsetRange(input.offsetRange),
    widthBits: input.widthBits == null ? null : Number(input.widthBits),
    evidenceIds: [...new Set((input.evidenceIds ?? []).map(String))].sort(),
  };
  if (proven) target[ROOT_DESCRIPTOR_PROOF] = proof;
  target.rootKey = rootKeyOf(target);
  return deepFreeze(target);
}

/**
 * Canonical root-descriptor proof boundary (#6066).
 *
 * `proof` must be the exact object returned by the canonical root-descriptor
 * producer. Matching `separationClass`/authority strings are insufficient.
 */
export function createRootDescriptorSeparatedTarget(input = {}, proof = null) {
  if (!canonicalProofMetadataIsValid(proof) || !inputMatchesCanonicalProof(input, proof)) {
    fail('phase7-pointsto-root-descriptor-proof-required');
  }
  const target = {
    ...input,
    addressSpace: canonicalAddressSpace(proof.addressSpace),
    rootKind: proofRootKind(proof),
    rootIdentity: proof.rootIdentity ?? null,
    rootEntityId: proof.rootEntityId ?? null,
    separationClass: proof.separationClass,
    separationAuthority: 'root-descriptor',
    [ROOT_DESCRIPTOR_PROOF]: proof,
  };
  return createPointsToTarget(target);
}

/**
 * Consumer-side authority check (#6066).
 *
 * Answers with the target's proof-brand and exact root fields, not with a
 * caller-supplied authority string.
 */
export function provenSeparationAuthority(target) {
  return targetMatchesCanonicalProof(target, target?.[ROOT_DESCRIPTOR_PROOF])
    ? 'root-descriptor'
    : null;
}
/**
 * A points-to set.
 *
 * `top` and an empty `targets` list are different things and must stay
 * different: `top` means "anywhere", empty means "nothing has flowed here yet".
 */
export function createPointsToSet(input = {}) {
  const top = input.top === true;
  // Canonical target order must be locale-independent: rootKey is a digest
  // identity, and localeCompare() ranks non-ASCII identifiers differently per
  // host locale (ICU collation), which would change both the canonical order
  // and pointsToDigest() for the identical semantic set (#5715). UTF-16
  // code-unit order is the same total order stableDigest's string encoding
  // already uses elsewhere in the identity stack.
  // Rebuild every target before sorting so caller-supplied derived rootKey
  // values cannot become same-root proof authority (#4712). This also keeps
  // set construction safe when a producer passes a plain target object rather
  // than one returned by createPointsToTarget().
  const targets = top ? [] : [...(input.targets ?? [])]
    .map((target) => createPointsToTarget(target))
    .sort((a, b) => (a.rootKey < b.rootKey ? -1 : a.rootKey > b.rootKey ? 1 : 0));
  const lossReasons = [...new Set(input.lossReasons ?? [])].sort();
  // A loss reason outside the declared vocabulary would be an unexplainable
  // imprecision: the alias layer maps these onto proof reasons, and a free-form
  // string there becomes an answer nobody can account for.
  for (const reason of lossReasons) {
    if (!PROVENANCE_LOSS_REASONS.includes(reason)) fail(`points-to-unknown-loss-reason:${reason}`);
  }
  return deepFreeze({
    top,
    targets: deepFreeze(targets),
    lossReasons: deepFreeze(lossReasons),
  });
}

export const BOTTOM_POINTS_TO = createPointsToSet({ targets: [] });
export function topPointsTo(reason) {
  return createPointsToSet({ top: true, lossReasons: reason ? [reason] : ['unsupported-operation'] });
}

export function pointsToIsBottom(set) {
  return !set.top && set.targets.length === 0;
}

/**
 * Set join. Same-root targets merge their ranges; distinct roots accumulate
 * until the target cap, at which point the set collapses to TOP rather than
 * silently dropping a target (dropping one would falsely prove separation).
 */
export function joinPointsTo(a, b, budget = POINTS_TO_DEFAULT_BUDGET) {
  const targetLimit = maxTargetsPerSet(budget);
  if (a.top || b.top) {
    return createPointsToSet({ top: true, lossReasons: [...a.lossReasons, ...b.lossReasons] });
  }
  const byRoot = new Map();
  for (const target of [...a.targets, ...b.targets]) {
    const prior = byRoot.get(target.rootKey);
    if (!prior) { byRoot.set(target.rootKey, target); continue; }
    byRoot.set(target.rootKey, createPointsToTarget({
      ...prior,
      offsetRange: joinRange(prior.offsetRange, target.offsetRange),
      widthBits: prior.widthBits === target.widthBits ? prior.widthBits : null,
      evidenceIds: [...prior.evidenceIds, ...target.evidenceIds],
    }));
  }
  if (byRoot.size > targetLimit) {
    return createPointsToSet({ top: true, lossReasons: [...a.lossReasons, ...b.lossReasons, 'target-cap'] });
  }
  return createPointsToSet({
    targets: [...byRoot.values()],
    lossReasons: [...a.lossReasons, ...b.lossReasons],
  });
}

/** Widening applied at loop headers once the iteration threshold is passed. */
export function widenPointsTo(previous, next, budget = POINTS_TO_DEFAULT_BUDGET) {
  const targetLimit = maxTargetsPerSet(budget);
  if (next.top) return next;
  if (previous == null) return next;
  if (previous.top) return previous;
  const priorByRoot = new Map(previous.targets.map((target) => [target.rootKey, target]));
  // A root that only `previous` holds must survive widening: widening may lose
  // precision but never drops a known reachable root — dropping it broke the
  // upper-bound law (previous ⊑ widened) and let the fixed point "converge"
  // below its own past state (#5358).
  const rootsOnlyInPrevious = previous.targets.filter((target) => !next.targets.some((candidate) => candidate.rootKey === target.rootKey));
  let anyWidened = false;
  const targets = next.targets.map((target) => {
    const prior = priorByRoot.get(target.rootKey);
    if (!prior) return target;
    const widenedRange = widenRange(prior.offsetRange, target.offsetRange);
    // Compare by value, not by object identity: widenRange always allocates,
    // so an identity check would report every stable range as widened and the
    // fixed point would never look converged.
    if (widenedRange.min !== target.offsetRange.min || widenedRange.max !== target.offsetRange.max) {
      anyWidened = true;
    }
    return createPointsToTarget({ ...target, offsetRange: widenedRange });
  });
  if (rootsOnlyInPrevious.length) anyWidened = true;
  const merged = [...targets, ...rootsOnlyInPrevious];
  if (merged.length > targetLimit) {
    return topPointsTo('target-cap');
  }
  return createPointsToSet({
    targets: merged,
    lossReasons: [...previous.lossReasons, ...next.lossReasons, ...(anyWidened ? ['widened'] : [])],
  });
}

/** Structural equality, used as the fixed-point stop condition. */
export function pointsToEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return pointsToDigest(a) === pointsToDigest(b);
}

export function pointsToDigest(set) {
  return stableDigest({
    top: set.top,
    lossReasons: set.lossReasons,
    targets: set.targets.map((target) => ({
      rootKey: target.rootKey,
      min: target.offsetRange.min == null ? null : target.offsetRange.min.toString(),
      max: target.offsetRange.max == null ? null : target.offsetRange.max.toString(),
      widthBits: target.widthBits,
      // Join unions provenance ids; the fixed-point equality must observe
      // that growth or a join that only adds provenance looks equal to its
      // input and the merged provenance never reaches the solved state
      // (#5629). Target construction keeps this list deduped and sorted, so
      // the digest stays canonical for identical semantic sets.
      evidenceIds: target.evidenceIds,
    })),
  });
}

/**
 * Monotonicity check used by the property tests: a join must never be lower in
 * the lattice than either input.
 */
export function pointsToLessOrEqual(a, b) {
  if (b.top) return true;
  if (a.top) return false;
  for (const target of a.targets) {
    const other = b.targets.find((candidate) => candidate.rootKey === target.rootKey);
    if (!other) return false;
    const inner = target.offsetRange;
    const outer = other.offsetRange;
    if (outer.min != null && (inner.min == null || inner.min < outer.min)) return false;
    if (outer.max != null && (inner.max == null || inner.max > outer.max)) return false;
  }
  return true;
}
