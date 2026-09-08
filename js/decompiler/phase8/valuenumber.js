/**
 * Global value numbering.
 *
 * Two values get the same number when they are the same computation, decided by
 * semantic identity: operator, sub-kind, exact width, and the numbers of the
 * operands. Never by rendered text. `printExpression` output is a projection
 * chosen for humans — it normalises casts, hides widths and reorders for
 * readability — so two expressions that print identically can compute different
 * things, and using the printed form as a key is how a decompiler starts
 * "simplifying" one computation into another.
 *
 * Memory is the hard half. A load is congruent to an earlier load only when the
 * IR's own memory facts prove it: the same canonical location, the same width,
 * the same reaching memory definitions, and no barrier in between. Phase 8 does
 * not re-derive any of that — the alias solver and MemorySSA already answered it,
 * and a second opinion computed here would be a second memory truth.
 *
 * Everything this pass cannot prove becomes its own singleton class. A missed
 * reuse costs readability; a wrong reuse is a wrong program.
 */

import { createPassDescriptor, createPassResult } from './contract.js';
import { analysisIdentityMatches, canonicalAnalysisIdentity } from './analysis-identity.js';

// Publication is a trust boundary too.  Capture the descriptor/prototype
// intrinsics before traversing IDs and proof records supplied by the Semantic
// IR so a poisoned global or accessor cannot turn a frozen result into a live
// caller-controlled reference.
const INTRINSIC_OBJECT_CREATE = Object.create;
const INTRINSIC_OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const INTRINSIC_OBJECT_FREEZE = Object.freeze;
const INTRINSIC_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const INTRINSIC_OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const INTRINSIC_OBJECT_HAS_OWN = Object.hasOwn;
const INTRINSIC_OBJECT_IS = Object.is;
const INTRINSIC_OBJECT_IS_FROZEN = Object.isFrozen;
const INTRINSIC_OBJECT_KEYS = Object.keys;
const INTRINSIC_OBJECT_PROTOTYPE = Object.prototype;
const INTRINSIC_REFLECT_OWN_KEYS = Reflect.ownKeys;
const INTRINSIC_ARRAY_CONSTRUCTOR = Array;
const INTRINSIC_ARRAY_IS_ARRAY = Array.isArray;
const INTRINSIC_ARRAY_PROTOTYPE = Array.prototype;
const INTRINSIC_MAP_CONSTRUCTOR = Map;
const INTRINSIC_MAP_PROTOTYPE = Map.prototype;
const INTRINSIC_MAP_ENTRIES = Map.prototype.entries;
const INTRINSIC_MAP_GET = Map.prototype.get;
const INTRINSIC_MAP_HAS = Map.prototype.has;
const INTRINSIC_MAP_SET = Map.prototype.set;
const INTRINSIC_MAP_DELETE = Map.prototype.delete;
const INTRINSIC_MAP_CLEAR = Map.prototype.clear;
const INTRINSIC_MAP_VALUES = Map.prototype.values;
const INTRINSIC_SET_CONSTRUCTOR = Set;

export const GVN_PASS = createPassDescriptor({
  id: 'phase8.gvn',
  version: '1.0.4',
  stage: 'memory-optimization',
  budgetClass: 'standard',
  // `ranges` is SCCP's output: two values that are the same constant are the
  // same computation however they were spelled. Declaring the dependency is what
  // makes the transaction refuse to run this pass before SCCP has run.
  consumes: ['cfg', 'ssa', 'ranges'],
  preserves: ['cfg', 'dominators', 'loops', 'ssa', 'memorySsa', 'alias', 'effects', 'ranges', 'deadCode', 'induction', 'types', 'aggregates', 'summaries', 'origins', 'structuredRegions', 'providerHints'],
  invalidates: [],
  produces: ['valueNumbers'],
  description: 'Semantic value numbering with memory reuse gated on the IR\'s own memory proof.',
});

/** Operators whose operand order does not change the result. */
const COMMUTATIVE = new INTRINSIC_SET_CONSTRUCTOR(['add', 'mul', 'and', 'or', 'xor', 'eq', 'ne']);

/**
 * Operations that are never congruent to anything, including themselves.
 *
 * A call, an opaque clobber or an unrepresented operation may return a different
 * value each time it runs. Giving two of them the same number would let a
 * consumer replace the second with the first.
 */
const NEVER_CONGRUENT = new INTRINSIC_SET_CONSTRUCTOR(['call', 'clobber', 'unknown']);

function fail(code) { throw new TypeError(code); }

const INVALID_CONGRUENCE_KEY = Symbol('phase8-gvn-invalid-congruence-key');

const BITVECTOR_BINARY_OPERATORS = new INTRINSIC_SET_CONSTRUCTOR([
  'add', 'sub', 'mul', 'and', 'or', 'xor', 'shl', 'lshr', 'ashr', 'rotl', 'rotr',
  'udiv', 'urem', 'sdiv', 'srem', 'bic', 'orn', 'eon',
]);
const BITVECTOR_UNARY_OPERATORS = new INTRINSIC_SET_CONSTRUCTOR([
  'not', 'neg', 'zext', 'sext', 'trunc', 'is-zero',
]);
const SHIFT_OPERATORS = new INTRINSIC_SET_CONSTRUCTOR([
  'lsl', 'lsr', 'asr', 'uxtb', 'uxth', 'uxtw', 'sxtb', 'sxth', 'sxtw',
]);
const COMMON_SCALAR_EXTRA_KEYS = new INTRINSIC_SET_CONSTRUCTOR([
  'semanticNodeId', 'attributes', 'completeness', 'widthBits', 'compatSource',
]);
const LOAD_EXTRA_KEYS = new INTRINSIC_SET_CONSTRUCTOR([
  'semanticNodeId', 'size', 'widthBits', 'signed', 'memoryAccess', 'completeness',
  'addressPrecise', 'addressOrigin', 'faults',
]);
const MEMORY_ACCESS_KEYS = new INTRINSIC_SET_CONSTRUCTOR([
  'addressSpace', 'addressExpr', 'addressValueId', 'widthBits', 'endian', 'alignment',
  'volatility', 'atomic', 'ordering', 'faults',
]);
const INSTRUCTION_PROVENANCE_KEYS = [
  'id', 'instructionId', 'definitionId', 'semanticNodeId', 'sourceEntityId',
  'sourceEffectIds', 'sourceInstructionIds', 'address', 'text', 'origin',
];
const SCALAR_DEFINITION_KEYS = new INTRINSIC_SET_CONSTRUCTOR([
  'op', 'sub', 'block', 'row', 'args', 'dst', 'extra', 'cond', 'conditionValue',
  ...INSTRUCTION_PROVENANCE_KEYS,
]);
const LOAD_DEFINITION_KEYS = new INTRINSIC_SET_CONSTRUCTOR([
  'op', 'sub', 'block', 'row', 'args', 'dst', 'extra', 'loc', 'addr', 'memUse',
  'unknownAliasBarrier', 'memoryAliasRelation', ...INSTRUCTION_PROVENANCE_KEYS,
]);
const PRODUCED_VALUE_KEYS = new INTRINSIC_SET_CONSTRUCTOR([
  'id', 'vid', 'kind', 'reg', 'stateKey', 'version', 'bits', 'def', 'uses',
  'const', 'range', 'signed', 'nullable', 'type', 'label', 'semanticValueId',
  'semanticSsaValueId', 'sourceSemanticValueId', 'sourceEntityId', 'machineType',
  'origin', 'float', 'floatConst', 'constKind',
]);
const LOAD_LOCATION_KEYS = new INTRINSIC_SET_CONSTRUCTOR([
  'key', 'kind', 'size', 'regionId', 'base', 'baseEntityId', 'index', 'scale',
  'address', 'disp', 'uncertaintyIdentity', 'addressMetadataSource', 'origin',
]);
const LOAD_ADDRESS_KEYS = new INTRINSIC_SET_CONSTRUCTOR([
  'base', 'baseReg', 'disp', 'index', 'scale', 'extend', 'size', 'widthBits',
  'stack', 'addressSpace', 'rawAddressValueId', 'indexSignedness', 'indexWidthBits',
  'addressWidthBits', 'precise', 'unknownReason', 'compatDisplacementEvidence', 'origin',
]);
const LOAD_MEMORY_USE_KEYS = new INTRINSIC_SET_CONSTRUCTOR([
  'memDefs', 'reaching', 'unknownAlias', 'kind', 'reason', 'clobber',
]);
const MEMORY_DEFINITION_ENTRY_KEYS = new INTRINSIC_SET_CONSTRUCTOR([
  'inst', 'id', 'instructionId', 'definitionId',
]);

function supportedIdentityPrimitive(value) {
  return (typeof value === 'string' && value.length > 0)
    || typeof value === 'bigint'
    || (typeof value === 'number' && Number.isSafeInteger(value));
}

function typedPrimitiveFrame(value) {
  let type;
  let text;
  if (value === null) {
    type = 'null';
    text = '';
  } else if (value === undefined) {
    type = 'undefined';
    text = '';
  } else if (typeof value === 'string') {
    type = 'string';
    text = value;
  } else if (typeof value === 'bigint') {
    type = 'bigint';
    text = String(value);
  } else if (typeof value === 'boolean') {
    type = 'boolean';
    text = value ? 'true' : 'false';
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    type = 'number';
    text = INTRINSIC_OBJECT_IS(value, -0) ? '-0' : String(value);
  } else {
    return null;
  }
  return `${type}:${text.length}:${text}`;
}

/** An injective transcript for one typed tuple, including every field boundary. */
function framedTupleKey(kind, values) {
  if (typeof kind !== 'string' || !kind || !INTRINSIC_ARRAY_IS_ARRAY(values)) return null;
  const fields = [typedPrimitiveFrame(kind)];
  for (const value of values) fields.push(typedPrimitiveFrame(value));
  if (fields.some((field) => field == null)) return null;
  return `tuple:${fields.length}:${fields.map((field) => `${field.length}:${field}`).join('')}`;
}

function hasOnlyOwnKeys(value, allowed) {
  return isPlainRecord(value) && INTRINSIC_OBJECT_KEYS(value).every((key) => allowed.has(key));
}

function createValueIdKeyer() {
  const objectKeys = new WeakMap();
  let nextObjectKey = 1;
  return (value) => {
    if (supportedIdentityPrimitive(value)) {
      const framed = typedPrimitiveFrame(value);
      return framed == null ? null : `value-id:${framed.length}:${framed}`;
    }
    if (value != null && typeof value === 'object') {
      let key = objectKeys.get(value);
      if (key == null) {
        key = Symbol(`phase8-gvn-object-id-${nextObjectKey++}`);
        objectKeys.set(value, key);
      }
      return key;
    }
    return null;
  };
}

/**
 * A Map-compatible outward fact table whose public keys retain exact ID type.
 * Native Map uses SameValueZero, so it aliases -0 and +0. The underlying map
 * stores a typed key while iteration and get/has expose the original ID.
 */
class CanonicalValueIdMap extends INTRINSIC_MAP_CONSTRUCTOR {
  #keyOf;
  #rawKeys = new INTRINSIC_MAP_CONSTRUCTOR();

  constructor(keyOf, entries = []) {
    super();
    this.#keyOf = keyOf;
    for (const [key, value] of entries) this.set(key, value);
  }

  #canonical(key) {
    const canonical = this.#keyOf(key);
    if (canonical == null) throw new TypeError('phase8-gvn-unsupported-value-id');
    return canonical;
  }

  set(key, value) {
    const canonical = this.#canonical(key);
    this.#rawKeys.set(canonical, key);
    INTRINSIC_MAP_SET.call(this, canonical, value);
    return this;
  }

  get(key) {
    const canonical = this.#keyOf(key);
    return canonical == null ? undefined : INTRINSIC_MAP_GET.call(this, canonical);
  }

  has(key) {
    const canonical = this.#keyOf(key);
    return canonical != null && INTRINSIC_MAP_HAS.call(this, canonical);
  }

  delete(key) {
    const canonical = this.#keyOf(key);
    if (canonical == null) return false;
    this.#rawKeys.delete(canonical);
    return INTRINSIC_MAP_DELETE.call(this, canonical);
  }

  clear() {
    this.#rawKeys.clear();
    return INTRINSIC_MAP_CLEAR.call(this);
  }

  *entries() {
    for (const [canonical, value] of INTRINSIC_MAP_ENTRIES.call(this)) {
      yield [this.#rawKeys.get(canonical), value];
    }
  }

  *keys() {
    for (const [key] of this.entries()) yield key;
  }

  values() { return INTRINSIC_MAP_VALUES.call(this); }
  [Symbol.iterator]() { return this.entries(); }

  forEach(callback, thisArg = undefined) {
    if (typeof callback !== 'function') throw new TypeError('phase8-gvn-map-callback-required');
    for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
  }
}

// A frozen object containing a native Map is not immutable: Map.prototype.set
// can still mutate its internal slots.  Publish the same read-only view shape
// used by SCCP, preserving typed `get`/iteration while removing mutation
// authority from every consumer.
function readonlyMap(source) {
  const snapshot = source;
  const view = {
    get size() { return snapshot.size; },
    get(key) { return snapshot.get(key); },
    has(key) { return snapshot.has(key); },
    set() { throw new TypeError('phase8-value-number-map-read-only'); },
    delete() { throw new TypeError('phase8-value-number-map-read-only'); },
    clear() { throw new TypeError('phase8-value-number-map-read-only'); },
    keys() { return snapshot.keys(); },
    values() { return snapshot.values(); },
    entries() { return snapshot.entries(); },
    forEach(callback, thisArg) {
      if (typeof callback !== 'function') throw new TypeError('phase8-value-number-map-callback-required');
      return snapshot.forEach((value, key) => callback.call(thisArg, value, key, view));
    },
    [Symbol.iterator]() { return snapshot[Symbol.iterator](); },
  };
  return INTRINSIC_OBJECT_FREEZE(view);
}

function immutablePublishedValue(value, active = new INTRINSIC_SET_CONSTRUCTOR()) {
  if (value == null || typeof value !== 'object') return value;
  if (active.has(value)) throw new TypeError('phase8-value-number-publication-cycle');
  active.add(value);
  try {
    const prototype = INTRINSIC_OBJECT_GET_PROTOTYPE_OF(value);
    if (INTRINSIC_ARRAY_IS_ARRAY(value)) {
      if (prototype !== INTRINSIC_ARRAY_PROTOTYPE) {
        throw new TypeError('phase8-value-number-publication-array');
      }
      const lengthDescriptor = INTRINSIC_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, 'length');
      if (lengthDescriptor == null || !('value' in lengthDescriptor)
          || lengthDescriptor.enumerable || lengthDescriptor.configurable
          || !Number.isSafeInteger(lengthDescriptor.value)
          || lengthDescriptor.value < 0 || lengthDescriptor.value > 0xffffffff) {
        throw new TypeError('phase8-value-number-publication-array');
      }
      const copy = new INTRINSIC_ARRAY_CONSTRUCTOR(lengthDescriptor.value);
      for (const key of INTRINSIC_REFLECT_OWN_KEYS(value)) {
        if (typeof key === 'symbol' || key === 'length') {
          if (typeof key === 'symbol') throw new TypeError('phase8-value-number-publication-symbol');
          continue;
        }
        const descriptor = INTRINSIC_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
        if (descriptor == null || !('value' in descriptor) || !descriptor.enumerable) {
          throw new TypeError('phase8-value-number-publication-descriptor');
        }
        INTRINSIC_OBJECT_DEFINE_PROPERTY(copy, key, {
          value:immutablePublishedValue(descriptor.value, active),
          enumerable:true,
          configurable:true,
          writable:true,
        });
      }
      return INTRINSIC_OBJECT_FREEZE(copy);
    }
    if (prototype !== INTRINSIC_OBJECT_PROTOTYPE && prototype !== null) {
      throw new TypeError('phase8-value-number-publication-object');
    }
    const copy = INTRINSIC_OBJECT_CREATE(prototype);
    const keys = INTRINSIC_REFLECT_OWN_KEYS(value);
    for (const key of keys.sort()) {
      if (typeof key === 'symbol') throw new TypeError('phase8-value-number-publication-symbol');
      const descriptor = INTRINSIC_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
      if (descriptor == null || !('value' in descriptor) || !descriptor.enumerable) {
        throw new TypeError('phase8-value-number-publication-descriptor');
      }
      INTRINSIC_OBJECT_DEFINE_PROPERTY(copy, key, {
        value:immutablePublishedValue(descriptor.value, active),
        enumerable:true,
        configurable:true,
        writable:true,
      });
    }
    return INTRINSIC_OBJECT_FREEZE(copy);
  } finally {
    active.delete(value);
  }
}

function canonicalFactMap(source, keyOf) {
  if (source == null) return null;
  try {
    if (INTRINSIC_OBJECT_GET_PROTOTYPE_OF(source) === INTRINSIC_MAP_PROTOTYPE) {
      return new CanonicalValueIdMap(keyOf, INTRINSIC_MAP_ENTRIES.call(source));
    }
    // SCCP publishes a frozen read-only Map view so Map.prototype.set cannot
    // mutate its evidence after publication. Consume that established artifact
    // contract through its iterator, then keep only this pass-local typed copy.
    if (INTRINSIC_OBJECT_IS_FROZEN(source) && typeof source.entries === 'function') {
      return new CanonicalValueIdMap(keyOf, source.entries());
    }
  } catch {
    return null;
  }
  return null;
}

function supportedResultWidth(bits) {
  return typeof bits === 'number' && Number.isSafeInteger(bits) && bits > 0;
}

// These are the producer-owned scalar families from the public V1 projection.
// Each family gets an explicit, finite attribute vocabulary below; an unknown
// operation or an open-ended metadata bag remains a singleton in GVN.
const SCALAR_FAMILY_ATTRIBUTES = Object.freeze({
  bin: ['negate', 'signed', 'float', 'roundingMode'],
  un: ['sourceBits', 'targetBits', 'float', 'roundingMode'],
  mov: ['castKind', 'sourceBits', 'targetBits'],
  mac: ['widen', 'negate', 'float', 'roundingMode'],
  cmp: ['comparison', 'signed', 'float', 'semanticComparisonCarrier'],
  sel: ['conditionValueId', 'conditionCarrierValueId'],
  bfx: ['lsb', 'width', 'signed'],
  bfi: ['lsb', 'width', 'bitfieldKind'],
});
const SCALAR_FAMILY_OPERATORS = Object.freeze({
  bin: new INTRINSIC_SET_CONSTRUCTOR([
    ...BITVECTOR_BINARY_OPERATORS, 'ror', 'smull', 'umull', 'eq', 'ne', 'lt', 'le', 'gt', 'ge',
  ]),
  un: new INTRINSIC_SET_CONSTRUCTOR([
    ...BITVECTOR_UNARY_OPERATORS, 'bool', 'lnot', 'abs', 'clz', 'ctz', 'rbit', 'rev',
  ]),
  mov: new INTRINSIC_SET_CONSTRUCTOR([null, 'copy', 'mov', 'sext', 'zext', 'trunc']),
  mac: new INTRINSIC_SET_CONSTRUCTOR(['madd', 'msub']),
  cmp: new INTRINSIC_SET_CONSTRUCTOR([null, 'sub', 'cmp', 'add']),
  sel: new INTRINSIC_SET_CONSTRUCTOR([null, 'sel', 'inc', 'inv', 'neg']),
  bfx: new INTRINSIC_SET_CONSTRUCTOR([null, 'bfx', 'sbfx', 'ubfx', 'extract']),
  bfi: new INTRINSIC_SET_CONSTRUCTOR([null, 'bfi', 'bfxil', 'insert']),
});

function isPlainRecord(value) {
  if (value == null || typeof value !== 'object' || INTRINSIC_ARRAY_IS_ARRAY(value)) return false;
  const prototype = INTRINSIC_OBJECT_GET_PROTOTYPE_OF(value);
  return prototype === INTRINSIC_OBJECT_PROTOTYPE || prototype === null;
}

function bitvectorResultKey(value) {
  if (value == null || typeof value !== 'object' || !supportedResultWidth(value.bits)) return null;
  if (value.signed != null && typeof value.signed !== 'boolean') return null;
  if (typeof value.kind !== 'string' || !value.kind) return null;
  const machineType = value.machineType;
  if (machineType == null) {
    // Hand-authored v1 inputs predate machineType. Float markers must not use
    // that compatibility path: equal bit widths do not make FP and integers the
    // same machine value.
    if (value.constKind === 'float' || value.float != null || value.floatConst != null) return null;
    return framedTupleKey('legacy-bitvector-result', [value.bits, value.signed, value.kind]);
  }
  if (!isPlainRecord(machineType)) return null;
  const keys = INTRINSIC_OBJECT_KEYS(machineType).sort();
  if (keys.length !== 2 || keys[0] !== 'kind' || keys[1] !== 'widthBits'
      || machineType.kind !== 'bitvector' || machineType.widthBits !== value.bits) return null;
  return framedTupleKey('bitvector-result', [
    machineType.kind, machineType.widthBits, value.signed, value.kind,
  ]);
}

function producedBitvectorKey(value, definition, {
  allowConstantKind = false,
  allowStoredConstant = false,
} = {}) {
  if (!hasOnlyOwnKeys(value, PRODUCED_VALUE_KEYS)
      || (value.kind !== 'def' && !(allowConstantKind && value.kind === 'const'))
      || value.def !== definition
      || !supportedIdentityPrimitive(value.id)
      || (INTRINSIC_OBJECT_HAS_OWN(value, 'vid') && !Number.isSafeInteger(value.vid))
      || (INTRINSIC_OBJECT_HAS_OWN(value, 'reg') && value.reg != null)
      || (INTRINSIC_OBJECT_HAS_OWN(value, 'stateKey') && value.stateKey != null)
      || (INTRINSIC_OBJECT_HAS_OWN(value, 'version') && value.version !== 0)
      || (INTRINSIC_OBJECT_HAS_OWN(value, 'uses') && !INTRINSIC_ARRAY_IS_ARRAY(value.uses))
      || (!allowStoredConstant && INTRINSIC_OBJECT_HAS_OWN(value, 'const') && value.const != null)
      || (INTRINSIC_OBJECT_HAS_OWN(value, 'range') && value.range != null)
      || (INTRINSIC_OBJECT_HAS_OWN(value, 'nullable') && value.nullable != null)
      || (INTRINSIC_OBJECT_HAS_OWN(value, 'type') && value.type != null)
      || (INTRINSIC_OBJECT_HAS_OWN(value, 'float') && value.float != null)
      || (INTRINSIC_OBJECT_HAS_OWN(value, 'floatConst') && value.floatConst != null)
      || (INTRINSIC_OBJECT_HAS_OWN(value, 'constKind') && value.constKind != null)) {
    return null;
  }
  return bitvectorResultKey(value);
}

function exactShiftKey(shift) {
  if (!isPlainRecord(shift)) return null;
  const keys = INTRINSIC_OBJECT_KEYS(shift).sort();
  if (keys.length !== 2 || keys[0] !== 'amount' || keys[1] !== 'op'
      || !SHIFT_OPERATORS.has(shift.op)
      || !Number.isSafeInteger(shift.amount) || shift.amount < 0) return null;
  return framedTupleKey('operand-shift', [shift.op, shift.amount]);
}

function argumentCongruenceKey(argument, valueKey) {
  if (!isPlainRecord(argument) || valueKey == null || valueKey === INVALID_CONGRUENCE_KEY) return null;
  const allowed = new INTRINSIC_SET_CONSTRUCTOR(['value', 'bits', 'shift', 'origin']);
  if (INTRINSIC_OBJECT_KEYS(argument).some((key) => !allowed.has(key))) return null;
  let bits;
  if (INTRINSIC_OBJECT_HAS_OWN(argument, 'bits')) {
    bits = argument.bits;
    if (!supportedResultWidth(bits) || !supportedResultWidth(argument.value?.bits)
        || bits > argument.value.bits) return null;
  }
  let shiftKey;
  if (INTRINSIC_OBJECT_HAS_OWN(argument, 'shift')) {
    if (argument.shift == null) shiftKey = framedTupleKey('operand-shift-null', []);
    else {
      shiftKey = exactShiftKey(argument.shift);
      if (shiftKey == null) return null;
    }
  }
  return framedTupleKey('operand', [valueKey, bits, shiftKey]);
}

function scalarExtraKey(extra, producedBits, allowedSemanticKeys = new INTRINSIC_MAP_CONSTRUCTOR()) {
  if (extra == null) return framedTupleKey('scalar-extra', []);
  if (!isPlainRecord(extra)) return null;
  const allowedKeys = new INTRINSIC_SET_CONSTRUCTOR([...COMMON_SCALAR_EXTRA_KEYS, ...allowedSemanticKeys.keys()]);
  if (INTRINSIC_OBJECT_KEYS(extra).some((key) => !allowedKeys.has(key))) return null;
  if (INTRINSIC_OBJECT_HAS_OWN(extra, 'semanticNodeId') && !supportedIdentityPrimitive(extra.semanticNodeId)) return null;
  // `attributes` is an open-ended producer metadata bag. Until the producer
  // gives every member a value-semantics contract, even an apparently empty
  // Proxy-backed bag cannot be treated as proof of scalar equality: ownKeys
  // may legally hide configurable fields. Keep such operations singleton.
  if (INTRINSIC_OBJECT_HAS_OWN(extra, 'attributes')) return null;
  if (INTRINSIC_OBJECT_HAS_OWN(extra, 'completeness') && extra.completeness !== 'complete') return null;
  if (INTRINSIC_OBJECT_HAS_OWN(extra, 'widthBits') && extra.widthBits !== producedBits) return null;
  if (INTRINSIC_OBJECT_HAS_OWN(extra, 'compatSource')
      && (typeof extra.compatSource !== 'string' || !extra.compatSource)) return null;
  const fields = [
    INTRINSIC_OBJECT_HAS_OWN(extra, 'completeness'), extra.completeness,
    INTRINSIC_OBJECT_HAS_OWN(extra, 'widthBits'), extra.widthBits,
    INTRINSIC_OBJECT_HAS_OWN(extra, 'compatSource'), extra.compatSource,
  ];
  for (const [key, validator] of allowedSemanticKeys) {
    const present = INTRINSIC_OBJECT_HAS_OWN(extra, key);
    const value = extra[key];
    if (present && !validator(value)) return null;
    fields.push(key, present, value);
  }
  return framedTupleKey('scalar-extra', fields);
}

const scalarNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const scalarBoolean = (value) => typeof value === 'boolean';
const scalarIdentity = (value) => supportedIdentityPrimitive(value);
const scalarBitfieldOffset = (value) => Number.isSafeInteger(value) && value >= 0;
const scalarFloatMarker = (value) => value === false;
const scalarSignedness = scalarBoolean;
const scalarWidth = (value) => supportedResultWidth(value);
const scalarWidening = (value) => scalarNonEmptyString(value) || scalarBoolean(value);
const scalarComparisonCarrier = (value) => scalarBoolean(value) || scalarIdentity(value);

const SCALAR_ATTRIBUTE_VALIDATORS = Object.freeze({
  negate: scalarBoolean,
  signed: scalarSignedness,
  float: scalarFloatMarker,
  roundingMode: scalarNonEmptyString,
  sourceBits: scalarWidth,
  targetBits: scalarWidth,
  castKind: scalarNonEmptyString,
  widen: scalarWidening,
  comparison: scalarNonEmptyString,
  semanticComparisonCarrier: scalarComparisonCarrier,
  conditionValueId: scalarIdentity,
  conditionCarrierValueId: scalarIdentity,
  lsb: scalarBitfieldOffset,
  width: scalarWidth,
  bitfieldKind: scalarNonEmptyString,
});

function scalarAttributeMap(op) {
  const fields = SCALAR_FAMILY_ATTRIBUTES[op];
  if (fields == null) return null;
  return new INTRINSIC_MAP_CONSTRUCTOR(fields.map((field) => [field, SCALAR_ATTRIBUTE_VALIDATORS[field]]));
}

function scalarConditionKey(instruction, argumentKeys, valueKey) {
  const hasConditionCode = INTRINSIC_OBJECT_HAS_OWN(instruction, 'cond');
  const hasConditionValue = INTRINSIC_OBJECT_HAS_OWN(instruction, 'conditionValue');

  // A condition carrier is owned by the select family. Top-level conditional
  // fields on every other scalar family are unmodelled execution semantics.
  if (instruction.op !== 'sel') {
    return hasConditionCode || hasConditionValue ? null : framedTupleKey('scalar-condition-none', []);
  }

  const predicate = hasConditionValue ? instruction.conditionValue : null;
  if (hasConditionValue && predicate == null) return null;
  const predicateKey = predicate == null ? null : valueKey(predicate);
  if (predicate != null && (predicate.bits !== 1
      || predicateKey == null || predicateKey === INVALID_CONGRUENCE_KEY)) return null;

  const code = hasConditionCode ? instruction.cond : null;
  if (code != null) {
    const normalizedCode = scalarNonEmptyString(code) ? code.trim() : '';
    if (!normalizedCode || ['unknown', '?'].includes(normalizedCode.toLowerCase())) return null;
    if (predicate == null && argumentKeys.length < 3) return null;
    return framedTupleKey('scalar-condition-code', [code, predicateKey]);
  }
  if (predicate != null) return framedTupleKey('scalar-predicate-value', [predicateKey]);

  // The generic select representation carries a one-bit predicate first.
  // A legacy flags-select with no condition code is not that representation.
  const first = instruction.args?.[0]?.value;
  if (argumentKeys.length !== 3 || !supportedResultWidth(first?.bits) || first.bits !== 1
      || argumentKeys[0] == null || argumentKeys[0] === INVALID_CONGRUENCE_KEY) return null;
  return framedTupleKey('scalar-predicate-first', [argumentKeys[0]]);
}

function scalarBitfieldGeometry(instruction, produced) {
  const extra = instruction.extra;
  const lsb = extra?.lsb;
  const sourceArgument = instruction.args?.[0];
  const insertedArgument = instruction.args?.[1];
  const hasWidth = extra != null && INTRINSIC_OBJECT_HAS_OWN(extra, 'width');
  const width = hasWidth ? extra.width
    : instruction.sub === 'extract' ? produced.bits
      : instruction.sub === 'insert'
        ? insertedArgument?.bits ?? insertedArgument?.value?.bits : null;
  // An argument view is the actual source width for a bitfield operation. The
  // underlying SSA value may be wider, and argumentCongruenceKey has already
  // validated this bounded view before this geometry check.
  const sourceBits = sourceArgument?.bits ?? sourceArgument?.value?.bits;
  if (!scalarBitfieldOffset(lsb) || !scalarWidth(width) || !scalarWidth(sourceBits)
      || lsb + width > sourceBits) return null;
  return framedTupleKey('scalar-bitfield-geometry', [lsb, width, sourceBits]);
}

function scalarOperationKey(instruction, produced, argumentKeys, valueKey) {
  const resultType = producedBitvectorKey(produced, instruction);
  if (resultType == null || !hasOnlyOwnKeys(instruction, SCALAR_DEFINITION_KEYS)
      || typeof instruction.op !== 'string' || instruction.dst !== produced) {
    return null;
  }
  const operands = framedTupleKey('operands', argumentKeys);
  if (operands == null) return null;
  const operators = SCALAR_FAMILY_OPERATORS[instruction.op];
  if (operators == null || !operators.has(instruction.sub ?? null)) return null;
  if (instruction.op === 'bin' && argumentKeys.length !== 2) return null;
  if (instruction.op === 'un' && argumentKeys.length !== 1) return null;
  if (instruction.op === 'mov') {
    // Zero-argument mov nodes are state reads. Their state identity is complex
    // metadata and deliberately remains singleton until its producer gives it a
    // scalar equality contract.
    if (argumentKeys.length !== 1) return null;
  }

  const extra = scalarExtraKey(instruction.extra, produced.bits, scalarAttributeMap(instruction.op));
  if (extra == null) return null;
  const condition = scalarConditionKey(instruction, argumentKeys, valueKey);
  if (condition == null) return null;
  const geometry = instruction.op === 'bfx' || instruction.op === 'bfi'
    ? scalarBitfieldGeometry(instruction, produced) : framedTupleKey('scalar-geometry-none', []);
  if (geometry == null) return null;
  const ordered = instruction.op === 'bin' && COMMUTATIVE.has(instruction.sub)
    ? [...argumentKeys].sort() : argumentKeys;
  return framedTupleKey('scalar-operation', [
    instruction.op, instruction.sub ?? null, resultType, extra, condition, geometry,
    framedTupleKey('operands', ordered),
  ]);
}

function constantCongruenceKey(constant) {
  if (constant == null || typeof constant !== 'object'
      || !supportedResultWidth(constant.bits)
      || typeof constant.value !== 'bigint') return null;
  return framedTupleKey('constant', [constant.bits, constant.value]);
}

function memoryAccessOf(definition) {
  return definition?.extra?.memoryAccess ?? null;
}

function denseList(value) {
  if (!INTRINSIC_ARRAY_IS_ARRAY(value)) return false;
  const keys = INTRINSIC_OBJECT_KEYS(value);
  if (keys.length !== value.length) return false;
  return keys.every((key, index) => key === String(index));
}

function referenceIdKey(value) {
  if (value == null) return framedTupleKey('absent-reference', []);
  if (!isPlainRecord(value) || !supportedIdentityPrimitive(value.id)) return null;
  return framedTupleKey('value-reference', [value.id]);
}

function scalarOffset(value) {
  return value == null || typeof value === 'bigint'
    || (typeof value === 'number' && Number.isSafeInteger(value));
}

function loadLocationIdentity(location) {
  if (!hasOnlyOwnKeys(location, LOAD_LOCATION_KEYS)
      || !supportedIdentityPrimitive(location.key)
      || !['stack', 'field', 'global'].includes(location.kind)
      || !Number.isSafeInteger(location.size) || location.size <= 0
      || (INTRINSIC_OBJECT_HAS_OWN(location, 'regionId') && location.regionId != null
        && !supportedIdentityPrimitive(location.regionId))
      || (INTRINSIC_OBJECT_HAS_OWN(location, 'baseEntityId') && location.baseEntityId != null
        && !supportedIdentityPrimitive(location.baseEntityId))
      || (INTRINSIC_OBJECT_HAS_OWN(location, 'scale')
        && (!Number.isSafeInteger(location.scale) || location.scale < 0))
      || (INTRINSIC_OBJECT_HAS_OWN(location, 'address') && !scalarOffset(location.address))
      || (INTRINSIC_OBJECT_HAS_OWN(location, 'disp') && !scalarOffset(location.disp))
      || (INTRINSIC_OBJECT_HAS_OWN(location, 'uncertaintyIdentity')
        && location.uncertaintyIdentity != null)
      || (INTRINSIC_OBJECT_HAS_OWN(location, 'addressMetadataSource')
        && (typeof location.addressMetadataSource !== 'string'
          || location.addressMetadataSource.length === 0))) {
    return null;
  }
  const base = INTRINSIC_OBJECT_HAS_OWN(location, 'base') ? referenceIdKey(location.base) : null;
  const index = INTRINSIC_OBJECT_HAS_OWN(location, 'index') ? referenceIdKey(location.index) : null;
  if ((INTRINSIC_OBJECT_HAS_OWN(location, 'base') && base == null)
      || (INTRINSIC_OBJECT_HAS_OWN(location, 'index') && index == null)) return null;
  return framedTupleKey('load-location', [
    location.key, location.kind, location.size,
    INTRINSIC_OBJECT_HAS_OWN(location, 'regionId'), location.regionId,
    INTRINSIC_OBJECT_HAS_OWN(location, 'base'), base,
    INTRINSIC_OBJECT_HAS_OWN(location, 'baseEntityId'), location.baseEntityId,
    INTRINSIC_OBJECT_HAS_OWN(location, 'index'), index,
    INTRINSIC_OBJECT_HAS_OWN(location, 'scale'), location.scale,
    INTRINSIC_OBJECT_HAS_OWN(location, 'address'), location.address,
    INTRINSIC_OBJECT_HAS_OWN(location, 'disp'), location.disp,
    INTRINSIC_OBJECT_HAS_OWN(location, 'uncertaintyIdentity'), location.uncertaintyIdentity,
    INTRINSIC_OBJECT_HAS_OWN(location, 'addressMetadataSource'), location.addressMetadataSource,
  ]);
}

function loadAddressIdentity(address) {
  if (address == null) return framedTupleKey('load-address-absent', []);
  if (!hasOnlyOwnKeys(address, LOAD_ADDRESS_KEYS)
      || (INTRINSIC_OBJECT_HAS_OWN(address, 'baseReg') && address.baseReg != null
        && !supportedIdentityPrimitive(address.baseReg))
      || (INTRINSIC_OBJECT_HAS_OWN(address, 'disp') && !scalarOffset(address.disp))
      || (INTRINSIC_OBJECT_HAS_OWN(address, 'scale')
        && (!Number.isSafeInteger(address.scale) || address.scale < 0))
      || (INTRINSIC_OBJECT_HAS_OWN(address, 'extend') && address.extend != null
        && (typeof address.extend !== 'string' || address.extend.length === 0))
      || (INTRINSIC_OBJECT_HAS_OWN(address, 'size')
        && (!Number.isSafeInteger(address.size) || address.size <= 0))
      || (INTRINSIC_OBJECT_HAS_OWN(address, 'widthBits')
        && !supportedResultWidth(address.widthBits))
      || (INTRINSIC_OBJECT_HAS_OWN(address, 'stack') && typeof address.stack !== 'boolean')
      || (INTRINSIC_OBJECT_HAS_OWN(address, 'addressSpace') && address.addressSpace !== 'memory')
      || (INTRINSIC_OBJECT_HAS_OWN(address, 'rawAddressValueId')
        && !supportedIdentityPrimitive(address.rawAddressValueId))
      || (INTRINSIC_OBJECT_HAS_OWN(address, 'indexSignedness') && address.indexSignedness != null
        && !['signed', 'unsigned'].includes(address.indexSignedness))
      || (INTRINSIC_OBJECT_HAS_OWN(address, 'indexWidthBits') && address.indexWidthBits != null
        && !supportedResultWidth(address.indexWidthBits))
      || (INTRINSIC_OBJECT_HAS_OWN(address, 'addressWidthBits') && address.addressWidthBits != null
        && !supportedResultWidth(address.addressWidthBits))
      || (INTRINSIC_OBJECT_HAS_OWN(address, 'precise') && address.precise !== true)
      || (INTRINSIC_OBJECT_HAS_OWN(address, 'unknownReason') && address.unknownReason != null)
      || (INTRINSIC_OBJECT_HAS_OWN(address, 'compatDisplacementEvidence')
        && (typeof address.compatDisplacementEvidence !== 'string'
          || address.compatDisplacementEvidence.length === 0))) {
    return null;
  }
  const base = INTRINSIC_OBJECT_HAS_OWN(address, 'base') ? referenceIdKey(address.base) : null;
  const index = INTRINSIC_OBJECT_HAS_OWN(address, 'index') ? referenceIdKey(address.index) : null;
  if ((INTRINSIC_OBJECT_HAS_OWN(address, 'base') && base == null)
      || (INTRINSIC_OBJECT_HAS_OWN(address, 'index') && index == null)) return null;
  return framedTupleKey('load-address', [
    INTRINSIC_OBJECT_HAS_OWN(address, 'base'), base,
    INTRINSIC_OBJECT_HAS_OWN(address, 'baseReg'), address.baseReg,
    INTRINSIC_OBJECT_HAS_OWN(address, 'disp'), address.disp,
    INTRINSIC_OBJECT_HAS_OWN(address, 'index'), index,
    INTRINSIC_OBJECT_HAS_OWN(address, 'scale'), address.scale,
    INTRINSIC_OBJECT_HAS_OWN(address, 'extend'), address.extend,
    INTRINSIC_OBJECT_HAS_OWN(address, 'size'), address.size,
    INTRINSIC_OBJECT_HAS_OWN(address, 'widthBits'), address.widthBits,
    INTRINSIC_OBJECT_HAS_OWN(address, 'stack'), address.stack,
    INTRINSIC_OBJECT_HAS_OWN(address, 'addressSpace'), address.addressSpace,
    INTRINSIC_OBJECT_HAS_OWN(address, 'rawAddressValueId'), address.rawAddressValueId,
    INTRINSIC_OBJECT_HAS_OWN(address, 'indexSignedness'), address.indexSignedness,
    INTRINSIC_OBJECT_HAS_OWN(address, 'indexWidthBits'), address.indexWidthBits,
    INTRINSIC_OBJECT_HAS_OWN(address, 'addressWidthBits'), address.addressWidthBits,
    INTRINSIC_OBJECT_HAS_OWN(address, 'precise'), address.precise,
    INTRINSIC_OBJECT_HAS_OWN(address, 'unknownReason'), address.unknownReason,
    INTRINSIC_OBJECT_HAS_OWN(address, 'compatDisplacementEvidence'), address.compatDisplacementEvidence,
  ]);
}

function memoryDefinitionListKey(reaching) {
  if (!denseList(reaching)) return null;
  const framed = [];
  for (const entry of reaching) {
    if (!hasOnlyOwnKeys(entry, MEMORY_DEFINITION_ENTRY_KEYS)) return null;
    const aliases = [];
    if (INTRINSIC_OBJECT_HAS_OWN(entry, 'inst') && entry.inst != null) {
      if (!hasOnlyOwnKeys(entry.inst, new INTRINSIC_SET_CONSTRUCTOR(['id']))
          || !INTRINSIC_OBJECT_HAS_OWN(entry.inst, 'id')) return null;
      aliases.push(entry.inst.id);
    }
    for (const key of ['id', 'instructionId', 'definitionId']) {
      if (INTRINSIC_OBJECT_HAS_OWN(entry, key) && entry[key] != null) aliases.push(entry[key]);
    }
    if (aliases.length === 0 || aliases.some((id) => !supportedIdentityPrimitive(id))) return null;
    const id = aliases[0];
    if (aliases.some((candidate) => !INTRINSIC_OBJECT_IS(candidate, id))) return null;
    framed.push(framedTupleKey('memory-definition', [id]));
  }
  framed.sort();
  return framedTupleKey('memory-definition-list', framed);
}

function loadMemoryUseIdentity(use) {
  if (!hasOnlyOwnKeys(use, LOAD_MEMORY_USE_KEYS)
      || (INTRINSIC_OBJECT_HAS_OWN(use, 'unknownAlias') && use.unknownAlias !== false)
      || (INTRINSIC_OBJECT_HAS_OWN(use, 'clobber') && use.clobber !== false)
      || (INTRINSIC_OBJECT_HAS_OWN(use, 'kind') && use.kind != null)
      || (INTRINSIC_OBJECT_HAS_OWN(use, 'reason') && use.reason != null)) return null;
  const hasMemDefs = INTRINSIC_OBJECT_HAS_OWN(use, 'memDefs');
  const hasReaching = INTRINSIC_OBJECT_HAS_OWN(use, 'reaching');
  if (!hasMemDefs && !hasReaching) return null;
  const memDefs = hasMemDefs ? memoryDefinitionListKey(use.memDefs) : null;
  const reaching = hasReaching ? memoryDefinitionListKey(use.reaching) : null;
  if ((hasMemDefs && memDefs == null) || (hasReaching && reaching == null)
      || (hasMemDefs && hasReaching && memDefs !== reaching)) return null;
  const version = memDefs ?? reaching;
  return {
    version,
    key:framedTupleKey('load-memory-use', [
      hasMemDefs, memDefs, hasReaching, reaching,
      INTRINSIC_OBJECT_HAS_OWN(use, 'unknownAlias'), use.unknownAlias,
      INTRINSIC_OBJECT_HAS_OWN(use, 'clobber'), use.clobber,
      INTRINSIC_OBJECT_HAS_OWN(use, 'kind'), use.kind,
      INTRINSIC_OBJECT_HAS_OWN(use, 'reason'), use.reason,
    ]),
  };
}

function loadValueIdentity(definition, access) {
  if (!hasOnlyOwnKeys(definition, LOAD_DEFINITION_KEYS)
      || definition.op !== 'load' || definition.sub != null
      || !denseList(definition.args) || definition.args.length !== 0
      || definition.dst == null
      || definition.unknownAliasBarrier != null
      || (INTRINSIC_OBJECT_HAS_OWN(definition, 'memoryAliasRelation')
        && definition.memoryAliasRelation !== 'must')
      || !hasOnlyOwnKeys(definition?.extra, LOAD_EXTRA_KEYS)
      || !hasOnlyOwnKeys(access, MEMORY_ACCESS_KEYS)) {
    return { ok:false, reason:'load semantic fields are malformed or unsupported' };
  }
  if (access.addressSpace !== 'memory') {
    return { ok:false, reason:'access is not ordinary memory' };
  }
  const accessBits = access.widthBits;
  const projectedAccessBits = definition?.extra?.widthBits;
  const resultBits = definition?.dst?.bits;
  if (!supportedResultWidth(accessBits)
      || !supportedResultWidth(projectedAccessBits)
      || accessBits !== projectedAccessBits) {
    return { ok:false, reason:'load access width is missing, malformed, or inconsistent' };
  }
  if (!supportedResultWidth(resultBits) || accessBits > resultBits) {
    return { ok:false, reason:'load result width cannot represent the memory access' };
  }
  if (access.endian !== 'little' && access.endian !== 'big') {
    return { ok:false, reason:'load memory endianness is missing or unsupported' };
  }
  if (!INTRINSIC_OBJECT_HAS_OWN(access, 'alignment')
      || (access.alignment !== null && (!Number.isSafeInteger(access.alignment) || access.alignment <= 0))) {
    return { ok:false, reason:'load memory alignment is missing or malformed' };
  }
  if (!isPlainRecord(access.addressExpr)
      || INTRINSIC_OBJECT_KEYS(access.addressExpr).length !== 1
      || !INTRINSIC_OBJECT_HAS_OWN(access.addressExpr, 'valueId')
      || !supportedIdentityPrimitive(access.addressExpr.valueId)) {
    return { ok:false, reason:'load address expression is missing or malformed' };
  }
  if (INTRINSIC_OBJECT_HAS_OWN(access, 'addressValueId')
      && !INTRINSIC_OBJECT_IS(access.addressValueId, access.addressExpr.valueId)) {
    return { ok:false, reason:'load address identity aliases disagree' };
  }
  const signed = definition?.extra?.signed;
  if (typeof signed !== 'boolean') {
    return { ok:false, reason:'load extension signedness is missing or malformed' };
  }
  const byteWidth = Math.ceil(accessBits / 8);
  if (!Number.isSafeInteger(definition?.extra?.size) || definition.extra.size !== byteWidth
      || !Number.isSafeInteger(definition?.loc?.size) || definition.loc.size !== byteWidth) {
    return { ok:false, reason:'load byte width is missing, malformed, or inconsistent' };
  }
  if (definition.loc.kind != null
      && (typeof definition.loc.kind !== 'string' || !definition.loc.kind)) {
    return { ok:false, reason:'load location kind is malformed' };
  }
  if (definition.extra.completeness !== 'complete') {
    return { ok:false, reason:'load semantic description is incomplete' };
  }
  if (!INTRINSIC_ARRAY_IS_ARRAY(access.faults) || access.faults.length !== 0) {
    return { ok:false, reason:'load may fault or has malformed fault facts' };
  }
  if (INTRINSIC_OBJECT_HAS_OWN(definition.extra, 'faults')
      && (!INTRINSIC_ARRAY_IS_ARRAY(definition.extra.faults) || definition.extra.faults.length !== 0)) {
    return { ok:false, reason:'load may trap or has malformed trap facts' };
  }
  const resultType = producedBitvectorKey(definition.dst, definition);
  if (resultType == null) {
    return { ok:false, reason:'load result is not a supported scalar bitvector' };
  }
  const locationIdentity = loadLocationIdentity(definition.loc);
  if (locationIdentity == null) {
    return { ok:false, reason:'load location identity is malformed or unsupported' };
  }
  const addressIdentity = loadAddressIdentity(
    INTRINSIC_OBJECT_HAS_OWN(definition, 'addr') ? definition.addr : null,
  );
  if (addressIdentity == null) {
    return { ok:false, reason:'load address proof is malformed or unsupported' };
  }
  const memoryUseIdentity = loadMemoryUseIdentity(definition.memUse);
  if (memoryUseIdentity == null) {
    return { ok:false, reason:'reaching memory definitions are not determined' };
  }
  const extensionMode = accessBits === resultBits
    ? 'identity'
    : (signed ? 'sign-extend' : 'zero-extend');
  return {
    ok:true,
    reason:null,
    fields:[
      access.addressSpace, access.addressExpr.valueId, accessBits, access.endian,
      INTRINSIC_OBJECT_HAS_OWN(access, 'addressValueId'), access.addressValueId,
      access.alignment, definition.loc.kind, definition.loc.size,
      signed, extensionMode, resultType,
      definition.extra.completeness,
      INTRINSIC_OBJECT_HAS_OWN(definition.extra, 'faults'),
      locationIdentity, addressIdentity, memoryUseIdentity.key,
      INTRINSIC_OBJECT_HAS_OWN(definition, 'memoryAliasRelation'), definition.memoryAliasRelation,
    ],
    memoryVersion:memoryUseIdentity.version,
  };
}

/**
 * Whether a load may participate in value numbering at all.
 *
 * Reusing a load means executing it once where the program executed it twice, so
 * the question is not only "is the value the same" — MemorySSA answers that —
 * but "is the second execution unobservable". At machine level that turns on
 * three facts, and this predicate names each one against the vocabulary the
 * Semantic IR actually uses (`true | false | 'unknown'` for knowledge,
 * `relaxed | acquire | release | acq-rel | seq-cst | unknown` for ordering).
 *
 * Deliberately *not* required: proof that the access was not `volatile`.
 * `volatile` is a source-language annotation and cannot be recovered from a
 * stripped binary, so demanding it would make this capability unreachable on
 * every input forever rather than merely today. What matters at machine level is
 * that the access is to ordinary memory rather than a device, that it is not
 * atomic, and that it imposes no ordering. A positively volatile access still
 * blocks, because that is a fact rather than an absence of one.
 */
function loadIsReusable(definition) {
  const access = memoryAccessOf(definition);
  if (access == null) return { ok: false, reason: 'load carries no memory-access facts' };
  if (definition?.unknownAliasBarrier != null) {
    return { ok: false, reason: 'an unknown store lies between this load and its source' };
  }
  const valueIdentity = loadValueIdentity(definition, access);
  if (!valueIdentity.ok) return valueIdentity;
  // Device or otherwise non-ordinary memory: re-execution is observable there
  // regardless of what the value is.
  if (access.volatility !== false && access.volatility !== 'unknown') {
    return { ok: false, reason: access.volatility === true
      ? 'the access is known to be volatile'
      : 'load volatility facts are missing or malformed' };
  }
  // Atomicity is machine-recoverable — the instruction encoding says whether an
  // access is exclusive or atomic — so `unknown` here is a missing upstream fact,
  // not an unknowable one, and unknown is not permission.
  if (access.atomic !== false) {
    return { ok: false, reason: `atomicity is ${access.atomic === true ? 'yes' : 'unknown'}` };
  }
  // Canonical non-atomic Semantic IR uses `unknown` to mean ordering is not
  // applicable. `relaxed` with atomic=false is deliberately rejected because
  // that pair is noncanonical, not treated as an equivalent spelling.
  if (access.ordering !== 'unknown') {
    return { ok: false, reason: 'access imposes or carries unsupported ordering' };
  }
  if (definition.loc?.key == null) {
    return { ok: false, reason: 'load has no canonical location key' };
  }
  if (!supportedIdentityPrimitive(definition.loc.key)) {
    return { ok: false, reason: 'load location identity has an unsupported type' };
  }
  if (definition.extra?.addressPrecise !== true) {
    return { ok: false, reason: 'load address is not proved precise' };
  }
  return {
    ok:true,
    reason:null,
    valueIdentity:[...valueIdentity.fields, access.volatility, access.atomic, access.ordering],
  };
}

/**
 * The memory version a load reads, taken from the IR's reaching definitions.
 *
 * Two loads are congruent only when this key matches. If the set of reaching
 * definitions cannot be determined the key is null, which makes the load a
 * singleton — the conservative answer.
 */
function memoryVersionKey(definition) {
  return loadMemoryUseIdentity(definition?.memUse)?.version ?? null;
}

/**
 * Dominance, read from the IR rather than recomputed.
 *
 * Reuse requires the earlier definition to dominate the later one; otherwise the
 * "earlier" value may not have been computed on the path that reaches the reuse.
 */
function canonicalIdSet(source, keyOf) {
  try {
    const result = new INTRINSIC_SET_CONSTRUCTOR();
    for (const value of source ?? []) {
      const key = keyOf(value);
      if (key == null) return null;
      result.add(key);
    }
    return result;
  } catch {
    return null;
  }
}

function dominatorSets(ir, keyOf, trustProvidedFacts = true) {
  const sets = new INTRINSIC_MAP_CONSTRUCTOR();
  if (!trustProvidedFacts) return sets;
  const raw = ir?.dominators;
  if (raw instanceof Map) {
    for (const [block, dominators] of raw) {
      const blockKey = keyOf(block);
      const canonical = canonicalIdSet(dominators, keyOf);
      if (blockKey == null || canonical == null) return new INTRINSIC_MAP_CONSTRUCTOR();
      sets.set(blockKey, canonical);
    }
    return sets;
  }
  if (INTRINSIC_ARRAY_IS_ARRAY(raw)) {
    for (let block = 0; block < raw.length; block += 1) {
      const canonical = canonicalIdSet(raw[block], keyOf);
      if (canonical == null) return new INTRINSIC_MAP_CONSTRUCTOR();
      sets.set(keyOf(block), canonical);
    }
    return sets;
  }
  // Fall back to the immediate-dominator chain, which is the same information.
  const idom = ir?.idom;
  if (idom == null) return sets;
  const immediateOf = (block) => (idom instanceof Map ? idom.get(block) : idom[block]);
  for (const block of (ir.blocks ?? []).map((item) => item.index)) {
    const blockKey = keyOf(block);
    if (blockKey == null) return new INTRINSIC_MAP_CONSTRUCTOR();
    const chain = new INTRINSIC_SET_CONSTRUCTOR([blockKey]);
    let current = immediateOf(block);
    let guard = 0;
    while (current != null && guard < 4096) {
      const currentKey = keyOf(current);
      if (currentKey == null) return new INTRINSIC_MAP_CONSTRUCTOR();
      if (chain.has(currentKey)) break;
      chain.add(currentKey);
      current = immediateOf(current);
      guard += 1;
    }
    sets.set(blockKey, chain);
  }
  return sets;
}

function dominates(sets, keyOf, earlierBlock, laterBlock) {
  if (earlierBlock == null || laterBlock == null) return false;
  const earlierKey = keyOf(earlierBlock);
  const laterKey = keyOf(laterBlock);
  if (earlierKey == null || laterKey == null) return false;
  if (earlierKey === laterKey) return true;
  return sets.get(laterKey)?.has(earlierKey) === true;
}

/**
 * Computes value numbers over one function.
 *
 * Values are numbered in a single pass over blocks in index order. That is
 * sufficient because congruence here is structural: a value's number depends
 * only on its operands' numbers, and an operand defined later in a loop simply
 * yields a singleton rather than a wrong class.
 */
export function runGvnPass(context = {}, budget = {}, area = null) {
  const analysis = context.analysis;
  const cfg = analysis?.get('cfg');
  const ssa = analysis?.get('ssa');
  const scalarFacts = analysis?.get('ranges');
  const blocks = cfg?.blocks ?? [];
  const values = ssa?.values ?? [];
  if (area == null) fail('phase8-gvn-requires-staging-area');
  // Snapshot binding/publication belongs to the transaction owner (T011).  The
  // T012 consumer must remain loadable against the existing transaction
  // contract; its own authority boundary is the canonical IR identity below.
  const resolvedIdentity = context.resolvedAnalysisIdentity ?? canonicalAnalysisIdentity(context);
  if (!resolvedIdentity.valid || !analysisIdentityMatches(scalarFacts?.identity, resolvedIdentity.identity)) {
    return createPassResult({
      descriptor: GVN_PASS,
      status: 'unsupported',
      changed: false,
      completeness: 'unknown',
      stopReason: `invalid-identity:${resolvedIdentity.valid ? 'scalar range artifact is stale or missing identity' : resolvedIdentity.reason}`,
      diagnostics: [{
        severity: 'warning',
        code: 'phase8.gvn.identity',
        message: 'GVN refused to consume scalar facts without a matching canonical identity.',
        reason: resolvedIdentity.valid ? 'scalar range artifact is stale or missing identity' : resolvedIdentity.reason,
      }],
    });
  }

  const valueIdKey = createValueIdKeyer();
  const numbers = new CanonicalValueIdMap(valueIdKey);
  const classes = new INTRINSIC_MAP_CONSTRUCTOR();
  const singletonReasons = new CanonicalValueIdMap(valueIdKey);
  const reuseCandidates = [];
  const diagnostics = [];
  // A native Map/Set cannot retain the sign of a zero key. If this adversarial
  // graph actually uses -0 as a block identity, do not consume ambiguous
  // cross-block dominance evidence; exact same-block checks remain available.
  const hasNegativeZeroBlock = blocks.some((block) => INTRINSIC_OBJECT_IS(block?.index, -0))
    || values.some((value) => INTRINSIC_OBJECT_IS(value?.def?.block, -0));
  const dominatorsOf = dominatorSets(
    context.ir ?? { blocks, dominators:cfg?.dominators, idom:cfg?.idom },
    valueIdKey,
    !hasNegativeZeroBlock,
  );
  const valueById = new CanonicalValueIdMap(valueIdKey,
    values.map((value) => [value.id, value]));
  const canonicalFactsPresent = scalarFacts?.facts != null;
  const canonicalFacts = canonicalFactMap(scalarFacts?.facts, valueIdKey);
  const legacyConstants = canonicalFactMap(scalarFacts?.constants, valueIdKey);
  // A native producer Map cannot say whether its sole zero key was inserted as
  // -0 or +0. If this graph contains -0, decline every zero-keyed input fact;
  // the typed GVN tables below can still number the two IR values separately.
  const ambiguousNativeZeroFact = values.some((value) => INTRINSIC_OBJECT_IS(value.id, -0));
  const inputFact = (map, valueId) => (
    ambiguousNativeZeroFact && typeof valueId === 'number' && valueId === 0
      ? null : map?.get(valueId) ?? null
  );

  let nextNumber = 1;
  const keyToNumber = new INTRINSIC_MAP_CONSTRUCTOR();

  // Values with no defining operation — function arguments, incoming state,
  // anything the IR presents without a producer — are each their own class. They
  // are never visited by the instruction walk below, and leaving them unnumbered
  // makes every expression over them a singleton, which silently disables the
  // whole pass on exactly the operands real code is built from.
  const preNumber = (value) => {
    const number = nextNumber++;
    numbers.set(value.id, number);
    classes.set(number, [value.id]);
  };

  const singleton = (value, reason) => {
    const number = nextNumber++;
    numbers.set(value.id, number);
    classes.set(number, [value.id]);
    if (reason) singletonReasons.set(value.id, reason);
    return number;
  };

  const constantKey = (valueId) => {
    const canonical = inputFact(canonicalFacts, valueId);
    if (canonicalFactsPresent) {
      if (scalarFacts?.completeness === 'complete' && canonical?.constant != null
          && ['exact', 'conservative'].includes(canonical.status)) {
        const resultType = bitvectorResultKey(valueById.get(valueId));
        if (resultType == null) return INVALID_CONGRUENCE_KEY;
        const constant = constantCongruenceKey(canonical.constant);
        return constant == null
          ? INVALID_CONGRUENCE_KEY
          : framedTupleKey('typed-constant', [resultType, constant]);
      }
      return null;
    }
    const constant = inputFact(legacyConstants, valueId);
    if (constant == null) return null;
    const resultType = bitvectorResultKey(valueById.get(valueId));
    if (resultType == null) return INVALID_CONGRUENCE_KEY;
    const digest = constantCongruenceKey(constant);
    return digest == null
      ? INVALID_CONGRUENCE_KEY
      : framedTupleKey('typed-constant', [resultType, digest]);
  };

  const operandKey = (operand) => {
    if (operand == null) return null;
    // A proved constant is the same computation however it was produced, so the
    // constant itself is the key rather than the value that happened to hold it.
    const asConstant = constantKey(operand.id);
    if (asConstant === INVALID_CONGRUENCE_KEY) return INVALID_CONGRUENCE_KEY;
    if (asConstant != null) return asConstant;
    const number = numbers.get(operand.id);
    return number == null
      ? null
      : (framedTupleKey('value-number', [number]) ?? INVALID_CONGRUENCE_KEY);
  };

  const abortedNow = () => {
    try { return typeof budget.shouldAbort === 'function' && budget.shouldAbort() === true; }
    catch { return true; }
  };

  for (const value of values) if (value.def == null) preNumber(value);

  let budgetExhausted = false;
  const ordered = [...blocks].sort((left, right) => left.index - right.index);
  for (const block of ordered) {
    if (budgetExhausted) break;
    // Phis merge values from different paths; two phis are congruent only if
    // their whole incoming set is, which this pass does not attempt.
    for (const phi of block.phis ?? []) {
      const produced = phi?.dst;
      if (produced != null) singleton(produced, 'phi values are not numbered');
    }
    for (const instruction of block.insts ?? []) {
      if (abortedNow()) { budgetExhausted = true; break; }
      const produced = instruction?.dst;
      if (produced == null) continue;

      const producedType = producedBitvectorKey(produced, instruction, {
        allowConstantKind:instruction.op === 'const',
        allowStoredConstant:true,
      });
      if (producedType == null) {
        singleton(produced, 'operation identity has an unsupported produced-value schema');
        continue;
      }

      const constant = constantKey(produced.id);
      if (constant === INVALID_CONGRUENCE_KEY) {
        singleton(produced, 'constant identity has unsupported tuple fields');
        continue;
      }

      // Never-congruent operations and family-specific scalar attributes must
      // be checked before a range fact can turn the result into a constant.
      // Otherwise a changed select condition or bitfield geometry could hide
      // behind SCCP's value and authorize an invalid reuse.
      if (NEVER_CONGRUENT.has(instruction.op)) {
        singleton(produced, `${instruction.op} may produce a different value each time it runs`);
        continue;
      }

      let scalarKey = null;
      if (instruction.op !== 'load' && instruction.op !== 'const') {
        if (!INTRINSIC_ARRAY_IS_ARRAY(instruction.args)) {
          singleton(produced, 'operation arguments are malformed');
          continue;
        }
        const operands = instruction.args.map((argument) => {
          const valueKey = operandKey(argument?.value);
          return argumentCongruenceKey(argument, valueKey) ?? INVALID_CONGRUENCE_KEY;
        });
        if (operands.includes(INVALID_CONGRUENCE_KEY)) {
          singleton(produced, 'an operand identity has unsupported tuple fields');
          continue;
        }
        scalarKey = scalarOperationKey(instruction, produced, operands, operandKey);
        if (scalarKey == null) {
          singleton(produced, 'operation identity has unsupported tuple fields');
          continue;
        }
      }

      if (constant != null) {
        // Every proved constant of the same width and value is one class.
        const existing = keyToNumber.get(constant);
        if (existing != null) {
          numbers.set(produced.id, existing);
          classes.get(existing).push(produced.id);
        } else {
          const number = nextNumber++;
          keyToNumber.set(constant, number);
          numbers.set(produced.id, number);
          classes.set(number, [produced.id]);
        }
        continue;
      }

      if (instruction.op === 'load') {
        const reusable = loadIsReusable(instruction);
        if (!reusable.ok) { singleton(produced, reusable.reason); continue; }
        const version = memoryVersionKey(instruction);
        if (version == null) { singleton(produced, 'reaching memory definitions are not determined'); continue; }
        const key = supportedResultWidth(produced.bits)
          ? framedTupleKey('load', [
            instruction.loc.key,
            produced.bits,
            ...reusable.valueIdentity,
            version,
          ])
          : null;
        if (key == null) {
          singleton(produced, 'load congruence identity has unsupported tuple fields');
          continue;
        }
        const existing = keyToNumber.get(key);
        if (existing == null) {
          const number = nextNumber++;
          keyToNumber.set(key, number);
          numbers.set(produced.id, number);
          classes.set(number, [produced.id]);
          continue;
        }
        numbers.set(produced.id, existing);
        classes.get(existing).push(produced.id);
        const earlier = valueById.get(classes.get(existing)[0]);
        if (earlier != null
            && dominates(dominatorsOf, valueIdKey, earlier.def?.block, instruction.block)) {
          reuseCandidates.push({
            kind: 'load', valueId: produced.id, reuseOf: earlier.id,
            proof: 'same typed canonical location and load interpretation, same reaching memory definitions, no unknown-store barrier, and the earlier load dominates',
          });
        }
        continue;
      }

      if (scalarKey == null) {
        singleton(produced, 'operation identity has unsupported tuple fields');
        continue;
      }
      const key = scalarKey;
      const existing = keyToNumber.get(key);
      if (existing == null) {
        const number = nextNumber++;
        keyToNumber.set(key, number);
        numbers.set(produced.id, number);
        classes.set(number, [produced.id]);
        continue;
      }
      numbers.set(produced.id, existing);
      classes.get(existing).push(produced.id);
      const earlier = valueById.get(classes.get(existing)[0]);
      if (earlier != null
          && dominates(dominatorsOf, valueIdKey, earlier.def?.block, instruction.block)) {
        reuseCandidates.push({
          kind: 'scalar', valueId: produced.id, reuseOf: earlier.id,
          proof: 'identical supported scalar-bitvector operation and type over congruent operands; the earlier definition dominates',
        });
      }
    }
  }

  const congruentClasses = [...classes.values()].filter((members) => members.length > 1);
  const publishedClasses = readonlyMap(new INTRINSIC_MAP_CONSTRUCTOR(
    [...classes.entries()].map(([number, members]) => [number, immutablePublishedValue(members)]),
  ));
  const publishedReuseCandidates = INTRINSIC_OBJECT_FREEZE(
    reuseCandidates.map((entry) => immutablePublishedValue(entry)),
  );
  const facts = INTRINSIC_OBJECT_FREEZE({
    passVersion: GVN_PASS.version,
    numbers:readonlyMap(numbers),
    classes:publishedClasses,
    congruentClassCount: congruentClasses.length,
    reuseCandidates:publishedReuseCandidates,
    // Why each value could not be numbered with anything else. A missed reuse
    // with no reason recorded is indistinguishable from a reuse nobody looked for.
    singletonReasons:readonlyMap(singletonReasons),
    completeness: budgetExhausted ? 'partial' : 'complete',
  });
  area.stage('valueNumbers', facts);

  if (budgetExhausted) {
    diagnostics.push({
      severity: 'warning',
      code: 'phase8.gvn.budget',
      message: 'Value numbering stopped before covering the whole function.',
      reason: 'The pass was cancelled; the classes published are sound but incomplete.',
    });
  }
  const blockedLoads = [...singletonReasons.entries()].filter(([valueId]) => valueById.get(valueId)?.def?.op === 'load');
  if (blockedLoads.length > 0) {
    diagnostics.push({
      severity: 'info',
      code: 'phase8.gvn.load-not-reused',
      message: `${blockedLoads.length} loads were not reused.`,
      reason: [...new INTRINSIC_SET_CONSTRUCTOR(blockedLoads.map(([, reason]) => reason))].slice(0, 4).join('; '),
    });
  }

  return createPassResult({
    descriptor: GVN_PASS,
    status: 'changed',
    changed: true,
    completeness: facts.completeness,
    transforms: [],
    produced: ['valueNumbers'],
    diagnostics,
    invalidated: [],
  });
}

export { loadIsReusable, memoryVersionKey };
