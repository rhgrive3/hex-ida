/**
 * Canonical identity for Phase 8 analysis products.
 *
 * A scalar artifact is only useful for the exact Semantic IR/SSA snapshot that
 * produced it.  This module owns the small identity boundary shared by SCCP,
 * GVN and induction; consumers do not invent a second stale-result check.
 */

import { stableDigest } from '../../core/identity/index.js';
import * as originIdentity from '../../core/identity/origin.js';
import { isCanonicalMemorySsaProducerArtifact } from '../../semantics/memoryssa/build.js';
import { SEMANTIC_IR_DEFAULT_BUDGET } from '../../semantics/ir/common.js';

// #3255 is the Phase 8 consumer lane and must remain independently loadable on
// current main.  #3382 publishes this producer-owned fast path afterwards; the
// generic strict graph digest remains the conservative behavior until then.
const canonicalOriginSetDigest = typeof originIdentity.canonicalOriginSetDigest === 'function'
  ? originIdentity.canonicalOriginSetDigest
  : () => null;

const REQUIRED_FIELDS = Object.freeze([
  'binaryId', 'functionId', 'snapshotId', 'semanticIrId', 'ssaId', 'analyzerVersion',
]);

function createIdentityWorkBudget(limit = SEMANTIC_IR_DEFAULT_BUDGET.maxReferences) {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError('identity-invalid-work-budget');
  }
  let used = 0;
  const consume = (amount) => {
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > limit - used) {
      throw new TypeError('identity-work-budget-exceeded');
    }
    used += amount;
  };
  const consumeText = (text) => {
    if (typeof text !== 'string') throw new TypeError('identity-invalid-text-work');
    consume(text.length);
  };
  const bigintText = (value) => {
    if (typeof value !== 'bigint') throw new TypeError('identity-invalid-bigint-work');
    const remaining = limit - used;
    // Decimal conversion itself is linear in magnitude. Bound the signed bit
    // width first so a hostile million-digit BigInt is rejected before an
    // unbounded decimal string is allocated. A value that passes this check can
    // produce at most approximately `remaining + 1` decimal characters.
    const maxBits = Math.max(1, Math.ceil(remaining * 3.3219280948873626) + 2);
    if (BigInt.asIntN(maxBits, value) !== value) {
      throw new TypeError('identity-work-budget-exceeded');
    }
    const text = String(value);
    consumeText(text);
    return text;
  };
  return Object.freeze({ consume, consumeText, bigintText, remaining:() => limit - used });
}

function token(value, digests = null) {
  if (typeof value === 'string') {
    digests?.graphDigester?.consumeText?.(value);
    if (!value.trim()) throw new TypeError('identity-invalid-token');
    return `string:${value.length}:${value}`;
  }
  if (typeof value === 'bigint') {
    const text = digests?.graphDigester?.bigintText?.(value) ?? String(value);
    return `bigint:${text.length}:${text}`;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('identity-invalid-token');
    const text = Object.is(value, -0) ? '-0' : String(value);
    return `number:${text.length}:${text}`;
  }
  if (value == null) return null;
  if (typeof value !== 'object') throw new TypeError('identity-invalid-token');
  try {
    // IDs are occasionally represented by structured scalar handles. Use the
    // same collision-free typed encoding as the semantic graph; the generic
    // JSON digest would collapse null, NaN and Infinity into one spelling.
    const digester = digests?.graphDigester ?? createFastJsonGraphDigester();
    const projection = digester.project(value, NO_SKIPPED_KEYS);
    if (projection.values == null || projection.includedCount === 0) {
      throw new TypeError('identity-invalid-token');
    }
    const digest = digester(projection.digest);
    return `object:${digest.length}:${digest}`;
  } catch {
    throw new TypeError('identity-invalid-token');
  }
}

function requiredToken(value, digests = null) {
  const resolved = token(value, digests);
  if (resolved == null) throw new TypeError('identity-required-token');
  return resolved;
}

function requiredReferenceToken(value, digests, ...keys) {
  const resolved = optionalReferenceToken(value, digests, ...keys);
  if (resolved == null) throw new TypeError('identity-required-reference-token');
  return resolved;
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const NON_SEMANTIC_KEYS = new Set(['dst', 'uses']);
const NO_SKIPPED_KEYS = new Set();
export const ANALYSIS_IDENTITY_VERSION = 'phase8-analysis-v1';
// This seed frames every persistent semantic digest. Any transcript change
// must advance it so evidence issued by the previous algorithm fails stale;
// the public analyzer contract above remains independent.
export const ANALYSIS_IDENTITY_DIGEST_VERSION = 'phase8-analysis-merkle-v6';

/* Semantic identity only accepts enumerable, own, data properties.  Reading a
 * getter while issuing an artifact ID would make identity depend on timing or
 * hidden state, while ignoring symbols/non-enumerables would let an in-place
 * semantic mutation reuse a stale product.  Arrays have one intrinsic
 * non-enumerable `length` descriptor; all other descriptors are required to be
 * explicit enumerable data. */
function semanticOwnKeys(value) {
  const keys = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') throw new TypeError('identity-symbol-semantic-metadata');
    if (Array.isArray(value) && key === 'length') continue;
    keys.push(key);
  }
  return keys;
}

function semanticDataValue(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor == null || !('value' in descriptor) || !descriptor.enumerable) {
    throw new TypeError('identity-unsupported-semantic-descriptor');
  }
  return descriptor.value;
}

const REFERENCE_TOKEN_KEYS = Object.freeze(['id', 'instructionId', 'definitionId']);

function referenceFieldSnapshot(value, digests) {
  const digester = digests?.graphDigester ?? createFastJsonGraphDigester();
  return digester.fields(value, REFERENCE_TOKEN_KEYS);
}

function optionalReferenceToken(value, digests, ...keys) {
  if (value == null) return null;
  if (typeof value !== 'object') return requiredToken(value, digests);
  const fields = referenceFieldSnapshot(value, digests);
  for (const key of keys) {
    if (!Object.hasOwn(fields, key) || fields[key] == null) continue;
    return requiredToken(fields[key], digests);
  }
  throw new TypeError('identity-required-reference-token');
}

function referenceOrSelfToken(value, digests, ...keys) {
  if (value == null || typeof value !== 'object') return token(value, digests);
  const fields = referenceFieldSnapshot(value, digests);
  for (const key of keys) {
    if (!Object.hasOwn(fields, key)) continue;
    return requiredToken(fields[key], digests);
  }
  return requiredToken(value, digests);
}

function arrayIndexKey(key) {
  if (!/^(?:0|[1-9]\d*)$/.test(key)) return false;
  const number = Number(key);
  return Number.isSafeInteger(number) && number >= 0 && number < 0xffffffff && String(number) === key;
}

function semanticArrayLength(value) {
  const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (descriptor == null || !('value' in descriptor) || descriptor.enumerable
      || descriptor.configurable || !Number.isSafeInteger(descriptor.value)
      || descriptor.value < 0 || descriptor.value > 0xffffffff) {
    throw new TypeError('identity-unsupported-semantic-array');
  }
  return descriptor.value;
}

function mappedSemanticList(value, mapper) {
  if (!Array.isArray(value)) throw new TypeError('identity-unsupported-semantic-array');
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError('identity-unsupported-semantic-array');
  }
  const length = semanticArrayLength(value);
  const captured = new Array(length);
  const keys = semanticOwnKeys(value);
  if (keys.length !== length) throw new TypeError('identity-unsupported-semantic-array');
  for (const key of keys) {
    if (!arrayIndexKey(key) || Number(key) >= length) {
      throw new TypeError('identity-unsupported-semantic-array');
    }
    captured[Number(key)] = semanticDataValue(value, key);
  }
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(captured, index)) throw new TypeError('identity-unsupported-semantic-array');
  }
  return captured.map(mapper);
}

function mappedSemanticPropertyList(values, key, mapper) {
  if (!Object.hasOwn(values, key)) return null;
  return mappedSemanticList(values[key], mapper);
}

// The legacy projection keeps several indexes and compatibility views beside
// the canonical block/value graph.  They either contain back references to
// that graph (`instructions`, `args`, `byRow`, `locations`) or executable
// helpers (`defUse`), so walking them as semantic input would reject every
// product IR as cyclic/unsupported.  Their semantic content is represented by
// the block, instruction, value and origin shapes below; hashing the indexes a
// second time would also make identity depend on derived bookkeeping.
const IDENTITY_AUTHORITY_KEYS = Object.freeze([
  'analysisIdentity', 'identity', 'artifactIdentity',
]);
const IDENTITY_PUBLIC_KEYS = Object.freeze([
  'binaryId', 'functionId', 'snapshotId', 'semanticIrId', 'semanticIRId',
  'ssaId', 'analyzerVersion',
]);
const IDENTITY_BINDING_KEYS = Object.freeze([
  'semanticIrShapeDigest', 'semanticIRShapeDigest', 'irShapeDigest',
  'canonicalIrDigest', 'shapeDigest',
]);
const IDENTITY_SOURCE_KEYS = Object.freeze(['analysisIdentity', 'identity', 'artifactIdentity']);
const IDENTITY_FIELD_KEYS = new Set([
  ...IDENTITY_PUBLIC_KEYS, ...IDENTITY_BINDING_KEYS,
  'semanticSchemaVersion',
]);
const DERIVED_IR_KEYS = new Set([
  'blocks', 'values', 'instructions', 'locations', 'byRow', 'args', 'reachable',
  'idom', 'dominators', 'ipdom', 'immediatePostDominators', 'postDominators',
  'stackSlots', 'loops', 'backEdges',
  'defUse', '_unknownStoreBarriers', '_branchConstraints', 'compat', 'memorySafety',
  'origin', ...IDENTITY_AUTHORITY_KEYS, ...IDENTITY_PUBLIC_KEYS,
  ...IDENTITY_BINDING_KEYS, ...NON_SEMANTIC_KEYS,
]);
const ARGUMENT_KEYS = new Set(['value', 'bits', 'shift', 'origin', ...NON_SEMANTIC_KEYS]);
const INCOMING_KEYS = new Set(['value', 'origin', ...NON_SEMANTIC_KEYS]);
const MEMORY_INCOMING_KEYS = new Set([
  'from', 'semanticPredecessorBlockId', 'node', 'definitionId',
]);
const MEMORY_NODE_KEYS = new Set([
  'kind', 'key', 'definitionId', 'regionId', 'block', 'reason', 'unknownAlias', 'aliasRelation',
  'clobber', 'inst', 'prev', 'previous', 'incoming', 'memDefs', 'reaching',
  'effectSummary', 'proof', 'origin',
]);
const MEMORY_REACHING_ENTRY_KEYS = new Set(['inst', ...REFERENCE_TOKEN_KEYS]);
const MEMORY_REACHING_INSTRUCTION_KEYS = new Set(['id']);
const MEMORY_LOCATION_KEYS = new Set([
  'key', 'kind', 'size', 'regionId', 'base', 'baseEntityId', 'index', 'scale',
  'address', 'disp', 'uncertaintyIdentity', 'addressMetadataSource', 'metadata', 'origin',
]);
const DEFINITION_KEYS = new Set([
  'args', 'incoming', 'addr', 'loc', 'conditionValue', 'selectorValue', 'cond', 'extra', 'origin',
  'memUse', 'memDef', 'memDefs', 'memKills', 'reachingStore', 'unknownAliasBarrier',
  ...NON_SEMANTIC_KEYS,
]);
const VALUE_KEYS = new Set([
  'id', 'bits', 'kind', 'signed', 'const', 'float', 'floatConst', 'constKind',
  'machineType', 'origin', 'def', 'uses',
]);
const VALUE_SCHEMA_KEYS = new Set([
  ...VALUE_KEYS,
  'vid', 'reg', 'stateKey', 'version', 'range', 'nullable', 'type', 'label',
  'semanticValueId', 'semanticSsaValueId', 'sourceSemanticValueId', 'sourceEntityId',
  'unknown', 'undefined', 'clobbered', 'compatDerived',
]);
const BLOCK_KEYS = new Set([
  'insts', 'phis', 'memPhis', 'successorEdges', 'succ', 'pred', 'origin', ...NON_SEMANTIC_KEYS,
]);
const ADDRESS_KEYS = new Set(['base', 'index']);
const DEFINITION_REFERENCE_KEYS = new Set([
  ...REFERENCE_TOKEN_KEYS, 'block', 'row', 'op', 'sub', 'dst',
]);
const IR_SCHEMA_KEYS = new Set([...DERIVED_IR_KEYS, 'entry', 'semanticSchemaVersion']);
const ARGUMENT_SCHEMA_KEYS = new Set([...ARGUMENT_KEYS, 'id']);
const INCOMING_SCHEMA_KEYS = new Set([...INCOMING_KEYS, 'id', 'from']);
const DEFINITION_SCHEMA_KEYS = new Set([
  ...DEFINITION_KEYS,
  ...REFERENCE_TOKEN_KEYS,
  'op', 'sub', 'block', 'row', 'target', 'trueTarget', 'falseTarget',
  'defaultTarget', 'targets', 'cases', 'casesComplete', 'value', 'bits',
  'signed', 'kind', 'size', 'writesState', 'semanticNodeId', 'sourceEntityId',
  'sourceEffectIds', 'sourceInstructionIds', 'address', 'text', 'memoryAliasRelation',
  'memoryBarrier', 'clobbers',
]);
const BLOCK_SCHEMA_KEYS = new Set([
  ...BLOCK_KEYS, 'index', 'id', 'isEntry', 'declaredEdges',
]);
const EMPTY_LIST = Object.freeze([]);

/*
 * Phase 8 executes over this private, descriptor-captured graph rather than the
 * caller's live objects.  A Proxy descriptor is allowed to mutate another
 * property while a graph is being observed; trying to detect every such
 * re-entrancy after the fact is not an enforceable boundary.  Capturing once
 * makes the mixed observation itself the immutable semantic input shared by
 * identity derivation and every consumer.  Publication separately verifies
 * that a fresh capture still has the same shape.
 */
const PHASE8_SEMANTIC_SNAPSHOTS = new WeakSet();
const SNAPSHOT_MAP_TARGETS = new WeakMap();
const SNAPSHOT_SET_TARGETS = new WeakMap();
const SNAPSHOT_DATE_TARGETS = new WeakMap();
const rejectSnapshotMutation = () => { throw new TypeError('phase8-semantic-snapshot-immutable'); };
const MAP_READ_METHODS = new Set(['get', 'has', 'entries', 'keys', 'values']);
const SET_READ_METHODS = new Set(['has', 'entries', 'keys', 'values']);

function readonlyMap(target) {
  let proxy;
  proxy = new Proxy(target, {
    get(map, key, receiver) {
      if (key === 'set' || key === 'delete' || key === 'clear') return rejectSnapshotMutation;
      if (key === 'size') return Reflect.get(map, key, map);
      if (key === 'forEach') {
        return (callback, thisArg = undefined) => {
          if (typeof callback !== 'function') throw new TypeError('phase8-semantic-map-callback-required');
          return Map.prototype.forEach.call(map,
            (value, entryKey) => callback.call(thisArg, value, entryKey, proxy));
        };
      }
      if (key === Symbol.iterator) return Map.prototype[Symbol.iterator].bind(map);
      if (MAP_READ_METHODS.has(key)) return Map.prototype[key].bind(map);
      return Reflect.get(map, key, receiver);
    },
    set:rejectSnapshotMutation,
    defineProperty:rejectSnapshotMutation,
    deleteProperty:rejectSnapshotMutation,
    setPrototypeOf:rejectSnapshotMutation,
  });
  SNAPSHOT_MAP_TARGETS.set(proxy, target);
  return proxy;
}

function readonlySet(target) {
  let proxy;
  proxy = new Proxy(target, {
    get(set, key, receiver) {
      if (key === 'add' || key === 'delete' || key === 'clear') return rejectSnapshotMutation;
      if (key === 'size') return Reflect.get(set, key, set);
      if (key === 'forEach') {
        return (callback, thisArg = undefined) => {
          if (typeof callback !== 'function') throw new TypeError('phase8-semantic-set-callback-required');
          return Set.prototype.forEach.call(set,
            (value) => callback.call(thisArg, value, value, proxy));
        };
      }
      if (key === Symbol.iterator) return Set.prototype[Symbol.iterator].bind(set);
      if (SET_READ_METHODS.has(key)) return Set.prototype[key].bind(set);
      return Reflect.get(set, key, receiver);
    },
    set:rejectSnapshotMutation,
    defineProperty:rejectSnapshotMutation,
    deleteProperty:rejectSnapshotMutation,
    setPrototypeOf:rejectSnapshotMutation,
  });
  SNAPSHOT_SET_TARGETS.set(proxy, target);
  return proxy;
}

function readonlyDate(target) {
  const proxy = new Proxy(target, {
    get(date, key, receiver) {
      if (typeof key === 'string' && key.startsWith('set')
          && typeof Date.prototype[key] === 'function') return rejectSnapshotMutation;
      if (Object.hasOwn(Date.prototype, key) && typeof Date.prototype[key] === 'function') {
        return Date.prototype[key].bind(date);
      }
      return Reflect.get(date, key, receiver);
    },
    set:rejectSnapshotMutation,
    defineProperty:rejectSnapshotMutation,
    deleteProperty:rejectSnapshotMutation,
    setPrototypeOf:rejectSnapshotMutation,
  });
  SNAPSHOT_DATE_TARGETS.set(proxy, target);
  return proxy;
}
const SNAPSHOT_ROOT_OMIT_KEYS = new Set([
  // Executable/index compatibility views are not semantic inputs and are not
  // consumed by Phase 8. Their own descriptors are still validated below.
  'locations', 'byRow', 'args', 'reachable', 'defUse', '_unknownStoreBarriers',
  '_branchConstraints', 'compat', 'memorySafety', 'stackSlots',
  // These iterable class views are executable indexes over the canonical
  // immediate-dominator arrays retained below. Consumers already fall back to
  // the same idom/ipdom facts, so the live method-bearing views never cross the
  // snapshot boundary.
  'dominators', 'postDominators',
]);
const SNAPSHOT_EDGE_KEYS = new Set([
  'from', 'to', 'kind', 'kinds', 'edgeId', 'reachable', 'status', 'predicate',
  'facts', 'provenance', 'reason',
]);
const SNAPSHOT_LOOP_KEYS = new Set([
  'header', 'nodes', 'blocks', 'latches', 'exits', 'exitEdges', 'classification',
  'guardBlock', 'depth', 'parentHeader', 'earlyExitCount', 'earlyExitEdges',
]);
const SNAPSHOT_ORIGIN_KEYS = new Set([
  'schemaVersion', 'byteRanges', 'virtualRanges', 'instructionIds', 'operationIds',
  'bytecodeOperationIds', 'sourceLocations', 'parentEntityIds', 'transforms',
]);
const SNAPSHOT_EXTRA_KEYS = new Set([
  'value', 'lsb', 'low', 'offset', 'width', 'widthBits', 'sourceBits', 'targetBits',
  'cases', 'casesComplete', 'memoryAccess', 'addressPrecise', 'faults',
  'signed', 'widen', 'toward', 'bitfieldKind', 'negate', 'comparison', 'float',
  'conditional', 'cond', 'fallbackNzcv', 'completeness', 'castKind', 'compatSource',
  'conditionValueId', 'conditionCarrierValueId', 'semanticComparisonCarrier',
  'stateRead', 'stateWrite', 'publicStateIdentity', 'reachingStateSsaValueId',
  'stateSsaUseId', 'stateSsaDefinitionId', 'stateReadProof', 'stateWriteProof',
  'localPhysicalViewProjection', 'entryStateRead', 'attributes', 'semanticNodeId',
]);
const SNAPSHOT_MEMORY_ACCESS_KEYS = new Set([
  'addressSpace', 'addressExpr', 'addressValueId', 'widthBits', 'endian', 'alignment',
  'volatility', 'atomic', 'ordering', 'faults',
]);
const SNAPSHOT_SHIFT_KEYS = new Set(['op', 'amount']);
const SNAPSHOT_MACHINE_TYPE_KEYS = new Set([
  'kind', 'widthBits', 'format', 'laneCount', 'elementType', 'addressSpace',
]);
const SNAPSHOT_ADDRESS_EXPRESSION_KEYS = new Set(['valueId']);
const SNAPSHOT_STATE_IDENTITY_KEYS = new Set([
  'key', 'kind', 'scope', 'physicalIdentity', 'metadata',
]);
const SNAPSHOT_PHYSICAL_IDENTITY_KEYS = new Set([
  'kind', 'registerId', 'flagId', 'groupId', 'view', 'widthBits',
]);
const SNAPSHOT_SWITCH_CASE_KEYS = new Set(['value', 'caseValue', 'constant', 'to', 'target']);
const SNAPSHOT_FAULT_KEYS = new Set(['kind', 'condition', 'detail']);
const SNAPSHOT_ADDRESS_KEYS = new Set([
  ...ADDRESS_KEYS, 'baseReg', 'disp', 'scale', 'extend', 'size', 'widthBits',
  'stack', 'addressSpace', 'rawAddressValueId', 'indexSignedness', 'indexWidthBits',
  'addressWidthBits', 'precise', 'unknownReason', 'compatDisplacementEvidence', 'origin',
]);
const SNAPSHOT_ROLE_KEYS = new Map([
  ['ir', IR_SCHEMA_KEYS],
  ['block', BLOCK_SCHEMA_KEYS],
  ['value', VALUE_SCHEMA_KEYS],
  ['definition', DEFINITION_SCHEMA_KEYS],
  ['argument', ARGUMENT_SCHEMA_KEYS],
  ['incoming', INCOMING_SCHEMA_KEYS],
  ['memory-node', MEMORY_NODE_KEYS],
  ['memory-incoming', MEMORY_INCOMING_KEYS],
  ['memory-location', MEMORY_LOCATION_KEYS],
  ['address', SNAPSHOT_ADDRESS_KEYS],
  ['identity', IDENTITY_FIELD_KEYS],
  ['edge', SNAPSHOT_EDGE_KEYS],
  ['loop', SNAPSHOT_LOOP_KEYS],
  ['origin', SNAPSHOT_ORIGIN_KEYS],
  ['extra', SNAPSHOT_EXTRA_KEYS],
  ['memory-access', SNAPSHOT_MEMORY_ACCESS_KEYS],
  ['shift', SNAPSHOT_SHIFT_KEYS],
  ['machine-type', SNAPSHOT_MACHINE_TYPE_KEYS],
  ['address-expression', SNAPSHOT_ADDRESS_EXPRESSION_KEYS],
  ['state-identity', SNAPSHOT_STATE_IDENTITY_KEYS],
  ['physical-identity', SNAPSHOT_PHYSICAL_IDENTITY_KEYS],
  ['memory-reaching', MEMORY_REACHING_ENTRY_KEYS],
  ['switch-case', SNAPSHOT_SWITCH_CASE_KEYS],
  ['fault', SNAPSHOT_FAULT_KEYS],
  ['reference', new Set(REFERENCE_TOKEN_KEYS)],
]);

function snapshotListItemRole(role) {
  switch (role) {
    case 'block-list': return 'block';
    case 'value-list': return 'value';
    case 'definition-list': return 'definition';
    case 'argument-list': return 'argument';
    case 'incoming-list': return 'incoming';
    case 'memory-node-list': return 'memory-node';
    case 'memory-incoming-list': return 'memory-incoming';
    case 'memory-location-list': return 'memory-location';
    case 'memory-reaching-list': return 'memory-reaching';
    case 'edge-list': return 'edge';
    case 'loop-list': return 'loop';
    case 'switch-case-list': return 'switch-case';
    case 'fault-list': return 'fault';
    case 'reference-list': return 'reference';
    default: return 'generic';
  }
}

function snapshotChildRole(role, key) {
  if (role === 'ir') {
    if (key === 'blocks') return 'block-list';
    if (key === 'values') return 'value-list';
    if (key === 'instructions') return 'definition-list';
    if (key === 'loops') return 'loop-list';
    if (key === 'backEdges') return 'edge-list';
    if (key === 'entry') return 'reference';
    if (IDENTITY_AUTHORITY_KEYS.includes(key)) return 'identity';
  }
  if (role === 'block') {
    if (key === 'insts' || key === 'phis') return 'definition-list';
    if (key === 'memPhis') return 'memory-node-list';
    if (key === 'successorEdges') return 'edge-list';
    if (key === 'succ' || key === 'pred') return 'reference-list';
  }
  if (role === 'value') {
    if (key === 'def') return 'definition';
    if (key === 'uses') return 'definition-list';
    if (key === 'machineType') return 'machine-type';
  }
  if (role === 'definition') {
    if (key === 'args') return 'argument-list';
    if (key === 'incoming') return 'incoming-list';
    if (key === 'dst' || key === 'conditionValue' || key === 'selectorValue') return 'value';
    if (key === 'addr') return 'address';
    if (key === 'loc') return 'memory-location';
    if (key === 'memUse' || key === 'memDef') return 'memory-node';
    if (key === 'memDefs') return 'memory-node-list';
    if (key === 'memKills') return 'memory-location-list';
    if (key === 'reachingStore' || key === 'unknownAliasBarrier') return 'memory-reaching';
    if (key === 'cases') return 'switch-case-list';
    if (['target', 'trueTarget', 'falseTarget', 'defaultTarget'].includes(key)) return 'reference';
    if (key === 'targets') return 'reference-list';
  }
  if (role === 'argument' || role === 'incoming') {
    if (key === 'value') return 'value';
    if (role === 'argument' && key === 'shift') return 'shift';
  }
  if (role === 'memory-node') {
    if (key === 'inst') return 'definition';
    if (key === 'prev') return 'memory-node';
    if (key === 'previous') return 'memory-node-list';
    if (key === 'incoming') return 'memory-incoming-list';
    if (key === 'memDefs' || key === 'reaching') return 'memory-reaching-list';
  }
  if (role === 'memory-reaching' && key === 'inst') return 'reference';
  if (role === 'memory-incoming' && key === 'node') return 'memory-node';
  if (role === 'address' && (key === 'base' || key === 'index')) return 'value';
  if (role === 'memory-location' && (key === 'base' || key === 'index')) return 'reference';
  if (role === 'edge' && (key === 'from' || key === 'to')) return 'reference';
  if (role === 'loop') {
    if (key === 'header' || key === 'guardBlock' || key === 'parentHeader') return 'reference';
    if (key === 'nodes' || key === 'blocks' || key === 'latches' || key === 'exits') return 'reference-list';
    if (key === 'exitEdges' || key === 'earlyExitEdges') return 'edge-list';
  }
  if (role === 'extra') {
    if (key === 'memoryAccess') return 'memory-access';
    if (key === 'cases') return 'switch-case-list';
    if (key === 'faults') return 'fault-list';
    if (key === 'stateRead' || key === 'stateWrite') return 'state-identity';
  }
  if (role === 'memory-access') {
    if (key === 'faults') return 'fault-list';
    if (key === 'addressExpr') return 'address-expression';
  }
  if (role === 'machine-type' && key === 'elementType') return 'machine-type';
  if (role === 'state-identity' && key === 'physicalIdentity') return 'physical-identity';
  if (role === 'switch-case' && (key === 'to' || key === 'target')) return 'reference';
  if (key === 'origin' || key === 'provenance') return 'origin';
  if (key === 'extra') return 'extra';
  if (REFERENCE_TOKEN_KEYS.includes(key)) return 'reference';
  return 'generic';
}

/**
 * Capture a graph that Phase 8 may safely execute against.
 *
 * No ordinary property read or user method is performed. Object sharing and
 * cycles are retained, while every copied node becomes inaccessible to later
 * caller mutation. Canonical producer artifacts remain producer-owned leaves:
 * their private brand and deep freeze are the stronger ownership proof.
 */
function capturePhase8SemanticSnapshotWithBudget(ir, workBudget) {
  if (PHASE8_SEMANTIC_SNAPSHOTS.has(ir)) return ir;
  if (ir == null || typeof ir !== 'object' || Array.isArray(ir)) {
    throw new TypeError('identity-invalid-semantic-ir');
  }

  const records = new WeakMap();
  const pendingFreeze = [];
  const budget = workBudget;
  const consumeCaptureWork = budget.consume;
  const capturedStrings = new Set();
  const capturedBigints = new Set();
  const capture = (value, role = 'generic') => {
    if (value === null) return null;
    switch (typeof value) {
      case 'undefined':
        return value;
      case 'string':
        if (!capturedStrings.has(value)) {
          budget.consumeText(value);
          capturedStrings.add(value);
        }
        return value;
      case 'boolean':
        return value;
      case 'bigint':
        if (!capturedBigints.has(value)) {
          budget.bigintText(value);
          capturedBigints.add(value);
        }
        return value;
      case 'number':
        if (!Number.isFinite(value)) throw new TypeError('identity-non-finite-number');
        return value;
      case 'function':
      case 'symbol':
        throw new TypeError('identity-invalid-semantic-metadata');
      default: break;
    }

    if ((isCanonicalMemorySsaProducerArtifact(value) && Object.isFrozen(value))
        || canonicalOriginSetDigest(value) != null) return value;
    let record = records.get(value);
    if (record == null) {
      consumeCaptureWork(1);
      const prototype = Object.getPrototypeOf(value);
      let kind;
      let clone;
      let propertyTarget;
      if (Array.isArray(value)) {
        if (prototype !== Array.prototype) throw new TypeError('identity-unsupported-semantic-array');
        kind = 'array';
        // The length descriptor is observed below before any indexed value.
        clone = [];
        propertyTarget = clone;
      } else if (prototype === Map.prototype) {
        kind = 'map';
        propertyTarget = new Map();
        clone = readonlyMap(propertyTarget);
      } else if (prototype === Set.prototype) {
        kind = 'set';
        propertyTarget = new Set();
        clone = readonlySet(propertyTarget);
      } else if (prototype === Date.prototype) {
        kind = 'date';
        const sourceDate = SNAPSHOT_DATE_TARGETS.get(value) ?? value;
        propertyTarget = new Date(Date.prototype.getTime.call(sourceDate));
        clone = readonlyDate(propertyTarget);
      } else {
        if (prototype !== Object.prototype && prototype !== null) {
          throw new TypeError('identity-unsupported-semantic-metadata');
        }
        kind = 'object';
        clone = Object.create(prototype);
        propertyTarget = clone;
      }

      const reportedKeys = Reflect.ownKeys(value);
      for (const key of reportedKeys) {
        if (typeof key === 'symbol') throw new TypeError('identity-symbol-semantic-metadata');
        consumeCaptureWork(1);
        budget.consumeText(key);
      }
      record = {
        source:value,
        clone,
        propertyTarget,
        kind,
        reported:new Set(reportedKeys),
        reportedKeys,
        descriptors:new Map(),
        chargedKeys:new Set(reportedKeys),
        defined:new Set(),
        roles:new Set(),
        length:null,
        omitRootKeys:role === 'ir',
      };
      records.set(value, record);
      pendingFreeze.push(propertyTarget);

      if (kind === 'map') {
        const sourceMap = SNAPSHOT_MAP_TARGETS.get(value) ?? value;
        const size = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get.call(sourceMap);
        consumeCaptureWork(size);
        // Fix the intrinsic iteration domain before descending. A descriptor
        // trap on a key/value can mutate its source collection; keeping the
        // iterator live while capturing that child would absorb unbudgeted
        // appended entries.
        const sourceEntries = Array.from(Map.prototype.entries.call(sourceMap));
        if (sourceEntries.length !== size) {
          throw new TypeError('identity-semantic-snapshot-collection-changed');
        }
        for (const [key, entryValue] of sourceEntries) {
          Map.prototype.set.call(propertyTarget, capture(key), capture(entryValue));
        }
      } else if (kind === 'set') {
        const sourceSet = SNAPSHOT_SET_TARGETS.get(value) ?? value;
        const size = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get.call(sourceSet);
        consumeCaptureWork(size);
        const sourceValues = Array.from(Set.prototype.values.call(sourceSet));
        if (sourceValues.length !== size) {
          throw new TypeError('identity-semantic-snapshot-collection-changed');
        }
        for (const entryValue of sourceValues) {
          Set.prototype.add.call(propertyTarget, capture(entryValue));
        }
      }
    }

    // Mark before descending so a cycle returning with the same role stops,
    // while a later, more specific role can still extend this one clone.
    if (record.roles.has(role)) return record.clone;
    record.roles.add(role);

    const keys = new Set(record.reportedKeys);
    for (const key of SNAPSHOT_ROLE_KEYS.get(role) ?? EMPTY_LIST) keys.add(key);
    if (record.kind === 'array') keys.add('length');
    const itemRole = record.kind === 'array' ? snapshotListItemRole(role) : null;
    const orderedKeys = [...keys].sort((left, right) => {
      if (record.kind === 'array' && left === 'length') return -1;
      if (record.kind === 'array' && right === 'length') return 1;
      return codeUnitCompare(left, right);
    });
    for (const key of orderedKeys) {
      // Canonical array slots are handled as a complete 0..length-1 domain
      // below. Reported indexes outside that domain still flow through this
      // path and fail rather than disappearing from the capture.
      if (record.kind === 'array' && arrayIndexKey(key) && record.length != null
          && Number(key) < record.length) continue;
      let descriptor;
      if (record.descriptors.has(key)) descriptor = record.descriptors.get(key);
      else {
        if (!record.chargedKeys.has(key)) {
          consumeCaptureWork(1);
          record.chargedKeys.add(key);
        }
        descriptor = Object.getOwnPropertyDescriptor(record.source, key) ?? null;
        record.descriptors.set(key, descriptor);
      }
      if (descriptor == null) {
        if (record.reported.has(key)) throw new TypeError('identity-unsupported-semantic-descriptor');
        continue;
      }
      if (record.kind === 'array' && key === 'length') {
        if (!('value' in descriptor) || descriptor.enumerable || descriptor.configurable
            || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0
            || descriptor.value > 0xffffffff) {
          throw new TypeError('identity-unsupported-semantic-array');
        }
        if (record.length == null) {
          record.length = descriptor.value;
          record.propertyTarget.length = descriptor.value;
        } else if (record.length !== descriptor.value) {
          throw new TypeError('identity-unsupported-semantic-array');
        }
        continue;
      }
      if (!('value' in descriptor) || !descriptor.enumerable) {
        throw new TypeError('identity-unsupported-semantic-descriptor');
      }
      if (record.kind === 'array' && arrayIndexKey(key)
          && (record.length == null || Number(key) >= record.length)) {
        throw new TypeError('identity-unsupported-semantic-array');
      }
      if (record.omitRootKeys && SNAPSHOT_ROOT_OMIT_KEYS.has(key)) continue;
      const childRole = record.kind === 'array' && arrayIndexKey(key)
        ? itemRole : snapshotChildRole(role, key);
      const captured = capture(descriptor.value, childRole);
      if (!record.defined.has(key)) {
        Object.defineProperty(record.propertyTarget, key, {
          value:captured, enumerable:true, configurable:true, writable:true,
        });
        record.defined.add(key);
      }
    }
    if (record.kind === 'array') {
      if (record.length == null) throw new TypeError('identity-unsupported-semantic-array');
      // Proxy ownKeys may legally omit configurable dense indexes. Probe the
      // complete canonical index domain from the validated length so a hidden
      // value cannot collide with a true hole. Charge the whole traversal
      // before entering it: the Semantic IR maxReferences authority bounds the
      // cumulative nodes, own keys, Map/Set entries and array-slot visits for
      // this capture call, including role upgrades of a shared array.
      consumeCaptureWork(record.length);
      for (let index = 0; index < record.length; index += 1) {
        const key = String(index);
        let descriptor;
        if (record.descriptors.has(key)) descriptor = record.descriptors.get(key);
        else {
          descriptor = Object.getOwnPropertyDescriptor(record.source, key) ?? null;
          record.descriptors.set(key, descriptor);
        }
        if (descriptor == null) {
          if (record.reported.has(key)) {
            throw new TypeError('identity-unsupported-semantic-descriptor');
          }
          continue;
        }
        if (!('value' in descriptor) || !descriptor.enumerable) {
          throw new TypeError('identity-unsupported-semantic-descriptor');
        }
        const captured = capture(descriptor.value, itemRole);
        if (!record.defined.has(key)) {
          Object.defineProperty(record.propertyTarget, key, {
            value:captured, enumerable:true, configurable:true, writable:true,
          });
          record.defined.add(key);
        }
      }
    }
    return record.clone;
  };

  const snapshot = capture(ir, 'ir');
  for (let index = pendingFreeze.length - 1; index >= 0; index -= 1) {
    Object.freeze(pendingFreeze[index]);
  }
  PHASE8_SEMANTIC_SNAPSHOTS.add(snapshot);
  return snapshot;
}

/** Public capture always owns the fixed Semantic IR work authority. */
export function capturePhase8SemanticSnapshot(ir) {
  return capturePhase8SemanticSnapshotWithBudget(ir, createIdentityWorkBudget());
}

export function isPhase8SemanticSnapshot(value) {
  return value != null && typeof value === 'object' && PHASE8_SEMANTIC_SNAPSHOTS.has(value);
}

function createFastJsonGraphDigester({
  maxReferences = SEMANTIC_IR_DEFAULT_BUDGET.maxReferences,
  workBudget = null,
} = {}) {
  // The Semantic IR is a graph: the same definition and provenance object is
  // reachable from its value, block-local instruction and flat instruction
  // table. Serializing that graph as an expanded tree repeatedly walks and
  // copies the same subgraphs. On large loop functions that made identity
  // derivation dominate the complete optimizer stage.
  //
  // Hash one canonical node transcript per distinct object instead. The memo
  // is deliberately local to this call: a later call must walk the graph again
  // so an in-place semantic mutation can never reuse a stale identity. All of
  // the strict descriptor/type/cycle checks remain on the path to a digest.
  const memo = new WeakMap();
  const stringMemo = new Map();
  const numberMemo = new Map();
  const bigintMemo = new Map();
  const memorySsaMemo = new Map();
  const originSetMemo = new Map();
  const projectionMemo = new WeakMap();
  const descriptorMemo = new WeakMap();
  const digestReferences = new WeakSet();
  const active = new WeakSet();
  if (!Number.isSafeInteger(maxReferences) || maxReferences < 0) {
    throw new TypeError('identity-invalid-reference-budget');
  }
  const budget = workBudget ?? createIdentityWorkBudget(maxReferences);
  const consumeReferenceWork = budget.consume;
  const semanticDescriptor = (object, key) => {
    let descriptors = descriptorMemo.get(object);
    if (descriptors == null) {
      descriptors = new Map();
      descriptorMemo.set(object, descriptors);
    }
    if (descriptors.has(key)) return descriptors.get(key);
    const descriptor = Object.getOwnPropertyDescriptor(object, key) ?? null;
    descriptors.set(key, descriptor);
    return descriptor;
  };
  const dataValue = (object, key) => {
    const descriptor = semanticDescriptor(object, key);
    if (descriptor == null || !('value' in descriptor) || !descriptor.enumerable) {
      throw new TypeError('identity-unsupported-semantic-descriptor');
    }
    return descriptor.value;
  };
  // Match the repository-wide 128-bit identity width: four independent
  // 32-bit lanes make the digest suitable for a persistent artifact key.
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x243f6a88, 0xb7e15162];
  const primes = [0x01000193, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f];
  const TAG = Object.freeze({
    NULL: 1, UNDEFINED: 2, STRING: 3, FALSE: 4, TRUE: 5,
    NUMBER: 6, NEGATIVE_ZERO: 7, BIGINT: 8, ARRAY: 9,
    ARRAY_ITEM: 10, ARRAY_HOLE: 11, MAP: 12, MAP_ENTRY: 13,
    SET: 14, SET_ENTRY: 15, DATE: 16, OBJECT: 17,
    PROPERTIES: 18, PROPERTY: 19, CHILD: 20, MEMORY_SSA: 21,
    ORIGIN_SET: 22, BYTE_RANGE: 23, VIRTUAL_RANGE: 24, TRANSFORM: 25,
    PRESENT: 26, ABSENT: 27,
    ARGUMENT: 28, INCOMING: 29, MEMORY_INCOMING: 30, MEMORY_NODE: 31,
    MEMORY_LOCATION: 32, DEFINITION: 33, VALUE: 34, BLOCK: 35, IR: 36,
    ORIGIN_ARTIFACT: 37,
  });
  const mix = (hash, code) => {
    hash[0] = Math.imul(hash[0] ^ code, primes[0]) >>> 0;
    hash[1] = Math.imul(hash[1] ^ code, primes[1]) >>> 0;
    hash[2] = Math.imul(hash[2] ^ code, primes[2]) >>> 0;
    hash[3] = Math.imul(hash[3] ^ code, primes[3]) >>> 0;
  };
  const writeText = (hash, text) => {
    budget.consumeText(text);
    mix(hash, text.length);
    for (let index = 0; index < text.length; index += 1) mix(hash, text.charCodeAt(index));
  };
  // Seed the algorithm/schema version once per top-level digest. Repeating the
  // same version text for every Merkle node was measurable work on large DAGs.
  writeText(seeds, ANALYSIS_IDENTITY_DIGEST_VERSION);
  const createHash = (tag) => {
    const hash = [...seeds];
    mix(hash, tag);
    return hash;
  };
  const writeDigest = (hash, digest) => {
    mix(hash, TAG.CHILD);
    mix(hash, digest[0]);
    mix(hash, digest[1]);
    mix(hash, digest[2]);
    mix(hash, digest[3]);
  };
  const digestText = (digest) => digest
    .map((word) => word.toString(16).padStart(8, '0')).join('');
  const writeProperties = (hash, object, keys, visit, trusted = false) => {
    if (keys.length === 0) return;
    keys.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    mix(hash, TAG.PROPERTIES);
    mix(hash, keys.length);
    for (const key of keys) {
      mix(hash, TAG.PROPERTY);
      writeText(hash, key);
      writeDigest(hash, visit(trusted ? object[key] : dataValue(object, key)));
    }
  };
  const compareDigest = (left, right) => {
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
    }
    return 0;
  };
  const primitiveDigest = (cache, key, tag, text = null) => {
    let digest = cache.get(key);
    if (digest == null) {
      digest = createHash(tag);
      if (text != null) writeText(digest, text);
      cache.set(key, digest);
    }
    return digest;
  };
  const nullDigest = createHash(TAG.NULL);
  const undefinedDigest = createHash(TAG.UNDEFINED);
  const falseDigest = createHash(TAG.FALSE);
  const trueDigest = createHash(TAG.TRUE);
  const negativeZeroDigest = createHash(TAG.NEGATIVE_ZERO);
  const visit = (item) => {
    if (item === null) return nullDigest;
    switch (typeof item) {
      case 'undefined': return undefinedDigest;
      case 'function':
      case 'symbol':
        throw new TypeError('identity-invalid-semantic-metadata');
      case 'string': return primitiveDigest(stringMemo, item, TAG.STRING, item);
      case 'boolean': return item ? trueDigest : falseDigest;
      case 'number': {
        if (!Number.isFinite(item)) throw new TypeError('identity-non-finite-number');
        if (Object.is(item, -0)) return negativeZeroDigest;
        return primitiveDigest(numberMemo, item, TAG.NUMBER, String(item));
      }
      case 'bigint': {
        const cached = bigintMemo.get(item);
        if (cached != null) return cached;
        const text = budget.bigintText(item);
        const digest = createHash(TAG.BIGINT);
        // bigintText already charged the bounded conversion.
        mix(digest, text.length);
        for (let index = 0; index < text.length; index += 1) mix(digest, text.charCodeAt(index));
        bigintMemo.set(item, digest);
        return digest;
      }
      default: break;
    }

    // Projection shapes keep already-computed Merkle children as private raw
    // digest references. Rehashing their 32-character diagnostic spelling at
    // every parent would turn a linear DAG walk into a large amount of repeated
    // text work. Only arrays registered by this call-local digester are trusted.
    if (digestReferences.has(item)) return item;

    // Canonical MemorySSA artifacts are private-branded, deeply frozen content
    // addresses. Compatibility metadata can reference the same large artifact
    // from every load; walking its full proof graph again cannot add freshness
    // once the producer-owned digest is immutable. Serialized/re-signed clones
    // do not carry the private brand and stay on the strict structural path.
    if (isCanonicalMemorySsaProducerArtifact(item)
        && Object.isFrozen(item)
        && typeof item.canonicalDigest === 'string'
        && item.canonicalDigest.trim()) {
      return primitiveDigest(memorySsaMemo, item.canonicalDigest, TAG.MEMORY_SSA, item.canonicalDigest);
    }
    const originSetDigest = canonicalOriginSetDigest(item);
    if (originSetDigest != null) {
      return primitiveDigest(originSetMemo, originSetDigest, TAG.ORIGIN_ARTIFACT, originSetDigest);
    }

    const cached = memo.get(item);
    if (cached != null) return cached;
    if (active.has(item)) throw new TypeError('identity-cyclic-semantic-metadata');
    consumeReferenceWork(1);
    active.add(item);
    try {
      const keys = semanticOwnKeys(item);
      consumeReferenceWork(keys.length);
      for (const key of keys) budget.consumeText(key);
      const prototype = Object.getPrototypeOf(item);
      let digest;
      if (Array.isArray(item)) {
        if (prototype !== Array.prototype) throw new TypeError('identity-unsupported-semantic-metadata');
        const length = semanticArrayLength(item);
        // A sparse array can expose a tiny own-key list with an enormous
        // canonical slot domain. Charge the complete domain before entering
        // the loop so hostile authority metadata fails promptly.
        consumeReferenceWork(length);
        const entries = Object.create(null);
        const indexKeys = new Set();
        const propertyKeys = [];
        for (const key of keys) {
          entries[key] = dataValue(item, key);
          if (arrayIndexKey(key)) {
            if (Number(key) >= length) throw new TypeError('identity-unsupported-semantic-array');
            indexKeys.add(key);
          }
          else propertyKeys.push(key);
        }
        const hash = createHash(TAG.ARRAY);
        mix(hash, length);
        for (let arrayIndex = 0; arrayIndex < length; arrayIndex += 1) {
          const key = String(arrayIndex);
          if (indexKeys.has(key)) {
            mix(hash, TAG.ARRAY_ITEM);
            writeDigest(hash, visit(entries[key]));
          } else {
            mix(hash, TAG.ARRAY_HOLE);
          }
        }
        writeProperties(hash, entries, propertyKeys, visit, true);
        digest = hash;
      } else if (prototype === Map.prototype) {
        const map = SNAPSHOT_MAP_TARGETS.get(item) ?? item;
        const size = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get.call(map);
        consumeReferenceWork(size);
        const entries = [...Map.prototype.entries.call(map)];
        if (entries.length !== size) throw new TypeError('identity-semantic-map-changed');
        const mapped = entries.map(([key, entryValue]) => ({
          keyDigest: visit(key), valueDigest: visit(entryValue),
        }));
        mapped.sort((left, right) => {
          const keyOrder = compareDigest(left.keyDigest, right.keyDigest);
          if (keyOrder !== 0) return keyOrder;
          // The final transcript contains only these digests. If both digest
          // pairs are equal their relative order cannot change the output, so
          // expanding the complete graphs as a tie-breaker is wasted work and
          // can become quadratic for distinct wrappers around one shared DAG.
          return compareDigest(left.valueDigest, right.valueDigest);
        });
        const hash = createHash(TAG.MAP);
        mix(hash, mapped.length);
        for (const { keyDigest, valueDigest } of mapped) {
          mix(hash, TAG.MAP_ENTRY);
          writeDigest(hash, keyDigest);
          writeDigest(hash, valueDigest);
        }
        writeProperties(hash, item, keys, visit);
        digest = hash;
      } else if (prototype === Set.prototype) {
        const set = SNAPSHOT_SET_TARGETS.get(item) ?? item;
        const size = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get.call(set);
        consumeReferenceWork(size);
        const entries = [...Set.prototype.values.call(set)];
        if (entries.length !== size) throw new TypeError('identity-semantic-set-changed');
        const values = entries.map((entryValue) => ({ digest: visit(entryValue) }))
          .sort((left, right) => compareDigest(left.digest, right.digest));
        const hash = createHash(TAG.SET);
        mix(hash, values.length);
        for (const { digest: entryDigest } of values) {
          mix(hash, TAG.SET_ENTRY);
          writeDigest(hash, entryDigest);
        }
        writeProperties(hash, item, keys, visit);
        digest = hash;
      } else if (prototype === Date.prototype) {
        const date = SNAPSHOT_DATE_TARGETS.get(item) ?? item;
        const iso = Date.prototype.toISOString.call(date);
        const hash = createHash(TAG.DATE);
        writeText(hash, iso);
        writeProperties(hash, item, keys, visit);
        digest = hash;
      } else {
        if (prototype !== Object.prototype && prototype !== null) {
          throw new TypeError('identity-unsupported-semantic-metadata');
        }
        const hash = createHash(TAG.OBJECT);
        writeProperties(hash, item, keys, visit);
        digest = hash;
      }
      memo.set(item, digest);
      return digest;
    } finally {
      active.delete(item);
    }
  };
  const project = (item, skip, knownKeys = skip, requirePlain = false) => {
    if (item == null || typeof item !== 'object' || Array.isArray(item)) {
      if (requirePlain) throw new TypeError('identity-unsupported-semantic-metadata');
      return { digest: visit(item), includedCount: null, values: null };
    }
    const prototype = Object.getPrototypeOf(item);
    if (prototype === Map.prototype || prototype === Set.prototype || prototype === Date.prototype) {
      if (requirePlain) throw new TypeError('identity-unsupported-semantic-metadata');
      return { digest: visit(item), includedCount: null, values: null };
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('identity-unsupported-semantic-metadata');
    }
    const variants = projectionMemo.get(item);
    // Schema callers that add known-key probes pair that set with one fixed
    // skip set. Plain projections otherwise retain the hot skip-identity key.
    const variantKey = knownKeys === skip ? skip : knownKeys;
    const cached = variants?.get(variantKey);
    if (cached != null) return cached;
    if (active.has(item)) throw new TypeError('identity-cyclic-semantic-metadata');
    consumeReferenceWork(1);
    active.add(item);
    try {
      const reportedKeys = semanticOwnKeys(item);
      const reported = new Set(reportedKeys);
      const keys = [...reportedKeys];
      for (const key of reportedKeys) budget.consumeText(key);
      for (const key of knownKeys) {
        if (!reported.has(key)) keys.push(key);
      }
      keys.sort(codeUnitCompare);
      consumeReferenceWork(keys.length);
      const values = Object.create(null);
      const included = [];
      for (const key of keys) {
        // Snapshot each descriptor exactly once. Known schema fields are probed
        // even when a Proxy omits a configurable key from `ownKeys`; reported
        // keys may not disappear between the key and descriptor observations.
        const descriptor = semanticDescriptor(item, key);
        if (descriptor == null) {
          if (reported.has(key)) throw new TypeError('identity-unsupported-semantic-descriptor');
          continue;
        }
        if (!('value' in descriptor) || !descriptor.enumerable) {
          throw new TypeError('identity-unsupported-semantic-descriptor');
        }
        const entryValue = descriptor.value;
        values[key] = entryValue;
        if (skip.has(key)) continue;
        included.push([key, entryValue]);
      }
      const hash = createHash(TAG.OBJECT);
      if (included.length > 0) {
        mix(hash, TAG.PROPERTIES);
        mix(hash, included.length);
      }
      for (const [key, entryValue] of included) {
        mix(hash, TAG.PROPERTY);
        writeText(hash, key);
        writeDigest(hash, visit(entryValue));
      }
      const result = { digest: hash, includedCount:included.length, values };
      const next = variants ?? new Map();
      // Skip sets are module-local constants (or one definition-local set), so
      // their object identity is the exact projection variant. Avoid rebuilding
      // and sorting a long textual key for every definition in a function.
      next.set(variantKey, result);
      if (variants == null) projectionMemo.set(item, next);
      return result;
    } finally {
      active.delete(item);
    }
  };
  const digest = (value) => digestText(visit(value));
  digest.consumeText = budget.consumeText;
  digest.bigintText = budget.bigintText;
  digest.reference = (value) => {
    const reference = visit(value);
    digestReferences.add(reference);
    return reference;
  };
  digest.project = (value, skip, knownKeys = skip) => {
    const result = project(value, skip, knownKeys);
    digestReferences.add(result.digest);
    return result;
  };
  digest.projectPlain = (value, skip, knownKeys = skip) => {
    const result = project(value, skip, knownKeys, true);
    digestReferences.add(result.digest);
    return result;
  };
  digest.fields = (value, keys) => {
    if (value == null || typeof value !== 'object') {
      throw new TypeError('identity-invalid-semantic-node');
    }
    consumeReferenceWork(keys.size ?? keys.length);
    const fields = Object.create(null);
    for (const key of keys) {
      const descriptor = semanticDescriptor(value, key);
      if (descriptor == null) continue;
      if (!('value' in descriptor) || !descriptor.enumerable) {
        throw new TypeError('identity-unsupported-semantic-descriptor');
      }
      fields[key] = descriptor.value;
    }
    return fields;
  };
  digest.record = (tag, values) => {
    const code = TAG[tag];
    if (!Number.isSafeInteger(code) || !Array.isArray(values)) {
      throw new TypeError('identity-invalid-internal-record');
    }
    const reference = createHash(code);
    mix(reference, values.length);
    for (const value of values) writeDigest(reference, visit(value));
    digestReferences.add(reference);
    return reference;
  };
  digest.list = (values) => {
    if (!Array.isArray(values)) throw new TypeError('identity-invalid-internal-list');
    const reference = createHash(TAG.ARRAY);
    mix(reference, values.length);
    for (const value of values) {
      mix(reference, TAG.ARRAY_ITEM);
      writeDigest(reference, visit(value));
    }
    digestReferences.add(reference);
    return reference;
  };
  return digest;
}

function fastJsonGraphDigest(value, digester = null) {
  return (digester ?? createFastJsonGraphDigester())(value);
}

function semanticProjectionDigest(value, skip, digests, knownKeys = skip) {
  return digests.graphDigester.project(value, skip, knownKeys);
}

function metadataProjection(value, skip, digests, knownKeys = skip) {
  if (value == null || typeof value !== 'object') return { digest: null, values: null };
  const projected = semanticProjectionDigest(value, skip, digests, knownKeys);
  return {
    digest: projected.includedCount === 0 ? null : projected.digest,
    values: projected.values,
  };
}

function semanticDigest(value, digests) {
  if (value == null) return null;
  if (typeof value === 'object') {
    const cached = digests.get(value);
    if (cached != null) return cached;
    // Ordinary Phase 8 metadata (`extra`, effect summaries, and proofs) is a
    // plain graph in the canonical IR. Hash it exactly once: retrying a failed
    // descriptor read could let a stateful Proxy launder malformed metadata.
    const digest = digests.graphDigester.reference(value);
    digests.set(value, digest);
    return digest;
  }
  return digests.graphDigester.reference(value);
}

function argumentShape(argument, digests) {
  if (argument == null || typeof argument !== 'object') throw new TypeError('identity-invalid-semantic-node');
  const projection = metadataProjection(argument, ARGUMENT_KEYS, digests, ARGUMENT_SCHEMA_KEYS);
  const values = projection.values;
  const valueToken = values.value == null
    ? requiredToken(values.id, digests)
    : optionalReferenceToken(values.value, digests, 'id');
  return digests.graphDigester.record('ARGUMENT', [
    projection.digest,
    valueToken,
    values.bits ?? null,
    semanticDigest(values.shift, digests),
    semanticDigest(values.origin, digests),
  ]);
}

function incomingShape(incoming, digests) {
  if (incoming == null || typeof incoming !== 'object') throw new TypeError('identity-invalid-semantic-node');
  const projection = metadataProjection(incoming, INCOMING_KEYS, digests, INCOMING_SCHEMA_KEYS);
  const values = projection.values;
  const valueToken = values.value == null
    ? requiredToken(values.id, digests)
    : optionalReferenceToken(values.value, digests, 'id');
  return digests.graphDigester.record('INCOMING', [
    projection.digest,
    valueToken,
    semanticDigest(values.origin, digests),
  ]);
}

function memoryIncomingShape(item, digests) {
  if (item == null || typeof item !== 'object') throw new TypeError('identity-invalid-semantic-node');
  const projected = semanticProjectionDigest(item, MEMORY_INCOMING_KEYS, digests);
  const values = projected.values;
  if (Object.keys(values).length === 0) throw new TypeError('identity-invalid-semantic-node');
  const metadataDigest = projected.includedCount === 0 ? null : projected.digest;
  const nodeId = Object.hasOwn(values, 'node') && values.node != null
    ? optionalReferenceToken(values.node, digests, 'definitionId')
    : null;
  const definitionId = Object.hasOwn(values, 'definitionId') && values.definitionId != null
    ? requiredToken(values.definitionId, digests)
    : null;
  if (nodeId == null && definitionId == null) throw new TypeError('identity-required-reference-token');
  return digests.graphDigester.record('MEMORY_INCOMING', [
    metadataDigest,
    values.from ?? null,
    token(values.semanticPredecessorBlockId, digests),
    nodeId,
    definitionId,
  ]);
}

// MemorySSA nodes are part of the projected IR, but their `prev`, `incoming`
// and `inst` fields point back into the same graph.  Keep the semantic keys and
// reference IDs while deliberately omitting those object edges; otherwise a
// valid loop with a memory phi is mistaken for malformed cyclic IR.
function memoryReachingEntryShape(entry, digests) {
  if (entry == null || typeof entry !== 'object') {
    throw new TypeError('identity-invalid-semantic-node');
  }
  const fields = digests.graphDigester.fields(entry, MEMORY_REACHING_ENTRY_KEYS);
  let instId = null;
  if (fields.inst != null) {
    if (typeof fields.inst !== 'object') {
      throw new TypeError('identity-invalid-semantic-node');
    }
    const instFields = digests.graphDigester.fields(fields.inst, MEMORY_REACHING_INSTRUCTION_KEYS);
    if (Object.hasOwn(instFields, 'id') && instFields.id != null) {
      instId = requiredToken(instFields.id, digests);
    }
  }
  // Bind the preferred `inst.id` and every direct alias separately. GVN uses
  // inst.id ?? id, but a lower-priority alias must not conceal a mutation of
  // the preferred source.
  const directId = Object.hasOwn(fields, 'id') ? token(fields.id, digests) : null;
  const instructionId = Object.hasOwn(fields, 'instructionId')
    ? token(fields.instructionId, digests) : null;
  const definitionId = Object.hasOwn(fields, 'definitionId')
    ? token(fields.definitionId, digests) : null;
  if (instId == null && directId == null && instructionId == null && definitionId == null) {
    throw new TypeError('identity-required-reference-token');
  }
  return digests.graphDigester.record('PRESENT', [
    instId,
    directId,
    instructionId,
    definitionId,
  ]);
}

function memoryNodeShape(node, digests, memoryCache) {
  if (node == null) return null;
  if (typeof node !== 'object') throw new TypeError('identity-invalid-semantic-node');
  const cached = memoryCache?.nodes.get(node);
  if (cached != null) return cached;
  const projection = metadataProjection(node, MEMORY_NODE_KEYS, digests);
  const values = projection.values;
  if (Object.keys(values).length === 0) throw new TypeError('identity-invalid-semantic-node');
  const previous = mappedSemanticPropertyList(values, 'previous',
    (item) => requiredReferenceToken(item, digests, 'definitionId'));
  const incomingItems = mappedSemanticPropertyList(values, 'incoming',
    (item) => memoryIncomingShape(item, digests));
  const memDefs = mappedSemanticPropertyList(values, 'memDefs',
    (item) => memoryReachingEntryShape(item, digests));
  const reaching = mappedSemanticPropertyList(values, 'reaching',
    (item) => memoryReachingEntryShape(item, digests));
  const digest = digests.graphDigester.record('MEMORY_NODE', [
    projection.digest,
    values.kind ?? null,
    values.key ?? null,
    token(values.definitionId, digests),
    token(values.regionId, digests),
    values.block ?? null,
    values.reason ?? null,
    values.unknownAlias ?? null,
    values.aliasRelation ?? null,
    optionalReferenceToken(values.inst, digests, 'instructionId', 'id'),
    optionalReferenceToken(values.prev, digests, 'definitionId'),
    previous == null ? null : digests.graphDigester.list(previous),
    incomingItems == null ? null : digests.graphDigester.list(incomingItems),
    memDefs == null ? null : digests.graphDigester.list(memDefs),
    reaching == null ? null : digests.graphDigester.list(reaching),
    semanticDigest(values.clobber, digests),
    semanticDigest(values.effectSummary, digests),
    semanticDigest(values.proof, digests),
    semanticDigest(values.origin, digests),
  ]);
  memoryCache?.nodes.set(node, digest);
  return digest;
}

function requiredMemoryNodeShape(node, digests, memoryCache) {
  if (node == null) throw new TypeError('identity-invalid-semantic-node');
  return memoryNodeShape(node, digests, memoryCache);
}

function memoryLocationShape(location, digests, memoryCache) {
  if (location == null) return null;
  if (typeof location !== 'object') throw new TypeError('identity-invalid-semantic-node');
  const cached = memoryCache?.locations.get(location);
  if (cached != null) return cached;
  const projection = metadataProjection(location, MEMORY_LOCATION_KEYS, digests);
  const values = projection.values;
  if (Object.keys(values).length === 0) throw new TypeError('identity-invalid-semantic-node');
  const digest = digests.graphDigester.record('MEMORY_LOCATION', [
    projection.digest,
    values.key ?? null,
    values.kind ?? null,
    values.size ?? null,
    token(values.regionId, digests),
    referenceOrSelfToken(values.base, digests, 'id'),
    semanticDigest(values.baseEntityId, digests),
    referenceOrSelfToken(values.index, digests, 'id'),
    values.scale ?? null,
    semanticDigest(values.address, digests),
    semanticDigest(values.disp, digests),
    semanticDigest(values.uncertaintyIdentity, digests),
    semanticDigest(values.addressMetadataSource, digests),
    semanticDigest(values.metadata, digests),
    semanticDigest(values.origin, digests),
  ]);
  memoryCache?.locations.set(location, digest);
  return digest;
}

function requiredMemoryLocationShape(location, digests, memoryCache) {
  if (location == null) throw new TypeError('identity-invalid-semantic-node');
  return memoryLocationShape(location, digests, memoryCache);
}

function definitionShape(definition, extraSkip = [], digests = null,
  definitionCache = null, memoryCache = null) {
  if (definition == null) return null;
  if (typeof definition !== 'object') throw new TypeError('identity-invalid-semantic-node');
  const cacheKey = extraSkip.length === 0 ? '' : [...extraSkip].sort().join('\u0000');
  const cached = definitionCache?.get(definition)?.get(cacheKey);
  if (cached != null) return cached;
  const skipped = extraSkip.length === 0 ? DEFINITION_KEYS : new Set([...DEFINITION_KEYS, ...extraSkip]);
  const knownKeys = extraSkip.length === 0
    ? DEFINITION_SCHEMA_KEYS : new Set([...DEFINITION_SCHEMA_KEYS, ...extraSkip]);
  const projection = semanticProjectionDigest(definition, skipped, digests, knownKeys);
  const values = projection.values;
  if (Object.keys(values).length === 0) throw new TypeError('identity-invalid-semantic-node');
  const argumentItems = mappedSemanticPropertyList(values, 'args',
    (argument) => argumentShape(argument, digests));
  const incomingItems = mappedSemanticPropertyList(values, 'incoming',
    (item) => incomingShape(item, digests));
  const addressProjection = values.addr == null
    ? null : semanticProjectionDigest(values.addr, ADDRESS_KEYS, digests);
  const addressValues = addressProjection?.values;
  const memoryDefinitionItems = mappedSemanticPropertyList(values, 'memDefs',
    (node) => requiredMemoryNodeShape(node, digests, memoryCache));
  const memoryKillItems = mappedSemanticPropertyList(values, 'memKills',
    (location) => requiredMemoryLocationShape(location, digests, memoryCache));
  const digest = digests.graphDigester.record('DEFINITION', [
    projection.digest,
    optionalReferenceToken(values.dst, digests, 'id'),
    argumentItems == null ? null : digests.graphDigester.list(argumentItems),
    incomingItems == null ? null : digests.graphDigester.list(incomingItems),
    addressProjection?.digest ?? null,
    referenceOrSelfToken(addressValues?.base, digests, 'id'),
    referenceOrSelfToken(addressValues?.index, digests, 'id'),
    optionalReferenceToken(values.conditionValue, digests, 'id'),
    optionalReferenceToken(values.selectorValue, digests, 'id'),
    values.cond ?? null,
    semanticDigest(values.extra, digests),
    semanticDigest(values.origin, digests),
    memoryLocationShape(values.loc, digests, memoryCache),
    memoryNodeShape(values.memUse, digests, memoryCache),
    memoryNodeShape(values.memDef, digests, memoryCache),
    memoryDefinitionItems == null ? null : digests.graphDigester.list(memoryDefinitionItems),
    memoryKillItems == null ? null : digests.graphDigester.list(memoryKillItems),
    values.reachingStore == null ? null : memoryReachingEntryShape(values.reachingStore, digests),
    values.unknownAliasBarrier == null
      ? null : memoryReachingEntryShape(values.unknownAliasBarrier, digests),
  ]);
  if (definitionCache != null) {
    const entries = definitionCache.get(definition) ?? new Map();
    entries.set(cacheKey, digest);
    definitionCache.set(definition, entries);
  }
  return digest;
}

function requiredDefinitionShape(definition, digests, definitionCache, memoryCache) {
  if (definition == null) throw new TypeError('identity-invalid-semantic-node');
  return definitionShape(definition, [], digests, definitionCache, memoryCache);
}

function definitionReferenceToken(definition, digests) {
  if (definition == null || typeof definition !== 'object') {
    throw new TypeError('identity-invalid-semantic-node');
  }
  const fields = digests.graphDigester.fields(definition, DEFINITION_REFERENCE_KEYS);
  for (const key of REFERENCE_TOKEN_KEYS) {
    if (!Object.hasOwn(fields, key) || fields[key] == null) continue;
    const explicit = requiredToken(fields[key], digests);
    return `definition-id:${explicit.length}:${explicit}`;
  }
  const parts = [
    requiredToken(fields.block, digests),
    requiredToken(fields.row, digests),
    requiredToken(fields.op, digests),
    token(fields.sub, digests),
    optionalReferenceToken(fields.dst, digests, 'id'),
  ];
  return `definition-position:${parts.map((part) => (
    part == null ? '0:' : `${part.length}:${part}`
  )).join('')}`;
}

function valueShape(value, digests, definitionCache, memoryCache) {
  if (value == null || typeof value !== 'object') throw new TypeError('identity-invalid-semantic-node');
  const projection = metadataProjection(value, VALUE_KEYS, digests, VALUE_SCHEMA_KEYS);
  const values = projection.values;
  const id = requiredToken(values.id, digests);
  const uses = mappedSemanticPropertyList(values, 'uses',
    (definition) => definitionReferenceToken(definition, digests));
  uses?.sort(codeUnitCompare);
  return {
    id,
    digest: digests.graphDigester.record('VALUE', [
      projection.digest,
      id,
      values.bits ?? null,
      values.kind ?? null,
      values.signed ?? null,
      values.const ?? null,
      values.float ?? null,
      values.floatConst ?? null,
      values.constKind ?? null,
      semanticDigest(values.machineType, digests),
      semanticDigest(values.origin, digests),
      definitionShape(values.def, [], digests, definitionCache, memoryCache),
      uses == null ? null : digests.graphDigester.list(uses),
    ]),
  };
}

function instructionShape(instruction, digests, definitionCache, memoryCache) {
  if (instruction == null || typeof instruction !== 'object') throw new TypeError('identity-invalid-semantic-node');
  // definitionShape already records the selector/condition by stable value ID
  // and excludes their graph edges. Use the identical cache key for the flat
  // instruction and value-definition views instead of rebuilding every
  // definition twice.
  const shape = definitionShape(instruction, [], digests, definitionCache, memoryCache);
  return shape;
}

function blockShape(block, digests, definitionCache, memoryCache) {
  if (block == null || typeof block !== 'object') throw new TypeError('identity-invalid-semantic-node');
  const projection = semanticProjectionDigest(block, BLOCK_KEYS, digests, BLOCK_SCHEMA_KEYS);
  const values = projection.values;
  const index = requiredToken(values.index ?? values.id, digests);
  const successors = mappedSemanticPropertyList(values, 'succ', (value) => requiredToken(value, digests));
  const predecessors = mappedSemanticPropertyList(values, 'pred', (value) => requiredToken(value, digests));
  const successorEdges = mappedSemanticPropertyList(values, 'successorEdges',
    (edge) => {
      if (edge == null || typeof edge !== 'object') throw new TypeError('identity-invalid-semantic-node');
      return semanticDigest(edge, digests);
    });
  const instructions = mappedSemanticPropertyList(values, 'insts',
    (instruction) => instructionShape(instruction, digests, definitionCache, memoryCache));
  const phis = mappedSemanticPropertyList(values, 'phis',
    (definition) => requiredDefinitionShape(definition, digests, definitionCache, memoryCache));
  const memoryPhis = mappedSemanticPropertyList(values, 'memPhis',
    (node) => requiredMemoryNodeShape(node, digests, memoryCache));
  return {
    index,
    digest: digests.graphDigester.record('BLOCK', [
      projection.digest,
      index,
      token(values.id, digests),
      successors == null ? null : digests.graphDigester.list(successors),
      predecessors == null ? null : digests.graphDigester.list(predecessors),
      successorEdges == null ? null : digests.graphDigester.list(successorEdges),
      instructions == null ? null : digests.graphDigester.list(instructions),
      phis == null ? null : digests.graphDigester.list(phis),
      memoryPhis == null ? null : digests.graphDigester.list(memoryPhis),
      semanticDigest(values.origin, digests),
    ]),
  };
}

function irShape(ir, workBudget = null) {
  if (ir == null || typeof ir !== 'object') return null;
  try {
    const digests = new WeakMap();
    digests.graphDigester = createFastJsonGraphDigester({ workBudget:workBudget ?? createIdentityWorkBudget() });
    const definitionCache = new WeakMap();
    const memoryCache = { nodes: new WeakMap(), locations: new WeakMap() };
    const projection = semanticProjectionDigest(ir, DERIVED_IR_KEYS, digests, IR_SCHEMA_KEYS);
    const values = projection.values;
    const entry = token(values.entry, digests);
    const originDigest = semanticDigest(values.origin, digests);
    const blockShapes = (mappedSemanticPropertyList(values, 'blocks',
      (block) => blockShape(block, digests, definitionCache, memoryCache)) ?? [])
      .sort((left, right) => codeUnitCompare(left.index, right.index));
    for (let index = 1; index < blockShapes.length; index += 1) {
      if (blockShapes[index - 1].index === blockShapes[index].index) {
        throw new TypeError('identity-duplicate-block-token');
      }
    }
    const blocksDigest = digests.graphDigester.list(blockShapes.map((block) => block?.digest ?? block));
    const valueShapes = (mappedSemanticPropertyList(values, 'values',
      (value) => valueShape(value, digests, definitionCache, memoryCache)) ?? [])
      .sort((left, right) => codeUnitCompare(left.id, right.id));
    for (let index = 1; index < valueShapes.length; index += 1) {
      if (valueShapes[index - 1].id === valueShapes[index].id) {
        throw new TypeError('identity-duplicate-value-token');
      }
    }
    const valuesDigest = digests.graphDigester.list(valueShapes.map((value) => value?.digest ?? value));
    // Some canonical IR producers expose a flat instruction table in addition
    // to block-local `insts`. It is semantic input, not derived bookkeeping:
    // omitting it lets an in-place instruction mutation reuse a stale product.
    let instructionsDigest = null;
    if (Object.hasOwn(values, 'instructions')) {
      if (values.instructions == null) throw new TypeError('identity-invalid-semantic-node');
      instructionsDigest = Array.isArray(values.instructions)
        ? digests.graphDigester.list(mappedSemanticList(values.instructions,
          (instruction) => instructionShape(instruction, digests, definitionCache, memoryCache)))
        : semanticDigest(values.instructions, digests);
    }
    // Loop/back-edge facts are canonical upstream inputs to widening.  Keep
    // their scalar shape when present, while avoiding Maps/Sets used only as
    // derived lookup caches in graph products.
    const semanticListPresence = (key) => {
      if (!Object.hasOwn(values, key)) {
        return digests.graphDigester.record('ABSENT', []);
      }
      if (!Array.isArray(values[key])) throw new TypeError('identity-unsupported-semantic-array');
      return digests.graphDigester.record('PRESENT', [semanticDigest(values[key], digests)]);
    };
    const backEdgesDigest = semanticListPresence('backEdges');
    const loopsDigest = semanticListPresence('loops');
    // Phase 8 consumes immediate-dominance arrays retained by the snapshot.
    // Executable DominanceView indexes are deliberately omitted at capture,
    // but their canonical idom/ipdom sources must participate in publication
    // identity or an in-place dominance mutation can serve a stale artifact.
    const idomDigest = Object.hasOwn(values, 'idom')
      ? semanticDigest(values.idom, digests) : null;
    const hasIpdom = Object.hasOwn(values, 'ipdom');
    const hasIpdomAlias = Object.hasOwn(values, 'immediatePostDominators');
    const canonicalIpdomDigest = hasIpdom ? semanticDigest(values.ipdom, digests) : null;
    const aliasIpdomDigest = hasIpdomAlias
      ? semanticDigest(values.immediatePostDominators, digests) : null;
    if (hasIpdom && hasIpdomAlias && canonicalIpdomDigest !== aliasIpdomDigest) {
      throw new TypeError('identity-conflicting-immediate-post-dominators');
    }
    const hasPostDominatorTree = hasIpdom || hasIpdomAlias;
    const ipdomDigest = digests.graphDigester.record(
      hasPostDominatorTree ? 'PRESENT' : 'ABSENT',
      hasPostDominatorTree ? [hasIpdom ? canonicalIpdomDigest : aliasIpdomDigest] : [],
    );
    const shape = digests.graphDigester.record('IR', [
      projection.digest,
      entry,
      originDigest,
      blocksDigest,
      valuesDigest,
      instructionsDigest,
      backEdgesDigest,
      loopsDigest,
      idomDigest,
      ipdomDigest,
    ]);
    return {
      shape,
      values: valuesDigest,
      sourceValues: values,
      graphDigester: digests.graphDigester,
    };
  } catch {
    return null;
  }
}

function irShapeDigest(shaped) {
  if (shaped == null) return null;
  try { return `shape:${fastJsonGraphDigest(shaped.shape, shaped.graphDigester)}`; }
  catch { return null; }
}

/** The durable binding for a captured Semantic IR graph. */
export function phase8SemanticSnapshotShapeDigest(ir) {
  try {
    const workBudget = createIdentityWorkBudget();
    const snapshot = isPhase8SemanticSnapshot(ir)
      ? ir : capturePhase8SemanticSnapshotWithBudget(ir, workBudget);
    return irShapeDigest(irShape(snapshot, workBudget));
  } catch {
    return null;
  }
}

/**
 * Re-capture a live producer graph at a publication boundary and compare it to
 * the immutable graph actually consumed. No cross-call snapshot or digest memo
 * is retained.
 */
export function phase8SemanticSnapshotMatches(rawIr, semanticSnapshot) {
  if (!isPhase8SemanticSnapshot(semanticSnapshot)) return false;
  if (rawIr === semanticSnapshot) return true;
  const expected = phase8SemanticSnapshotShapeDigest(semanticSnapshot);
  const observed = phase8SemanticSnapshotShapeDigest(rawIr);
  return expected != null && observed === expected;
}

function ownDataProperty(source, key) {
  if (source == null || typeof source !== 'object') return { present: false, value: undefined, malformed: false };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor == null) return { present: false, value: undefined, malformed: false };
    if (!('value' in descriptor) || !descriptor.enumerable) {
      return { present: true, value: undefined, malformed: true };
    }
    return { present: true, value: descriptor.value, malformed: false };
  } catch {
    return { present: true, value: undefined, malformed: true };
  }
}

function identitySourceEntries(source) {
  return IDENTITY_SOURCE_KEYS.map((key) => ({
    source,
    key,
    ...ownDataProperty(source, key),
  }));
}

function explicitlyMissingIdentity(entries) {
  return entries.some((entry) => entry.present && entry.value == null);
}

function identitySourceEntriesFromSnapshot(source, values) {
  return IDENTITY_SOURCE_KEYS.map((key) => ({
    source,
    key,
    present:Object.hasOwn(values, key),
    value:values[key],
    malformed:false,
  }));
}

function identitySourceSnapshots(entries, workBudget = null) {
  if (entries.some((entry) => entry.malformed)) return null;
  // Authority objects are caller-controlled metadata, not part of the bounded
  // Semantic IR snapshot. Give their strict walk its own call-local hard cap so
  // a sparse array or broad nested graph cannot turn identity validation into
  // unbounded work.
  const digester = createFastJsonGraphDigester({
    maxReferences:SEMANTIC_IR_DEFAULT_BUDGET.maxReferences,
    workBudget:workBudget ?? createIdentityWorkBudget(),
  });
  const snapshots = [];
  try {
    for (const entry of entries) {
      if (!entry.present || entry.value == null) continue;
      if (typeof entry.value !== 'object' || Array.isArray(entry.value)) return null;
      // One strict projection both validates every unknown nested field and
      // captures every identity field. The plain-record projection observes
      // the prototype and each known descriptor once, so a stateful Proxy
      // cannot change container kind or hide an authority field between walks.
      const projection = digester.projectPlain(entry.value, NO_SKIPPED_KEYS, IDENTITY_FIELD_KEYS);
      if (projection.values == null) return null;
      snapshots.push(projection.values);
    }
  } catch {
    return null;
  }
  return snapshots;
}

function field(candidate, ...names) {
  for (const name of names) {
    const property = ownDataProperty(candidate, name);
    if (property.malformed) return null;
    if (typeof property.value === 'string' && property.value.trim()) return property.value;
  }
  return null;
}

function hasMalformedIdentityFields(candidate) {
  if (candidate == null) return false;
  if (typeof candidate !== 'object' || Array.isArray(candidate)) return true;
  const aliases = [
    ['binaryId'], ['functionId'], ['snapshotId'], ['semanticIrId', 'semanticIRId'],
    ['ssaId'], ['analyzerVersion'], ['semanticSchemaVersion'],
    ['semanticIrShapeDigest', 'semanticIRShapeDigest', 'irShapeDigest', 'canonicalIrDigest', 'shapeDigest'],
  ];
  try {
    for (const names of aliases) {
      let selected = null;
      for (const name of names) {
        const property = ownDataProperty(candidate, name);
        if (!property.present) continue;
        if (property.malformed) return true;
        if (typeof property.value !== 'string' || !property.value.trim()) return true;
        if (selected != null && selected !== property.value) return true;
        selected = property.value;
      }
    }
    return false;
  } catch {
    return true;
  }
}

function sameKnownSourceFields(identity, source) {
  if (source == null || typeof source !== 'object' || Array.isArray(source)) return true;
  for (const name of REQUIRED_FIELDS) {
    const observed = field(source, name, name === 'semanticIrId' ? 'semanticIRId' : name);
    if (observed != null && observed !== identity[name]) return false;
  }
  return true;
}

function sourcesAgreeOnField(sources, ...names) {
  const expected = firstSourceField(sources, ...names);
  return sources.every((source) => {
    const observed = field(source, ...names);
    return observed == null || expected == null || observed === expected;
  });
}

function firstSourceField(sources, ...names) {
  for (const source of sources) {
    const value = field(source, ...names);
    if (value != null) return value;
  }
  return null;
}

function shapeBinding(source) {
  return field(source, 'semanticIrShapeDigest', 'semanticIRShapeDigest', 'irShapeDigest', 'canonicalIrDigest', 'shapeDigest');
}

function sourceIsBoundToShape(source, identity, shapeDigest, values, graphDigester = null) {
  if (source == null || typeof source !== 'object' || Array.isArray(source)) return true;
  const explicitBinding = shapeBinding(source);
  if (explicitBinding != null) return explicitBinding === shapeDigest;
  const suppliedSemantic = field(source, 'semanticIrId', 'semanticIRId');
  const suppliedSsa = field(source, 'ssaId');
  // Partial identity metadata is useful (for example a loader can know the
  // binary and snapshot before SSA exists).  Once a caller supplies semantic
  // or SSA IDs, however, accepting an arbitrary string would let a result from
  // another IR be laundered into this one.  The fallback IDs are deliberately
  // shape-bound and provide the deterministic proof when no upstream digest is
  // available.
  if (suppliedSemantic != null) {
    const expectedSemantic = `semantic-ir:${stableDigest({
      snapshotId: identity.snapshotId,
      functionId: identity.functionId,
      shapeDigest,
    })}`;
    if (suppliedSemantic !== expectedSemantic) return false;
  }
  if (suppliedSsa != null) {
    const expectedSemantic = suppliedSemantic ?? `semantic-ir:${stableDigest({
      snapshotId: identity.snapshotId,
      functionId: identity.functionId,
      shapeDigest,
    })}`;
    const expectedSsa = `ssa:${ssaIdentityDigest(expectedSemantic, values, graphDigester)}`;
    if (suppliedSsa !== expectedSsa) return false;
  }
  return true;
}

function ssaIdentityDigest(semanticIrId, values, graphDigester = null) {
  try { return fastJsonGraphDigest({ semanticIrId, values }, graphDigester); }
  catch { return null; }
}

function validatedIdentitySnapshot(identity, workBudget = null) {
  if (identity == null || typeof identity !== 'object' || Array.isArray(identity)) return null;
  const budget = workBudget ?? createIdentityWorkBudget();
  const fields = [];
  for (const name of REQUIRED_FIELDS) {
    budget.consume(1);
    const property = ownDataProperty(identity, name);
    if (property.malformed || typeof property.value !== 'string') return null;
    budget.consumeText(property.value);
    if (!property.value.trim()) return null;
    fields.push(property.value);
  }
  let shapeDigest = null;
  for (const name of IDENTITY_BINDING_KEYS) {
    budget.consume(1);
    const property = ownDataProperty(identity, name);
    if (!property.present) continue;
    if (property.malformed || typeof property.value !== 'string') return null;
    budget.consumeText(property.value);
    if (!property.value.trim()) return null;
    if (shapeDigest != null && shapeDigest !== property.value) return null;
    shapeDigest = property.value;
  }
  return { fields, shapeDigest };
}

export function isValidatedAnalysisIdentity(identity) {
  try { return validatedIdentitySnapshot(identity) != null; }
  catch { return false; }
}

export function analysisIdentityMatches(observed, expected) {
  try {
    const workBudget = createIdentityWorkBudget();
    const observedValues = validatedIdentitySnapshot(observed, workBudget);
    const expectedValues = validatedIdentitySnapshot(expected, workBudget);
    if (observedValues == null || expectedValues == null) return false;
    return observedValues.shapeDigest === expectedValues.shapeDigest
      && observedValues.fields.every((value, index) => value === expectedValues.fields[index]);
  } catch {
    return false;
  }
}

/**
 * Resolve a validated identity from canonical IR metadata.  Existing fixtures
 * often carry no binary loader IDs, so the fallback is a deterministic digest
 * of the IR shape, never a wall-clock or architecture-name guess.
 */
export function canonicalAnalysisIdentity(context = {}) {
  const workBudget = createIdentityWorkBudget();
  const seededCfg = context?.analysis?.get?.('cfg') ?? null;
  const seededSsa = context?.analysis?.get?.('ssa') ?? null;
  const seededOrigins = context?.analysis?.get?.('origins') ?? null;
  const rawIr = context?.ir ?? (seededCfg != null || seededSsa != null ? {
    blocks: seededCfg?.blocks ?? [],
    entry: seededCfg?.entry ?? null,
    values: seededSsa?.values ?? [],
    origin: seededOrigins?.functionOrigin ?? null,
  } : null);
  let ir;
  try {
    ir = isPhase8SemanticSnapshot(rawIr)
      ? rawIr : capturePhase8SemanticSnapshotWithBudget(rawIr, workBudget);
  } catch {
    return { identity: null, valid: false, reason: 'canonical Semantic IR snapshot is unavailable' };
  }
  const contextSourceEntries = identitySourceEntries(context);
  if (explicitlyMissingIdentity(contextSourceEntries)) return { identity: null, valid: false, reason: 'analysis identity is null' };
  const contextIdentitySources = identitySourceSnapshots(contextSourceEntries, workBudget);
  if (contextIdentitySources == null || contextIdentitySources.some(hasMalformedIdentityFields)) {
    return { identity: null, valid: false, reason: 'analysis identity is malformed' };
  }
  const shaped = irShape(ir, workBudget);
  if (shaped == null) return { identity: null, valid: false, reason: 'canonical Semantic IR identity is unavailable' };
  const {
    values, sourceValues, graphDigester,
  } = shaped;
  const rootSourceEntries = identitySourceEntriesFromSnapshot(ir, sourceValues);
  if (explicitlyMissingIdentity(rootSourceEntries)) return { identity: null, valid: false, reason: 'analysis identity is null' };
  const rootIdentitySources = identitySourceSnapshots(rootSourceEntries, workBudget);
  if (rootIdentitySources == null || rootIdentitySources.some(hasMalformedIdentityFields)) {
    return { identity: null, valid: false, reason: 'analysis identity is malformed' };
  }
  if (hasMalformedIdentityFields(sourceValues)) {
    return { identity: null, valid: false, reason: 'analysis identity is malformed' };
  }
  const sources = [...contextIdentitySources, ...rootIdentitySources, sourceValues];
  // `shape` is a private call-local Merkle reference assembled above. Ask the
  // same digester for its 128-bit spelling; malformed values fail closed
  // instead of falling back to a lossy alternate representation.
  const shapeDigest = irShapeDigest(shaped);
  if (shapeDigest == null) return { identity: null, valid: false, reason: 'canonical Semantic IR identity is unavailable' };
  const functionId = firstSourceField(sources, 'functionId') ?? `function:${shapeDigest}`;
  const binaryId = firstSourceField(sources, 'binaryId') ?? `binary:${stableDigest({ functionId, shapeDigest })}`;
  const snapshotId = firstSourceField(sources, 'snapshotId') ?? `snapshot:${stableDigest({ binaryId, functionId, shapeDigest })}`;
  const semanticIrId = firstSourceField(sources, 'semanticIrId', 'semanticIRId')
    ?? `semantic-ir:${stableDigest({ snapshotId, functionId, shapeDigest })}`;
  const computedSsaDigest = ssaIdentityDigest(semanticIrId, values, graphDigester);
  if (computedSsaDigest == null) return { identity: null, valid: false, reason: 'canonical SSA identity is unavailable' };
  const ssaId = firstSourceField(sources, 'ssaId')
    ?? `ssa:${computedSsaDigest}`;
  const analyzerVersion = firstSourceField(sources, 'analyzerVersion')
    ?? ANALYSIS_IDENTITY_VERSION;
  const identity = Object.freeze({
    binaryId, functionId, snapshotId, semanticIrId, ssaId, analyzerVersion, shapeDigest,
  });
  if (!isValidatedAnalysisIdentity(identity)) return { identity: null, valid: false, reason: 'analysis identity fields are invalid' };
  if (!sourcesAgreeOnField(sources, 'semanticSchemaVersion')
      || !sources.every((source) => sameKnownSourceFields(identity, source))
      || !sources.every((source) => sourceIsBoundToShape(source, identity, shapeDigest, values, graphDigester))) {
    return { identity: null, valid: false, reason: 'analysis identity is stale for the Semantic IR' };
  }
  return { identity, valid: true, reason: null, semanticSnapshot:ir };
}

export { REQUIRED_FIELDS as ANALYSIS_IDENTITY_FIELDS };
