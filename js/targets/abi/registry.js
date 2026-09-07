import { stableDigest } from '../../core/identity/index.js';

const ABI_PLUGINS = new Map();
const ABI_REGISTRY_BINDINGS = new WeakMap();
const ABI_CLASSIFIER_SOURCES = new WeakMap();
let ABI_REGISTRY_GENERATION = 0;
const APPLE_ARM64E_PLATFORMS = new Set([
  'apple', 'darwin', 'macos', 'macosx', 'ios', 'ios-simulator', 'ipados',
  'tvos', 'watchos', 'visionos',
]);

const STRICT_PROTOTYPE_METADATA_ABIS = new Set([
  'sysv-amd64', 'microsoft-x64', 'microsoft-vectorcall', 'darwin-arm64',
  'lp64', 'lp64f', 'lp64d',
]);
const ABI_STRING_METADATA_FIELDS = new Set([
  'type', 'name', 'kind', 'abiClass', 'class',
  'callingConvention', 'convention', 'cc',
  'returnType', 'resultType', 'ret', 'result',
  'returnClass', 'resultClass',
]);
const ABI_INTEGER_METADATA_FIELDS = new Set([
  'bits', 'sizeBits', 'returnBits', 'elementBits', 'memberBits',
  'alignmentBytes', 'alignBytes', 'alignment',
  'lmul', 'LMUL', 'tupleCount', 'nf',
  'byteOffset', 'offsetBytes', 'offset',
  'bytes', 'sizeBytes', 'length', 'count', 'memberCount',
  'fixedParameterCount',
]);
const ABI_BOOLEAN_METADATA_FIELDS = new Set([
  'pointer', 'isPointer', 'aggregate', 'isAggregate', 'vector', 'isVector',
  'floating', 'complexX87', 'x87', 'nonTrivialForCalls', 'nonTrivial',
  'trivialForCalls', 'pod', 'hfa', 'hva', 'mask', 'vectorMask',
  'fixedLengthVector', 'signed', 'returnsValue', 'void', 'indirectResult',
  'variadic', 'varargs', 'named', 'unnamed', 'mayContainPointers',
  'containsPointers', 'returnTrivialForCalls', 'returnNonTrivialForCalls',
]);
const ABI_STRING_ARRAY_METADATA_FIELDS = new Set([
  'eightbyteClasses', 'abiClasses', 'returnEightbyteClasses',
]);
const ABI_RECORD_ARRAY_METADATA_FIELDS = new Set([
  'args', 'parameters', 'params', 'arguments', 'members', 'elements', 'fields',
]);
const ABI_RECORD_METADATA_FIELDS = new Set([
  'layout', 'returnAggregate', 'functionPrototype', 'prototype',
]);
const ABI_AUTHORITY_OPTION_FIELDS = new Set([
  ...ABI_STRING_METADATA_FIELDS,
  ...ABI_INTEGER_METADATA_FIELDS,
  ...ABI_BOOLEAN_METADATA_FIELDS,
  ...ABI_STRING_ARRAY_METADATA_FIELDS,
  ...ABI_RECORD_ARRAY_METADATA_FIELDS,
  ...ABI_RECORD_METADATA_FIELDS,
]);

function canonicalId(value) { return String(value || '').trim().toLowerCase(); }
function requiredCanonicalId(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a primitive string`);
  const id = value.trim().toLowerCase();
  if (!id) throw new TypeError(`${label} is required`);
  return id;
}
function optionalIdentity(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new TypeError(`${label} must be a primitive string`);
  if (!value.trim()) throw new TypeError(`${label} is required`);
  return value;
}
function frozenArray(value) { return Object.freeze(Array.isArray(value) ? value.slice() : []); }
function normalizeABIHook(value, name, fallback = null) {
  if (value == null) return fallback;
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  if (isClassConstructorSource(value) || isBoundClassConstructor(value)) {
    throw new TypeError(`${name} must be an invocable callback, not a class constructor`);
  }
  return value;
}

function isClassConstructorSource(value) {
  try { return /^class[\s{;]/.test(Function.prototype.toString.call(value)); }
  catch { return false; }
}

function isBoundClassConstructor(value) {
  if (typeof value.name !== 'string' || !value.name.startsWith('bound ')) return false;
  try {
    Reflect.apply(value, undefined, []);
    return false;
  } catch (error) {
    return error instanceof TypeError && /cannot be invoked without ['"]new['"]/.test(error.message);
  }
}

function canonicalCallingConvention(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') return null;
  return value.trim().toLowerCase().replace(/^__/, '');
}

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownDataValue(record, key) {
  let owner = record;
  try {
    while (owner && owner !== Object.prototype) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor) {
        return 'value' in descriptor
          ? { present:true, value:descriptor.value }
          : { present:true, accessor:true, value:undefined };
      }
      owner = Object.getPrototypeOf(owner);
    }
  } catch {
    return { present:true, accessor:true, value:undefined };
  }
  return { present:false, value:undefined };
}

function safeEnumerableDataCopy(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return {};
  const copy = {};
  try {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) continue;
      Object.defineProperty(copy, key, {
        configurable:true,
        enumerable:true,
        writable:true,
        value:descriptor.value,
      });
    }
  } catch {
    return {};
  }
  return copy;
}

/*
 * Prototype metadata is caller-owned authority.  Validation must not inspect
 * one view of an array and then let a classifier inspect another view of that
 * same array.  Capture only own data properties into an owned graph before
 * validation/classification; accessors, unsupported objects, proxies whose
 * reflection fails, and cycles are all malformed authority.
 */
function snapshotMetadataValue(value, seen = new WeakSet()) {
  if (value == null || (typeof value !== 'object' && typeof value !== 'function')) {
    return { valid:true, value };
  }
  if (typeof value === 'function' || seen.has(value)) return { valid:false, value:null };
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      if (!lengthDescriptor || !('value' in lengthDescriptor)
        || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
        return { valid:false, value:null };
      }
      const snapshot = [];
      for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) return { valid:false, value:null };
        const nested = snapshotMetadataValue(descriptor.value, seen);
        if (!nested.valid) return { valid:false, value:null };
        Object.defineProperty(snapshot, key, {
          configurable:true,
          enumerable:descriptor.enumerable,
          writable:true,
          value:nested.value,
        });
      }
      Object.defineProperty(snapshot, 'length', {
        configurable:false,
        enumerable:false,
        writable:true,
        value:lengthDescriptor.value,
      });
      return { valid:true, value:snapshot };
    }
    if (!plainRecord(value)) return { valid:false, value:null };
    const prototype = Object.getPrototypeOf(value);
    const snapshot = Object.create(prototype === null ? null : Object.prototype);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) return { valid:false, value:null };
      const nested = snapshotMetadataValue(descriptor.value, seen);
      if (!nested.valid) return { valid:false, value:null };
      Object.defineProperty(snapshot, key, {
        configurable:true,
        enumerable:descriptor.enumerable,
        writable:true,
        value:nested.value,
      });
    }
    return { valid:true, value:snapshot };
  } catch {
    return { valid:false, value:null };
  } finally {
    seen.delete(value);
  }
}

function snapshotPrototypeValue(value) {
  const snapshot = snapshotMetadataValue(value);
  return snapshot.valid && strictPrototype(snapshot.value)
    ? snapshot
    : { valid:false, value:null };
}

function snapshotAuthorityOptions(options) {
  if (options == null) return { valid:true, value:options };
  if (typeof options !== 'object' && typeof options !== 'function') {
    return { valid:false, value:null };
  }
  const snapshot = safeEnumerableDataCopy(options);
  try {
    const providerEntry = ownDataValue(options, 'callPrototypeFor');
    if (providerEntry.accessor) return { valid:false, value:null };
    if (providerEntry.present) {
      Object.defineProperty(snapshot, 'callPrototypeFor', {
        configurable:true,
        enumerable:true,
        writable:true,
        value:providerEntry.value,
      });
    }
    for (const key of ABI_AUTHORITY_OPTION_FIELDS) {
      const entry = ownDataValue(options, key);
      if (!entry.present || entry.accessor) {
        if (entry.accessor) return { valid:false, value:null };
        continue;
      }
      const nested = snapshotMetadataValue(entry.value);
      if (!nested.valid) return { valid:false, value:null };
      Object.defineProperty(snapshot, key, {
        configurable:true,
        enumerable:true,
        writable:true,
        value:nested.value,
      });
    }
    return { valid:true, value:snapshot };
  } catch {
    return { valid:false, value:null };
  }
}

function strictInteger(value) {
  return typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(value);
}

function strictPrototypeRecord(record, seen = new WeakSet()) {
  if (!plainRecord(record) || seen.has(record)) return false;
  seen.add(record);
  try {
    for (const key of ABI_STRING_METADATA_FIELDS) {
      const entry = ownDataValue(record, key);
      if (!entry.present) continue;
      if (entry.accessor || (entry.value != null && typeof entry.value !== 'string')) return false;
    }
    for (const key of ABI_INTEGER_METADATA_FIELDS) {
      const entry = ownDataValue(record, key);
      if (!entry.present) continue;
      if (entry.accessor || (entry.value != null && !strictInteger(entry.value))) return false;
    }
    for (const key of ABI_BOOLEAN_METADATA_FIELDS) {
      const entry = ownDataValue(record, key);
      if (!entry.present) continue;
      if (entry.accessor || (entry.value != null && typeof entry.value !== 'boolean')) return false;
    }
    for (const key of ABI_STRING_ARRAY_METADATA_FIELDS) {
      const entry = ownDataValue(record, key);
      if (!entry.present) continue;
      if (entry.accessor || (entry.value != null
        && (!Array.isArray(entry.value) || entry.value.some((value) => typeof value !== 'string')))) return false;
    }
    for (const key of ABI_RECORD_ARRAY_METADATA_FIELDS) {
      const entry = ownDataValue(record, key);
      if (!entry.present || entry.value == null) continue;
      if (entry.accessor) return false;
      if ((key === 'members' || key === 'elements') && strictInteger(entry.value)) continue;
      if (!Array.isArray(entry.value)) return false;
      for (const value of entry.value) {
        if (typeof value === 'string') continue;
        if (!strictPrototypeRecord(value, seen)) return false;
      }
    }
    for (const key of ABI_RECORD_METADATA_FIELDS) {
      const entry = ownDataValue(record, key);
      if (!entry.present || entry.value == null) continue;
      if (entry.accessor) return false;
      if (key === 'returnAggregate' && typeof entry.value === 'boolean') continue;
      if (!strictPrototypeRecord(entry.value, seen)) return false;
    }
    return true;
  } finally {
    seen.delete(record);
  }
}

function strictPrototype(value) {
  return value == null || strictPrototypeRecord(value);
}

function strictCallingConventionMetadata(value) {
  if (value == null || (typeof value !== 'object' && typeof value !== 'function')) return true;
  for (const key of ['callingConvention', 'convention', 'cc']) {
    const entry = ownDataValue(value, key);
    if (!entry.present) continue;
    if (entry.accessor || (entry.value != null && typeof entry.value !== 'string')) return false;
  }
  return true;
}

function strictOptionsMetadata(options) {
  if (options == null) return true;
  if (typeof options !== 'object' && typeof options !== 'function') return false;
  for (const key of ABI_AUTHORITY_OPTION_FIELDS) {
    const entry = ownDataValue(options, key);
    if (!entry.present) continue;
    if (entry.accessor) return false;
    const value = entry.value;
    if (value == null) continue;
    if (ABI_STRING_METADATA_FIELDS.has(key) && typeof value !== 'string') return false;
    if (ABI_INTEGER_METADATA_FIELDS.has(key) && !strictInteger(value)) return false;
    if (ABI_BOOLEAN_METADATA_FIELDS.has(key) && typeof value !== 'boolean') return false;
    if (ABI_STRING_ARRAY_METADATA_FIELDS.has(key)
      && (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))) return false;
    if (ABI_RECORD_ARRAY_METADATA_FIELDS.has(key)) {
      if ((key === 'members' || key === 'elements') && strictInteger(value)) continue;
      if (!Array.isArray(value)) return false;
      if (value.some((item) => typeof item !== 'string' && !strictPrototypeRecord(item))) return false;
    }
    if (ABI_RECORD_METADATA_FIELDS.has(key)) {
      if (key === 'returnAggregate' && typeof value === 'boolean') continue;
      if (!strictPrototype(value)) return false;
    }
  }
  return true;
}

function sanitizedClassifierOptions(options = {}) {
  const sanitized = safeEnumerableDataCopy(options);
  for (const key of ABI_AUTHORITY_OPTION_FIELDS) delete sanitized[key];
  sanitized.callPrototypeFor = () => null;
  return sanitized;
}

function withoutCallPrototype(instruction) {
  if (!instruction || typeof instruction !== 'object') return instruction;
  const sanitized = safeEnumerableDataCopy(instruction);
  sanitized.callPrototype = null;
  return sanitized;
}

function guardedProviderOptions(options = {}, state, providerThis = options) {
  if (!options || typeof options !== 'object') return options;
  const providerEntry = ownDataValue(options, 'callPrototypeFor');
  if (providerEntry.accessor) {
    state.invalid = true;
    return sanitizedClassifierOptions(options);
  }
  const guarded = safeEnumerableDataCopy(options);
  if (!providerEntry.present) {
    guarded.callPrototypeFor = null;
    return guarded;
  }
  const provider = providerEntry.value;
  if (typeof provider !== 'function') {
    guarded.callPrototypeFor = provider;
    return guarded;
  }
  guarded.callPrototypeFor = function guardedCallPrototypeFor(...args) {
    let prototype;
    try {
      prototype = provider.apply(providerThis, args);
    } catch {
      // A provider is caller-controlled authority.  A throw is malformed
      // metadata, not permission to let the target classifier fall back to
      // its own coercive/default path.
      state.invalid = true;
      return null;
    }
    const snapshot = snapshotPrototypeValue(prototype);
    if (!snapshot.valid) {
      state.invalid = true;
      return null;
    }
    return snapshot.value;
  };
  return guarded;
}

function invalidReturnClassification() {
  return {
    reg:null,
    partial:true,
    exact:false,
    certainty:'unknown',
    reason:'abi-prototype-metadata-invalid',
  };
}

function guardArgumentClassifier(classifier) {
  if (typeof classifier !== 'function') return classifier;
  return function guardedABIArguments(instruction, options = {}) {
    const explicitPrototype = instruction && typeof instruction === 'object'
      ? ownDataValue(instruction, 'callPrototype')
      : { present:false, value:undefined };
    const prototypeSnapshot = explicitPrototype.present && !explicitPrototype.accessor
      ? snapshotPrototypeValue(explicitPrototype.value)
      : { valid:false, value:null };
    const optionsSnapshot = snapshotAuthorityOptions(options);
    if ((explicitPrototype.present && (explicitPrototype.accessor || !prototypeSnapshot.valid))
      || !strictCallingConventionMetadata(instruction)
      || !optionsSnapshot.valid
      || !strictOptionsMetadata(optionsSnapshot.value)) {
      return classifier.call(this, withoutCallPrototype(instruction), sanitizedClassifierOptions(options));
    }
    const instructionSnapshot = instruction && typeof instruction === 'object'
      ? safeEnumerableDataCopy(instruction)
      : instruction;
    if (explicitPrototype.present) instructionSnapshot.callPrototype = prototypeSnapshot.value;
    const state = { invalid:false };
    const result = classifier.call(this, instructionSnapshot,
      guardedProviderOptions(optionsSnapshot.value, state, options));
    if (!state.invalid) return result;
    return classifier.call(this, withoutCallPrototype(instructionSnapshot), sanitizedClassifierOptions(options));
  };
}

function guardCallReturnClassifier(classifier) {
  if (typeof classifier !== 'function') return classifier;
  return function guardedABICallReturn(instruction, options = {}) {
    const explicitPrototype = instruction && typeof instruction === 'object'
      ? ownDataValue(instruction, 'callPrototype')
      : { present:false, value:undefined };
    const prototypeSnapshot = explicitPrototype.present && !explicitPrototype.accessor
      ? snapshotPrototypeValue(explicitPrototype.value)
      : { valid:false, value:null };
    const optionsSnapshot = snapshotAuthorityOptions(options);
    if ((explicitPrototype.present && (explicitPrototype.accessor || !prototypeSnapshot.valid))
      || !strictCallingConventionMetadata(instruction)
      || !optionsSnapshot.valid
      || !strictOptionsMetadata(optionsSnapshot.value)) return invalidReturnClassification();
    const instructionSnapshot = instruction && typeof instruction === 'object'
      ? safeEnumerableDataCopy(instruction)
      : instruction;
    if (explicitPrototype.present) instructionSnapshot.callPrototype = prototypeSnapshot.value;
    const state = { invalid:false };
    const result = classifier.call(this, instructionSnapshot,
      guardedProviderOptions(optionsSnapshot.value, state, options));
    return state.invalid ? invalidReturnClassification() : result;
  };
}

function guardFunctionReturnClassifier(classifier) {
  if (typeof classifier !== 'function') return classifier;
  return function guardedABIFunctionReturn(options = {}) {
    const optionsSnapshot = snapshotAuthorityOptions(options);
    if (!optionsSnapshot.valid || !strictOptionsMetadata(optionsSnapshot.value)) return invalidReturnClassification();
    return classifier.call(this, optionsSnapshot.value);
  };
}

function claimedCallingConventions(plugin) {
  try {
    return frozenArray(plugin?.callingConventions?.())
      .map(canonicalCallingConvention)
      .filter(Boolean);
  } catch {
    return Object.freeze([]);
  }
}

export class ABIPlugin {
  constructor(definition = {}) {
    const id = requiredCanonicalId(definition.id, 'ABI id');
    const architectureId = requiredCanonicalId(definition.architectureId, `ABI ${id} architectureId`);

    this.id = id;
    this.semanticVersion = optionalIdentity(definition.semanticVersion, '1', `ABI ${id} semanticVersion`);
    this.semanticIdentity = optionalIdentity(
      definition.semanticIdentity,
      `${id}@${this.semanticVersion}`,
      `ABI ${id} semanticIdentity`,
    );
    this.architectureId = architectureId;
    this.platformPredicate = normalizeABIHook(definition.platformPredicate, 'platformPredicate', () => true);
    this.callingConventions = normalizeABIHook(definition.callingConventions, 'callingConventions', () => frozenArray([]));
    const classifyArguments = normalizeABIHook(definition.classifyArguments, 'classifyArguments', () => ({
      srcs: [], arguments: [], stackArguments: [], stackArgsUnknown: true,
      stackArgsMayContainPointers: true, evidence: 'unsupported-abi', unsupported: true,
    }));
    const classifyCallReturn = normalizeABIHook(definition.classifyCallReturn, 'classifyCallReturn', () => null);
    const classifyFunctionReturn = normalizeABIHook(definition.classifyFunctionReturn, 'classifyFunctionReturn', () => null);
    ABI_CLASSIFIER_SOURCES.set(this, {
      classifyArguments:String(classifyArguments ?? ''),
      classifyCallReturn:String(classifyCallReturn ?? ''),
      classifyFunctionReturn:String(classifyFunctionReturn ?? ''),
    });
    const strictPrototypeMetadata = STRICT_PROTOTYPE_METADATA_ABIS.has(id);
    this.classifyArguments = strictPrototypeMetadata
      ? guardArgumentClassifier(classifyArguments)
      : classifyArguments;
    this.classifyCallReturn = strictPrototypeMetadata
      ? guardCallReturnClassifier(classifyCallReturn)
      : classifyCallReturn;
    this.classifyFunctionReturn = strictPrototypeMetadata
      ? guardFunctionReturnClassifier(classifyFunctionReturn)
      : classifyFunctionReturn;
    this.classifyEntryRegister = normalizeABIHook(definition.classifyEntryRegister, 'classifyEntryRegister', () => ({ kind:'incoming-register-state' }));
    this.callerSaved = normalizeABIHook(definition.callerSaved, 'callerSaved', () => frozenArray([]));
    this.calleeSaved = normalizeABIHook(definition.calleeSaved, 'calleeSaved', () => frozenArray([]));
    this.stackRules = normalizeABIHook(definition.stackRules, 'stackRules', () => Object.freeze({ unknown:true }));
    this.redZone = normalizeABIHook(definition.redZone, 'redZone', () => null);
    this.syscallABI = definition.syscallABI || null;
    this.unwindRules = normalizeABIHook(definition.unwindRules, 'unwindRules', () => Object.freeze({ unknown:true }));
    this.defaultUnknownCallEffects = normalizeABIHook(definition.defaultUnknownCallEffects, 'defaultUnknownCallEffects', () => Object.freeze({
      registerEffects:'unknown', memoryEffects:'unknown', mayThrow:true,
    }));
    this.supported = definition.supported !== false;
    Object.freeze(this);
  }
}

function classifierDescriptor(plugin) {
  // Function values are intentionally represented by their source text: the
  // identity digest must cover replacement-sensitive classifier behavior, not
  // just the public id/version fields. A monotonic binding generation still
  // distinguishes two frozen objects whose closures happen to stringify the
  // same way.
  const sources = ABI_CLASSIFIER_SOURCES.get(plugin);
  return {
    platformPredicate:String(plugin?.platformPredicate ?? ''),
    callingConventions:String(plugin?.callingConventions ?? ''),
    classifyArguments:sources?.classifyArguments ?? String(plugin?.classifyArguments ?? ''),
    classifyCallReturn:sources?.classifyCallReturn ?? String(plugin?.classifyCallReturn ?? ''),
    classifyFunctionReturn:sources?.classifyFunctionReturn ?? String(plugin?.classifyFunctionReturn ?? ''),
    classifyEntryRegister:String(plugin?.classifyEntryRegister ?? ''),
    callerSaved:String(plugin?.callerSaved ?? ''),
    calleeSaved:String(plugin?.calleeSaved ?? ''),
    stackRules:String(plugin?.stackRules ?? ''),
    redZone:String(plugin?.redZone ?? ''),
    unwindRules:String(plugin?.unwindRules ?? ''),
    defaultUnknownCallEffects:String(plugin?.defaultUnknownCallEffects ?? ''),
  };
}

function registryDescriptor(plugin, { generation = null, classifierDigest = null } = {}) {
  return {
    id:plugin?.id ?? null,
    semanticVersion:plugin?.semanticVersion ?? null,
    semanticIdentity:plugin?.semanticIdentity ?? null,
    architectureId:plugin?.architectureId ?? null,
    supported:plugin?.supported !== false,
    callingConventions:claimedCallingConventions(plugin),
    ...(generation == null ? {} : { generation }),
    ...(classifierDigest == null ? {} : { classifierDigest }),
  };
}

function expectedRegistryDigest(plugin, binding) {
  return `abi-registry:${stableDigest(registryDescriptor(plugin, {
    generation:binding.generation,
    classifierDigest:binding.classifierDigest,
  }))}`;
}

export function abiPluginRegistryDigest(plugin) {
  const binding = plugin && typeof plugin === 'object' ? ABI_REGISTRY_BINDINGS.get(plugin) : null;
  return binding?.digest ?? null;
}

export function abiPluginRegistryGeneration(plugin) {
  const binding = plugin && typeof plugin === 'object' ? ABI_REGISTRY_BINDINGS.get(plugin) : null;
  return binding?.generation ?? null;
}

/*
 * Registry membership is object identity, not a matching set of public fields.
 * A plugin-like object can copy an id/version/classifier and still be a
 * different implementation, so only the exact frozen object registered here
 * may cross the canonical ABI boundary.
 */
export function isRegisteredABIPlugin(plugin) {
  if (!plugin || typeof plugin !== 'object') return false;
  const binding = ABI_REGISTRY_BINDINGS.get(plugin);
  return !!binding && ABI_PLUGINS.get(binding.id) === plugin
    && binding.digest === expectedRegistryDigest(plugin, binding);
}

export function registerABIPlugin(definition, { replace = false } = {}) {
  const plugin = definition instanceof ABIPlugin ? definition : new ABIPlugin(definition);
  // A duplicate object may not silently steal publication.  An explicit
  // replacement is allowed for registry lifecycle tooling, but it makes the
  // previous object non-canonical immediately: isRegisteredABIPlugin() checks
  // the map's exact object identity as well as each object's digest.
  if (ABI_PLUGINS.has(plugin.id) && !replace) {
    throw new Error(`ABI already registered: ${plugin.id}`);
  }
  ABI_PLUGINS.set(plugin.id, plugin);
  const generation = ++ABI_REGISTRY_GENERATION;
  const classifierDigest = stableDigest(classifierDescriptor(plugin));
  const binding = {
    id:plugin.id,
    generation,
    classifierDigest,
    digest:null,
  };
  binding.digest = expectedRegistryDigest(plugin, binding);
  ABI_REGISTRY_BINDINGS.set(plugin, binding);
  return plugin;
}

export function abiPlugin(id) {
  return ABI_PLUGINS.get(canonicalId(id)) || ABI_PLUGINS.get('unknown') || null;
}

export function abiPlugins() { return Object.freeze(Array.from(ABI_PLUGINS.values())); }

export function abiPluginClaimsCallingConvention(plugin, callingConvention = null) {
  const requested = canonicalCallingConvention(callingConvention);
  if (requested === null) return false;
  if (!requested) return true;
  const claims = claimedCallingConventions(plugin);
  return claims.some((claim) => claim === requested);
}

export function findABIPlugin({ id = null, architecture = null, platform = null, callingConvention = null } = {}) {
  if (id) {
    const explicit = abiPlugin(id);
    if (!explicit || explicit.id === 'unknown') return explicit;
    if (!abiPluginClaimsCallingConvention(explicit, callingConvention)) return abiPlugin('unknown');
    // An explicit id selects the profile, not a waiver of target identity:
    // the plugin must still match the target architecture (with the
    // established arm64e->arm64 exception) and any given platform.
    const arch = canonicalId(architecture);
    if (arch && explicit.architectureId !== arch && !(arch === 'arm64e' && explicit.architectureId === 'arm64')) {
      return abiPlugin('unknown');
    }
    const platformId = canonicalId(platform);
    if (platformId) {
      let matches = false;
      try {
        matches = explicit.platformPredicate({ architecture: arch || explicit.architectureId, platform: platformId });
      } catch { matches = false; }
      if (!matches) return abiPlugin('unknown');
    }
    return explicit;
  }
  const arch = canonicalId(architecture);
  const platformId = canonicalId(platform);
  // arm64e is not enough to choose an ABI.  In particular, silently treating
  // an architecture-only arm64e target as AAPCS64 would invent register and
  // aggregate placement facts for non-Apple binaries.
  if (arch === 'arm64e' && !APPLE_ARM64E_PLATFORMS.has(platformId)) return abiPlugin('unknown');
  // An architecture name is not an ABI identity. Require either an explicit
  // registered calling convention or a platform-qualified architecture before
  // selecting a profile; otherwise arm64/x86_64/riscv64 would silently pick a
  // registry default.
  if (!arch || (!platformId && !callingConvention)) return abiPlugin('unknown');
  for (const plugin of ABI_PLUGINS.values()) {
    if (!plugin.supported || plugin.id === 'unknown') continue;
    if (arch && plugin.architectureId !== arch && !(arch === 'arm64e' && plugin.architectureId === 'arm64')) continue;
    let matches = false;
    try { matches = plugin.platformPredicate({ architecture:arch, platform:platformId }); } catch { matches = false; }
    if (!matches) continue;
    if (!abiPluginClaimsCallingConvention(plugin, callingConvention)) continue;
    return plugin;
  }
  return abiPlugin('unknown');
}
