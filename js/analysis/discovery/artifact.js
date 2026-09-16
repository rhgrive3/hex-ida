/**
 * T016 — immutable ambiguity-preserving discovery artifact.
 *
 * Current-main discovery fusion remains the sole authority for candidate
 * derivation. This module snapshots that result together with its evidence,
 * producer identities and unresolved conflicts so rebuild/reparse consumers
 * cannot silently strengthen or discard uncertainty.
 */

import { deepFreeze, stableDigest } from '../../core/identity/index.js';
import { createAnalysisStatus } from '../status.js';
import { createDiscoveryEvidence, createFunctionCandidate, hasExactStart } from './candidates.js';
import { canonicalTypedDigest, canonicalTypedString } from './canonical-value.js';

export const DISCOVERY_ARTIFACT_SCHEMA = 'hex-discovery-ambiguity-artifact/v2';
export const DISCOVERY_REBUILD_BINDING_SCHEMA = 'hex-discovery-rebuild-binding/v2';
export const DISCOVERY_ARTIFACT_DEFAULT_BUDGET = deepFreeze({
  maxEvidence: 200000,
  maxCandidates: 200000,
  maxProducerRuns: 1024,
  maxIntervals: 400000,
  maxReferences: 200000,
});

const REFERENCE_KINDS = new Set(['relocation-target', 'vtable-entry']);
const ISSUED_ARTIFACTS = new WeakSet();
const ISSUED_REBUILD_BINDINGS = new WeakSet();

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

function normalizeBinding(input = {}) {
  const value = record(input, 'discovery-artifact-binding-invalid');
  return deepFreeze({
    binaryId: optionalToken(own(value, 'binaryId', 'discovery-artifact-binary-id-invalid'), 'discovery-artifact-binary-id-invalid'),
    sourceHash: optionalToken(own(value, 'sourceHash', 'discovery-artifact-source-hash-invalid'), 'discovery-artifact-source-hash-invalid'),
    snapshotId: optionalToken(own(value, 'snapshotId', 'discovery-artifact-snapshot-id-invalid'), 'discovery-artifact-snapshot-id-invalid'),
    architectureId: optionalToken(own(value, 'architectureId', 'discovery-artifact-architecture-id-invalid'), 'discovery-artifact-architecture-id-invalid'),
  });
}

function budgetValue(value, fallback, name) {
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > fallback) {
    fail(`discovery-artifact-budget-${name}-invalid`);
  }
  return value;
}

function normalizeBudget(input = {}) {
  const value = record(input, 'discovery-artifact-budget-invalid');
  const result = {};
  for (const [name, fallback] of Object.entries(DISCOVERY_ARTIFACT_DEFAULT_BUDGET)) {
    result[name] = budgetValue(own(value, name, `discovery-artifact-budget-${name}-invalid`), fallback, name);
  }
  return deepFreeze(result);
}

function normalizeStatus(input) {
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

function normalizeProducerRun(input) {
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

function compareAddress(left, right) {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalCandidates(raw) {
  return arrayItems(raw, 'discovery-artifact-candidates-invalid')
    .map((item) => createFunctionCandidate(item))
    .sort((a, b) => compareAddress(a.start, b.start) || String(a.architectureId ?? '').localeCompare(String(b.architectureId ?? '')));
}

function conflictRecord(candidate, conflict, index) {
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

function candidateIntervals(candidate) {
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

function referenceRecord(item) {
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

function publicationState({ status, binding, producerRuns, evidence }) {
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

function artifactPayload(artifact) {
  const payload = { ...artifact };
  delete payload.artifactId;
  return payload;
}

function artifactIdentityValid(artifact) {
  return !!artifact && ISSUED_ARTIFACTS.has(artifact)
    && artifact.schemaVersion === DISCOVERY_ARTIFACT_SCHEMA
    && artifact.artifactId === `discovery-artifact:${stableDigest(artifactPayload(artifact))}`;
}

function issueArtifact(payload) {
  const artifact = deepFreeze({ artifactId: `discovery-artifact:${stableDigest(payload)}`, ...payload });
  ISSUED_ARTIFACTS.add(artifact);
  return artifact;
}

export function createDiscoveryArtifact(input = {}) {
  const value = record(input, 'discovery-artifact-input-invalid');
  const budget = normalizeBudget(own(value, 'budget', 'discovery-artifact-budget-invalid') ?? {});
  const rawEvidence = own(value, 'evidence', 'discovery-artifact-evidence-invalid') ?? [];
  const rawCandidates = own(value, 'candidates', 'discovery-artifact-candidates-invalid') ?? [];
  const rawRuns = own(value, 'producerRuns', 'discovery-artifact-producer-runs-invalid') ?? [];
  if (!Array.isArray(rawEvidence) || !Array.isArray(rawCandidates) || !Array.isArray(rawRuns)) {
    fail('discovery-artifact-array-invalid');
  }
  if (rawEvidence.length > budget.maxEvidence || rawCandidates.length > budget.maxCandidates || rawRuns.length > budget.maxProducerRuns) {
    fail('discovery-artifact-budget-exhausted');
  }

  const status = normalizeStatus(own(value, 'status', 'discovery-artifact-status-invalid'));
  const binding = normalizeBinding(own(value, 'binding', 'discovery-artifact-binding-invalid') ?? {});
  if (binding.snapshotId != null && status.snapshotId !== binding.snapshotId) {
    fail('discovery-artifact-status-snapshot-mismatch');
  }
  const evidence = arrayItems(rawEvidence, 'discovery-artifact-evidence-invalid')
    .map((item) => createDiscoveryEvidence(item))
    .sort((a, b) => canonicalTypedString(a).localeCompare(canonicalTypedString(b)));
  const candidates = canonicalCandidates(rawCandidates);
  const producerRuns = arrayItems(rawRuns, 'discovery-artifact-producer-runs-invalid')
    .map(normalizeProducerRun).sort((a, b) => a.id.localeCompare(b.id));

  const collisionSets = candidates.flatMap((candidate) => candidate.conflicts.map((conflict, index) => conflictRecord(candidate, conflict, index)))
    .sort((a, b) => a.collisionId.localeCompare(b.collisionId));
  const collisionIdsByStart = new Map();
  for (const collision of collisionSets) {
    if (!collisionIdsByStart.has(collision.candidateStart)) collisionIdsByStart.set(collision.candidateStart, []);
    collisionIdsByStart.get(collision.candidateStart).push(collision.collisionId);
  }
  const intervalClaims = candidates.flatMap(candidateIntervals)
    .sort((a, b) => compareAddress(a.start, b.start) || compareAddress(a.end, b.end) || a.intervalId.localeCompare(b.intervalId));
  const references = evidence.filter((item) => REFERENCE_KINDS.has(item.kind) && item.start != null)
    .map(referenceRecord).sort((a, b) => compareAddress(a.address, b.address) || a.memberId.localeCompare(b.memberId));
  if (intervalClaims.length > budget.maxIntervals || references.length > budget.maxReferences) {
    fail('discovery-artifact-budget-exhausted');
  }

  const functionCandidates = candidates.map((candidate) => deepFreeze({
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

  const publication = deepFreeze(publicationState({ status, binding, producerRuns, evidence }));
  return issueArtifact({
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

export function isFactoryIssuedDiscoveryArtifact(artifact) {
  return artifactIdentityValid(artifact);
}

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
    functionCandidates: artifact.functionCandidates,
    intervalClaims: artifact.intervalClaims,
    collisionSets: artifact.collisionSets,
    references: artifact.references,
  };
  const rebuild = deepFreeze({ ...payload, digest: stableDigest(payload) });
  ISSUED_REBUILD_BINDINGS.add(rebuild);
  return rebuild;
}

function rebuildBindingValid(binding) {
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

export function verifyDiscoveryReparse(sourceBinding, reparsedArtifact, options = {}) {
  if (!rebuildBindingValid(sourceBinding)) return deepFreeze({ ok: false, reason: 'discovery-reparse-source-binding-invalid' });
  if (!artifactIdentityValid(reparsedArtifact) || reparsedArtifact.publication?.status !== 'complete') {
    return deepFreeze({ ok: false, reason: 'discovery-reparse-artifact-invalid' });
  }
  if (sourceBinding.binding.binaryId !== reparsedArtifact.binding.binaryId
      || sourceBinding.binding.architectureId !== reparsedArtifact.binding.architectureId) {
    return deepFreeze({ ok: false, reason: 'discovery-reparse-identity-mismatch' });
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
  if (!artifactIdentityValid(artifact)) return result;
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
