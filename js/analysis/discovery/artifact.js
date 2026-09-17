/**
 * HEX-X-03 / T016 — ambiguity-preserving discovery artifact.
 * Unified implementation supporting both v1 and v2 schemas.
 */

import { deepFreeze, stableDigest } from '../../core/identity/index.js';
import { createAnalysisStatus } from '../status.js';
import { createDiscoveryEvidence, createFunctionCandidate, hasExactStart } from './candidates.js';
import { DiscoveryProducerRegistry, fuseFunctionCandidates } from './fusion.js';
import { GENERIC_PRODUCERS, isCanonicalDiscoveryProducer } from './producers.js';
import { canonicalTypedDigest, canonicalTypedString } from './canonical-value.js';

export const DISCOVERY_ARTIFACT_SCHEMA = 'hex-discovery-ambiguity-artifact/v2';
export const DISCOVERY_ARTIFACT_SCHEMA_V1 = 'hex-discovery-ambiguity-artifact/v1';
export const DISCOVERY_REBUILD_BINDING_SCHEMA = 'hex-discovery-rebuild-binding/v2';
export const DISCOVERY_REBUILD_BINDING_SCHEMA_V1 = 'hex-discovery-rebuild-binding/v1';
export const DISCOVERY_ARTIFACT_DEFAULT_BUDGET = deepFreeze({
  maxEvidence: 200000,
  maxCandidates: 200000,
  maxProducerRuns: 1024,
  maxIntervals: 400000,
  maxReferences: 200000,
  maxCollisionChecks: 2000000,
});

const REFERENCE_KINDS = new Set(['relocation-target', 'vtable-entry']);
const INTERVAL_KINDS = new Set(['code', 'data', 'padding', 'unsupported']);
const ISSUED_ARTIFACTS = new WeakSet();
const ISSUED_REBUILD_BINDINGS = new WeakSet();

function fail(code) { throw new TypeError(code); }

function compareText(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareAddress(left, right) {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function address(value, code) {
  const type = typeof value;
  if (type !== 'bigint' && type !== 'string' && !(type === 'number' && Number.isSafeInteger(value))) fail(code);
  if (type === 'string' && value.trim().length === 0) fail(code);
  try {
    const result = BigInt(value);
    if (result < 0n) fail(code);
    return result.toString();
  } catch {
    fail(code);
    return '0';
  }
}

// === V1 (HEX-X-03) SUBSYSTEM ===
function requiredString(value, code) {
  if (typeof value !== 'string' || value.trim() === '' || value.trim() !== value) fail(code);
  return value;
}

function optionalString(value, code) {
  if (value == null) return null;
  return requiredString(value, code);
}

function plainRecord(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  let prototype;
  try { prototype = Object.getPrototypeOf(value); } catch { fail(code); }
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  return value;
}

function objectRecord(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}

function ownData(value, key, code) {
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { fail(code); }
  if (descriptor == null) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) fail(code);
  return descriptor.value;
}

function denseArray(value, code) {
  if (!Array.isArray(value)) fail(code);
  const out = [];
  for (let index = 0; index < value.length; index += 1) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, String(index)); } catch { fail(code); }
    if (descriptor == null || !Object.hasOwn(descriptor, 'value')) fail(code);
    out.push(descriptor.value);
  }
  return out;
}

function ownArray(value, key, code) {
  const raw = ownData(value, key, code) ?? [];
  if (!Array.isArray(raw)) fail(code);
  return raw;
}

function canonicalTypedValue(value, code, seen = new WeakSet()) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return { $type: 'bigint', value: value.toString() };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(code);
    return Object.is(value, -0) ? { $type: 'number', value: '-0' } : value;
  }
  if (typeof value !== 'object' || seen.has(value)) fail(code);
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = denseArray(value, code).map((item) => canonicalTypedValue(item, code, seen));
  } else if (ArrayBuffer.isView(value)) {
    result = { $type: value.constructor?.name ?? 'TypedArray', value: Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
  } else if (value instanceof ArrayBuffer) {
    result = { $type: 'ArrayBuffer', value: Array.from(new Uint8Array(value)) };
  } else {
    plainRecord(value, code);
    let descriptors;
    try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { fail(code); }
    result = {};
    for (const key of Object.keys(descriptors).sort(compareText)) {
      if (key === '__proto__') fail(code);
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, 'value')) fail(code);
      Object.defineProperty(result, key, {
        value: canonicalTypedValue(descriptor.value, code, seen),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  seen.delete(value);
  return result;
}

function budgetValueV1(input, name) {
  const fallback = DISCOVERY_ARTIFACT_DEFAULT_BUDGET[name];
  const value = ownData(input, name, `discovery-artifact-budget-${name}-invalid`);
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > fallback) {
    fail(`discovery-artifact-budget-${name}-invalid`);
  }
  return value;
}

export function normalizeDiscoveryArtifactBudget(input = {}) {
  plainRecord(input, 'discovery-artifact-budget-invalid');
  return deepFreeze(Object.fromEntries(
    Object.keys(DISCOVERY_ARTIFACT_DEFAULT_BUDGET).map((name) => [name, budgetValueV1(input, name)]),
  ));
}

function normalizeBindingV1(input = {}) {
  plainRecord(input, 'discovery-artifact-binding-invalid');
  return deepFreeze({
    binaryId: optionalString(ownData(input, 'binaryId', 'discovery-artifact-binary-id-invalid'), 'discovery-artifact-binary-id-invalid'),
    sourceHash: optionalString(ownData(input, 'sourceHash', 'discovery-artifact-source-hash-invalid'), 'discovery-artifact-source-hash-invalid'),
    snapshotId: optionalString(ownData(input, 'snapshotId', 'discovery-artifact-snapshot-id-invalid'), 'discovery-artifact-snapshot-id-invalid'),
    architectureId: optionalString(ownData(input, 'architectureId', 'discovery-artifact-architecture-id-invalid'), 'discovery-artifact-architecture-id-invalid'),
  });
}

function normalizeProducerRunV1(input) {
  plainRecord(input, 'discovery-artifact-producer-run-invalid');
  const id = requiredString(ownData(input, 'id', 'discovery-artifact-producer-id-invalid'), 'discovery-artifact-producer-id-invalid');
  const evidenceCount = ownData(input, 'evidenceCount', 'discovery-artifact-producer-evidence-count-invalid') ?? 0;
  if (!Number.isSafeInteger(evidenceCount) || evidenceCount < 0) fail('discovery-artifact-producer-evidence-count-invalid');
  return deepFreeze({
    id,
    version: optionalString(ownData(input, 'version', 'discovery-artifact-producer-version-invalid'), 'discovery-artifact-producer-version-invalid') ?? '1',
    architectureId: optionalString(ownData(input, 'architectureId', 'discovery-artifact-producer-architecture-invalid'), 'discovery-artifact-producer-architecture-invalid'),
    evidenceCount,
  });
}

function normalizeIntervalV1(input) {
  plainRecord(input, 'discovery-artifact-interval-invalid');
  const start = address(ownData(input, 'start', 'discovery-artifact-interval-start-invalid'), 'discovery-artifact-interval-start-invalid');
  const end = address(ownData(input, 'end', 'discovery-artifact-interval-end-invalid'), 'discovery-artifact-interval-end-invalid');
  if (BigInt(end) <= BigInt(start)) fail('discovery-artifact-interval-empty');
  const kind = requiredString(ownData(input, 'kind', 'discovery-artifact-interval-kind-invalid'), 'discovery-artifact-interval-kind-invalid');
  if (!INTERVAL_KINDS.has(kind)) fail('discovery-artifact-interval-kind-invalid');
  const payload = {
    kind,
    start,
    end,
    ownership: optionalString(ownData(input, 'ownership', 'discovery-artifact-interval-ownership-invalid'), 'discovery-artifact-interval-ownership-invalid'),
    candidateStart: ownData(input, 'candidateStart', 'discovery-artifact-interval-candidate-invalid') == null
      ? null : address(ownData(input, 'candidateStart', 'discovery-artifact-interval-candidate-invalid'), 'discovery-artifact-interval-candidate-invalid'),
    producerId: optionalString(ownData(input, 'producerId', 'discovery-artifact-interval-producer-invalid'), 'discovery-artifact-interval-producer-invalid'),
    evidenceIds: (() => {
      const raw = ownData(input, 'evidenceIds', 'discovery-artifact-interval-evidence-invalid') ?? [];
      const ids = denseArray(raw, 'discovery-artifact-interval-evidence-invalid')
        .map((id) => requiredString(id, 'discovery-artifact-interval-evidence-invalid'));
      return [...new Set(ids)].sort(compareText);
    })(),
    origin: optionalString(ownData(input, 'origin', 'discovery-artifact-interval-origin-invalid'), 'discovery-artifact-interval-origin-invalid'),
  };
  return deepFreeze({ intervalId: `discovery-interval:${stableDigest(payload)}`, ...payload });
}

function inferredIntervalsV1(evidence) {
  const out = [];
  for (const item of evidence) {
    for (const region of item.regions) {
      out.push(normalizeIntervalV1({
        kind: 'code',
        start: region.start,
        end: region.end,
        ownership: region.ownership,
        candidateStart: item.start,
        producerId: item.producerId,
        evidenceIds: item.evidenceIds,
        origin: 'discovery-evidence',
      }));
    }
  }
  return out;
}

function referenceKindV1(value) {
  const kind = requiredString(value, 'discovery-artifact-reference-kind-invalid');
  if (!['relocation', 'jump-table', 'vtable'].includes(kind)) fail('discovery-artifact-reference-kind-invalid');
  return kind;
}

function normalizeReferenceV1(input) {
  plainRecord(input, 'discovery-artifact-reference-invalid');
  const kind = referenceKindV1(ownData(input, 'kind', 'discovery-artifact-reference-kind-invalid'));
  const payload = {
    kind,
    address: address(ownData(input, 'address', 'discovery-artifact-reference-address-invalid'), 'discovery-artifact-reference-address-invalid'),
    sourceAddress: ownData(input, 'sourceAddress', 'discovery-artifact-reference-source-invalid') == null
      ? null : address(ownData(input, 'sourceAddress', 'discovery-artifact-reference-source-invalid'), 'discovery-artifact-reference-source-invalid'),
    relocationId: optionalString(ownData(input, 'relocationId', 'discovery-artifact-reference-relocation-invalid'), 'discovery-artifact-reference-relocation-invalid'),
    tableId: optionalString(ownData(input, 'tableId', 'discovery-artifact-reference-table-invalid'), 'discovery-artifact-reference-table-invalid'),
    symbolicExpression: ownData(input, 'symbolicExpression', 'discovery-artifact-reference-expression-invalid') == null
      ? null : canonicalTypedValue(ownData(input, 'symbolicExpression', 'discovery-artifact-reference-expression-invalid'), 'discovery-artifact-reference-expression-invalid'),
  };
  return deepFreeze({ referenceId: `discovery-reference:${stableDigest(payload)}`, ...payload });
}

function normalizeCandidateV1(input) {
  const candidate = createFunctionCandidate(input);
  // X-03 is not another exactness authority.  It records the current working
  // candidate view plus the alternatives that view left unresolved.  In
  // particular, no score, confidence, producer id, or artifact-local flag can
  // promote a candidate to exact truth.
  const conflicts = candidate.conflicts
    .map((item) => canonicalTypedValue(item, 'discovery-artifact-candidate-conflict-invalid'));
  const conflictDigests = conflicts.map((item) => stableDigest(item)).sort(compareText);
  const identity = { start: candidate.start, architectureId: candidate.architectureId };
  return deepFreeze({
    candidateId: `discovery-candidate:${stableDigest(identity)}`,
    start: candidate.start,
    name: candidate.name,
    regions: candidate.regions,
    startState: candidate.startState,
    extentState: candidate.extentState,
    digest: candidate.digest,
    ambiguous: candidate.startState !== 'exact' || candidate.extentState !== 'exact' || conflicts.length > 0,
    conflicts,
    conflictDigests,
    startEvidenceIds: [...new Set(candidate.startEvidence.flatMap((item) => item.evidenceIds))].sort(compareText),
    extentEvidenceIds: [...new Set(candidate.extentEvidence.flatMap((item) => item.evidenceIds))].sort(compareText),
  });
}

function intervalCompareV1(left, right) {
  return compareAddress(left.start, right.start)
    || compareAddress(left.end, right.end)
    || compareText(left.kind, right.kind)
    || compareText(left.intervalId, right.intervalId);
}

function referenceCompareV1(left, right) {
  return compareAddress(left.address, right.address)
    || compareText(left.kind, right.kind)
    || compareText(left.referenceId, right.referenceId);
}

function collisionV1(kind, alternatives, range = null, at = null) {
  const ordered = alternatives.slice().sort((left, right) => compareText(left.memberId, right.memberId));
  const payload = { kind, range, at, alternatives: ordered, resolution: 'unresolved' };
  return deepFreeze({ collisionId: `discovery-collisionV1:${stableDigest(payload)}`, ...payload });
}

function intervalMemberV1(interval) {
  return deepFreeze({
    memberId: interval.intervalId,
    kind: interval.kind,
    start: interval.start,
    end: interval.end,
    candidateStart: interval.candidateStart,
    producerId: interval.producerId,
    evidenceIds: interval.evidenceIds,
  });
}

function candidateMemberV1(candidate) {
  return deepFreeze({
    memberId: candidate.candidateId,
    kind: 'function-start',
    start: candidate.start,
    candidateStart: candidate.start,
    startState: candidate.startState,
    extentState: candidate.extentState,
    conflictDigests: candidate.conflictDigests,
  });
}

function referenceMemberV1(reference) {
  return deepFreeze({
    memberId: reference.referenceId,
    kind: `${reference.kind}-reference`,
    address: reference.address,
    sourceAddress: reference.sourceAddress,
    relocationId: reference.relocationId,
    tableId: reference.tableId,
  });
}

function buildCollisionsV1(intervals, candidates, references, budget) {
  let checks = 0;
  const collisions = new Map();
  const consume = () => {
    checks += 1;
    return checks <= budget.maxCollisionChecks;
  };

  for (let leftIndex = 0; leftIndex < intervals.length; leftIndex += 1) {
    const left = intervals[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < intervals.length; rightIndex += 1) {
      const right = intervals[rightIndex];
      if (BigInt(right.start) >= BigInt(left.end)) break;
      if (!consume()) return { ok: false, reason: 'collisionV1-work', checks, collisions: [] };
      if (BigInt(left.start) >= BigInt(right.end)) continue;
      const distinctFunctions = left.kind === 'code' && right.kind === 'code'
        && left.candidateStart != null && right.candidateStart != null
        && left.candidateStart !== right.candidateStart;
      const codeData = (left.kind === 'code' && right.kind === 'data')
        || (left.kind === 'data' && right.kind === 'code');
      if (!distinctFunctions && !codeData) continue;
      const start = BigInt(left.start) > BigInt(right.start) ? left.start : right.start;
      const end = BigInt(left.end) < BigInt(right.end) ? left.end : right.end;
      const item = collisionV1(distinctFunctions ? 'function-overlap' : 'code-data', [intervalMemberV1(left), intervalMemberV1(right)], { start, end });
      collisions.set(item.collisionId, item);
    }
  }

  const codeIntervals = intervals.filter((interval) => interval.kind === 'code');
  for (const interval of codeIntervals) {
    for (const candidate of candidates) {
      if (!consume()) return { ok: false, reason: 'collisionV1-work', checks, collisions: [] };
      if (interval.candidateStart === candidate.start) continue;
      if (BigInt(interval.start) < BigInt(candidate.start) && BigInt(candidate.start) < BigInt(interval.end)) {
        const item = collisionV1('function-contained-start', [intervalMemberV1(interval), candidateMemberV1(candidate)], null, candidate.start);
        collisions.set(item.collisionId, item);
      }
    }
  }

  for (const reference of references) {
    for (const interval of codeIntervals) {
      if (!consume()) return { ok: false, reason: 'collisionV1-work', checks, collisions: [] };
      if (BigInt(interval.start) < BigInt(reference.address) && BigInt(reference.address) < BigInt(interval.end)
          && interval.candidateStart !== reference.address) {
        const item = collisionV1('code-reference', [intervalMemberV1(interval), referenceMemberV1(reference)], null, reference.address);
        collisions.set(item.collisionId, item);
      }
    }
  }

  return {
    ok: true,
    reason: null,
    checks,
    collisions: [...collisions.values()].sort((left, right) => compareText(left.collisionId, right.collisionId)),
  };
}

function resourceStateV1(ok, reason, budget, counts, collisionChecks = 0) {
  return deepFreeze({ ok, reason, budget, observed: deepFreeze({ ...counts, collisionChecks }) });
}

function issueArtifactV1(payload) {
  const artifact = deepFreeze({ artifactId: `discovery-artifact:${stableDigest(payload)}`, ...payload });
  ISSUED_ARTIFACTS.add(artifact);
  return artifact;
}

function artifactIdentityValidV1(artifact) {
  if (!artifact || !ISSUED_ARTIFACTS.has(artifact) || artifact.schemaVersion !== DISCOVERY_ARTIFACT_SCHEMA_V1) return false;
  const payload = { ...artifact };
  delete payload.artifactId;
  return artifact.artifactId === `discovery-artifact:${stableDigest(payload)}`;
}



function withheldArtifactV1({ binding, status, producerRuns, resource, reason }) {
  return issueArtifactV1({
    schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_V1,
    binding,
    producerRuns,
    status,
    publication: deepFreeze({ status: 'withheld', reason }),
    resource,
    evidence: [],
    functionCandidates: [],
    intervalClaims: [],
    collisionSets: [],
    references: [],
  });
}

/**
 * Build a canonical artifact from the current fusion's inputs and output.
 * Nothing in this function performs a second/private candidate fusion.
 */
function createDiscoveryArtifactV1(input = {}) {
  plainRecord(input, 'discovery-artifact-input-invalid');
  const budget = normalizeDiscoveryArtifactBudget(ownData(input, 'artifactBudget', 'discovery-artifact-budget-invalid') ?? {});
  const binding = normalizeBindingV1(ownData(input, 'binding', 'discovery-artifact-binding-invalid') ?? {});
  const status = plainRecord(ownData(input, 'status', 'discovery-artifact-status-invalid'), 'discovery-artifact-status-invalid');
  const evidenceInput = ownArray(input, 'evidence', 'discovery-artifact-evidence-invalid');
  const candidatesInput = ownArray(input, 'candidates', 'discovery-artifact-candidates-invalid');
  const intervalsInput = ownArray(input, 'byteIntervals', 'discovery-artifact-intervals-invalid');
  const referencesInput = ownArray(input, 'references', 'discovery-artifact-references-invalid');
  const producerRunsInput = ownArray(input, 'producerRuns', 'discovery-artifact-producer-runs-invalid');

  // Cardinality checks happen before descriptor traversal/canonicalization so a
  // malformed or gigantic container cannot turn X-03 into an unbounded side
  // path around current-main discovery budgets.
  const counts = {
    evidence: evidenceInput.length,
    candidates: candidatesInput.length,
    intervals: intervalsInput.length,
    references: referencesInput.length,
    producerRuns: producerRunsInput.length,
  };
  for (const [name, observed, maximum] of [
    ['evidence', counts.evidence, budget.maxEvidence],
    ['candidates', counts.candidates, budget.maxCandidates],
    ['intervals', counts.intervals, budget.maxIntervals],
    ['references', counts.references, budget.maxReferences],
    ['producerRuns', counts.producerRuns, budget.maxProducerRuns],
  ]) {
    if (observed > maximum) {
      const resource = resourceStateV1(false, `${name}-budget`, budget, counts);
      return withheldArtifactV1({ binding, status, producerRuns: [], resource, reason: `artifact-budget-exhausted:${name}` });
    }
  }
  const forcedResourceReason = optionalString(
    ownData(input, 'resourceLimitReason', 'discovery-artifact-resource-limit-reason-invalid'),
    'discovery-artifact-resource-limit-reason-invalid',
  );
  if (forcedResourceReason != null) {
    const resource = resourceStateV1(false, forcedResourceReason, budget, counts);
    return withheldArtifactV1({ binding, status, producerRuns: [], resource, reason: `artifact-budget-exhausted:${forcedResourceReason}` });
  }

  const evidenceRaw = denseArray(evidenceInput, 'discovery-artifact-evidence-invalid');
  const candidatesRaw = denseArray(candidatesInput, 'discovery-artifact-candidates-invalid');
  const intervalsRaw = denseArray(intervalsInput, 'discovery-artifact-intervals-invalid');
  const referencesRaw = denseArray(referencesInput, 'discovery-artifact-references-invalid');
  const producerRuns = denseArray(producerRunsInput, 'discovery-artifact-producer-runs-invalid')
    .map(normalizeProducerRunV1)
    .sort((left, right) => compareText(left.id, right.id) || compareText(left.version, right.version));

  const evidence = evidenceRaw.map((item) => createDiscoveryEvidence(item))
    .sort((left, right) => compareText(stableDigest(left), stableDigest(right)));
  const candidates = candidatesRaw.map(normalizeCandidateV1)
    .sort((left, right) => compareAddress(left.start, right.start) || compareText(left.candidateId, right.candidateId));
  const suppliedIntervals = intervalsRaw.map(normalizeIntervalV1);
  const inferred = inferredIntervalsV1(evidence);
  if (suppliedIntervals.length + inferred.length > budget.maxIntervals) {
    const resource = resourceStateV1(false, 'intervals-budget', budget, { ...counts, intervals: suppliedIntervals.length + inferred.length });
    return withheldArtifactV1({ binding, status, producerRuns, resource, reason: 'artifact-budget-exhausted:intervals' });
  }
  const intervals = [...suppliedIntervals, ...inferred].sort(intervalCompareV1);
  const duplicateInterval = intervals.find((interval, index) => index > 0 && interval.intervalId === intervals[index - 1].intervalId);
  if (duplicateInterval) fail('discovery-artifact-interval-duplicate');
  const references = referencesRaw.map(normalizeReferenceV1).sort(referenceCompareV1);
  const collisionResult = buildCollisionsV1(intervals, candidates, references, budget);
  const resource = resourceStateV1(collisionResult.ok, collisionResult.reason, budget, {
    ...counts,
    intervals: intervals.length,
  }, collisionResult.checks);
  if (!collisionResult.ok) {
    return withheldArtifactV1({ binding, status, producerRuns, resource, reason: `artifact-budget-exhausted:${collisionResult.reason}` });
  }

  const completeness = ownData(status, 'completeness', 'discovery-artifact-status-completeness-invalid');
  const stopReason = ownData(status, 'stopReason', 'discovery-artifact-status-stop-reason-invalid');
  let publicationReason = null;
  if (completeness !== 'complete' || stopReason != null) publicationReason = stopReason ?? 'analysis-incomplete';
  if (binding.snapshotId != null && ownData(status, 'snapshotId', 'discovery-artifact-status-snapshot-invalid') !== binding.snapshotId
      && publicationReason == null) publicationReason = 'stale-status-snapshotId';
  const runsById = new Map();
  for (const run of producerRuns) {
    if (runsById.has(run.id) && publicationReason == null) publicationReason = `producer-identity-duplicate:${run.id}`;
    runsById.set(run.id, run);
  }
  const evidenceCounts = new Map();
  for (const item of evidence) {
    evidenceCounts.set(item.producerId, (evidenceCounts.get(item.producerId) ?? 0) + 1);
    if ((!runsById.has(item.producerId) || item.producerId === 'unknown') && publicationReason == null) {
      publicationReason = `producer-identity-mismatch:${item.producerId}`;
    }
  }
  for (const run of producerRuns) {
    if (run.evidenceCount !== (evidenceCounts.get(run.id) ?? 0) && publicationReason == null) {
      publicationReason = `producer-evidence-count-mismatch:${run.id}`;
    }
  }
  for (const key of ['binaryId', 'sourceHash', 'snapshotId', 'architectureId']) {
    if (binding[key] == null && publicationReason == null) publicationReason = `identity-unbound:${key}`;
  }
  const expectedBindingRaw = ownData(input, 'expectedBinding', 'discovery-artifact-expected-binding-invalid');
  if (expectedBindingRaw != null) {
    const expectedBinding = normalizeBindingV1(expectedBindingRaw);
    for (const key of ['binaryId', 'sourceHash', 'snapshotId', 'architectureId']) {
      if (expectedBinding[key] != null && binding[key] !== expectedBinding[key] && publicationReason == null) {
        publicationReason = `stale-${key}`;
      }
    }
  }

  const payload = {
    schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_V1,
    binding,
    producerRuns,
    status: deepFreeze({
      completeness,
      stopReason: stopReason ?? null,
      analyzerId: ownData(status, 'analyzerId', 'discovery-artifact-status-analyzer-invalid') ?? null,
      analyzerVersion: ownData(status, 'analyzerVersion', 'discovery-artifact-status-analyzer-invalid') ?? null,
      snapshotId: ownData(status, 'snapshotId', 'discovery-artifact-status-snapshot-invalid') ?? null,
      budgetClass: ownData(status, 'budgetClass', 'discovery-artifact-status-budget-invalid') ?? null,
    }),
    publication: deepFreeze({ status: publicationReason == null ? 'complete' : 'withheld', reason: publicationReason }),
    resource,
    evidence,
    functionCandidates: candidates,
    intervalClaims: intervals,
    collisionSets: collisionResult.collisions,
    references,
  };
  return issueArtifactV1(payload);
}

function discoveryDataIntervalsFromImage(image, maxIntervals) {
  objectRecord(image, 'discovery-artifact-image-invalid');
  const raw = ownData(image, 'dataInCode', 'discovery-artifact-image-dataInCode-invalid') ?? [];
  if (!Array.isArray(raw)) fail('discovery-artifact-image-dataInCode-invalid');
  if (raw.length > maxIntervals) return { intervals: [], overflow: true };
  const intervals = [];
  for (const item of denseArray(raw, 'discovery-artifact-image-dataInCode-invalid')) {
    const value = objectRecord(item, 'discovery-artifact-data-in-code-invalid');
    const startRaw = ownData(value, 'address', 'discovery-artifact-data-in-code-address-invalid');
    const lengthRaw = ownData(value, 'length', 'discovery-artifact-data-in-code-length-invalid');
    if (startRaw == null) continue;
    if (!Number.isSafeInteger(lengthRaw) || lengthRaw <= 0) fail('discovery-artifact-data-in-code-length-invalid');
    const start = address(startRaw, 'discovery-artifact-data-in-code-address-invalid');
    const end = (BigInt(start) + BigInt(lengthRaw)).toString();
    const kindName = ownData(value, 'kindName', 'discovery-artifact-data-in-code-kind-invalid');
    intervals.push({
      kind: 'data',
      start,
      end,
      producerId: 'binary-image.data-in-code',
      origin: typeof kindName === 'string' && kindName.length > 0 ? `data-in-code:${kindName}` : 'data-in-code',
    });
  }
  return { intervals, overflow: false };
}

/**
 * Public X-03 entrypoint.  It reuses current-main producer collection and
 * function fusion; the private artifact issuer only accepts the result of this
 * path, so callers cannot mint a factory-issued rebuild artifact directly.
 */
export function functionDiscoveryArtifact({
  input,
  architectureId = 'generic',
  producers = [],
  binaryId = null,
  sourceHash = null,
  snapshotId = 'snapshot-unbound',
  byteIntervals = null,
  artifactBudget = {},
  expectedBinding = null,
  ...options
} = {}) {
  const registry = new DiscoveryProducerRegistry();
  for (const producer of GENERIC_PRODUCERS) registry.register(producer);
  for (const producer of producers) registry.register(producer);
  const artifactBudgetNormalized = normalizeDiscoveryArtifactBudget(artifactBudget);
  const { evidence, producerIds } = registry.collect(input, architectureId, { ...options, snapshotId });
  const applicable = new Map(registry.for(architectureId).map((producer) => [producer.id, producer]));
  if (evidence.some((item) => item.authority === 'authoritative'
      && !isCanonicalDiscoveryProducer(applicable.get(item.producerId)))) {
    throw new TypeError('discovery-artifact-authoritative-evidence-untrusted');
  }
  const fused = fuseFunctionCandidates(evidence, { architectureId, ...options, snapshotId });
  const evidenceCountByProducer = new Map();
  for (const item of evidence) {
    evidenceCountByProducer.set(item.producerId, (evidenceCountByProducer.get(item.producerId) ?? 0) + 1);
  }
  const producerRuns = producerIds.map((id) => {
    const producer = applicable.get(id);
    return {
      id,
      version: typeof producer?.version === 'string' && producer.version.trim() === producer.version && producer.version
        ? producer.version : '1',
      architectureId: producer?.architectureId ?? null,
      evidenceCount: evidenceCountByProducer.get(id) ?? 0,
    };
  });
  const binding = { binaryId, sourceHash, snapshotId, architectureId };
  const image = input?.image ?? {};
  const referenceResult = discoveryReferencesFromImage(image, {
    maxReferences: artifactBudgetNormalized.maxReferences,
  });
  let effectiveIntervals = byteIntervals;
  let intervalOverflow = false;
  if (effectiveIntervals == null) {
    effectiveIntervals = ownData(image, 'byteIntervals', 'discovery-artifact-image-byteIntervals-invalid');
  }
  if (effectiveIntervals == null) {
    const dataIntervals = discoveryDataIntervalsFromImage(image, artifactBudgetNormalized.maxIntervals);
    effectiveIntervals = dataIntervals.intervals;
    intervalOverflow = dataIntervals.overflow;
  }
  if (!Array.isArray(effectiveIntervals)) fail('discovery-artifact-image-byteIntervals-invalid');
  const resourceLimitReason = referenceResult.overflow ? 'references' : intervalOverflow ? 'intervals' : null;
  const artifact = createDiscoveryArtifactV1({
    binding,
    ...(expectedBinding == null ? {} : { expectedBinding }),
    artifactBudget: artifactBudgetNormalized,
    ...(resourceLimitReason == null ? {} : { resourceLimitReason }),
    status: fused.status,
    evidence,
    candidates: fused.candidates,
    producerRuns,
    byteIntervals: effectiveIntervals,
    references: referenceResult.references,
  });
  return { ...fused, artifact };
}

/** Bind only factory-issued, complete discovery evidence into X-01 rebuild state. */
export function discoveryArtifactForRebuildV1(artifact, expected = {}) {
  if (!artifactIdentityValidV1(artifact)) fail('discovery-rebuild-artifact-identity-invalid');
  if (artifact.publication?.status !== 'complete') fail('discovery-rebuild-artifact-not-publishable');
  const binding = normalizeBindingV1(expected);
  for (const key of ['binaryId', 'sourceHash', 'snapshotId', 'architectureId']) {
    if (binding[key] != null && artifact.binding[key] !== binding[key]) fail(`discovery-rebuild-${key}-mismatch`);
  }
  const payload = {
    schemaVersion: DISCOVERY_REBUILD_BINDING_SCHEMA_V1,
    artifactId: artifact.artifactId,
    binding: artifact.binding,
    candidateAlternatives: artifact.functionCandidates
      .filter((candidate) => candidate.ambiguous)
      .map((candidate) => deepFreeze({
        candidateId: candidate.candidateId,
        startState: candidate.startState,
        extentState: candidate.extentState,
        conflictDigests: candidate.conflictDigests,
      })),
    collisionSets: artifact.collisionSets,
    references: artifact.references,
  };
  const issued = deepFreeze({ ...payload, digest: stableDigest(payload) });
  ISSUED_REBUILD_BINDINGS.add(issued);
  return issued;
}

function rebuildBindingIdentityValidV1(binding) {
  if (!binding || binding.schemaVersion !== DISCOVERY_REBUILD_BINDING_SCHEMA_V1 || typeof binding.digest !== 'string') return false;
  const payload = { ...binding };
  delete payload.digest;
  return binding.digest === stableDigest(payload)
    && Array.isArray(binding.candidateAlternatives)
    && Array.isArray(binding.collisionSets)
    && Array.isArray(binding.references);
}



/**
 * A rebuild must not silently delete a source ambiguity or source reference.
 * The output artifact is separately parsed and bound to the materialized bytes.
 */
export function verifyDiscoveryReparseV1(sourceBinding, reparsedArtifact, { expectedOutputHash } = {}) {
  if (!isFactoryIssuedDiscoveryRebuildBinding(sourceBinding)) {
    return deepFreeze({ ok: false, reason: 'discovery-reparse-source-binding-invalid' });
  }
  if (!artifactIdentityValidV1(reparsedArtifact) || reparsedArtifact.publication?.status !== 'complete') {
    return deepFreeze({ ok: false, reason: 'discovery-reparse-artifact-invalid' });
  }
  if (sourceBinding.binding.binaryId !== reparsedArtifact.binding.binaryId
      || sourceBinding.binding.architectureId !== reparsedArtifact.binding.architectureId) {
    return deepFreeze({ ok: false, reason: 'discovery-reparse-identity-mismatch' });
  }
  if (typeof expectedOutputHash !== 'string' || expectedOutputHash.length === 0) {
    return deepFreeze({ ok: false, reason: 'discovery-reparse-output-hash-required' });
  }
  if (reparsedArtifact.binding.sourceHash !== expectedOutputHash) {
    return deepFreeze({ ok: false, reason: 'discovery-reparse-output-hash-mismatch' });
  }
  const outputCandidates = new Map(reparsedArtifact.functionCandidates.map((candidate) => [candidate.candidateId, candidate]));
  const missingCandidateIds = [];
  const promotedCandidateIds = [];
  const missingCandidateConflictIds = [];
  for (const source of sourceBinding.candidateAlternatives) {
    const output = outputCandidates.get(source.candidateId);
    if (!output) {
      missingCandidateIds.push(source.candidateId);
      continue;
    }
    if ((source.startState !== 'exact' && output.startState === 'exact')
        || (source.extentState !== 'exact' && output.extentState === 'exact')) {
      promotedCandidateIds.push(source.candidateId);
    }
    for (const digest of source.conflictDigests ?? []) {
      if (!output.conflictDigests.includes(digest)) {
        missingCandidateConflictIds.push(`${source.candidateId}:${digest}`);
      }
    }
  }
  const sourceCollisionIds = sourceBinding.collisionSets.map((item) => item.collisionId).sort(compareText);
  const outputCollisionIds = reparsedArtifact.collisionSets.map((item) => item.collisionId).sort(compareText);
  const sourceReferenceIds = sourceBinding.references.map((item) => item.referenceId).sort(compareText);
  const outputReferenceIds = reparsedArtifact.references.map((item) => item.referenceId).sort(compareText);
  const missingCollisionIds = sourceCollisionIds.filter((id) => !outputCollisionIds.includes(id));
  const missingReferenceIds = sourceReferenceIds.filter((id) => !outputReferenceIds.includes(id));
  const ok = missingCandidateIds.length === 0
    && promotedCandidateIds.length === 0
    && missingCandidateConflictIds.length === 0
    && missingCollisionIds.length === 0
    && missingReferenceIds.length === 0;
  return deepFreeze({
    ok,
    reason: ok ? null : 'discovery-reparse-ambiguity-lost',
    missingCandidateIds: missingCandidateIds.sort(compareText),
    promotedCandidateIds: promotedCandidateIds.sort(compareText),
    missingCandidateConflictIds: missingCandidateConflictIds.sort(compareText),
    missingCollisionIds,
    missingReferenceIds,
  });
}

/** Normalize reference facts from the production BinaryImage without fusion. */
export function discoveryReferencesFromImage(image = {}, { maxReferences = DISCOVERY_ARTIFACT_DEFAULT_BUDGET.maxReferences } = {}) {
  objectRecord(image, 'discovery-artifact-image-invalid');
  if (!Number.isSafeInteger(maxReferences) || maxReferences < 1
      || maxReferences > DISCOVERY_ARTIFACT_DEFAULT_BUDGET.maxReferences) {
    fail('discovery-artifact-reference-budget-invalid');
  }
  const out = [];
  let overflow = false;
  const append = (value) => {
    if (out.length >= maxReferences) {
      overflow = true;
      return false;
    }
    out.push(value);
    return true;
  };
  const items = (key) => {
    const raw = ownData(image, key, `discovery-artifact-image-${key}-invalid`) ?? [];
    if (!Array.isArray(raw)) fail(`discovery-artifact-image-${key}-invalid`);
    if (raw.length > maxReferences + 1) return { raw, oversized: true };
    return { raw, oversized: false };
  };
  const recordOrAddress = (raw, code) => {
    if (raw != null && typeof raw === 'object' && !Array.isArray(raw)) return objectRecord(raw, code);
    return { address: raw };
  };
  const field = (value, key, code) => ownData(value, key, code);

  const relocations = items('relocationTargets');
  if (relocations.oversized) overflow = true;
  else for (const raw of denseArray(relocations.raw, 'discovery-artifact-image-relocationTargets-invalid')) {
    const value = recordOrAddress(raw, 'discovery-artifact-relocation-reference-invalid');
    const target = field(value, 'address', 'discovery-artifact-relocation-reference-invalid')
      ?? field(value, 'target', 'discovery-artifact-relocation-reference-invalid');
    if (!append({
      kind: 'relocation',
      address: target,
      sourceAddress: field(value, 'sourceAddress', 'discovery-artifact-relocation-reference-invalid')
        ?? field(value, 'addressOfReference', 'discovery-artifact-relocation-reference-invalid') ?? null,
      relocationId: field(value, 'id', 'discovery-artifact-relocation-reference-invalid') ?? null,
      symbolicExpression: field(value, 'symbolicExpression', 'discovery-artifact-relocation-reference-invalid')
        ?? field(value, 'expression', 'discovery-artifact-relocation-reference-invalid') ?? null,
    })) break;
  }

  const jumpTables = items('jumpTableTargets');
  if (jumpTables.oversized) overflow = true;
  else for (const raw of denseArray(jumpTables.raw, 'discovery-artifact-image-jumpTableTargets-invalid')) {
    const value = recordOrAddress(raw, 'discovery-artifact-jump-table-reference-invalid');
    const target = field(value, 'address', 'discovery-artifact-jump-table-reference-invalid')
      ?? field(value, 'target', 'discovery-artifact-jump-table-reference-invalid');
    if (!append({
      kind: 'jump-table',
      address: target,
      sourceAddress: field(value, 'tableAddress', 'discovery-artifact-jump-table-reference-invalid')
        ?? field(value, 'sourceAddress', 'discovery-artifact-jump-table-reference-invalid') ?? null,
      tableId: field(value, 'tableId', 'discovery-artifact-jump-table-reference-invalid') ?? null,
      symbolicExpression: field(value, 'symbolicExpression', 'discovery-artifact-jump-table-reference-invalid') ?? null,
    })) break;
  }

  const vtables = items('vtableEntries');
  if (vtables.oversized) overflow = true;
  else for (const raw of denseArray(vtables.raw, 'discovery-artifact-image-vtableEntries-invalid')) {
    const value = recordOrAddress(raw, 'discovery-artifact-vtable-reference-invalid');
    const target = field(value, 'address', 'discovery-artifact-vtable-reference-invalid')
      ?? field(value, 'target', 'discovery-artifact-vtable-reference-invalid');
    if (!append({
      kind: 'vtable',
      address: target,
      sourceAddress: field(value, 'tableAddress', 'discovery-artifact-vtable-reference-invalid')
        ?? field(value, 'sourceAddress', 'discovery-artifact-vtable-reference-invalid') ?? null,
      tableId: field(value, 'tableId', 'discovery-artifact-vtable-reference-invalid') ?? null,
    })) break;
  }
  return deepFreeze({ references: out, overflow });
}

// === V2 (T016) SUBSYSTEM ===
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

function arrayItems(value, code) {
  if (!Array.isArray(value)) fail(code);
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor == null || !Object.hasOwn(descriptor, 'value')) fail(code);
    result.push(descriptor.value);
  }
  return result;
}

function optionalToken(value, code) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) fail(code);
  return value;
}

function normalizeBindingV2(input = {}) {
  const value = record(input, 'discovery-artifact-binding-invalid');
  return deepFreeze({
    binaryId: optionalToken(own(value, 'binaryId', 'discovery-artifact-binary-id-invalid'), 'discovery-artifact-binary-id-invalid'),
    sourceHash: optionalToken(own(value, 'sourceHash', 'discovery-artifact-source-hash-invalid'), 'discovery-artifact-source-hash-invalid'),
    snapshotId: optionalToken(own(value, 'snapshotId', 'discovery-artifact-snapshot-id-invalid'), 'discovery-artifact-snapshot-id-invalid'),
    architectureId: optionalToken(own(value, 'architectureId', 'discovery-artifact-architecture-id-invalid'), 'discovery-artifact-architecture-id-invalid'),
  });
}

function budgetValueV2(value, fallback, name) {
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > fallback) {
    fail(`discovery-artifact-budget-${name}-invalid`);
  }
  return value;
}

function normalizeBudgetV2(input = {}) {
  const value = record(input, 'discovery-artifact-budget-invalid');
  const result = {};
  for (const [name, fallback] of Object.entries(DISCOVERY_ARTIFACT_DEFAULT_BUDGET)) {
    result[name] = budgetValueV2(own(value, name, `discovery-artifact-budget-${name}-invalid`), fallback, name);
  }
  return deepFreeze(result);
}

function normalizeStatusV2(input) {
  const value = record(input, 'discovery-artifact-status-invalid');
  return createAnalysisStatus({
    completeness: own(value, 'completeness', 'discovery-artifact-status-completeness-invalid'),
    stopReason: own(value, 'stopReason', 'discovery-artifact-status-stop-invalid'),
    budgetClass: own(value, 'budgetClass', 'discovery-artifact-status-budget-invalid'),
    snapshotId: own(value, 'snapshotId', 'discovery-artifact-status-snapshot-invalid'),
    analyzerId: own(value, 'analyzerId', 'discovery-artifact-status-analyzer-invalid'),
    analyzerVersion: own(value, 'analyzerVersion', 'discovery-artifact-status-version-invalid'),
    evidenceIds: own(value, 'evidenceIds', 'discovery-artifact-status-evidence-invalid'),
    dependencyIds: own(value, 'dependencyIds', 'discovery-artifact-status-dependency-invalid'),
  });
}

function normalizeProducerRunV2(input) {
  const value = record(input, 'discovery-artifact-producer-run-invalid');
  const id = optionalToken(own(value, 'id', 'discovery-artifact-producer-id-invalid'), 'discovery-artifact-producer-id-invalid');
  const version = optionalToken(own(value, 'version', 'discovery-artifact-producer-version-invalid'), 'discovery-artifact-producer-version-invalid');
  if (id == null || version == null) fail('discovery-artifact-producer-identity-required');
  const completeness = own(value, 'completeness', 'discovery-artifact-producer-completeness-invalid') ?? 'complete';
  if (!['complete', 'partial', 'truncated', 'bounded', 'unsupported'].includes(completeness)) {
    fail('discovery-artifact-producer-completeness-invalid');
  }
  const stopReason = optionalToken(own(value, 'stopReason', 'discovery-artifact-producer-stop-invalid'), 'discovery-artifact-producer-stop-invalid');
  const evidenceCount = own(value, 'evidenceCount', 'discovery-artifact-producer-count-invalid') ?? 0;
  if (!Number.isSafeInteger(evidenceCount) || evidenceCount < 0) fail('discovery-artifact-producer-count-invalid');
  const authorityClass = own(value, 'authorityClass', 'discovery-artifact-producer-authority-invalid') ?? 'external';
  if (authorityClass !== 'canonical' && authorityClass !== 'external') fail('discovery-artifact-producer-authority-invalid');
  return deepFreeze({ id, version, completeness, stopReason, evidenceCount, authorityClass });
}



function canonicalCandidatesV2(raw) {
  return arrayItems(raw, 'discovery-artifact-candidates-invalid')
    .map((item) => createFunctionCandidate(item))
    .sort((a, b) => compareAddress(a.start, b.start) || String(a.architectureId ?? '').localeCompare(String(b.architectureId ?? '')));
}

function conflictRecordV2(candidate, conflict, index) {
  const payload = {
    candidateStart: candidate.start,
    architectureId: candidate.architectureId,
    index,
    conflict,
  };
  return deepFreeze({
    collisionId: `discovery-collision:${canonicalTypedDigest(payload)}`,
    kind: conflict.kind,
    candidateStart: candidate.start,
    detail: conflict.detail ?? null,
    alternatives: conflict.alternatives ?? [],
    resolution: 'unresolved',
  });
}

function candidateIntervalsV2(candidate) {
  return candidate.regions.map((region) => {
    const payload = {
      candidateStart: candidate.start,
      architectureId: candidate.architectureId,
      start: region.start,
      end: region.end,
      ownership: region.ownership,
    };
    return deepFreeze({
      intervalId: `discovery-interval:${canonicalTypedDigest(payload)}`,
      ...payload,
    });
  });
}

function referenceRecordV2(item) {
  const payload = {
    kind: item.kind,
    address: item.start,
    producerId: item.producerId,
    architectureId: item.architectureId,
    evidenceIds: item.evidenceIds,
  };
  return deepFreeze({
    memberId: `discovery-reference:${canonicalTypedDigest(payload)}`,
    ...payload,
  });
}

function publicationStateV2({ status, binding, producerRuns, evidence }) {
  if (status.completeness !== 'complete' || status.stopReason != null) {
    return { status: 'withheld', reason: status.stopReason ?? 'analysis-incomplete' };
  }
  if (!binding.binaryId || !binding.sourceHash || !binding.snapshotId || !binding.architectureId) {
    return { status: 'withheld', reason: 'identity-unbound' };
  }
  if (producerRuns.length === 0) return { status: 'withheld', reason: 'producer-identity-unbound' };
  const byId = new Map();
  for (const run of producerRuns) {
    if (byId.has(run.id)) return { status: 'withheld', reason: 'producer-identity-duplicate' };
    byId.set(run.id, run);
    if (run.completeness !== 'complete' || run.stopReason != null) {
      return { status: 'withheld', reason: `producer-incomplete:${run.id}` };
    }
  }
  const counts = new Map();
  for (const item of evidence) {
    const run = byId.get(item.producerId);
    if (!run) return { status: 'withheld', reason: 'producer-identity-mismatch' };
    counts.set(item.producerId, (counts.get(item.producerId) ?? 0) + 1);
    if (item.authority === 'authoritative' && run.authorityClass !== 'canonical') {
      return { status: 'withheld', reason: 'producer-authority-untrusted' };
    }
    if (item.architectureId != null && item.architectureId !== binding.architectureId) {
      return { status: 'withheld', reason: 'stale-evidence-architectureId' };
    }
  }
  for (const run of producerRuns) {
    if (run.evidenceCount !== (counts.get(run.id) ?? 0)) {
      return { status: 'withheld', reason: `producer-evidence-count-mismatch:${run.id}` };
    }
  }
  return { status: 'complete', reason: null };
}

function artifactPayloadV2(artifact) {
  const payload = { ...artifact };
  delete payload.artifactId;
  return payload;
}

function artifactIdentityValidV2(artifact) {
  return !!artifact && ISSUED_ARTIFACTS.has(artifact)
    && artifact.schemaVersion === DISCOVERY_ARTIFACT_SCHEMA
    && artifact.artifactId === `discovery-artifact:${stableDigest(artifactPayloadV2(artifact))}`;
}

function issueArtifactV2(payload) {
  const artifact = deepFreeze({ artifactId: `discovery-artifact:${stableDigest(payload)}`, ...payload });
  ISSUED_ARTIFACTS.add(artifact);
  return artifact;
}

export function createDiscoveryArtifact(input = {}) {
  const value = record(input, 'discovery-artifact-input-invalid');
  const budget = normalizeBudgetV2(own(value, 'budget', 'discovery-artifact-budget-invalid') ?? {});
  const rawEvidence = own(value, 'evidence', 'discovery-artifact-evidence-invalid') ?? [];
  const rawCandidates = own(value, 'candidates', 'discovery-artifact-candidates-invalid') ?? [];
  const rawRuns = own(value, 'producerRuns', 'discovery-artifact-producer-runs-invalid') ?? [];
  if (!Array.isArray(rawEvidence) || !Array.isArray(rawCandidates) || !Array.isArray(rawRuns)) {
    fail('discovery-artifact-array-invalid');
  }
  if (rawEvidence.length > budget.maxEvidence || rawCandidates.length > budget.maxCandidates || rawRuns.length > budget.maxProducerRuns) {
    fail('discovery-artifact-budget-exhausted');
  }

  const status = normalizeStatusV2(own(value, 'status', 'discovery-artifact-status-invalid'));
  const binding = normalizeBindingV2(own(value, 'binding', 'discovery-artifact-binding-invalid') ?? {});
  if (binding.snapshotId != null && status.snapshotId !== binding.snapshotId) {
    fail('discovery-artifact-status-snapshot-mismatch');
  }
  const evidence = arrayItems(rawEvidence, 'discovery-artifact-evidence-invalid')
    .map((item) => createDiscoveryEvidence(item))
    .sort((a, b) => canonicalTypedString(a).localeCompare(canonicalTypedString(b)));
  const candidates = canonicalCandidatesV2(rawCandidates);
  const derivedCandidates = canonicalCandidatesV2(fuseFunctionCandidates(evidence, {
    architectureId: binding.architectureId ?? 'generic',
    snapshotId: status.snapshotId,
  }).candidates);
  if (candidates.length !== derivedCandidates.length
      || candidates.some((candidate, index) => candidate.digest !== derivedCandidates[index].digest)) {
    fail('discovery-artifact-candidate-view-mismatch');
  }
  const canonicalCandidateView = derivedCandidates;
  const producerRuns = arrayItems(rawRuns, 'discovery-artifact-producer-runs-invalid')
    .map(normalizeProducerRunV2).sort((a, b) => a.id.localeCompare(b.id));

  const collisionSets = canonicalCandidateView.flatMap((candidate) => candidate.conflicts.map((conflict, index) => conflictRecordV2(candidate, conflict, index)))
    .sort((a, b) => a.collisionId.localeCompare(b.collisionId));
  const collisionIdsByStart = new Map();
  for (const collision of collisionSets) {
    if (!collisionIdsByStart.has(collision.candidateStart)) collisionIdsByStart.set(collision.candidateStart, []);
    collisionIdsByStart.get(collision.candidateStart).push(collision.collisionId);
  }
  const intervalClaims = canonicalCandidateView.flatMap(candidateIntervalsV2)
    .sort((a, b) => compareAddress(a.start, b.start) || compareAddress(a.end, b.end) || a.intervalId.localeCompare(b.intervalId));
  const references = evidence.filter((item) => REFERENCE_KINDS.has(item.kind) && item.start != null)
    .map(referenceRecordV2).sort((a, b) => compareAddress(a.address, b.address) || a.memberId.localeCompare(b.memberId));
  if (intervalClaims.length > budget.maxIntervals || references.length > budget.maxReferences) {
    fail('discovery-artifact-budget-exhausted');
  }

  const functionCandidates = canonicalCandidateView.map((candidate) => deepFreeze({
    candidateId: `function-candidate:${candidate.architectureId ?? 'generic'}:${candidate.start}`,
    start: candidate.start,
    name: candidate.name,
    architectureId: candidate.architectureId,
    regions: candidate.regions,
    startState: candidate.startState,
    extentState: candidate.extentState,
    exact: hasExactStart(candidate),
    collisionIds: [...new Set(collisionIdsByStart.get(candidate.start) ?? [])].sort(),
    startEvidenceIds: [...new Set(candidate.startEvidence.flatMap((item) => item.evidenceIds))].sort(),
    digest: candidate.digest,
  }));

  const publication = deepFreeze(publicationStateV2({ status, binding, producerRuns, evidence }));
  return issueArtifactV2({
    schemaVersion: DISCOVERY_ARTIFACT_SCHEMA,
    binding,
    status,
    publication,
    budget,
    producerRuns,
    evidence,
    functionCandidates,
    intervalClaims,
    collisionSets,
    references,
  });
}



export function discoveryArtifactForRebuildV2(artifact, expected = {}) {
  if (!artifactIdentityValidV2(artifact)) fail('discovery-rebuild-artifact-identity-invalid');
  if (artifact.publication?.status !== 'complete') fail('discovery-rebuild-artifact-not-publishable');
  const binding = normalizeBindingV2(expected);
  for (const key of ['binaryId', 'sourceHash', 'snapshotId', 'architectureId']) {
    if (binding[key] != null && artifact.binding[key] !== binding[key]) fail(`discovery-rebuild-${key}-mismatch`);
  }
  const payload = {
    schemaVersion: DISCOVERY_REBUILD_BINDING_SCHEMA,
    artifactId: artifact.artifactId,
    binding: artifact.binding,
    functionCandidates: artifact.functionCandidates,
    intervalClaims: artifact.intervalClaims,
    collisionSets: artifact.collisionSets,
    references: artifact.references,
  };
  const rebuild = deepFreeze({ ...payload, digest: stableDigest(payload) });
  ISSUED_REBUILD_BINDINGS.add(rebuild);
  return rebuild;
}

function rebuildBindingValidV2(binding) {
  if (!binding || !ISSUED_REBUILD_BINDINGS.has(binding) || binding.schemaVersion !== DISCOVERY_REBUILD_BINDING_SCHEMA) return false;
  const payload = { ...binding };
  delete payload.digest;
  return binding.digest === stableDigest(payload);
}

function ids(values, key) {
  return [...new Set(values.map((item) => item[key]))].sort();
}

function sameCanonical(left, right) {
  return canonicalTypedString(left) === canonicalTypedString(right);
}

function candidateProjection(item) {
  return {
    candidateId: item.candidateId,
    start: item.start,
    name: item.name,
    architectureId: item.architectureId,
    regions: item.regions,
    startState: item.startState,
    extentState: item.extentState,
    exact: item.exact,
    collisionIds: item.collisionIds,
    startEvidenceIds: item.startEvidenceIds,
  };
}

export function verifyDiscoveryReparseV2(sourceBinding, reparsedArtifact, options = {}) {
  if (!rebuildBindingValidV2(sourceBinding)) return deepFreeze({ ok: false, reason: 'discovery-reparse-source-binding-invalid' });
  if (!artifactIdentityValidV2(reparsedArtifact) || reparsedArtifact.publication?.status !== 'complete') {
    return deepFreeze({ ok: false, reason: 'discovery-reparse-artifact-invalid' });
  }
  if (sourceBinding.binding.binaryId !== reparsedArtifact.binding.binaryId
      || sourceBinding.binding.architectureId !== reparsedArtifact.binding.architectureId) {
    return deepFreeze({ ok: false, reason: 'discovery-reparse-identity-mismatch' });
  }
  if (sourceBinding.binding.snapshotId === reparsedArtifact.binding.snapshotId) {
    return deepFreeze({ ok: false, reason: 'discovery-reparse-stale-snapshot' });
  }
  const expectedOutputHash = optionalToken(options?.expectedOutputHash, 'discovery-reparse-output-hash-required');
  if (expectedOutputHash == null) return deepFreeze({ ok: false, reason: 'discovery-reparse-output-hash-required' });
  if (reparsedArtifact.binding.sourceHash !== expectedOutputHash) {
    return deepFreeze({ ok: false, reason: 'discovery-reparse-output-hash-mismatch' });
  }

  const missingCollisionIds = ids(sourceBinding.collisionSets, 'collisionId')
    .filter((id) => !ids(reparsedArtifact.collisionSets, 'collisionId').includes(id));
  const missingReferenceIds = ids(sourceBinding.references, 'memberId')
    .filter((id) => !ids(reparsedArtifact.references, 'memberId').includes(id));
  const candidatesPreserved = sameCanonical(
    sourceBinding.functionCandidates.map(candidateProjection),
    reparsedArtifact.functionCandidates.map(candidateProjection),
  );
  const intervalsPreserved = sameCanonical(sourceBinding.intervalClaims, reparsedArtifact.intervalClaims);
  const ok = missingCollisionIds.length === 0 && missingReferenceIds.length === 0
    && candidatesPreserved && intervalsPreserved;
  return deepFreeze({
    ok,
    reason: ok ? null : 'discovery-reparse-ambiguity-lost',
    missingCollisionIds,
    missingReferenceIds,
    candidatesPreserved,
    intervalsPreserved,
  });
}

export function attachDiscoveryArtifactToSearchResult(result, artifact) {
  if (!artifactIdentityValidV2(artifact)) return result;
  const rows = Array.isArray(result?.results) ? result.results : [];
  const byStart = new Map(artifact.functionCandidates.map((candidate) => [candidate.start, candidate]));
  return {
    ...(result && typeof result === 'object' && !Array.isArray(result) ? result : {}),
    results: rows.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
      const raw = row.address ?? row.addr;
      let start;
      try { start = BigInt(raw).toString(); } catch { return row; }
      const candidate = byStart.get(start);
      if (!candidate) return row;
      return {
        ...row,
        discovery: {
          artifactId: artifact.artifactId,
          candidateId: candidate.candidateId,
          startState: candidate.startState,
          extentState: candidate.extentState,
          collisionIds: candidate.collisionIds,
          ambiguous: candidate.collisionIds.length > 0,
          publication: artifact.publication.status,
        },
      };
    }),
    discoveryArtifact: {
      artifactId: artifact.artifactId,
      publication: artifact.publication,
      collisionCount: artifact.collisionSets.length,
      status: artifact.status,
    },
  };
}

// === UNIFIED DISPATCHERS ===

export function isFactoryIssuedDiscoveryArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object' || !ISSUED_ARTIFACTS.has(artifact)) return false;
  return artifactIdentityValidV1(artifact) || artifactIdentityValidV2(artifact);
}

export function isFactoryIssuedDiscoveryRebuildBinding(binding) {
  if (!binding || typeof binding !== 'object' || !ISSUED_REBUILD_BINDINGS.has(binding)) return false;
  return rebuildBindingIdentityValidV1(binding) || rebuildBindingValidV2(binding);
}

export function discoveryArtifactForRebuild(artifact, expected = {}) {
  if (!isFactoryIssuedDiscoveryArtifact(artifact)) fail('discovery-rebuild-artifact-identity-invalid');
  if (artifact.schemaVersion === DISCOVERY_ARTIFACT_SCHEMA_V1) {
    return discoveryArtifactForRebuildV1(artifact, expected);
  }
  if (artifact.schemaVersion === DISCOVERY_ARTIFACT_SCHEMA) {
    return discoveryArtifactForRebuildV2(artifact, expected);
  }
  fail('discovery-rebuild-artifact-identity-invalid');
}

export function verifyDiscoveryReparse(sourceBinding, reparsedArtifact, options = {}) {
  if (!isFactoryIssuedDiscoveryRebuildBinding(sourceBinding)) {
    return deepFreeze({ ok: false, reason: 'discovery-reparse-source-binding-invalid' });
  }
  if (sourceBinding.schemaVersion === DISCOVERY_REBUILD_BINDING_SCHEMA_V1) {
    return verifyDiscoveryReparseV1(sourceBinding, reparsedArtifact, options);
  }
  if (sourceBinding.schemaVersion === DISCOVERY_REBUILD_BINDING_SCHEMA) {
    return verifyDiscoveryReparseV2(sourceBinding, reparsedArtifact, options);
  }
  return deepFreeze({ ok: false, reason: 'discovery-reparse-source-binding-invalid' });
}
