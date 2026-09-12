/** A demand slice of the existing owners, captured once on the platform worker.
 * No parallel points-to, SSA, range, summary or ABI engine is created here.
 * All outputs are scoped navigation/conditional facts, never new exact truth.
 */
import { captureNativeFingerprint } from '../recognition/native-context.js';
import { createAnalysisSurface } from './index.js';
import { createWorldScope, createAssumptionSet, worldContains } from '../core/identity/world.js';
import { deepFreeze, stableStringify, stableDigest, createEntityId } from '../core/identity/index.js';
import { recordFields, snapshotContractData, stringSet, exactInteger, exactString, contractFail } from '../core/identity/structured.js';
import { ScopedAnalysisWork, AnalysisWorkStopped } from '../core/budgets/scoped-work.js';
import { seedAnalysisState } from '../decompiler/phase8/transaction.js';
import { canonicalAnalysisIdentity } from '../decompiler/phase8/analysis-identity.js';
import { requestDemandRanges } from '../decompiler/phase8/demand-range.js';
import { createObjectContext, partitionPointsToObjects, compareSubobjectGeometry } from './pointsto/objects.js';
import { projectCanonicalPhysicalTypes } from './types/scoped-physical.js';
import { ESCAPE_ANALYZER_VERSION } from './summary/escape.js';
import { createCanonicalObjectLifetimeOwner } from './pointsto/object-lifetime.js';
import { queryScopedAbiPlacement } from './types/scoped-abi.js';
import { projectScopedFlowInputs } from './scoped-flow-projection.js';

export const SCOPED_DEMAND_OWNER_VERSION = '1.0.0';
export const DEMAND_PRECISION_SCHEMA = 'scoped-precision-request/v1';
const GOALS = ['constant', 'known-bits', 'interval', 'congruence', 'alignment', 'pointer-offset'];
export function normalizeDemandPrecision(value = {}) {
  const input = snapshotContractData(value, { maxBytes: 65536, maxNodes: 1024 });
  recordFields(input, ['schema', 'valueIds', 'goals', 'maximumValues'], 'demand-precision-fields');
  if (input.schema !== undefined && input.schema !== DEMAND_PRECISION_SCHEMA) contractFail('demand-precision-schema');
  const goals = stringSet(input.goals ?? GOALS, 'demand-precision-goals', 6);
  if (!goals.length || goals.some(goal => !GOALS.includes(goal))) contractFail('demand-precision-goal');
  return deepFreeze({ schema: DEMAND_PRECISION_SCHEMA, valueIds: stringSet(input.valueIds ?? [], 'demand-precision-values', 64),
    maximumValues: exactInteger(input.maximumValues ?? 32, 'demand-precision-value-limit', { min: 1, max: 64 }), goals });
}

function objectDescription(target, access = null) {
  // Root kind is an owner annotation, NOT singleton/lifetime/separation proof.
  const root = String(target.rootKind ?? '');
  const annotated = access?.geometry === 'canonical-region-description' ? access.region.kind : null;
  const kind = annotated === 'stack-fixed' ? 'stack' : annotated === 'global-fixed' || annotated === 'global-absolute' ? 'global' : /stack/.test(root) ? 'stack' : /alloc|heap/.test(root) ? 'heap'
    : /global/.test(root) ? 'global' : /tls/.test(root) ? 'tls' : 'unknown';
  const range = target.offsetRange;
  const offset = range?.min != null && range.max === range.min ? range.min : null;
  return { kind, subobject: { offset }, escape: 'unknown', evidenceIds: target.evidenceIds ?? [] };
}

/** Index only the actual MemorySSA owner's access bindings. Definitions which
 * merely may alias remain effect upper bounds, never exact address geometry.
 * Missing/broad records cannot turn a load/store into an empty effect.
 */
function memoryOwnerView(pipeline, work) {
  const memory = pipeline.memorySsa, ir = pipeline.semanticIr;
  const regions = new Map((memory?.regions ?? []).map(row => [row.id, row]));
  const nodes = new Map(ir.nodes.map(row => [row.id, row]));
  const entities = new Map([...(memory?.definitions ?? []), ...(memory?.uses ?? [])].map(row => [row.id, row]));
  const byNode = new Map(), accesses = [], frontier = [];
  for (const binding of memory?.canonicalAccessBindings ?? []) {
    work.charge('workUnits');
    const node = nodes.get(binding.nodeId), entity = entities.get(binding.memorySsaEntityId), region = regions.get(binding.regionId);
    if (!node?.memory || !['load', 'store'].includes(node.kind)) continue;
    if (!entity || !region || entity.sourceEntityId !== node.id || binding.sourceEntityId !== node.id) {
      frontier.push({ reason: 'memory-access-owner-binding-incomplete', nodeId: node.id }); continue;
    }
    const list = byNode.get(node.id) ?? []; list.push({ binding, region, entity }); byNode.set(node.id, list);
    const addressValueId = node.memory.addressExpr?.valueId ?? null;
    accesses.push({ nodeId: node.id, kind: node.kind, memoryEntityId: entity.id, memoryKind: entity.kind ?? null,
      addressValueId, valueIds: node.kind === 'store' ? node.inputs.filter(id => id !== addressValueId) : node.outputs,
      region, binding, widthBits: node.memory.widthBits, endian: node.memory.endian,
      evidenceIds: [...new Set([node.id, entity.id, ...(node.origin?.instructionIds ?? [])])],
      geometry: binding.broad !== true && binding.aliasRelation === 'must' && region.kind !== 'unknown'
        ? 'canonical-region-description' : 'open-alias-upper', exact: false });
    if (accesses.length >= 1024) { frontier.push({ reason: 'memory-access-view-cut' }); break; }
  }
  return { accesses, frontier, resolveRegion: (_memory, { node }) => {
    const rows = byNode.get(node.id);
    // All effects, including broad/unknown regions, survive this adapter.
    return rows?.length ? [...new Map(rows.map(row => [row.region.id, row.region])).values()] : null;
  } };
}
async function projectMemoryObjects(memory, points, world, assumptions, work, lifetimeOwner) {
  const accesses = [], comparisons = [], frontier = [...memory.frontier];
  for (const access of memory.accesses) {
    work.charge('workUnits');
    const set = points?.pointsTo?.get(access.addressValueId) ?? points?.ssaPointsTo?.get(access.addressValueId);
    let view = { partitions: [], unknowns: [{ reason: 'address-points-to-unavailable' }] };
    if (set) view = await partitionPointsToObjects(set, { world, assumptions, work, context: createObjectContext(), lifetimeOwner,
      describeTarget: target => ({ ...objectDescription(target, access), subobject: { ...objectDescription(target, access).subobject,
        size: Number.isSafeInteger(access.widthBits) && access.widthBits > 0 && access.widthBits % 8 === 0
          ? String(access.widthBits / 8) : null }, evidenceIds: [...new Set([...(target.evidenceIds ?? []), ...access.evidenceIds])] }) });
    accesses.push({ ...access, partitions: view.partitions, unknowns: view.unknowns,
      extentAuthority: 'access-width-not-allocation-size', lifetime: 'unknown', strongUpdateEligible: false });
    await work.yieldIfNeeded();
  }
  // A bounded geometrical read-only projection. Disjoint described bits do not
  // qualify NoAlias or runtime uniqueness, even for a stack/allocation site.
  const partitions = accesses.flatMap(row => row.partitions.map(partition => ({ nodeId: row.nodeId, partition })));
  let cut = false;
  outer: for (let i = 0; i < partitions.length; i++) for (let j = i + 1; j < partitions.length; j++) {
    work.charge('workUnits');
    if (comparisons.length >= 256) { cut = true; break outer; }
    const a = partitions[i], b = partitions[j];
    comparisons.push({ leftNodeId: a.nodeId, rightNodeId: b.nodeId, leftPartitionId: a.partition.id,
      rightPartitionId: b.partition.id, ...compareSubobjectGeometry(a.partition, b.partition) });
  }
  if (cut) frontier.push({ reason: 'memory-object-geometry-comparison-cut' });
  return { schema: 'canonical-memory-object-view/v1', accesses, comparisons, frontier, aliasAuthority: false, exact: false };
}

async function projectNativeAbiPlacements(owner, input, world, assumptions, work) {
  const pipeline = owner.pipeline, adapter = owner.abiAdapter, views = [], frontier = [];
  if (typeof input.producerArtifactId !== 'string' || !input.producerArtifactId) return {
    views, frontier: [{ reason: 'native-abi-artifact-owner-unbound' }], exact: false };
  const requests = [{ kind: 'arguments', callSiteId: null, call: null }, { kind: 'return', callSiteId: null, call: null }];
  for (const node of pipeline.legacyV1.instructions) {
    work.charge('workUnits');
    if (node.op !== 'call') continue;
    if (requests.length >= 18) { frontier.push({ reason: 'native-abi-callsite-cut' }); break; }
    // Compatibility call sites carry the original canonical node ID; no
    // instruction address or display name is substituted for that identity.
    const callSiteId = node.semanticNodeId ?? node.extra?.semanticNodeId ?? null;
    if (!callSiteId || !pipeline.semanticIr.nodes.some(row => row.id === callSiteId && row.call)) {
      frontier.push({ reason: 'native-abi-canonical-call-binding-unavailable' }); continue;
    }
    requests.push({ kind: 'arguments', callSiteId, call: node });
  }
  for (const request of requests) {
    work.charge('workUnits', 128);
    const result = request.kind === 'arguments' ? adapter.classifyArguments({ call: request.call }) : adapter.classifyFunctionReturn();
    if (!result) { views.push({ kind: request.kind, callSiteId: request.callSiteId, status: 'unsupported', reason: 'canonical-abi-prototype-or-owner-unavailable', exact: false }); continue; }
    const binding = { worldId: world.id, assumptionsId: assumptions.id, snapshotId: input.snapshotId,
      binaryId: pipeline.binaryId, functionId: pipeline.functionId, kind: request.kind, callSiteId: request.callSiteId,
      producerArtifactId: input.producerArtifactId, ownerRevision: adapter.semanticVersion };
    // This happens BEFORE structured cloning, preserving the canonical ABI
    // owner's hidden same-object stack-mirror authority through validation.
    const { cost: _cost, ...view } = await queryScopedAbiPlacement({ functionId: pipeline.functionId,
      kind: request.kind, callSiteId: request.callSiteId }, { world, assumptions, snapshotId: input.snapshotId, work, allowPartialDeclarations: true,
      getContext: async () => ({ binding, result, isCurrent: () => !work.signal.aborted }) });
    views.push({ kind: request.kind, callSiteId: request.callSiteId, ...view });
    await work.yieldIfNeeded();
  }
  return { schema: 'native-abi-placement-view/v1', views, frontier, exact: false,
    authority: 'registered-abi-classifier; prototypes-and-machine-behavior-not-inferred' };
}

export async function projectScopedDemandOwners(owner, semanticResult, request, { signal = null, limits = {} } = {}) {
  const input = snapshotContractData(request, { maxBytes: 2 * 1024 * 1024, maxNodes: 32768 });
  recordFields(input, ['kind', 'snapshotId', 'worldId', 'world', 'assumptions', 'precision', 'context', 'producerArtifactId'], 'demand-owner-fields');
  if (input.kind !== 'demand') contractFail('demand-owner-kind');
  const world = createWorldScope(input.world), assumptions = createAssumptionSet(input.assumptions, world);
  const precision = normalizeDemandPrecision(input.precision);
  if (input.worldId !== world.id) contractFail('demand-owner-world');
  const work = new ScopedAnalysisWork({ limits, signal, name: 'scoped-demand-worker' });
  try {
    work.checkpoint();
    const pipeline = owner?.pipeline, transported = semanticResult?.pipeline, ir = pipeline?.semanticIr;
    const base = { schema: 'scoped-local-owner-projection/v1', version: SCOPED_DEMAND_OWNER_VERSION, kind: 'demand',
      worldId: world.id, assumptionsId: assumptions.id, snapshotId: input.snapshotId,
      binaryId: pipeline?.binaryId ?? null, functionId: pipeline?.functionId ?? null,
      precision, exact: false, authority: 'existing-owners; query-scoped; not-independent-semantic-proof' };
    const finish = value => { work.checkpoint(); return deepFreeze({ ...base, ...value, workerCost: work.cost() }); };
    if (!pipeline || !pipeline.legacyV1 || pipeline.instrumentation?.v2Executed !== true
      || owner.snapshotId !== input.snapshotId || pipeline.semanticIr !== transported?.semanticIr || pipeline.ssa !== transported?.ssa
      || !worldContains(world, pipeline.binaryId, pipeline.sliceId) || semanticResult.architectureId !== 'arm64'
      || semanticResult.abiId !== world.profile.abi || semanticResult.abiSemanticVersion !== world.profile.abiRevision) {
      return finish({ status: 'unsupported', reason: 'demand-canonical-owner-unbound' });
    }
    if (!Array.isArray(ir?.nodes) || !Array.isArray(ir?.values) || ir.nodes.length > 1024 || ir.values.length > 2048
      || (pipeline.ssa?.definitions?.length ?? 0) > 4096 || (pipeline.ssa?.uses?.length ?? 0) > 8192) {
      return finish({ status: 'unsupported', reason: 'demand-local-owner-structural-bound' });
    }
    const flow = await projectScopedFlowInputs(owner, semanticResult, { kind: 'flow-inputs', snapshotId: input.snapshotId,
      worldId: world.id, world, assumptions }, { signal: work.signal, work });
    const selected = new Set(), frontier = [], available = new Set();
    for (const value of ir.values) { work.charge('workUnits'); available.add(value.id); }
    for (const definition of pipeline.ssa.definitions) { work.charge('workUnits'); available.add(definition.valueId); }
    const add = id => {
      if (typeof id !== 'string' || selected.has(id)) return;
      if (selected.size >= precision.maximumValues) return;
      if (available.has(id)) selected.add(id);
    };
    if (precision.valueIds.length) {
      for (const id of precision.valueIds) {
        add(id);
        if (!selected.has(id)) frontier.push({ valueId: id, reason: available.has(id) ? 'demand-value-limit' : 'value-outside-owner' });
      }
    } else {
      for (const parameter of flow.inputs?.parameters ?? []) add(parameter.valueId);
      for (const call of flow.inputs?.calls ?? []) for (const argument of call.arguments) add(argument.valueId);
      // Demand only values feeding memory, control and call boundaries, not an
      // eager upgrade of every SSA value in every function.
      for (const node of ir.nodes) {
        work.charge('workUnits');
        if (node.memory || node.call || ['load', 'store', 'branch', 'conditional-branch', 'return'].includes(node.kind)) {
          for (const id of [...(node.call?.targetValueIds ?? []), ...(node.inputs ?? []), ...(node.outputs ?? [])]) add(id);
        }
      }
      if (!selected.size) frontier.push({ reason: 'no-interesting-canonical-values' });
      if (selected.size === precision.maximumValues) frontier.push({ reason: 'automatic-demand-may-be-truncated' });
      // Request existing owner facts for the dependencies of the chosen cut.
      // In particular an indexed address needs its masked/extended index,
      // even when the final address interval is conservatively full.
      const nodesById = new Map(ir.nodes.map(node => [node.id, node]));
      const producers = new Map(), definitions = new Map(), uses = new Map();
      for (const node of ir.nodes) {
        work.charge('workUnits'); for (const id of node.outputs) producers.set(id, node);
      }
      for (const definition of pipeline.ssa.definitions) { work.charge('workUnits'); definitions.set(definition.valueId, definition); }
      for (const use of pipeline.ssa.uses) {
        work.charge('workUnits'); const list = uses.get(use.sourceEntityId) ?? []; list.push(use.valueId); uses.set(use.sourceEntityId, list);
      }
      let cut = false;
      for (const id of selected) {
        work.charge('workUnits');
        const definition = definitions.get(id), node = producers.get(id) ?? nodesById.get(definition?.sourceEntityId);
        const dependencies = [...(node?.inputs ?? []), ...(uses.get(node?.id) ?? []),
          ...(definition ? [definition.sourceEntityId, ...(definition.incoming ?? []).map(row => row.valueId)] : [])];
        for (const dependency of dependencies) {
          work.charge('workUnits');
          if (available.has(dependency) && !selected.has(dependency) && selected.size >= precision.maximumValues) cut = true;
          add(dependency);
        }
      }
      if (cut) frontier.push({ reason: 'demand-dependency-value-limit' });
    }
    // Synchronous owners have real fixed caps. Reserve a deterministic upper
    // work estimate BEFORE invoking them; no uncharged child CPU after abort.
    work.charge('workUnits', Math.max(1, ir.values.length) * 8 + ir.nodes.length * 4);
    work.charge('residentBytes', ir.values.length * 256 + ir.nodes.length * 256);
    const memoryView = memoryOwnerView(pipeline, work);
    const surface = createAnalysisSurface({ ir, cfg: pipeline.cfg, ssa: pipeline.ssa, memorySsa: pipeline.memorySsa,
      snapshotId: input.snapshotId, resolveRegion: memoryView.resolveRegion, options: { signal: work.signal,
        budget: { maxValues: 2048, maxIterations: 8, widenAfterIterations: 3, maxTargetsPerSet: 8 },
        memorySsaBinding: { snapshotId: input.snapshotId, functionId: pipeline.functionId,
          semanticIrVersion: ir.contractVersion, memorySsaBuildVersion: pipeline.memorySsa?.buildVersion ?? null,
          completeness: ir.completeness === 'complete' ? 'complete' : 'partial' } } });
    const points = surface.pointsTo(); work.checkpoint();
    work.charge('workUnits', Math.max(1, ir.nodes.length) * 16);
    const escaped = surface.escape(); work.checkpoint();
    const escape = { schema: 'canonical-escape-view/v1', version: ESCAPE_ANALYZER_VERSION,
      records: (escaped?.escapes ?? []).slice(0, 256), status: escaped?.status ?? null,
      omittedRecords: Math.max(0, (escaped?.escapes?.length ?? 0) - 256),
      authority: 'existing-summary-escape-owner; no-new-lifetime-or-separation-proof' };
    const summaryOwner = surface.functionSummary(); work.checkpoint();
    const lifetimeOwner = createCanonicalObjectLifetimeOwner({ binaryId: pipeline.binaryId, ir, cfg: pipeline.cfg,
      pointsToRun: points, escapeResult: escaped, summary: summaryOwner?.summary ?? summaryOwner,
      world, assumptions, snapshotId: input.snapshotId, work });
    const objects = [];
    for (const valueId of [...selected].sort()) {
      work.charge('workUnits');
      const set = points?.pointsTo?.get(valueId) ?? points?.ssaPointsTo?.get(valueId);
      if (!set) { frontier.push({ valueId, reason: 'points-to-unavailable' }); continue; }
      const view = await partitionPointsToObjects(set, { world, assumptions, work, context: createObjectContext(), lifetimeOwner,
        describeTarget: objectDescription });
      objects.push({ valueId, pointsTo: set, partitions: view.partitions, unknowns: view.unknowns,
        ownerStatus: points.status, aliasAuthority: false });
    }
    const legacy = pipeline.legacyV1;
    const context = { ir: { ...legacy, binaryId: pipeline.binaryId, functionId: pipeline.functionId, snapshotId: input.snapshotId }, abi: owner.abiAdapter };
    context.analysis = seedAnalysisState(context.ir);
    const identity = canonicalAnalysisIdentity(context), bindings = [];
    for (const value of legacy.values) {
      work.charge('workUnits');
      if (selected.has(value.semanticValueId) || selected.has(value.semanticSsaValueId)) {
        if (bindings.length >= 128) { frontier.push({ reason: 'compat-value-binding-limit' }); break; }
        bindings.push({ localId: value.id, semanticValueId: value.semanticValueId ?? null,
          semanticSsaValueId: value.semanticSsaValueId ?? null, bits: value.bits ?? null });
      }
    }
    const ids = [...new Set(bindings.map(row => row.localId))].sort((a, b) => a - b);
    const ranges = ids.length && identity.valid ? await requestDemandRanges(context,
      { valueIds: ids, goals: precision.goals, mode: 'reuse-or-refresh' }, { world, assumptions, work, publish: false })
      : { status: 'unsupported', reason: 'selected-values-have-no-bound-phase8-view', values: [], exact: false };
    if (ranges.status !== 'completed') frontier.push({ reason: ranges.reason ?? `ranges-${ranges.status}` });
    let conditionalRanges = null;
    if (input.context != null) {
      const request = input.context;
      recordFields(request, ['schema', 'contextId', 'functionId', 'callerFunctionId', 'callSiteId', 'worldId',
        'assumptionsId', 'snapshotId', 'sourceArtifactIds', 'bindings', 'authority', 'contextDependencyKey'], 'demand-context-fields');
      exactString(request.contextDependencyKey, 'demand-context-dependency-key');
      if (request.schema !== 'scpa-conditional-input-request/v1' || request.worldId !== world.id
        || request.assumptionsId !== assumptions.id || request.snapshotId !== input.snapshotId
        || request.functionId !== pipeline.functionId || !Array.isArray(request.bindings) || request.bindings.length > 32) contractFail('demand-context-owner-binding');
      const constraints = [], conditionRows = [];
      for (const binding of request.bindings) {
        work.charge('workUnits');
        recordFields(binding, ['valueId', 'compatibilityValueId', 'register', 'bits', 'constant', 'sourceFactId'], 'demand-context-input-fields');
        const parameter = flow.inputs?.parameters.find(row => row.valueId === binding.valueId
          && row.compatibilityValueId === binding.compatibilityValueId && row.register === binding.register && row.widthBits === binding.bits);
        if (!parameter) contractFail('demand-context-parameter-not-owned');
        const conditionId = createEntityId({ binaryId: pipeline.binaryId, kind: 'scpa-call-input-condition',
          identity: { contextId: request.contextId, binding, sourceArtifactIds: request.sourceArtifactIds } });
        let matched = false;
        for (const value of legacy.values) {
          work.charge('workUnits');
          if (value.kind !== 'arg' || value.def != null || value.bits !== binding.bits
            || ![binding.valueId, binding.compatibilityValueId].includes(value.semanticSsaValueId)) continue;
          if (constraints.length >= 32) { frontier.push({ reason: 'conditional-input-value-limit' }); break; }
          constraints.push({ valueId: value.id, bits: binding.bits, operator: 'eq', constant: binding.constant,
            truth: true, assumptionId: conditionId }); matched = true;
        }
        conditionRows.push({ ...binding, conditionId, matched, semanticAuthority: false });
      }
      const conditionalAssumptions = createAssumptionSet({ predicates: [...assumptions.predicates, ...conditionRows.filter(row => row.matched).map(row => row.conditionId)],
        provenance: [...assumptions.provenance, ...stringSet(request.sourceArtifactIds, 'demand-context-source-artifacts', 8)],
        satisfiability: 'not-checked' }, world);
      const refined = constraints.length ? await requestDemandRanges(context,
        { valueIds: [...new Set([...ids, ...constraints.map(row => row.valueId)])], goals: precision.goals, mode: 'refresh', constraints },
        { world, assumptions: conditionalAssumptions, work, publish: false, propagateInputs: true,
          resolveConstraint: constraint => ({ worldId: world.id, assumptionsId: conditionalAssumptions.id,
            constraintDigest: stableDigest(constraint), propositionBound: true }) })
        : { status: 'unsupported', reason: 'no-bound-context-entry-values', values: [] };
      conditionalRanges = { ...refined, contextId: request.contextId, contextDependencyKey: request.contextDependencyKey,
        parentAssumptionsId: assumptions.id, worldId: world.id, snapshotId: input.snapshotId,
        assumptions: conditionalAssumptions, inputConditions: conditionRows, exact: false,
        authority: 'conditional-existing-sccp-propagation; no-global-publication',
        bindings: legacy.values.filter(value => ids.includes(value.id) || constraints.some(row => row.valueId === value.id))
          .map(value => ({ localId: value.id, semanticValueId: value.semanticValueId ?? null, semanticSsaValueId: value.semanticSsaValueId ?? null, bits: value.bits })) };
      if (refined.status !== 'completed') frontier.push({ reason: refined.reason ?? 'conditional-range-incomplete', contextId: request.contextId });
    }
    const abiPlacements = await projectNativeAbiPlacements(owner, input, world, assumptions, work);
    const memoryObjects = await projectMemoryObjects(memoryView, points, world, assumptions, work, lifetimeOwner);
    frontier.push(...memoryObjects.frontier, ...abiPlacements.frontier);
    const types = selected.size ? projectCanonicalPhysicalTypes(pipeline, [...selected], { worldId: world.id, snapshotId: input.snapshotId, signal: work.signal })
      : { status: 'unsupported', reason: 'no-selected-canonical-values', types: [], exact: false };
    work.checkpoint();
    const result = { status: 'completed', selectedValues: [...selected].sort(), objects, memoryObjects, abiPlacements, escape,
      ranges: { ...ranges, bindings, ownerIdentity: identity.valid ? identity.identity : null }, conditionalRanges, types,
      summary: summaryOwner?.summary ?? null, summaryStatus: summaryOwner?.status ?? null,
      nativeFlowInputs: flow.status === 'completed' ? flow.inputs : null,
      fingerprint: captureNativeFingerprint(owner, input, summaryOwner?.summary, work),
      frontier: [...frontier, ...(flow.status === 'completed' ? [] : [{ reason: flow.reason ?? 'abi-inputs-unavailable' }])],
      ownerVersions: { semanticIr: ir.contractVersion, ssa: pipeline.ssa.buildVersion,
        memorySsa: pipeline.memorySsa?.buildVersion ?? null },
      publication: 'isolated-query-projection-only; no-global-fact-narrowing' };
    work.charge('residentBytes', stableStringify(result).length * 2);
    return finish(result);
  } catch (error) {
    if (error instanceof AnalysisWorkStopped && !error.cost) error.cost = work.cost();
    throw error;
  } finally { work.dispose(); }
}
