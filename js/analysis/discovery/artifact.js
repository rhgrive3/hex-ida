/**
 * HEX-X-03 — ambiguity-preserving discovery artifact.
 *
 * This layer deliberately wraps the current production fusion instead of
 * replacing it.  Candidate scores/ranking never become truth here: exactness is
 * inherited only from the current FunctionCandidate authority contract and only
 * for repository-owned generic evidence producers.  Raw interval/reference
 * alternatives survive even when the working candidate view withdraws an
 * extent because of ambiguity.
 */

import { deepFreeze, stableDigest } from '../../core/identity/index.js';
import { createDiscoveryEvidence, createFunctionCandidate } from './candidates.js';
import { DiscoveryProducerRegistry, fuseFunctionCandidates } from './fusion.js';
import { GENERIC_PRODUCERS, isCanonicalDiscoveryProducer } from './producers.js';

export const DISCOVERY_ARTIFACT_SCHEMA = 'hex-discovery-ambiguity-artifact/v1';
export const DISCOVERY_REBUILD_BINDING_SCHEMA = 'hex-discovery-rebuild-binding/v1';
export const DISCOVERY_ARTIFACT_DEFAULT_BUDGET = deepFreeze({
  maxEvidence: 200000,
  maxCandidates: 200000,
  maxIntervals: 400000,
  maxReferences: 200000,
  maxProducerRuns: 1024,
  maxCollisionChecks: 2000000,
});

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

function budgetValue(input, name) {
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
    Object.keys(DISCOVERY_ARTIFACT_DEFAULT_BUDGET).map((name) => [name, budgetValue(input, name)]),
  ));
}

function normalizeBinding(input = {}) {
  plainRecord(input, 'discovery-artifact-binding-invalid');
  return deepFreeze({
    binaryId: optionalString(ownData(input, 'binaryId', 'discovery-artifact-binary-id-invalid'), 'discovery-artifact-binary-id-invalid'),
    sourceHash: optionalString(ownData(input, 'sourceHash', 'discovery-artifact-source-hash-invalid'), 'discovery-artifact-source-hash-invalid'),
    snapshotId: optionalString(ownData(input, 'snapshotId', 'discovery-artifact-snapshot-id-invalid'), 'discovery-artifact-snapshot-id-invalid'),
    architectureId: optionalString(ownData(input, 'architectureId', 'discovery-artifact-architecture-id-invalid'), 'discovery-artifact-architecture-id-invalid'),
  });
}

function normalizeProducerRun(input) {
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

function normalizeInterval(input) {
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

function inferredIntervals(evidence) {
  const out = [];
  for (const item of evidence) {
    for (const region of item.regions) {
      out.push(normalizeInterval({
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

function referenceKind(value) {
  const kind = requiredString(value, 'discovery-artifact-reference-kind-invalid');
  if (!['relocation', 'jump-table', 'vtable'].includes(kind)) fail('discovery-artifact-reference-kind-invalid');
  return kind;
}

function normalizeReference(input) {
  plainRecord(input, 'discovery-artifact-reference-invalid');
  const kind = referenceKind(ownData(input, 'kind', 'discovery-artifact-reference-kind-invalid'));
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

function normalizeCandidate(input) {
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

function intervalCompare(left, right) {
  return compareAddress(left.start, right.start)
    || compareAddress(left.end, right.end)
    || compareText(left.kind, right.kind)
    || compareText(left.intervalId, right.intervalId);
}

function referenceCompare(left, right) {
  return compareAddress(left.address, right.address)
    || compareText(left.kind, right.kind)
    || compareText(left.referenceId, right.referenceId);
}

function collision(kind, alternatives, range = null, at = null) {
  const ordered = alternatives.slice().sort((left, right) => compareText(left.memberId, right.memberId));
  const payload = { kind, range, at, alternatives: ordered, resolution: 'unresolved' };
  return deepFreeze({ collisionId: `discovery-collision:${stableDigest(payload)}`, ...payload });
}

function intervalMember(interval) {
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

function candidateMember(candidate) {
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

function referenceMember(reference) {
  return deepFreeze({
    memberId: reference.referenceId,
    kind: `${reference.kind}-reference`,
    address: reference.address,
    sourceAddress: reference.sourceAddress,
    relocationId: reference.relocationId,
    tableId: reference.tableId,
  });
}

function buildCollisions(intervals, candidates, references, budget) {
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
      if (!consume()) return { ok: false, reason: 'collision-work', checks, collisions: [] };
      if (BigInt(left.start) >= BigInt(right.end)) continue;
      const distinctFunctions = left.kind === 'code' && right.kind === 'code'
        && left.candidateStart != null && right.candidateStart != null
        && left.candidateStart !== right.candidateStart;
      const codeData = (left.kind === 'code' && right.kind === 'data')
        || (left.kind === 'data' && right.kind === 'code');
      if (!distinctFunctions && !codeData) continue;
      const start = BigInt(left.start) > BigInt(right.start) ? left.start : right.start;
      const end = BigInt(left.end) < BigInt(right.end) ? left.end : right.end;
      const item = collision(distinctFunctions ? 'function-overlap' : 'code-data', [intervalMember(left), intervalMember(right)], { start, end });
      collisions.set(item.collisionId, item);
    }
  }

  const codeIntervals = intervals.filter((interval) => interval.kind === 'code');
  for (const interval of codeIntervals) {
    for (const candidate of candidates) {
      if (!consume()) return { ok: false, reason: 'collision-work', checks, collisions: [] };
      if (interval.candidateStart === candidate.start) continue;
      if (BigInt(interval.start) < BigInt(candidate.start) && BigInt(candidate.start) < BigInt(interval.end)) {
        const item = collision('function-contained-start', [intervalMember(interval), candidateMember(candidate)], null, candidate.start);
        collisions.set(item.collisionId, item);
      }
    }
  }

  for (const reference of references) {
    for (const interval of codeIntervals) {
      if (!consume()) return { ok: false, reason: 'collision-work', checks, collisions: [] };
      if (BigInt(interval.start) < BigInt(reference.address) && BigInt(reference.address) < BigInt(interval.end)
          && interval.candidateStart !== reference.address) {
        const item = collision('code-reference', [intervalMember(interval), referenceMember(reference)], null, reference.address);
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

function resourceState(ok, reason, budget, counts, collisionChecks = 0) {
  return deepFreeze({ ok, reason, budget, observed: deepFreeze({ ...counts, collisionChecks }) });
}

function issueArtifact(payload) {
  const artifact = deepFreeze({ artifactId: `discovery-artifact:${stableDigest(payload)}`, ...payload });
  ISSUED_ARTIFACTS.add(artifact);
  return artifact;
}

function artifactIdentityValid(artifact) {
  if (!artifact || !ISSUED_ARTIFACTS.has(artifact) || artifact.schemaVersion !== DISCOVERY_ARTIFACT_SCHEMA) return false;
  const payload = { ...artifact };
  delete payload.artifactId;
  return artifact.artifactId === `discovery-artifact:${stableDigest(payload)}`;
}

export function isFactoryIssuedDiscoveryArtifact(artifact) {
  return artifactIdentityValid(artifact);
}

function withheldArtifact({ binding, status, producerRuns, resource, reason }) {
  return issueArtifact({
    schemaVersion: DISCOVERY_ARTIFACT_SCHEMA,
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
function createDiscoveryArtifact(input = {}) {
  plainRecord(input, 'discovery-artifact-input-invalid');
  const budget = normalizeDiscoveryArtifactBudget(ownData(input, 'artifactBudget', 'discovery-artifact-budget-invalid') ?? {});
  const binding = normalizeBinding(ownData(input, 'binding', 'discovery-artifact-binding-invalid') ?? {});
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
      const resource = resourceState(false, `${name}-budget`, budget, counts);
      return withheldArtifact({ binding, status, producerRuns: [], resource, reason: `artifact-budget-exhausted:${name}` });
    }
  }
  const forcedResourceReason = optionalString(
    ownData(input, 'resourceLimitReason', 'discovery-artifact-resource-limit-reason-invalid'),
    'discovery-artifact-resource-limit-reason-invalid',
  );
  if (forcedResourceReason != null) {
    const resource = resourceState(false, forcedResourceReason, budget, counts);
    return withheldArtifact({ binding, status, producerRuns: [], resource, reason: `artifact-budget-exhausted:${forcedResourceReason}` });
  }

  const evidenceRaw = denseArray(evidenceInput, 'discovery-artifact-evidence-invalid');
  const candidatesRaw = denseArray(candidatesInput, 'discovery-artifact-candidates-invalid');
  const intervalsRaw = denseArray(intervalsInput, 'discovery-artifact-intervals-invalid');
  const referencesRaw = denseArray(referencesInput, 'discovery-artifact-references-invalid');
  const producerRuns = denseArray(producerRunsInput, 'discovery-artifact-producer-runs-invalid')
    .map(normalizeProducerRun)
    .sort((left, right) => compareText(left.id, right.id) || compareText(left.version, right.version));

  const evidence = evidenceRaw.map((item) => createDiscoveryEvidence(item))
    .sort((left, right) => compareText(stableDigest(left), stableDigest(right)));
  const candidates = candidatesRaw.map(normalizeCandidate)
    .sort((left, right) => compareAddress(left.start, right.start) || compareText(left.candidateId, right.candidateId));
  const suppliedIntervals = intervalsRaw.map(normalizeInterval);
  const inferred = inferredIntervals(evidence);
  if (suppliedIntervals.length + inferred.length > budget.maxIntervals) {
    const resource = resourceState(false, 'intervals-budget', budget, { ...counts, intervals: suppliedIntervals.length + inferred.length });
    return withheldArtifact({ binding, status, producerRuns, resource, reason: 'artifact-budget-exhausted:intervals' });
  }
  const intervals = [...suppliedIntervals, ...inferred].sort(intervalCompare);
  const duplicateInterval = intervals.find((interval, index) => index > 0 && interval.intervalId === intervals[index - 1].intervalId);
  if (duplicateInterval) fail('discovery-artifact-interval-duplicate');
  const references = referencesRaw.map(normalizeReference).sort(referenceCompare);
  const collisionResult = buildCollisions(intervals, candidates, references, budget);
  const resource = resourceState(collisionResult.ok, collisionResult.reason, budget, {
    ...counts,
    intervals: intervals.length,
  }, collisionResult.checks);
  if (!collisionResult.ok) {
    return withheldArtifact({ binding, status, producerRuns, resource, reason: `artifact-budget-exhausted:${collisionResult.reason}` });
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
    const expectedBinding = normalizeBinding(expectedBindingRaw);
    for (const key of ['binaryId', 'sourceHash', 'snapshotId', 'architectureId']) {
      if (expectedBinding[key] != null && binding[key] !== expectedBinding[key] && publicationReason == null) {
        publicationReason = `stale-${key}`;
      }
    }
  }

  const payload = {
    schemaVersion: DISCOVERY_ARTIFACT_SCHEMA,
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
  return issueArtifact(payload);
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
  const artifact = createDiscoveryArtifact({
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
export function discoveryArtifactForRebuild(artifact, expected = {}) {
  if (!artifactIdentityValid(artifact)) fail('discovery-rebuild-artifact-identity-invalid');
  if (artifact.publication?.status !== 'complete') fail('discovery-rebuild-artifact-not-publishable');
  const binding = normalizeBinding(expected);
  for (const key of ['binaryId', 'sourceHash', 'snapshotId', 'architectureId']) {
    if (binding[key] != null && artifact.binding[key] !== binding[key]) fail(`discovery-rebuild-${key}-mismatch`);
  }
  const payload = {
    schemaVersion: DISCOVERY_REBUILD_BINDING_SCHEMA,
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

function rebuildBindingIdentityValid(binding) {
  if (!binding || binding.schemaVersion !== DISCOVERY_REBUILD_BINDING_SCHEMA || typeof binding.digest !== 'string') return false;
  const payload = { ...binding };
  delete payload.digest;
  return binding.digest === stableDigest(payload)
    && Array.isArray(binding.candidateAlternatives)
    && Array.isArray(binding.collisionSets)
    && Array.isArray(binding.references);
}

export function isFactoryIssuedDiscoveryRebuildBinding(binding) {
  return !!binding && ISSUED_REBUILD_BINDINGS.has(binding) && rebuildBindingIdentityValid(binding);
}

/**
 * A rebuild must not silently delete a source ambiguity or source reference.
 * The output artifact is separately parsed and bound to the materialized bytes.
 */
export function verifyDiscoveryReparse(sourceBinding, reparsedArtifact, { expectedOutputHash } = {}) {
  if (!isFactoryIssuedDiscoveryRebuildBinding(sourceBinding)) {
    return deepFreeze({ ok: false, reason: 'discovery-reparse-source-binding-invalid' });
  }
  if (!artifactIdentityValid(reparsedArtifact) || reparsedArtifact.publication?.status !== 'complete') {
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
