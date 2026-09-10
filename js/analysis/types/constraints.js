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
const NUMERIC_DESCRIPTOR_FIELDS = new Set(['widthBits', 'sizeBytes', 'totalSizeBytes', 'alignBytes', 'offset', 'strideBytes', 'length']);

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
  /* Structural integer authority accepts only the same primitive forms used
     by canonicalDescriptorMaterial(). Never invoke BigInt() on a structured
     value: its ToPrimitive step would launder arrays/objects/booleans into
     hard layout evidence. */
  return canonicalInteger(val);
}

function canonicalInteger(val) {
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number') return Number.isSafeInteger(val) ? BigInt(val) : null;
  if (typeof val !== 'string' || !val.trim()) return null;
  try { return BigInt(val.trim()); } catch { return null; }
}

// One descriptor bound also limits downstream canonical serialization's tree
// expansion. Unique-node limits alone do not bound a highly shared DAG.
export const TYPE_DESCRIPTOR_LIMITS = Object.freeze({ nodes:4096, expandedNodes:16384, depth:64, stringLength:4096 });
function snapshotDescriptor(descriptor, layer) {
  const seen = new WeakMap(), active = new WeakSet(), costs = new WeakMap(), heights = new WeakMap();
  let nodes = 0, expanded = 0;
  const reserve = (amount) => {
    if (expanded + amount > TYPE_DESCRIPTOR_LIMITS.expandedNodes) fail('type-claim-descriptor-expansion-budget');
    expanded += amount;
  };
  const visit = (value, depth = 0) => {
    if (depth > TYPE_DESCRIPTOR_LIMITS.depth) fail('type-claim-descriptor-depth-budget');
    if (value == null || typeof value !== 'object') {
      if (typeof value === 'string' && value.length > TYPE_DESCRIPTOR_LIMITS.stringLength) fail('type-claim-descriptor-string-budget');
      if (typeof value === 'bigint' && value.toString(16).length > 1024) fail('type-claim-descriptor-integer-budget');
      if (typeof value === 'function' || typeof value === 'symbol' || (typeof value === 'number' && !Number.isFinite(value))) fail('type-claim-descriptor-invalid');
      reserve(1); return value;
    }
    if (active.has(value)) fail('type-claim-descriptor-cycle');
    if (seen.has(value)) {
      if (depth + heights.get(value) > TYPE_DESCRIPTOR_LIMITS.depth) fail('type-claim-descriptor-depth-budget');
      reserve(costs.get(value)); return seen.get(value);
    }
    if (nodes >= TYPE_DESCRIPTOR_LIMITS.nodes) fail('type-claim-descriptor-node-budget');
    nodes++;
    let isArray, descriptors;
    try {
      isArray = Array.isArray(value);
      const proto = Object.getPrototypeOf(value);
      if (!isArray && proto !== Object.prototype && proto !== null) fail('type-claim-descriptor-invalid');
      descriptors = Object.getOwnPropertyDescriptors(value);
    } catch { fail('type-claim-descriptor-invalid'); }
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > TYPE_DESCRIPTOR_LIMITS.nodes) fail('type-claim-descriptor-node-budget');
    if (isArray) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length > TYPE_DESCRIPTOR_LIMITS.nodes || length !== keys.length - 1) fail('type-claim-descriptor-array-budget');
      for (let i = 0; i < length; i++) if (!Object.hasOwn(descriptors,String(i))) fail('type-claim-descriptor-invalid');
    }
    const start = expanded;reserve(1);
    const out = isArray ? [] : {};seen.set(value,out);active.add(value);
    let height = 0;
    try {
      for (const key of keys) {
        if (isArray && key === 'length') continue;
        const property = descriptors[key];
        if (typeof key !== 'string' || !property.enumerable) fail('type-claim-descriptor-invalid');
        if (!Object.hasOwn(property,'value')) fail('type-claim-descriptor-accessor');
        if (key === 'abiProfile' && property.value != null && typeof property.value !== 'string') fail('abi-profile-invalid');
        if (layer === 'structural' && NUMERIC_DESCRIPTOR_FIELDS.has(key) && property.value != null
            && canonicalInteger(property.value) == null) {
          fail(`structural-${({sizeBytes:'size',alignBytes:'align',strideBytes:'stride',totalSizeBytes:'total-size',widthBits:'width'})[key] ?? key}-invalid`);
        }
        const child = visit(property.value,depth + 1);
        height = Math.max(height,1 + ((property.value && typeof property.value === 'object') ? heights.get(property.value) : 0));
        Object.defineProperty(out,key,{value:child,enumerable:true,configurable:true,writable:true});
      }
    } finally { active.delete(value); }
    costs.set(value,expanded - start);heights.set(value,height);return out;
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

export function canonicalDescriptorString(layer, descriptor) {
  return stableStringify(canonicalDescriptorMaterial(layer, descriptor));
}

function validateDescriptor(layer, descriptor) {
  if (descriptor == null || typeof descriptor !== 'object' || Array.isArray(descriptor)) fail('type-claim-descriptor-required');
  if (layer !== 'structural') return;
  const pending = [descriptor], seen = new WeakSet();
  while (pending.length) {
    const node = pending.pop();
    if (node == null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    for (const [key,value] of Object.entries(node)) {
      if (NUMERIC_DESCRIPTOR_FIELDS.has(key) && value != null) {
        const integer = toBigInt(value,null);
        const zeroSize = (key === 'sizeBytes' || key === 'totalSizeBytes') && node.kind === 'array' && toBigInt(node.length,null) === 0n;
        if (integer == null || integer < 0n || (integer === 0n && !zeroSize && !['offset','length'].includes(key))) fail(`structural-${({sizeBytes:'size',alignBytes:'align',strideBytes:'stride',totalSizeBytes:'total-size',widthBits:'width'})[key] ?? key}-invalid`);
      }
      if (['targetEntityId','elementEntityId'].includes(key) && value != null && (typeof value !== 'string' || !value.trim())) fail('structural-target-invalid');
      if (value && typeof value === 'object') pending.push(value);
    }
    if (node.sizeBytes != null && node.totalSizeBytes != null && toBigInt(node.sizeBytes) !== toBigInt(node.totalSizeBytes)) fail('structural-total-size-conflict');
    if (node.kind === 'array') {
      const stride = toBigInt(node.strideBytes,null), length = toBigInt(node.length,null), elementSize = toBigInt(node.elementType?.sizeBytes,null);
      if (stride != null && elementSize != null && stride < elementSize) fail('structural-array-stride-conflict');
      const size = toBigInt(node.totalSizeBytes ?? node.sizeBytes,null);
      if (size != null && stride != null && length != null && size !== stride * length) fail('structural-array-size-conflict');
    }
    if (node.members != null) {
      if (!Array.isArray(node.members)) fail('structural-members-invalid');
      for (const member of node.members) if (!member || typeof member !== 'object' || Array.isArray(member)) fail('structural-member-invalid');
    }
    if (node.kind === 'union' && Array.isArray(node.members)) {
      for (const member of node.members) if (toBigInt(member?.offset,0n) !== 0n) fail('structural-union-offset-invalid');
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
    descriptor: snapshotDescriptor(descriptor, layer),
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

    // Top-level array claims are complete structural candidates, not field
    // fragments. Keep their identity intact and compare the array contract
    // directly before the aggregate interval rules below.
    if (aKind === 'array' || bKind === 'array') {
      if (aKind !== bKind) return true;
      if (a.strideBytes != null && b.strideBytes != null && numericValuesDiffer(a.strideBytes, b.strideBytes)) return true;
      if (a.length != null && b.length != null && numericValuesDiffer(a.length, b.length)) return true;
      if (a.sizeBytes != null && b.sizeBytes != null && numericValuesDiffer(a.sizeBytes, b.sizeBytes)) return true;
      if (a.alignBytes != null && b.alignBytes != null && numericValuesDiffer(a.alignBytes, b.alignBytes)) return true;
      if (a.elementEntityId != null && b.elementEntityId != null && a.elementEntityId !== b.elementEntityId) return true;
      if (a.elementType != null && b.elementType != null && memberTypesConflict(a.elementType, b.elementType)) return true;
      return false;
    }

    // Check total size or alignment mismatch
    if (a.sizeBytes != null && b.sizeBytes != null && a.offset == null && b.offset == null && numericValuesDiffer(a.sizeBytes, b.sizeBytes)) return true;
    if (a.alignBytes != null && b.alignBytes != null && a.offset == null && b.offset == null && numericValuesDiffer(a.alignBytes, b.alignBytes)) return true;

    // A member extent must fit inside a co-claimed whole-aggregate size (#5819):
    // hard aggregate size N + hard field [offset, offset+size) with
    // offset+size > N are hard facts that cannot both hold.
    // Only an explicitly typed aggregate can supply a whole-object bound.
    // Offset-less structural-field metadata is member evidence, not a bound.
    const isExplicitAggregateDescriptor = (descriptor) => (
      descriptor.kind === 'struct'
      && descriptor.offset == null
      && descriptor.fieldName == null
      && descriptor.memberType == null
    );
    const extentBeyondAggregate = (aggregate, field) => {
      if (!isExplicitAggregateDescriptor(aggregate)) return false;
      if (field.offset == null || field.sizeBytes == null) return false;
      const start = toBigInt(field.offset, null);
      const size = toBigInt(field.sizeBytes, null);
      const total = toBigInt(aggregate.sizeBytes, null);
      if (start == null || size == null || total == null) return false;
      return start + size > total;
    };
    if (extentBeyondAggregate(a, b) || extentBeyondAggregate(b, a)) return true;

    // Overlapping byte intervals with incompatible member types conflict;
    // disjoint intervals coexist happily in one aggregate.
    // A same-offset field is the same storage slot even when its member type
    // is compatible. Its extent and alignment are still hard layout facts;
    // compare those before the member-type early return so a width mismatch
    // cannot be laundered as a compatible type claim (#4423).
    const sameOffset = a.offset != null && b.offset != null
      && !numericValuesDiffer(a.offset, b.offset);
    if (sameOffset) {
      if (a.sizeBytes != null && b.sizeBytes != null
        && numericValuesDiffer(a.sizeBytes, b.sizeBytes)) return true;
      if (a.alignBytes != null && b.alignBytes != null
        && numericValuesDiffer(a.alignBytes, b.alignBytes)) return true;
    }
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
