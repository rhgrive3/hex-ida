/**
 * Canonical identity for Phase 8 analysis products.
 *
 * A scalar artifact is only useful for the exact Semantic IR/SSA snapshot that
 * produced it.  This module owns the small identity boundary shared by SCCP,
 * GVN and induction; consumers do not invent a second stale-result check.
 */

import { stableDigest } from '../../core/identity/index.js';

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
const DEEPLY_FROZEN_CACHE = new WeakMap();

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
  const cached = DEEPLY_FROZEN_CACHE.get(value);
  if (cached != null) return cached;
  if (!Object.isFrozen(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  if (active.has(value)) return false;
  active.add(value);
  let result = true;
  try {
    for (const key of Object.keys(value)) {
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

// `stableDigest` intentionally uses BigInt FNV and JSON-safe allocation because
// it is a general public identity primitive.  OriginSets are already validated,
// deeply frozen, and used on the phase8 deadline hot path, so serialize their
// fixed data graph directly into four uint32 lanes.  This preserves a 128-bit
// deterministic fingerprint while avoiding a large JSON clone and BigInt
// multiply for every provenance character.  The generic semantic walk remains
// the fallback for mutable/untrusted metadata.
function fastOriginDigest(root) {
  let hash0 = 0x811c9dc5;
  let hash1 = 0x9e3779b9;
  let hash2 = 0x243f6a88;
  let hash3 = 0xb7e15162;
  const active = new Set();
  const write = (text) => {
    const value = String(text);
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      hash0 = Math.imul(hash0 ^ code, 0x01000193) >>> 0;
      hash1 = Math.imul(hash1 ^ code, 0x85ebca6b) >>> 0;
      hash2 = Math.imul(hash2 ^ code, 0xc2b2ae35) >>> 0;
      hash3 = Math.imul(hash3 ^ code, 0x27d4eb2f) >>> 0;
    }
  };
  const visit = (value) => {
    if (value == null) { write(value === null ? 'null;' : 'undefined;'); return; }
    switch (typeof value) {
      case 'string': write(`s${value.length}:${value};`); return;
      case 'boolean': write(value ? 'b1;' : 'b0;'); return;
      case 'number': write(`n${Number.isFinite(value) ? value : 'nonfinite'};`); return;
      case 'bigint': write(`i${value};`); return;
      case 'undefined':
      case 'function':
      case 'symbol':
        throw new TypeError('identity-invalid-semantic-metadata');
      default: break;
    }
    if (typeof value !== 'object' || active.has(value)) throw new TypeError('identity-invalid-frozen-origin');
    active.add(value);
    if (Array.isArray(value)) {
      write(`a${value.length}[`);
      for (const item of value) visit(item);
      write('];');
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError('identity-unsupported-semantic-metadata');
      const keys = Object.keys(value).sort();
      write(`o${keys.length}{`);
      for (const key of keys) {
        write(`k${key.length}:${key};`);
        visit(value[key]);
      }
      write('};');
    }
    active.delete(value);
  };
  visit(root);
  return [hash0, hash1, hash2, hash3].map((hash) => hash.toString(16).padStart(8, '0')).join('');
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

function fastFrozenOriginDigest(value) {
  return fastJsonGraphDigest(value);
}

function typedIdentityText(root) {
  const active = new Set();
  const visit = (value) => {
    if (value === null) return 'null;';
    switch (typeof value) {
      case 'undefined':
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
      if (Array.isArray(value)) {
        return `array:${value.length}[${value.map(visit).join('')}]`;
      }
      if (value instanceof Map) {
        const entries = [...value.entries()]
          .map(([key, item]) => `${visit(key)}=>${visit(item)}`)
          .sort();
        return `map:${entries.length}{${entries.join('')}}`;
      }
      if (value instanceof Set) {
        const values = [...value.values()].map(visit).sort();
        return `set:${values.length}{${values.join('')}}`;
      }
      if (value instanceof Date) return `date:${value.toISOString().length}:${value.toISOString()};`;
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('identity-unsupported-semantic-metadata');
      }
      const keys = Object.keys(value).sort();
      return `object:${keys.length}{${keys.map((key) => `key:${key.length}:${key};${visit(value[key])}`).join('')}}`;
    } finally {
      active.delete(value);
    }
  };
  return visit(root);
}

function identityJsonReplacer(key, item) {
  const source = this != null && Object.hasOwn(this, key) ? this[key] : item;
  if (source === null) return null;
  const type = typeof source;
  if (type === 'undefined' || type === 'function' || type === 'symbol') {
    throw new TypeError('identity-invalid-semantic-metadata');
  }
  if (type === 'string') return source.startsWith('\u0000') ? `\u0000${source}` : source;
  if (type === 'bigint') return `\u0000bigint:${source}`;
  if (type === 'number') {
    if (!Number.isFinite(source)) throw new TypeError('identity-non-finite-number');
    return Object.is(source, -0) ? '\u0000number:-0' : source;
  }
  if (type === 'object') {
    if (source instanceof Date) {
      const iso = source.toISOString();
      return `\u0000date:${iso.length}:${iso}`;
    }
    if (source instanceof Map) return `\u0000map:${typedIdentityText(source)}`;
    if (source instanceof Set) return `\u0000set:${typedIdentityText(source)}`;
    const prototype = Object.getPrototypeOf(source);
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(source)) {
      throw new TypeError('identity-unsupported-semantic-metadata');
    }
  }
  return item;
}

function fastJsonGraphDigest(value) {
  const text = JSON.stringify(value, identityJsonReplacer);
  if (text === undefined) throw new TypeError('identity-invalid-semantic-metadata');
  return fastJsonTextDigest(text);
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
  if (value == null || typeof value === 'string' || typeof value === 'boolean'
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
  let result;
  if (Array.isArray(value)) {
    result = value.map((item, index) => semanticObject(item, seen, NO_SKIPPED_KEYS, `${path}[${index}]`, memo));
  } else if (value instanceof Map) {
    result = {
      type: 'Map',
      entries: [...value.entries()]
        .map(([key, item], index) => [
          semanticObject(key, seen, NO_SKIPPED_KEYS, `${path}.mapKey[${index}]`, memo),
          semanticObject(item, seen, NO_SKIPPED_KEYS, `${path}.mapValue[${index}]`, memo),
        ])
        .sort((left, right) => fastJsonGraphDigest(left).localeCompare(fastJsonGraphDigest(right))),
    };
  } else if (value instanceof Set) {
    result = {
      type: 'Set',
      values: [...value.values()]
        .map((item, index) => semanticObject(item, seen, NO_SKIPPED_KEYS, `${path}.set[${index}]`, memo))
        .sort((left, right) => fastJsonGraphDigest(left).localeCompare(fastJsonGraphDigest(right))),
    };
  } else if (value instanceof Date) {
    result = { type: 'Date', value: value.toISOString() };
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('identity-unsupported-semantic-metadata');
    }
    result = {};
    for (const key of Object.keys(value).sort()) {
      if (skip.has(key)) continue;
      // A skip list describes this known wrapper object only.  Applying it to
      // nested `extra`/metadata objects would silently erase a semantic field
      // whose name happens to be `uses` or `dst`.
      result[key] = semanticObject(value[key], seen, NO_SKIPPED_KEYS, `${path}.${key}`, memo);
    }
  }
  seen.delete(value);
  if (memoizable) memo.set(value, result);
  return result;
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

function argumentShape(argument, memo, digests) {
  if (argument == null || typeof argument !== 'object') return { valueId: token(argument) };
  const shape = semanticObject(argument, new Set(), new Set(['value', 'origin', ...NON_SEMANTIC_KEYS]), '$.argument', memo);
  shape.valueId = token(argument.value?.id ?? argument.id);
  shape.originDigest = semanticDigest(argument.origin, memo, digests, '$.argument.origin', true);
  return shape;
}

function incomingShape(incoming, memo, digests) {
  if (incoming == null || typeof incoming !== 'object') return { valueId: token(incoming) };
  const shape = semanticObject(incoming, new Set(), new Set(['value', 'origin', ...NON_SEMANTIC_KEYS]), '$.incoming', memo);
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
  return {
    kind: node.kind ?? null,
    key: node.key ?? null,
    definitionId: token(node.definitionId),
    regionId: token(node.regionId),
    block: node.block ?? null,
    reason: node.reason ?? null,
    unknownAlias: node.unknownAlias ?? null,
    aliasRelation: node.aliasRelation ?? null,
    instructionId: token(node.inst?.instructionId ?? node.inst?.id),
    previousId: token(node.prev?.definitionId),
    previousIds: Array.isArray(node.previous) ? node.previous.map((item) => token(item?.definitionId)) : null,
    incoming: Array.isArray(node.incoming) ? node.incoming.map((item) => ({
      from: item?.from ?? null,
      semanticPredecessorBlockId: token(item?.semanticPredecessorBlockId),
      definitionId: token(item?.node?.definitionId ?? item?.definitionId),
    })) : null,
    effectSummaryDigest: semanticDigest(node.effectSummary, memo, digests, '$.memory.effectSummary'),
    proofDigest: semanticDigest(node.proof, memo, digests, '$.memory.proof'),
    originDigest: semanticDigest(node.origin, memo, digests, '$.memory.origin', true),
  };
}

function memoryLocationShape(location, memo, digests) {
  if (location == null || typeof location !== 'object') return location ?? null;
  return {
    key: location.key ?? null,
    kind: location.kind ?? null,
    size: location.size ?? null,
    regionId: token(location.regionId),
    baseId: token(location.base?.id ?? location.base),
    indexId: token(location.index?.id ?? location.index),
    scale: location.scale ?? null,
    address: location.address == null ? null : semanticObject(location.address, new Set(), NO_SKIPPED_KEYS, '$.memory.address', memo),
    disp: location.disp == null ? null : semanticObject(location.disp, new Set(), NO_SKIPPED_KEYS, '$.memory.disp', memo),
    uncertaintyIdentityDigest: semanticDigest(location.uncertaintyIdentity, memo, digests, '$.memory.uncertainty'),
    originDigest: semanticDigest(location.origin, memo, digests, '$.memory.location.origin', true),
  };
}

function definitionShape(definition, extraSkip = [], memo = null, digests = null, definitionCache = null) {
  if (definition == null || typeof definition !== 'object') return null;
  const cacheKey = extraSkip.length === 0 ? '' : [...extraSkip].sort().join('\u0000');
  const cached = definitionCache?.get(definition)?.get(cacheKey);
  if (cached != null) return cached;
  const shape = semanticObject(definition, new Set(), new Set([
    'args', 'incoming', 'addr', 'loc', 'conditionValue', 'selectorValue', 'extra', 'origin',
    'memUse', 'memDef', 'memDefs', 'memKills', 'reachingStore', 'unknownAliasBarrier',
    ...NON_SEMANTIC_KEYS, ...extraSkip,
  ]), '$.definition', memo);
  shape.args = Array.isArray(definition.args) ? definition.args.map((argument) => argumentShape(argument, memo, digests)) : null;
  shape.incoming = Array.isArray(definition.incoming)
    ? definition.incoming.map((incoming) => incomingShape(incoming, memo, digests)) : null;
  shape.addr = definition.addr == null
    ? null : semanticObject(definition.addr, new Set(), new Set(['base', 'index']), '$.definition.addr', memo);
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
    ? definition.memDefs.map((node) => memoryNodeShape(node, memo, digests)) : null;
  shape.memoryKills = Array.isArray(definition.memKills)
    ? definition.memKills.map((location) => memoryLocationShape(location, memo, digests)) : null;
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
  return {
    id: token(value.id),
    bits: value.bits ?? null,
    kind: value.kind ?? null,
    signed: value.signed ?? null,
    constant: value.const ?? null,
    originDigest: semanticDigest(value.origin, memo, digests, '$.value.origin', true),
    definition: definitionShape(value.def, [], memo, digests, definitionCache),
  };
}

function instructionShape(instruction, memo, digests, definitionCache) {
  if (instruction == null || typeof instruction !== 'object') return instruction ?? null;
  const shape = definitionShape(instruction, ['conditionValue', 'selectorValue'], memo, digests, definitionCache);
  return shape;
}

function blockShape(block, memo, digests, definitionCache) {
  if (block == null || typeof block !== 'object') return block ?? null;
  const shape = semanticObject(block, new Set(), new Set(['insts', 'phis', 'memPhis', 'successorEdges', 'succ', 'pred', 'origin', ...NON_SEMANTIC_KEYS]), '$.block', memo);
  shape.index = block.index ?? null;
  shape.id = token(block.id);
  shape.succ = Array.isArray(block.succ) ? block.succ.map(token) : null;
  shape.pred = Array.isArray(block.pred) ? block.pred.map(token) : null;
  shape.successorEdges = Array.isArray(block.successorEdges)
    ? block.successorEdges.map((edge) => semanticObject(edge, new Set(), NO_SKIPPED_KEYS, '$.block.successorEdge', memo)) : null;
  shape.insts = Array.isArray(block.insts)
    ? block.insts.map((instruction) => instructionShape(instruction, memo, digests, definitionCache)) : null;
  shape.phis = Array.isArray(block.phis)
    ? block.phis.map((definition) => definitionShape(definition, [], memo, digests, definitionCache)) : null;
  shape.memPhis = Array.isArray(block.memPhis)
    ? block.memPhis.map((node) => memoryNodeShape(node, memo, digests)) : null;
  shape.originDigest = semanticDigest(block.origin, memo, digests, '$.block.origin', true);
  return shape;
}

function irShape(ir) {
  if (ir == null || typeof ir !== 'object') return null;
  try {
    const memo = new WeakMap();
    const digests = new WeakMap();
    digests.originRefs = new WeakMap();
    digests.originValues = [];
    const definitionCache = new WeakMap();
    const shape = semanticObject(ir, new Set(), DERIVED_IR_KEYS, '$', memo);
    shape.entry = token(ir.entry);
    shape.originDigest = semanticDigest(ir.origin, memo, digests, '$.origin', true);
    shape.blocks = Array.isArray(ir.blocks)
      ? ir.blocks.map((block) => blockShape(block, memo, digests, definitionCache))
        .sort((left, right) => String(left.index).localeCompare(String(right.index))) : [];
    shape.values = Array.isArray(ir.values)
      ? ir.values.map((value) => valueShape(value, memo, digests, definitionCache))
        .sort((left, right) => String(left.id).localeCompare(String(right.id))) : [];
    // Some canonical IR producers expose a flat instruction table in addition
    // to block-local `insts`. It is semantic input, not derived bookkeeping:
    // omitting it lets an in-place instruction mutation reuse a stale product.
    shape.instructions = ir.instructions == null
      ? null
      : Array.isArray(ir.instructions)
        ? ir.instructions.map((instruction) => instructionShape(instruction, memo, digests, definitionCache))
        : semanticObject(ir.instructions, new Set(), NO_SKIPPED_KEYS, '$.instructions', memo);
    // Loop/back-edge facts are canonical upstream inputs to widening.  Keep
    // their scalar shape when present, while avoiding Maps/Sets used only as
    // derived lookup caches in graph products.
    shape.backEdges = Array.isArray(ir.backEdges)
      ? ir.backEdges.map((edge) => semanticObject(edge, new Set(), NO_SKIPPED_KEYS, '$.backEdge', memo)) : [];
    shape.loops = Array.isArray(ir.loops)
      ? ir.loops.map((loop) => semanticObject(loop, new Set(), NO_SKIPPED_KEYS, '$.loop', memo)) : [];
    try {
      shape.originTableDigest = `origin-table:${fastFrozenOriginDigest(digests.originValues)}`;
    } catch {
      return null;
    }
    return shape;
  } catch {
    return null;
  }
}

function sourceIdentity(context, ir) {
  const candidates = [
    context?.analysisIdentity,
    context?.identity,
    context?.artifactIdentity,
    ir?.analysisIdentity,
    ir?.identity,
  ];
  return candidates.find((candidate) => candidate != null) ?? null;
}

function explicitlyMissingIdentity(context, ir) {
  return [context, ir].some((source) => ['analysisIdentity', 'identity', 'artifactIdentity'].some((key) => Object.hasOwn(source ?? {}, key)
    && source[key] == null));
}

function field(candidate, ...names) {
  for (const name of names) {
    const value = token(candidate?.[name]);
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
        if (!Object.hasOwn(candidate, name)) continue;
        const raw = candidate[name];
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

function sourceIsBoundToShape(source, identity, shapeDigest, shape) {
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
    const expectedSsa = `ssa:${ssaIdentityDigest(expectedSemantic, shape.values)}`;
    if (suppliedSsa !== expectedSsa) return false;
  }
  return true;
}

function ssaIdentityDigest(semanticIrId, values) {
  try { return fastJsonGraphDigest({ semanticIrId, values }); }
  catch { return null; }
}

export function isValidatedAnalysisIdentity(identity) {
  if (identity == null || typeof identity !== 'object' || Array.isArray(identity)) return false;
  return REQUIRED_FIELDS.every((name) => typeof identity[name] === 'string' && identity[name].trim().length > 0);
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
  const source = sourceIdentity(context, ir);
  if (explicitlyMissingIdentity(context, ir)) return { identity: null, valid: false, reason: 'analysis identity is null' };
  if (source != null && (typeof source !== 'object' || Array.isArray(source))) {
    return { identity: null, valid: false, reason: 'analysis identity is malformed' };
  }
  if (hasMalformedIdentityFields(source)
      || hasMalformedIdentityFields(ir?.analysisIdentity ?? ir?.identity)) {
    return { identity: null, valid: false, reason: 'analysis identity is malformed' };
  }
  const shape = irShape(ir);
  if (shape == null) return { identity: null, valid: false, reason: 'canonical Semantic IR identity is unavailable' };
  // `shape` is the acyclic plain projection assembled above. Use the same
  // width-preserving typed serializer as canonical origins; malformed values
  // fail closed instead of falling back to a lossy alternate representation.
  let shapeDigest;
  try { shapeDigest = `shape:${fastJsonGraphDigest(shape)}`; }
  catch { return { identity: null, valid: false, reason: 'canonical Semantic IR identity is unavailable' }; }
  const functionId = field(source, 'functionId') ?? field(ir, 'functionId') ?? `function:${shapeDigest}`;
  const binaryId = field(source, 'binaryId') ?? field(ir, 'binaryId') ?? `binary:${stableDigest({ functionId, shapeDigest })}`;
  const snapshotId = field(source, 'snapshotId') ?? field(ir, 'snapshotId') ?? `snapshot:${stableDigest({ binaryId, functionId, shapeDigest })}`;
  const semanticIrId = field(source, 'semanticIrId', 'semanticIRId') ?? field(ir, 'semanticIrId', 'semanticIRId')
    ?? `semantic-ir:${stableDigest({ snapshotId, functionId, shapeDigest })}`;
  const computedSsaDigest = ssaIdentityDigest(semanticIrId, shape.values);
  if (computedSsaDigest == null) return { identity: null, valid: false, reason: 'canonical SSA identity is unavailable' };
  const ssaId = field(source, 'ssaId') ?? field(ir, 'ssaId')
    ?? `ssa:${computedSsaDigest}`;
  const analyzerVersion = field(source, 'analyzerVersion', 'semanticSchemaVersion')
    ?? field(ir, 'analyzerVersion', 'semanticSchemaVersion') ?? 'phase8-analysis-v1';
  const identity = Object.freeze({ binaryId, functionId, snapshotId, semanticIrId, ssaId, analyzerVersion });
  if (!isValidatedAnalysisIdentity(identity)) return { identity: null, valid: false, reason: 'analysis identity fields are invalid' };
  if (!sameKnownSourceFields(identity, source) || !sameKnownSourceFields(identity, ir?.analysisIdentity ?? ir?.identity)
      || !sourceIsBoundToShape(source, identity, shapeDigest, shape)
      || !sourceIsBoundToShape(ir?.analysisIdentity ?? ir?.identity, identity, shapeDigest, shape)) {
    return { identity: null, valid: false, reason: 'analysis identity is stale for the Semantic IR' };
  }
  return { identity, valid: true, reason: null };
}

export { REQUIRED_FIELDS as ANALYSIS_IDENTITY_FIELDS };
