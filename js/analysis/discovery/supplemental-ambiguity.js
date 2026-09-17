import { deepFreeze } from '../../core/identity/index.js';
import { canonicalTypedDigest, canonicalTypedValue } from './canonical-value.js';

const MAX_COLLISION_CHECKS = 400000;

function fail(code) { throw new TypeError(code); }
function own(value, key, code) {
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
  catch { fail(code); }
  if (descriptor == null) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) fail(code);
  return descriptor.value;
}
function record(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(code);
  return value;
}
function items(value, code, maximum) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail(code);
  if (value.length > maximum) fail('discovery-artifact-budget-exhausted');
  const out = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor == null || !Object.hasOwn(descriptor, 'value')) fail(code);
    out.push(descriptor.value);
  }
  return out;
}
function address(value, code) {
  if (value == null) fail(code);
  const type = typeof value;
  if (type !== 'bigint' && type !== 'string' && !(type === 'number' && Number.isSafeInteger(value))) fail(code);
  if (type === 'string' && (value.length === 0 || value.trim() !== value)) fail(code);
  try {
    const result = BigInt(value);
    if (result < 0n) fail(code);
    return result.toString();
  } catch { fail(code); }
}
function optionalAddress(value, code) { return value == null ? null : address(value, code); }
function optionalText(value, code) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) fail(code);
  return value;
}
function compareAddress(left, right) {
  const a = BigInt(left); const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

function normalizeInterval(raw, architectureId) {
  const value = record(raw, 'discovery-artifact-supplemental-interval-invalid');
  const kind = own(value, 'kind', 'discovery-artifact-supplemental-interval-kind-invalid') ?? 'data';
  if (kind !== 'data' && kind !== 'code') fail('discovery-artifact-supplemental-interval-kind-invalid');
  const start = address(own(value, 'start', 'discovery-artifact-supplemental-interval-start-invalid'), 'discovery-artifact-supplemental-interval-start-invalid');
  const end = address(own(value, 'end', 'discovery-artifact-supplemental-interval-end-invalid'), 'discovery-artifact-supplemental-interval-end-invalid');
  if (BigInt(end) <= BigInt(start)) fail('discovery-artifact-supplemental-interval-range-invalid');
  const payload = {
    kind,
    start,
    end,
    candidateStart: optionalAddress(own(value, 'candidateStart', 'discovery-artifact-supplemental-interval-candidate-invalid'), 'discovery-artifact-supplemental-interval-candidate-invalid'),
    architectureId,
    producerId: optionalText(own(value, 'producerId', 'discovery-artifact-supplemental-interval-producer-invalid'), 'discovery-artifact-supplemental-interval-producer-invalid'),
    origin: own(value, 'origin', 'discovery-artifact-supplemental-interval-origin-invalid') == null
      ? null : canonicalTypedValue(own(value, 'origin', 'discovery-artifact-supplemental-interval-origin-invalid')),
  };
  return deepFreeze({ intervalId: `discovery-interval:${canonicalTypedDigest(payload)}`, ...payload });
}

function dataIntervals(image, explicit, artifact) {
  const maximum = artifact.budget.maxIntervals;
  const source = explicit ?? own(image, 'byteIntervals', 'discovery-artifact-image-byteIntervals-invalid');
  if (source != null) return items(source, 'discovery-artifact-image-byteIntervals-invalid', maximum).map((item) => normalizeInterval(item, artifact.binding.architectureId));
  const raw = items(own(image, 'dataInCode', 'discovery-artifact-image-dataInCode-invalid') ?? [], 'discovery-artifact-image-dataInCode-invalid', maximum);
  return raw.map((item) => {
    const value = record(item, 'discovery-artifact-data-in-code-invalid');
    const start = address(own(value, 'address', 'discovery-artifact-data-in-code-address-invalid'), 'discovery-artifact-data-in-code-address-invalid');
    const length = own(value, 'length', 'discovery-artifact-data-in-code-length-invalid');
    if (!Number.isSafeInteger(length) || length <= 0) fail('discovery-artifact-data-in-code-length-invalid');
    return normalizeInterval({
      kind: 'data', start, end: (BigInt(start) + BigInt(length)).toString(),
      producerId: 'binary-image.data-in-code',
      origin: own(value, 'kindName', 'discovery-artifact-data-in-code-kind-invalid') ?? 'data-in-code',
    }, artifact.binding.architectureId);
  });
}

function reference(kind, raw, artifact) {
  const value = raw != null && typeof raw === 'object' && !Array.isArray(raw)
    ? record(raw, 'discovery-artifact-supplemental-reference-invalid') : { address: raw };
  const target = own(value, 'address', 'discovery-artifact-supplemental-reference-address-invalid')
    ?? own(value, 'target', 'discovery-artifact-supplemental-reference-address-invalid');
  const sourceRaw = kind === 'jump-table'
    ? (own(value, 'tableAddress', 'discovery-artifact-supplemental-reference-source-invalid')
      ?? own(value, 'sourceAddress', 'discovery-artifact-supplemental-reference-source-invalid'))
    : (own(value, 'sourceAddress', 'discovery-artifact-supplemental-reference-source-invalid')
      ?? own(value, 'addressOfReference', 'discovery-artifact-supplemental-reference-source-invalid')
      ?? own(value, 'tableAddress', 'discovery-artifact-supplemental-reference-source-invalid'));
  const expression = own(value, 'symbolicExpression', 'discovery-artifact-supplemental-reference-expression-invalid')
    ?? own(value, 'expression', 'discovery-artifact-supplemental-reference-expression-invalid');
  const payload = {
    kind,
    address: address(target, 'discovery-artifact-supplemental-reference-address-invalid'),
    sourceAddress: optionalAddress(sourceRaw, 'discovery-artifact-supplemental-reference-source-invalid'),
    architectureId: artifact.binding.architectureId,
    relocationId: optionalText(own(value, 'id', 'discovery-artifact-supplemental-reference-id-invalid'), 'discovery-artifact-supplemental-reference-id-invalid'),
    tableId: optionalText(own(value, 'tableId', 'discovery-artifact-supplemental-reference-id-invalid'), 'discovery-artifact-supplemental-reference-id-invalid'),
    symbolicExpression: expression == null ? null : canonicalTypedValue(expression),
  };
  return deepFreeze({ memberId: `discovery-reference:${canonicalTypedDigest(payload)}`, ...payload });
}

function rawReferences(image, artifact) {
  const maximum = artifact.budget.maxReferences;
  const result = [];
  for (const [key, kind] of [['relocationTargets', 'relocation'], ['jumpTableTargets', 'jump-table'], ['vtableEntries', 'vtable']]) {
    const raw = items(own(image, key, `discovery-artifact-image-${key}-invalid`) ?? [], `discovery-artifact-image-${key}-invalid`, maximum);
    for (const item of raw) {
      if (result.length >= maximum) fail('discovery-artifact-budget-exhausted');
      result.push(reference(kind, item, artifact));
    }
  }
  return result;
}

function codeIntervals(artifact) {
  const out = [];
  for (const candidate of artifact.functionCandidates) {
    for (const region of candidate.regions) {
      out.push({
        intervalId: `candidate-region:${candidate.candidateId}:${region.start}:${region.end}`,
        kind: 'code',
        start: region.start,
        end: region.end,
        candidateStart: candidate.start,
      });
    }
  }
  return out.sort((a, b) => compareAddress(a.start, b.start) || compareAddress(a.end, b.end) || compareText(a.intervalId, b.intervalId));
}
function intervalMember(interval) {
  return { memberId: interval.intervalId, kind: interval.kind, start: interval.start, end: interval.end, candidateStart: interval.candidateStart ?? null };
}
function referenceMember(item) {
  return { memberId: item.memberId, kind: `${item.kind}-reference`, address: item.address, sourceAddress: item.sourceAddress ?? null, relocationId: item.relocationId ?? null, tableId: item.tableId ?? null };
}
function collision(kind, alternatives, range = null, at = null) {
  const ordered = alternatives.slice().sort((a, b) => compareText(a.memberId, b.memberId));
  const payload = { kind, range, at, alternatives: ordered, resolution: 'unresolved' };
  return deepFreeze({ collisionId: `discovery-collision:${canonicalTypedDigest(payload)}`, ...payload });
}
function supplementalCollisions(artifact, supplementalIntervals, supplementalReferences) {
  if (supplementalIntervals.length === 0 && supplementalReferences.length === 0) return [];
  const code = codeIntervals(artifact);
  const all = [...code, ...supplementalIntervals].sort((a, b) => compareAddress(a.start, b.start) || compareAddress(a.end, b.end));
  const found = new Map();
  let checks = 0;
  const consume = () => { if (++checks > MAX_COLLISION_CHECKS) fail('discovery-artifact-collision-budget-exhausted'); };
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      if (BigInt(all[j].start) >= BigInt(all[i].end)) break;
      consume();
      if (BigInt(all[i].start) >= BigInt(all[j].end)) continue;
      const distinctFunctions = all[i].kind === 'code' && all[j].kind === 'code'
        && all[i].candidateStart != null && all[j].candidateStart != null && all[i].candidateStart !== all[j].candidateStart;
      const codeData = all[i].kind !== all[j].kind;
      if (!distinctFunctions && !codeData) continue;
      const start = BigInt(all[i].start) > BigInt(all[j].start) ? all[i].start : all[j].start;
      const end = BigInt(all[i].end) < BigInt(all[j].end) ? all[i].end : all[j].end;
      const item = collision(distinctFunctions ? 'function-overlap' : 'code-data', [intervalMember(all[i]), intervalMember(all[j])], { start, end });
      found.set(item.collisionId, item);
    }
  }
  for (const ref of supplementalReferences) {
    for (const interval of code) {
      consume();
      if (BigInt(interval.start) < BigInt(ref.address) && BigInt(ref.address) < BigInt(interval.end) && interval.candidateStart !== ref.address) {
        const item = collision('code-reference', [intervalMember(interval), referenceMember(ref)], null, ref.address);
        found.set(item.collisionId, item);
      }
    }
  }
  return [...found.values()].sort((a, b) => compareText(a.collisionId, b.collisionId));
}

export function augmentDiscoveryPayload(artifact, rawImage = {}, options = {}) {
  const image = record(rawImage ?? {}, 'discovery-artifact-image-invalid');
  const supplementalIntervals = dataIntervals(image, options.byteIntervals ?? null, artifact);
  const supplementalReferences = rawReferences(image, artifact);
  const intervalMap = new Map(artifact.intervalClaims.map((item) => [item.intervalId, item]));
  for (const item of supplementalIntervals) intervalMap.set(item.intervalId, item);
  const referenceMap = new Map(artifact.references.map((item) => [item.memberId, item]));
  for (const item of supplementalReferences) referenceMap.set(item.memberId, item);
  const collisionMap = new Map(artifact.collisionSets.map((item) => [item.collisionId, item]));
  for (const item of supplementalCollisions(artifact, supplementalIntervals, supplementalReferences)) collisionMap.set(item.collisionId, item);
  const intervalClaims = [...intervalMap.values()].sort((a, b) => compareAddress(a.start, b.start) || compareAddress(a.end, b.end) || compareText(a.intervalId, b.intervalId));
  const references = [...referenceMap.values()].sort((a, b) => compareAddress(a.address, b.address) || compareText(a.memberId, b.memberId));
  if (intervalClaims.length > artifact.budget.maxIntervals || references.length > artifact.budget.maxReferences) fail('discovery-artifact-budget-exhausted');
  const payload = { ...artifact, intervalClaims, references, collisionSets: [...collisionMap.values()].sort((a, b) => compareText(a.collisionId, b.collisionId)) };
  delete payload.artifactId;
  return payload;
}
