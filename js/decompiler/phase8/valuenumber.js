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
import { semanticSnapshotForAnalysis } from './transaction.js';

export const GVN_PASS = createPassDescriptor({
  id: 'phase8.gvn',
  version: '1.0.3',
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
const COMMUTATIVE = new Set(['add', 'mul', 'and', 'or', 'xor', 'eq', 'ne']);

/**
 * Operations that are never congruent to anything, including themselves.
 *
 * A call, an opaque clobber or an unrepresented operation may return a different
 * value each time it runs. Giving two of them the same number would let a
 * consumer replace the second with the first.
 */
const NEVER_CONGRUENT = new Set(['call', 'clobber', 'unknown']);

function fail(code) { throw new TypeError(code); }

const INVALID_CONGRUENCE_KEY = Symbol('phase8-gvn-invalid-congruence-key');

const BITVECTOR_BINARY_OPERATORS = new Set([
  'add', 'sub', 'mul', 'and', 'or', 'xor', 'shl', 'lshr', 'ashr', 'rotl', 'rotr',
  'udiv', 'urem', 'sdiv', 'srem', 'bic', 'orn', 'eon',
]);
const BITVECTOR_UNARY_OPERATORS = new Set([
  'not', 'neg', 'zext', 'sext', 'trunc', 'is-zero',
]);
const SHIFT_OPERATORS = new Set([
  'lsl', 'lsr', 'asr', 'uxtb', 'uxth', 'uxtw', 'sxtb', 'sxth', 'sxtw',
]);
const COMMON_SCALAR_EXTRA_KEYS = new Set([
  'semanticNodeId', 'attributes', 'completeness', 'widthBits', 'compatSource',
]);
const LOAD_EXTRA_KEYS = new Set([
  'semanticNodeId', 'size', 'widthBits', 'signed', 'memoryAccess', 'completeness',
  'addressPrecise', 'addressOrigin', 'faults',
]);
const MEMORY_ACCESS_KEYS = new Set([
  'addressSpace', 'addressExpr', 'addressValueId', 'widthBits', 'endian', 'alignment',
  'volatility', 'atomic', 'ordering', 'faults',
]);
const INSTRUCTION_PROVENANCE_KEYS = [
  'id', 'instructionId', 'definitionId', 'semanticNodeId', 'sourceEntityId',
  'sourceEffectIds', 'sourceInstructionIds', 'address', 'text', 'origin',
];
const SCALAR_DEFINITION_KEYS = new Set([
  'op', 'sub', 'block', 'row', 'args', 'dst', 'extra', ...INSTRUCTION_PROVENANCE_KEYS,
]);
const LOAD_DEFINITION_KEYS = new Set([
  'op', 'sub', 'block', 'row', 'args', 'dst', 'extra', 'loc', 'addr', 'memUse',
  'unknownAliasBarrier', 'memoryAliasRelation', ...INSTRUCTION_PROVENANCE_KEYS,
]);
const PRODUCED_VALUE_KEYS = new Set([
  'id', 'vid', 'kind', 'reg', 'stateKey', 'version', 'bits', 'def', 'uses',
  'const', 'range', 'signed', 'nullable', 'type', 'label', 'semanticValueId',
  'semanticSsaValueId', 'sourceSemanticValueId', 'sourceEntityId', 'machineType',
  'origin', 'float', 'floatConst', 'constKind',
]);
const LOAD_LOCATION_KEYS = new Set([
  'key', 'kind', 'size', 'regionId', 'base', 'baseEntityId', 'index', 'scale',
  'address', 'disp', 'uncertaintyIdentity', 'addressMetadataSource', 'origin',
]);
const LOAD_ADDRESS_KEYS = new Set([
  'base', 'baseReg', 'disp', 'index', 'scale', 'extend', 'size', 'widthBits',
  'stack', 'addressSpace', 'rawAddressValueId', 'indexSignedness', 'indexWidthBits',
  'addressWidthBits', 'precise', 'unknownReason', 'compatDisplacementEvidence', 'origin',
]);
const LOAD_MEMORY_USE_KEYS = new Set([
  'memDefs', 'reaching', 'unknownAlias', 'kind', 'reason', 'clobber',
]);
const MEMORY_DEFINITION_ENTRY_KEYS = new Set([
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
    text = Object.is(value, -0) ? '-0' : String(value);
  } else {
    return null;
  }
  return `${type}:${text.length}:${text}`;
}

/** An injective transcript for one typed tuple, including every field boundary. */
function framedTupleKey(kind, values) {
  if (typeof kind !== 'string' || !kind || !Array.isArray(values)) return null;
  const fields = [typedPrimitiveFrame(kind)];
  for (const value of values) fields.push(typedPrimitiveFrame(value));
  if (fields.some((field) => field == null)) return null;
  return `tuple:${fields.length}:${fields.map((field) => `${field.length}:${field}`).join('')}`;
}

function hasOnlyOwnKeys(value, allowed) {
  return isPlainRecord(value) && Object.keys(value).every((key) => allowed.has(key));
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
class CanonicalValueIdMap extends Map {
  #keyOf;
  #rawKeys = new Map();

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
    Map.prototype.set.call(this, canonical, value);
    return this;
  }

  get(key) {
    const canonical = this.#keyOf(key);
    return canonical == null ? undefined : Map.prototype.get.call(this, canonical);
  }

  has(key) {
    const canonical = this.#keyOf(key);
    return canonical != null && Map.prototype.has.call(this, canonical);
  }

  delete(key) {
    const canonical = this.#keyOf(key);
    if (canonical == null) return false;
    this.#rawKeys.delete(canonical);
    return Map.prototype.delete.call(this, canonical);
  }

  clear() {
    this.#rawKeys.clear();
    return Map.prototype.clear.call(this);
  }

  *entries() {
    for (const [canonical, value] of Map.prototype.entries.call(this)) {
      yield [this.#rawKeys.get(canonical), value];
    }
  }

  *keys() {
    for (const [key] of this.entries()) yield key;
  }

  values() { return Map.prototype.values.call(this); }
  [Symbol.iterator]() { return this.entries(); }

  forEach(callback, thisArg = undefined) {
    if (typeof callback !== 'function') throw new TypeError('phase8-gvn-map-callback-required');
    for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
  }
}

function canonicalFactMap(source, keyOf) {
  if (source == null) return null;
  try {
    if (Object.getPrototypeOf(source) === Map.prototype) {
      return new CanonicalValueIdMap(keyOf, Map.prototype.entries.call(source));
    }
    // SCCP publishes a frozen read-only Map view so Map.prototype.set cannot
    // mutate its evidence after publication. Consume that established artifact
    // contract through its iterator, then keep only this pass-local typed copy.
    if (Object.isFrozen(source) && typeof source.entries === 'function') {
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

function isPlainRecord(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
  const keys = Object.keys(machineType).sort();
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
      || (Object.hasOwn(value, 'vid') && !Number.isSafeInteger(value.vid))
      || (Object.hasOwn(value, 'reg') && value.reg != null)
      || (Object.hasOwn(value, 'stateKey') && value.stateKey != null)
      || (Object.hasOwn(value, 'version') && value.version !== 0)
      || (Object.hasOwn(value, 'uses') && !Array.isArray(value.uses))
      || (!allowStoredConstant && Object.hasOwn(value, 'const') && value.const != null)
      || (Object.hasOwn(value, 'range') && value.range != null)
      || (Object.hasOwn(value, 'nullable') && value.nullable != null)
      || (Object.hasOwn(value, 'type') && value.type != null)
      || (Object.hasOwn(value, 'float') && value.float != null)
      || (Object.hasOwn(value, 'floatConst') && value.floatConst != null)
      || (Object.hasOwn(value, 'constKind') && value.constKind != null)) {
    return null;
  }
  return bitvectorResultKey(value);
}

function exactShiftKey(shift) {
  if (!isPlainRecord(shift)) return null;
  const keys = Object.keys(shift).sort();
  if (keys.length !== 2 || keys[0] !== 'amount' || keys[1] !== 'op'
      || !SHIFT_OPERATORS.has(shift.op)
      || !Number.isSafeInteger(shift.amount) || shift.amount < 0) return null;
  return framedTupleKey('operand-shift', [shift.op, shift.amount]);
}

function argumentCongruenceKey(argument, valueKey) {
  if (!isPlainRecord(argument) || valueKey == null || valueKey === INVALID_CONGRUENCE_KEY) return null;
  const allowed = new Set(['value', 'bits', 'shift', 'origin']);
  if (Object.keys(argument).some((key) => !allowed.has(key))) return null;
  let bits;
  if (Object.hasOwn(argument, 'bits')) {
    bits = argument.bits;
    if (!supportedResultWidth(bits) || !supportedResultWidth(argument.value?.bits)
        || bits > argument.value.bits) return null;
  }
  let shiftKey;
  if (Object.hasOwn(argument, 'shift')) {
    if (argument.shift == null) shiftKey = framedTupleKey('operand-shift-null', []);
    else {
      shiftKey = exactShiftKey(argument.shift);
      if (shiftKey == null) return null;
    }
  }
  return framedTupleKey('operand', [valueKey, bits, shiftKey]);
}

function scalarExtraKey(extra, producedBits, allowedSemanticKeys = new Map()) {
  if (extra == null) return framedTupleKey('scalar-extra', []);
  if (!isPlainRecord(extra)) return null;
  const allowedKeys = new Set([...COMMON_SCALAR_EXTRA_KEYS, ...allowedSemanticKeys.keys()]);
  if (Object.keys(extra).some((key) => !allowedKeys.has(key))) return null;
  if (Object.hasOwn(extra, 'semanticNodeId') && !supportedIdentityPrimitive(extra.semanticNodeId)) return null;
  // `attributes` is an open-ended producer metadata bag. Until the producer
  // gives every member a value-semantics contract, even an apparently empty
  // Proxy-backed bag cannot be treated as proof of scalar equality: ownKeys
  // may legally hide configurable fields. Keep such operations singleton.
  if (Object.hasOwn(extra, 'attributes')) return null;
  if (Object.hasOwn(extra, 'completeness') && extra.completeness !== 'complete') return null;
  if (Object.hasOwn(extra, 'widthBits') && extra.widthBits !== producedBits) return null;
  if (Object.hasOwn(extra, 'compatSource')
      && (typeof extra.compatSource !== 'string' || !extra.compatSource)) return null;
  const fields = [
    Object.hasOwn(extra, 'completeness'), extra.completeness,
    Object.hasOwn(extra, 'widthBits'), extra.widthBits,
    Object.hasOwn(extra, 'compatSource'), extra.compatSource,
  ];
  for (const [key, validator] of allowedSemanticKeys) {
    const present = Object.hasOwn(extra, key);
    const value = extra[key];
    if (present && !validator(value)) return null;
    fields.push(key, present, value);
  }
  return framedTupleKey('scalar-extra', fields);
}

function scalarOperationKey(instruction, produced, argumentKeys) {
  const resultType = producedBitvectorKey(produced, instruction);
  if (resultType == null || !hasOnlyOwnKeys(instruction, SCALAR_DEFINITION_KEYS)
      || typeof instruction.op !== 'string' || instruction.dst !== produced) {
    return null;
  }
  const operands = framedTupleKey('operands', argumentKeys);
  if (operands == null) return null;

  if (instruction.op === 'bin') {
    if (!BITVECTOR_BINARY_OPERATORS.has(instruction.sub) || argumentKeys.length !== 2) return null;
    const extra = scalarExtraKey(instruction.extra, produced.bits, new Map([
      ['negate', (value) => typeof value === 'boolean'],
    ]));
    if (extra == null) return null;
    const ordered = COMMUTATIVE.has(instruction.sub) ? [...argumentKeys].sort() : argumentKeys;
    return framedTupleKey('scalar-bin', [
      instruction.sub, resultType, extra, framedTupleKey('operands', ordered),
    ]);
  }
  if (instruction.op === 'un') {
    if (!BITVECTOR_UNARY_OPERATORS.has(instruction.sub) || argumentKeys.length !== 1) return null;
    const positiveWidth = (value) => supportedResultWidth(value);
    const extra = scalarExtraKey(instruction.extra, produced.bits, new Map([
      ['sourceBits', positiveWidth], ['targetBits', positiveWidth],
    ]));
    return extra == null ? null
      : framedTupleKey('scalar-un', [instruction.sub, resultType, extra, operands]);
  }
  if (instruction.op === 'mov') {
    // Zero-argument mov nodes are state reads. Their state identity is complex
    // metadata and deliberately remains singleton until it has a producer-owned
    // scalar equality contract.
    if (argumentKeys.length !== 1
        || (instruction.sub != null && typeof instruction.sub !== 'string')) return null;
    const positiveWidth = (value) => supportedResultWidth(value);
    const extra = scalarExtraKey(instruction.extra, produced.bits, new Map([
      ['castKind', (value) => typeof value === 'string' && value.length > 0],
      ['sourceBits', positiveWidth], ['targetBits', positiveWidth],
    ]));
    return extra == null ? null
      : framedTupleKey('scalar-mov', [instruction.sub, resultType, extra, operands]);
  }

  // cmp/sel/mac/bfx/bfi, FP/vector operations, state reads and unknown future
  // forms carry semantics beyond an op/sub/bits tuple. Missing CSE is safe;
  // merging one of those forms without a complete key is not.
  return null;
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
  if (!Array.isArray(value)) return false;
  const keys = Object.keys(value);
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
      || (Object.hasOwn(location, 'regionId') && location.regionId != null
        && !supportedIdentityPrimitive(location.regionId))
      || (Object.hasOwn(location, 'baseEntityId') && location.baseEntityId != null
        && !supportedIdentityPrimitive(location.baseEntityId))
      || (Object.hasOwn(location, 'scale')
        && (!Number.isSafeInteger(location.scale) || location.scale < 0))
      || (Object.hasOwn(location, 'address') && !scalarOffset(location.address))
      || (Object.hasOwn(location, 'disp') && !scalarOffset(location.disp))
      || (Object.hasOwn(location, 'uncertaintyIdentity')
        && location.uncertaintyIdentity != null)
      || (Object.hasOwn(location, 'addressMetadataSource')
        && (typeof location.addressMetadataSource !== 'string'
          || location.addressMetadataSource.length === 0))) {
    return null;
  }
  const base = Object.hasOwn(location, 'base') ? referenceIdKey(location.base) : null;
  const index = Object.hasOwn(location, 'index') ? referenceIdKey(location.index) : null;
  if ((Object.hasOwn(location, 'base') && base == null)
      || (Object.hasOwn(location, 'index') && index == null)) return null;
  return framedTupleKey('load-location', [
    location.key, location.kind, location.size,
    Object.hasOwn(location, 'regionId'), location.regionId,
    Object.hasOwn(location, 'base'), base,
    Object.hasOwn(location, 'baseEntityId'), location.baseEntityId,
    Object.hasOwn(location, 'index'), index,
    Object.hasOwn(location, 'scale'), location.scale,
    Object.hasOwn(location, 'address'), location.address,
    Object.hasOwn(location, 'disp'), location.disp,
    Object.hasOwn(location, 'uncertaintyIdentity'), location.uncertaintyIdentity,
    Object.hasOwn(location, 'addressMetadataSource'), location.addressMetadataSource,
  ]);
}

function loadAddressIdentity(address) {
  if (address == null) return framedTupleKey('load-address-absent', []);
  if (!hasOnlyOwnKeys(address, LOAD_ADDRESS_KEYS)
      || (Object.hasOwn(address, 'baseReg') && address.baseReg != null
        && !supportedIdentityPrimitive(address.baseReg))
      || (Object.hasOwn(address, 'disp') && !scalarOffset(address.disp))
      || (Object.hasOwn(address, 'scale')
        && (!Number.isSafeInteger(address.scale) || address.scale < 0))
      || (Object.hasOwn(address, 'extend') && address.extend != null
        && (typeof address.extend !== 'string' || address.extend.length === 0))
      || (Object.hasOwn(address, 'size')
        && (!Number.isSafeInteger(address.size) || address.size <= 0))
      || (Object.hasOwn(address, 'widthBits')
        && !supportedResultWidth(address.widthBits))
      || (Object.hasOwn(address, 'stack') && typeof address.stack !== 'boolean')
      || (Object.hasOwn(address, 'addressSpace') && address.addressSpace !== 'memory')
      || (Object.hasOwn(address, 'rawAddressValueId')
        && !supportedIdentityPrimitive(address.rawAddressValueId))
      || (Object.hasOwn(address, 'indexSignedness') && address.indexSignedness != null
        && !['signed', 'unsigned'].includes(address.indexSignedness))
      || (Object.hasOwn(address, 'indexWidthBits') && address.indexWidthBits != null
        && !supportedResultWidth(address.indexWidthBits))
      || (Object.hasOwn(address, 'addressWidthBits') && address.addressWidthBits != null
        && !supportedResultWidth(address.addressWidthBits))
      || (Object.hasOwn(address, 'precise') && address.precise !== true)
      || (Object.hasOwn(address, 'unknownReason') && address.unknownReason != null)
      || (Object.hasOwn(address, 'compatDisplacementEvidence')
        && (typeof address.compatDisplacementEvidence !== 'string'
          || address.compatDisplacementEvidence.length === 0))) {
    return null;
  }
  const base = Object.hasOwn(address, 'base') ? referenceIdKey(address.base) : null;
  const index = Object.hasOwn(address, 'index') ? referenceIdKey(address.index) : null;
  if ((Object.hasOwn(address, 'base') && base == null)
      || (Object.hasOwn(address, 'index') && index == null)) return null;
  return framedTupleKey('load-address', [
    Object.hasOwn(address, 'base'), base,
    Object.hasOwn(address, 'baseReg'), address.baseReg,
    Object.hasOwn(address, 'disp'), address.disp,
    Object.hasOwn(address, 'index'), index,
    Object.hasOwn(address, 'scale'), address.scale,
    Object.hasOwn(address, 'extend'), address.extend,
    Object.hasOwn(address, 'size'), address.size,
    Object.hasOwn(address, 'widthBits'), address.widthBits,
    Object.hasOwn(address, 'stack'), address.stack,
    Object.hasOwn(address, 'addressSpace'), address.addressSpace,
    Object.hasOwn(address, 'rawAddressValueId'), address.rawAddressValueId,
    Object.hasOwn(address, 'indexSignedness'), address.indexSignedness,
    Object.hasOwn(address, 'indexWidthBits'), address.indexWidthBits,
    Object.hasOwn(address, 'addressWidthBits'), address.addressWidthBits,
    Object.hasOwn(address, 'precise'), address.precise,
    Object.hasOwn(address, 'unknownReason'), address.unknownReason,
    Object.hasOwn(address, 'compatDisplacementEvidence'), address.compatDisplacementEvidence,
  ]);
}

function memoryDefinitionListKey(reaching) {
  if (!denseList(reaching)) return null;
  const framed = [];
  for (const entry of reaching) {
    if (!hasOnlyOwnKeys(entry, MEMORY_DEFINITION_ENTRY_KEYS)) return null;
    const aliases = [];
    if (Object.hasOwn(entry, 'inst') && entry.inst != null) {
      if (!hasOnlyOwnKeys(entry.inst, new Set(['id']))
          || !Object.hasOwn(entry.inst, 'id')) return null;
      aliases.push(entry.inst.id);
    }
    for (const key of ['id', 'instructionId', 'definitionId']) {
      if (Object.hasOwn(entry, key) && entry[key] != null) aliases.push(entry[key]);
    }
    if (aliases.length === 0 || aliases.some((id) => !supportedIdentityPrimitive(id))) return null;
    const id = aliases[0];
    if (aliases.some((candidate) => !Object.is(candidate, id))) return null;
    framed.push(framedTupleKey('memory-definition', [id]));
  }
  framed.sort();
  return framedTupleKey('memory-definition-list', framed);
}

function loadMemoryUseIdentity(use) {
  if (!hasOnlyOwnKeys(use, LOAD_MEMORY_USE_KEYS)
      || (Object.hasOwn(use, 'unknownAlias') && use.unknownAlias !== false)
      || (Object.hasOwn(use, 'clobber') && use.clobber !== false)
      || (Object.hasOwn(use, 'kind') && use.kind != null)
      || (Object.hasOwn(use, 'reason') && use.reason != null)) return null;
  const hasMemDefs = Object.hasOwn(use, 'memDefs');
  const hasReaching = Object.hasOwn(use, 'reaching');
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
      Object.hasOwn(use, 'unknownAlias'), use.unknownAlias,
      Object.hasOwn(use, 'clobber'), use.clobber,
      Object.hasOwn(use, 'kind'), use.kind,
      Object.hasOwn(use, 'reason'), use.reason,
    ]),
  };
}

function loadValueIdentity(definition, access) {
  if (!hasOnlyOwnKeys(definition, LOAD_DEFINITION_KEYS)
      || definition.op !== 'load' || definition.sub != null
      || !denseList(definition.args) || definition.args.length !== 0
      || definition.dst == null
      || definition.unknownAliasBarrier != null
      || (Object.hasOwn(definition, 'memoryAliasRelation')
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
  if (!Object.hasOwn(access, 'alignment')
      || (access.alignment !== null && (!Number.isSafeInteger(access.alignment) || access.alignment <= 0))) {
    return { ok:false, reason:'load memory alignment is missing or malformed' };
  }
  if (!isPlainRecord(access.addressExpr)
      || Object.keys(access.addressExpr).length !== 1
      || !Object.hasOwn(access.addressExpr, 'valueId')
      || !supportedIdentityPrimitive(access.addressExpr.valueId)) {
    return { ok:false, reason:'load address expression is missing or malformed' };
  }
  if (Object.hasOwn(access, 'addressValueId')
      && !Object.is(access.addressValueId, access.addressExpr.valueId)) {
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
  if (!Array.isArray(access.faults) || access.faults.length !== 0) {
    return { ok:false, reason:'load may fault or has malformed fault facts' };
  }
  if (Object.hasOwn(definition.extra, 'faults')
      && (!Array.isArray(definition.extra.faults) || definition.extra.faults.length !== 0)) {
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
    Object.hasOwn(definition, 'addr') ? definition.addr : null,
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
      Object.hasOwn(access, 'addressValueId'), access.addressValueId,
      access.alignment, definition.loc.kind, definition.loc.size,
      signed, extensionMode, resultType,
      definition.extra.completeness,
      Object.hasOwn(definition.extra, 'faults'),
      locationIdentity, addressIdentity, memoryUseIdentity.key,
      Object.hasOwn(definition, 'memoryAliasRelation'), definition.memoryAliasRelation,
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
    const result = new Set();
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
  const sets = new Map();
  if (!trustProvidedFacts) return sets;
  const raw = ir?.dominators;
  if (raw instanceof Map) {
    for (const [block, dominators] of raw) {
      const blockKey = keyOf(block);
      const canonical = canonicalIdSet(dominators, keyOf);
      if (blockKey == null || canonical == null) return new Map();
      sets.set(blockKey, canonical);
    }
    return sets;
  }
  if (Array.isArray(raw)) {
    for (let block = 0; block < raw.length; block += 1) {
      const canonical = canonicalIdSet(raw[block], keyOf);
      if (canonical == null) return new Map();
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
    if (blockKey == null) return new Map();
    const chain = new Set([blockKey]);
    let current = immediateOf(block);
    let guard = 0;
    while (current != null && guard < 4096) {
      const currentKey = keyOf(current);
      if (currentKey == null) return new Map();
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
  const snapshotBound = semanticSnapshotForAnalysis(analysis) != null;
  const resolvedIdentity = snapshotBound
    ? (context.resolvedAnalysisIdentity ?? canonicalAnalysisIdentity(context))
    : { valid:false, reason:'analysis state is not bound to an immutable Semantic IR snapshot' };
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
  const classes = new Map();
  const singletonReasons = new CanonicalValueIdMap(valueIdKey);
  const reuseCandidates = [];
  const diagnostics = [];
  // A native Map/Set cannot retain the sign of a zero key. If this adversarial
  // graph actually uses -0 as a block identity, do not consume ambiguous
  // cross-block dominance evidence; exact same-block checks remain available.
  const hasNegativeZeroBlock = blocks.some((block) => Object.is(block?.index, -0))
    || values.some((value) => Object.is(value?.def?.block, -0));
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
  const ambiguousNativeZeroFact = values.some((value) => Object.is(value.id, -0));
  const inputFact = (map, valueId) => (
    ambiguousNativeZeroFact && typeof valueId === 'number' && valueId === 0
      ? null : map?.get(valueId) ?? null
  );

  let nextNumber = 1;
  const keyToNumber = new Map();

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

      if (NEVER_CONGRUENT.has(instruction.op)) {
        singleton(produced, `${instruction.op} may produce a different value each time it runs`);
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

      if (!Array.isArray(instruction.args)) {
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
      const key = scalarOperationKey(instruction, produced, operands);
      if (key == null) {
        singleton(produced, 'operation identity has unsupported tuple fields');
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
          kind: 'scalar', valueId: produced.id, reuseOf: earlier.id,
          proof: 'identical supported scalar-bitvector operation and type over congruent operands; the earlier definition dominates',
        });
      }
    }
  }

  const congruentClasses = [...classes.values()].filter((members) => members.length > 1);
  const facts = Object.freeze({
    passVersion: GVN_PASS.version,
    numbers,
    classes,
    congruentClassCount: congruentClasses.length,
    reuseCandidates: Object.freeze(reuseCandidates),
    // Why each value could not be numbered with anything else. A missed reuse
    // with no reason recorded is indistinguishable from a reuse nobody looked for.
    singletonReasons,
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
      reason: [...new Set(blockedLoads.map(([, reason]) => reason))].slice(0, 4).join('; '),
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
