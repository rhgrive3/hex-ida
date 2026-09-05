import { deepFreeze, jsonSafe, stableStringify } from '../../core/identity/index.js';
import { createOriginSet } from '../../core/identity/origin.js';

export const MACHINE_EFFECTS_SCHEMA_VERSION = 1;
export const MACHINE_EFFECTS_CONTRACT_VERSION = '1.0.0';
export const MACHINE_EFFECT_DEFAULT_BUDGET = Object.freeze({
  maxOperations: 4096,
  maxPossibleFaults: 256,
  maxValuesPerOperation: 256,
  maxIntrinsicValues: 4096,
  maxIntrinsicRegisters: 4096,
  maxIntrinsicControlEffects: 256,
});

export const MACHINE_EFFECT_COMPLETENESS = Object.freeze([
  'exact',
  'exact-with-intrinsic',
  'partial',
  'unknown',
]);

export const PHYSICAL_ADDRESS_SPACES = Object.freeze([
  'register',
  'memory',
  'code',
  'tls',
  'io',
  'unique',
]);

export const MEMORY_ENDIANNESS = Object.freeze(['little', 'big']);
export const MEMORY_ORDERINGS = Object.freeze(['relaxed', 'acquire', 'release', 'acq-rel', 'seq-cst']);
export const CONTROL_EFFECT_KINDS = Object.freeze([
  'fallthrough',
  'branch',
  'conditional-branch',
  'call',
  'return',
  'trap',
  'indirect',
  'unknown',
]);
export const MACHINE_VALUE_KINDS = Object.freeze([
  'bitvector',
  'float',
  'vector',
  'predicate',
  'register',
  'memory',
  'code',
  'tls',
  'io',
  'temporary',
  'flag',
]);
export const MACHINE_OPERATION_KINDS = Object.freeze([
  'value',
  'register-read',
  'register-write',
  'flag-read',
  'flag-write',
  'memory-read',
  'memory-write',
  'intrinsic',
  'barrier',
  'unknown',
]);
export const UNKNOWN_EFFECT_CATEGORIES = Object.freeze([
  'registers',
  'flags',
  'memory',
  'control',
  'faults',
  'other',
]);
export const INTRINSIC_MEMORY_SCOPES = Object.freeze(['none', 'accesses', 'all', 'unknown']);
export const INTRINSIC_DETERMINISM = Object.freeze(['deterministic', 'input-dependent', 'nondeterministic', 'unknown']);
export const INTRINSIC_SYMBOLIC_DETAIL = Object.freeze(['available', 'summary-only', 'unavailable']);
export const UNDEFINED_RESULT_CLASSES = Object.freeze(['fully', 'conditional', 'partial', 'operand-dependent']);
export const UNDEFINED_RESULT_SCHEMA_VERSION = 'machine-effects-undefined-result/v1';
export const MAX_UNDEFINED_RESULT_WIDTH_BITS = 4096;

const SETS = Object.freeze({
  completeness: new Set(MACHINE_EFFECT_COMPLETENESS),
  spaces: new Set(PHYSICAL_ADDRESS_SPACES),
  endian: new Set(MEMORY_ENDIANNESS),
  orderings: new Set(MEMORY_ORDERINGS),
  controls: new Set(CONTROL_EFFECT_KINDS),
  values: new Set(MACHINE_VALUE_KINDS),
  operations: new Set(MACHINE_OPERATION_KINDS),
  unknownCategories: new Set(UNKNOWN_EFFECT_CATEGORIES),
  intrinsicMemoryScopes: new Set(INTRINSIC_MEMORY_SCOPES),
  intrinsicDeterminism: new Set(INTRINSIC_DETERMINISM),
  intrinsicSymbolicDetail: new Set(INTRINSIC_SYMBOLIC_DETAIL),
  undefinedResultClasses: new Set(UNDEFINED_RESULT_CLASSES),
});

function fail(code) { throw new TypeError(code); }
function assertAllowedKeys(input, allowed, code) {
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail(`${code}:${key}`);
}

function snapshotOwnEnumerableData(input, allowed, label, unexpectedCode) {
  if (input == null || typeof input !== 'object') fail(`machine-effects-${label}-required`);
  let isArray;
  let prototype;
  let keys;
  try {
    isArray = Array.isArray(input);
    prototype = Object.getPrototypeOf(input);
    keys = Reflect.ownKeys(input);
  } catch {
    fail(`machine-effects-${label}-snapshot-failed`);
  }
  if (isArray) fail(`machine-effects-${label}-required`);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`machine-effects-${label}-invalid-prototype`);
  }
  const snapshot = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      fail(`${unexpectedCode}:${typeof key === 'string' ? key : 'symbol'}`);
    }
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(input, key); }
    catch { fail(`machine-effects-${label}-snapshot-failed`); }
    if (descriptor == null || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      fail(`machine-effects-${label}-requires-enumerable-data-property:${key}`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function ownDataProperty(input, key, code) {
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(input, key); }
  catch { fail(code); }
  if (descriptor == null) return { present:false, value:undefined };
  if (descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) fail(code);
  return { present:true, value:descriptor.value };
}

function snapshotSerializableData(value, code, seen = new WeakSet()) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'bigint') return jsonSafe(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(code);
    return value;
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') fail(code);
  if (typeof value !== 'object' || seen.has(value)) fail(code);
  let prototype;
  let keys;
  let isArray;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
    isArray = Array.isArray(value);
  } catch { fail(code); }
  if ((!isArray && prototype !== Object.prototype && prototype !== null)
    || (isArray && prototype !== Array.prototype)) fail(code);
  seen.add(value);
  const out = isArray ? [] : {};
  for (const key of keys) {
    if (typeof key !== 'string') fail(code);
    if (isArray && key === 'length') continue;
    if (isArray && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) fail(code);
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
    catch { fail(code); }
    if (descriptor == null || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) fail(code);
    out[key] = snapshotSerializableData(descriptor.value, code, seen);
  }
  seen.delete(value);
  return out;
}
// Pre-built field whitelists. Same members as the per-call literal sets they
// replace; hoisted so millions of normalize calls allocate no Set objects.
const ALLOWED_FIELDS = Object.freeze({
  bitvectorValue: new Set(['kind', 'widthBits', 'value']),
  floatValue: new Set(['kind', 'widthBits', 'format', 'bitPattern', 'semanticValue']),
  vectorValue: new Set(['kind', 'laneCount', 'elementType']),
  predicateValue: new Set(['kind', 'widthBits', 'laneCount']),
  registerValue: new Set(['kind', 'registerId', 'widthBits', 'view']),
  flagValue: new Set(['kind', 'flagId', 'widthBits']),
  temporaryValue: new Set(['kind', 'temporaryId', 'id', 'valueType']),
  locationValue: new Set(['kind', 'addressExpr', 'widthBits']),
  memoryAccess: new Set(['space', 'addressExpr', 'widthBits', 'alignment', 'endian', 'volatility', 'atomic', 'ordering']),
  controlEffect: new Set(['kind', 'target', 'targets', 'condition', 'fallthrough', 'reason']),
  fault: new Set(['kind', 'condition', 'detail']),
  intrinsicMemoryScope: new Set(['scope', 'accesses', 'spaces', 'detail']),
  intrinsicSummary: new Set(['inputs', 'outputs', 'registersRead', 'registersWritten', 'memoryRead', 'memoryWrite', 'controlEffects', 'determinism', 'symbolicDetail']),
  unknownEffects: new Set(['categories', 'reason', 'detail', 'preservation']),
  statePreservation: new Set(['proven', 'reason']),
  undefinedResult: new Set(['schemaVersion', 'widthBits', 'mask', 'class', 'reason', 'condition']),
  bundle: new Set(['schemaVersion', 'contractVersion', 'instructionId', 'architectureId', 'mode', 'operations', 'controlEffect', 'possibleFaults', 'origin', 'completeness', 'unknownEffects', 'statePreservation', 'metadata']),
});
const OPERATION_FIELDS_BY_KIND = Object.freeze({
  value: new Set(['kind', 'id', 'metadata', 'opcode', 'inputs', 'outputs', 'undefinedResult']),
  'register-read': new Set(['kind', 'id', 'metadata', 'register', 'value']),
  'register-write': new Set(['kind', 'id', 'metadata', 'register', 'value']),
  'flag-read': new Set(['kind', 'id', 'metadata', 'flag', 'value']),
  'flag-write': new Set(['kind', 'id', 'metadata', 'flag', 'value']),
  'memory-read': new Set(['kind', 'id', 'metadata', 'access', 'value', 'undefinedResult']),
  'memory-write': new Set(['kind', 'id', 'metadata', 'access', 'value']),
  intrinsic: new Set(['kind', 'id', 'metadata', 'intrinsicId', 'effectSummary', 'undefinedResult']),
  barrier: new Set(['kind', 'id', 'metadata', 'scope']),
  unknown: new Set(['kind', 'id', 'metadata', 'reason', 'categories']),
});
// Canonical registries. Objects produced by the normalizers below are already
// fully validated, budget-compliant, and deep-frozen, so re-entering them is
// a proven identity: the full path would rebuild an object with identical
// fields and stableStringify the same bytes. The lift/audit path normalizes
// every bundle at least twice (create then validate), so this memo removes a
// complete duplicate normalization pass per instruction. Re-normalization is
// only skipped when default budgets apply: a caller-supplied tighter budget
// must still be able to reject an over-budget structure.
const CANONICAL_VALUES = new WeakSet();
const CANONICAL_OPERATIONS = new WeakSet();
const CANONICAL_BUNDLES = new WeakSet();
function usesDefaultBudget(options) {
  return options?.budget == null;
}
function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}
function nonEmpty(value, code) {
  if (typeof value !== 'string') fail(code);
  const text = value.trim();
  if (!text) fail(code);
  return text;
}
function positiveInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(code);
  return number;
}
function optionalPositiveInteger(value, code) {
  return value == null ? undefined : positiveInteger(value, code);
}
function booleanOrUndefined(value, code) {
  if (value == null) return undefined;
  if (typeof value !== 'boolean') fail(code);
  return value;
}
function enumValue(value, allowed, code) {
  const text = nonEmpty(value, code);
  if (!allowed.has(text)) fail(code);
  return text;
}
function array(value, code) {
  if (!Array.isArray(value)) fail(code);
  return value;
}
function budgetLimit(options, key) {
  const fallback = MACHINE_EFFECT_DEFAULT_BUDGET[key];
  const candidate = options?.budget?.[key];
  return candidate == null ? fallback : positiveInteger(candidate, `machine-effects-invalid-budget-${key}`);
}
function boundedArray(value, code, options, budgetKey) {
  const values = array(value, code);
  if (values.length > budgetLimit(options, budgetKey)) fail(`machine-effects-budget-exceeded-${budgetKey}`);
  return values;
}
function uniqueSortedStrings(value, code) {
  return [...new Set(array(value, code).map((item) => nonEmpty(item, code)))].sort();
}
function assertNotAborted(options) {
  if (options?.signal?.aborted) {
    const error = new Error('machine-effects-cancelled');
    error.name = 'AbortError';
    throw error;
  }
}

function strictSerializable(value, code, seen = new WeakSet()) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'bigint') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(code);
    return;
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') fail(code);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date) return;
  if (typeof value !== 'object') fail(code);
  if (seen.has(value)) fail(code);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) strictSerializable(item, code, seen);
  } else {
    for (const item of Object.values(value)) strictSerializable(item, code, seen);
  }
  seen.delete(value);
}
function serializable(value, code) {
  strictSerializable(value, code);
  return jsonSafe(value);
}

function bigintValue(value, code) {
  try { return typeof value === 'bigint' ? value : BigInt(value); }
  catch { fail(code); }
}

function undefinedResultMask(value) {
  const code = 'machine-effects-invalid-undefined-result-mask';
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail(code);
    return BigInt(value);
  }
  if (typeof value === 'string') {
    if (!/^(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(value)) fail(code);
    try { return BigInt(value); } catch { fail(code); }
  }
  fail(code);
}

function normalizeBitvectorValue(input) {
  assertAllowedKeys(input, ALLOWED_FIELDS.bitvectorValue, 'machine-effects-unexpected-value-field');
  const widthBits = positiveInteger(input.widthBits, 'machine-effects-invalid-bitvector-width');
  const out = { kind: 'bitvector', widthBits };
  if (input.value != null) {
    const value = bigintValue(input.value, 'machine-effects-invalid-bitvector-value');
    if (value < 0n || value >= (1n << BigInt(widthBits))) fail('machine-effects-bitvector-value-out-of-range');
    out.value = value.toString();
  }
  return out;
}

function normalizeFloatValue(input) {
  assertAllowedKeys(input, ALLOWED_FIELDS.floatValue, 'machine-effects-unexpected-value-field');
  const widthBits = positiveInteger(input.widthBits, 'machine-effects-invalid-float-width');
  const format = nonEmpty(input.format, 'machine-effects-float-format-required');
  const out = { kind: 'float', widthBits, format };
  if (input.bitPattern != null) {
    const bitPattern = bigintValue(input.bitPattern, 'machine-effects-invalid-float-bit-pattern');
    if (bitPattern < 0n || bitPattern >= (1n << BigInt(widthBits))) fail('machine-effects-float-bit-pattern-out-of-range');
    out.bitPattern = bitPattern.toString();
  }
  if (input.semanticValue != null) out.semanticValue = nonEmpty(input.semanticValue, 'machine-effects-invalid-float-value');
  return out;
}

export function createMachineValue(input, options = {}) {
  assertNotAborted(options);
  if (CANONICAL_VALUES.has(input) && usesDefaultBudget(options)) return input;
  input = object(input, 'machine-effects-invalid-value');
  const kind = enumValue(input.kind, SETS.values, 'machine-effects-invalid-value-kind');
  let out;

  switch (kind) {
    case 'bitvector': out = normalizeBitvectorValue(input); break;
    case 'float': out = normalizeFloatValue(input); break;
    case 'vector': {
      assertAllowedKeys(input, ALLOWED_FIELDS.vectorValue, 'machine-effects-unexpected-value-field');
      const laneCount = positiveInteger(input.laneCount, 'machine-effects-invalid-vector-lane-count');
      const elementType = createMachineValue(input.elementType, options);
      if (!['bitvector', 'float', 'predicate'].includes(elementType.kind)) fail('machine-effects-invalid-vector-element-type');
      out = { kind, laneCount, elementType };
      break;
    }
    case 'predicate': {
      assertAllowedKeys(input, ALLOWED_FIELDS.predicateValue, 'machine-effects-unexpected-value-field');
      out = { kind, widthBits: positiveInteger(input.widthBits, 'machine-effects-invalid-predicate-width') };
      if (input.laneCount != null) out.laneCount = positiveInteger(input.laneCount, 'machine-effects-invalid-predicate-lane-count');
      break;
    }
    case 'register':
      assertAllowedKeys(input, ALLOWED_FIELDS.registerValue, 'machine-effects-unexpected-value-field');
      out = {
        kind,
        registerId: nonEmpty(input.registerId, 'machine-effects-register-id-required'),
        widthBits: positiveInteger(input.widthBits, 'machine-effects-invalid-register-width'),
      };
      if (input.view != null) out.view = nonEmpty(input.view, 'machine-effects-invalid-register-view');
      break;
    case 'flag':
      assertAllowedKeys(input, ALLOWED_FIELDS.flagValue, 'machine-effects-unexpected-value-field');
      out = {
        kind,
        flagId: nonEmpty(input.flagId, 'machine-effects-flag-id-required'),
        widthBits: input.widthBits == null ? 1 : positiveInteger(input.widthBits, 'machine-effects-invalid-flag-width'),
      };
      break;
    case 'temporary':
      assertAllowedKeys(input, ALLOWED_FIELDS.temporaryValue, 'machine-effects-unexpected-value-field');
      out = {
        kind,
        temporaryId: nonEmpty(input.temporaryId ?? input.id, 'machine-effects-temporary-id-required'),
        valueType: createMachineValue(input.valueType, options),
      };
      break;
    case 'memory':
    case 'code':
    case 'tls':
    case 'io':
      assertAllowedKeys(input, ALLOWED_FIELDS.locationValue, 'machine-effects-unexpected-value-field');
      out = {
        kind,
        addressExpr: serializable(input.addressExpr, 'machine-effects-invalid-address-expression'),
        widthBits: positiveInteger(input.widthBits, 'machine-effects-invalid-location-width'),
      };
      break;
    default:
      fail('machine-effects-invalid-value-kind');
  }

  const frozen = deepFreeze(out);
  CANONICAL_VALUES.add(frozen);
  return frozen;
}

export function createBitVectorValue(widthBits, value) {
  return createMachineValue({ kind: 'bitvector', widthBits, ...(value == null ? {} : { value }) });
}
export function createRegisterValue(registerId, widthBits, options = {}) {
  return createMachineValue({ kind: 'register', registerId, widthBits, ...options });
}
export function createFlagValue(flagId, widthBits = 1) {
  return createMachineValue({ kind: 'flag', flagId, widthBits });
}
export function createTemporaryValue(temporaryId, valueType) {
  return createMachineValue({ kind: 'temporary', temporaryId, valueType });
}
export function createFloatValue(widthBits, format, options = {}) {
  return createMachineValue({ kind: 'float', widthBits, format, ...options });
}
export function createVectorValue(laneCount, elementType) {
  return createMachineValue({ kind: 'vector', laneCount, elementType });
}
export function createPredicateValue(widthBits, laneCount) {
  return createMachineValue({ kind: 'predicate', widthBits, ...(laneCount == null ? {} : { laneCount }) });
}
export function createLocationValue(kind, addressExpr, widthBits) {
  if (!['memory','code','tls','io'].includes(kind)) fail('machine-effects-invalid-location-kind');
  return createMachineValue({ kind, addressExpr, widthBits });
}

export function createMemoryAccess(input, options = {}) {
  assertNotAborted(options);
  input = object(input, 'machine-effects-invalid-memory-access');
  assertAllowedKeys(input, ALLOWED_FIELDS.memoryAccess, 'machine-effects-unexpected-memory-access-field');
  const space = enumValue(input.space, SETS.spaces, 'machine-effects-invalid-memory-space');
  if (space === 'register' || space === 'unique') fail('machine-effects-memory-space-not-addressable');
  const out = {
    space,
    addressExpr: serializable(input.addressExpr, 'machine-effects-invalid-address-expression'),
    widthBits: positiveInteger(input.widthBits, 'machine-effects-invalid-memory-width'),
    endian: enumValue(input.endian, SETS.endian, 'machine-effects-invalid-endian'),
  };
  const alignment = optionalPositiveInteger(input.alignment, 'machine-effects-invalid-memory-alignment');
  if (alignment != null) out.alignment = alignment;
  const volatility = booleanOrUndefined(input.volatility, 'machine-effects-invalid-volatility');
  if (volatility != null) out.volatility = volatility;
  const atomic = booleanOrUndefined(input.atomic, 'machine-effects-invalid-atomic');
  if (atomic != null) out.atomic = atomic;
  if (input.ordering != null) {
    out.ordering = enumValue(input.ordering, SETS.orderings, 'machine-effects-invalid-memory-ordering');
    if (atomic === false) fail('machine-effects-ordering-requires-atomic-access');
  }
  return deepFreeze(out);
}

function normalizeControlEffect(input, options = {}) {
  assertNotAborted(options);
  input = object(input, 'machine-effects-control-effect-required');
  assertAllowedKeys(input, ALLOWED_FIELDS.controlEffect, 'machine-effects-unexpected-control-effect-field');
  const kind = enumValue(input.kind, SETS.controls, 'machine-effects-invalid-control-effect');
  const out = { kind };
  if (input.target != null) out.target = serializable(input.target, 'machine-effects-invalid-control-target');
  if (input.targets != null) out.targets = array(input.targets, 'machine-effects-invalid-control-targets').map((value) => serializable(value, 'machine-effects-invalid-control-target'));
  if (input.condition != null) out.condition = serializable(input.condition, 'machine-effects-invalid-control-condition');
  if (input.fallthrough != null) out.fallthrough = serializable(input.fallthrough, 'machine-effects-invalid-control-fallthrough');
  if (input.reason != null) out.reason = nonEmpty(input.reason, 'machine-effects-invalid-control-reason');
  if (kind === 'unknown' && !out.reason) fail('machine-effects-unknown-control-reason-required');
  return deepFreeze(out);
}

function normalizeFault(input) {
  input = object(input, 'machine-effects-invalid-fault');
  assertAllowedKeys(input, ALLOWED_FIELDS.fault, 'machine-effects-unexpected-fault-field');
  const out = { kind: nonEmpty(input.kind, 'machine-effects-fault-kind-required') };
  if (input.condition != null) out.condition = serializable(input.condition, 'machine-effects-invalid-fault-condition');
  if (input.detail != null) out.detail = serializable(input.detail, 'machine-effects-invalid-fault-detail');
  return deepFreeze(out);
}

function normalizeIntrinsicMemoryScope(input, options = {}) {
  assertNotAborted(options);
  input = object(input, 'machine-effects-intrinsic-memory-scope-required');
  assertAllowedKeys(input, ALLOWED_FIELDS.intrinsicMemoryScope, 'machine-effects-unexpected-intrinsic-memory-field');
  const scope = enumValue(input.scope, SETS.intrinsicMemoryScopes, 'machine-effects-invalid-intrinsic-memory-scope');
  if (scope !== 'accesses' && input.accesses != null) fail('machine-effects-intrinsic-memory-accesses-not-allowed');
  if (scope !== 'all' && input.spaces != null) fail('machine-effects-intrinsic-memory-spaces-not-allowed');
  const out = { scope };
  if (scope === 'accesses') {
    const accesses = array(input.accesses, 'machine-effects-intrinsic-memory-accesses-required').map((access) => createMemoryAccess(access, options));
    if (accesses.length === 0) fail('machine-effects-intrinsic-memory-accesses-required');
    out.accesses = accesses;
  }
  if (scope === 'all') {
    out.spaces = uniqueSortedStrings(input.spaces, 'machine-effects-intrinsic-memory-spaces-required');
    if (out.spaces.length === 0 || out.spaces.some((space) => !SETS.spaces.has(space) || space === 'register' || space === 'unique')) {
      fail('machine-effects-invalid-intrinsic-memory-spaces');
    }
  }
  if (input.detail != null) out.detail = serializable(input.detail, 'machine-effects-invalid-intrinsic-memory-detail');
  return deepFreeze(out);
}

export function createIntrinsicEffectSummary(input, options = {}) {
  assertNotAborted(options);
  input = object(input, 'machine-effects-intrinsic-summary-required');
  assertAllowedKeys(input, ALLOWED_FIELDS.intrinsicSummary, 'machine-effects-unexpected-intrinsic-summary-field');
  const out = {
    inputs: boundedArray(input.inputs, 'machine-effects-intrinsic-inputs-required', options, 'maxIntrinsicValues').map((value) => createMachineValue(value, options)),
    outputs: boundedArray(input.outputs, 'machine-effects-intrinsic-outputs-required', options, 'maxIntrinsicValues').map((value) => createMachineValue(value, options)),
    registersRead: uniqueSortedStrings(boundedArray(input.registersRead, 'machine-effects-intrinsic-registers-read-required', options, 'maxIntrinsicRegisters'), 'machine-effects-intrinsic-registers-read-required'),
    registersWritten: uniqueSortedStrings(boundedArray(input.registersWritten, 'machine-effects-intrinsic-registers-written-required', options, 'maxIntrinsicRegisters'), 'machine-effects-intrinsic-registers-written-required'),
    memoryRead: normalizeIntrinsicMemoryScope(input.memoryRead, options),
    memoryWrite: normalizeIntrinsicMemoryScope(input.memoryWrite, options),
    controlEffects: boundedArray(input.controlEffects, 'machine-effects-intrinsic-control-effects-required', options, 'maxIntrinsicControlEffects').map((effect) => normalizeControlEffect(effect, options)),
    determinism: enumValue(input.determinism, SETS.intrinsicDeterminism, 'machine-effects-invalid-intrinsic-determinism'),
    symbolicDetail: enumValue(input.symbolicDetail, SETS.intrinsicSymbolicDetail, 'machine-effects-invalid-intrinsic-symbolic-detail'),
  };
  return deepFreeze(out);
}

function intrinsicSummaryIsComplete(summary) {
  if (summary.memoryRead.scope === 'unknown' || summary.memoryWrite.scope === 'unknown') return false;
  if (summary.controlEffects.some((effect) => effect.kind === 'unknown')) return false;
  return summary.determinism !== 'unknown';
}

export function createUndefinedResultDescriptor(input) {
  input = snapshotOwnEnumerableData(input, ALLOWED_FIELDS.undefinedResult,
    'undefined-result', 'machine-effects-unexpected-undefined-result-field');
  const schemaVersion = Object.hasOwn(input, 'schemaVersion')
    ? input.schemaVersion : UNDEFINED_RESULT_SCHEMA_VERSION;
  if (schemaVersion !== UNDEFINED_RESULT_SCHEMA_VERSION) fail('machine-effects-unsupported-undefined-result-schema');
  if (typeof input.widthBits !== 'number') fail('machine-effects-invalid-undefined-result-width');
  const widthBits = positiveInteger(input.widthBits, 'machine-effects-invalid-undefined-result-width');
  if (widthBits > MAX_UNDEFINED_RESULT_WIDTH_BITS) fail('machine-effects-invalid-undefined-result-width');
  const resultClass = enumValue(input.class, SETS.undefinedResultClasses, 'machine-effects-invalid-undefined-result-class');
  const mask = undefinedResultMask(input.mask);
  const fullMask = (1n << BigInt(widthBits)) - 1n;
  if (mask <= 0n || mask > fullMask) fail('machine-effects-invalid-undefined-result-mask');
  if (resultClass === 'fully' && mask !== fullMask) fail('machine-effects-fully-undefined-result-mask-incomplete');
  if (resultClass === 'partial' && mask === fullMask) fail('machine-effects-partial-undefined-result-mask-full');
  const conditionRequired = resultClass === 'conditional' || resultClass === 'operand-dependent';
  const conditionPresent = Object.hasOwn(input, 'condition');
  if (conditionRequired !== conditionPresent || (conditionPresent && input.condition == null)) {
    fail(conditionRequired
      ? 'machine-effects-undefined-result-condition-required'
      : 'machine-effects-undefined-result-condition-not-allowed');
  }
  const out = {
    schemaVersion: UNDEFINED_RESULT_SCHEMA_VERSION,
    widthBits,
    mask: `0x${mask.toString(16).padStart(Math.ceil(widthBits / 4), '0')}`,
    class: resultClass,
    reason: nonEmpty(input.reason, 'machine-effects-undefined-result-reason-required'),
  };
  if (conditionRequired) out.condition = snapshotSerializableData(input.condition, 'machine-effects-invalid-undefined-result-condition');
  return deepFreeze(out);
}

function resultWidthBits(value) {
  if (value?.kind === 'temporary') return resultWidthBits(value.valueType);
  if (value?.kind === 'vector') {
    const elementBits = resultWidthBits(value.elementType);
    return elementBits == null ? null : elementBits * value.laneCount;
  }
  return Number.isSafeInteger(value?.widthBits) ? value.widthBits : null;
}

export function createMachineOperation(input, options = {}) {
  assertNotAborted(options);
  if (CANONICAL_OPERATIONS.has(input) && usesDefaultBudget(options)) return input;
  input = object(input, 'machine-effects-invalid-operation');
  const kind = enumValue(input.kind, SETS.operations, 'machine-effects-invalid-operation-kind');
  const allowedFields = OPERATION_FIELDS_BY_KIND[kind];
  if (!allowedFields) fail('machine-effects-invalid-operation-kind');
  assertAllowedKeys(input, allowedFields, 'machine-effects-unexpected-operation-field');
  const undefinedResultProperty = ownDataProperty(input, 'undefinedResult',
    'machine-effects-undefined-result-requires-enumerable-data-property');
  const out = { kind };
  if (input.id != null) out.id = nonEmpty(input.id, 'machine-effects-invalid-operation-id');

  if (kind === 'value') {
    out.opcode = nonEmpty(input.opcode, 'machine-effects-value-opcode-required');
    out.inputs = boundedArray(input.inputs ?? [], 'machine-effects-invalid-operation-inputs', options, 'maxValuesPerOperation').map((value) => createMachineValue(value, options));
    out.outputs = boundedArray(input.outputs, 'machine-effects-operation-outputs-required', options, 'maxValuesPerOperation').map((value) => createMachineValue(value, options));
    if (out.outputs.length === 0) fail('machine-effects-operation-outputs-required');
  } else if (kind === 'register-read' || kind === 'register-write') {
    out.register = createMachineValue(input.register, options);
    if (out.register.kind !== 'register') fail('machine-effects-register-operation-requires-register-value');
    out.value = createMachineValue(input.value, options);
  } else if (kind === 'flag-read' || kind === 'flag-write') {
    out.flag = createMachineValue(input.flag, options);
    if (out.flag.kind !== 'flag') fail('machine-effects-flag-operation-requires-flag-value');
    out.value = createMachineValue(input.value, options);
  } else if (kind === 'memory-read' || kind === 'memory-write') {
    out.access = createMemoryAccess(input.access, options);
    out.value = createMachineValue(input.value, options);
  } else if (kind === 'intrinsic') {
    out.intrinsicId = nonEmpty(input.intrinsicId, 'machine-effects-intrinsic-id-required');
    out.effectSummary = createIntrinsicEffectSummary(input.effectSummary, options);
  } else if (kind === 'barrier') {
    out.scope = serializable(input.scope, 'machine-effects-barrier-scope-required');
  } else if (kind === 'unknown') {
    out.reason = nonEmpty(input.reason, 'machine-effects-unknown-operation-reason-required');
    out.categories = uniqueSortedStrings(input.categories, 'machine-effects-unknown-operation-categories-required');
    if (out.categories.length === 0 || out.categories.some((category) => !SETS.unknownCategories.has(category))) {
      fail('machine-effects-invalid-unknown-operation-categories');
    }
  }

  if (undefinedResultProperty.present) {
    const descriptor = createUndefinedResultDescriptor(undefinedResultProperty.value);
    const results = kind === 'value' ? out.outputs
      : kind === 'intrinsic' ? out.effectSummary.outputs
        : kind === 'memory-read' ? [out.value] : [];
    const inputs = kind === 'value' ? out.inputs
      : kind === 'intrinsic' ? out.effectSummary.inputs : [];
    if (results.length !== 1 || resultWidthBits(results[0]) !== descriptor.widthBits) {
      fail('machine-effects-undefined-result-output-width-mismatch');
    }
    if (descriptor.condition != null && Object.hasOwn(descriptor.condition, 'operandIndex')) {
      const operandIndex = descriptor.condition.operandIndex;
      if (!Number.isSafeInteger(operandIndex) || operandIndex < 0) {
        fail('machine-effects-invalid-undefined-result-condition-operand');
      }
      if (operandIndex >= inputs.length) fail('machine-effects-undefined-result-condition-operand-out-of-range');
    }
    out.undefinedResult = descriptor;
  }
  if (input.metadata != null) out.metadata = serializable(input.metadata, 'machine-effects-invalid-operation-metadata');
  const frozen = deepFreeze(out);
  CANONICAL_OPERATIONS.add(frozen);
  return frozen;
}

export function createUnknownEffects(input) {
  input = object(input, 'machine-effects-unknown-effects-required');
  assertAllowedKeys(input, ALLOWED_FIELDS.unknownEffects, 'machine-effects-unexpected-unknown-effects-field');
  const categories = uniqueSortedStrings(input.categories, 'machine-effects-unknown-categories-required');
  if (categories.length === 0 || categories.some((category) => !SETS.unknownCategories.has(category))) {
    fail('machine-effects-invalid-unknown-categories');
  }
  if (input.preservation != null && input.preservation !== 'not-assumed') fail('machine-effects-unknown-effects-cannot-assume-preservation');
  const out = {
    categories,
    reason: nonEmpty(input.reason, 'machine-effects-unknown-reason-required'),
    preservation: 'not-assumed',
  };
  if (input.detail != null) out.detail = serializable(input.detail, 'machine-effects-invalid-unknown-detail');
  return deepFreeze(out);
}

function normalizeStatePreservation(input) {
  input = object(input, 'machine-effects-state-preservation-proof-required');
  assertAllowedKeys(input, ALLOWED_FIELDS.statePreservation, 'machine-effects-unexpected-state-preservation-field');
  if (input.proven !== true) fail('machine-effects-state-preservation-proof-required');
  return deepFreeze({ proven: true, reason: nonEmpty(input.reason, 'machine-effects-state-preservation-reason-required') });
}

function validateCompletenessSemantics(bundle) {
  const hasUnknownOperation = bundle.operations.some((operation) => operation.kind === 'unknown');
  const intrinsics = bundle.operations.filter((operation) => operation.kind === 'intrinsic');
  const intrinsicIsIncomplete = intrinsics.some((operation) => !intrinsicSummaryIsComplete(operation.effectSummary));
  const controlUnknown = bundle.controlEffect.kind === 'unknown';
  const unresolved = hasUnknownOperation || intrinsicIsIncomplete || controlUnknown;

  if (bundle.completeness === 'exact') {
    if (bundle.unknownEffects != null || unresolved || intrinsics.length !== 0) fail('machine-effects-exact-has-unresolved-effects');
  }
  if (bundle.completeness === 'exact-with-intrinsic') {
    if (bundle.unknownEffects != null || unresolved || intrinsics.length === 0) fail('machine-effects-intrinsic-completeness-invalid');
  }
  if (bundle.completeness === 'partial') {
    if (bundle.unknownEffects == null) fail('machine-effects-partial-requires-explicit-unknown-effects');
  }
  if (bundle.completeness === 'unknown') {
    if (bundle.unknownEffects == null) fail('machine-effects-unknown-requires-explicit-unknown-effects');
    if (bundle.operations.length !== 0 || bundle.controlEffect.kind !== 'unknown') fail('machine-effects-unknown-bundle-must-not-imply-known-state');
  }

  const silentPreserve = (bundle.completeness === 'exact' || bundle.completeness === 'exact-with-intrinsic')
    && bundle.operations.length === 0
    && bundle.controlEffect.kind === 'fallthrough'
    && bundle.possibleFaults.length === 0;
  if (silentPreserve && bundle.statePreservation == null) fail('machine-effects-silent-preserve-requires-proof');
  if (!silentPreserve && bundle.statePreservation != null) fail('machine-effects-state-preservation-conflicts-with-effects');
}

function normalizeBundle(input, options = {}, requireVersion = false) {
  assertNotAborted(options);
  // A canonical bundle already embeds the current schema/contract versions, so
  // the requireVersion path is satisfied by construction.
  if (CANONICAL_BUNDLES.has(input) && usesDefaultBudget(options)) return input;
  input = object(input, 'machine-effects-invalid-bundle');
  assertAllowedKeys(input, ALLOWED_FIELDS.bundle, 'machine-effects-unexpected-bundle-field');

  if (requireVersion) {
    if (input.schemaVersion !== MACHINE_EFFECTS_SCHEMA_VERSION || input.contractVersion !== MACHINE_EFFECTS_CONTRACT_VERSION) {
      fail('machine-effects-unsupported-contract-version');
    }
  } else {
    if (input.schemaVersion != null && input.schemaVersion !== MACHINE_EFFECTS_SCHEMA_VERSION) fail('machine-effects-unsupported-schema-version');
    if (input.contractVersion != null && input.contractVersion !== MACHINE_EFFECTS_CONTRACT_VERSION) fail('machine-effects-unsupported-contract-version');
  }

  const instructionId = nonEmpty(input.instructionId, 'machine-effects-instruction-id-required');
  const origin = createOriginSet(input.origin);
  if (!origin.instructionIds.includes(instructionId)) fail('machine-effects-origin-must-reference-instruction');

  const bundle = {
    schemaVersion: MACHINE_EFFECTS_SCHEMA_VERSION,
    contractVersion: MACHINE_EFFECTS_CONTRACT_VERSION,
    instructionId,
    architectureId: nonEmpty(input.architectureId, 'machine-effects-architecture-id-required'),
    mode: nonEmpty(input.mode, 'machine-effects-mode-required'),
    operations: boundedArray(input.operations, 'machine-effects-operations-required', options, 'maxOperations').map((operation) => createMachineOperation(operation, options)),
    controlEffect: normalizeControlEffect(input.controlEffect, options),
    possibleFaults: boundedArray(input.possibleFaults, 'machine-effects-possible-faults-required', options, 'maxPossibleFaults').map(normalizeFault),
    origin,
    completeness: enumValue(input.completeness, SETS.completeness, 'machine-effects-invalid-completeness'),
  };

  if (input.unknownEffects != null) bundle.unknownEffects = createUnknownEffects(input.unknownEffects);
  if (input.statePreservation != null) bundle.statePreservation = normalizeStatePreservation(input.statePreservation);
  if (input.metadata != null) bundle.metadata = serializable(input.metadata, 'machine-effects-invalid-metadata');

  validateCompletenessSemantics(bundle);
  const frozen = deepFreeze(bundle);
  CANONICAL_BUNDLES.add(frozen);
  return frozen;
}

export function createMachineEffectBundle(input, options = {}) {
  return normalizeBundle(input, options, false);
}

export function validateMachineEffectBundle(input, options = {}) {
  return normalizeBundle(input, options, true);
}

export function serializeMachineEffectBundle(input, options = {}) {
  assertNotAborted(options);
  return stableStringify(validateMachineEffectBundle(input, options));
}

export function deserializeMachineEffectBundle(text, options = {}) {
  assertNotAborted(options);
  if (typeof text !== 'string') fail('machine-effects-serialized-text-required');
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { fail('machine-effects-invalid-serialized-json'); }
  return validateMachineEffectBundle(parsed, options);
}
