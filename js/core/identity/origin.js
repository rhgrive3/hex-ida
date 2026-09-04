import { canonicalAddress, deepFreeze, jsonSafe, validateCanonicalIdentityNumbers } from './index.js';

export const ORIGIN_SCHEMA_VERSION = 1;
const CANONICAL_ORIGIN_SETS = new WeakSet();
const CANONICAL_ORIGIN_DIGESTS = new WeakMap();
const CANONICAL_BYTE_RANGES = new WeakSet();
const CANONICAL_VIRTUAL_RANGES = new WeakSet();
const CANONICAL_TRANSFORMS = new WeakSet();
const CANONICAL_SORT_KEYS = new WeakMap();
const ORIGIN_PRIMITIVE_DIGESTS = new Map();
const ORIGIN_DIGEST_VERSION = 'origin-set-merkle-v1';
const ORIGIN_DIGEST_SEEDS = [0x811c9dc5, 0x9e3779b9, 0x243f6a88, 0xb7e15162];
const ORIGIN_DIGEST_PRIMES = [0x01000193, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f];
const ORIGIN_DIGEST_TAG = Object.freeze({
  NULL:1, UNDEFINED:2, STRING:3, FALSE:4, TRUE:5, NUMBER:6,
  NEGATIVE_ZERO:7, BIGINT:8, ARRAY:9, ITEM:10, HOLE:11,
  OBJECT:12, PROPERTY:13, CHILD:14,
});

function originMix(hash, code) {
  hash[0] = Math.imul(hash[0] ^ code, ORIGIN_DIGEST_PRIMES[0]) >>> 0;
  hash[1] = Math.imul(hash[1] ^ code, ORIGIN_DIGEST_PRIMES[1]) >>> 0;
  hash[2] = Math.imul(hash[2] ^ code, ORIGIN_DIGEST_PRIMES[2]) >>> 0;
  hash[3] = Math.imul(hash[3] ^ code, ORIGIN_DIGEST_PRIMES[3]) >>> 0;
}

function originWriteText(hash, text) {
  originMix(hash, text.length);
  for (let index = 0; index < text.length; index += 1) originMix(hash, text.charCodeAt(index));
}

for (const code of ORIGIN_DIGEST_VERSION) originMix(ORIGIN_DIGEST_SEEDS, code.charCodeAt(0));

function originHash(tag) {
  const hash = [...ORIGIN_DIGEST_SEEDS];
  originMix(hash, tag);
  return hash;
}

function originWriteDigest(hash, digest) {
  originMix(hash, ORIGIN_DIGEST_TAG.CHILD);
  originMix(hash, digest[0]);
  originMix(hash, digest[1]);
  originMix(hash, digest[2]);
  originMix(hash, digest[3]);
}

function originPrimitiveDigest(tag, text = null) {
  const key = text == null ? `${tag}` : `${tag}:${text.length}:${text}`;
  const cached = ORIGIN_PRIMITIVE_DIGESTS.get(key);
  if (cached != null) return cached;
  const digest = originHash(tag);
  if (text != null) originWriteText(digest, text);
  if (ORIGIN_PRIMITIVE_DIGESTS.size >= 16384) ORIGIN_PRIMITIVE_DIGESTS.clear();
  ORIGIN_PRIMITIVE_DIGESTS.set(key, digest);
  return digest;
}

function canonicalOriginDigest(value) {
  const memo = new WeakMap();
  const active = new WeakSet();
  const visit = (item) => {
    if (item === null) return originPrimitiveDigest(ORIGIN_DIGEST_TAG.NULL);
    switch (typeof item) {
      case 'undefined': return originPrimitiveDigest(ORIGIN_DIGEST_TAG.UNDEFINED);
      case 'string': return originPrimitiveDigest(ORIGIN_DIGEST_TAG.STRING, item);
      case 'boolean': return originPrimitiveDigest(item ? ORIGIN_DIGEST_TAG.TRUE : ORIGIN_DIGEST_TAG.FALSE);
      case 'number': {
        if (!Number.isFinite(item)) fail('origin-invalid-digest-number');
        return Object.is(item, -0)
          ? originPrimitiveDigest(ORIGIN_DIGEST_TAG.NEGATIVE_ZERO)
          : originPrimitiveDigest(ORIGIN_DIGEST_TAG.NUMBER, String(item));
      }
      case 'bigint': return originPrimitiveDigest(ORIGIN_DIGEST_TAG.BIGINT, String(item));
      case 'function':
      case 'symbol':
        fail('origin-invalid-digest-value');
        break;
      default: break;
    }
    const cached = memo.get(item);
    if (cached != null) return cached;
    if (active.has(item)) fail('origin-invalid-digest-cycle');
    active.add(item);
    try {
      let digest;
      if (Array.isArray(item)) {
        digest = originHash(ORIGIN_DIGEST_TAG.ARRAY);
        originMix(digest, item.length);
        for (let index = 0; index < item.length; index += 1) {
          if (!Object.hasOwn(item, index)) {
            originMix(digest, ORIGIN_DIGEST_TAG.HOLE);
            continue;
          }
          originMix(digest, ORIGIN_DIGEST_TAG.ITEM);
          originWriteDigest(digest, visit(item[index]));
        }
      } else {
        const prototype = Object.getPrototypeOf(item);
        if (prototype !== Object.prototype && prototype !== null) fail('origin-invalid-digest-object');
        const keys = Object.keys(item).sort();
        digest = originHash(ORIGIN_DIGEST_TAG.OBJECT);
        originMix(digest, keys.length);
        for (const key of keys) {
          originMix(digest, ORIGIN_DIGEST_TAG.PROPERTY);
          originWriteText(digest, key);
          originWriteDigest(digest, visit(item[key]));
        }
      }
      memo.set(item, digest);
      return digest;
    } finally {
      active.delete(item);
    }
  };
  return visit(value).map((word) => word.toString(16).padStart(8, '0')).join('');
}

function fail(code) { throw new TypeError(code); }
function arrayList(values, code) {
  if (values == null) return [];
  if (!Array.isArray(values)) fail(code);
  return values;
}
function stringList(values, code) {
  if (values == null) return [];
  if (!Array.isArray(values)) fail(code);
  for (const value of values) {
    if (typeof value !== 'string') fail(code);
  }
  return values.filter(Boolean);
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

// Canonical provenance can contain evidence that JSON text deliberately
// collapses (`-0`/`0`, sparse-array holes/`null`).  A lossy JSON key must never
// decide set membership: doing so discards evidence before the producer-owned
// content digest can distinguish it.  This encoding is exact and framed; it is
// used for ordering/deduplication, not as a probabilistic hash authority.
function canonicalSortKey(root) {
  const active = new WeakSet();
  const visit = (value) => {
    if (value === null) return 'null;';
    switch (typeof value) {
      case 'undefined': return 'undefined;';
      case 'string': return `string:${value.length}:${value};`;
      case 'boolean': return value ? 'boolean:1;' : 'boolean:0;';
      case 'number': {
        if (!Number.isFinite(value)) fail('origin-invalid-sort-number');
        return `number:${Object.is(value, -0) ? '-0' : String(value)};`;
      }
      case 'bigint': return `bigint:${value};`;
      case 'function':
      case 'symbol':
        fail('origin-invalid-sort-value');
        break;
      default: break;
    }
    if (active.has(value)) fail('origin-invalid-sort-cycle');
    active.add(value);
    try {
      if (Array.isArray(value)) {
        let items = '';
        for (let index = 0; index < value.length; index += 1) {
          items += Object.hasOwn(value, index) ? `item:${visit(value[index])}` : 'hole;';
        }
        return `array:${value.length}[${items}]`;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) fail('origin-invalid-sort-object');
      const keys = Object.keys(value).sort();
      return `object:${keys.length}{${keys.map((key) => (
        `key:${key.length}:${key};${visit(value[key])}`
      )).join('')}}`;
    } finally {
      active.delete(value);
    }
  };
  return visit(root);
}

function uniqueSorted(values) {
  const byKey = new Map(values.map((value) => {
    const cached = value != null && typeof value === 'object' ? CANONICAL_SORT_KEYS.get(value) : null;
    return [cached ?? canonicalSortKey(value), value];
  }));
  return [...byKey.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, value]) => value);
}
// Provenance payloads must be validated before jsonSafe can erase or round numeric evidence.
function exactJson(value) {
  validateCanonicalIdentityNumbers(value);
  return jsonSafe(value);
}

function byteRange(range) {
  if (!range || typeof range !== 'object') fail('origin-invalid-byte-range');
  if (CANONICAL_BYTE_RANGES.has(range)) return range;
  const start = bigintValue(range.start ?? range.offset, 'origin-invalid-byte-range');
  const end = range.end != null ? bigintValue(range.end, 'origin-invalid-byte-range')
    : range.length != null ? start + bigintValue(range.length, 'origin-invalid-byte-range') : null;
  if (end == null || start < 0n || end < start) fail('origin-invalid-byte-range');
  const frozen = deepFreeze({
    ...(range.binaryId == null ? {} : { binaryId: stringValue(range.binaryId, 'origin-invalid-byte-range') }),
    start: start.toString(),
    end: end.toString(),
  });
  CANONICAL_BYTE_RANGES.add(frozen);
  CANONICAL_SORT_KEYS.set(frozen, canonicalSortKey(frozen));
  return frozen;
}

function virtualRange(range) {
  if (!range || typeof range !== 'object') fail('origin-invalid-virtual-range');
  if (CANONICAL_VIRTUAL_RANGES.has(range)) return range;
  const start = canonicalAddress(range.start ?? range.address);
  let end;
  if (range.end != null) end = canonicalAddress(range.end);
  else if (range.length != null) end = canonicalAddress(BigInt(start) + bigintValue(range.length, 'origin-invalid-virtual-range'));
  else fail('origin-invalid-virtual-range');
  if (BigInt(end) < BigInt(start)) fail('origin-invalid-virtual-range');
  const frozen = deepFreeze({
    ...(range.imageId == null ? {} : { imageId: stringValue(range.imageId, 'origin-invalid-virtual-range') }),
    ...(range.sliceId == null ? {} : { sliceId: stringValue(range.sliceId, 'origin-invalid-virtual-range') }),
    start,
    end,
  });
  CANONICAL_VIRTUAL_RANGES.add(frozen);
  CANONICAL_SORT_KEYS.set(frozen, canonicalSortKey(frozen));
  return frozen;
}

export function createTransformRecord(input = {}) {
  if (!input || typeof input !== 'object') fail('origin-invalid-transform');
  if (CANONICAL_TRANSFORMS.has(input)) return input;
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
  CANONICAL_TRANSFORMS.add(frozen);
  CANONICAL_SORT_KEYS.set(frozen, canonicalSortKey(frozen));
  return frozen;
}

export function createOriginSet(input = {}) {
  if (input && typeof input === 'object' && CANONICAL_ORIGIN_SETS.has(input)) return input;
  if (input == null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) fail('origin-invalid-set');
  const byteRanges = uniqueSorted(arrayList(input.byteRanges, 'origin-invalid-byte-ranges').map(byteRange));
  const virtualRanges = uniqueSorted(arrayList(input.virtualRanges, 'origin-invalid-virtual-ranges').map(virtualRange));
  const transforms = uniqueSorted(arrayList(input.transforms, 'origin-invalid-transforms').map(createTransformRecord));
  const out = {
    schemaVersion: ORIGIN_SCHEMA_VERSION,
    byteRanges,
    virtualRanges,
    instructionIds: uniqueSorted(stringList(input.instructionIds, 'origin-invalid-instruction-ids')),
    operationIds: uniqueSorted(stringList(input.operationIds ?? input.bytecodeOperationIds, 'origin-invalid-operation-ids')),
    sourceLocations: uniqueSorted(arrayList(input.sourceLocations, 'origin-invalid-source-locations').map(exactJson)),
    parentEntityIds: uniqueSorted(stringList(input.parentEntityIds, 'origin-invalid-parent-ids')),
    transforms,
  };
  const frozen = deepFreeze(out);
  CANONICAL_ORIGIN_SETS.add(frozen);
  CANONICAL_ORIGIN_DIGESTS.set(frozen, canonicalOriginDigest(frozen));
  return frozen;
}

export function canonicalOriginSetDigest(value) {
  return value != null && typeof value === 'object' ? CANONICAL_ORIGIN_DIGESTS.get(value) ?? null : null;
}

export function mergeOriginSets(...sets) {
  const normalized = sets.filter((value) => value != null).map((value) => createOriginSet(value));
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

export function appendTransform(origin, transform) {
  const base = createOriginSet(origin);
  return mergeOriginSets(base, createOriginSet({ transforms: [transform] }));
}
