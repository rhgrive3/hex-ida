/**
 * Wrapped range domain.
 *
 * A range here is a set of values on Z/2^n, represented as an interval that may
 * wrap around the end of the width: `[0xFFFFFFF0, 0x0000000F]` at 32 bits is the
 * 32 values around zero, not the empty set and not everything. Machine
 * arithmetic wraps, so a domain that cannot represent a wrapped set has to
 * answer "unknown" for the most common loop counters, or — much worse — answer
 * with an unwrapped interval that excludes values the program can actually
 * reach.
 *
 * The rule this module follows everywhere: when an operation cannot be
 * represented exactly, widen to the full width rather than invent a tighter
 * answer. False precision in a decompiler becomes a confident wrong claim in the
 * user interface, which is the one failure the architecture forbids outright.
 */

import { bitvector, evaluateBinary, isSupportedWidth, maxUnsigned, signedOf, unsignedOf } from './bitvector.js';

function fail(code) { throw new TypeError(code); }

/** Every value of the width. The safe answer. */
export function fullRange(bits) {
  if (!isSupportedWidth(bits)) fail(`phase8-range-unsupported-width:${bits}`);
  return Object.freeze({ bits: Number(bits), kind: 'full', lower: 0n, upper: maxUnsigned(bits) });
}

/** No value at all. Produced by meeting disjoint facts, never by guessing. */
export function emptyRange(bits) {
  if (!isSupportedWidth(bits)) fail(`phase8-range-unsupported-width:${bits}`);
  return Object.freeze({ bits: Number(bits), kind: 'empty', lower: 0n, upper: 0n });
}

/**
 * The inclusive interval from `lower` up to `upper`, wrapping if `upper` is
 * numerically below `lower`.
 */
export function rangeOf(lower, upper, bits) {
  if (!isSupportedWidth(bits)) fail(`phase8-range-unsupported-width:${bits}`);
  const low = unsignedOf(lower, bits);
  const high = unsignedOf(upper, bits);
  // An interval that covers the whole width is `full`, however it was written,
  // so two spellings of "everything" compare equal.
  if (low === unsignedOf(high + 1n, bits)) return fullRange(bits);
  return Object.freeze({ bits: Number(bits), kind: low <= high ? 'interval' : 'wrapped', lower: low, upper: high });
}

export function singleton(constant) {
  return rangeOf(constant.value, constant.value, constant.bits);
}

const NO_CONGRUENCE = Object.freeze({ remainder: 0n, modulus: 1n });
const EMPTY_PROVENANCE = Object.freeze({});
const DEEPLY_FROZEN_CACHE = new WeakMap();
const ACYCLIC_EVIDENCE_CACHE = new WeakMap();
const EVIDENCE_FIELDS = Object.freeze(['knownZero', 'knownOne', 'congruence', 'alignment', 'pointerOffset', 'provenance']);
const COMPARISON_OPERATORS = new Set(['eq', 'ne', 'ult', 'ule', 'ugt', 'uge', 'slt', 'sle', 'sgt', 'sge', '=', '==', '!=', '<', '<=', '>', '>=']);
const VALID_FACT_STATUSES = new Set(['exact', 'conservative']);

function widthMask(bits) { return maxUnsigned(bits); }

function asMask(value, bits) {
  try { return unsignedOf(value ?? 0n, bits); } catch { return 0n; }
}

function parseBoundedMaskEvidence(value, bits) {
  if (value == null) return { value: null, malformed: false };
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    return { value: null, malformed: true };
  }
  try {
    const parsed = BigInt(value);
    if (parsed < 0n || parsed > widthMask(bits)) return { value: null, malformed: true };
    return { value: parsed, malformed: false };
  } catch {
    return { value: null, malformed: true };
  }
}

function gcd(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) { const next = a % b; a = b; b = next; }
  return a;
}

function normalizeCongruenceValue(congruence, bits) {
  const parsed = parseCongruenceValue(congruence, bits);
  // A residue class survives adding the machine modulus only when its modulus
  // divides that modulus. Keeping a non-divisor through wraparound would make
  // the published class depend on an operation that changed the represented
  // integer, which is false exactness.
  const width = 1n << BigInt(bits);
  return parsed == null || parsed.modulus <= 1n || width % parsed.modulus !== 0n ? NO_CONGRUENCE : parsed;
}

/* Keep malformed upstream residue evidence distinguishable from the valid
 * modulus-one spelling of "no useful residue".  Callers that only need a
 * conservative projection use normalizeCongruenceValue(); publication uses
 * this parser to prevent malformed evidence from retaining exactness. */
function parseCongruenceValue(congruence, bits) {
  const width = 1n << BigInt(bits);
  if (congruence == null || typeof congruence !== 'object') return null;
  let modulus;
  let remainder;
  try {
    modulus = BigInt(congruence.modulus);
    remainder = BigInt(congruence.remainder);
  } catch {
    return null;
  }
  if (modulus <= 0n || modulus > width) return null;
  remainder = ((remainder % modulus) + modulus) % modulus;
  return Object.freeze({ remainder, modulus });
}

/** Normalize a residue without exposing an alternate scalar domain. */
export function normalizeCongruence(congruence, bits) {
  if (!isSupportedWidth(bits)) fail(`phase8-range-unsupported-width:${bits}`);
  return normalizeCongruenceValue(congruence, Number(bits));
}

function commonCongruence(left, right, bits) {
  const first = normalizeCongruenceValue(left, bits);
  const second = normalizeCongruenceValue(right, bits);
  const modulus = gcd(gcd(first.modulus, second.modulus), first.remainder - second.remainder);
  if (modulus <= 1n) return NO_CONGRUENCE;
  return Object.freeze({ remainder: first.remainder % modulus, modulus });
}

function addCongruence(left, right, bits, subtract = false) {
  const first = normalizeCongruenceValue(left, bits);
  const second = normalizeCongruenceValue(right, bits);
  const modulus = gcd(first.modulus, second.modulus);
  if (modulus <= 1n) return NO_CONGRUENCE;
  const raw = subtract ? first.remainder - second.remainder : first.remainder + second.remainder;
  return Object.freeze({ remainder: ((raw % modulus) + modulus) % modulus, modulus });
}

function multiplyCongruence(fact, constant, bits) {
  const normalized = normalizeCongruenceValue(fact, bits);
  const width = 1n << BigInt(bits);
  const multiplier = unsignedOf(constant, bits);
  if (multiplier === 0n) return Object.freeze({ remainder: 0n, modulus: width });
  const modulus = gcd(width, multiplier * normalized.modulus);
  if (modulus <= 1n) return NO_CONGRUENCE;
  return Object.freeze({ remainder: (multiplier * normalized.remainder) % modulus, modulus });
}

function singletonValue(range) {
  return !isEmpty(range) && cardinality(range) === 1n ? range.lower : null;
}

function combinedFactStatus(left, right, exactStatus = 'conservative') {
  const statuses = [left?.status, right?.status].filter((status) => status != null);
  const invalid = statuses.find((status) => !VALID_FACT_STATUSES.has(status));
  if (invalid != null) return invalid;
  if (statuses.includes('conservative')) return 'conservative';
  return exactStatus;
}

function maskFactsForConstant(mask, bits, operand) {
  const normalizedMask = asMask(mask, bits);
  const widthMaskValue = widthMask(bits);
  const operandZero = asMask(operand?.knownZero, bits);
  const operandOne = asMask(operand?.knownOne, bits);
  let trailing = 0;
  while (trailing < bits && ((normalizedMask >> BigInt(trailing)) & 1n) === 0n) trailing += 1;
  const modulus = trailing >= bits ? (1n << BigInt(bits)) : (1n << BigInt(trailing));
  return {
    knownZero: (operandZero | (widthMaskValue ^ normalizedMask)) & widthMaskValue,
    knownOne: operandOne & normalizedMask,
    congruence: Object.freeze({ remainder: 0n, modulus }),
  };
}

function deeplyFrozen(value, seen = new Set()) {
  if (value == null || typeof value !== 'object') return true;
  if (DEEPLY_FROZEN_CACHE.get(value) === true) return true;
  if (!Object.isFrozen(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  let result = false;
  try {
    result = Object.keys(value).every((key) => deeplyFrozen(value[key], seen));
  } catch {
    result = false;
  }
  seen.delete(value);
  if (result) DEEPLY_FROZEN_CACHE.set(value, true);
  return result;
}

function immutableProvenance(provenance) {
  if (!provenance || typeof provenance !== 'object') return EMPTY_PROVENANCE;
  if (deeplyFrozen(provenance)) return provenance;
  return immutableEvidence(provenance);
}

function immutableEvidence(value) {
  return immutableEvidenceWithSeen(value, new Set());
}

function immutableEvidenceWithSeen(value, seen) {
  if (value == null || typeof value !== 'object') return value;
  if (deeplyFrozen(value)) return value;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    const copy = value.map((item) => immutableEvidenceWithSeen(item, seen));
    seen.delete(value);
    return Object.freeze(copy);
  }
  const copy = {};
  try {
    for (const key of Object.keys(value).sort()) copy[key] = immutableEvidenceWithSeen(value[key], seen);
  } catch {
    seen.delete(value);
    return null;
  }
  seen.delete(value);
  return Object.freeze(copy);
}

/** Returns false for a cyclic or hostile evidence object without recursing. */
function acyclicEvidence(root) {
  if (root == null || typeof root !== 'object') return true;
  const cached = ACYCLIC_EVIDENCE_CACHE.get(root);
  if (cached != null) return cached;
  const active = new Set();
  const visited = new Set();
  const stack = [{ value: root, exit: false }];
  try {
    while (stack.length > 0) {
      const frame = stack.pop();
      const value = frame.value;
      if (value == null || typeof value !== 'object') continue;
      if (frame.exit) {
        active.delete(value);
        continue;
      }
      if (active.has(value)) return false;
      if (visited.has(value)) continue;
      visited.add(value);
      active.add(value);
      stack.push({ value, exit: true });
      for (const key of Object.keys(value)) stack.push({ value: value[key], exit: false });
    }
    // A positive cache entry is safe only for a deeply frozen graph; otherwise
    // a caller could mutate a nested evidence object into a cycle later.
    if (deeplyFrozen(root)) ACYCLIC_EVIDENCE_CACHE.set(root, true);
    return true;
  } catch {
    return false;
  }
}

function evidenceIsAcyclic(options) {
  return EVIDENCE_FIELDS.every((field) => acyclicEvidence(options?.[field]));
}

function mergeProvenance(left, right) {
  if (left === right && left != null) return left;
  if (left == null && right == null) return EMPTY_PROVENANCE;
  if (left == null) return immutableProvenance(right);
  if (right == null) return immutableProvenance(left);
  if (sameProvenance(left, right)) return left;
  const merged = {};
  for (const source of [left, right]) {
    if (!source || typeof source !== 'object') continue;
    for (const key of Object.keys(source)) {
      const value = source[key];
      if (Array.isArray(value)) merged[key] = [...new Set([...(merged[key] ?? []), ...value])].sort();
      else if (merged[key] == null) merged[key] = value;
    }
  }
  return immutableProvenance(merged);
}

// Provenance is on the hot path of every product-fact join.  Keep the generic
// descriptor comparator for alignment/pointer evidence, but compare the
// canonical provenance shape without sorting object keys or recursing through
// its instruction-id array on every revisit.
function sameProvenance(left, right) {
  if (left === right) return true;
  if (left == null || right == null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (left.valueId !== right.valueId || left.definitionBlock !== right.definitionBlock) return false;
  const leftIds = left.instructionIds;
  const rightIds = right.instructionIds;
  if (leftIds === rightIds) return true;
  if (!Array.isArray(leftIds) || !Array.isArray(rightIds) || leftIds.length !== rightIds.length) return false;
  for (let index = 0; index < leftIds.length; index += 1) {
    if (leftIds[index] !== rightIds[index]) return false;
  }
  const leftKeys = Object.keys(left).filter((key) => key !== 'valueId' && key !== 'definitionBlock' && key !== 'instructionIds').sort();
  const rightKeys = Object.keys(right).filter((key) => key !== 'valueId' && key !== 'definitionBlock' && key !== 'instructionIds').sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameEvidence(left[key], right[key]));
}

/* Descriptors are upstream evidence and may contain BigInt offsets.  Keep a
 * join from retaining one path's descriptor when the other disagrees without
 * using JSON.stringify (which cannot represent BigInt). */
function sameEvidence(left, right) {
  if (left === right) return true;
  if (left == null || right == null || typeof left !== typeof right) return false;
  if (typeof left === 'bigint' || typeof left !== 'object') return left === right;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameEvidence(value, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameEvidence(left[key], right[key]));
}

function congruenceFromAlignment(alignment) {
  if (alignment == null) return null;
  if (typeof alignment === 'bigint' || typeof alignment === 'number') {
    return { modulus: alignment, remainder: 0n };
  }
  if (typeof alignment !== 'object') return null;
  if (alignment.modulus != null && alignment.remainder != null) {
    return { modulus: alignment.modulus, remainder: alignment.remainder };
  }
  if (alignment.alignment != null) return { modulus: alignment.alignment, remainder: 0n };
  return null;
}

function shiftedAlignment(alignment, delta, bits) {
  if (alignment == null || delta == null) return null;
  const congruence = normalizeCongruenceValue(congruenceFromAlignment(alignment), bits);
  if (congruence.modulus <= 1n) return alignment;
  const remainder = ((congruence.remainder + delta) % congruence.modulus + congruence.modulus) % congruence.modulus;
  if (typeof alignment === 'number' || typeof alignment === 'bigint') {
    return Object.freeze({ modulus: congruence.modulus, remainder });
  }
  return Object.freeze({ ...alignment, modulus: congruence.modulus, remainder });
}

function shiftedPointerOffset(pointerOffset, delta) {
  if (pointerOffset == null || delta == null || typeof pointerOffset !== 'object') return null;
  if (pointerOffset.baseId == null || pointerOffset.offset == null) return null;
  try {
    return Object.freeze({ ...pointerOffset, offset: BigInt(pointerOffset.offset) + BigInt(delta) });
  } catch {
    return null;
  }
}

function validPointerOffsetEvidence(pointerOffset) {
  if (pointerOffset == null) return true;
  if (typeof pointerOffset !== 'object' || Array.isArray(pointerOffset)) return false;
  if (pointerOffset.baseId == null || pointerOffset.offset == null) return false;
  try {
    BigInt(pointerOffset.offset);
    return true;
  } catch {
    return false;
  }
}

function validRangeShape(range) {
  if (range == null || !isSupportedWidth(range.bits)) return false;
  if (!['full', 'empty', 'interval', 'wrapped'].includes(range.kind)) return false;
  try {
    const lower = unsignedOf(range.lower, range.bits);
    const upper = unsignedOf(range.upper, range.bits);
    if (range.kind === 'full') return lower === 0n && upper === maxUnsigned(range.bits);
    if (range.kind === 'empty') return lower === 0n && upper === 0n;
    if (range.kind === 'interval') return lower <= upper;
    return lower > upper;
  } catch {
    return false;
  }
}

/**
 * Build the one canonical scalar fact used by SCCP and its consumers.
 *
 * `range` remains the compatibility representation. Masks and residues are
 * evidence about that same set, never an independent value analysis.
 */
export function factFromRange(range, options = {}) {
  if (!validRangeShape(range)) {
    const bits = Number(options.bits ?? range?.bits ?? 1);
    if (!isSupportedWidth(bits)) return Object.freeze({ bits, range: null, status: 'malformed', reason: 'unsupported width', provenance: Object.freeze({}) });
    range = fullRange(bits);
    options = { ...options, status: 'malformed', reason: options.reason ?? 'malformed range' };
  }
  const bits = Number(range.bits);
  const hasEvidence = EVIDENCE_FIELDS.some((field) => options[field] != null);
  if (!hasEvidence) return simpleFactFromRange(range, options, bits);
  // SCCP evaluates ordinary arithmetic values with an explicit zero mask and
  // modulus-one residue to say "no additional evidence".  Those primitive
  // spellings are already validated by construction; sending them through the
  // recursive evidence freezer on every work-list visit made the hot path
  // sensitive to GC pauses and could turn a bounded complete pass into a
  // deadline cancellation.  Keep the same semantics, including an explicitly
  // supplied modulus-one residue, while reserving the rich validator for real
  // masks, residues, provenance, alignment, and pointer evidence.
  if (hasOnlyTrivialEvidence(options)) {
    return simpleFactFromRange(range, options, bits, options.congruence != null);
  }
  const mask = widthMask(bits);
  const cyclicEvidence = !evidenceIsAcyclic(options);
  const parsedKnownZero = cyclicEvidence ? { value: null, malformed: true } : parseBoundedMaskEvidence(options.knownZero, bits);
  const parsedKnownOne = cyclicEvidence ? { value: null, malformed: true } : parseBoundedMaskEvidence(options.knownOne, bits);
  const knownZeroEvidence = parsedKnownZero.value;
  const knownOneEvidence = parsedKnownOne.value;
  const maskEvidenceMalformed = parsedKnownZero.malformed || parsedKnownOne.malformed;
  let knownZero = knownZeroEvidence ?? 0n;
  let knownOne = knownOneEvidence ?? 0n;
  let status = options.status ?? null;
  let reason = options.reason ?? null;
  const masksOverlap = knownZeroEvidence != null && knownOneEvidence != null
    && (knownZeroEvidence & knownOneEvidence) !== 0n;
  const masksHaveNoCommonValue = (knownZeroEvidence != null || knownOneEvidence != null)
    && !maskEvidenceMalformed
    && !masksOverlap
    && !rangeHasMaskValue(range, knownZero, knownOne);
  if (cyclicEvidence || maskEvidenceMalformed || masksOverlap || masksHaveNoCommonValue) {
    knownZero = 0n;
    knownOne = 0n;
    status = 'malformed';
    reason = reason ?? (cyclicEvidence ? 'cyclic evidence'
      : maskEvidenceMalformed ? 'malformed or out-of-width known-bit evidence'
        : masksOverlap ? 'known-zero and known-one masks overlap'
          : 'known-bit evidence conflicts with range');
  }
  const value = singletonValue(range);
  const singletonMaskConflict = value != null
    && ((knownZeroEvidence != null && (knownZeroEvidence & value) !== 0n)
      || (knownOneEvidence != null && (knownOneEvidence & (mask ^ value)) !== 0n));
  if (singletonMaskConflict) {
    status = 'malformed';
    reason = reason ?? 'known-bit evidence conflicts with singleton range';
  }
  if (value != null && options.deriveKnownBits !== false && !maskEvidenceMalformed && !masksHaveNoCommonValue
      && !cyclicEvidence && !singletonMaskConflict && (knownZeroEvidence == null || knownOneEvidence == null
        || !masksOverlap)) {
    knownZero = mask ^ value;
    knownOne = value;
  }
  const alignmentCongruence = cyclicEvidence ? null : congruenceFromAlignment(options.alignment);
  const alignmentValue = alignmentCongruence == null ? null : parseCongruenceValue(alignmentCongruence, bits);
  const congruenceValue = cyclicEvidence || options.congruence == null ? null : parseCongruenceValue(options.congruence, bits);
  const alignmentMalformed = cyclicEvidence || (options.alignment != null
    && (alignmentCongruence == null || alignmentValue == null));
  const congruenceMalformed = cyclicEvidence || (options.congruence != null && congruenceValue == null);
  const pointerOffsetMalformed = cyclicEvidence || !validPointerOffsetEvidence(options.pointerOffset);
  const requestedCongruence = congruenceMalformed ? null : options.congruence ?? alignmentCongruence;
  const requestedCongruenceValue = requestedCongruence == null ? null : parseCongruenceValue(requestedCongruence, bits);
  const singletonCongruenceConflict = value != null && requestedCongruenceValue != null
    && ((value - requestedCongruenceValue.remainder) % requestedCongruenceValue.modulus + requestedCongruenceValue.modulus)
      % requestedCongruenceValue.modulus !== 0n;
  const rangeCongruenceConflict = !alignmentMalformed && !congruenceMalformed
    && requestedCongruenceValue != null && !rangeHasCongruenceValue(range, requestedCongruenceValue);
  // A mask and a residue are conjunctive evidence about one abstract set.  It
  // is not enough for each projection to intersect the range independently:
  // `x & 1 == 0` and `x == 1 (mod 2)` have no common value even over fullRange.
  // Only divisor-of-2^bits residues are retained; non-divisor residues are
  // deliberately dropped as a conservative projection below.
  const normalizedRequestedCongruence = requestedCongruenceValue == null
    ? NO_CONGRUENCE : normalizeCongruenceValue(requestedCongruenceValue, bits);
  const maskCongruenceConflict = !alignmentMalformed && !congruenceMalformed
    && normalizedRequestedCongruence.modulus > 1n
    && !rangeHasMaskAndCongruenceValue(range, knownZero, knownOne, normalizedRequestedCongruence);
  if (alignmentMalformed || congruenceMalformed || pointerOffsetMalformed || singletonCongruenceConflict
      || rangeCongruenceConflict || maskCongruenceConflict) {
    if (singletonCongruenceConflict || rangeCongruenceConflict || maskCongruenceConflict) {
      knownZero = 0n;
      knownOne = 0n;
    }
    status = 'malformed';
    reason = reason ?? (cyclicEvidence ? 'cyclic evidence'
      : alignmentMalformed ? 'malformed alignment evidence'
      : congruenceMalformed ? 'malformed congruence evidence'
        : pointerOffsetMalformed ? 'malformed pointer-offset evidence'
          : singletonCongruenceConflict ? 'congruence evidence conflicts with singleton range'
            : rangeCongruenceConflict ? 'congruence evidence conflicts with range'
              : 'known-bit and congruence evidence have no common value');
  }
  const congruence = requestedCongruence == null && value != null && !cyclicEvidence
      && !alignmentMalformed && !congruenceMalformed
    ? Object.freeze({ remainder: value, modulus: 1n << BigInt(bits) })
    : (rangeCongruenceConflict || singletonCongruenceConflict || maskCongruenceConflict || cyclicEvidence
      ? NO_CONGRUENCE : normalizeCongruenceValue(requestedCongruence, bits));
  if (status == null) status = value == null ? 'conservative' : 'exact';
  // Only a complete, valid fact may carry an exact constant.  In particular,
  // an unsupported or stale singleton-shaped payload is still not permission
  // to fold: shape is not proof of semantic validity.
  const constant = value == null || !['exact', 'conservative'].includes(status)
    ? null
    : bitvector(value, bits);
  if (isFull(range) && reason == null) reason = 'unconstrained';
  if (isEmpty(range) && status === 'exact') status = 'conservative';
  return Object.freeze({
    valueId: options.valueId ?? null,
    bits,
    range,
    knownZero,
    knownOne,
    congruence,
    alignment: alignmentMalformed ? null : immutableEvidence(options.alignment ?? null),
    pointerOffset: pointerOffsetMalformed ? null : immutableEvidence(options.pointerOffset ?? null),
    constant,
    status,
    reason,
    provenance: cyclicEvidence ? EMPTY_PROVENANCE : immutableProvenance(options.provenance),
  });
}

export function fullFact(bits, options = {}) {
  return factFromRange(fullRange(bits), { ...options, status: options.status ?? 'conservative', reason: options.reason ?? 'unconstrained' });
}

export function emptyFact(bits, options = {}) {
  return factFromRange(emptyRange(bits), { ...options, status: options.status ?? 'conservative', reason: options.reason ?? 'empty set' });
}

export function singletonFact(constant, options = {}) {
  const value = typeof constant === 'object' && constant != null ? constant : bitvector(constant, options.bits);
  return factFromRange(singleton(value), { ...options, status: options.status ?? 'exact', provenance: options.provenance });
}

export function sameFact(left, right) {
  if (left == null || right == null) return left === right;
  return left.bits === right.bits && sameRange(left.range, right.range)
    && left.knownZero === right.knownZero && left.knownOne === right.knownOne
    && left.congruence.remainder === right.congruence.remainder
    && left.congruence.modulus === right.congruence.modulus
    && sameEvidence(left.alignment, right.alignment)
    && sameEvidence(left.pointerOffset, right.pointerOffset)
    && left.status === right.status && left.reason === right.reason;
}

/** Sound union of two product facts. */
export function joinFacts(left, right, options = {}) {
  if (left == null) return right;
  if (right == null) return left;
  if (left.bits !== right.bits) return fullFact(Math.max(left.bits, right.bits), { reason: 'fact widths disagree' });
  if (isEmpty(left.range)) {
    if (!VALID_FACT_STATUSES.has(left.status)) return fullFact(left.bits, { status: left.status, reason: 'invalid empty fact' });
    return right;
  }
  if (isEmpty(right.range)) {
    if (!VALID_FACT_STATUSES.has(right.status)) return fullFact(right.bits, { status: right.status, reason: 'invalid empty fact' });
    return left;
  }
  const range = join(left.range, right.range);
  return factFromRange(range, {
    knownZero: left.knownZero & right.knownZero,
    knownOne: left.knownOne & right.knownOne,
    congruence: commonCongruence(left.congruence, right.congruence, left.bits),
    alignment: left.alignment != null && right.alignment != null && sameEvidence(left.alignment, right.alignment) ? left.alignment : null,
    pointerOffset: left.pointerOffset != null && right.pointerOffset != null && sameEvidence(left.pointerOffset, right.pointerOffset) ? left.pointerOffset : null,
    status: combinedFactStatus(left, right),
    reason: left.reason === right.reason ? left.reason : 'joined scalar facts',
    deriveKnownBits: false,
    provenance: options.provenance === false ? null : mergeProvenance(left.provenance, right.provenance),
  });
}

/** Monotone bounded widening for the product domain. */
export function widenFacts(previous, next) {
  if (previous == null) return next;
  if (next == null) return previous;
  if (sameFact(previous, next)) return next;
  const range = widen(previous.range, next.range);
  return factFromRange(range, {
    knownZero: previous.knownZero & next.knownZero,
    knownOne: previous.knownOne & next.knownOne,
    congruence: NO_CONGRUENCE,
    status: combinedFactStatus(previous, next),
    reason: 'product fact widened at bounded fixed point',
    deriveKnownBits: false,
    provenance: mergeProvenance(previous.provenance, next.provenance),
  });
}

function factInput(value) {
  if (value?.range && value?.bits != null) {
    return validRangeShape(value.range) && Number(value.bits) === Number(value.range.bits) ? value : null;
  }
  return value?.bits != null && value?.kind != null ? factFromRange(value) : null;
}

function constantFromFact(fact) {
  // A partial, malformed, or explicitly unknown fact cannot be promoted back
  // to an exact operand merely because its range happens to be a singleton.
  if (fact == null || !['exact', 'conservative'].includes(fact.status)) return null;
  if (fact?.constant != null) return fact.constant.value;
  return singletonValue(fact?.range);
}

/** Width-exact product-domain binary evaluation. */
export function evaluateBinaryFact(operator, leftInput, rightInput, options = {}) {
  const left = factInput(leftInput);
  const right = factInput(rightInput);
  const bits = Number(left?.bits ?? right?.bits ?? 0);
  if (!isSupportedWidth(bits)) return fullFact(32, { status: 'malformed', reason: 'unsupported operand width' });
  if (left == null || right == null) return fullFact(bits, { status: 'unknown', reason: 'missing scalar fact' });
  if (!isSupportedWidth(left.bits) || !isSupportedWidth(right.bits)) {
    return fullFact(isSupportedWidth(left.bits) ? left.bits : 32, { status: 'malformed', reason: 'unsupported operand width' });
  }
  if (isEmpty(left.range) || isEmpty(right.range)) return emptyFact(bits);
  if (right.bits !== bits && !['shl', 'lshr', 'ashr'].includes(operator)) return fullFact(bits, { reason: 'operands have different widths' });
  const combined = evaluateBinaryRange(operator, left.range, right.range);
  let knownZero = 0n;
  let knownOne = 0n;
  let congruence = NO_CONGRUENCE;
  let alignment = null;
  let pointerOffset = null;
  const leftConstant = constantFromFact(left);
  const rightConstant = constantFromFact(right);
  if (COMPARISON_OPERATORS.has(operator)) {
    if (left.bits !== right.bits) return fullFact(1, { status: 'malformed', reason: 'comparison operands have different widths' });
    if (leftConstant != null && rightConstant != null) {
      const folded = evaluateBinary(normalizedComparison(operator), bitvector(leftConstant, left.bits), bitvector(rightConstant, right.bits));
      if (folded != null) return factFromRange(singleton(folded), {
        status: combinedFactStatus(left, right, 'exact'),
        provenance: options.provenance === false ? null : mergeProvenance(left.provenance, right.provenance),
      });
    }
    return fullFact(1, {
      status: 'conservative',
      reason: `comparison ${operator} is not a proven singleton`,
      provenance: options.provenance === false ? null : mergeProvenance(left.provenance, right.provenance),
    });
  }
  const mask = widthMask(bits);
  if (operator === 'add' || operator === 'sub') {
    congruence = addCongruence(left.congruence, right.congruence, bits, operator === 'sub');
    // Carries make addition bit facts non-local.  Without a carry proof, an
    // apparently zero bit in both operands can become one in the sum.
    knownZero = 0n;
    knownOne = 0n;
    if (rightConstant != null && left.pointerOffset != null) {
      const delta = operator === 'sub' ? -rightConstant : rightConstant;
      pointerOffset = shiftedPointerOffset(left.pointerOffset, delta);
      alignment = shiftedAlignment(left.alignment, delta, bits);
    } else if (operator === 'add' && leftConstant != null && right.pointerOffset != null) {
      pointerOffset = shiftedPointerOffset(right.pointerOffset, leftConstant);
      alignment = shiftedAlignment(right.alignment, leftConstant, bits);
    }
  } else if (operator === 'and' && rightConstant != null) {
    ({ knownZero, knownOne, congruence } = maskFactsForConstant(rightConstant, bits, left));
  } else if (operator === 'and' && leftConstant != null) {
    ({ knownZero, knownOne, congruence } = maskFactsForConstant(leftConstant, bits, right));
  } else if (operator === 'or' && rightConstant != null) {
    const c = unsignedOf(rightConstant, bits);
    knownOne = (left.knownOne | c) & mask;
    knownZero = left.knownZero & (mask ^ c);
  } else if (operator === 'or' && leftConstant != null) {
    const c = unsignedOf(leftConstant, bits);
    knownOne = (right.knownOne | c) & mask;
    knownZero = right.knownZero & (mask ^ c);
  } else if (operator === 'xor' && rightConstant != null) {
    const c = unsignedOf(rightConstant, bits);
    knownOne = ((left.knownOne & (mask ^ c)) | (left.knownZero & c)) & mask;
    knownZero = ((left.knownZero & (mask ^ c)) | (left.knownOne & c)) & mask;
  } else if (operator === 'xor' && leftConstant != null) {
    const c = unsignedOf(leftConstant, bits);
    knownOne = ((right.knownOne & (mask ^ c)) | (right.knownZero & c)) & mask;
    knownZero = ((right.knownZero & (mask ^ c)) | (right.knownOne & c)) & mask;
  } else if (['shl', 'lshr', 'ashr'].includes(operator) && rightConstant != null) {
    const amount = rightConstant;
    if (amount < BigInt(bits)) {
      const shift = BigInt(amount);
      if (operator === 'shl') {
        knownZero = ((left.knownZero << shift) | ((1n << shift) - 1n)) & mask;
        knownOne = (left.knownOne << shift) & mask;
        const sourceCongruence = left.congruence;
        const shiftedModulus = gcd(1n << BigInt(bits), sourceCongruence.modulus << shift);
        congruence = Object.freeze({ remainder: (sourceCongruence.remainder << shift) % shiftedModulus, modulus: shiftedModulus });
      } else {
        const shiftedMask = mask >> shift;
        // Logical right shift introduces zeroes in the high lanes.  For ASHR
        // these are not necessarily zero, so this conservative projection is
        // intentionally only used for the logical operator.
        knownZero = operator === 'lshr'
          ? ((left.knownZero >> shift) | (mask ^ shiftedMask)) & mask
          : (left.knownZero >> shift) & mask;
        knownOne = (left.knownOne >> shift) & mask;
      }
    }
  } else if (operator === 'mul' && rightConstant != null) {
    congruence = multiplyCongruence(left.congruence, rightConstant, bits);
  } else if (operator === 'mul' && leftConstant != null) {
    congruence = multiplyCongruence(right.congruence, leftConstant, bits);
  }
  return factFromRange(combined.range.bits === bits ? combined.range : fullRange(bits), {
    knownZero,
    knownOne,
    congruence,
    alignment,
    pointerOffset,
    status: combinedFactStatus(left, right, combined.exact && cardinality(combined.range) === 1n ? 'exact' : 'conservative'),
    reason: combined.reason,
    deriveKnownBits: false,
    provenance: options.provenance === false ? null : mergeProvenance(left.provenance, right.provenance),
  });
}

function rangeSegments(range) {
  if (isEmpty(range)) return [];
  if (isFull(range)) return [[0n, widthMask(range.bits)]];
  if (range.kind === 'wrapped') return [[range.lower, widthMask(range.bits)], [0n, range.upper]];
  return [[range.lower, range.upper]];
}

/**
 * Evidence may refine an interval without being implied by its hull.  Validate
 * consistency by asking whether the intersection is non-empty, rather than
 * requiring every value in the deliberately lossy hull to carry the evidence.
 */
function rangeHasMaskValue(range, knownZero, knownOne) {
  if (isEmpty(range)) return true;
  // Every non-overlapping mask assignment has a witness in the full machine
  // domain. This is the common conservative fact and avoids a bit-DP walk on
  // every unconstrained SCCP value.
  if (isFull(range)) return true;
  const bits = Number(range.bits);
  const mask = widthMask(bits);
  const fixed = (knownZero | knownOne) & mask;
  if (fixed === 0n) return true;
  const choose = (lower, upper) => {
    const memo = new Map();
    const solve = (bit, tight) => {
      if (bit < 0) return 0n;
      const key = `${bit}:${tight ? 1 : 0}`;
      if (memo.has(key)) return memo.get(key);
      const lowerBit = (lower >> BigInt(bit)) & 1n;
      const choices = tight ? [lowerBit, 1n] : [0n, 1n];
      for (const choice of choices) {
        if (tight && choice < lowerBit) continue;
        const bitMask = 1n << BigInt(bit);
        if ((fixed & bitMask) !== 0n) {
          const required = (knownOne & bitMask) !== 0n ? 1n : 0n;
          if (choice !== required) continue;
        }
        const suffix = solve(bit - 1, tight && choice === lowerBit);
        if (suffix != null) {
          const result = (choice << BigInt(bit)) | suffix;
          // A lower-bound satisfying assignment can still overshoot the
          // segment only when the suffix search was already unconstrained; the
          // caller checks the upper bound, so retain it for that comparison.
          memo.set(key, result);
          return result;
        }
      }
      memo.set(key, null);
      return null;
    };
    const candidate = solve(bits - 1, true);
    return candidate != null && candidate <= upper;
  };
  return rangeSegments(range).some(([lower, upper]) => choose(lower, upper));
}

function rangeHasCongruenceValue(range, congruence) {
  if (congruence == null || congruence.modulus <= 1n || isEmpty(range)) return true;
  const modulus = congruence.modulus;
  const remainder = congruence.remainder;
  return rangeSegments(range).some(([lower, upper]) => {
    const delta = ((remainder - (lower % modulus)) + modulus) % modulus;
    return lower + delta <= upper;
  });
}

function rangeHasMaskAndCongruenceValue(range, knownZero, knownOne, congruence) {
  if (congruence == null || congruence.modulus <= 1n) return rangeHasMaskValue(range, knownZero, knownOne);
  const residueMask = congruence.modulus - 1n;
  const residue = congruence.remainder & residueMask;
  // A divisor of 2^bits fixes exactly its low bits.  Contradictory evidence is
  // rejected before the range search so an overlap cannot be silently resolved
  // in favour of known-one bits.
  if ((knownZero & residue) !== 0n || (knownOne & (residueMask ^ residue)) !== 0n) return false;
  if (isFull(range)) return true;
  return rangeHasMaskValue(range, knownZero | (residueMask ^ residue), knownOne | residue);
}

function rangeContainsRange(container, member) {
  return rangeSegments(member).every(([memberLower, memberUpper]) => rangeSegments(container)
    .some(([containerLower, containerUpper]) => containerLower <= memberLower && memberUpper <= containerUpper));
}

function hasOnlyTrivialEvidence(options) {
  const zeroMask = options.knownZero == null || options.knownZero === 0n || options.knownZero === 0;
  const oneMask = options.knownOne == null || options.knownOne === 0n || options.knownOne === 0;
  const residue = options.congruence;
  const noResidue = residue == null || residue === NO_CONGRUENCE
    || (residue && typeof residue === 'object'
      && (residue.remainder === 0n || residue.remainder === 0)
      && (residue.modulus === 1n || residue.modulus === 1));
  return zeroMask && oneMask && noResidue
    && options.alignment == null
    && options.pointerOffset == null
    && (options.provenance == null || options.provenance === false);
}

function simpleFactFromRange(range, options, bits, explicitNoCongruence = false) {
  const mask = widthMask(bits);
  const value = singletonValue(range);
  const status = options.status ?? (value == null ? 'conservative' : 'exact');
  let reason = options.reason ?? null;
  if (isFull(range) && reason == null) reason = 'unconstrained';
  const finalStatus = isEmpty(range) && status === 'exact' ? 'conservative' : status;
  return Object.freeze({
    valueId: options.valueId ?? null,
    bits,
    range,
    knownZero: value != null && options.deriveKnownBits !== false ? mask ^ value : 0n,
    knownOne: value != null && options.deriveKnownBits !== false ? value : 0n,
    congruence: explicitNoCongruence || value == null
      ? NO_CONGRUENCE
      : Object.freeze({ remainder: value, modulus: 1n << BigInt(bits) }),
    alignment: null,
    pointerOffset: null,
    constant: value == null || !['exact', 'conservative'].includes(finalStatus) ? null : bitvector(value, bits),
    status: finalStatus,
    reason,
    provenance: EMPTY_PROVENANCE,
  });
}

function rangeFromSegments(segments, bits) {
  const max = widthMask(bits);
  const sorted = segments
    .filter(([lower, upper]) => lower <= upper)
    .map(([lower, upper]) => [lower, upper])
    .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
  const merged = [];
  for (const [lower, upper] of sorted) {
    const prior = merged.at(-1);
    if (prior != null && lower <= prior[1] + 1n) prior[1] = prior[1] > upper ? prior[1] : upper;
    else merged.push([lower, upper]);
  }
  if (merged.length === 0) return emptyRange(bits);
  if (merged.length === 1) return rangeOf(merged[0][0], merged[0][1], bits);
  if (merged.length === 2 && merged[0][0] === 0n && merged[1][1] === max) {
    return rangeOf(merged[1][0], merged[0][1], bits);
  }
  return null;
}

/** Intersect two ranges when their union is representable by this domain. */
export function intersectRange(left, right) {
  if (left?.bits !== right?.bits) return null;
  const pieces = [];
  for (const [leftLower, leftUpper] of rangeSegments(left)) {
    for (const [rightLower, rightUpper] of rangeSegments(right)) {
      const lower = leftLower > rightLower ? leftLower : rightLower;
      const upper = leftUpper < rightUpper ? leftUpper : rightUpper;
      if (lower <= upper) pieces.push([lower, upper]);
    }
  }
  return rangeFromSegments(pieces, left.bits);
}

function castFact(factInputValue, toBits, cast) {
  const fact = factInput(factInputValue);
  if (fact == null || !isSupportedWidth(toBits)) return fullFact(toBits, { status: 'malformed', reason: 'invalid cast fact' });
  const result = cast === 'trunc' ? truncateRange(fact.range, toBits)
    : cast === 'zext' ? zeroExtendRange(fact.range, toBits)
      : signExtendRange(fact.range, toBits);
  const sourceMask = widthMask(fact.bits);
  const targetMask = widthMask(toBits);
  let knownZero = fact.knownZero & targetMask;
  let knownOne = fact.knownOne & targetMask;
  if (cast === 'zext' && toBits > fact.bits) knownZero |= targetMask ^ sourceMask;
  if (cast === 'sext' && toBits > fact.bits) {
    const signBit = 1n << BigInt(fact.bits - 1);
    const high = targetMask ^ sourceMask;
    if ((fact.knownZero & signBit) !== 0n) knownZero |= high;
    if ((fact.knownOne & signBit) !== 0n) knownOne |= high;
  }
  const congruence = cast === 'trunc' && result.exact ? fact.congruence : NO_CONGRUENCE;
  return factFromRange(result.range, {
    knownZero,
    knownOne,
    congruence,
    status: combinedFactStatus(fact, null, result.exact ? fact.status : 'conservative'),
    reason: result.reason,
    deriveKnownBits: false,
    provenance: fact.provenance,
  });
}

export function zeroExtendFact(fact, toBits) { return castFact(fact, toBits, 'zext'); }
export function signExtendFact(fact, toBits) { return castFact(fact, toBits, 'sext'); }
export function truncateFact(fact, toBits) { return castFact(fact, toBits, 'trunc'); }

function restrictFactToRange(factInputValue, targetRange, reason = 'edge refinement') {
  const fact = factInput(factInputValue);
  if (fact == null || targetRange == null || fact.bits !== targetRange.bits) return fact;
  const narrowed = intersectRange(fact.range, targetRange);
  // A two-piece non-wrapped result cannot be represented without excluding a
  // reachable value. Keep the input fact instead of manufacturing a hull.
  if (narrowed == null) return fact;
  if (sameRange(narrowed, fact.range)) return fact;
  return factFromRange(narrowed, {
    knownZero: fact.knownZero,
    knownOne: fact.knownOne,
    congruence: fact.congruence,
    alignment: fact.alignment,
    pointerOffset: fact.pointerOffset,
    status: narrowed.kind === 'empty' ? combinedFactStatus(fact, null, 'conservative') : fact.status,
    reason,
    deriveKnownBits: narrowed.kind !== 'empty',
    provenance: fact.provenance,
  });
}

const COMPARISON_ALIASES = Object.freeze({ '=': 'eq', '==': 'eq', '!=': 'ne', '<': 'slt', '<=': 'sle', '>': 'sgt', '>=': 'sge' });
const COMPARISON_NEGATIONS = Object.freeze({
  eq: 'ne', ne: 'eq', '=': 'ne', '!=': 'eq',
  ult: 'uge', ule: 'ugt', ugt: 'ule', uge: 'ult',
  slt: 'sge', sle: 'sgt', sgt: 'sle', sge: 'slt',
  '<': 'sge', '<=': 'sgt', '>': 'sle', '>=': 'slt',
});

function normalizedComparison(operator) {
  return COMPARISON_ALIASES[operator] ?? operator;
}

function compareConstantValues(operator, left, right, bits) {
  const op = normalizedComparison(operator);
  if (!['eq', 'ne', 'ult', 'ule', 'ugt', 'uge', 'slt', 'sle', 'sgt', 'sge'].includes(op)) return null;
  const leftUnsigned = unsignedOf(left, bits);
  const rightUnsigned = unsignedOf(right, bits);
  switch (op) {
    case 'eq': return leftUnsigned === rightUnsigned;
    case 'ne': return leftUnsigned !== rightUnsigned;
    case 'ult': return leftUnsigned < rightUnsigned;
    case 'ule': return leftUnsigned <= rightUnsigned;
    case 'ugt': return leftUnsigned > rightUnsigned;
    case 'uge': return leftUnsigned >= rightUnsigned;
    case 'slt': return signedOf(leftUnsigned, bits) < signedOf(rightUnsigned, bits);
    case 'sle': return signedOf(leftUnsigned, bits) <= signedOf(rightUnsigned, bits);
    case 'sgt': return signedOf(leftUnsigned, bits) > signedOf(rightUnsigned, bits);
    case 'sge': return signedOf(leftUnsigned, bits) >= signedOf(rightUnsigned, bits);
    default: return null;
  }
}

function signedRange(lower, upper, bits) {
  const minimum = -(1n << BigInt(bits - 1));
  const maximum = (1n << BigInt(bits - 1)) - 1n;
  if (lower > upper || upper < minimum || lower > maximum) return emptyRange(bits);
  const low = lower < minimum ? minimum : lower;
  const high = upper > maximum ? maximum : upper;
  if (low === minimum && high === maximum) return fullRange(bits);
  const map = (value) => value < 0n ? value + (1n << BigInt(bits)) : value;
  return rangeOf(map(low), map(high), bits);
}

function comparisonRange(operator, constant, bits) {
  const op = normalizedComparison(operator);
  const value = unsignedOf(constant, bits);
  const max = widthMask(bits);
  if (op === 'eq') return rangeOf(value, value, bits);
  if (op === 'ne') {
    if (value === 0n) return rangeOf(1n, max, bits);
    if (value === max) return rangeOf(0n, max - 1n, bits);
    return null;
  }
  if (op === 'ult') return value === 0n ? emptyRange(bits) : rangeOf(0n, value - 1n, bits);
  if (op === 'ule') return value === max ? fullRange(bits) : rangeOf(0n, value, bits);
  if (op === 'ugt') return value === max ? emptyRange(bits) : rangeOf(value + 1n, max, bits);
  if (op === 'uge') return value === 0n ? fullRange(bits) : rangeOf(value, max, bits);
  const signedValue = signedOf(value, bits);
  const minimum = -(1n << BigInt(bits - 1));
  const maximum = (1n << BigInt(bits - 1)) - 1n;
  if (op === 'slt') return signedRange(minimum, signedValue - 1n, bits);
  if (op === 'sle') return signedRange(minimum, signedValue, bits);
  if (op === 'sgt') return signedRange(signedValue + 1n, maximum, bits);
  if (op === 'sge') return signedRange(signedValue, maximum, bits);
  return null;
}

/** Refine one operand against a constant comparison on one CFG edge. */
export function refineFactByComparison(factInputValue, operator, constant, truth = true) {
  const fact = factInput(factInputValue);
  if (fact == null || !isSupportedWidth(fact.bits)) return null;
  let op = normalizedComparison(operator);
  if (!truth) op = COMPARISON_NEGATIONS[op] ?? null;
  if (op == null) return fact;
  const target = comparisonRange(op, constant, fact.bits);
  return target == null ? fact : restrictFactToRange(fact, target, `comparison ${operator} ${truth ? 'true' : 'false'} edge`);
}

/**
 * Refine the variable side of a comparison when the other side is singleton.
 * The returned map contains only changed/proven facts and is safe to attach to
 * one edge; callers must not merge it into the global map.
 */
export function refineComparisonFacts(operator, leftInput, rightInput, truth = true) {
  const left = factInput(leftInput);
  const right = factInput(rightInput);
  if (left == null || right == null) return new Map();
  const leftConstant = constantFromFact(left);
  const rightConstant = constantFromFact(right);
  const refined = new Map();
  if (leftConstant != null && rightConstant != null) {
    const comparison = left.bits === right.bits
      ? compareConstantValues(operator, leftConstant, rightConstant, left.bits)
      : null;
    if (comparison != null && comparison !== Boolean(truth)) {
      refined.set(left.valueId ?? left.id, emptyFact(left.bits, {
        valueId: left.valueId ?? left.id,
        reason: `comparison ${operator} edge is impossible`,
      }));
      refined.set(right.valueId ?? right.id, emptyFact(right.bits, {
        valueId: right.valueId ?? right.id,
        reason: `comparison ${operator} edge is impossible`,
      }));
    }
  } else if (rightConstant != null && leftConstant == null) {
    const result = refineFactByComparison(left, operator, rightConstant, truth);
    if (result != null && !sameFact(result, left)) refined.set(left.valueId ?? left.id, result);
  } else if (leftConstant != null && rightConstant == null) {
    const mirror = { eq: 'eq', ne: 'ne', ult: 'ugt', ule: 'uge', ugt: 'ult', uge: 'ule', slt: 'sgt', sle: 'sge', sgt: 'slt', sge: 'sle' };
    const result = refineFactByComparison(right, mirror[normalizedComparison(operator)] ?? operator, leftConstant, truth);
    if (result != null && !sameFact(result, right)) refined.set(right.valueId ?? right.id, result);
  }
  return refined;
}

export function isFull(range) { return range.kind === 'full'; }
export function isEmpty(range) { return range.kind === 'empty'; }

/** How many values the range holds. Used for widening decisions and reporting. */
export function cardinality(range) {
  if (isEmpty(range)) return 0n;
  if (isFull(range)) return 1n << BigInt(range.bits);
  return unsignedOf(range.upper - range.lower, range.bits) + 1n;
}

export function contains(range, value) {
  if (isEmpty(range)) return false;
  if (isFull(range)) return true;
  const point = unsignedOf(value, range.bits);
  return range.kind === 'interval'
    ? point >= range.lower && point <= range.upper
    : point >= range.lower || point <= range.upper;
}

export function sameRange(left, right) {
  return left.bits === right.bits && left.kind === right.kind
    && left.lower === right.lower && left.upper === right.upper;
}

/**
 * Union. Wrapped intervals have no unique least upper bound, so this picks the
 * smaller of the two candidate hulls and falls back to full. Picking a hull is
 * always sound; picking the smaller one is what keeps the answer useful.
 */
export function join(left, right) {
  if (left.bits !== right.bits) return fullRange(Math.max(left.bits, right.bits));
  if (isEmpty(left)) return right;
  if (isEmpty(right)) return left;
  if (isFull(left) || isFull(right)) return fullRange(left.bits);
  if (rangeContainsRange(left, right) && cardinality(left) >= cardinality(right)) return left;
  if (rangeContainsRange(right, left) && cardinality(right) >= cardinality(left)) return right;
  const candidates = [rangeOf(left.lower, right.upper, left.bits), rangeOf(right.lower, left.upper, left.bits)]
    .filter((candidate) => rangeContainsRange(candidate, left) && rangeContainsRange(candidate, right));
  if (candidates.length === 0) return fullRange(left.bits);
  return candidates.reduce((best, candidate) => (cardinality(candidate) < cardinality(best) ? candidate : best));
}

/**
 * Widening.
 *
 * Applied once a value has been revisited more times than the threshold, so a
 * loop-carried range cannot climb one step per iteration forever. Widening to
 * full is deliberately blunt: a cleverer widening operator would be a precision
 * feature, and P8-2's contract is bounded convergence, not a rich domain.
 */
export function widen(previous, next) {
  if (sameRange(previous, next)) return next;
  return fullRange(previous.bits);
}

function wrappingAdd(range, delta) {
  return rangeOf(range.lower + delta, range.upper + delta, range.bits);
}

/**
 * Range arithmetic.
 *
 * Only the operations with an exact, cheap wrapped answer are modelled. The rest
 * report the full range and a reason, so a consumer can tell "we proved nothing"
 * apart from "nobody looked".
 */
export function evaluateBinaryRange(operator, left, right) {
  if (isEmpty(left) || isEmpty(right)) return { range: emptyRange(left.bits), exact: true, reason: null };
  const bits = left.bits;
  const unknown = (reason) => ({ range: fullRange(bits), exact: false, reason });
  if (right.bits !== bits && !['shl', 'lshr', 'ashr'].includes(operator)) {
    return unknown('operands have different widths');
  }

  switch (operator) {
    case 'add': {
      if (isFull(left) || isFull(right)) return unknown('an operand is unconstrained');
      // Adding two intervals is exact when the result still fits in one
      // interval: the widths sum to at most the whole space.
      const size = cardinality(left) + cardinality(right) - 1n;
      if (size > (1n << BigInt(bits))) return unknown('the sum covers the whole width');
      return { range: rangeOf(left.lower + right.lower, left.upper + right.upper, bits), exact: true, reason: null };
    }
    case 'sub': {
      if (isFull(left) || isFull(right)) return unknown('an operand is unconstrained');
      const size = cardinality(left) + cardinality(right) - 1n;
      if (size > (1n << BigInt(bits))) return unknown('the difference covers the whole width');
      return { range: rangeOf(left.lower - right.upper, left.upper - right.lower, bits), exact: true, reason: null };
    }
    case 'and': {
      // Exact only for the common masking case: a constant mask bounds the
      // result from above regardless of the other operand.
      if (cardinality(right) === 1n) return {
        range: rangeOf(0n, right.lower, bits), exact: false, reason: 'masked by a constant',
        ...maskFactsForConstant(right.lower, bits, null),
      };
      if (cardinality(left) === 1n) return {
        range: rangeOf(0n, left.lower, bits), exact: false, reason: 'masked by a constant',
        ...maskFactsForConstant(left.lower, bits, null),
      };
      return unknown('bitwise and of two ranges is not modelled');
    }
    case 'or':
    case 'xor':
    case 'mul':
    case 'udiv':
    case 'sdiv':
    case 'urem':
    case 'srem':
      return unknown(`${operator} of two ranges is not modelled`);
    case 'shl':
    case 'lshr':
    case 'ashr':
      return unknown(`${operator} of two ranges is not modelled`);
    default:
      return unknown(`unmodelled operator: ${operator}`);
  }
}

/** Zero extension is exact for a non-wrapped range and unknown for a wrapped one. */
export function zeroExtendRange(range, toBits) {
  if (!isSupportedWidth(toBits) || toBits < range.bits) return { range: fullRange(toBits), exact: false, reason: 'invalid extension width' };
  if (isEmpty(range)) return { range: emptyRange(toBits), exact: true, reason: null };
  if (isFull(range)) {
    // Every source bit pattern zero-extends into one contiguous target
    // interval.  Treating `full` like a wrapped range needlessly discards a
    // proof that remains exactly representable at the wider width.
    return { range: rangeOf(0n, maxUnsigned(range.bits), toBits), exact: true, reason: null };
  }
  if (range.kind === 'wrapped') {
    // A wrapped source range becomes two disjoint intervals once extended, which
    // this domain cannot represent. The bound that is still true is the source
    // width's maximum.
    return { range: rangeOf(0n, maxUnsigned(range.bits), toBits), exact: false, reason: 'wrapped source range cannot be extended exactly' };
  }
  return { range: rangeOf(range.lower, range.upper, toBits), exact: true, reason: null };
}

/** Sign extension is exact when the range does not straddle the sign boundary. */
export function signExtendRange(range, toBits) {
  if (!isSupportedWidth(toBits) || toBits < range.bits) return { range: fullRange(toBits), exact: false, reason: 'invalid extension width' };
  if (isEmpty(range)) return { range: emptyRange(toBits), exact: true, reason: null };
  if (range.kind === 'wrapped' || isFull(range)) {
    return { range: fullRange(toBits), exact: false, reason: 'wrapped source range cannot be sign extended exactly' };
  }
  const low = signedOf(range.lower, range.bits);
  const high = signedOf(range.upper, range.bits);
  if (low > high) {
    // The interval crosses from positive into negative once reinterpreted.
    return { range: fullRange(toBits), exact: false, reason: 'range straddles the sign boundary' };
  }
  return { range: rangeOf(low, high, toBits), exact: true, reason: null };
}

/** Truncation is exact only when the range fits inside the narrower width. */
export function truncateRange(range, toBits) {
  if (!isSupportedWidth(toBits) || toBits > range.bits) return { range: fullRange(toBits), exact: false, reason: 'invalid truncation width' };
  if (isEmpty(range)) return { range: emptyRange(toBits), exact: true, reason: null };
  if (toBits === range.bits) return { range, exact: true, reason: null };
  if (isFull(range) || range.kind === 'wrapped') return { range: fullRange(toBits), exact: false, reason: 'wrapped source range cannot be truncated exactly' };
  if (cardinality(range) > (1n << BigInt(toBits))) {
    return { range: fullRange(toBits), exact: false, reason: 'range is wider than the target width' };
  }
  return { range: rangeOf(range.lower, range.upper, toBits), exact: true, reason: null };
}

/** A human-readable form for diagnostics and evidence. */
export function describeRange(range) {
  if (isEmpty(range)) return `empty:${range.bits}`;
  if (isFull(range)) return `full:${range.bits}`;
  const prefix = range.kind === 'wrapped' ? 'wrapped' : 'interval';
  return `${prefix}:${range.bits}[0x${range.lower.toString(16)},0x${range.upper.toString(16)}]`;
}
