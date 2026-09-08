import { canonicalAddress, deepFreeze, jsonSafe, stableStringify, validateCanonicalIdentityNumbers } from './index.js';

export const ORIGIN_SCHEMA_VERSION = 1;
const CANONICAL_ORIGIN_SETS = new WeakSet();
const CANONICAL_TRANSFORM_RECORDS = new WeakSet();
const REUSABLE_ORIGIN_SETS = new WeakSet();
const REPLAY_SAFE_JSON = new WeakSet();
const ORIGIN_FIELDS = ['byteRanges', 'virtualRanges', 'instructionIds', 'operationIds',
  'sourceLocations', 'parentEntityIds', 'transforms'];
// Keys belong to lists produced here, never to caller-owned/frozen inputs.
// Keep the already-computed keys beside their deeply frozen values so merging
// canonical origins need not normalize, copy and serialize the same trees again.
// Weak ownership lets both the list and its key/value entries be collected.
const CANONICAL_LIST_ENTRIES = new WeakMap();
const EMPTY_LIST = Object.freeze([]);
const ORIGINAL_ARRAY_MAP = Array.prototype.map;
CANONICAL_LIST_ENTRIES.set(EMPTY_LIST, []);

function fail(code) { throw new TypeError(code); }
function arrayList(values, code) {
  if (values == null) return [];
  if (!Array.isArray(values)) fail(code);
  return values;
}
function stringList(values, code) {
  if (values == null) return [];
  if (!Array.isArray(values)) fail(code);
  const out = [];
  for (const value of values) {
    if (typeof value !== 'string') fail(code);
    const text = value.trim();
    if (!text) fail(code);
    out.push(text);
  }
  return out;
}
function stringValue(value, code) {
  if (typeof value !== 'string') fail(code);
  return value;
}
function requiredString(value, code) {
  if (typeof value !== 'string') fail(code);
  const text = value.trim();
  if (!text) fail(code);
  return text;
}
function bigintValue(value, code) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail(code);
    return BigInt(value);
  }
  if (typeof value !== 'string' || !value.trim()) fail(code);
  try { return BigInt(value.trim()); }
  catch { fail(code); }
}
function ordinaryJsonPrototypes() {
  // JSON.stringify also observes inherited toJSON hooks on its fresh jsonSafe
  // output. Such hooks can change keys even for deeply frozen input values.
  // Use presence checks, not reads, so an inherited getter is never invoked here.
  return !('toJSON' in Object.prototype) && !('toJSON' in Array.prototype);
}
function arrayIndex(key) {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 0xffffffff && String(index) === key;
}
function replaySafeJson(value, active = null) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value)
    && (!Number.isInteger(value) || Number.isSafeInteger(value));
  if (typeof value !== 'object') return false;
  if (REPLAY_SAFE_JSON.has(value)) return true;
  // jsonSafe uses Array#map: a custom mapper/species can return a caller-owned,
  // shallow-frozen object or an accessor. The producer brand must not bless it.
  // Inspect descriptors without executing getters and cache only genuinely
  // immutable, normalization-idempotent JSON trees. Unusual values replay the
  // original normalizer rather than gaining weaker validation.
  active ??= new WeakSet();
  if (active.has(value)) return false;
  active.add(value);
  try {
    const array = Array.isArray(value);
    if (!Object.isFrozen(value) || Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    // Holes can expose later mutations of Array.prototype; own undefined values
    // are not idempotent either (jsonSafe replaces them with null).
    if (array && keys.length !== descriptors.length.value + 1) return false;
    let priorKey = null;
    for (const key of keys) {
      if (typeof key !== 'string') return false;
      if (array && key === 'length') continue;
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
      if (array) {
        if (!arrayIndex(key)) return false;
      } else {
        if (descriptor.value === undefined) return false;
        if (!arrayIndex(key)) {
          if (priorKey !== null && priorKey > key) return false;
          priorKey = key;
        }
      }
      if (!replaySafeJson(descriptor.value, active)) return false;
    }
    REPLAY_SAFE_JSON.add(value);
    return true;
  } catch {
    // Proxy reflection is not a reason to reject an otherwise accepted input;
    // it only disqualifies the optional reuse path.
    return false;
  } finally {
    active.delete(value);
  }
}
function normalizedList(values, code, normalize) {
  const input = arrayList(values, code);
  let ordinary = false;
  try {
    ordinary = Object.getPrototypeOf(input) === Array.prototype
      && !Object.hasOwn(input, 'map') && !Object.hasOwn(input, 'constructor');
  } catch { /* Reflection failure means replay, not a new input error. */ }
  // Keep custom map/species behavior unchanged, but do not brand its output
  // for reuse. Only the original Array#map with an ordinary result proves that
  // every list value passed through the field normalizer.
  const mapper = input.map;
  const mapped = Reflect.apply(mapper, input, [normalize]);
  const result = uniqueSorted(mapped);
  let standardMapped = false;
  try {
    standardMapped = mapper === ORIGINAL_ARRAY_MAP
      && Array.prototype.map === ORIGINAL_ARRAY_MAP
      && Object.getPrototypeOf(mapped) === Array.prototype
      && !Object.hasOwn(mapped, 'map') && !Object.hasOwn(mapped, 'constructor');
  } catch { /* Reflection failure means replay, not a new input error. */ }
  // An overridden mapper/species can bypass the field normalizer altogether.
  if ((!ordinary || !standardMapped) && result !== EMPTY_LIST) CANONICAL_LIST_ENTRIES.delete(result);
  return result;
}
function sortedList(byKey, cacheable = true) {
  if (byKey.size === 0) return EMPTY_LIST;
  // Preserve localeCompare (including ties between distinct keys) and Map's
  // first-insertion order / last-value-wins semantics exactly.
  const entries = [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b));
  const values = entries.map(([, value]) => value);
  if (cacheable) CANONICAL_LIST_ENTRIES.set(values, entries);
  return values;
}
function uniqueSorted(values) {
  const cacheable = ordinaryJsonPrototypes();
  const byKey = new Map(values.map((value) => [stableStringify(value), value]));
  return sortedList(byKey, cacheable && ordinaryJsonPrototypes());
}
function mergeCanonicalLists(origins, field) {
  const lists = origins.map((origin) => origin[field]).filter((values) => values.length > 0);
  if (lists.length === 0) return EMPTY_LIST;
  if (lists.length === 1) return lists[0];
  const byKey = new Map();
  for (const values of lists) {
    for (const [key, value] of CANONICAL_LIST_ENTRIES.get(values)) byKey.set(key, value);
  }
  return sortedList(byKey);
}
function captureOriginSet(out) {
  const frozen = deepFreeze(out);
  CANONICAL_ORIGIN_SETS.add(frozen);
  if (ordinaryJsonPrototypes() && ORIGIN_FIELDS.every((field) => CANONICAL_LIST_ENTRIES.has(frozen[field]))
      && frozen.sourceLocations.every((value) => replaySafeJson(value))
      && frozen.transforms.every((value) => CANONICAL_TRANSFORM_RECORDS.has(value))) {
    REUSABLE_ORIGIN_SETS.add(frozen);
  }
  return frozen;
}
// Provenance payloads must be validated before jsonSafe can erase or round numeric evidence.
function exactJson(value) {
  validateCanonicalIdentityNumbers(value);
  return jsonSafe(value);
}

/** Normalize a half-open file range; a present binary reference must be a nonempty identity. */
function byteRange(range) {
  if (!range || typeof range !== 'object') fail('origin-invalid-byte-range');
  const start = bigintValue(range.start ?? range.offset, 'origin-invalid-byte-range');
  const end = range.end != null ? bigintValue(range.end, 'origin-invalid-byte-range')
    : range.length != null ? start + bigintValue(range.length, 'origin-invalid-byte-range') : null;
  if (end == null || start < 0n || end < start) fail('origin-invalid-byte-range');
  return {
    ...(range.binaryId == null ? {} : { binaryId: requiredString(range.binaryId, 'origin-invalid-byte-range') }),
    start: start.toString(),
    end: end.toString(),
  };
}

/** Normalize a half-open virtual range without inventing absent image or slice identities. */
function virtualRange(range) {
  if (!range || typeof range !== 'object') fail('origin-invalid-virtual-range');
  const start = canonicalAddress(range.start ?? range.address);
  let end;
  if (range.end != null) end = canonicalAddress(range.end);
  else if (range.length != null) end = canonicalAddress(BigInt(start) + bigintValue(range.length, 'origin-invalid-virtual-range'));
  else fail('origin-invalid-virtual-range');
  if (BigInt(end) < BigInt(start)) fail('origin-invalid-virtual-range');
  return {
    ...(range.imageId == null ? {} : { imageId: requiredString(range.imageId, 'origin-invalid-virtual-range') }),
    ...(range.sliceId == null ? {} : { sliceId: requiredString(range.sliceId, 'origin-invalid-virtual-range') }),
    start,
    end,
  };
}

export function createTransformRecord(input = {}) {
  if (CANONICAL_TRANSFORM_RECORDS.has(input)) return input;
  if (!input || typeof input !== 'object') fail('origin-invalid-transform');
  const passId = requiredString(input.passId, 'origin-invalid-transform');
  const passVersion = requiredString(input.passVersion, 'origin-invalid-transform');
  const ruleId = requiredString(input.ruleId, 'origin-invalid-transform');
  const proofKind = requiredString(input.proofKind, 'origin-invalid-transform');
  const frozen = deepFreeze({
    passId,
    passVersion,
    ruleId,
    consumedEntityIds: uniqueSorted(stringList(input.consumedEntityIds, 'origin-invalid-consumed-ids')),
    producedEntityIds: uniqueSorted(stringList(input.producedEntityIds, 'origin-invalid-produced-ids')),
    preconditions: exactJson(input.preconditions ?? []),
    proofKind,
    timestampOrBuildId: input.timestampOrBuildId == null ? null : stringValue(input.timestampOrBuildId, 'origin-invalid-transform'),
  });
  if (replaySafeJson(frozen.preconditions)) CANONICAL_TRANSFORM_RECORDS.add(frozen);
  return frozen;
}

export function createOriginSet(input = {}) {
  if (input && typeof input === 'object' && CANONICAL_ORIGIN_SETS.has(input)) return input;
  if (input == null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) fail('origin-invalid-set');
  const byteRanges = normalizedList(input.byteRanges, 'origin-invalid-byte-ranges', byteRange);
  const virtualRanges = normalizedList(input.virtualRanges, 'origin-invalid-virtual-ranges', virtualRange);
  const transforms = normalizedList(input.transforms, 'origin-invalid-transforms', createTransformRecord);
  const out = {
    schemaVersion: ORIGIN_SCHEMA_VERSION,
    byteRanges,
    virtualRanges,
    instructionIds: uniqueSorted(stringList(input.instructionIds, 'origin-invalid-instruction-ids')),
    operationIds: uniqueSorted(stringList(input.operationIds ?? input.bytecodeOperationIds, 'origin-invalid-operation-ids')),
    sourceLocations: normalizedList(input.sourceLocations, 'origin-invalid-source-locations', exactJson),
    parentEntityIds: uniqueSorted(stringList(input.parentEntityIds, 'origin-invalid-parent-ids')),
    transforms,
  };
  return captureOriginSet(out);
}

/**
 * Return true only for a deeply frozen origin set issued by this module. This
 * is a producer-owned capture boundary, not a generic frozen-object shortcut.
 */
export function isCanonicalOriginSet(value) {
  return value != null && typeof value === 'object'
    && CANONICAL_ORIGIN_SETS.has(value);
}

export function mergeOriginSets(...sets) {
  const normalized = sets.filter((value) => value != null).map((value) => createOriginSet(value));
  // Normalize *all* external inputs before any reuse. A frozen shape, clone or
  // proxy is not the private producer brand and must still validate every field.
  if (!ordinaryJsonPrototypes() || normalized.some((origin) => !REUSABLE_ORIGIN_SETS.has(origin))) {
    // Rebuild through the original normalization path for unusual input trees
    // or JSON hooks, including hooks present when an input's keys were captured.
    return createOriginSet({
      byteRanges: normalized.flatMap((value) => value.byteRanges),
      virtualRanges: normalized.flatMap((value) => value.virtualRanges),
      instructionIds: normalized.flatMap((value) => value.instructionIds),
      operationIds: normalized.flatMap((value) => value.operationIds),
      sourceLocations: normalized.flatMap((value) => value.sourceLocations),
      parentEntityIds: normalized.flatMap((value) => value.parentEntityIds),
      transforms: normalized.flatMap((value) => value.transforms),
    });
  }
  return captureOriginSet({
    schemaVersion: ORIGIN_SCHEMA_VERSION,
    byteRanges: mergeCanonicalLists(normalized, 'byteRanges'),
    virtualRanges: mergeCanonicalLists(normalized, 'virtualRanges'),
    instructionIds: mergeCanonicalLists(normalized, 'instructionIds'),
    operationIds: mergeCanonicalLists(normalized, 'operationIds'),
    sourceLocations: mergeCanonicalLists(normalized, 'sourceLocations'),
    parentEntityIds: mergeCanonicalLists(normalized, 'parentEntityIds'),
    transforms: mergeCanonicalLists(normalized, 'transforms'),
  });
}

export function appendTransform(origin, transform) {
  const base = createOriginSet(origin);
  return mergeOriginSets(base, createOriginSet({ transforms: [transform] }));
}
