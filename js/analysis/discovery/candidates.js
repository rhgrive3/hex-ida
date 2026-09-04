/**
 * P7-6 — FunctionCandidate contract.
 *
 * The rule this file enforces is P7-INV-006: a function's *start* and its
 * *extent* are separate facts. A precise start with an unknown extent is a
 * perfectly good answer, and inventing one contiguous body to make downstream
 * analysis simpler is how false merges get published (FM-8).
 *
 * So a candidate carries two independent evidence lists and two independent
 * states. Nothing here lets a strong start upgrade a weak extent.
 */

import { deepFreeze, stableDigest } from '../../core/identity/index.js';
import { canonicalTypedValue } from './canonical-value.js';

export const FUNCTION_CANDIDATE_SCHEMA_VERSION = 1;

/**
 * Evidence classes, ordered by the authority they carry.
 *
 * `authoritative` producers can establish an exact start on their own;
 * `corroborating` ones support a start but cannot establish it alone;
 * `heuristic` ones only ever raise a candidate for consideration.
 */
export const EVIDENCE_AUTHORITY = Object.freeze({
  'loader-function-start': 'authoritative',
  'unwind-entry': 'authoritative',
  'debug-symbol': 'authoritative',
  'export': 'authoritative',
  'entrypoint': 'authoritative',
  'symbol-table': 'corroborating',
  'direct-call-target': 'corroborating',
  'relocation-target': 'corroborating',
  'vtable-entry': 'corroborating',
  'jump-table-target': 'corroborating',
  'runtime-metadata': 'corroborating',
  'exception-metadata': 'corroborating',
  'runtime-observation': 'corroborating',
  'prologue-candidate': 'heuristic',
  'alignment-heuristic': 'heuristic',
});

export const EVIDENCE_KINDS = Object.freeze(Object.keys(EVIDENCE_AUTHORITY));

/** Candidate states. `contradicted` is a first-class outcome, not an error. */
export const CANDIDATE_STATES = Object.freeze(['exact', 'probable', 'heuristic', 'contradicted']);

/** How a byte range is owned. Shared ownership is representable on purpose. */
export const REGION_OWNERSHIP = Object.freeze(['exclusive', 'shared', 'ambiguous']);

const KIND_SET = new Set(EVIDENCE_KINDS);
const OWNERSHIP_SET = new Set(REGION_OWNERSHIP);

function fail(code) { throw new TypeError(code); }

function address(value, code) {
  if (value == null) fail(code);
  const type = typeof value;
  if (type !== 'bigint' && type !== 'string' && !(type === 'number' && Number.isSafeInteger(value))) fail(code);
  try {
    const result = BigInt(value);
    if (result < 0n) fail(code);
    return result;
  } catch { fail(code); return 0n; }
}

function producerId(value) {
  if (value == null) return 'unknown';
  if (typeof value !== 'string' || value.length === 0) fail('discovery-evidence-invalid-producer-id');
  return value;
}

function optionalString(value, code) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length === 0) fail(code);
  return value;
}

function ownData(value, key, code) {
  let item;
  try { item = Object.getOwnPropertyDescriptor(value, key); }
  catch { fail(code); }
  if (item == null) return undefined;
  if (!Object.hasOwn(item, 'value')) fail(code);
  return item.value;
}

function dataArray(value, code) {
  if (!Array.isArray(value)) fail(code);
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (item == null || !Object.hasOwn(item, 'value')) fail(code);
    result.push(item.value);
  }
  return result;
}

function evidenceInput(input, overrides = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('discovery-evidence-input-invalid');
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) fail('discovery-evidence-overrides-invalid');
  const fields = [
    'kind', 'extentRole', 'extentCoverageComplete', 'start', 'regions', 'producerId', 'producerVersion',
    'architectureId', 'binaryId', 'sourceHash', 'snapshotId', 'referenceAddress',
    'relocationId', 'symbolicExpression', 'name', 'confidence', 'evidenceIds',
  ];
  const result = {};
  for (const key of fields) {
    result[key] = ownData(input, key, `discovery-evidence-${key}-accessor-invalid`);
    const override = ownData(overrides, key, `discovery-evidence-${key}-override-accessor-invalid`);
    if (override !== undefined) result[key] = override;
  }
  return result;
}

function confidence(value) {
  if (value == null) return null;
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  fail('discovery-evidence-invalid-confidence');
  return null;
}

function plainObject(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  let prototype;
  try { prototype = Object.getPrototypeOf(value); }
  catch { fail(code); }
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  return value;
}

function snapshotConflictValue(value, seen = new WeakSet()) {
  if (value == null || ['string', 'boolean', 'bigint'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || seen.has(value)) fail('discovery-candidate-conflict-invalid');
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = dataArray(value, 'discovery-candidate-conflict-accessor-invalid')
      .map((item) => snapshotConflictValue(item, seen));
  } else {
    plainObject(value, 'discovery-candidate-conflict-invalid');
    result = {};
    let keys;
    try { keys = Object.keys(value).sort(); }
    catch { fail('discovery-candidate-conflict-invalid'); }
    for (const key of keys) {
      result[key] = snapshotConflictValue(
        ownData(value, key, 'discovery-candidate-conflict-accessor-invalid'), seen,
      );
    }
  }
  seen.delete(value);
  return result;
}

function candidateInput(input) {
  const value = plainObject(input, 'discovery-candidate-input-invalid');
  const result = {};
  for (const key of [
    'start', 'name', 'regions', 'startEvidence', 'extentEvidence', 'startState',
    'extentState', 'conflicts', 'architectureId', 'allowRegionsWithUnknownExtent',
  ]) {
    result[key] = ownData(value, key, `discovery-candidate-${key}-accessor-invalid`);
  }
  return result;
}

/**
 * How much of a function's extent one piece of evidence describes.
 *
 * `complete` claims the whole body; `partial` claims one range of a body that
 * may have others. The distinction is what lets a non-contiguous function be
 * assembled from several unwind entries without those entries looking like
 * competing answers to the same question.
 */
export const EXTENT_ROLES = Object.freeze(['complete', 'partial']);

/** One piece of evidence about a start or an extent. */
export function createDiscoveryEvidence(input = {}, overrides = {}) {
  const snapshot = evidenceInput(input, overrides);
  const kind = typeof snapshot.kind === 'string' ? snapshot.kind : '';
  if (!KIND_SET.has(kind)) fail(`discovery-evidence-unknown-kind:${kind}`);
  const extentRole = snapshot.extentRole == null ? 'complete' : (typeof snapshot.extentRole === 'string' ? snapshot.extentRole : '');
  if (!EXTENT_ROLES.includes(extentRole)) fail('discovery-evidence-invalid-extent-role');
  if (snapshot.extentCoverageComplete != null && typeof snapshot.extentCoverageComplete !== 'boolean') {
    fail('discovery-evidence-invalid-extent-coverage');
  }
  const evidenceIds = dataArray(snapshot.evidenceIds ?? [], 'discovery-evidence-invalid-evidence-id');
  if (evidenceIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    fail('discovery-evidence-invalid-evidence-id');
  }
  const regions = dataArray(snapshot.regions ?? [], 'discovery-evidence-invalid-regions');
  return deepFreeze({
    kind,
    authority: EVIDENCE_AUTHORITY[kind],
    extentRole,
    extentCoverageComplete: snapshot.extentCoverageComplete === true,
    start: snapshot.start == null ? null : address(snapshot.start, 'discovery-evidence-invalid-start').toString(),
    regions: deepFreeze(regions.map((region) => createRegion(region))),
    // Producer identity participates in corroboration. Pre-registry evidence
    // may omit it, but any explicit identity must already be canonical.
    producerId: producerId(snapshot.producerId),
    producerVersion: optionalString(snapshot.producerVersion, 'discovery-evidence-invalid-producer-version') ?? 'unknown',
    architectureId: optionalString(snapshot.architectureId, 'discovery-evidence-invalid-architecture-id'),
    binaryId: optionalString(snapshot.binaryId, 'discovery-evidence-invalid-binary-id'),
    sourceHash: optionalString(snapshot.sourceHash, 'discovery-evidence-invalid-source-hash'),
    snapshotId: optionalString(snapshot.snapshotId, 'discovery-evidence-invalid-snapshot-id'),
    referenceAddress: snapshot.referenceAddress == null ? null : address(snapshot.referenceAddress, 'discovery-evidence-invalid-reference-address').toString(),
    relocationId: optionalString(snapshot.relocationId, 'discovery-evidence-invalid-relocation-id'),
    symbolicExpression: snapshot.symbolicExpression == null ? null : canonicalTypedValue(snapshot.symbolicExpression),
    name: optionalString(snapshot.name, 'discovery-evidence-invalid-name'),
    confidence: confidence(snapshot.confidence),
    evidenceIds: [...new Set(evidenceIds)].sort(),
  });
}

export function createRegion(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('discovery-region-invalid');
  const start = address(ownData(input, 'start', 'discovery-region-start-accessor-invalid'), 'discovery-region-invalid-start');
  const end = address(ownData(input, 'end', 'discovery-region-end-accessor-invalid'), 'discovery-region-invalid-end');
  if (end <= start) fail('discovery-region-empty');
  const rawOwnership = ownData(input, 'ownership', 'discovery-region-ownership-accessor-invalid');
  const ownership = rawOwnership == null ? 'exclusive' : (typeof rawOwnership === 'string' ? rawOwnership : '');
  if (!OWNERSHIP_SET.has(ownership)) fail('discovery-region-invalid-ownership');
  return deepFreeze({ start: start.toString(), end: end.toString(), ownership });
}

export function regionsOverlap(a, b) {
  return BigInt(a.start) < BigInt(b.end) && BigInt(b.start) < BigInt(a.end);
}

/**
 * A discovered function candidate.
 *
 * `extentState` defaults to `unknown` and stays there unless extent evidence
 * actually supports something better. That default is the whole point: an
 * unknown extent must be cheap to report and impossible to forget.
 */
export function createFunctionCandidate(input = {}) {
  const snapshot = candidateInput(input);
  const start = address(snapshot.start, 'discovery-candidate-invalid-start');
  const startState = snapshot.startState == null ? 'heuristic' : (typeof snapshot.startState === 'string' ? snapshot.startState : '');
  if (!CANDIDATE_STATES.includes(startState)) fail('discovery-candidate-invalid-start-state');
  const extentState = snapshot.extentState == null ? 'unknown' : (typeof snapshot.extentState === 'string' ? snapshot.extentState : '');
  if (extentState !== 'unknown' && !CANDIDATE_STATES.includes(extentState)) fail('discovery-candidate-invalid-extent-state');

  const regions = dataArray(snapshot.regions ?? [], 'discovery-candidate-regions-invalid').map((region) => createRegion(region));
  regions.sort((left, right) => {
    const leftStart = BigInt(left.start);
    const rightStart = BigInt(right.start);
    if (leftStart < rightStart) return -1;
    if (leftStart > rightStart) return 1;
    const leftEnd = BigInt(left.end);
    const rightEnd = BigInt(right.end);
    if (leftEnd < rightEnd) return -1;
    if (leftEnd > rightEnd) return 1;
    return left.ownership.localeCompare(right.ownership);
  });
  if (extentState === 'unknown' && regions.length > 0 && snapshot.allowRegionsWithUnknownExtent !== true) {
    fail('discovery-candidate-unknown-extent-cannot-claim-regions');
  }

  const name = snapshot.name == null ? null : optionalString(snapshot.name, 'discovery-candidate-invalid-name');
  const architectureId = snapshot.architectureId == null
    ? null : optionalString(snapshot.architectureId, 'discovery-candidate-invalid-architecture-id');

  const candidate = {
    schemaVersion: FUNCTION_CANDIDATE_SCHEMA_VERSION,
    start: start.toString(),
    name,
    regions: deepFreeze(regions),
    startEvidence: deepFreeze(dataArray(snapshot.startEvidence ?? [], 'discovery-candidate-start-evidence-invalid')
      .map((evidence) => createDiscoveryEvidence(evidence))),
    extentEvidence: deepFreeze(dataArray(snapshot.extentEvidence ?? [], 'discovery-candidate-extent-evidence-invalid')
      .map((evidence) => createDiscoveryEvidence(evidence))),
    startState,
    extentState,
    conflicts: deepFreeze(dataArray(snapshot.conflicts ?? [], 'discovery-candidate-conflicts-invalid')
      .map((item) => snapshotConflictValue(item))),
    architectureId,
  };
  candidate.digest = stableDigest({
    start: candidate.start,
    name: candidate.name,
    regions: candidate.regions,
    startEvidence: candidate.startEvidence,
    extentEvidence: candidate.extentEvidence,
    startState: candidate.startState,
    extentState: candidate.extentState,
    conflicts: candidate.conflicts,
    architectureId: candidate.architectureId,
  });
  return deepFreeze(candidate);
}

/**
 * The single accessor for "is this definitely a function start?".
 *
 * A contradicted candidate is never exact, whatever its evidence count says.
 */
export function hasExactStart(candidate) {
  return candidate.startState === 'exact' && !candidate.conflicts.some((conflict) => conflict.kind === 'start');
}

export function hasKnownExtent(candidate) {
  return candidate.extentState !== 'unknown' && candidate.regions.length > 0;
}
