/** Context views belong to the existing summary owner, not a second solver.
 * The SCC fixed point remains in interprocedural.js. This adapter substitutes
 * bound physical inputs and object offsets ONLY within a selected call context.
 * Open effects are retained and candidates never replace a canonical summary.
 */
import { createFunctionSummary, functionSummaryDigest } from './contract.js';
import { assertCanonicalQueryProjection } from '../query/semantic/projection.js';
import { bindScopedFlowInputs } from '../scoped-flow-projection.js';
import { assertWorldScope, assertAssumptionSet } from '../../core/identity/world.js';
import { createEntityId, deepFreeze, stableStringify } from '../../core/identity/index.js';
import { snapshotContractData, contractFail } from '../../core/identity/structured.js';
import { assertScopedAnalysisWork } from '../../core/budgets/scoped-work.js';

export const SUMMARY_SPECIALIZATION_VERSION = '1.0.0';
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
  const ids = new Set([actual.valueId, actual.compatibilityValueId]);
  const bindings = demand.ranges?.bindings?.filter(row => ids.has(row.semanticSsaValueId) || ids.has(row.semanticValueId)) ?? [];
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
  const ids = new Set([actual.valueId, actual.compatibilityValueId]);
  const row = demand.objects.find(item => ids.has(item.valueId));
  return row ? { pointsTo: row.pointsTo, partitions: row.partitions, unknowns: row.unknowns }
    : { pointsTo: null, partitions: [], unknowns: [{ reason: 'argument-object-view-unavailable' }] };
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
    sourceArtifactIds: specialization.dependencies.positiveArtifactIds, bindings,
    authority: 'explicit-call-context-assumptions; not-unconditional-input-truth' });
}
export function attachDemandContextRanges(specialization, projected) {
  assertSummarySpecialization(specialization);
  if (!projected) return specialization;
  const { conditionalRanges, artifactId, ownerIdentity } = projected;
  if (conditionalRanges?.contextId !== specialization.id || conditionalRanges.worldId !== specialization.worldId
    || conditionalRanges.snapshotId !== specialization.snapshotId || ownerIdentity?.functionId !== specialization.functionId
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
