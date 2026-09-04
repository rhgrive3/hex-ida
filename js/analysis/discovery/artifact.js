/**
 * HEX-X-03 — canonical ambiguity-preserving discovery artifact.
 *
 * FunctionCandidate is intentionally a conservative working view: disputed
 * extents are withdrawn.  Rebuild, UI, and audit consumers also need the
 * alternatives which caused that withdrawal.  This artifact retains both,
 * bound to the binary/snapshot and producer identities which created them.
 */

import { deepFreeze, stableDigest } from '../../core/identity/index.js';
import { createAnalysisStatus } from '../status.js';
import { createDiscoveryEvidence, createFunctionCandidate, hasExactStart } from './candidates.js';
import { canonicalTypedDigest, canonicalTypedString } from './canonical-value.js';
import { deriveFunctionCandidates } from './fusion-rules.js';
import { isFactoryIssuedCanonicalProducerRun } from './fusion.js';

export const DISCOVERY_ARTIFACT_SCHEMA = 'hex-discovery-ambiguity-artifact/v1';
export const DISCOVERY_REBUILD_BINDING_SCHEMA = 'hex-discovery-rebuild-binding/v1';
export const DISCOVERY_ARTIFACT_DEFAULT_BUDGET = deepFreeze({
  maxTotalEvidence: 200000,
  maxCandidateViews: 200000,
  maxProducerRuns: 1024,
  maxIntervalClaims: 400000,
  maxReferences: 200000,
  maxCollisionWork: 2000000,
});

const BYTE_KINDS = new Set(['code', 'data', 'padding', 'unsupported']);
const COMPLETE = 'complete';
const ISSUED_ARTIFACTS = new WeakSet();
const ISSUED_REBUILD_BINDINGS = new WeakSet();

function fail(code) { throw new TypeError(code); }

function record(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}

function optionalString(value, code) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) fail(code);
  return value.trim();
}

function requiredString(value, code) {
  const result = optionalString(value, code);
  if (result == null) fail(code);
  return result;
}

function ownData(value, key, code) {
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
  catch { fail(code); }
  if (descriptor == null) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) fail(code);
  return descriptor.value;
}

function arrayItems(value, code) {
  if (!Array.isArray(value)) fail(code);
  const items = [];
  for (let index = 0; index < value.length; index += 1) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, String(index)); }
    catch { fail(code); }
    if (descriptor == null || !Object.hasOwn(descriptor, 'value')) fail(code);
    items.push(descriptor.value);
  }
  return items;
}

function normalizeStatus(input) {
  const value = record(input, 'discovery-artifact-status-invalid');
  const result = {};
  for (const key of [
    'completeness', 'stopReason', 'budgetClass', 'snapshotId', 'analyzerId',
    'analyzerVersion', 'evidenceIds', 'dependencyIds',
  ]) {
    result[key] = ownData(value, key, `discovery-artifact-status-${key}-invalid`);
  }
  for (const key of ['evidenceIds', 'dependencyIds']) {
    if (result[key] != null) result[key] = arrayItems(result[key], `discovery-artifact-status-${key}-invalid`);
  }
  return createAnalysisStatus(result);
}

function budgetValue(value, fallback, name) {
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    fail(`discovery-artifact-budget-${name}-invalid`);
  }
  if (value > fallback) fail(`discovery-artifact-budget-${name}-exceeds-default`);
  return value;
}

export function normalizeDiscoveryArtifactBudget(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('discovery-artifact-budget-invalid');
  return deepFreeze(Object.fromEntries(Object.entries(DISCOVERY_ARTIFACT_DEFAULT_BUDGET).map(([name, fallback]) => [
    name,
    budgetValue((() => {
      let descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(input, name); }
      catch { fail(`discovery-artifact-budget-${name}-invalid`); }
      if (descriptor == null) return null;
      if (!Object.hasOwn(descriptor, 'value')) fail(`discovery-artifact-budget-${name}-invalid`);
      return descriptor.value;
    })(), fallback, name),
  ])));
}

function ownArray(value, key, { required = false } = {}) {
  const errorName = key === 'byteIntervals' ? 'byte-intervals'
    : key === 'producerRuns' ? 'producer-runs' : key;
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
  catch { fail(`discovery-artifact-${errorName}-descriptor-invalid`); }
  if (descriptor == null) {
    if (required) fail(`discovery-artifact-${errorName}-invalid`);
    return [];
  }
  if (!Object.hasOwn(descriptor, 'value') || !Array.isArray(descriptor.value)) {
    fail(`discovery-artifact-${errorName}-invalid`);
  }
  return descriptor.value;
}

function collisionWorkFor(intervalClaims, references, evidence) {
  return BigInt(intervalClaims) * BigInt(Math.max(0, intervalClaims - 1)) / 2n
    + BigInt(intervalClaims) * BigInt(references + evidence);
}

function resourceResult(ok, reason, budget, counts) {
  return deepFreeze({
    ok,
    reason,
    observed: {
      totalEvidence: counts.evidence,
      candidateViews: counts.candidates,
      producerRuns: counts.producerRuns,
      intervalClaims: counts.intervals,
      references: counts.references,
      collisionWork: collisionWorkFor(counts.intervals, counts.references, counts.evidence).toString(),
    },
    budget,
  });
}

/** Cheap cardinality gate run before evidence or collision canonicalization. */
export function discoveryArtifactResourcePreflight(input = {}, rawBudget = {}) {
  const value = record(input, 'discovery-artifact-resource-input-invalid');
  const budget = normalizeDiscoveryArtifactBudget(rawBudget);
  const evidence = ownArray(value, 'evidence');
  const candidates = ownArray(value, 'candidates');
  const producerRuns = ownArray(value, 'producerRuns');
  const byteIntervals = ownArray(value, 'byteIntervals');
  const counts = {
    evidence: evidence.length,
    candidates: candidates.length,
    producerRuns: producerRuns.length,
    intervals: byteIntervals.length,
    references: 0,
  };
  // Primitive array lengths are checked before reading a single evidence item.
  // Sparse or otherwise enormous arrays therefore fail in constant time.
  const cardinalities = [
    ['total-evidence', counts.evidence, budget.maxTotalEvidence],
    ['candidate-views', counts.candidates, budget.maxCandidateViews],
    ['producer-runs', counts.producerRuns, budget.maxProducerRuns],
    ['interval-claims', counts.intervals, budget.maxIntervalClaims],
  ];
  for (const [reason, count, limit] of cardinalities) {
    if (count > limit) return resourceResult(false, reason, budget, counts);
  }
  if (collisionWorkFor(counts.intervals, counts.references, counts.evidence) > BigInt(budget.maxCollisionWork)) {
    return resourceResult(false, 'collision-work', budget, counts);
  }
  for (let index = 0; index < evidence.length; index += 1) {
    let itemDescriptor;
    try { itemDescriptor = Object.getOwnPropertyDescriptor(evidence, String(index)); }
    catch { return resourceResult(false, 'malformed-evidence-descriptor', budget, counts); }
    if (itemDescriptor == null || !Object.hasOwn(itemDescriptor, 'value')) {
      return resourceResult(false, 'malformed-evidence-descriptor', budget, counts);
    }
    const item = itemDescriptor.value;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return resourceResult(false, 'malformed-evidence-record', budget, counts);
    }
    let regionsDescriptor;
    let kindDescriptor;
    try {
      regionsDescriptor = Object.getOwnPropertyDescriptor(item, 'regions');
      kindDescriptor = Object.getOwnPropertyDescriptor(item, 'kind');
    } catch {
      return resourceResult(false, 'malformed-evidence-descriptor', budget, counts);
    }
    if ((regionsDescriptor != null && !Object.hasOwn(regionsDescriptor, 'value'))
        || (kindDescriptor != null && !Object.hasOwn(kindDescriptor, 'value'))) {
      return resourceResult(false, 'malformed-evidence-descriptor', budget, counts);
    }
    const regions = regionsDescriptor?.value ?? [];
    if (!Array.isArray(regions)) return resourceResult(false, 'malformed-evidence-regions', budget, counts);
    counts.intervals += regions.length;
    if (counts.intervals > budget.maxIntervalClaims) {
      return resourceResult(false, 'interval-claims', budget, counts);
    }
    if (['relocation-target', 'vtable-entry', 'jump-table-target'].includes(kindDescriptor?.value)) {
      counts.references += 1;
      if (counts.references > budget.maxReferences) {
        return resourceResult(false, 'references', budget, counts);
      }
    }
    if (collisionWorkFor(counts.intervals, counts.references, counts.evidence) > BigInt(budget.maxCollisionWork)) {
      return resourceResult(false, 'collision-work', budget, counts);
    }
  }
  return resourceResult(true, null, budget, counts);
}

function address(value, code) {
  const type = typeof value;
  if (type !== 'bigint' && type !== 'string' && !(type === 'number' && Number.isSafeInteger(value))) fail(code);
  try {
    const result = BigInt(value);
    if (result < 0n) fail(code);
    return result.toString();
  } catch {
    fail(code);
    return '0';
  }
}

function compareAddress(left, right) {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedStrings(values, code) {
  if (values == null) return [];
  if (!Array.isArray(values)) fail(code);
  const normalized = arrayItems(values, code).map((value) => {
    if (typeof value !== 'string' || value.trim().length === 0) fail(code);
    return value.trim();
  });
  return [...new Set(normalized)].sort();
}

function producerRun(input) {
  const value = record(input, 'discovery-artifact-producer-run-invalid');
  const completeness = optionalString(
    ownData(value, 'completeness', 'discovery-artifact-producer-completeness-invalid') ?? COMPLETE,
    'discovery-artifact-producer-completeness-invalid',
  );
  if (!['complete', 'bounded', 'partial', 'truncated', 'unsupported'].includes(completeness)) {
    fail('discovery-artifact-producer-completeness-invalid');
  }
  const evidenceCount = ownData(value, 'evidenceCount', 'discovery-artifact-producer-evidence-count-invalid');
  const intervalCount = ownData(value, 'intervalCount', 'discovery-artifact-producer-interval-count-invalid');
  if (evidenceCount != null && (!Number.isSafeInteger(evidenceCount) || evidenceCount < 0)) {
    fail('discovery-artifact-producer-evidence-count-invalid');
  }
  if (intervalCount != null && (!Number.isSafeInteger(intervalCount) || intervalCount < 0)) {
    fail('discovery-artifact-producer-interval-count-invalid');
  }
  const normalized = {
    id: requiredString(ownData(value, 'id', 'discovery-artifact-producer-id-required'), 'discovery-artifact-producer-id-required'),
    version: requiredString(ownData(value, 'version', 'discovery-artifact-producer-version-required'), 'discovery-artifact-producer-version-required'),
    architectureId: optionalString(ownData(value, 'architectureId', 'discovery-artifact-producer-architecture-invalid'), 'discovery-artifact-producer-architecture-invalid'),
    completeness,
    stopReason: optionalString(ownData(value, 'stopReason', 'discovery-artifact-producer-stop-reason-invalid'), 'discovery-artifact-producer-stop-reason-invalid'),
    evidenceCount: Number.isSafeInteger(evidenceCount) && evidenceCount >= 0 ? evidenceCount : 0,
    intervalCount: Number.isSafeInteger(intervalCount) && intervalCount >= 0 ? intervalCount : 0,
    authorityClass: isFactoryIssuedCanonicalProducerRun(value) ? 'canonical' : 'external',
  };
  return normalized.authorityClass === 'canonical' ? value : normalized;
}

function normalizeBinding(input = {}) {
  const value = input == null ? {} : record(input, 'discovery-artifact-binding-invalid');
  return {
    binaryId: optionalString(ownData(value, 'binaryId', 'discovery-artifact-binary-id-invalid'), 'discovery-artifact-binary-id-invalid'),
    sourceHash: optionalString(ownData(value, 'sourceHash', 'discovery-artifact-source-hash-invalid'), 'discovery-artifact-source-hash-invalid'),
    snapshotId: optionalString(ownData(value, 'snapshotId', 'discovery-artifact-snapshot-id-invalid'), 'discovery-artifact-snapshot-id-invalid'),
    architectureId: optionalString(ownData(value, 'architectureId', 'discovery-artifact-architecture-id-invalid'), 'discovery-artifact-architecture-id-invalid'),
  };
}

function normalizeByteInterval(input) {
  const value = record(input, 'discovery-artifact-byte-interval-invalid');
  if (ownData(value, 'intervalId', 'discovery-artifact-byte-interval-id-invalid') !== undefined) {
    fail('discovery-artifact-byte-interval-id-caller-controlled');
  }
  const start = address(ownData(value, 'start', 'discovery-artifact-byte-interval-start-invalid'), 'discovery-artifact-byte-interval-start-invalid');
  const end = address(ownData(value, 'end', 'discovery-artifact-byte-interval-end-invalid'), 'discovery-artifact-byte-interval-end-invalid');
  if (BigInt(end) <= BigInt(start)) fail('discovery-artifact-byte-interval-empty');
  const kind = optionalString(ownData(value, 'kind', 'discovery-artifact-byte-kind-required'), 'discovery-artifact-byte-kind-required');
  if (!BYTE_KINDS.has(kind)) fail('discovery-artifact-byte-kind-invalid');
  const evidenceIds = sortedStrings(ownData(value, 'evidenceIds', 'discovery-artifact-byte-evidence-id-invalid'), 'discovery-artifact-byte-evidence-id-invalid');
  const producerId = optionalString(ownData(value, 'producerId', 'discovery-artifact-byte-producer-id-invalid'), 'discovery-artifact-byte-producer-id-invalid');
  const producerVersion = optionalString(ownData(value, 'producerVersion', 'discovery-artifact-byte-producer-version-invalid'), 'discovery-artifact-byte-producer-version-invalid');
  const payload = { start, end, kind, evidenceIds, producerId, producerVersion };
  return {
    intervalId: `byte-interval:${canonicalTypedDigest(payload)}`,
    ...payload,
  };
}

function evidenceClaim(item, region) {
  const payload = {
    start: region.start,
    end: region.end,
    kind: 'code',
    candidateStart: item.start,
    evidenceIds: item.evidenceIds,
    producerId: item.producerId,
    producerVersion: item.producerVersion,
    evidenceKind: item.kind,
    ownership: region.ownership,
  };
  return {
    intervalId: `evidence-interval:${canonicalTypedDigest(payload)}`,
    ...payload,
  };
}

function compareInterval(left, right) {
  return compareAddress(left.start, right.start)
    || compareAddress(left.end, right.end)
    || left.kind.localeCompare(right.kind)
    || canonicalTypedString(left).localeCompare(canonicalTypedString(right));
}

function overlaps(left, right) {
  return BigInt(left.start) < BigInt(right.end) && BigInt(right.start) < BigInt(left.end);
}

function collision(kind, alternatives, range = null, at = null) {
  const ordered = alternatives.slice().sort((left, right) => left.memberId.localeCompare(right.memberId));
  const payload = { kind, range, at, alternatives: ordered, resolution: 'unresolved' };
  return { collisionId: `discovery-collision:${stableDigest(payload)}`, ...payload };
}

function intervalMember(interval) {
  return {
    memberId: interval.intervalId,
    kind: interval.kind,
    start: interval.start,
    end: interval.end,
    candidateStart: interval.candidateStart ?? null,
    producerId: interval.producerId ?? null,
    evidenceIds: interval.evidenceIds ?? [],
  };
}

function referenceMember(item) {
  const identity = {
    kind: item.kind,
    start: item.start,
    evidenceIds: item.evidenceIds,
    producerId: item.producerId,
    producerVersion: item.producerVersion,
    relocationId: item.relocationId,
    referenceAddress: item.referenceAddress,
    symbolicExpression: item.symbolicExpression,
  };
  return {
    memberId: `reference:${canonicalTypedDigest(identity)}`,
    kind: item.kind === 'jump-table-target' ? 'jump-table-reference' : item.kind === 'vtable-entry' ? 'data-reference' : 'relocation-reference',
    address: item.start,
    producerId: item.producerId,
    producerVersion: item.producerVersion,
    evidenceIds: item.evidenceIds,
    relocationId: item.relocationId,
    referenceAddress: item.referenceAddress,
    symbolicExpression: item.symbolicExpression,
  };
}

function functionStartMember(start, evidence) {
  const identity = {
    start,
    evidenceIds: [...new Set(evidence.flatMap((item) => item.evidenceIds))].sort(),
    producers: [...new Set(evidence.map((item) => `${item.producerId}@${item.producerVersion}`))].sort(),
  };
  return {
    memberId: `function-start:${canonicalTypedDigest(identity)}`,
    kind: 'function-start',
    start,
    candidateStart: start,
    evidenceIds: identity.evidenceIds,
    producers: identity.producers,
  };
}

function buildCollisions(intervals, evidence) {
  const collisions = new Map();
  for (let leftIndex = 0; leftIndex < intervals.length; leftIndex += 1) {
    const left = intervals[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < intervals.length; rightIndex += 1) {
      const right = intervals[rightIndex];
      if (!overlaps(left, right)) continue;
      const distinctFunctions = left.kind === 'code' && right.kind === 'code'
        && left.candidateStart != null && right.candidateStart != null
        && left.candidateStart !== right.candidateStart;
      const codeData = (left.kind === 'code' && right.kind === 'data') || (left.kind === 'data' && right.kind === 'code');
      if (!distinctFunctions && !codeData) continue;
      const start = BigInt(left.start) > BigInt(right.start) ? left.start : right.start;
      const end = BigInt(left.end) < BigInt(right.end) ? left.end : right.end;
      const item = collision(distinctFunctions ? 'function-overlap' : 'code-data', [intervalMember(left), intervalMember(right)], { start, end });
      collisions.set(item.collisionId, item);
    }
  }

  const evidenceByStart = new Map();
  for (const item of evidence) {
    if (item.start == null) continue;
    if (!evidenceByStart.has(item.start)) evidenceByStart.set(item.start, []);
    evidenceByStart.get(item.start).push(item);
  }
  const codeIntervals = intervals.filter((item) => item.kind === 'code');
  for (const interval of codeIntervals) {
    for (const [start, startEvidence] of evidenceByStart) {
      if (interval.candidateStart == null || interval.candidateStart === start) continue;
      if (!(BigInt(interval.start) < BigInt(start) && BigInt(start) < BigInt(interval.end))) continue;
      const value = collision(
        'function-contained-start',
        [intervalMember(interval), functionStartMember(start, startEvidence)],
        null,
        start,
      );
      collisions.set(value.collisionId, value);
    }
  }

  evidence.forEach((item) => {
    if (!['relocation-target', 'vtable-entry', 'jump-table-target'].includes(item.kind) || item.start == null) return;
    const inside = codeIntervals.filter((interval) => BigInt(interval.start) < BigInt(item.start) && BigInt(item.start) < BigInt(interval.end));
    for (const interval of inside) {
      if (interval.candidateStart === item.start) continue;
      const reference = referenceMember(item);
      const value = collision('code-data-reference', [intervalMember(interval), reference], null, item.start);
      collisions.set(value.collisionId, value);
    }
  });
  return [...collisions.values()].sort((left, right) => left.collisionId.localeCompare(right.collisionId));
}

function evidenceKey(item) {
  return canonicalTypedDigest(item);
}

function sameEvidenceMultiset(left, right) {
  if (left.length !== right.length) return false;
  const a = left.map(evidenceKey).sort();
  const b = right.map(evidenceKey).sort();
  return a.every((key, index) => key === b[index]);
}

function canonicalEvidenceSelection(rawItems, authorityItems, code) {
  const available = new Map();
  for (const item of authorityItems) {
    const key = evidenceKey(item);
    if (!available.has(key)) available.set(key, []);
    available.get(key).push(item);
  }
  const selected = [];
  for (const raw of rawItems) {
    const normalized = createDiscoveryEvidence(raw);
    const matches = available.get(evidenceKey(normalized));
    if (!matches?.length) fail(code);
    selected.push(matches.pop());
  }
  return selected;
}

function expectedStartState(items) {
  if (items.some((item) => item.authority === 'authoritative')) return 'exact';
  const corroborators = new Set(items
    .filter((item) => item.authority === 'corroborating')
    .map((item) => item.producerId));
  return corroborators.size >= 2 ? 'probable' : 'heuristic';
}

function canonicalEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left == null || right == null || typeof left !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => canonicalEqual(item, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && canonicalEqual(left[key], right[key]));
}

function canonicalCandidates(rawCandidates, evidence, status, binding) {
  const evidenceByStart = new Map();
  for (const item of evidence) {
    if (item.start == null) continue;
    if (!evidenceByStart.has(item.start)) evidenceByStart.set(item.start, []);
    evidenceByStart.get(item.start).push(item);
  }
  const complete = status.completeness === COMPLETE && status.stopReason == null;
  if (complete) {
    const supplied = rawCandidates.map((raw) => createFunctionCandidate(raw))
      .sort((left, right) => compareAddress(left.start, right.start));
    const expected = deriveFunctionCandidates(evidence, { architectureId: binding.architectureId }).candidates;
    if (!canonicalEqual(supplied, expected)) fail('discovery-artifact-candidate-view-mismatch');
    return expected;
  }
  const starts = new Set();
  const result = rawCandidates.map((raw) => {
    const candidate = createFunctionCandidate(raw);
    if (starts.has(candidate.start)) fail('discovery-artifact-candidate-start-duplicate');
    starts.add(candidate.start);
    const authority = evidenceByStart.get(candidate.start);
    if (!authority) fail('discovery-artifact-candidate-start-unsupported');
    const startEvidence = canonicalEvidenceSelection(
      candidate.startEvidence,
      authority,
      'discovery-artifact-candidate-start-evidence-mismatch',
    );
    if (complete && !sameEvidenceMultiset(startEvidence, authority)) {
      fail('discovery-artifact-candidate-start-evidence-incomplete');
    }
    const expectedExtent = startEvidence.filter((item) => item.regions.length > 0);
    const extentEvidence = canonicalEvidenceSelection(
      candidate.extentEvidence,
      expectedExtent,
      'discovery-artifact-candidate-extent-evidence-mismatch',
    );
    if (!sameEvidenceMultiset(extentEvidence, expectedExtent)) {
      fail('discovery-artifact-candidate-extent-evidence-incomplete');
    }
    if (candidate.startState !== expectedStartState(startEvidence)) {
      fail('discovery-artifact-candidate-start-authority-mismatch');
    }
    if (candidate.architectureId != null && binding.architectureId != null
        && candidate.architectureId !== binding.architectureId) {
      fail('discovery-artifact-candidate-architecture-mismatch');
    }
    return createFunctionCandidate({
      ...candidate,
      startEvidence,
      extentEvidence,
    });
  });
  return result.sort((left, right) => compareAddress(left.start, right.start));
}

function artifactIdentityValid(artifact) {
  if (!artifact || !ISSUED_ARTIFACTS.has(artifact)
      || artifact.schemaVersion !== DISCOVERY_ARTIFACT_SCHEMA || typeof artifact.artifactId !== 'string') return false;
  const payload = { ...artifact };
  delete payload.artifactId;
  return artifact.artifactId === `discovery-artifact:${stableDigest(payload)}`;
}

function issueArtifact(artifact) {
  const issued = deepFreeze({ artifactId: `discovery-artifact:${stableDigest(artifact)}`, ...artifact });
  ISSUED_ARTIFACTS.add(issued);
  return issued;
}

function publicationState({ status, producerRuns, binding, expectedBinding, evidence, intervals, suppliedIntervals }) {
  if (status?.completeness !== COMPLETE || status?.stopReason != null) {
    return { status: 'withheld', reason: status?.stopReason ?? 'analysis-incomplete' };
  }
  const incompleteProducer = producerRuns.find((run) => run.completeness !== COMPLETE || run.stopReason != null);
  if (incompleteProducer) return { status: 'withheld', reason: `producer-incomplete:${incompleteProducer.id}` };
  if (producerRuns.length === 0) return { status: 'withheld', reason: 'producer-identity-unbound' };
  if (evidence.length === 0 && suppliedIntervals.length === 0) {
    return { status: 'withheld', reason: 'discovery-evidence-absent' };
  }
  const extentCoverage = new Map();
  for (const item of evidence) {
    if (item.start == null || item.regions.length === 0) continue;
    if (!extentCoverage.has(item.start)) extentCoverage.set(item.start, { partial: false, complete: false });
    extentCoverage.get(item.start)[item.extentRole === 'partial' ? 'partial' : 'complete'] = true;
    if (item.extentCoverageComplete) extentCoverage.get(item.start).complete = true;
  }
  const incompleteExtentStart = [...extentCoverage.entries()]
    .filter(([, coverage]) => coverage.partial && !coverage.complete)
    .map(([start]) => start)
    .sort(compareAddress)[0];
  if (incompleteExtentStart != null) {
    return { status: 'withheld', reason: `extent-coverage-incomplete:${incompleteExtentStart}` };
  }
  if (new Set(producerRuns.map((run) => run.id)).size !== producerRuns.length) {
    return { status: 'withheld', reason: 'producer-identity-duplicate' };
  }
  const runsById = new Map(producerRuns.map((run) => [run.id, run]));
  const evidenceCounts = new Map();
  for (const item of evidence) {
    const run = runsById.get(item.producerId);
    if (!run || item.producerId === 'unknown' || item.producerVersion === 'unknown' || run.version !== item.producerVersion) {
      return { status: 'withheld', reason: 'producer-identity-mismatch' };
    }
    evidenceCounts.set(item.producerId, (evidenceCounts.get(item.producerId) ?? 0) + 1);
  }
  for (const item of intervals) {
    const run = runsById.get(item.producerId);
    if (!run || item.producerId == null || item.producerVersion == null || run.version !== item.producerVersion) {
      return { status: 'withheld', reason: 'interval-producer-identity-mismatch' };
    }
  }
  const intervalCounts = new Map();
  for (const item of suppliedIntervals) {
    intervalCounts.set(item.producerId, (intervalCounts.get(item.producerId) ?? 0) + 1);
  }
  for (const run of producerRuns) {
    if (run.evidenceCount !== (evidenceCounts.get(run.id) ?? 0)) {
      return { status: 'withheld', reason: `producer-evidence-count-mismatch:${run.id}` };
    }
    if (run.intervalCount !== (intervalCounts.get(run.id) ?? 0)) {
      return { status: 'withheld', reason: `producer-interval-count-mismatch:${run.id}` };
    }
  }
  if (!binding.binaryId || !binding.sourceHash || !binding.snapshotId || !binding.architectureId) {
    return { status: 'withheld', reason: 'identity-unbound' };
  }
  if (expectedBinding) {
    for (const key of ['binaryId', 'sourceHash', 'snapshotId', 'architectureId']) {
      if (expectedBinding[key] != null && binding[key] !== expectedBinding[key]) return { status: 'withheld', reason: `stale-${key}` };
    }
  }
  for (const item of evidence) {
    for (const key of ['binaryId', 'sourceHash', 'snapshotId', 'architectureId']) {
      if (item[key] != null && item[key] !== binding[key]) return { status: 'withheld', reason: `stale-evidence-${key}` };
    }
    if (item.authority === 'authoritative' && runsById.get(item.producerId)?.authorityClass !== 'canonical') {
      return { status: 'withheld', reason: 'producer-authority-untrusted' };
    }
  }
  for (const run of producerRuns) {
    if (run.architectureId != null && run.architectureId !== binding.architectureId) {
      return { status: 'withheld', reason: 'stale-producer-architectureId' };
    }
  }
  return { status: 'complete', reason: null };
}

function resourceLimitedArtifact({ status, binding, preflight }) {
  const artifact = {
    schemaVersion: DISCOVERY_ARTIFACT_SCHEMA,
    binding,
    producerRuns: [],
    status,
    publication: { status: 'withheld', reason: `artifact-budget-exhausted:${preflight.reason}` },
    resource: preflight,
    evidence: [],
    functionCandidates: [],
    intervalClaims: [],
    collisionSets: [],
    references: [],
  };
  return issueArtifact(artifact);
}

/** Build the immutable artifact from canonical evidence and the fused view. */
export function createDiscoveryArtifact(input = {}) {
  const value = record(input, 'discovery-artifact-input-invalid');
  const rawEvidence = ownArray(value, 'evidence', { required: true });
  const rawCandidates = ownArray(value, 'candidates', { required: true });
  const rawProducerRuns = ownArray(value, 'producerRuns');
  const rawByteIntervals = ownArray(value, 'byteIntervals');

  const status = normalizeStatus(ownData(value, 'status', 'discovery-artifact-status-invalid'));
  const binding = normalizeBinding(ownData(value, 'binding', 'discovery-artifact-binding-invalid'));
  if (binding.snapshotId != null && status.snapshotId !== binding.snapshotId) {
    fail('discovery-artifact-status-snapshot-mismatch');
  }
  const rawArtifactBudget = ownData(value, 'artifactBudget', 'discovery-artifact-budget-invalid') ?? {};
  const observedPreflight = discoveryArtifactResourcePreflight(value, rawArtifactBudget);
  const forcedResourceReason = optionalString(
    ownData(value, 'resourceLimitReason', 'discovery-artifact-resource-limit-reason-invalid'),
    'discovery-artifact-resource-limit-reason-invalid',
  );
  const preflight = forcedResourceReason == null
    ? observedPreflight
    : deepFreeze({ ...observedPreflight, ok: false, reason: forcedResourceReason });
  if (!preflight.ok) return resourceLimitedArtifact({ status, binding, preflight });

  const evidence = arrayItems(rawEvidence, 'discovery-artifact-evidence-descriptor-invalid')
    .map((item) => createDiscoveryEvidence(item))
    .sort((left, right) => canonicalTypedString(left).localeCompare(canonicalTypedString(right)));
  const producerRuns = arrayItems(rawProducerRuns, 'discovery-artifact-producer-runs-descriptor-invalid')
    .map(producerRun).sort((left, right) => (
    left.id.localeCompare(right.id) || stableDigest(left).localeCompare(stableDigest(right))
  ));
  const candidates = canonicalCandidates(
    arrayItems(rawCandidates, 'discovery-artifact-candidates-descriptor-invalid'), evidence, status, binding,
  );
  const rawExpectedBinding = ownData(value, 'expectedBinding', 'discovery-artifact-expected-binding-invalid');
  const expectedBinding = rawExpectedBinding == null ? null : normalizeBinding(rawExpectedBinding);
  const supplied = arrayItems(rawByteIntervals, 'discovery-artifact-byte-intervals-descriptor-invalid')
    .map(normalizeByteInterval);
  const inferred = evidence.flatMap((item) => item.regions.map((region) => evidenceClaim(item, region)));
  const intervals = [...supplied, ...inferred].sort(compareInterval);
  if (new Set(intervals.map((item) => item.intervalId)).size !== intervals.length) {
    fail('discovery-artifact-byte-interval-id-duplicate');
  }
  const collisions = buildCollisions(intervals, evidence);
  const collisionIdsByStart = new Map();
  for (const item of collisions) {
    for (const alternative of item.alternatives) {
      if (alternative.candidateStart == null) continue;
      if (!collisionIdsByStart.has(alternative.candidateStart)) collisionIdsByStart.set(alternative.candidateStart, []);
      collisionIdsByStart.get(alternative.candidateStart).push(item.collisionId);
    }
  }
  const functionCandidates = candidates.map((candidate) => ({
    candidateId: `function-candidate:${candidate.start}`,
    start: candidate.start,
    name: candidate.name,
    startState: candidate.startState,
    extentState: candidate.extentState,
    digest: candidate.digest,
    collisionIds: [...new Set(collisionIdsByStart.get(candidate.start) ?? [])].sort(),
    startEvidenceIds: [...new Set(candidate.startEvidence.flatMap((item) => item.evidenceIds))].sort(),
    exact: hasExactStart(candidate),
  }));
  const references = evidence
    .map((item) => ({ item }))
    .filter(({ item }) => ['relocation-target', 'vtable-entry', 'jump-table-target'].includes(item.kind))
    .map(({ item }) => referenceMember(item))
    .sort((left, right) => compareAddress(left.address, right.address) || left.memberId.localeCompare(right.memberId));
  const publication = publicationState({ status, producerRuns, binding, expectedBinding, evidence, intervals, suppliedIntervals: supplied });
  const artifact = {
    schemaVersion: DISCOVERY_ARTIFACT_SCHEMA,
    binding,
    producerRuns,
    status,
    publication,
    resource: preflight,
    evidence,
    functionCandidates,
    intervalClaims: intervals,
    collisionSets: collisions,
    references,
  };
  return issueArtifact(artifact);
}

/**
 * Create the compact, identity-checked value placed in rebuild expected state.
 * A partial, stale, cancelled, or budget-limited artifact cannot cross this
 * boundary as complete rebuild evidence.
 */
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
    collisionSets: artifact.collisionSets,
    references: artifact.references,
  };
  if (payload.collisionSets.length === 0 && payload.references.length === 0) {
    fail('discovery-rebuild-ambiguity-required');
  }
  const rebuildBinding = deepFreeze({ ...payload, digest: stableDigest(payload) });
  ISSUED_REBUILD_BINDINGS.add(rebuildBinding);
  return rebuildBinding;
}

function rebuildBindingIdentityValid(binding) {
  if (!binding || binding.schemaVersion !== DISCOVERY_REBUILD_BINDING_SCHEMA || typeof binding.digest !== 'string') return false;
  const payload = { ...binding };
  delete payload.digest;
  return binding.digest === stableDigest(payload)
    && Array.isArray(binding.collisionSets)
    && Array.isArray(binding.references);
}

export function isFactoryIssuedDiscoveryRebuildBinding(binding) {
  return !!binding && ISSUED_REBUILD_BINDINGS.has(binding) && rebuildBindingIdentityValid(binding);
}

/** Reject a reparse which dropped or resolved any source ambiguity silently. */
export function verifyDiscoveryReparse(sourceBinding, reparsedArtifact, options = {}) {
  if (!isFactoryIssuedDiscoveryRebuildBinding(sourceBinding)) {
    return deepFreeze({ ok: false, reason: 'discovery-reparse-source-binding-invalid' });
  }
  if (!artifactIdentityValid(reparsedArtifact) || reparsedArtifact.publication?.status !== 'complete') {
    return deepFreeze({ ok: false, reason: 'discovery-reparse-artifact-invalid' });
  }
  if (sourceBinding.binding?.binaryId !== reparsedArtifact.binding?.binaryId
      || sourceBinding.binding?.architectureId !== reparsedArtifact.binding?.architectureId) {
    return deepFreeze({ ok: false, reason: 'discovery-reparse-identity-mismatch' });
  }
  let expectedOutputHash;
  try {
    expectedOutputHash = requiredString(options?.expectedOutputHash, 'discovery-reparse-output-hash-required');
  } catch {
    return deepFreeze({ ok: false, reason: 'discovery-reparse-output-hash-required' });
  }
  if (reparsedArtifact.binding?.sourceHash !== expectedOutputHash) {
    return deepFreeze({ ok: false, reason: 'discovery-reparse-output-hash-mismatch' });
  }
  const sourceCollisionIds = sortedStrings(sourceBinding.collisionSets?.map((item) => item.collisionId), 'discovery-reparse-collision-id-invalid');
  const reparsedCollisionIds = sortedStrings(reparsedArtifact.collisionSets?.map((item) => item.collisionId), 'discovery-reparse-collision-id-invalid');
  const missingCollisionIds = sourceCollisionIds.filter((id) => !reparsedCollisionIds.includes(id));
  const sourceReferenceIds = sortedStrings(sourceBinding.references?.map((item) => item.memberId), 'discovery-reparse-reference-id-invalid');
  const reparsedReferenceIds = sortedStrings(reparsedArtifact.references?.map((item) => item.memberId), 'discovery-reparse-reference-id-invalid');
  const missingReferenceIds = sourceReferenceIds.filter((id) => !reparsedReferenceIds.includes(id));
  const ok = missingCollisionIds.length === 0 && missingReferenceIds.length === 0;
  return deepFreeze({ ok, reason: ok ? null : 'discovery-reparse-ambiguity-lost', missingCollisionIds, missingReferenceIds });
}

function descriptorDataCopy(value, omitted = new Set()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); }
  catch { return {}; }
  const copy = {};
  for (const key of Object.keys(descriptors).sort()) {
    const descriptor = descriptors[key];
    if (omitted.has(key) || key === '__proto__' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) continue;
    copy[key] = descriptor.value;
  }
  return copy;
}

function descriptorArrayItems(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, String(index)); }
    catch { return []; }
    if (descriptor == null || !Object.hasOwn(descriptor, 'value')) return [];
    result.push(descriptor.value);
  }
  return result;
}

/** Attach canonical discovery state to function-search rows without selecting a winner. */
export function attachDiscoveryArtifactToSearchResult(result, artifact) {
  const valid = artifactIdentityValid(artifact);
  const byStart = new Map(valid ? artifact.functionCandidates.map((candidate) => [candidate.start, candidate]) : []);
  const cleanResult = descriptorDataCopy(result, new Set(['results', 'discoveryArtifact']));
  let resultDescriptor = null;
  try {
    resultDescriptor = result && typeof result === 'object'
      ? Object.getOwnPropertyDescriptor(result, 'results') : null;
  } catch { resultDescriptor = null; }
  const rawRows = resultDescriptor != null && Object.hasOwn(resultDescriptor, 'value')
    ? descriptorArrayItems(resultDescriptor.value) : [];
  const rows = rawRows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    const clean = descriptorDataCopy(row, new Set(['discovery']));
    let start = null;
    try { start = address(clean.address ?? clean.addr, 'discovery-search-address-invalid'); } catch { return clean; }
    const candidate = byStart.get(start);
    if (!candidate) return clean;
    return {
      ...clean,
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
  });
  return valid ? {
    ...cleanResult,
    results: rows,
    discoveryArtifact: {
      artifactId: artifact.artifactId,
      publication: artifact.publication,
      collisionCount: artifact.collisionSets.length,
      status: artifact.status,
    },
  } : { ...cleanResult, results: rows };
}
