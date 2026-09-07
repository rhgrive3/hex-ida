/**
 * P7-4 — type constraint model.
 *
 * The type architecture has four layers, and they are kept apart even when
 * their representations happen to be compatible (§10):
 *
 *   MachineType             — what the hardware moved: width, class, address space
 *   ABIType                 — how a value was passed or returned
 *   RecoveredStructuralType — inferred layout: fields, intervals, arrays
 *   NominalLanguageType     — a named source-language type
 *
 * Collapsing them is tempting because `int32` at the machine layer and `int` at
 * the nominal layer often coincide. They are still different claims with
 * different authority, and a contradiction at one layer says nothing about the
 * others.
 *
 * The other structural rule is P7-INV-005: hard and soft evidence are separate
 * kinds, not two ends of one confidence scale. Soft evidence ranks candidates;
 * it can never erase a hard contradiction, and no amount of it promotes a
 * conclusion to certainty.
 */

import { deepFreeze, stableDigest, stableStringify } from '../../core/identity/index.js';

export const TYPE_CONSTRAINT_SCHEMA_VERSION = 1;

export const TYPE_LAYERS = Object.freeze([
  'machine',
  'abi',
  'structural',
  'nominal',
]);

/**
 * Hard constraint kinds. Each is something the binary or a verified authority
 * *states*, not something an analysis guessed.
 */
export const HARD_CONSTRAINT_KINDS = Object.freeze([
  'access-width',
  'abi-location',
  'debug-type',
  'runtime-metadata-type',
  'pointer-stride',
  'call-prototype',
  'user-declared',
  'structural-field',
  'recursive-pointer',
  'array-stride',
  'nested-aggregate',
  'call-return-type',
  'abi-structural',
]);

/** Soft evidence kinds. These rank candidates and nothing more. */
export const SOFT_EVIDENCE_KINDS = Object.freeze([
  'symbol-spelling',
  'selector-pattern',
  'runtime-library-pattern',
  'use-shape',
  'array-stride-heuristic',
  'signature-candidate',
  'decompiler-hint',
]);

/**
 * Where a constraint's authority comes from. `debug-matched` is deliberately
 * distinct from `debug-unmatched`: only an identity-verified debug source may
 * ever produce a hard constraint (P7-5, FM-7).
 */
export const CONSTRAINT_ORIGINS = Object.freeze([
  'binary-evidence',
  'abi-boundary',
  'debug-matched',
  'debug-unmatched',
  'runtime-verified',
  'runtime-observed',
  'library-model',
  'user-approved',
  'heuristic',
]);

/** Origins permitted to state a hard constraint. */
const HARD_ORIGINS = new Set(['binary-evidence', 'abi-boundary', 'debug-matched', 'runtime-verified', 'user-approved']);

const LAYER_SET = new Set(TYPE_LAYERS);
const HARD_SET = new Set(HARD_CONSTRAINT_KINDS);
const SOFT_SET = new Set(SOFT_EVIDENCE_KINDS);
const ORIGIN_SET = new Set(CONSTRAINT_ORIGINS);
const NUMERIC_DESCRIPTOR_FIELDS = new Set(['widthBits', 'sizeBytes', 'alignBytes', 'offset', 'strideBytes', 'length']);

function fail(code) { throw new TypeError(code); }

function nonEmpty(value, code) {
  const text = String(value ?? '').trim();
  if (!text) fail(code);
  return text;
}

function strictNonEmpty(value, code) {
  if (typeof value !== 'string') fail(code);
  const text = value.trim();
  if (!text) fail(code);
  return text;
}

function idList(values, code) {
  if (values == null) return [];
  if (!Array.isArray(values)) fail(code);
  return [...new Set(values.map((value) => nonEmpty(value, code)))].sort();
}

function toBigInt(val, fallback = 0n) {
  if (val == null) return fallback;
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number') {
    if (!Number.isSafeInteger(val)) return null;
    return BigInt(val);
  }
  try { return BigInt(val); } catch { return null; }
}

function canonicalInteger(val) {
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number') return Number.isSafeInteger(val) ? BigInt(val) : null;
  if (typeof val !== 'string' || !val.trim()) return null;
  try { return BigInt(val.trim()); } catch { return null; }
}

function snapshotDescriptor(descriptor) {
  const seen = new WeakMap();
  const active = new WeakSet();
  const visit = (value) => {
    if (value == null || typeof value !== 'object') return value;
    if (active.has(value)) fail('type-claim-descriptor-cycle');
    if (seen.has(value)) return seen.get(value);

    let isArray;
    let descriptors;
    try {
      isArray = Array.isArray(value);
      descriptors = Object.getOwnPropertyDescriptors(value);
    } catch {
      fail('type-claim-descriptor-invalid');
    }

    const out = isArray ? [] : {};
    seen.set(value, out);
    active.add(value);
    try {
      for (const key of Reflect.ownKeys(descriptors)) {
        if (isArray && key === 'length') continue;
        const property = descriptors[key];
        if (!Object.prototype.hasOwnProperty.call(property, 'value')) {
          fail('type-claim-descriptor-accessor');
        }
        Object.defineProperty(out, key, { ...property, value: visit(property.value) });
      }
      if (isArray) {
        const length = descriptors.length;
        if (!length || !Object.prototype.hasOwnProperty.call(length, 'value')) {
          fail('type-claim-descriptor-invalid');
        }
        Object.defineProperty(out, 'length', length);
      }
    } finally {
      active.delete(value);
    }
    return out;
  };
  return visit(descriptor);
}

function canonicalDescriptorMaterial(layer, descriptor) {
  if (layer === 'nominal' || descriptor == null || typeof descriptor !== 'object') return descriptor;
  const seen = new WeakMap();
  const visit = (value, field = null) => {
    if (field != null && NUMERIC_DESCRIPTOR_FIELDS.has(field)) {
      const integer = canonicalInteger(value);
      if (integer != null) return integer;
    }
    if (value == null || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);
    const out = Array.isArray(value) ? [] : {};
    seen.set(value, out);
    for (const [key, child] of Object.entries(value)) {
      Object.defineProperty(out, key, {
        value: visit(child, key),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return out;
  };
  return visit(descriptor);
}

function numericValuesDiffer(left, right) {
  const a = canonicalInteger(left);
  const b = canonicalInteger(right);
  if (a != null && b != null) return a !== b;
  return left !== right;
}

function canonicalDescriptorString(layer, descriptor) {
  return stableStringify(canonicalDescriptorMaterial(layer, descriptor));
}

function validateDescriptor(layer, descriptor) {
  if (descriptor == null || typeof descriptor !== 'object') fail('type-claim-descriptor-required');
  if (layer === 'structural') {
    if (descriptor.offset != null) {
      const offset = toBigInt(descriptor.offset, null);
      if (offset == null || offset < 0n) fail('structural-offset-invalid');
    }
    if (descriptor.sizeBytes != null) {
      const size = toBigInt(descriptor.sizeBytes, null);
      if (size == null || size <= 0n) fail('structural-size-invalid');
    }
    if (descriptor.alignBytes != null) {
      const align = toBigInt(descriptor.alignBytes, null);
      if (align == null || align <= 0n) fail('structural-align-invalid');
    }
    if (descriptor.strideBytes != null) {
      const stride = toBigInt(descriptor.strideBytes, null);
      if (stride == null || stride <= 0n) fail('structural-stride-invalid');
    }
    if (descriptor.length != null) {
      const len = toBigInt(descriptor.length, null);
      if (len == null || len < 0n) fail('structural-length-invalid');
    }
  }
}

/**
 * A type claim at one layer.
 *
 * `descriptor` is layer-specific and opaque here; two claims are compared by
 * their canonical serialization, so equality means "the same claim", not "the
 * same object".
 */
export function createTypeClaim(input = {}) {
  const layer = strictNonEmpty(input.layer, 'type-claim-layer-required');
  if (!LAYER_SET.has(layer)) fail('type-claim-invalid-layer');
  const descriptor = input.descriptor ?? null;
  if (descriptor == null) fail('type-claim-descriptor-required');
  const claim = {
    layer,
    entityId: nonEmpty(input.entityId, 'type-claim-entity-required'),
    descriptor: snapshotDescriptor(descriptor),
  };
  validateDescriptor(layer, claim.descriptor);
  claim.key = stableDigest({ layer: claim.layer, entityId: claim.entityId, descriptor: canonicalDescriptorMaterial(layer, claim.descriptor) });
  return deepFreeze(claim);
}

function canonicalHardAbiProfile(value) {
  if (value == null) return null;
  const abiProfile = strictNonEmpty(value, 'abi-profile-invalid');
  if (abiProfile.startsWith('unsupported')) fail(`abi-profile-unsupported:${abiProfile}`);
  return abiProfile;
}

function bindClaimAbiProfile(claim, abiProfile) {
  if (abiProfile == null) return claim;
  const hasClaimProfile = Object.hasOwn(claim.descriptor, 'abiProfile');
  if (!hasClaimProfile && claim.layer !== 'abi') return claim;
  if (hasClaimProfile && claim.descriptor.abiProfile === abiProfile) return claim;

  const properties = Object.getOwnPropertyDescriptors(claim.descriptor);
  properties.abiProfile = { value: abiProfile, enumerable: true, configurable: true, writable: true };
  const descriptor = Array.isArray(claim.descriptor) ? [] : {};
  Object.defineProperties(descriptor, properties);
  return createTypeClaim({ layer: claim.layer, entityId: claim.entityId, descriptor });
}

export function createHardConstraint(input = {}) {
  const kind = strictNonEmpty(input.kind, 'hard-constraint-kind-required');
  if (!HARD_SET.has(kind)) fail('hard-constraint-invalid-kind');
  const origin = strictNonEmpty(input.origin, 'hard-constraint-origin-required');
  if (!ORIGIN_SET.has(origin)) fail('hard-constraint-invalid-origin');
  // The structural guard against FM-7: a heuristic or an unmatched debug file
  // cannot state a hard fact no matter how confident it sounds.
  if (!HARD_ORIGINS.has(origin)) fail(`hard-constraint-origin-not-authoritative:${origin}`);

  const claim = createTypeClaim(input.claim ?? {});
  const constraintAbiProfile = canonicalHardAbiProfile(input.abiProfile);
  const claimAbiProfile = canonicalHardAbiProfile(
    Object.hasOwn(claim.descriptor, 'abiProfile') ? claim.descriptor.abiProfile : null,
  );
  if (constraintAbiProfile != null && claimAbiProfile != null && constraintAbiProfile !== claimAbiProfile) {
    fail('abi-profile-conflict');
  }
  const abiProfile = constraintAbiProfile ?? claimAbiProfile;
  const canonicalClaim = bindClaimAbiProfile(claim, abiProfile);

  return deepFreeze({
    kind,
    origin,
    claim: canonicalClaim,
    evidenceIds: idList(input.evidenceIds, 'hard-constraint-invalid-evidence-ids'),
    providerVersion: input.providerVersion == null ? null : String(input.providerVersion),
    buildIdentity: input.buildIdentity == null ? null : String(input.buildIdentity),
    abiProfile,
  });
}

export function createSoftEvidence(input = {}) {
  const kind = strictNonEmpty(input.kind, 'soft-evidence-kind-required');
  if (!SOFT_SET.has(kind)) fail('soft-evidence-invalid-kind');
  const origin = strictNonEmpty(input.origin ?? 'heuristic', 'soft-evidence-origin-required');
  if (!ORIGIN_SET.has(origin)) fail('soft-evidence-invalid-origin');
  const weight = Number(input.weight ?? 0.5);
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) fail('soft-evidence-invalid-weight');
  return deepFreeze({
    kind,
    origin,
    claim: createTypeClaim(input.claim ?? {}),
    weight,
    evidenceIds: idList(input.evidenceIds, 'soft-evidence-invalid-evidence-ids'),
  });
}

function intervalsOverlap(a, b) {
  if (a.offset == null || b.offset == null || a.sizeBytes == null || b.sizeBytes == null) return true;
  const aStart = toBigInt(a.offset, 0n);
  const bStart = toBigInt(b.offset, 0n);
  const aSize = toBigInt(a.sizeBytes, 0n);
  const bSize = toBigInt(b.sizeBytes, 0n);
  if (aStart == null || bStart == null || aSize == null || bSize == null || aSize <= 0n || bSize <= 0n) return true;
  return aStart < bStart + bSize && bStart < aStart + aSize;
}

function memberTypesConflict(aType, bType) {
  if (aType == null || bType == null) return false;
  if (typeof aType !== 'object' || typeof bType !== 'object') {
    return stableStringify(aType) !== stableStringify(bType);
  }
  const aKind = aType.kind ?? null;
  const bKind = bType.kind ?? null;
  if (aKind != null && bKind != null && aKind !== bKind) return true;

  if (aKind === 'pointer' || bKind === 'pointer') {
    const aTarget = aType.targetEntityId ?? null;
    const bTarget = bType.targetEntityId ?? null;
    if (aTarget != null && bTarget != null && aTarget !== bTarget) return true;
    if (aType.pointeeType != null && bType.pointeeType != null && memberTypesConflict(aType.pointeeType, bType.pointeeType)) return true;
    return false;
  }

  if (aKind === 'array' || bKind === 'array') {
    if (aType.strideBytes != null && bType.strideBytes != null && numericValuesDiffer(aType.strideBytes, bType.strideBytes)) return true;
    if (aType.length != null && bType.length != null && numericValuesDiffer(aType.length, bType.length)) return true;
    if (aType.elementType != null && bType.elementType != null && memberTypesConflict(aType.elementType, bType.elementType)) return true;
    return false;
  }

  if (aType.name != null && bType.name != null && aType.name !== bType.name) return true;
  if (aType.widthBits != null && bType.widthBits != null && numericValuesDiffer(aType.widthBits, bType.widthBits)) return true;
  if (aType.signed != null && bType.signed != null && aType.signed !== bType.signed) return true;

  return canonicalDescriptorString('structural', aType) !== canonicalDescriptorString('structural', bType);
}

/**
 * Do two claims at the same layer conflict?
 *
 * Equality is not the same as representational compatibility. Two claims that
 * describe the same storage differently are compatible; two that describe it
 * *incompatibly* conflict. Anything the comparison cannot decide is reported as
 * a conflict rather than waved through, because an undetected contradiction is
 * how false certainty gets published.
 */
export function claimsConflict(left, right) {
  if (left.layer !== right.layer) return false;
  if (left.entityId !== right.entityId) return false;
  if (left.key === right.key) return false;

  const a = left.descriptor;
  const b = right.descriptor;
  if (a == null || b == null) return true;

  if (left.layer === 'machine') {
    // Different widths for the same access are a genuine contradiction; a
    // different class at the same width is too (an integer is not a pointer).
    if (a.widthBits != null && b.widthBits != null && numericValuesDiffer(a.widthBits, b.widthBits)) return true;
    if (a.class != null && b.class != null && a.class !== b.class) return true;
    if (a.addressSpace != null && b.addressSpace != null && a.addressSpace !== b.addressSpace) return true;
    return false;
  }
  if (left.layer === 'abi') {
    if (a.location != null && b.location != null && a.location !== b.location) return true;
    if (a.passingClass != null && b.passingClass != null && a.passingClass !== b.passingClass) return true;
    if (a.abiProfile != null && b.abiProfile != null && a.abiProfile !== b.abiProfile) return true;
    if (a.sizeBytes != null && b.sizeBytes != null && numericValuesDiffer(a.sizeBytes, b.sizeBytes)) return true;
    if (a.alignBytes != null && b.alignBytes != null && numericValuesDiffer(a.alignBytes, b.alignBytes)) return true;
    return false;
  }
  if (left.layer === 'structural') {
    // Check kind mismatch
    const aKind = a.kind ?? (a.offset != null ? 'field' : null);
    const bKind = b.kind ?? (b.offset != null ? 'field' : null);
    if (aKind != null && bKind != null && aKind !== bKind && aKind !== 'field' && bKind !== 'field') {
      return true;
    }
    // Check total size or alignment mismatch
    if (a.sizeBytes != null && b.sizeBytes != null && a.offset == null && b.offset == null && numericValuesDiffer(a.sizeBytes, b.sizeBytes)) return true;
    if (a.alignBytes != null && b.alignBytes != null && a.offset == null && b.offset == null && numericValuesDiffer(a.alignBytes, b.alignBytes)) return true;

    // Overlapping byte intervals with incompatible member types conflict;
    // disjoint intervals coexist happily in one aggregate.
    const overlap = intervalsOverlap(a, b);
    if (!overlap) return false;

    if (a.memberType != null && b.memberType != null) {
      if (memberTypesConflict(a.memberType, b.memberType)) return true;
      return false;
    }
    if (a.members != null && b.members != null) {
      return canonicalDescriptorString('structural', a.members) !== canonicalDescriptorString('structural', b.members);
    }
    if (a.offset != null && b.offset != null && !numericValuesDiffer(a.offset, b.offset)) {
      return canonicalDescriptorString('structural', a) !== canonicalDescriptorString('structural', b);
    }
    return false;
  }
  // Nominal types: two different names for one entity is a conflict unless one
  // is declared an alias of the other.
  if (a.name != null && b.name != null) {
    if (a.name === b.name) return false;
    const aAliases = new Set(a.aliases ?? []);
    const bAliases = new Set(b.aliases ?? []);
    return !(aAliases.has(b.name) || bAliases.has(a.name));
  }
  return true;
}

/** A recorded contradiction. It is a first-class result, not an error. */
export function createContradiction(input = {}) {
  return deepFreeze({
    layer: nonEmpty(input.layer, 'contradiction-layer-required'),
    entityId: nonEmpty(input.entityId, 'contradiction-entity-required'),
    left: input.left,
    right: input.right,
    detail: input.detail == null ? null : String(input.detail),
  });
}
