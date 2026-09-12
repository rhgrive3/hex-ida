/** Context views belong to the existing summary owner, not a second solver.
 * The SCC fixed point remains in interprocedural.js. This adapter substitutes
 * bound physical inputs and object offsets ONLY within a selected call context.
 * Open effects are retained and candidates never replace a canonical summary.
 */
import { createFunctionSummary, functionSummaryDigest, classifyCallTargetProof } from './contract.js';
import { assertCanonicalQueryProjection } from '../query/semantic/projection.js';
import { bindScopedFlowInputs } from '../scoped-flow-projection.js';
import { assertWorldScope, assertAssumptionSet } from '../../core/identity/world.js';
import { createEntityId, deepFreeze, stableStringify } from '../../core/identity/index.js';
import { snapshotContractData, contractFail } from '../../core/identity/structured.js';
import { assertScopedAnalysisWork } from '../../core/budgets/scoped-work.js';

export const SUMMARY_SPECIALIZATION_VERSION = '1.1.0';
const OWNED = new WeakSet();
const same = (a, b) => stableStringify(a) === stableStringify(b);
function captureDemand(entry, world, assumptions, snapshotId) {
  const { projection, demand } = entry;
  assertCanonicalQueryProjection(projection, { world, assumptions });
  if (demand?.schema !== 'scoped-local-owner-projection/v1' || demand.kind !== 'demand'
    || demand.version !== '1.0.0' || demand.status !== 'completed' || demand.worldId !== world.id
    || demand.assumptionsId !== assumptions.id || demand.snapshotId !== snapshotId
    || demand.functionId !== projection.functionId || demand.binaryId !== projection.inputIdentity.binaryId) {
    contractFail('summary-specialization-owner-binding');
  }
  return bindScopedFlowInputs(demand.nativeFlowInputs, projection, { world, assumptions, snapshotId });
}
function contextualRange(demand, actual) {
  const allBindings = demand.ranges?.bindings ?? [];
  const boundTo = id => allBindings.filter(row => row.semanticSsaValueId === id || row.semanticValueId === id);
  // The definition at the call is the requested program point. A compatible
  // earlier value may now also be in the backward demand slice; its distinct
  // valueId/provenance must neither hide the exact call input nor replace it.
  const primary = boundTo(actual.valueId);
  const bindings = primary.length ? primary : boundTo(actual.compatibilityValueId);
  const rows = demand.ranges?.values?.filter(row => bindings.some(binding => binding.localId === row.localId)
    && row.fact && row.completeness === 'complete' && !row.conditionalOn?.length) ?? [];
  if (!rows.length || rows.some(row => !same(row.fact, rows[0].fact))) return null;
  const row = rows[0], fact = row.fact;
  if (fact.bits !== actual.widthBits) return null;
  // A projected constant is evidence for a conditional specialization, not
  // proof that the selected target is called or the program reaches the site.
  return { sourceFactId: row.entityId, fact, conditionalOn: ['selected-call-is-executed', 'physical-argument-binding-is-valid'],
    nullness: fact.constant == null ? 'unknown' : BigInt(fact.constant.value) === 0n ? 'null' : 'non-null' };
}
function contextualObjects(demand, actual) {
  const primary = demand.objects.filter(item => item.valueId === actual.valueId);
  const rows = primary.length ? primary : demand.objects.filter(item => item.valueId === actual.compatibilityValueId);
  const row = rows[0];
  if (rows.some(item => !same(item.pointsTo, row.pointsTo) || !same(item.partitions, row.partitions))) {
    return { pointsTo: null, partitions: [], unknowns: [{ reason: 'argument-object-projections-disagree' }] };
  }
  return row ? { pointsTo: row.pointsTo, partitions: row.partitions, unknowns: row.unknowns }
    : { pointsTo: null, partitions: [], unknowns: [{ reason: 'argument-object-view-unavailable' }] };
}
function prototypeDependency(demand, callSiteId) {
  const views = demand.abiPlacements?.views?.filter(row => row.callSiteId == null || row.callSiteId === callSiteId) ?? [];
  return views.length ? views.map(row => ({ kind: row.kind, callSiteId: row.callSiteId, status: row.status,
    binding: row.binding ?? null, canonicalOwner: row.canonicalOwner ?? null, results: row.results ?? [], reason: row.reason ?? null }))
    : [{ status: 'unknown', reason: 'canonical-prototype-placement-unavailable' }];
}
function contextDependencies(caller, callee, callSiteId, targetBinding, summary, sccRevision, world, assumptions, snapshotId, work) {
  const reference = caller.projection.entityReference('semantic-ir', callSiteId);
  const callNode = reference && caller.projection.source(reference);
  if (!callNode?.call) contractFail('summary-context-call-source-unavailable');
  const source = targetBinding.sourceBinding;
  if (source?.callerInput && !same(source.callerInput, caller.projection.inputIdentity)
    || source?.calleeInput && !same(source.calleeInput, callee.projection.inputIdentity)) contractFail('summary-context-target-source-stale');
  const targets = classifyCallTargetProof(callNode.call);
  const objects = entry => {
    // The demand owner retains the full roots and lifetime evidence. Context
    // identity binds those exact rows without duplicating their deep object
    // graphs in every specialization/evidence node. These IDs are dependency
    // keys only; a digest is never an alias or lifetime proof.
    const rows = snapshotContractData(entry.demand.objects, { allowBigInt: true, maxBytes: 2 * 1024 * 1024, maxNodes: 32768 });
    work.charge('residentBytes', stableStringify(rows).length * 2);
    return rows.map(row => ({ valueId: row.valueId,
      sourceIdentity: createEntityId({ binaryId: entry.projection.inputIdentity.binaryId, kind: 'summary-object-context-input', identity: row }),
      partitions: row.partitions.map(partition => ({ id: partition.id, rootKey: partition.root.rootKey,
        cardinality: partition.cardinality, lifetimeGeneration: partition.lifetimeGeneration,
        subobject: partition.subobject, extent: partition.extent,
        lifetimeSource: partition.lifetimeEvidence?.sourceDigest ?? null })) }));
  };
  const body = snapshotContractData({ schema: 'summary-context-dependencies/v1', version: SUMMARY_SPECIALIZATION_VERSION,
    worldId: world.id, assumptionsId: assumptions.id, snapshotId, profile: world.profile,
    caller: caller.projection.inputIdentity, callee: callee.projection.inputIdentity,
    abi: { id: world.profile.abi, revision: world.profile.abiRevision,
      callerPrototype: prototypeDependency(caller.demand, callSiteId), calleePrototype: prototypeDependency(callee.demand, null) },
    dispatch: { callSiteId, sourceCall: callNode.call, candidateEntityIds: targets.candidateEntityIds,
      exhaustive: targets.exhaustive, selectedTarget: targetBinding,
      selectedSummaryMembership: caller.demand.summary?.indirectCallSets?.filter(row => row.callSiteId === callSiteId) ?? [] },
    memory: { model: world.profile.memoryModel, caller: objects(caller), callee: objects(callee),
      callerMssa: caller.projection.inputIdentity.ownerDigests.memoryssa, calleeMssa: callee.projection.inputIdentity.ownerDigests.memoryssa },
    summaryDigest: functionSummaryDigest(summary), sccRevision,
    sourceCompleteness: summary.status.completeness }, { allowBigInt: true, maxBytes: 2 * 1024 * 1024, maxNodes: 32768 });
  work.charge('residentBytes', stableStringify(body).length * 2); work.charge('workUnits', caller.demand.objects.length + callee.demand.objects.length + 16);
  return deepFreeze({ ...body, key: createEntityId({ binaryId: caller.projection.inputIdentity.binaryId,
    kind: 'summary-context-dependencies', identity: body }) });
}
function instantiateEffect(effect, inputs, work, demand) {
  work.charge('workUnits');
  if (effect.broad || !effect.region) return { source: effect, instantiated: [], upper: 'TOP',
    reason: effect.broad ? 'canonical-broad-effect-retained' : 'parameter-root-not-bound' };
  // MemorySSA may name the complete effective address rather than the incoming
  // parameter root. Join that SAME region/access to its native points-to view;
  // never infer the offset from instruction text or a display register name.
  const roots = [{ rootEntityId: effect.region.rootEntityId, relative: effect.region.offset, evidenceIds: effect.evidenceIds }];
  for (const access of demand.memoryObjects?.accesses ?? []) {
    work.charge('workUnits');
    if (access.region.id !== effect.regionId || access.geometry !== 'canonical-region-description') continue;
    for (const partition of access.partitions) {
      work.charge('workUnits');
      if (partition.subobject.offset != null) roots.push({ rootEntityId: partition.root.rootEntityId,
        relative: partition.subobject.offset, evidenceIds: [...access.evidenceIds, ...partition.evidenceIds] });
    }
  }
  const instantiated = [], seen = new Set();
  for (const root of roots) {
    if (!root.rootEntityId || root.relative == null) continue;
    const matches = inputs.filter(input => input.parameterObjects?.pointsTo?.targets?.some(target => target.rootEntityId === root.rootEntityId));
    if (matches.length !== 1) continue;
    const binding = matches[0], parameterSet = binding.parameterObjects.pointsTo, points = binding.objects.pointsTo;
    if (parameterSet.top || parameterSet.targets.length !== 1
      || String(parameterSet.targets[0].offsetRange?.min) !== '0'
      || String(parameterSet.targets[0].offsetRange?.max) !== '0' || !points || points.top) continue;
    for (const target of points.targets) {
      work.charge('workUnits');
      const range = target.offsetRange;
      if (range?.min == null || range.max == null) continue;
      const row = { rootEntityId: target.rootEntityId, rootKey: target.rootKey, addressSpace: target.addressSpace,
        minimumOffset: (BigInt(range.min) + BigInt(root.relative)).toString(), maximumOffset: (BigInt(range.max) + BigInt(root.relative)).toString(),
        widthBits: effect.region.widthBits, parameterValueId: binding.parameter.valueId, actualValueId: binding.actual.valueId,
        evidenceIds: [...new Set([...(effect.evidenceIds ?? []), ...(root.evidenceIds ?? []), ...(target.evidenceIds ?? [])])].sort(),
        exact: false, aliasAuthority: false };
      const key = stableStringify(row); if (seen.has(key)) continue; seen.add(key);
      if (instantiated.length >= 64) return { source: effect, instantiated, upper: 'TOP', reason: 'context-memory-candidate-cut' };
      instantiated.push(row);
    }
  }
  return { source: effect, instantiated, upper: 'TOP', reason: instantiated.length
    ? 'conditional-object-offset-candidates; lifetime-and-call-feasibility-open' : 'parameter-root-or-origin-open' };
}
export async function specializeDemandSummary({ caller, callee, callSiteId, summary, sccRevision = null,
  targetBinding, world, assumptions, snapshotId, work } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world); assertScopedAnalysisWork(work);
  const callerPorts = captureDemand(caller, world, assumptions, snapshotId), calleePorts = captureDemand(callee, world, assumptions, snapshotId);
  const owned = createFunctionSummary(snapshotContractData(summary, { allowBigInt: true, maxBytes: 1048576, maxNodes: 32768 }));
  if (owned.functionId !== callee.projection.functionId || owned.status.snapshotId !== snapshotId
    || targetBinding?.callerFunctionId !== caller.projection.functionId || targetBinding.callSiteId !== callSiteId
    || targetBinding.targetFunctionId !== callee.projection.functionId || targetBinding.inSelectedScope !== true) contractFail('summary-specialization-call-binding');
  const call = callerPorts.calls.find(row => row.callSiteId === callSiteId);
  const contextDependency = contextDependencies(caller, callee, callSiteId, targetBinding, owned, sccRevision, world, assumptions, snapshotId, work);
  const inputs = [], obligations = ['call-target-feasibility', 'physical-input-meaning-unqualified',
    'context-is-not-an-object-instance', 'exception-and-lifetime-effects-open'];
  for (const parameter of calleePorts.parameters) {
    work.charge('workUnits');
    const actuals = call?.arguments.filter(row => row.register === parameter.register && row.widthBits === parameter.widthBits) ?? [];
    if (actuals.length !== 1) { obligations.push(`unbound-parameter:${parameter.valueId}`); continue; }
    const actual = actuals[0];
    inputs.push({ parameter, actual, range: contextualRange(caller.demand, actual), objects: contextualObjects(caller.demand, actual),
      parameterObjects: contextualObjects(callee.demand, parameter) });
    await work.yieldIfNeeded();
  }
  const reads = owned.memoryReadRegions.map(effect => instantiateEffect(effect, inputs, work, callee.demand));
  const writes = owned.memoryWriteRegions.map(effect => instantiateEffect(effect, inputs, work, callee.demand));
  // No return-branch address can masquerade as an ABI result. Until a return
  // port is bound by the ABI owner, return provenance remains explicit TOP.
  const returns = owned.returnValues.map(valueId => ({ valueId, upper: 'TOP', reason: 'abi-result-port-required' }));
  const body = { schema: 'summary-specialization/v1', version: SUMMARY_SPECIALIZATION_VERSION,
    worldId: world.id, assumptionsId: assumptions.id, snapshotId, functionId: owned.functionId,
    callerFunctionId: caller.projection.functionId, callSiteId, context: { kind: 'call-string', callSites: [callSiteId], depth: 1 },
    contextDependencyKey: contextDependency.key, contextDependencies: contextDependency,
    inputs, reads, writes, returns, escapes: owned.escapes, calls: { direct: owned.directCalls,
      indirect: owned.indirectCallSets, unknown: owned.unknownCallEffects },
    exceptionalExits: [{ mayThrow: owned.mayThrow, upper: 'TOP' }], continuationEdges: [],
    sourceSummaryDigest: functionSummaryDigest(owned), sccRevision,
    completeness: { source: owned.status.completeness, semanticClosure: 'unknown', contextTransfer: 'conditional-input-and-object-substitution' },
    dependencies: { positiveArtifactIds: [...new Set([caller.projection.inputIdentity.producerArtifactId,
      callee.projection.inputIdentity.producerArtifactId].filter(Boolean))].sort(),
      negativeMembership: [{ selector: { kind: 'dispatch-targets', ownerId: caller.projection.functionId, partition: callSiteId }, polarity: 'complete-membership' }] },
    targetBinding, obligations: [...new Set(obligations)].sort(), exact: false,
    authority: 'existing-summary-context-view; canonical-summary-not-replaced' };
  work.charge('residentBytes', stableStringify(body).length * 2); work.checkpoint();
  const result = deepFreeze({ ...body, id: createEntityId({ binaryId: caller.projection.inputIdentity.binaryId,
    kind: 'summary-specialization', identity: body }) });
  OWNED.add(result); return result;
}
export function assertSummarySpecialization(value, { world = null, callerFunctionId = null, callSiteId = null, functionId = null } = {}) {
  if (!OWNED.has(value) || world && value.worldId !== world.id || callerFunctionId && value.callerFunctionId !== callerFunctionId
    || callSiteId && value.callSiteId !== callSiteId || functionId && value.functionId !== functionId) contractFail('summary-specialization-not-owned');
  return value;
}

/** Only an owned context can request another isolated owner evaluation. Values
 * cross the worker boundary as explicit assumptions, never as canonical facts.
 */
export function demandContextRangeRequest(specialization) {
  assertSummarySpecialization(specialization);
  const bindings = specialization.inputs.filter(input => input.range?.fact?.constant != null)
    .map(input => ({ valueId: input.parameter.valueId, compatibilityValueId: input.parameter.compatibilityValueId,
      register: input.parameter.register, bits: input.parameter.widthBits,
      constant: String(input.range.fact.constant.value), sourceFactId: input.range.sourceFactId }));
  if (!bindings.length) return null;
  return deepFreeze({ schema: 'scpa-conditional-input-request/v1', contextId: specialization.id,
    functionId: specialization.functionId, callerFunctionId: specialization.callerFunctionId, callSiteId: specialization.callSiteId,
    worldId: specialization.worldId, assumptionsId: specialization.assumptionsId, snapshotId: specialization.snapshotId,
    contextDependencyKey: specialization.contextDependencyKey,
    sourceArtifactIds: specialization.dependencies.positiveArtifactIds, bindings,
    authority: 'explicit-call-context-assumptions; not-unconditional-input-truth' });
}
export function attachDemandContextRanges(specialization, projected) {
  assertSummarySpecialization(specialization);
  if (!projected) return specialization;
  const { conditionalRanges, artifactId, ownerIdentity } = projected;
  if (conditionalRanges?.contextId !== specialization.id || conditionalRanges.worldId !== specialization.worldId
    || conditionalRanges.snapshotId !== specialization.snapshotId || ownerIdentity?.functionId !== specialization.functionId
    || conditionalRanges.parentAssumptionsId !== specialization.assumptionsId
    || conditionalRanges.contextDependencyKey !== specialization.contextDependencyKey
    || !same(ownerIdentity.ownerDigests, specialization.contextDependencies.callee.ownerDigests)
    || typeof artifactId !== 'string' || conditionalRanges.exact !== false) contractFail('summary-context-ranges-binding');
  // Timings and remaining parent quotas are execution receipts, never context
  // identity. The native worker cost has already been charged to the parent.
  const { cost: _cost, ...rangeView } = conditionalRanges;
  const body = { ...specialization, valueProjection: rangeView,
    dependencies: { ...specialization.dependencies, positiveArtifactIds: [...new Set([
      ...specialization.dependencies.positiveArtifactIds, artifactId])].sort() } };
  delete body.id;
  const result = deepFreeze({ ...body, id: createEntityId({ binaryId: ownerIdentity.binaryId,
    kind: 'summary-specialization', identity: body }) });
  OWNED.add(result); return result;
}
