import { IDENTITY_REUSE_BUDGETS as REUSE } from './reuse-budgets.js';
import { isReusableOriginSet } from './origin.js';
import { BoundedWeakMetadata } from './bounded-weak-cache.js';
/**
 * Optional reuse eligibility, not a validator. Only immutable, dense, plain
 * data graphs qualify; mutable children, descriptors, host containers and
 * cycles keep the original path. Failed checks are not cached (a caller may
 * subsequently freeze a value). Weak ownership never keeps source graphs alive.
 */
// Eligibility is a disposable hint, not producer authority. One bounded table
// holds both facts instead of two ever-growing weak-set backing tables.
const IMMUTABLE_FLAGS = new BoundedWeakMetadata(REUSE.immutableMetadataEntries);
const ARRAY_MAP = Array.prototype.map;
const ARRAY_SORT = Array.prototype.sort;
const ARRAY_SLICE = Array.prototype.slice;
const ARRAY_ITERATOR = Array.prototype[Symbol.iterator];
const ARRAY_SPECIES = Object.getOwnPropertyDescriptor(Array, Symbol.species)?.get;
const JSON_STRINGIFY = JSON.stringify;
const BIGINT_TO_STRING = BigInt.prototype.toString;
const STRING_CHAR_CODE_AT = String.prototype.charCodeAt;
const NUMBER_TO_STRING = Number.prototype.toString;
const STRING_PAD_START = String.prototype.padStart;
const MATH_IMUL = Math.imul;
const ORDINARY_PROTOTYPES = [Object.prototype, Array.prototype, Map.prototype, Set.prototype].map((prototype) => ({
  prototype, descriptors: Object.getOwnPropertyDescriptors(prototype),
  keys: Reflect.ownKeys(prototype),
}));

/** One check per IR validation, never one expensive prototype scan per node. */
export function ordinaryDataPrototypes() {
  for (const { prototype, descriptors, keys } of ORDINARY_PROTOTYPES) {
    const currentKeys = Reflect.ownKeys(prototype);
    if (currentKeys.length !== keys.length) return false;
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index];
      if (currentKeys[index] !== key) return false;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key), original = descriptors[key];
      if (!descriptor || descriptor.value !== original.value || descriptor.get !== original.get
        || descriptor.set !== original.set || descriptor.enumerable !== original.enumerable) return false;
    }
  }
  return true;
}

export function ordinaryJsonBehavior() {
  return !('toJSON' in Object.prototype) && !('toJSON' in Array.prototype)
    && Object.getOwnPropertyDescriptor(Array.prototype, 'map')?.value === ARRAY_MAP
    && Object.getOwnPropertyDescriptor(Array.prototype, 'sort')?.value === ARRAY_SORT
    && Object.getOwnPropertyDescriptor(Array.prototype, 'slice')?.value === ARRAY_SLICE
    && Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)?.value === ARRAY_ITERATOR
    && Object.getOwnPropertyDescriptor(Array.prototype, 'constructor')?.value === Array
    && Object.getOwnPropertyDescriptor(Array, Symbol.species)?.get === ARRAY_SPECIES
    && Object.getOwnPropertyDescriptor(JSON, 'stringify')?.value === JSON_STRINGIFY
    && Object.getOwnPropertyDescriptor(BigInt.prototype, 'toString')?.value === BIGINT_TO_STRING
    && Object.getOwnPropertyDescriptor(String.prototype, 'charCodeAt')?.value === STRING_CHAR_CODE_AT;
}

/** Digest reuse additionally requires the unchanged numeric hash intrinsics. */
export function ordinaryHashBehavior() {
  return Object.getOwnPropertyDescriptor(Number.prototype, 'toString')?.value === NUMBER_TO_STRING
    && Object.getOwnPropertyDescriptor(String.prototype, 'padStart')?.value === STRING_PAD_START
    && Object.getOwnPropertyDescriptor(Math, 'imul')?.value === MATH_IMUL;
}

export function isKnownImmutableData(value) {
  return value !== null && typeof value === 'object' && IMMUTABLE_FLAGS.get(value) !== undefined;
}

/** Already checked, JSON-normalization-idempotent data for frozen outputs. */
export function isKnownCanonicalJsonData(value) {
  return value !== null && typeof value === 'object' && IMMUTABLE_FLAGS.get(value) === 2;
}

function arrayIndex(key) {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 0xffffffff && String(index) === key;
}

export function isDeeplyFrozenPlainData(value, active = null) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'bigint') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (IMMUTABLE_FLAGS.get(value) !== undefined) return true;
  // Origin's producer already checked/froze this graph. It is a private brand,
  // not Object.isFrozen or a structural resemblance supplied by a caller.
  // Do not traverse/tag every provenance descendant again for every IR root.
  // Keep non-ordinary array/JSON behavior on the full eligibility path.
  if (isReusableOriginSet(value) && ordinaryJsonBehavior()) {
    IMMUTABLE_FLAGS.set(value, 1);
    return true;
  }
  active ??= new WeakSet();
  if (active.has(value)) return false;
  try {
    if (!Object.isFrozen(value)) return false;
    const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return false;
    const keys = Reflect.ownKeys(value);
    if (array && keys.length !== value.length + 1) return false;
    active.add(value);
    let canonicalJson = proto === (array ? Array.prototype : Object.prototype);
    let priorKey = null, arrayPosition = 0;
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') return false;
      // Frozen arrays have fixed key order and length. Equal cardinality and
      // exactly the dense index sequence exclude holes and custom properties.
      if (array && key !== String(arrayPosition++)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
        || !isDeeplyFrozenPlainData(descriptor.value, active)) return false;
      const child = descriptor.value;
      if (canonicalJson) {
        if (typeof child === 'bigint' || (child !== null && typeof child === 'object'
          && IMMUTABLE_FLAGS.get(child) !== 2)) canonicalJson = false;
        // jsonSafe sorts string keys; integer-index keys use ECMAScript's
        // numeric enumeration order. Reuse must preserve both orders exactly.
        if (!array && !arrayIndex(key)) {
          if (priorKey !== null && priorKey > key) canonicalJson = false;
          priorKey = key;
        }
      }
    }
    IMMUTABLE_FLAGS.set(value, canonicalJson ? 2 : 1);
    return true;
  } catch {
    // An optional optimization must not introduce a new reflection failure.
    return false;
  } finally { active.delete(value); }
}
