import { deepFreeze, jsonSafe, stableStringify } from '../../core/identity/index.js';
import { createOriginSet } from '../../core/identity/origin.js';

export const VM_EFFECTS_SCHEMA_VERSION = 1;
export const VM_EFFECTS_CONTRACT_VERSION = '1.0.0';

export const VM_EFFECT_DEFAULT_BUDGET = Object.freeze({
  maxOperations: 16384,
  maxValues: 32768,
  maxExceptionRegions: 1024,
});

export const VM_EFFECT_COMPLETENESS = Object.freeze([
  'exact',
  'exact-with-intrinsic',
  'partial',
  'unknown',
]);

/* #5404: the resolution taxonomy mirrors the conservative completeness lattice
   the runtime evidence bridge derives from resolution states. */
export const VM_EFFECT_RESOLUTION_COMPLETENESS = Object.freeze([
  'complete',
  'bounded',
  'partial',
  'unsupported',
]);

export const VM_LOCATION_KINDS = Object.freeze([
  'stack',
  'local',
  'register',
  'argument',
  'global',
  'field',
  'static-field',
  'array-element',
  'linear-memory',
  'table',
  'runtime',
]);

export const VM_OPERATION_KINDS = Object.freeze([
  'const',
  'copy',
  'unary',
  'binary',
  'compare',
  'select',
  'local-read',
  'local-write',
  'register-read',
  'register-write',
  'stack-push',
  'stack-pop',
  'stack-dup',
  'stack-swap',
  'arg-read',
  'conversion',
  'alloc-object',
  'alloc-array',
  'field-read',
  'field-write',
  'static-field-read',
  'static-field-write',
  'array-read',
  'array-write',
  'memory-read',
  'memory-write',
  'global-read',
  'global-write',
  'table-read',
  'table-write',
  'type-check',
  'type-cast',
  'call',
  'dispatch',
  'indirect-call',
  'return',
  'branch',
  'cond-branch',
  'switch',
  'throw',
  'rethrow',
  'monitor-enter',
  'monitor-exit',
  'trap',
  'barrier',
  'intrinsic',
  'unknown',
]);

export const VM_UNKNOWN_CATEGORIES = Object.freeze([
  'stack',
  'locals',
  'registers',
  'memory',
  'heap',
  'control',
  'exceptions',
  'calls',
  'types',
  'other',
]);

const SETS = Object.freeze({
  completeness: new Set(VM_EFFECT_COMPLETENESS),
  locations: new Set(VM_LOCATION_KINDS),
  operations: new Set(VM_OPERATION_KINDS),
  unknownCategories: new Set(VM_UNKNOWN_CATEGORIES),
});

function fail(code) { throw new TypeError(code); }
function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}
function array(value, code) {
  if (!Array.isArray(value)) fail(code);
  return value;
}
function nonEmpty(value, code) {
  if (typeof value !== 'string') fail(code);
  const text = value.trim();
  if (!text) fail(code);
  return text;
}
function optionalString(value, code) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') fail(code);
  return value;
}
function nonNegativeInteger(value, code) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}
function assertAllowedKeys(input, allowed, code) {
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail(`${code}:${key}`);
}
function validateUnknownEffect(value) {
  const effect = object(value, 'vm-effect-invalid-unknown-effect');
  const categoryDescriptor = Object.getOwnPropertyDescriptor(effect, 'category');
  if (!categoryDescriptor || !Object.prototype.hasOwnProperty.call(categoryDescriptor, 'value')) {
    fail('vm-effect-invalid-unknown-category');
  }
  const category = categoryDescriptor.value;
  if (typeof category !== 'string' || !SETS.unknownCategories.has(category)) {
    fail('vm-effect-invalid-unknown-category');
  }
  return effect;
}
function normalizeUnknownEffect(value) {
  object(value, 'vm-effect-invalid-unknown-effect');
  const normalized = jsonSafe(value);
  validateUnknownEffect(normalized);
  return normalized;
}
function unknownEffectsForValidation(bundle) {
  const descriptor = Object.getOwnPropertyDescriptor(bundle, 'unknownEffects');
  if (!descriptor) {
    if ('unknownEffects' in bundle) fail('vm-effect-invalid-unknown-effects');
    return [];
  }
  if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    fail('vm-effect-invalid-unknown-effects');
  }
  const effects = descriptor.value;
  if (effects == null) return [];
  array(effects, 'vm-effect-invalid-unknown-effects');
  const stable = new Array(effects.length);
  for (let index = 0; index < effects.length; index += 1) {
    const elementDescriptor = Object.getOwnPropertyDescriptor(effects, String(index));
    if (!elementDescriptor || !Object.prototype.hasOwnProperty.call(elementDescriptor, 'value')) {
      fail('vm-effect-invalid-unknown-effect');
    }
    stable[index] = elementDescriptor.value;
  }
  return stable;
}
function assertNotAborted(options) {
  if (options?.signal?.aborted) {
    const error = new Error('vm-effects-cancelled');
    error.name = 'AbortError';
    throw error;
  }
}

function budgetValue(options, key) {
  const raw = options?.budget?.[key] ?? VM_EFFECT_DEFAULT_BUDGET[key];
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) fail(`vm-effect-invalid-budget-${key}`);
  return raw;
}

export function createVMEffectBudgetTracker(options = {}) {
  const limits = Object.freeze({
    maxOperations: budgetValue(options, 'maxOperations'),
    maxValues: budgetValue(options, 'maxValues'),
    maxExceptionRegions: budgetValue(options, 'maxExceptionRegions'),
  });
  let operations = 0;
  let values = 0;
  let exceptionRegions = 0;
  const checkpoint = () => assertNotAborted(options);
  const charge = (field, count, limit, code) => {
    checkpoint();
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) fail('vm-effect-invalid-budget-charge');
    const next = field + count;
    if (next > limit) fail(code);
    return next;
  };
  return Object.freeze({
    limits,
    checkpoint,
    chargeOperation(count = 1) { operations = charge(operations, count, limits.maxOperations, 'vm-effect-resource-limit-operations'); return operations; },
    chargeValues(count = 1) { values = charge(values, count, limits.maxValues, 'vm-effect-resource-limit-values'); return values; },
    chargeExceptionRegions(count = 1) { exceptionRegions = charge(exceptionRegions, count, limits.maxExceptionRegions, 'vm-effect-resource-limit-exception-regions'); return exceptionRegions; },
    snapshot() { return Object.freeze({ operations, values, exceptionRegions, limits }); },
  });
}

export function createVMEffectBundle(input, options = {}) {
  assertNotAborted(options);
  input = object(input, 'vm-effect-bundle-invalid');
  assertAllowedKeys(input, new Set([
    'schemaVersion', 'contractVersion', 'frontendId', 'frontendSemanticVersion',
    'profileId', 'methodId', 'operationId', 'bytecodeOffset', 'opcode', 'mnemonic',
    'consumedValues', 'producedValues', 'locationReads', 'locationWrites',
    'memoryEffects', 'callEffects', 'controlEffects', 'possibleExceptions',
    'origin', 'completeness', 'unknownEffects', 'metadata',
  ]), 'vm-effect-bundle-unexpected-key');

  const frontendId = nonEmpty(input.frontendId, 'vm-effect-frontend-id-required');
  const methodId = nonEmpty(input.methodId, 'vm-effect-method-id-required');
  const operationId = nonEmpty(input.operationId, 'vm-effect-operation-id-required');
  const bytecodeOffset = nonNegativeInteger(input.bytecodeOffset ?? 0, 'vm-effect-offset-required');
  const completeness = nonEmpty(input.completeness ?? 'exact', 'vm-effect-completeness-required');
  if (!SETS.completeness.has(completeness)) fail('vm-effect-invalid-completeness');

  const consumedValues = array(input.consumedValues ?? [], 'vm-effect-invalid-consumed-values');
  const producedValues = array(input.producedValues ?? [], 'vm-effect-invalid-produced-values');
  const locationReads = array(input.locationReads ?? [], 'vm-effect-invalid-location-reads');
  const locationWrites = array(input.locationWrites ?? [], 'vm-effect-invalid-location-writes');
  const memoryEffects = array(input.memoryEffects ?? [], 'vm-effect-invalid-memory-effects');
  const callEffects = array(input.callEffects ?? [], 'vm-effect-invalid-call-effects');
  const controlEffects = array(input.controlEffects ?? [], 'vm-effect-invalid-control-effects');
  const possibleExceptions = array(input.possibleExceptions ?? [], 'vm-effect-invalid-exceptions');
  const unknownEffects = array(input.unknownEffects ?? [], 'vm-effect-invalid-unknown-effects')
    .map((effect) => normalizeUnknownEffect(effect));

  if ((completeness === 'partial' || completeness === 'unknown') && unknownEffects.length === 0) {
    fail('vm-effect-partial-must-specify-unknown-effects');
  }

  const schemaVersion = input.schemaVersion ?? VM_EFFECTS_SCHEMA_VERSION;
  if (typeof schemaVersion !== 'number' || schemaVersion !== VM_EFFECTS_SCHEMA_VERSION) fail('vm-effect-schema-version-mismatch');

  const contractVersion = input.contractVersion ?? VM_EFFECTS_CONTRACT_VERSION;
  if (typeof contractVersion !== 'string' || contractVersion !== VM_EFFECTS_CONTRACT_VERSION) fail('vm-effect-contract-version-mismatch');

  const frontendSemanticVersion = nonEmpty(input.frontendSemanticVersion ?? '1.0.0', 'vm-effect-invalid-frontend-semantic-version');
  const profileId = optionalString(input.profileId, 'vm-effect-invalid-profile-id');
  const mnemonic = optionalString(input.mnemonic, 'vm-effect-invalid-mnemonic');
  const opcode = input.opcode != null ? nonNegativeInteger(input.opcode, 'vm-effect-invalid-opcode') : null;

  const out = {
    schemaVersion,
    contractVersion,
    frontendId,
    frontendSemanticVersion,
    profileId,
    methodId,
    operationId,
    bytecodeOffset,
    opcode,
    mnemonic,
    consumedValues: deepFreeze(consumedValues.map((v) => jsonSafe(v))),
    producedValues: deepFreeze(producedValues.map((v) => jsonSafe(v))),
    locationReads: deepFreeze(locationReads.map((r) => jsonSafe(r))),
    locationWrites: deepFreeze(locationWrites.map((w) => jsonSafe(w))),
    memoryEffects: deepFreeze(memoryEffects.map((m) => jsonSafe(m))),
    callEffects: deepFreeze(callEffects.map((c) => jsonSafe(c))),
    controlEffects: deepFreeze(controlEffects.map((c) => jsonSafe(c))),
    possibleExceptions: deepFreeze(possibleExceptions.map((e) => jsonSafe(e))),
    origin: createOriginSet(input.origin ?? { operationIds: [operationId] }),
    completeness,
    unknownEffects: deepFreeze(unknownEffects),
    metadata: input.metadata ? deepFreeze(jsonSafe(input.metadata)) : Object.freeze({}),
  };

  return deepFreeze(out);
}

export function validateVMEffectBundle(bundle) {
  bundle = object(bundle, 'vm-effect-bundle-invalid');
  nonEmpty(bundle.operationId, 'vm-effect-bundle-missing-identity');
  nonEmpty(bundle.methodId, 'vm-effect-bundle-missing-identity');
  nonEmpty(bundle.frontendId, 'vm-effect-bundle-missing-identity');
  if (!SETS.completeness.has(bundle.completeness)) fail('vm-effect-bundle-invalid-completeness');
  if (typeof bundle.schemaVersion !== 'number' || bundle.schemaVersion !== VM_EFFECTS_SCHEMA_VERSION) {
    fail('vm-effect-schema-version-mismatch');
  }
  if (typeof bundle.contractVersion !== 'string' || bundle.contractVersion !== VM_EFFECTS_CONTRACT_VERSION) {
    fail('vm-effect-contract-version-mismatch');
  }
  nonNegativeInteger(bundle.bytecodeOffset, 'vm-effect-invalid-bytecode-offset');
  if (bundle.opcode != null) nonNegativeInteger(bundle.opcode, 'vm-effect-invalid-opcode');
  nonEmpty(bundle.frontendSemanticVersion, 'vm-effect-invalid-frontend-semantic-version');
  if (bundle.profileId != null && typeof bundle.profileId !== 'string') fail('vm-effect-invalid-profile-id');
  if (bundle.mnemonic != null && typeof bundle.mnemonic !== 'string') fail('vm-effect-invalid-mnemonic');
  array(bundle.consumedValues ?? [], 'vm-effect-invalid-consumed-values');
  array(bundle.producedValues ?? [], 'vm-effect-invalid-produced-values');
  array(bundle.locationReads ?? [], 'vm-effect-invalid-location-reads');
  array(bundle.locationWrites ?? [], 'vm-effect-invalid-location-writes');
  array(bundle.memoryEffects ?? [], 'vm-effect-invalid-memory-effects');
  array(bundle.callEffects ?? [], 'vm-effect-invalid-call-effects');
  array(bundle.controlEffects ?? [], 'vm-effect-invalid-control-effects');
  array(bundle.possibleExceptions ?? [], 'vm-effect-invalid-exceptions');
  const unknownEffects = unknownEffectsForValidation(bundle);
  for (const effect of unknownEffects) validateUnknownEffect(effect);
  if ((bundle.completeness === 'partial' || bundle.completeness === 'unknown') && unknownEffects.length === 0) {
    fail('vm-effect-partial-must-specify-unknown-effects');
  }
  return true;
}

function validateFunctionBundleOwnership(fn, bundle) {
  if (bundle.methodId !== fn.methodId) fail('vm-effect-function-bundle-method-mismatch');
  if (bundle.frontendId !== fn.frontendId) fail('vm-effect-function-bundle-frontend-mismatch');
  if (fn.profileId != null && bundle.profileId != null && bundle.profileId !== fn.profileId) {
    fail('vm-effect-function-bundle-profile-mismatch');
  }
}

export function assertVMEffectFunctionBundleOwnership(fn, bundles = fn?.bundles) {
  if (!Array.isArray(bundles)) return;
  for (const bundle of bundles) validateFunctionBundleOwnership(fn, bundle);
}

export function createVMEffectFunction(input, options = {}) {
  assertNotAborted(options);
  input = object(input, 'vm-effect-function-invalid');
  assertAllowedKeys(input, new Set([
    'methodId', 'profileId', 'frontendId', 'entryState', 'bundles',
    'exceptionRegions', 'validationReportId', 'aggregateCompleteness',
    'resolutionCompleteness', 'origin', 'metadata',
  ]), 'vm-effect-function-unexpected-key');

  const methodId = nonEmpty(input.methodId, 'vm-effect-method-id-required');
  const frontendId = nonEmpty(input.frontendId, 'vm-effect-frontend-id-required');
  const profileId = optionalString(input.profileId, 'vm-effect-invalid-profile-id');
  const bundles = array(input.bundles ?? [], 'vm-effect-function-bundles-required');
  const exceptionRegions = array(input.exceptionRegions ?? [], 'vm-effect-function-exceptions-invalid');
  if (bundles.length > budgetValue(options, 'maxOperations')) fail('vm-effect-resource-limit-operations');
  if (exceptionRegions.length > budgetValue(options, 'maxExceptionRegions')) fail('vm-effect-resource-limit-exception-regions');
  let valueCount = 0;
  for (const bundle of bundles) {
    valueCount += (bundle?.consumedValues?.length || 0) + (bundle?.producedValues?.length || 0);
    if (valueCount > budgetValue(options, 'maxValues')) fail('vm-effect-resource-limit-values');
  }

  const outBundles = bundles.map((b) => createVMEffectBundle(b, options));
  const derivedAggregateCompleteness =
    outBundles.some((b) => b.completeness === 'unknown') ? 'unknown' :
    outBundles.some((b) => b.completeness === 'partial') ? 'partial' :
    outBundles.some((b) => b.completeness === 'exact-with-intrinsic') ? 'exact-with-intrinsic' : 'exact';
  /* #5404: an explicitly supplied aggregate must not out-claim the bundles it
     summarizes — 'exact' over a partial bundle is exactly the laundering this
     field exists to prevent. A stronger declaration is a caller contradiction:
     it fails closed (vm-effect-aggregate-completeness-overclaim) instead of
     being silently demoted. A more conservative declaration (weaker than the
     derivation) is honored. Completeness authority fields are primitive
     strings only: a structured value is rejected, never String()-coerced into
     an enum token. */
  const AGGREGATE_STRENGTH = Object.freeze({ unknown: 0, partial: 1, 'exact-with-intrinsic': 2, exact: 3 });
  let aggregateCompleteness;
  if (input.aggregateCompleteness != null) {
    if (typeof input.aggregateCompleteness !== 'string') fail('vm-effect-aggregate-completeness-invalid');
    const declared = input.aggregateCompleteness;
    if (!VM_EFFECT_COMPLETENESS.includes(declared)) fail('vm-effect-aggregate-completeness-invalid');
    if (AGGREGATE_STRENGTH[declared] > AGGREGATE_STRENGTH[derivedAggregateCompleteness]) {
      fail('vm-effect-aggregate-completeness-overclaim');
    }
    aggregateCompleteness = declared;
  } else {
    aggregateCompleteness = derivedAggregateCompleteness;
  }
  nonEmpty(aggregateCompleteness, 'vm-effect-aggregate-completeness-required');
  /* #5404: resolution completeness is a typed authority field as well — an
     arbitrary free-text value must fail closed instead of being adopted. */
  let resolutionCompleteness;
  if (input.resolutionCompleteness != null) {
    if (typeof input.resolutionCompleteness !== 'string') fail('vm-effect-resolution-completeness-invalid');
    const declared = input.resolutionCompleteness;
    if (!VM_EFFECT_RESOLUTION_COMPLETENESS.includes(declared)) fail('vm-effect-resolution-completeness-invalid');
    resolutionCompleteness = declared;
  } else {
    resolutionCompleteness = 'complete';
  }

  const functionIdentity = { methodId, frontendId, profileId };
  assertVMEffectFunctionBundleOwnership(functionIdentity, outBundles);

  const out = {
    methodId,
    profileId,
    frontendId,
    entryState: input.entryState ? deepFreeze(jsonSafe(input.entryState)) : Object.freeze({}),
    bundles: deepFreeze(outBundles),
    exceptionRegions: deepFreeze(exceptionRegions.map((r) => jsonSafe(r))),
    validationReportId: optionalString(input.validationReportId, 'vm-effect-invalid-validation-report-id'),
    aggregateCompleteness,
    resolutionCompleteness: input.resolutionCompleteness != null ? resolutionCompleteness : 'complete',
    origin: createOriginSet(input.origin ?? { parentEntityIds: [methodId] }),
    metadata: input.metadata ? deepFreeze(jsonSafe(input.metadata)) : Object.freeze({}),
  };

  return deepFreeze(out);
}

export function validateVMEffectFunction(fn) {
  fn = object(fn, 'vm-effect-function-invalid');
  if (fn.methodId != null && typeof fn.methodId !== 'string') fail('vm-effect-function-invalid-structure');
  if (fn.frontendId != null && typeof fn.frontendId !== 'string') fail('vm-effect-function-invalid-structure');
  nonEmpty(fn.methodId, 'vm-effect-function-missing-identity');
  nonEmpty(fn.frontendId, 'vm-effect-function-missing-identity');
  array(fn.bundles, 'vm-effect-function-invalid-structure');
  if (fn.profileId != null && typeof fn.profileId !== 'string') fail('vm-effect-function-invalid-structure');
  if (fn.validationReportId != null && typeof fn.validationReportId !== 'string') fail('vm-effect-function-invalid-structure');
  for (const b of fn.bundles) validateVMEffectBundle(b);
  array(fn.exceptionRegions ?? [], 'vm-effect-function-exceptions-invalid');
  // #5404: the aggregate field is part of the validated contract, not free text.
  if (!VM_EFFECT_COMPLETENESS.includes(fn.aggregateCompleteness)) fail('vm-effect-aggregate-completeness-invalid');
  if (!VM_EFFECT_RESOLUTION_COMPLETENESS.includes(fn.resolutionCompleteness)) fail('vm-effect-resolution-completeness-invalid');
  // The published aggregate must never out-claim the bundles it summarizes:
  // re-derive the conservative aggregate from the actual bundles and reject
  // hand-made / tampered objects that claim stronger authority (#5404).
  const derived =
    fn.bundles.some((b) => b.completeness === 'unknown') ? 'unknown' :
    fn.bundles.some((b) => b.completeness === 'partial') ? 'partial' :
    fn.bundles.some((b) => b.completeness === 'exact-with-intrinsic') ? 'exact-with-intrinsic' : 'exact';
  const AGGREGATE_STRENGTH = Object.freeze({ unknown: 0, partial: 1, 'exact-with-intrinsic': 2, exact: 3 });
  if (AGGREGATE_STRENGTH[fn.aggregateCompleteness] > AGGREGATE_STRENGTH[derived]) {
    fail('vm-effect-aggregate-completeness-contradiction');
  }
  assertVMEffectFunctionBundleOwnership(fn);
  return true;
}
