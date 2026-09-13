/** Object/lifetime partitions over canonical points-to roots; not an alias owner. */
import { createPointsToTarget, provenSeparationAuthority } from './lattice.js';
import { createEntityId, deepFreeze, stableStringify, lossyTypeWitness } from '../../core/identity/index.js';
import { assertWorldScope, assertAssumptionSet } from '../../core/identity/world.js';
import { assertQualifiedJudgment } from '../../core/evidence/scoped.js';
import { snapshotContractData, recordFields, exactString, exactInteger, exactEnum, stringSet, signedIntegerText, contractFail } from '../../core/identity/structured.js';
import { assertScopedAnalysisWork } from '../../core/budgets/scoped-work.js';
import { describeCanonicalObjectLifetime } from './object-lifetime.js';

export const OBJECT_PARTITION_SCHEMA = 'object-memory-partition/v1';
export const OBJECT_KINDS = Object.freeze(['stack', 'heap', 'global', 'tls', 'objc', 'swift', 'cpp', 'closure', 'block', 'dispatch', 'buffer', 'mapped', 'unknown']);
const PARTITIONS = new WeakMap();
const ELIGIBLE = new WeakSet();
const equalData = (a, b) => stableStringify(a) === stableStringify(b) && stableStringify(lossyTypeWitness(a)) === stableStringify(lossyTypeWitness(b));

export function createObjectContext(value = { kind: 'context-insensitive', callSites: [], receiverPartition: null }) {
  const data = snapshotContractData(value, { maxBytes: 32768, maxNodes: 64 });
  recordFields(data, ['kind', 'callSites', 'receiverPartition'], 'object-context-fields');
  const kind = exactEnum(data.kind, ['context-insensitive', 'call-string', 'object-sensitive'], 'object-context-kind');
  if (!Array.isArray(data.callSites) || data.callSites.length > 4) contractFail('object-context-call-string-bound');
  const callSites = data.callSites.map((id) => exactString(id, 'object-context-call-site'));
  const receiverPartition = data.receiverPartition === null || data.receiverPartition === undefined ? null : exactString(data.receiverPartition, 'object-context-receiver');
  if (kind === 'context-insensitive' && (callSites.length || receiverPartition !== null)) contractFail('object-context-insensitive-fields');
  if (kind === 'call-string' && (!callSites.length || receiverPartition !== null)) contractFail('object-context-call-string-fields');
  if (kind === 'object-sensitive' && receiverPartition === null) contractFail('object-context-receiver-required');
  return deepFreeze({ kind, callSites, receiverPartition });
}
function nonnegativeText(value, code) {
  const text = signedIntegerText(value, code);
  if (BigInt(text) < 0n) contractFail(code);
  return text;
}
function extent(value = {}) {
  recordFields(value, ['minimumBytes', 'maximumBytes'], 'object-extent-fields');
  const minimumBytes = value.minimumBytes == null ? '0' : nonnegativeText(value.minimumBytes, 'object-minimum-size');
  const maximumBytes = value.maximumBytes == null ? null : nonnegativeText(value.maximumBytes, 'object-maximum-size');
  if (maximumBytes !== null && BigInt(minimumBytes) > BigInt(maximumBytes)) contractFail('object-size-order');
  return { minimumBytes, maximumBytes };
}
function subobject(value = {}) {
  recordFields(value, ['offset', 'size', 'layoutPath', 'overlapGroup', 'bitRange'], 'object-subobject-fields');
  const offset = value.offset == null ? null : signedIntegerText(value.offset, 'object-subobject-offset');
  const size = value.size == null ? null : nonnegativeText(value.size, 'object-subobject-size');
  let bitRange = null;
  if (value.bitRange !== null && value.bitRange !== undefined) {
    recordFields(value.bitRange, ['lsb', 'width'], 'object-bit-range-fields');
    bitRange = { lsb: exactInteger(value.bitRange.lsb, 'object-bit-lsb', { max: 1048576 }), width: exactInteger(value.bitRange.width, 'object-bit-width', { min: 1, max: 1048576 }) };
    if (size !== null && BigInt(bitRange.lsb + bitRange.width) > BigInt(size) * 8n) contractFail('object-bit-range-out-of-bounds');
  }
  const path = value.layoutPath ?? [];
  if (!Array.isArray(path) || path.length > 64) contractFail('object-layout-path');
  return { offset, size, layoutPath: path.map((part) => exactString(part, 'object-layout-path-entry')),
    overlapGroup: value.overlapGroup == null ? null : exactString(value.overlapGroup, 'object-overlap-group'), bitRange };
}

/**
 * Kind/lifetime/layout fields are annotations until qualified. In particular,
 * allocation-site identity does not mean singleton, and a new frame/context ID
 * does not by itself prove disjoint storage. The canonical alias solver remains
 * the only producer of Must/May/NoAlias answers.
 */
export function createObjectPartition(targetInput, { world, assumptions, context, description = {}, lifetimeOwner = null } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world);
  const target = createPointsToTarget(targetInput);
  const data = snapshotContractData(description, { allowBigInt: true, maxBytes: 262144 });
  recordFields(data, ['kind', 'allocationSite', 'lifetimeGeneration', 'extent', 'subobject', 'escape', 'evidenceIds'], 'object-description-fields');
  const root = snapshotContractData({ rootKey: target.rootKey, rootKind: target.rootKind, addressSpace: target.addressSpace,
    rootIdentity: target.rootIdentity, rootEntityId: target.rootEntityId, address: target.address,
    rootAuthority: provenSeparationAuthority(target), separationClass: target.separationClass }, { allowBigInt: true });
  const normalizedContext = createObjectContext(context);
  const lifetimeEvidence = lifetimeOwner ? describeCanonicalObjectLifetime(lifetimeOwner, target, normalizedContext, { world, assumptions }) : null;
  const body = {
    schema: OBJECT_PARTITION_SCHEMA, worldId: world.id, assumptionsId: assumptions.id, root,
    context: normalizedContext, kind: lifetimeEvidence?.kind !== undefined && lifetimeEvidence.kind !== 'unknown' ? lifetimeEvidence.kind : exactEnum(data.kind ?? 'unknown', OBJECT_KINDS, 'object-kind'),
    allocationSite: lifetimeEvidence?.allocationSite ?? (data.allocationSite == null ? null : exactString(data.allocationSite, 'object-allocation-site')),
    lifetimeGeneration: lifetimeEvidence?.lifetime.epoch ?? (data.lifetimeGeneration == null ? null : exactString(data.lifetimeGeneration, 'object-lifetime-generation')),
    extent: extent(data.extent), subobject: subobject(data.subobject),
    escape: exactEnum(data.escape ?? 'unknown', ['local', 'thread', 'global', 'unknown'], 'object-escape'),
    evidenceIds: stringSet([...target.evidenceIds, ...(data.evidenceIds ?? [])], 'object-evidence'),
    cardinality: lifetimeEvidence?.cardinality ?? 'unknown', lifetime: lifetimeEvidence?.lifetime ?? 'unknown', layoutAuthority: 'unqualified',
    ...(lifetimeEvidence ? { lifetimeEvidence } : {}),
  };
  const id = createEntityId({ binaryId: world.binarySet[0].binaryId, kind: OBJECT_PARTITION_SCHEMA, identity: body });
  const result = deepFreeze({ ...body, id });
  PARTITIONS.set(result, { target, world, assumptions });
  return result;
}
export function assertObjectPartition(value, world = null) {
  const binding = PARTITIONS.get(value);
  if (!binding || (world !== null && assertWorldScope(world).id !== value.worldId)) contractFail('object-partition-unbound');
  return value;
}

/** Geometric relation of DESCRIBED fields, deliberately not an alias verdict. */
export function compareSubobjectGeometry(left, right) {
  assertObjectPartition(left); assertObjectPartition(right);
  if (left.worldId !== right.worldId || left.assumptionsId !== right.assumptionsId) return deepFreeze({ relation: 'unknown', reason: 'object-world-mismatch', aliasAuthority: false });
  if (!equalData(left.root, right.root) || !equalData(left.context, right.context)
    || left.lifetimeGeneration !== right.lifetimeGeneration) return deepFreeze({ relation: 'unknown', reason: 'different-or-unproven-object-instance', aliasAuthority: false });
  const a = left.subobject, b = right.subobject;
  if ([a.offset, a.size, b.offset, b.size].some((value) => value === null)) return deepFreeze({ relation: 'unknown', reason: 'unbounded-subobject', aliasAuthority: false });
  const a0 = BigInt(a.offset) * 8n + BigInt(a.bitRange?.lsb ?? 0), b0 = BigInt(b.offset) * 8n + BigInt(b.bitRange?.lsb ?? 0);
  const a1 = a0 + (a.bitRange ? BigInt(a.bitRange.width) : BigInt(a.size) * 8n);
  const b1 = b0 + (b.bitRange ? BigInt(b.bitRange.width) : BigInt(b.size) * 8n);
  const empty = a1 === a0 || b1 === b0;
  const relation = empty ? 'empty-described-range' : a1 <= b0 || b1 <= a0 ? 'disjoint-described-bits'
    : a0 === b0 && a1 === b1 ? 'same-described-bits' : 'overlapping-described-bits';
  return deepFreeze({ relation, aliasAuthority: false, reason: 'layout-and-instance-proofs-required',
    intervals: [{ startBit: a0.toString(), endBit: a1.toString() }, { startBit: b0.toString(), endBit: b1.toString() }] });
}

export function objectObligationProposition(partition, kind, accessId = null) {
  assertObjectPartition(partition);
  exactEnum(kind, ['singleton', 'live', 'exclusive', 'layout', 'in-bounds-access'], 'object-obligation-kind');
  if (kind === 'in-bounds-access') exactString(accessId, 'object-access-id');
  else if (accessId !== null) contractFail('object-obligation-unexpected-access');
  return deepFreeze({ kind, partitionId: partition.id, ...(accessId === null ? {} : { accessId }) });
}

/** Eligibility is a proof-gated precondition, never an instruction to overwrite MSSA. */
export function strongUpdateEligibility(partition, { accessId, proofs = [] } = {}) {
  assertObjectPartition(partition);
  exactString(accessId, 'object-access-id');
  if (!Array.isArray(proofs) || proofs.length > 32) contractFail('object-proof-budget');
  const obligations = ['singleton', 'live', 'exclusive', 'layout', 'in-bounds-access'];
  const accepted = [];
  for (const kind of obligations) {
    const proposition = objectObligationProposition(partition, kind, kind === 'in-bounds-access' ? accessId : null);
    const proof = proofs.find((candidate) => {
      assertQualifiedJudgment(candidate);
      return candidate.world === partition.worldId && candidate.assumptions === partition.assumptionsId
        && candidate.subject === partition.id && candidate.quantifier === 'all-admitted-executions' && candidate.precision === 'exact'
        && candidate.executionStatus === 'completed' && candidate.obligations.length === 0 && equalData(candidate.value, proposition);
    });
    if (proof) accepted.push({ kind, judgmentId: proof.id });
  }
  const missing = obligations.filter((kind) => !accepted.some((entry) => entry.kind === kind));
  if (partition.root.rootKind === 'unknown' || partition.root.addressSpace === 'unknown') missing.push('root-binding');
  if (partition.lifetimeGeneration === null) missing.push('lifetime-generation');
  const result = deepFreeze({ schema: 'object-strong-update-eligibility/v1', partitionId: partition.id, accessId,
    worldId: partition.worldId, assumptionsId: partition.assumptionsId, eligible: missing.length === 0,
    missing, accepted, effect: 'precondition-only; canonical MemorySSA still owns writes' });
  if (result.eligible) ELIGIBLE.add(result);
  return result;
}
export function isQualifiedStrongUpdateEligibility(value, { partitionId, accessId, worldId, assumptionsId } = {}) {
  return ELIGIBLE.has(value) && value.partitionId === partitionId && value.accessId === accessId
    && value.worldId === worldId && value.assumptionsId === assumptionsId;
}

/** Demand projection: never expand heap objects or synthesize absent pointees. */
export async function partitionPointsToObjects(pointsTo, { world, assumptions, context, work, describeTarget = null, lifetimeOwner = null } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world); assertScopedAnalysisWork(work);
  if (!pointsTo || typeof pointsTo.top !== 'boolean' || !Array.isArray(pointsTo.targets)) contractFail('object-points-to-required');
  const partitions = [], unknowns = [];
  if (pointsTo.top) unknowns.push({ reason: 'points-to-top', lossReasons: stringSet(pointsTo.lossReasons ?? []) });
  if (!pointsTo.top && !pointsTo.targets.length) unknowns.push({ reason: 'points-to-bottom-not-proven-empty-memory' });
  for (const target of pointsTo.targets) {
    work.charge('nodes'); work.charge('workUnits'); work.charge('residentBytes', 1024);
    const description = typeof describeTarget === 'function' ? await work.await((signal) => describeTarget(target, { world, assumptions, signal })) : {};
    partitions.push(createObjectPartition(target, { world, assumptions, context, description, lifetimeOwner }));
    await work.yieldIfNeeded();
  }
  return deepFreeze({ schema: 'object-memory-view/v1', worldId: world.id, assumptionsId: assumptions.id,
    partitions, unknowns, completeness: unknowns.length ? 'partial' : 'bounded', aliasAuthority: false, cost: work.cost() });
}
