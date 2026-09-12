/** Read-only boundary navigation from the existing ABI/compat/SSA/MSSA owners.
 * This is deliberately NOT function-argument inference: an unknown incoming
 * register stays unknown and a possible ABI input stays possible. Declared
 * returns are consumed only when the canonical ABI-to-IR owner bound them.
 * Memory versions are borrowed verbatim; no alias, kill or forwarding proof
 * is inferred here. Stack, aggregate and exception-value ports remain open.
 */
import { resolveABIPlugin } from '../targets/abi/index.js';
import { createWorldScope, createAssumptionSet, assertWorldScope, assertAssumptionSet, worldContains } from '../core/identity/world.js';
import { deepFreeze, lossyTypeWitness, stableDigest } from '../core/identity/index.js';
import { snapshotContractData, recordFields, exactString, contractFail } from '../core/identity/structured.js';
import { AnalysisWorkStopped, ScopedAnalysisWork, assertScopedAnalysisWork } from '../core/budgets/scoped-work.js';
import { assertCanonicalQueryProjection } from './query/semantic/projection.js';
import { assertScopedCanonicalOwner } from './semantic-function.js';
import { isCanonicalMemorySsaProducerArtifact } from '../semantics/memoryssa/build.js';

export const SCOPED_FLOW_PROJECTION_VERSION = '1.1.0';
export const SCOPED_ABI_INPUT_SCHEMA = 'scoped-physical-register-inputs/v2';
export const SCOPED_ABI_INPUT_LIMITS = Object.freeze({ values: 16384, instructions: 8192, parameters: 64, calls: 512, argumentsPerCall: 64,
  ports: 3000, memoryDefinitions: 16384, memoryUses: 16384, regions: 4096, blocks: 8192 });
const OPEN = Object.freeze(['abi-prototype-and-arity-unqualified', 'incoming-register-state-is-not-an-exact-parameter',
  'stack-aggregate-subregister-and-vector-inputs-open', 'hidden-result-and-exception-value-ports-open']);
const physical = (definition) => definition?.proof?.variableIdentity?.physicalIdentity;
const isInputDefinition = (definition) => definition?.kind === 'entry'
  || definition?.kind === 'undef' && definition.proof?.kind === 'implicit-undef'
    && definition.proof?.sourceSemanticEntityId == null;
function scalarDefinition(definition, register) {
  const type = definition?.proof?.machineType, state = physical(definition);
  return state?.kind === 'register' && state.registerId === register
    && type?.kind === 'bitvector' && type.widthBits === 64 && definition.proof?.broadUnknown !== true;
}
function valuePort(value, definitions, physicalDefinitions) {
  if (!value || value.bits !== 64 || typeof value.reg !== 'string' || typeof value.semanticSsaValueId !== 'string') return null;
  const compatible = definitions.get(value.semanticSsaValueId);
  let definition = compatible;
  // Compatibility may refer to the scalar value definition while the SSA
  // owner also records its register assignment. Join only a UNIQUE existing
  // assignment with the SAME source semantic value; never infer from spelling.
  if (!scalarDefinition(definition, value.reg)) {
    if (!compatible?.proof?.sourceSemanticValueId) return null;
    definition = physicalDefinitions.get(JSON.stringify([value.reg, compatible.proof.sourceSemanticValueId]));
  }
  if (!scalarDefinition(definition, value.reg)) return null;
  return { register: value.reg, widthBits: 64, valueId: definition.valueId,
    definitionId: definition.definitionId, canonicalKind: definition.kind, compatibilityValueId: value.semanticSsaValueId };
}

const physicalScalar = (definition, register) => physical(definition)?.kind === 'register'
  && physical(definition).registerId === register && definition.proof?.machineType?.kind === 'bitvector'
  && definition.proof.machineType.widthBits === 64;
function abiBoundary(node, input) {
  const isReturn = node?.kind === 'return', fact = isReturn ? node.attributes?.abiReturnBinding : node?.attributes?.abiCallBinding;
  const location = isReturn ? fact?.location : fact?.returnLocation, identity = fact?.abiIdentity;
  if (!fact || fact.kind !== (isReturn ? 'abi-return-location' : 'abi-call-values') || fact.version !== 1
    || fact.functionId !== input.functionId || (isReturn ? fact.returnNodeId : fact.callNodeId) !== node.id
    || !identity || identity.id !== input.abiId || identity.semanticVersion !== input.abiRevision
    || identity.snapshotId !== input.snapshotId || identity.binaryId !== input.binaryId
    || identity.functionId != null && identity.functionId !== input.functionId
    || location?.kind !== 'register' || location.bits !== 64 || location.aggregate === true || typeof location.reg !== 'string') return null;
  const semanticValueId = isReturn ? fact.valueId : fact.returnValueId;
  if (typeof semanticValueId !== 'string' || !(isReturn ? node.inputs : node.call?.returns)?.includes(semanticValueId)
    || !isReturn && !node.outputs?.includes(semanticValueId)) return null;
  return { location, semanticValueId };
}
function reservePort(work, counter) {
  if (++counter.count > SCOPED_ABI_INPUT_LIMITS.ports) throw new AnalysisWorkStopped('budget-exhausted', 'scoped-flow-boundary-port-limit');
  work.charge('results'); work.charge('residentBytes', 768);
}

async function projectBoundaryPorts(pipeline, input, nodes, definitions, physicalDefinitions, work) {
  const returns = [], callReturns = new Map(), remaining = [], count = { count: 0 };
  const uses = new Map(), values = new Map();
  if (!Array.isArray(pipeline.ssa.uses) || pipeline.ssa.uses.length > SCOPED_ABI_INPUT_LIMITS.values
    || !Array.isArray(pipeline.semanticIr.values) || pipeline.semanticIr.values.length > SCOPED_ABI_INPUT_LIMITS.values) {
    throw new AnalysisWorkStopped('budget-exhausted', 'scoped-flow-boundary-structural-limit');
  }
  for (const value of pipeline.semanticIr.values) {
    work.charge('workUnits'); work.charge('residentBytes', 64); values.set(value.id, value); await work.yieldIfNeeded();
  }
  for (const use of pipeline.ssa.uses) {
    work.charge('workUnits'); work.charge('residentBytes', 64);
    const key = JSON.stringify([use.sourceEntityId, use.proof?.sourceSemanticValueId]);
    if (physical(use)?.kind === 'register') uses.set(key, uses.has(key) ? null : use);
    await work.yieldIfNeeded();
  }
  for (const node of nodes.values()) {
    work.charge('workUnits');
    if (node.kind !== 'return' && !node.call) continue;
    const boundary = abiBoundary(node, input);
    if (!boundary) { remaining.push(node.call ? 'call-return-binding-open' : 'function-return-binding-open'); continue; }
    const { location, semanticValueId } = boundary;
    let definition, sourceEntityId, useId = null;
    if (node.kind === 'return') {
      const source = nodes.get(values.get(semanticValueId)?.definitionNodeId);
      const use = uses.get(JSON.stringify([source?.id, semanticValueId]));
      if (source?.kind !== 'state-read' || source.variable?.physicalIdentity?.registerId !== location.reg
        || !source.outputs?.includes(semanticValueId) || !use) { remaining.push('function-return-physical-value-open'); continue; }
      definition = definitions.get(use.valueId); sourceEntityId = source.id; useId = use.useId;
    } else {
      definition = physicalDefinitions.get(JSON.stringify([location.reg, semanticValueId]));
      sourceEntityId = definition?.sourceEntityId;
      const source = nodes.get(sourceEntityId);
      if (source?.kind !== 'state-write' || !source.inputs?.includes(semanticValueId)) {
        remaining.push('call-return-physical-value-open'); continue;
      }
    }
    if (!physicalScalar(definition, location.reg)) { remaining.push('return-physical-definition-open'); continue; }
    reservePort(work, count);
    const port = { ...(node.kind === 'return' ? { returnSiteId: node.id } : {}), register: location.reg, widthBits: 64,
      valueId: definition.valueId, definitionId: definition.definitionId, canonicalKind: definition.kind,
      descriptor: snapshotContractData(location), source: node.kind === 'return' ? 'canonical-abi-return-value' : 'canonical-abi-call-result',
      sourceEntityId, useId, exact: false };
    if (node.kind === 'return') returns.push(port); else callReturns.set(node.id, [port]);
    await work.yieldIfNeeded();
  }
  const memory = { entries: [], exits: [], calls: [], remaining: ['interprocedural-alias-byte-coverage-and-exception-values-open'], exact: false };
  const mssa = pipeline.memorySsa;
  if (!isCanonicalMemorySsaProducerArtifact(mssa) || mssa.functionId !== input.functionId || mssa.snapshotId !== input.snapshotId) {
    memory.remaining.push('canonical-memoryssa-owner-unbound'); return { returns, callReturns, memory, remaining };
  }
  for (const [key, limit] of [['definitions', 'memoryDefinitions'], ['uses', 'memoryUses'], ['regions', 'regions'], ['blockStates', 'blocks']]) {
    if (!Array.isArray(mssa[key]) || mssa[key].length > SCOPED_ABI_INPUT_LIMITS[limit]) {
      throw new AnalysisWorkStopped('budget-exhausted', 'scoped-flow-memory-structural-limit');
    }
  }
  const regions = new Map(), memoryDefinitions = new Map(), states = new Map(), calls = new Map();
  for (const region of mssa.regions) {
    work.charge('workUnits'); work.charge('residentBytes', 64); regions.set(region.id, region); await work.yieldIfNeeded();
  }
  for (const state of mssa.blockStates) {
    work.charge('workUnits'); work.charge('residentBytes', 64);
    if (!Array.isArray(state.exit) || state.exit.length > SCOPED_ABI_INPUT_LIMITS.regions) throw new AnalysisWorkStopped('budget-exhausted', 'scoped-flow-memory-exit-limit');
    states.set(state.blockId, state); await work.yieldIfNeeded();
  }
  const callFor = id => {
    if (!calls.has(id)) {
      if (calls.size >= SCOPED_ABI_INPUT_LIMITS.calls) throw new AnalysisWorkStopped('budget-exhausted', 'scoped-flow-memory-call-limit');
      calls.set(id, { callSiteId: id, inputs: [], outputs: [], exact: false });
    }
    return calls.get(id);
  };
  const definitionPort = (definition, source) => {
    const region = regions.get(definition.regionId);
    if (!region) contractFail('scoped-flow-memory-region-source');
    reservePort(work, count);
    return { definitionId: definition.id, regionId: definition.regionId, regionKind: region.kind,
      canonicalKind: definition.kind, aliasRelation: definition.aliasRelation, source, exact: false };
  };
  for (const definition of mssa.definitions) {
    work.charge('workUnits'); work.charge('residentBytes', 64); memoryDefinitions.set(definition.id, definition);
    if (definition.kind === 'entry') memory.entries.push(definitionPort(definition, 'canonical-memoryssa-entry'));
    else if (nodes.get(definition.sourceEntityId)?.call) {
      // Preserve every owner-issued call effect, including unknown clobbers;
      // its kind and alias relation are evidence, never a value-kill decision.
      if (!Array.isArray(definition.previousDefinitionIds) || definition.previousDefinitionIds.length > SCOPED_ABI_INPUT_LIMITS.memoryDefinitions) {
        throw new AnalysisWorkStopped('budget-exhausted', 'scoped-flow-memory-previous-limit');
      }
      work.charge('workUnits', definition.previousDefinitionIds.length);
      callFor(definition.sourceEntityId).outputs.push({ ...definitionPort(definition, 'canonical-memoryssa-call-clobber'),
        previousDefinitionIds: [...definition.previousDefinitionIds] });
    }
    await work.yieldIfNeeded();
  }
  for (const use of mssa.uses) {
    work.charge('workUnits');
    if (!nodes.get(use.sourceEntityId)?.call) continue;
    const definition = memoryDefinitions.get(use.reachingDefinitionId), region = regions.get(use.regionId);
    if (!definition || !region || definition.regionId !== use.regionId) contractFail('scoped-flow-memory-reaching-source');
    reservePort(work, count);
    callFor(use.sourceEntityId).inputs.push({ useId: use.id, definitionId: definition.id, regionId: use.regionId, regionKind: region.kind,
      canonicalKind: definition.kind, aliasRelation: use.aliasRelation, source: 'canonical-memoryssa-call-use', exact: false });
    await work.yieldIfNeeded();
  }
  for (const node of nodes.values()) {
    work.charge('workUnits');
    if (node.kind !== 'return') continue;
    const state = states.get(node.blockId);
    if (!state) { memory.remaining.push('return-memory-block-state-open'); continue; }
    for (const exit of state.exit) {
      work.charge('workUnits');
      const definition = memoryDefinitions.get(exit.definitionId);
      if (!definition || definition.regionId !== exit.regionId) contractFail('scoped-flow-memory-exit-source');
      memory.exits.push({ ...definitionPort(definition, 'canonical-memoryssa-block-exit'), blockId: node.blockId, returnSiteId: node.id });
      await work.yieldIfNeeded();
    }
  }
  memory.calls = [...calls.values()]; memory.remaining = [...new Set(memory.remaining)].sort();
  return { returns, callReturns, memory, remaining };
}

/** Only the platform worker's in-process capture callback supplies owner. */
export async function projectScopedFlowInputs(owner, semanticResult, request, { signal = null, limits = {}, work: sharedWork = null } = {}) {
  const input = snapshotContractData(request, { maxBytes: 2 * 1024 * 1024, maxNodes: 32768 });
  recordFields(input, ['kind', 'world', 'assumptions', 'worldId', 'snapshotId'], 'scoped-flow-owner-fields');
  if (input.kind !== 'flow-inputs') contractFail('scoped-flow-owner-kind');
  const world = createWorldScope(input.world), assumptions = createAssumptionSet(input.assumptions, world);
  exactString(input.snapshotId, 'scoped-flow-owner-snapshot');
  if (input.worldId !== world.id) contractFail('scoped-flow-owner-world');
  const work = sharedWork ? assertScopedAnalysisWork(sharedWork) : new ScopedAnalysisWork({ limits, signal, name: 'scoped-abi-input-worker' });
  try {
    work.checkpoint();
    let issued = false;
    try { assertScopedCanonicalOwner(owner); issued = true; } catch { /* Unissued contexts remain unsupported. */ }
    const pipeline = owner?.pipeline, transported = semanticResult?.pipeline;
    const base = { schema: 'scoped-local-owner-projection/v1', version: SCOPED_FLOW_PROJECTION_VERSION,
      kind: 'flow-inputs', worldId: world.id, assumptionsId: assumptions.id, snapshotId: input.snapshotId,
      binaryId: pipeline?.binaryId ?? null, functionId: pipeline?.functionId ?? null, exact: false };
    const finish = (result) => { work.checkpoint(); return deepFreeze({ ...base, ...result, workerCost: work.cost() }); };
    if (!issued || !pipeline || !pipeline.legacyV1 || pipeline.instrumentation?.v2Executed !== true
      || owner.snapshotId !== input.snapshotId || pipeline.semanticIr !== transported?.semanticIr || pipeline.ssa !== transported?.ssa
      || pipeline.memorySsa !== transported?.memorySsa
      || !worldContains(world, pipeline.binaryId, pipeline.sliceId) || semanticResult.architectureId !== 'arm64'
      || semanticResult.abiId !== world.profile.abi || semanticResult.abiSemanticVersion !== world.profile.abiRevision) {
      return finish({ status: 'unsupported', reason: 'scoped-flow-canonical-owner-unbound' });
    }
    const abi = resolveABIPlugin({ architecture: 'arm64', abiId: world.profile.abi, platform: world.profile.osModel });
    if (!abi?.supported || abi.semanticVersion !== world.profile.abiRevision) return finish({ status: 'unsupported', reason: 'scoped-flow-abi-unbound' });
    const legacy = pipeline.legacyV1;
    if (!Array.isArray(pipeline.semanticIr?.nodes) || pipeline.semanticIr.nodes.length > SCOPED_ABI_INPUT_LIMITS.values
      || !Array.isArray(legacy.values) || legacy.values.length > SCOPED_ABI_INPUT_LIMITS.values
      || !Array.isArray(legacy.instructions) || legacy.instructions.length > SCOPED_ABI_INPUT_LIMITS.instructions
      || !Array.isArray(pipeline.ssa?.definitions) || pipeline.ssa.definitions.length > SCOPED_ABI_INPUT_LIMITS.values) {
      return finish({ status: 'unsupported', reason: 'scoped-flow-structural-budget' });
    }
    const definitions = new Map(), physicalDefinitions = new Map(), nodes = new Map(), parameters = [], calls = [], remaining = [...OPEN];
    for (const definition of pipeline.ssa.definitions) {
      work.charge('workUnits'); work.charge('residentBytes', 128);
      if (definitions.has(definition.valueId)) contractFail('scoped-flow-duplicate-definition');
      definitions.set(definition.valueId, definition);
      const reg = physical(definition)?.registerId, semanticValue = definition.proof?.sourceSemanticValueId;
      if (reg && semanticValue && scalarDefinition(definition, reg)) {
        const key = JSON.stringify([reg, semanticValue]);
        physicalDefinitions.set(key, physicalDefinitions.has(key) ? null : definition);
      }
      await work.yieldIfNeeded();
    }
    for (const node of pipeline.semanticIr.nodes) {
      work.charge('workUnits'); work.charge('residentBytes', 128); nodes.set(node.id, node);
      await work.yieldIfNeeded();
    }
    // Only actual consumed ARG views from canonical compatibility projection.
    // Do not synthesize x0..x7 or derive an ABI from a register's spelling.
    const seen = new Set();
    for (const value of legacy.values) {
      work.charge('workUnits');
      if (value.kind !== 'arg' || !value.uses?.length) continue;
      const port = valuePort(value, definitions, physicalDefinitions);
      if (!port || !isInputDefinition(definitions.get(port.valueId))) continue;
      const classification = abi.classifyEntryRegister(port.register);
      if (classification?.kind !== 'argument' || classification.reg !== port.register) continue;
      const key = JSON.stringify([port.register, port.valueId]);
      if (seen.has(key)) continue;
      if (parameters.length >= SCOPED_ABI_INPUT_LIMITS.parameters) { remaining.push('parameter-port-limit'); break; }
      work.charge('results'); work.charge('residentBytes', 512); seen.add(key);
      parameters.push({ ...port, source: 'canonical-consumed-arg-view', classification: snapshotContractData(classification), exact: false });
      await work.yieldIfNeeded();
    }
    for (const instruction of legacy.instructions) {
      work.charge('workUnits');
      if (instruction.op !== 'call') continue;
      const callSiteId = instruction.semanticNodeId ?? instruction.extra?.semanticNodeId, node = nodes.get(callSiteId);
      if (!node?.call || instruction.extra?.abiAdapterStatus !== 'used' || instruction.extra.abiId !== world.profile.abi
        || instruction.extra.abiSemanticVersion !== world.profile.abiRevision) { remaining.push('call-abi-owner-unbound'); continue; }
      if (calls.length >= SCOPED_ABI_INPUT_LIMITS.calls) { remaining.push('call-port-limit'); break; }
      const descriptors = instruction.callArguments, actuals = instruction.args;
      if (!Array.isArray(descriptors) || descriptors.length > SCOPED_ABI_INPUT_LIMITS.argumentsPerCall
        || !Array.isArray(actuals) || actuals.length > SCOPED_ABI_INPUT_LIMITS.argumentsPerCall) {
        remaining.push('call-argument-port-limit'); continue;
      }
      const arguments_ = [], callSeen = new Set();
      for (const argument of actuals) {
        work.charge('workUnits');
        const port = valuePort(argument.value, definitions, physicalDefinitions);
        if (!port || callSeen.has(port.valueId) || abi.classifyEntryRegister(port.register)?.kind !== 'argument') continue;
        const descriptor = descriptors.find((entry) => entry.location === 'register' && entry.reg === port.register
          && !entry.pieces && !entry.regs && (entry.bits == null || entry.bits === 64));
        if (!descriptor) continue;
        work.charge('results'); work.charge('residentBytes', 512); callSeen.add(port.valueId);
        arguments_.push({ ...port, source: 'existing-compat-dominance-bound-abi-input',
          descriptor: snapshotContractData(descriptor), exact: false });
      }
      calls.push({ callSiteId, arguments: arguments_, exact: false });
      await work.yieldIfNeeded();
    }
    const boundaries = await projectBoundaryPorts(pipeline, { functionId: pipeline.functionId, binaryId: pipeline.binaryId,
      snapshotId: input.snapshotId, abiId: abi.id, abiRevision: abi.semanticVersion }, nodes, definitions, physicalDefinitions, work);
    remaining.push(...boundaries.remaining);
    return finish({ status: 'completed', inputs: { schema: SCOPED_ABI_INPUT_SCHEMA, version: SCOPED_FLOW_PROJECTION_VERSION,
      worldId: world.id, assumptionsId: assumptions.id, snapshotId: input.snapshotId, binaryId: pipeline.binaryId,
      functionId: pipeline.functionId, abiId: abi.id, abiRevision: abi.semanticVersion, parameters,
      calls: calls.map(call => ({ ...call, returns: boundaries.callReturns.get(call.callSiteId) ?? [] })),
      returns: boundaries.returns, memory: boundaries.memory,
      remaining: [...new Set(remaining)].sort(), exact: false,
      authority: 'existing-ABI-SSA-and-MSSA-boundary-candidates; not-semantic-proof' } });
  } catch (error) {
    // Timer-triggered stops may not yet carry counters. Capture before dispose
    // so the existing worker protocol can preserve the typed stop and debit.
    if (error instanceof AnalysisWorkStopped && !error.cost) error.cost = work.cost();
    throw error;
  } finally { if (!sharedWork) work.dispose(); }
}

/** Validate every endpoint against the SAME immutable query owner capture.
 * Input is private host/worker data, never a semanticQuery request field.
 */
export function bindScopedFlowInputs(raw, projection, { world, assumptions, snapshotId } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world); assertCanonicalQueryProjection(projection, { world, assumptions });
  const input = snapshotContractData(raw, { maxBytes: 2 * 1024 * 1024, maxNodes: 32768 });
  recordFields(input, ['schema', 'version', 'worldId', 'assumptionsId', 'snapshotId', 'binaryId', 'functionId',
    'abiId', 'abiRevision', 'parameters', 'calls', 'returns', 'memory', 'remaining', 'exact', 'authority'], 'scoped-flow-binding-fields');
  if (input.schema !== SCOPED_ABI_INPUT_SCHEMA || input.version !== SCOPED_FLOW_PROJECTION_VERSION
    || input.worldId !== world.id || input.assumptionsId !== assumptions.id || input.snapshotId !== snapshotId
    || input.binaryId !== projection.inputIdentity.binaryId || input.functionId !== projection.functionId
    || input.abiId !== world.profile.abi || input.abiRevision !== world.profile.abiRevision || input.exact !== false) contractFail('scoped-flow-binding-identity');
  if (!Array.isArray(input.parameters) || input.parameters.length > SCOPED_ABI_INPUT_LIMITS.parameters
    || !Array.isArray(input.calls) || input.calls.length > SCOPED_ABI_INPUT_LIMITS.calls
    || !Array.isArray(input.returns) || input.returns.length > SCOPED_ABI_INPUT_LIMITS.ports
    || !Array.isArray(input.remaining) || input.remaining.length > 64) contractFail('scoped-flow-binding-budget');
  const abi = resolveABIPlugin({ architecture: 'arm64', abiId: world.profile.abi, platform: world.profile.osModel });
  if (!abi?.supported || abi.semanticVersion !== input.abiRevision) contractFail('scoped-flow-binding-abi');
  const port = (row, incoming) => {
    recordFields(row, ['register', 'widthBits', 'valueId', 'definitionId', 'canonicalKind', 'compatibilityValueId', 'source', incoming ? 'classification' : 'descriptor', 'exact'], 'scoped-flow-port-fields');
    exactString(row.register, 'scoped-flow-port-register'); exactString(row.valueId, 'scoped-flow-port-value');
    if (row.widthBits !== 64 || row.exact !== false) contractFail('scoped-flow-port-width');
    const reference = projection.entityReference('ssa', row.definitionId), definition = reference ? projection.source(reference) : null;
    if (!definition || definition.valueId !== row.valueId || definition.kind !== row.canonicalKind
      || !scalarDefinition(definition, row.register) || incoming && !isInputDefinition(definition)) contractFail('scoped-flow-port-source');
    if (!projection.valueReferenceIds(row.valueId).includes(reference)) contractFail('scoped-flow-port-reference');
    exactString(row.compatibilityValueId, 'scoped-flow-compatible-value');
    const compatible = projection.valueReferenceIds(row.compatibilityValueId)
      .map(id => projection.source(id)).find(d => d?.valueId === row.compatibilityValueId);
    if (!compatible || compatible.valueId !== row.valueId && (!compatible.proof?.sourceSemanticValueId
      || compatible.proof.sourceSemanticValueId !== definition.proof?.sourceSemanticValueId)) contractFail('scoped-flow-compatible-source');
    if (abi.classifyEntryRegister(row.register)?.kind !== 'argument') contractFail('scoped-flow-nonargument-register');
    if (incoming && (row.classification?.kind !== 'argument' || row.classification.reg !== row.register)) contractFail('scoped-flow-parameter-classification');
    if (!incoming && (row.descriptor?.location !== 'register' || row.descriptor.reg !== row.register
      || row.descriptor.pieces || row.descriptor.regs || row.descriptor.bits != null && row.descriptor.bits !== row.widthBits)) contractFail('scoped-flow-call-descriptor');
    return { ...row, references: [reference] };
  };
  const ports = (rows, incoming) => {
    const seen = new Set();
    return rows.map(row => {
      const result = port(row, incoming), key = JSON.stringify([row.register, row.valueId]);
      if (seen.has(key)) contractFail('scoped-flow-duplicate-port');
      seen.add(key); return result;
    });
  };
  const parameters = ports(input.parameters, true);
  let boundaryCount = 0;
  const chargeBoundary = () => {
    if (++boundaryCount > SCOPED_ABI_INPUT_LIMITS.ports) contractFail('scoped-flow-binding-boundary-budget');
  };
  const bindReturn = (row, callSiteId = null) => {
    chargeBoundary();
    recordFields(row, ['register', 'widthBits', 'valueId', 'definitionId', 'canonicalKind', 'descriptor',
      'source', 'sourceEntityId', 'useId', 'exact', ...(callSiteId === null ? ['returnSiteId'] : [])], 'scoped-flow-return-fields');
    const site = callSiteId ?? row.returnSiteId;
    const siteReference = projection.entityReference('semantic-ir', site), node = siteReference && projection.source(siteReference);
    const boundary = abiBoundary(node, input);
    if (!boundary || (callSiteId === null ? node.kind !== 'return' : !node.call)
      || row.widthBits !== 64 || row.exact !== false || row.register !== boundary.location.reg
      || stableDigest(row.descriptor) !== stableDigest(boundary.location)) contractFail('scoped-flow-return-binding');
    const reference = projection.entityReference('ssa', row.definitionId), definition = reference && projection.source(reference);
    const sourceReference = projection.entityReference('semantic-ir', row.sourceEntityId), source = sourceReference && projection.source(sourceReference);
    if (!definition || definition.valueId !== row.valueId || definition.kind !== row.canonicalKind
      || !physicalScalar(definition, row.register) || !projection.valueReferenceIds(row.valueId).includes(reference)
      || !source || source.blockId !== node.blockId) contractFail('scoped-flow-return-definition');
    if (callSiteId === null) {
      const useReference = projection.entityReference('ssa', row.useId), use = useReference && projection.source(useReference);
      if (row.source !== 'canonical-abi-return-value' || source.kind !== 'state-read'
        || source.variable?.physicalIdentity?.registerId !== row.register || !source.outputs?.includes(boundary.semanticValueId)
        || !use || use.valueId !== row.valueId || use.sourceEntityId !== source.id
        || use.proof?.sourceSemanticValueId !== boundary.semanticValueId || physical(use)?.registerId !== row.register) {
        contractFail('scoped-flow-return-consumed-source');
      }
    } else if (row.source !== 'canonical-abi-call-result' || row.useId !== null || source.kind !== 'state-write'
      || source.variable?.physicalIdentity?.registerId !== row.register || !source.inputs?.includes(boundary.semanticValueId)
      || definition.sourceEntityId !== source.id || definition.proof?.sourceSemanticValueId !== boundary.semanticValueId) {
      contractFail('scoped-flow-call-return-source');
    }
    return { ...row, references: [reference], siteReference, sourceReference };
  };
  const returnIds = new Set();
  const returns = input.returns.map(row => {
    const bound = bindReturn(row), key = JSON.stringify([row.returnSiteId, row.register, row.valueId]);
    if (returnIds.has(key)) contractFail('scoped-flow-duplicate-return');
    returnIds.add(key); return bound;
  });
  const callIds = new Set();
  const calls = input.calls.map((call) => {
    recordFields(call, ['callSiteId', 'arguments', 'returns', 'exact'], 'scoped-flow-call-fields');
    const reference = projection.entityReference('semantic-ir', call.callSiteId);
    if (!reference || !projection.source(reference)?.call || callIds.has(call.callSiteId) || call.exact !== false) contractFail('scoped-flow-call-source');
    callIds.add(call.callSiteId);
    if (!Array.isArray(call.arguments) || call.arguments.length > SCOPED_ABI_INPUT_LIMITS.argumentsPerCall
      || !Array.isArray(call.returns) || call.returns.length > SCOPED_ABI_INPUT_LIMITS.argumentsPerCall) contractFail('scoped-flow-call-budget');
    const seenReturns = new Set();
    const returned = call.returns.map(row => {
      const bound = bindReturn(row, call.callSiteId), key = JSON.stringify([row.register, row.valueId]);
      if (seenReturns.has(key)) contractFail('scoped-flow-duplicate-call-return');
      seenReturns.add(key); return bound;
    });
    return { ...call, reference, arguments: ports(call.arguments, false), returns: returned };
  });
  const rawMemory = input.memory;
  recordFields(rawMemory, ['entries', 'exits', 'calls', 'remaining', 'exact'], 'scoped-flow-memory-fields');
  if (rawMemory.exact !== false || !Array.isArray(rawMemory.remaining) || rawMemory.remaining.length > 64
    || !Array.isArray(rawMemory.calls) || rawMemory.calls.length > SCOPED_ABI_INPUT_LIMITS.calls
    || !Array.isArray(rawMemory.entries) || rawMemory.entries.length > SCOPED_ABI_INPUT_LIMITS.ports
    || !Array.isArray(rawMemory.exits) || rawMemory.exits.length > SCOPED_ABI_INPUT_LIMITS.ports) contractFail('scoped-flow-memory-budget');
  const memoryPort = (row, role, callSiteId = null) => {
    chargeBoundary();
    recordFields(row, ['definitionId', 'regionId', 'regionKind', 'canonicalKind', 'aliasRelation', 'source', 'exact',
      ...(role === 'input' ? ['useId'] : role === 'output' ? ['previousDefinitionIds'] : role === 'exit' ? ['blockId', 'returnSiteId'] : [])],
    'scoped-flow-memory-port-fields');
    const reference = projection.entityReference('memoryssa', row.definitionId), definition = reference && projection.source(reference);
    const region = projection.canonicalMemoryRegion(row.regionId);
    if (row.exact !== false || !definition || definition.regionId !== row.regionId || definition.kind !== row.canonicalKind
      || !region || region.kind !== row.regionKind) contractFail('scoped-flow-memory-definition');
    if (role !== 'input' && row.aliasRelation !== definition.aliasRelation) contractFail('scoped-flow-memory-alias-source');
    if (role === 'entry') {
      if (row.source !== 'canonical-memoryssa-entry' || definition.kind !== 'entry') contractFail('scoped-flow-memory-entry-source');
    } else if (role === 'exit') {
      const returnReference = projection.entityReference('semantic-ir', row.returnSiteId), returned = returnReference && projection.source(returnReference);
      const block = projection.canonicalBlock(row.blockId), state = projection.canonicalMemoryBlockState(row.blockId);
      if (row.source !== 'canonical-memoryssa-block-exit' || returned?.kind !== 'return' || returned.blockId !== row.blockId
        || block?.nodeIds?.at(-1) !== row.returnSiteId
        || !state?.exit?.some(exit => exit.definitionId === row.definitionId && exit.regionId === row.regionId)) {
        contractFail('scoped-flow-memory-exit-source');
      }
    } else if (role === 'output') {
      if (row.source !== 'canonical-memoryssa-call-clobber' || definition.sourceEntityId !== callSiteId
        || !Array.isArray(row.previousDefinitionIds) || row.previousDefinitionIds.length !== definition.previousDefinitionIds?.length
        || row.previousDefinitionIds.some((id, index) => id !== definition.previousDefinitionIds[index])) {
        contractFail('scoped-flow-memory-call-output-source');
      }
    } else {
      const useReference = projection.entityReference('memoryssa', row.useId), use = useReference && projection.source(useReference);
      if (row.source !== 'canonical-memoryssa-call-use' || !use || use.sourceEntityId !== callSiteId
        || use.regionId !== row.regionId || use.reachingDefinitionId !== row.definitionId || use.aliasRelation !== row.aliasRelation) {
        contractFail('scoped-flow-memory-call-input-source');
      }
      return { ...row, references: [useReference], reachingReferences: [reference] };
    }
    return { ...row, references: [reference] };
  };
  const memoryPorts = (rows, role, callSiteId = null) => {
    if (!Array.isArray(rows) || rows.length > SCOPED_ABI_INPUT_LIMITS.ports) contractFail('scoped-flow-memory-port-budget');
    const seen = new Set();
    return rows.map(row => {
      const result = memoryPort(row, role, callSiteId), key = JSON.stringify([row.definitionId, row.useId ?? null, row.returnSiteId ?? null]);
      if (seen.has(key)) contractFail('scoped-flow-memory-duplicate-port');
      seen.add(key); return result;
    });
  };
  const memoryCallIds = new Set();
  const memory = { ...rawMemory, entries: memoryPorts(rawMemory.entries, 'entry'), exits: memoryPorts(rawMemory.exits, 'exit'),
    calls: rawMemory.calls.map(call => {
      recordFields(call, ['callSiteId', 'inputs', 'outputs', 'exact'], 'scoped-flow-memory-call-fields');
      const reference = projection.entityReference('semantic-ir', call.callSiteId), node = reference && projection.source(reference);
      if (!node?.call || call.exact !== false || memoryCallIds.has(call.callSiteId)) contractFail('scoped-flow-memory-call-source');
      memoryCallIds.add(call.callSiteId);
      return { ...call, reference, inputs: memoryPorts(call.inputs, 'input', call.callSiteId), outputs: memoryPorts(call.outputs, 'output', call.callSiteId) };
    }) };
  rawMemory.remaining.forEach(reason => exactString(reason, 'scoped-flow-memory-remaining'));
  input.remaining.forEach((reason) => exactString(reason, 'scoped-flow-remaining'));
  const body = { ...input, parameters, calls, returns, memory, inputIdentity: projection.inputIdentity };
  // A digest is a content binding, not an independent proof or authority token.
  return deepFreeze({ ...body, digest: stableDigest({ body, typed: lossyTypeWitness(body) }) });
}
