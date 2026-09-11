import { IDENTITY_REUSE_BUDGETS as REUSE } from '../../core/identity/reuse-budgets.js';
import { BoundedWeakCache, BoundedWeakMetadata } from '../../core/identity/bounded-weak-cache.js';
/**
 * Canonical identity for Phase 8 analysis products.
 *
 * A scalar artifact is only useful for the exact Semantic IR/SSA snapshot that
 * produced it.  This module owns the small identity boundary shared by SCCP,
 * GVN and induction; consumers do not invent a second stale-result check.
 */

import { stableDigest } from '../../core/identity/index.js';
import { isKnownImmutableData, ordinaryJsonBehavior, ordinaryHashBehavior } from '../../core/identity/immutable-data.js';

const REQUIRED_FIELDS = Object.freeze([
  'binaryId', 'functionId', 'snapshotId', 'semanticIrId', 'ssaId', 'analyzerVersion',
]);

function token(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    // Reserve the scalar tags used for non-string IDs so a string such as
    // `bigint:1` cannot alias the canonical identity of 1n.
    return /^(?:bigint|number):/.test(text) ? `string:${text}` : text;
  }
  if (typeof value === 'bigint') return `bigint:${value}`;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? `number:${Object.is(value, -0) ? '-0' : value}` : null;
  if (value == null) return null;
  try {
    // IDs are occasionally represented by structured scalar handles. Use the
    // same collision-free typed encoding as the semantic graph; the generic
    // JSON digest would collapse null, NaN and Infinity into one spelling.
    return `id:${fastJsonGraphDigest(value)}`;
  } catch {
    return null;
  }
}

const NON_SEMANTIC_KEYS = new Set(['dst', 'uses']);
const NO_SKIPPED_KEYS = new Set();
const DEEPLY_FROZEN_CACHE = new BoundedWeakMetadata(REUSE.frozenMetadataEntries);
// Values in the existing validator's true-cache have only deeply immutable
// own data properties (no Map/Set/Date/accessor children). Keep their exact
// typed spelling weakly, and cap individual entries to avoid retaining giant
// strings beside large live graphs. Mutable/unvalidated data always re-encodes.
const FROZEN_IDENTITY_TEXT = new BoundedWeakCache(REUSE.frozenIdentityText.entries, REUSE.frozenIdentityText.bytes);
const MAX_CACHED_IDENTITY_TEXT = REUSE.frozenIdentityText.maxTextLength;

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
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor == null || !('value' in descriptor) || !descriptor.enumerable) {
      throw new TypeError('identity-unsupported-semantic-descriptor');
    }
    keys.push(key);
  }
  return keys;
}

function arrayIndexKey(key) {
  if (!/^(?:0|[1-9]\d*)$/.test(key)) return false;
  const number = Number(key);
  return Number.isSafeInteger(number) && number >= 0 && number < 0xffffffff && String(number) === key;
}

// The legacy projection keeps several indexes and compatibility views beside
// the canonical block/value graph.  They either contain back references to
// that graph (`instructions`, `args`, `byRow`, `locations`) or executable
// helpers (`defUse`), so walking them as semantic input would reject every
// product IR as cyclic/unsupported.  Their semantic content is represented by
// the block, instruction, value and origin shapes below; hashing the indexes a
// second time would also make identity depend on derived bookkeeping.
const DERIVED_IR_KEYS = new Set([
  'blocks', 'values', 'instructions', 'locations', 'byRow', 'args', 'reachable',
  'idom', 'dominators', 'ipdom', 'postDominators', 'stackSlots', 'loops', 'backEdges',
  'defUse', '_unknownStoreBarriers', '_branchConstraints', 'compat', 'memorySafety',
  'origin', ...NON_SEMANTIC_KEYS,
]);

// OriginSets produced by the canonical provenance owner are immutable data
// graphs.  Treat only a genuinely deeply-frozen plain graph as eligible for
// the origin table below: Object.freeze({ ids: [] }) is not enough because the
// nested array could still be changed after an identity was issued.  Rejecting
// accessors and host containers also keeps hostile metadata on the strict path.
function deeplyFrozen(value, active = new Set()) {
  if (value == null || ['string', 'boolean', 'number', 'bigint'].includes(typeof value)) return true;
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return false;
  if (isKnownImmutableData(value)) return true;
  const cached = DEEPLY_FROZEN_CACHE.get(value);
  if (cached != null) return cached;
  if (!Object.isFrozen(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  if (active.has(value)) return false;
  active.add(value);
  let result = true;
  try {
    for (const key of semanticOwnKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor == null || !('value' in descriptor) || !deeplyFrozen(descriptor.value, active)) {
        result = false;
        break;
      }
    }
  } catch {
    result = false;
  }
  active.delete(value);
  if (result) DEEPLY_FROZEN_CACHE.set(value, true);
  return result;
}

function fastJsonTextDigest(text) {
  let hash0 = 0x811c9dc5;
  let hash1 = 0x9e3779b9;
  let hash2 = 0x243f6a88;
  let hash3 = 0xb7e15162;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    hash0 = Math.imul(hash0 ^ code, 0x01000193) >>> 0;
    hash1 = Math.imul(hash1 ^ code, 0x85ebca6b) >>> 0;
    hash2 = Math.imul(hash2 ^ code, 0xc2b2ae35) >>> 0;
    hash3 = Math.imul(hash3 ^ code, 0x27d4eb2f) >>> 0;
  }
  return [hash0, hash1, hash2, hash3].map((hash) => hash.toString(16).padStart(8, '0')).join('');
}

// Every element is already accepted by deeplyFrozen() in semanticDigest.
// The table is private and ordered: a weak trie keys the full exact sequence,
// not a hash of hashes, so the digest spelling and collision domain are intact.
// No mutable metadata, partial table or failed encoding is ever memoized.
let ORIGIN_TABLE_DIGESTS = new WeakMap();
let originTableNodes = 0;
const MAX_ORIGIN_TABLE_NODES = REUSE.originTableNodes;
let emptyOriginTableDigest;
function fastFrozenOriginDigest(value) {
  if (!ordinaryJsonBehavior() || !ordinaryHashBehavior()) return fastJsonGraphDigest(value);
  if (value.length === 0) return emptyOriginTableDigest ??= fastJsonGraphDigest(value);
  // This trie is a disposable hint, never identity authority. Bound even its
  // weak-key bookkeeping while many origins stay live. Oversized sequences
  // use the exact encoder without entering the cache.
  if (value.length > MAX_ORIGIN_TABLE_NODES) return fastJsonGraphDigest(value);
  if (originTableNodes + value.length > MAX_ORIGIN_TABLE_NODES) {
    ORIGIN_TABLE_DIGESTS = new WeakMap();
    originTableNodes = 0;
  }
  let table = ORIGIN_TABLE_DIGESTS, node;
  for (const origin of value) {
    node = table.get(origin);
    if (node === undefined) {
      node = { next: new WeakMap(), digest: undefined };
      table.set(origin, node);
      originTableNodes++;
    }
    table = node.next;
  }
  if (node.digest !== undefined) return node.digest;
  const digest = fastJsonGraphDigest(value);
  if (ordinaryJsonBehavior() && ordinaryHashBehavior()) node.digest = digest;
  return digest;
}

function canonicalSortText(value) {
  // Sorting by the complete typed representation keeps semantically equivalent
  // Maps/Sets independent of insertion order even when two values happen to
  // share the short diagnostic digest used elsewhere in the identity.
  return typedIdentityText(value);
}

/**
 * Detached shape graphs have already been constructed by this module. The
 * projection validates caller descriptors and tracks raw scalar/array escapes;
 * escaped shapes stay on the original strict encoder. Private projections can
 * encode each shared subgraph once, preserving holes and custom array fields. This spelling is byte-for-byte
 * the strict encoder's format, NOT a new hash domain or identity definition.
 */
function createPassiveTextCache() {
  return { values: new WeakMap(), payloadBytes: 0, entryCount: 0 };
}

function typedPassiveIdentityText(root, texts = createPassiveTextCache()) {
  // Only detached, privately constructed projections reach this encoder. Its
  // own enumerable properties were already checked by semanticObject; unlike
  // public metadata, no getter or caller-owned object is traversed here.
  const visit = (value) => {
    if (value === null) return 'null;';
    switch (typeof value) {
      case 'undefined': return 'undefined;';
      case 'string': return `string:${value.length}:${value};`;
      case 'boolean': return value ? 'boolean:1;' : 'boolean:0;';
      case 'number':
        if (!Number.isFinite(value)) throw new TypeError('identity-non-finite-number');
        return `number:${Object.is(value, -0) ? '-0' : String(value)};`;
      case 'bigint': return `bigint:${value};`;
      case 'function':
      case 'symbol': throw new TypeError('identity-invalid-semantic-metadata');
      default: break;
    }
    const cached = texts.values.get(value);
    if (cached !== undefined) return cached;
    let text;
    if (Array.isArray(value)) {
      const keys = Object.keys(value), length = value.length;
      // Integer array keys precede every custom property. Equal cardinality
      // and a final length-1 key prove the dense case, without a hasOwn/regex
      // check for every element. Sparse/custom arrays retain the full format.
      const dense = keys.length === length && (length === 0 || keys[length - 1] === String(length - 1));
      let items = '';
      if (dense) {
        for (let index = 0; index < length; index++) items += visit(value[index]);
      } else {
        for (let index = 0; index < length; index++) items += Object.hasOwn(value, index) ? visit(value[index]) : 'hole;';
      }
      text = `array:${length}[${items}]`;
      const properties = dense ? [] : keys.filter((key) => !arrayIndexKey(key)).sort();
      if (properties.length) {
        let props = '';
        for (const key of properties) props += `key:${key.length}:${key};${visit(value[key])}`;
        text += `properties:${properties.length}{${props}}`;
      }
    } else {
      const keys = Object.keys(value).sort();
      let items = '';
      for (const key of keys) items += `key:${key.length}:${key};${visit(value[key])}`;
      text = `object:${keys.length}{${items}}`;
    }
    // Bound the entire shared shape/SSA encoding call, not just each entry.
    // A chain of individually small subtrees must not retain quadratic text.
    const weight = text.length * 2;
    if (weight <= REUSE.passiveText.maxEntryBytes && texts.payloadBytes + weight <= REUSE.passiveText.bytes
      && texts.entryCount < REUSE.passiveText.entries) {
      texts.values.set(value, text);
      texts.payloadBytes += weight;
      texts.entryCount++;
    }
    return text;
  };
  return visit(root);
}

function typedIdentityText(root, privateShape = false, sharedTexts = null) {
  if (privateShape && ordinaryJsonBehavior() && ordinaryHashBehavior()) {
    return typedPassiveIdentityText(root, sharedTexts ?? createPassiveTextCache());
  }
  const active = new Set();
  const visit = (value) => {
    if (value != null && typeof value === 'object'
      && (DEEPLY_FROZEN_CACHE.get(value) === true || isKnownImmutableData(value))) {
      if (active.has(value)) throw new TypeError('identity-cyclic-semantic-metadata');
      const cached = FROZEN_IDENTITY_TEXT.get(value);
      if (cached !== undefined) return cached;
      const text = encode(value);
      if (text.length <= MAX_CACHED_IDENTITY_TEXT) FROZEN_IDENTITY_TEXT.set(value, text, text.length * 2);
      return text;
    }
    return encode(value);
  };
  const encode = (value) => {
    if (value === null) return 'null;';
    switch (typeof value) {
      case 'undefined':
        return 'undefined;';
      case 'function':
      case 'symbol':
        throw new TypeError('identity-invalid-semantic-metadata');
      case 'string': return `string:${value.length}:${value};`;
      case 'boolean': return value ? 'boolean:1;' : 'boolean:0;';
      case 'number': {
        if (!Number.isFinite(value)) throw new TypeError('identity-non-finite-number');
        return `number:${Object.is(value, -0) ? '-0' : String(value)};`;
      }
      case 'bigint': return `bigint:${value};`;
      default: break;
    }
    if (active.has(value)) throw new TypeError('identity-cyclic-semantic-metadata');
    active.add(value);
    try {
      const keys = semanticOwnKeys(value);
      const properties = (propertyKeys) => propertyKeys.length === 0 ? '' : `properties:${propertyKeys.length}{${propertyKeys.sort()
        .map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          return `key:${key.length}:${key};${visit(descriptor.value)}`;
        }).join('')}}`;
      if (Array.isArray(value)) {
        const ownKeys = new Set(keys);
        let items = '';
        for (let index = 0; index < value.length; index += 1) {
          const key = String(index);
          items += ownKeys.has(key) ? visit(Object.getOwnPropertyDescriptor(value, key).value) : 'hole;';
        }
        return `array:${value.length}[${items}]${properties(keys.filter((key) => !arrayIndexKey(key)))}`;
      }
      if (value instanceof Map) {
        const entries = [...value.entries()]
          .map(([key, item]) => `${visit(key)}=>${visit(item)}`)
          .sort();
        return `map:${entries.length}{${entries.join('')}}${properties(keys)}`;
      }
      if (value instanceof Set) {
        const values = [...value.values()].map(visit).sort();
        return `set:${values.length}{${values.join('')}}${properties(keys)}`;
      }
      if (value instanceof Date) {
        const iso = value.toISOString();
        return `date:${iso.length}:${iso};${properties(keys)}`;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('identity-unsupported-semantic-metadata');
      }
      const sortedKeys = keys.sort();
      return `object:${sortedKeys.length}{${sortedKeys.map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return `key:${key.length}:${key};${visit(descriptor.value)}`;
      }).join('')}}`;
    } finally {
      active.delete(value);
    }
  };
  return visit(root);
}

const IMMUTABLE_GRAPH_DIGESTS = new BoundedWeakCache(REUSE.graphDigest.entries, REUSE.graphDigest.bytes);
function fastJsonGraphDigest(value, privateShape = false, sharedTexts = null) {
  // Reuse the exact typed digest only for previously certified immutable
  // own-data graphs. Mutable legacy shapes still re-encode on every request.
  const reusable = isKnownImmutableData(value) && ordinaryJsonBehavior() && ordinaryHashBehavior();
  if (reusable) {
    const cached = IMMUTABLE_GRAPH_DIGESTS.get(value);
    if (cached !== undefined) return cached;
  }
  const digest = fastJsonTextDigest(typedIdentityText(value, privateShape, sharedTexts));
  if (reusable && ordinaryJsonBehavior() && ordinaryHashBehavior()) IMMUTABLE_GRAPH_DIGESTS.set(value, digest, digest.length * 2);
  return digest;
}

/**
 * Convert the parts of the IR that affect scalar semantics to a deterministic
 * acyclic value.  Definitions contain back references (`dst`) and values keep
 * use lists, so hashing an IR object directly either recurses forever or makes
 * an identity depend on analysis bookkeeping.  Everything else is retained;
 * silently dropping a new semantic field would make stale artifacts look
 * current.
 */
function semanticObject(value, seen = new Set(), skip = NO_SKIPPED_KEYS, path = '$', memo = null) {
  if (value === null || typeof value === 'undefined' || typeof value === 'string' || typeof value === 'boolean'
      || typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('identity-non-finite-number');
    return value;
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError('identity-non-semantic-value');
  }
  if (seen.has(value)) throw new TypeError(`identity-cyclic-semantic-ir:${path}`);
  // The same origin/metadata object is frequently referenced by a value, its
  // definition and its containing instruction.  Reusing only the immutable
  // per-call canonical copy avoids an O(n²) walk while still rebuilding the
  // memo on every identity request, so mutations between requests are seen.
  const memoizable = memo != null && skip === NO_SKIPPED_KEYS;
  if (memoizable && memo.has(value)) return memo.get(value);
  seen.add(value);
  const ownKeys = semanticOwnKeys(value);
  const semanticProperties = (keys, propertyPath = path) => {
    const properties = Object.create(null);
    for (const key of keys.sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      properties[key] = semanticObject(descriptor.value, seen, NO_SKIPPED_KEYS, `${propertyPath}.${key}`, memo);
    }
    return properties;
  };
  let result;
  if (Array.isArray(value)) {
    result = [];
    result.length = value.length;
    for (const key of ownKeys.sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      Object.defineProperty(result, key, {
        value: semanticObject(descriptor.value, seen, NO_SKIPPED_KEYS,
          arrayIndexKey(key) ? `${path}[${Number(key)}]` : `${path}.${key}`, memo),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  } else if (value instanceof Map) {
    result = {
      type: 'Map',
      entries: [...value.entries()]
        .map(([key, item], index) => [
          semanticObject(key, seen, NO_SKIPPED_KEYS, `${path}.mapKey[${index}]`, memo),
          semanticObject(item, seen, NO_SKIPPED_KEYS, `${path}.mapValue[${index}]`, memo),
        ])
        .sort((left, right) => canonicalSortText(left).localeCompare(canonicalSortText(right))),
    };
    if (ownKeys.length > 0) result.properties = semanticProperties(ownKeys);
  } else if (value instanceof Set) {
    result = {
      type: 'Set',
      values: [...value.values()]
        .map((item, index) => semanticObject(item, seen, NO_SKIPPED_KEYS, `${path}.set[${index}]`, memo))
        .sort((left, right) => canonicalSortText(left).localeCompare(canonicalSortText(right))),
    };
    if (ownKeys.length > 0) result.properties = semanticProperties(ownKeys);
  } else if (value instanceof Date) {
    result = { type: 'Date', value: value.toISOString() };
    if (ownKeys.length > 0) result.properties = semanticProperties(ownKeys);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('identity-unsupported-semantic-metadata');
    }
    result = Object.create(null);
    for (const key of ownKeys.sort()) {
      if (skip.has(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      // A skip list describes this known wrapper object only.  Applying it to
      // nested `extra`/metadata objects would silently erase a semantic field
      // whose name happens to be `uses` or `dst`.
      result[key] = semanticObject(descriptor.value, seen, NO_SKIPPED_KEYS, `${path}.${key}`, memo);
    }
  }
  seen.delete(value);
  if (memoizable) memo.set(value, result);
  return result;
}

function metadataProjection(value, skip, path, memo) {
  if (value == null || typeof value !== 'object') return null;
  const projection = semanticObject(value, new Set(), skip, path, memo);
  return Object.keys(projection).length === 0 ? null : projection;
}

function semanticDigest(value, memo, digests, path, trustedFrozen = false) {
  if (value == null) return null;
  // Canonical origins are immutable.  Keep one deterministic reference per
  // unique origin during this walk and hash the complete table once at the end
  // of `irShape`; hashing each large provenance record at every use made loop
  // functions miss the fixed Phase 8 deadline.
  if (trustedFrozen && typeof value === 'object' && deeplyFrozen(value) && digests?.originRefs != null) {
    const existing = digests.originRefs.get(value);
    if (existing != null) return `origin:${existing}`;
    const index = digests.originValues.length;
    digests.originRefs.set(value, index);
    digests.originValues.push(value);
    return `origin:${index}`;
  }
  if (typeof value === 'object') {
    const cached = digests.get(value);
    if (cached != null) return cached;
    // Ordinary Phase 8 metadata (`extra`, effect summaries, and proofs) is a
    // plain graph in the canonical IR.  Hashing it directly keeps the strict
    // rejection behavior while avoiding an intermediate semantic copy and the
    // JSON-safe allocation that made large loop functions miss their budget.
    try {
      const digest = `metadata:${fastJsonGraphDigest(value)}`;
      digests.set(value, digest);
      return digest;
    } catch {
      // Maps/Sets/host objects use the generic semantic projection below.
    }
  }
  // Canonical OriginSets are validated and deeply frozen by the producer.  A
  // direct digest avoids first copying several megabytes of repeated
  // provenance arrays on large functions.  Untrusted/mutable metadata still
  // takes the strict semantic walk, which rejects functions, symbols and
  // cycles instead of letting jsonSafe erase them.
  const canonical = trustedFrozen && typeof value === 'object' && Object.isFrozen(value)
    ? value : semanticObject(value, new Set(), NO_SKIPPED_KEYS, path, memo);
  const digest = stableDigest(canonical);
  if (typeof value === 'object') digests.set(value, digest);
  return digest;
}

// Only private projections with no raw object-valued scalar escape can share
// encodings between shape and SSA hashing inside this one identity request.
// There is no cross-request cache of mutable legacy IR.
const DETACHED_SHAPES = new WeakSet();
const SHAPE_ARRAY_MAP = Array.prototype.map;
function shapeArrayMap(array, digests) {
  // Read the method at the original evaluation point exactly once. A Proxy
  // can replace .map without exposing an own descriptor; never treat that
  // caller's result as a detached private projection.
  const method = array.map;
  if (method !== SHAPE_ARRAY_MAP) digests.detached = false;
  return (callback) => Reflect.apply(method, array, [callback]);
}
function scalarShape(value, digests) {
  if (value !== null && typeof value === 'object') digests.detached = false;
  return value;
}
function checkShapeArrays(record, keys, digests) {
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor && !Object.hasOwn(descriptor, 'value')) { digests.detached = false; continue; }
    const value = descriptor?.value;
    if (Array.isArray(value) && (Object.getPrototypeOf(value) !== Array.prototype
      || Object.hasOwn(value, 'map') || Object.hasOwn(value, 'constructor'))) digests.detached = false;
  }
}


// Static private projection field sets; no allocation per entity.
const ARGUMENT_SHAPE_FIELDS = new Set(['value', 'origin', ...NON_SEMANTIC_KEYS]);
const INCOMING_SHAPE_FIELDS = new Set(['value', 'origin', ...NON_SEMANTIC_KEYS]);
const MEMORY_NODE_SHAPE_FIELDS = new Set([
    'kind', 'key', 'definitionId', 'regionId', 'block', 'reason', 'unknownAlias', 'aliasRelation',
    'inst', 'prev', 'previous', 'incoming', 'effectSummary', 'proof', 'origin',
  ]);
const MEMORY_LOCATION_SHAPE_FIELDS = new Set([
    'key', 'kind', 'size', 'regionId', 'base', 'index', 'scale', 'address', 'disp',
    'uncertaintyIdentity', 'origin',
  ]);
const ADDRESS_BASE_INDEX_FIELDS = new Set(['base', 'index']);
const VALUE_SHAPE_FIELDS = new Set([
    'id', 'bits', 'kind', 'signed', 'const', 'origin', 'def', 'uses',
  ]);
const BLOCK_SHAPE_FIELDS = new Set(['insts', 'phis', 'memPhis', 'successorEdges', 'succ', 'pred', 'origin', ...NON_SEMANTIC_KEYS]);

function argumentShape(argument, memo, digests) {
  if (argument == null || typeof argument !== 'object') return { valueId: token(argument) };
  const shape = semanticObject(argument, new Set(), ARGUMENT_SHAPE_FIELDS, '$.argument', memo);
  shape.valueId = token(argument.value?.id ?? argument.id);
  shape.originDigest = semanticDigest(argument.origin, memo, digests, '$.argument.origin', true);
  return shape;
}

function incomingShape(incoming, memo, digests) {
  if (incoming == null || typeof incoming !== 'object') return { valueId: token(incoming) };
  const shape = semanticObject(incoming, new Set(), INCOMING_SHAPE_FIELDS, '$.incoming', memo);
  shape.valueId = token(incoming.value?.id ?? incoming.id);
  shape.originDigest = semanticDigest(incoming.origin, memo, digests, '$.incoming.origin', true);
  return shape;
}

// MemorySSA nodes are part of the projected IR, but their `prev`, `incoming`
// and `inst` fields point back into the same graph.  Keep the semantic keys and
// reference IDs while deliberately omitting those object edges; otherwise a
// valid loop with a memory phi is mistaken for malformed cyclic IR.
function memoryNodeShape(node, memo, digests) {
  if (node == null || typeof node !== 'object') return node ?? null;
  checkShapeArrays(node, ['previous', 'incoming'], digests);
  const shape = {
    kind: scalarShape(node.kind ?? null, digests),
    key: scalarShape(node.key ?? null, digests),
    definitionId: token(node.definitionId),
    regionId: token(node.regionId),
    block: scalarShape(node.block ?? null, digests),
    reason: scalarShape(node.reason ?? null, digests),
    unknownAlias: scalarShape(node.unknownAlias ?? null, digests),
    aliasRelation: scalarShape(node.aliasRelation ?? null, digests),
    instructionId: token(node.inst?.instructionId ?? node.inst?.id),
    previousId: token(node.prev?.definitionId),
    previousIds: Array.isArray(node.previous) ? shapeArrayMap(node.previous, digests)((item) => token(item?.definitionId)) : null,
    incoming: Array.isArray(node.incoming) ? shapeArrayMap(node.incoming, digests)((item) => ({
      from: scalarShape(item?.from ?? null, digests),
      semanticPredecessorBlockId: token(item?.semanticPredecessorBlockId),
      definitionId: token(item?.node?.definitionId ?? item?.definitionId),
    })) : null,
    effectSummaryDigest: semanticDigest(node.effectSummary, memo, digests, '$.memory.effectSummary'),
    proofDigest: semanticDigest(node.proof, memo, digests, '$.memory.proof'),
    originDigest: semanticDigest(node.origin, memo, digests, '$.memory.origin', true),
  };
  const metadata = metadataProjection(node, MEMORY_NODE_SHAPE_FIELDS, '$.memory.metadata', memo);
  if (metadata != null) shape.metadata = metadata;
  return shape;
}

function memoryLocationShape(location, memo, digests) {
  if (location == null || typeof location !== 'object') return location ?? null;
  const shape = {
    key: scalarShape(location.key ?? null, digests),
    kind: scalarShape(location.kind ?? null, digests),
    size: scalarShape(location.size ?? null, digests),
    regionId: token(location.regionId),
    baseId: token(location.base?.id ?? location.base),
    indexId: token(location.index?.id ?? location.index),
    scale: scalarShape(location.scale ?? null, digests),
    address: location.address == null ? null : semanticObject(location.address, new Set(), NO_SKIPPED_KEYS, '$.memory.address', memo),
    disp: location.disp == null ? null : semanticObject(location.disp, new Set(), NO_SKIPPED_KEYS, '$.memory.disp', memo),
    uncertaintyIdentityDigest: semanticDigest(location.uncertaintyIdentity, memo, digests, '$.memory.uncertainty'),
    originDigest: semanticDigest(location.origin, memo, digests, '$.memory.location.origin', true),
  };
  const metadata = metadataProjection(location, MEMORY_LOCATION_SHAPE_FIELDS, '$.memory.location.metadata', memo);
  if (metadata != null) shape.metadata = metadata;
  return shape;
}

function definitionShape(definition, extraSkip = [], memo = null, digests = null, definitionCache = null) {
  if (definition == null || typeof definition !== 'object') return null;
  checkShapeArrays(definition, ['args', 'incoming', 'memDefs', 'memKills'], digests);
  const cacheKey = extraSkip.length === 0 ? '' : [...extraSkip].sort().join('\u0000');
  const cached = definitionCache?.get(definition)?.get(cacheKey);
  if (cached != null) return cached;
  const shape = semanticObject(definition, new Set(), new Set([
    'args', 'incoming', 'addr', 'loc', 'conditionValue', 'selectorValue', 'extra', 'origin',
    'memUse', 'memDef', 'memDefs', 'memKills', 'reachingStore', 'unknownAliasBarrier',
    ...NON_SEMANTIC_KEYS, ...extraSkip,
  ]), '$.definition', memo);
  shape.args = Array.isArray(definition.args) ? shapeArrayMap(definition.args, digests)((argument) => argumentShape(argument, memo, digests)) : null;
  shape.incoming = Array.isArray(definition.incoming)
    ? shapeArrayMap(definition.incoming, digests)((incoming) => incomingShape(incoming, memo, digests)) : null;
  shape.addr = definition.addr == null
    ? null : semanticObject(definition.addr, new Set(), ADDRESS_BASE_INDEX_FIELDS, '$.definition.addr', memo);
  shape.addrBaseId = token(definition.addr?.base?.id ?? definition.addr?.base);
  shape.addrIndexId = token(definition.addr?.index?.id ?? definition.addr?.index);
  shape.conditionValueId = token(definition.conditionValue?.id);
  shape.selectorValueId = token(definition.selectorValue?.id);
  shape.extraDigest = semanticDigest(definition.extra, memo, digests, '$.definition.extra');
  shape.originDigest = semanticDigest(definition.origin, memo, digests, '$.definition.origin', true);
  shape.location = memoryLocationShape(definition.loc, memo, digests);
  shape.memoryUse = memoryNodeShape(definition.memUse, memo, digests);
  shape.memoryDef = memoryNodeShape(definition.memDef, memo, digests);
  shape.memoryDefs = Array.isArray(definition.memDefs)
    ? shapeArrayMap(definition.memDefs, digests)((node) => memoryNodeShape(node, memo, digests)) : null;
  shape.memoryKills = Array.isArray(definition.memKills)
    ? shapeArrayMap(definition.memKills, digests)((location) => memoryLocationShape(location, memo, digests)) : null;
  shape.reachingStoreId = token(definition.reachingStore?.instructionId ?? definition.reachingStore?.id);
  shape.unknownAliasBarrierId = token(definition.unknownAliasBarrier?.instructionId ?? definition.unknownAliasBarrier?.id);
  if (definitionCache != null) {
    const entries = definitionCache.get(definition) ?? new Map();
    entries.set(cacheKey, shape);
    definitionCache.set(definition, entries);
  }
  return shape;
}

function valueShape(value, memo, digests, definitionCache) {
  if (value == null || typeof value !== 'object') return value ?? null;
  const shape = {
    id: token(value.id),
    bits: scalarShape(value.bits ?? null, digests),
    kind: scalarShape(value.kind ?? null, digests),
    signed: scalarShape(value.signed ?? null, digests),
    constant: scalarShape(value.const ?? null, digests),
    originDigest: semanticDigest(value.origin, memo, digests, '$.value.origin', true),
    definition: definitionShape(value.def, [], memo, digests, definitionCache),
  };
  const metadata = metadataProjection(value, VALUE_SHAPE_FIELDS, '$.value.metadata', memo);
  if (metadata != null) shape.metadata = metadata;
  return shape;
}

function instructionShape(instruction, memo, digests, definitionCache) {
  if (instruction == null || typeof instruction !== 'object') return instruction ?? null;
  const shape = definitionShape(instruction, ['conditionValue', 'selectorValue'], memo, digests, definitionCache);
  return shape;
}

function blockShape(block, memo, digests, definitionCache) {
  if (block == null || typeof block !== 'object') return block ?? null;
  checkShapeArrays(block, ['succ', 'pred', 'successorEdges', 'insts', 'phis', 'memPhis'], digests);
  const shape = semanticObject(block, new Set(), BLOCK_SHAPE_FIELDS, '$.block', memo);
  shape.index = scalarShape(block.index ?? null, digests);
  shape.id = token(block.id);
  shape.succ = Array.isArray(block.succ) ? shapeArrayMap(block.succ, digests)(token) : null;
  shape.pred = Array.isArray(block.pred) ? shapeArrayMap(block.pred, digests)(token) : null;
  shape.successorEdges = Array.isArray(block.successorEdges)
    ? shapeArrayMap(block.successorEdges, digests)((edge) => semanticObject(edge, new Set(), NO_SKIPPED_KEYS, '$.block.successorEdge', memo)) : null;
  shape.insts = Array.isArray(block.insts)
    ? shapeArrayMap(block.insts, digests)((instruction) => instructionShape(instruction, memo, digests, definitionCache)) : null;
  shape.phis = Array.isArray(block.phis)
    ? shapeArrayMap(block.phis, digests)((definition) => definitionShape(definition, [], memo, digests, definitionCache)) : null;
  shape.memPhis = Array.isArray(block.memPhis)
    ? shapeArrayMap(block.memPhis, digests)((node) => memoryNodeShape(node, memo, digests)) : null;
  shape.originDigest = semanticDigest(block.origin, memo, digests, '$.block.origin', true);
  return shape;
}

function irShape(ir) {
  if (ir == null || typeof ir !== 'object') return null;
  try {
    const memo = new WeakMap();
    const digests = new WeakMap();
    digests.detached = true;
    checkShapeArrays(ir, ['blocks', 'values', 'instructions', 'backEdges', 'loops'], digests);
    digests.originRefs = new WeakMap();
    digests.originValues = [];
    const definitionCache = new WeakMap();
    const shape = semanticObject(ir, new Set(), DERIVED_IR_KEYS, '$', memo);
    shape.entry = token(ir.entry);
    shape.originDigest = semanticDigest(ir.origin, memo, digests, '$.origin', true);
    shape.blocks = Array.isArray(ir.blocks)
      ? shapeArrayMap(ir.blocks, digests)((block) => blockShape(block, memo, digests, definitionCache))
        .sort((left, right) => String(left.index).localeCompare(String(right.index))) : [];
    shape.values = Array.isArray(ir.values)
      ? shapeArrayMap(ir.values, digests)((value) => valueShape(value, memo, digests, definitionCache))
        .sort((left, right) => String(left.id).localeCompare(String(right.id))) : [];
    // Some canonical IR producers expose a flat instruction table in addition
    // to block-local `insts`. It is semantic input, not derived bookkeeping:
    // omitting it lets an in-place instruction mutation reuse a stale product.
    shape.instructions = ir.instructions == null
      ? null
      : Array.isArray(ir.instructions)
        ? shapeArrayMap(ir.instructions, digests)((instruction) => instructionShape(instruction, memo, digests, definitionCache))
        : semanticObject(ir.instructions, new Set(), NO_SKIPPED_KEYS, '$.instructions', memo);
    // Loop/back-edge facts are canonical upstream inputs to widening.  Keep
    // their scalar shape when present, while avoiding Maps/Sets used only as
    // derived lookup caches in graph products.
    shape.backEdges = Array.isArray(ir.backEdges)
      ? shapeArrayMap(ir.backEdges, digests)((edge) => semanticObject(edge, new Set(), NO_SKIPPED_KEYS, '$.backEdge', memo)) : [];
    shape.loops = Array.isArray(ir.loops)
      ? shapeArrayMap(ir.loops, digests)((loop) => semanticObject(loop, new Set(), NO_SKIPPED_KEYS, '$.loop', memo)) : [];
    try {
      shape.originTableDigest = `origin-table:${fastFrozenOriginDigest(digests.originValues)}`;
    } catch {
      return null;
    }
    if (digests.detached) DETACHED_SHAPES.add(shape);
    return shape;
  } catch {
    return null;
  }
}

const IDENTITY_SOURCE_KEYS = Object.freeze(['analysisIdentity', 'identity', 'artifactIdentity']);

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

function identitySourceEntries(context, ir) {
  return [context, ir].flatMap((source) => IDENTITY_SOURCE_KEYS.map((key) => ({
    source,
    key,
    ...ownDataProperty(source, key),
  })));
}

function unsupportedIdentityMetadata(entries) {
  return entries.some((entry) => {
    if (entry.malformed) return true;
    if (!entry.present || entry.value == null) return false;
    try {
      // Validate the complete candidate, including unknown metadata, before
      // reading any identity field. This rejects symbols, hidden descriptors,
      // accessors, cycles, and non-finite values instead of silently ignoring
      // them at the identity boundary.
      typedIdentityText(entry.value);
      return false;
    } catch {
      return true;
    }
  });
}

function sourceIdentity(entries) {
  return entries.find((entry) => !entry.malformed && entry.value != null)?.value ?? null;
}

function explicitlyMissingIdentity(entries) {
  return entries.some((entry) => entry.present && entry.value == null);
}

function field(candidate, ...names) {
  for (const name of names) {
    const property = ownDataProperty(candidate, name);
    if (property.malformed) return null;
    const value = token(property.value);
    if (value != null) return value;
  }
  return null;
}

function hasMalformedIdentityFields(candidate) {
  if (candidate == null) return false;
  if (typeof candidate !== 'object' || Array.isArray(candidate)) return true;
  const aliases = [
    ['binaryId'], ['functionId'], ['snapshotId'], ['semanticIrId', 'semanticIRId'],
    ['ssaId'], ['analyzerVersion', 'semanticSchemaVersion'],
  ];
  try {
    for (const names of aliases) {
      for (const name of names) {
        const property = ownDataProperty(candidate, name);
        if (!property.present) continue;
        if (property.malformed) return true;
        const raw = property.value;
        if (raw == null || token(raw) == null) return true;
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

function shapeBinding(source) {
  return field(source, 'semanticIrShapeDigest', 'semanticIRShapeDigest', 'irShapeDigest', 'canonicalIrDigest', 'shapeDigest');
}

function sourceIsBoundToShape(source, identity, shapeDigest, shape, sharedTexts = null) {
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
    const expectedSsa = `ssa:${ssaIdentityDigest(expectedSemantic, shape.values, sharedTexts)}`;
    if (suppliedSsa !== expectedSsa) return false;
  }
  return true;
}

function ssaIdentityDigest(semanticIrId, values, sharedTexts = null) {
  try { return fastJsonGraphDigest({ semanticIrId, values }, sharedTexts !== null, sharedTexts); }
  catch { return null; }
}

export function isValidatedAnalysisIdentity(identity) {
  if (identity == null || typeof identity !== 'object' || Array.isArray(identity)) return false;
  return REQUIRED_FIELDS.every((name) => {
    const property = ownDataProperty(identity, name);
    return !property.malformed && typeof property.value === 'string' && property.value.trim().length > 0;
  });
}

export function analysisIdentityMatches(observed, expected) {
  if (!isValidatedAnalysisIdentity(observed) || !isValidatedAnalysisIdentity(expected)) return false;
  return REQUIRED_FIELDS.every((name) => observed[name] === expected[name]);
}

/**
 * Resolve a validated identity from canonical IR metadata.  Existing fixtures
 * often carry no binary loader IDs, so the fallback is a deterministic digest
 * of the IR shape, never a wall-clock or architecture-name guess.
 */
export function canonicalAnalysisIdentity(context = {}) {
  const seededCfg = context?.analysis?.get?.('cfg') ?? null;
  const seededSsa = context?.analysis?.get?.('ssa') ?? null;
  const seededOrigins = context?.analysis?.get?.('origins') ?? null;
  const ir = context?.ir ?? (seededCfg != null || seededSsa != null ? {
    blocks: seededCfg?.blocks ?? [],
    entry: seededCfg?.entry ?? null,
    values: seededSsa?.values ?? [],
    origin: seededOrigins?.functionOrigin ?? null,
  } : null);
  const sourceEntries = identitySourceEntries(context, ir);
  if (unsupportedIdentityMetadata(sourceEntries)) {
    return { identity: null, valid: false, reason: 'analysis identity is malformed' };
  }
  const source = sourceIdentity(sourceEntries);
  if (explicitlyMissingIdentity(sourceEntries)) return { identity: null, valid: false, reason: 'analysis identity is null' };
  if (source != null && (typeof source !== 'object' || Array.isArray(source))) {
    return { identity: null, valid: false, reason: 'analysis identity is malformed' };
  }
  const irAnalysisIdentity = sourceEntries.find((entry) => entry.source === ir && entry.key === 'analysisIdentity')?.value;
  const irIdentity = sourceEntries.find((entry) => entry.source === ir && entry.key === 'identity')?.value;
  const irSourceIdentity = irAnalysisIdentity ?? irIdentity ?? null;
  if (hasMalformedIdentityFields(source)
      || hasMalformedIdentityFields(irSourceIdentity)) {
    return { identity: null, valid: false, reason: 'analysis identity is malformed' };
  }
  const shape = irShape(ir);
  if (shape == null) return { identity: null, valid: false, reason: 'canonical Semantic IR identity is unavailable' };
  // `shape` is the acyclic plain projection assembled above. Use the same
  // width-preserving typed serializer as canonical origins; malformed values
  // fail closed instead of falling back to a lossy alternate representation.
  const sharedTexts = DETACHED_SHAPES.has(shape) ? createPassiveTextCache() : null;
  let shapeDigest;
  try { shapeDigest = `shape:${fastJsonGraphDigest(shape, sharedTexts !== null, sharedTexts)}`; }
  catch { return { identity: null, valid: false, reason: 'canonical Semantic IR identity is unavailable' }; }
  const functionId = field(source, 'functionId') ?? field(ir, 'functionId') ?? `function:${shapeDigest}`;
  const binaryId = field(source, 'binaryId') ?? field(ir, 'binaryId') ?? `binary:${stableDigest({ functionId, shapeDigest })}`;
  const snapshotId = field(source, 'snapshotId') ?? field(ir, 'snapshotId') ?? `snapshot:${stableDigest({ binaryId, functionId, shapeDigest })}`;
  const semanticIrId = field(source, 'semanticIrId', 'semanticIRId') ?? field(ir, 'semanticIrId', 'semanticIRId')
    ?? `semantic-ir:${stableDigest({ snapshotId, functionId, shapeDigest })}`;
  const computedSsaDigest = ssaIdentityDigest(semanticIrId, shape.values, sharedTexts);
  if (computedSsaDigest == null) return { identity: null, valid: false, reason: 'canonical SSA identity is unavailable' };
  const ssaId = field(source, 'ssaId') ?? field(ir, 'ssaId')
    ?? `ssa:${computedSsaDigest}`;
  const analyzerVersion = field(source, 'analyzerVersion', 'semanticSchemaVersion')
    ?? field(ir, 'analyzerVersion', 'semanticSchemaVersion') ?? 'phase8-analysis-v1';
  const identity = Object.freeze({ binaryId, functionId, snapshotId, semanticIrId, ssaId, analyzerVersion });
  if (!isValidatedAnalysisIdentity(identity)) return { identity: null, valid: false, reason: 'analysis identity fields are invalid' };
  if (!sameKnownSourceFields(identity, source) || !sameKnownSourceFields(identity, irSourceIdentity)
      || !sourceIsBoundToShape(source, identity, shapeDigest, shape, sharedTexts)
      || !sourceIsBoundToShape(irSourceIdentity, identity, shapeDigest, shape, sharedTexts)) {
    return { identity: null, valid: false, reason: 'analysis identity is stale for the Semantic IR' };
  }
  return { identity, valid: true, reason: null };
}

export { REQUIRED_FIELDS as ANALYSIS_IDENTITY_FIELDS };
