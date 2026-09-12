/** Read-only physical input navigation from the existing ABI/compat/SSA owners.
 * This is deliberately NOT function-argument inference: an unknown incoming
 * register stays unknown and a possible ABI input stays possible. No return,
 * stack, aggregate, subregister or memory port is invented by this adapter.
 */
import { resolveABIPlugin } from '../targets/abi/index.js';
import { createWorldScope, createAssumptionSet, assertWorldScope, assertAssumptionSet, worldContains } from '../core/identity/world.js';
import { deepFreeze, lossyTypeWitness, stableDigest } from '../core/identity/index.js';
import { snapshotContractData, recordFields, exactString, contractFail } from '../core/identity/structured.js';
import { AnalysisWorkStopped, ScopedAnalysisWork, assertScopedAnalysisWork } from '../core/budgets/scoped-work.js';
import { assertCanonicalQueryProjection } from './query/semantic/projection.js';

export const SCOPED_FLOW_PROJECTION_VERSION = '1.0.0';
export const SCOPED_ABI_INPUT_SCHEMA = 'scoped-physical-register-inputs/v1';
export const SCOPED_ABI_INPUT_LIMITS = Object.freeze({ values: 16384, instructions: 8192, parameters: 64, calls: 512, argumentsPerCall: 64 });
const OPEN = Object.freeze(['abi-prototype-and-arity-unqualified', 'incoming-register-state-is-not-an-exact-parameter',
  'stack-aggregate-subregister-and-vector-inputs-open', 'return-hidden-result-memory-and-exception-ports-open']);
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
    const pipeline = owner?.pipeline, transported = semanticResult?.pipeline;
    const base = { schema: 'scoped-local-owner-projection/v1', version: SCOPED_FLOW_PROJECTION_VERSION,
      kind: 'flow-inputs', worldId: world.id, assumptionsId: assumptions.id, snapshotId: input.snapshotId,
      binaryId: pipeline?.binaryId ?? null, functionId: pipeline?.functionId ?? null, exact: false };
    const finish = (result) => { work.checkpoint(); return deepFreeze({ ...base, ...result, workerCost: work.cost() }); };
    if (!pipeline || !pipeline.legacyV1 || pipeline.instrumentation?.v2Executed !== true
      || owner.snapshotId !== input.snapshotId || pipeline.semanticIr !== transported?.semanticIr || pipeline.ssa !== transported?.ssa
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
    return finish({ status: 'completed', inputs: { schema: SCOPED_ABI_INPUT_SCHEMA, version: SCOPED_FLOW_PROJECTION_VERSION,
      worldId: world.id, assumptionsId: assumptions.id, snapshotId: input.snapshotId, binaryId: pipeline.binaryId,
      functionId: pipeline.functionId, abiId: abi.id, abiRevision: abi.semanticVersion, parameters, calls,
      remaining: [...new Set(remaining)].sort(), exact: false,
      authority: 'existing-ABI-and-compat-input-candidates; not-semantic-proof' } });
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
    'abiId', 'abiRevision', 'parameters', 'calls', 'remaining', 'exact', 'authority'], 'scoped-flow-binding-fields');
  if (input.schema !== SCOPED_ABI_INPUT_SCHEMA || input.version !== SCOPED_FLOW_PROJECTION_VERSION
    || input.worldId !== world.id || input.assumptionsId !== assumptions.id || input.snapshotId !== snapshotId
    || input.binaryId !== projection.inputIdentity.binaryId || input.functionId !== projection.functionId
    || input.abiId !== world.profile.abi || input.abiRevision !== world.profile.abiRevision || input.exact !== false) contractFail('scoped-flow-binding-identity');
  if (!Array.isArray(input.parameters) || input.parameters.length > SCOPED_ABI_INPUT_LIMITS.parameters
    || !Array.isArray(input.calls) || input.calls.length > SCOPED_ABI_INPUT_LIMITS.calls
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
  const callIds = new Set();
  const calls = input.calls.map((call) => {
    recordFields(call, ['callSiteId', 'arguments', 'exact'], 'scoped-flow-call-fields');
    const reference = projection.entityReference('semantic-ir', call.callSiteId);
    if (!reference || !projection.source(reference)?.call || callIds.has(call.callSiteId) || call.exact !== false) contractFail('scoped-flow-call-source');
    callIds.add(call.callSiteId);
    if (!Array.isArray(call.arguments) || call.arguments.length > SCOPED_ABI_INPUT_LIMITS.argumentsPerCall) contractFail('scoped-flow-call-budget');
    return { ...call, reference, arguments: ports(call.arguments, false) };
  });
  input.remaining.forEach((reason) => exactString(reason, 'scoped-flow-remaining'));
  const body = { ...input, parameters, calls, inputIdentity: projection.inputIdentity };
  // A digest is a content binding, not an independent proof or authority token.
  return deepFreeze({ ...body, digest: stableDigest({ body, typed: lossyTypeWitness(body) }) });
}
