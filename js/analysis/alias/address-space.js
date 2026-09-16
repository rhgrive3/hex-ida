/**
 * One canonical address-space authority rule for every C1 alias boundary.
 *
 * `addressSpace` is proof-bearing: two proven distinct spaces mint a strong
 * `NoAlias`, and a memory-wide summary that omits the target's space mints a
 * proven non-clobber. A token may therefore only carry that authority once it
 * is canonical. #5587/#5717 established exactly this for the A2/points-to
 * consumer — a case-different or padded spelling must never separate by
 * spelling alone — but the canonical-proof → region → A1/legacy/effect path
 * kept comparing raw strings, so `"MEMORY"` versus canonical `"memory"`
 * manufactured a physical storage domain the storage never had (#8879).
 *
 * The rule is deliberately two-sided:
 *   - storage/identity canonicalization folds case and surrounding whitespace,
 *     so one domain cannot gain a second identity from a spelling;
 *   - separation/comparison authority additionally requires the value to
 *     already be canonical, so a value that never passed a canonical producer
 *     degrades to no authority instead of inventing either equivalence or
 *     separation.
 */

export const FLAT_MEMORY_SPACE = 'memory';

const UNKNOWN_ADDRESS_SPACE = 'unknown';

/**
 * Canonical spelling of an address-space token for storage, region identity and
 * serialization: trimmed and lowercased, or `null` when there is nothing to
 * store. Whitespace-only and non-string values carry no space at all.
 */
export function canonicalAddressSpace(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  return text.toLowerCase();
}

/**
 * Proven address-space token, usable as separation authority, or `null` when
 * the value proves nothing. A value that is not already trimmed never passed a
 * canonical producer (#5717), `'unknown'` is an explicit absence of proof, and
 * anything non-string cannot be identity at all — all three fail closed to no
 * authority rather than to a new space.
 */
export function provenAddressSpaceToken(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.trim() !== value) return null;
  const text = value.toLowerCase();
  if (!text || text === UNKNOWN_ADDRESS_SPACE) return null;
  return text;
}

/**
 * True when both values name the same canonical storage domain. Two absent
 * spaces agree (neither claims a domain); an absent space never agrees with a
 * named one, so a missing token cannot be folded into flat memory either.
 */
export function sameCanonicalAddressSpace(left, right) {
  const a = canonicalAddressSpace(left);
  const b = canonicalAddressSpace(right);
  if (a == null || b == null) return a === b;
  return a === b;
}

/**
 * True only when both sides are proven canonical tokens naming different
 * physical storage. Equal spellings, differing case, padding or a missing
 * authority on either side all answer `false`.
 */
export function provenDistinctAddressSpace(left, right) {
  const a = provenAddressSpaceToken(left);
  const b = provenAddressSpaceToken(right);
  if (a == null || b == null) return false;
  return a !== b;
}
