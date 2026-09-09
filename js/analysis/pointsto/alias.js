/**
 * P7-2 — alias answers derived from A2 points-to sets.
 *
 * This is where field sensitivity actually pays: two accesses that A1 could
 * only call `may` (same object, offsets it could not prove) become `no` once
 * their offset ranges are bounded and disjoint.
 *
 * The separation rule is deliberately narrow. Distinct roots are *not*
 * separation — two different roots can hold the same runtime address, and
 * proving they cannot requires escape evidence that Phase 7 only produces at
 * P7-3b. `nonEscapingRoots` is the hook that lets that later evidence be
 * supplied without A2 growing a backwards dependency on it.
 */

import { createAliasResult, mayAlias, unknownAlias } from '../alias/result.js';
import { canonicalPointsToAddress, provenSeparationAuthority, rangeRelation } from './lattice.js';

export const A2_ALIAS_ANALYZER_ID = 'phase7.alias.a2-points-to';

function widthBytes(widthBits) {
  if (typeof widthBits !== 'number') return null;
  const bits = widthBits;
  if (!Number.isSafeInteger(bits) || bits <= 0) return null;
  return BigInt(Math.ceil(bits / 8));
}

function absoluteInterval(target, accessWidth) {
  const range = target?.offsetRange;
  if (target?.address == null || range?.min == null || range?.max == null) {
    return { interval: null, reason: null };
  }
  const pointerWidth = target.widthBits;
  if (typeof pointerWidth !== 'number'
      || !Number.isSafeInteger(pointerWidth) || pointerWidth <= 0 || pointerWidth > 512) {
    return { interval: null, reason: 'provenance-lost' };
  }
  let base;
  try {
    base = BigInt(target.address);
  } catch {
    return { interval: null, reason: 'provenance-lost' };
  }
  const addressSpaceSize = 1n << BigInt(pointerWidth);
  const min = base + range.min;
  const max = base + range.max;
  if (min < 0n || max < min || max + accessWidth > addressSpaceSize) {
    return { interval: null, reason: 'provenance-lost' };
  }
  return { interval: { min, max }, reason: null };
}

function isProvenAddressSpace(value) {
  // Canonical spelling only: a value that is not already trimmed was never
  // canonicalized at the target boundary (e.g. a raw passthrough object), and
  // must not mint a separation proof off a whitespace difference (#5717).
  return typeof value === 'string' && value.length > 0 && value.trim() === value && value !== 'unknown';
}

// `nonEscapingRoots` is proof authority: a caller handing us a truthy
// non-Set (array, string, plain object) would otherwise leak a raw
// TypeError mid-comparison (#5453). Only Set-compatible shapes are
// accepted; anything else fails closed with a contract error.
function setNonEscaping(value) {
  if (value == null) return new Set();
  if (typeof value !== 'object' || typeof value.has !== 'function') {
    throw new TypeError('phase7-alias-nonescaping-roots-set-required');
  }
  return value;
}

/**
 * Alias relation between two points-to sets.
 *
 * `options.nonEscapingRoots` is a set of root keys proven not to escape their
 * defining function. Two *different* such roots cannot be the same storage, so
 * they separate; without that proof, different roots stay `may`.
 */
export function pointsToAlias(left, right, options = {}) {
  const status = options.status;
  const widthA = widthBytes(options.widthBitsLeft);
  const widthB = widthBytes(options.widthBitsRight);
  const nonEscaping = setNonEscaping(options.nonEscapingRoots);

  if (!left || !right) return unknownAlias(status, ['unresolved-root']);

  // A fixed point that stopped before converging may hold a *smaller* set than
  // the true one, and a smaller set can look separated when it is not. So an
  // unconverged or aborted run yields no strong answer at all, regardless of
  // how clean its intervals look (P7-INV-002, P7-INV-010).
  if (status && status.completeness !== 'complete' && status.completeness !== 'bounded') {
    return unknownAlias(status, [status.stopReason === 'iteration-limit' ? 'budget-exhausted' : 'unresolved-root']);
  }
  if (left.top || right.top) {
    const reasons = [...new Set([...left.lossReasons, ...right.lossReasons])];
    // Loss reasons are mapped onto the closed proof-reason vocabulary so the
    // weak answer is still explainable rather than an opaque shrug.
    const mapped = reasons.map((reason) => (
      reason === 'integer-to-pointer' ? 'provenance-lost'
        : reason === 'width-overflow' ? 'provenance-lost'
          : reason === 'target-cap' ? 'budget-exhausted'
            : reason === 'widened' ? 'unresolved-offset'
              : reason === 'unresolved-load' || reason === 'unresolved-call' ? 'unresolved-root'
                : 'unresolved-root'
    ));
    return unknownAlias(status, mapped.length ? [...new Set(mapped)] : ['unresolved-root']);
  }
  if (!left.targets.length || !right.targets.length) return unknownAlias(status, ['unresolved-root']);
  if (widthA == null || widthB == null) return unknownAlias(status, ['unresolved-offset']);

  const relations = [];
  const reasonCodes = new Set();
  for (const a of left.targets) {
    for (const b of right.targets) {
      if (a.rootKey !== b.rootKey) {
        if (isProvenAddressSpace(a.addressSpace) && isProvenAddressSpace(b.addressSpace)
          && a.addressSpace !== b.addressSpace) {
          relations.push('no');
          reasonCodes.add('distinct-address-space');
          continue;
        }

        const addressA = canonicalPointsToAddress(a.address);
        const addressB = canonicalPointsToAddress(b.address);
        const hasCanonicalAddressA = addressA != null && addressA === a.address;
        const hasCanonicalAddressB = addressB != null && addressB === b.address;

        if (hasCanonicalAddressA && hasCanonicalAddressB) {
          try {
            const absoluteA = absoluteInterval(a, widthA);
            const absoluteB = absoluteInterval(b, widthB);
            if (absoluteA.reason) reasonCodes.add(absoluteA.reason);
            if (absoluteB.reason) reasonCodes.add(absoluteB.reason);
            if (absoluteA.interval && absoluteB.interval) {
              const spanA_min = absoluteA.interval.min;
              const spanA_max = absoluteA.interval.max;
              const spanB_min = absoluteB.interval.min;
              const spanB_max = absoluteB.interval.max;
              if (spanA_max + widthA <= spanB_min || spanB_max + widthB <= spanA_min) {
                relations.push('no');
                reasonCodes.add('disjoint-global-interval');
                continue;
              }
              if (a.offsetRange.exact && b.offsetRange.exact && spanA_min === spanB_min && widthA === widthB) {
                relations.push('must');
                reasonCodes.add('identical-root-and-exact-offset');
                continue;
              }
            }
          } catch {}
        }

        const pair = new Set([a.rootKind, b.rootKind]);
        if ((pair.has('stack-fixed') || pair.has('stack-like')) && (pair.has('global-absolute') || pair.has('absolute') || hasCanonicalAddressA || hasCanonicalAddressB)) {
          relations.push('no');
          reasonCodes.add('distinct-proven-root');
          continue;
        }

        const aNonEscaping = nonEscaping.has(a.rootKey) || (a.rootEntityId && nonEscaping.has(a.rootEntityId));
        const bNonEscaping = nonEscaping.has(b.rootKey) || (b.rootEntityId && nonEscaping.has(b.rootEntityId));
        if (aNonEscaping || bNonEscaping) {
          relations.push('no');
          reasonCodes.add('distinct-non-escaping-allocation');
          continue;
        }

        // Descriptor-backed storage classes are proof-bearing because they come
        // from the canonical root descriptor boundary, not from variable spelling.
        // A manually-constructed/root-name-only target therefore cannot mint
        // separation authority (#1806), while the Phase 7 frozen corpus keeps its
        // two exact distinct-storage cases through explicit provenance (#1848).
        // The authority is verified against the target's proof brand, not the
        // stored string — a plain caller-supplied `separationAuthority` is not
        // evidence (#6066).
        const descriptorSeparated = provenSeparationAuthority(a) === 'root-descriptor'
          && provenSeparationAuthority(b) === 'root-descriptor'
          && a.separationClass === b.separationClass
          && ['global-like', 'heap-like', 'tls-like'].includes(a.separationClass)
          && a.rootEntityId != null && b.rootEntityId != null
          && a.rootEntityId !== b.rootEntityId;
        if (descriptorSeparated) {
          relations.push('no');
          reasonCodes.add('distinct-proven-root');
          continue;
        }

        relations.push('may');
        reasonCodes.add('escape-unproven');
        continue;
      }
      const relation = rangeRelation(a.offsetRange, widthA, b.offsetRange, widthB);
      relations.push(relation);
      if (relation === 'no') reasonCodes.add('disjoint-field-interval');
      else if (relation === 'must') reasonCodes.add('identical-root-and-exact-offset');
      else if (relation === 'may') reasonCodes.add('shared-root-uncertain-offset');
      else reasonCodes.add('unresolved-offset');
    }
  }

  if (relations.every((relation) => relation === 'no')) {
    const validSeparationReasons = new Set([
      'disjoint-field-interval',
      'disjoint-global-interval',
      'disjoint-stack-interval',
      'distinct-address-space',
      'distinct-proven-root',
      'distinct-non-escaping-allocation',
    ]);
    return createAliasResult({
      relation: 'no',
      reasonCodes: [...reasonCodes].filter((code) => validSeparationReasons.has(code)),
      status,
      proof: { analyzer: A2_ALIAS_ANALYZER_ID, pairs: relations.length },
    });
  }
  // `must` needs a single target on each side: a set with two members means the
  // pointer might be either one, which is not identity even if both members
  // happen to compare equal.
  if (left.targets.length === 1 && right.targets.length === 1 && relations.length === 1 && relations[0] === 'must') {
    return createAliasResult({
      relation: 'must',
      reasonCodes: ['identical-root-and-exact-offset'],
      status,
      proof: { analyzer: A2_ALIAS_ANALYZER_ID },
    });
  }
  if (relations.includes('unknown')) return unknownAlias(status, [...reasonCodes]);
  return mayAlias(status, [...reasonCodes]);
}
