import { canonicalAddress, deepFreeze, jsonSafe, stableStringify, validateCanonicalIdentityNumbers } from './index.js';

export const ORIGIN_SCHEMA_VERSION = 1;
const CANONICAL_ORIGIN_SETS = new WeakSet();

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
function uniqueSorted(values) {
  const byKey = new Map(values.map((value) => [stableStringify(value), value]));
  return [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
}
// Provenance payloads must be validated before jsonSafe can erase or round numeric evidence.
function exactJson(value) {
  validateCanonicalIdentityNumbers(value);
  return jsonSafe(value);
}

function byteRange(range) {
  if (!range || typeof range !== 'object') fail('origin-invalid-byte-range');
  const start = bigintValue(range.start ?? range.offset, 'origin-invalid-byte-range');
  const end = range.end != null ? bigintValue(range.end, 'origin-invalid-byte-range')
    : range.length != null ? start + bigintValue(range.length, 'origin-invalid-byte-range') : null;
  if (end == null || start < 0n || end < start) fail('origin-invalid-byte-range');
  return {
    ...(range.binaryId == null ? {} : { binaryId: stringValue(range.binaryId, 'origin-invalid-byte-range') }),
    start: start.toString(),
    end: end.toString(),
  };
}

function virtualRange(range) {
  if (!range || typeof range !== 'object') fail('origin-invalid-virtual-range');
  const start = canonicalAddress(range.start ?? range.address);
  let end;
  if (range.end != null) end = canonicalAddress(range.end);
  else if (range.length != null) end = canonicalAddress(BigInt(start) + bigintValue(range.length, 'origin-invalid-virtual-range'));
  else fail('origin-invalid-virtual-range');
  if (BigInt(end) < BigInt(start)) fail('origin-invalid-virtual-range');
  return {
    ...(range.imageId == null ? {} : { imageId: stringValue(range.imageId, 'origin-invalid-virtual-range') }),
    ...(range.sliceId == null ? {} : { sliceId: stringValue(range.sliceId, 'origin-invalid-virtual-range') }),
    start,
    end,
  };
}

export function createTransformRecord(input = {}) {
  if (!input || typeof input !== 'object') fail('origin-invalid-transform');
  const passId = requiredString(input.passId, 'origin-invalid-transform');
  const passVersion = requiredString(input.passVersion, 'origin-invalid-transform');
  const ruleId = requiredString(input.ruleId, 'origin-invalid-transform');
  const proofKind = requiredString(input.proofKind, 'origin-invalid-transform');
  return deepFreeze({
    passId,
    passVersion,
    ruleId,
    consumedEntityIds: uniqueSorted(stringList(input.consumedEntityIds, 'origin-invalid-consumed-ids')),
    producedEntityIds: uniqueSorted(stringList(input.producedEntityIds, 'origin-invalid-produced-ids')),
    preconditions: exactJson(input.preconditions ?? []),
    proofKind,
    timestampOrBuildId: input.timestampOrBuildId == null ? null : stringValue(input.timestampOrBuildId, 'origin-invalid-transform'),
  });
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
  return frozen;
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
