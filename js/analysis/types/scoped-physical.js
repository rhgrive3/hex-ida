/**
 * Demand-only physical type evidence from the existing canonical IR/SSA.
 *
 * The TypeConstraintGraph remains the sole type solver. A hard constraint in
 * this local graph states what a canonical owner declared; it is NOT an ISA
 * qualification, a recovered language type, or a closed-world exact fact.
 * Memory access width belongs to the access, never to the pointed-to object.
 */
import { TypeConstraintGraph, TYPE_GRAPH_ANALYZER_VERSION } from './graph.js';
import { createEntityId, deepFreeze, stableDigest, lossyTypeWitness } from '../../core/identity/index.js';
import { snapshotContractData, stringSet, exactString, exactInteger, contractFail } from '../../core/identity/structured.js';
import { SEMANTIC_IR_CONTRACT_VERSION } from '../../semantics/ir/index.js';
import { SEMANTIC_SSA_CONTRACT_VERSION } from '../../semantics/ssa/contract.js';

export const SCOPED_PHYSICAL_TYPES_VERSION = '1.0.0';
export const SCOPED_PHYSICAL_TYPES_SCHEMA = 'scoped-physical-type-evidence/v1';
const MAX_ENTITIES = 64;
const LIMITS = Object.freeze({ maxConstraintsPerLayer: 128, maxComparisonsPerLayer: 4096,
  maxContradictionsPerLayer: 64, maxNodes: 256, maxEdges: 2048, maxComponents: 256,
  maxIterationsPerComponent: 8 });

function stop(signal) {
  if (!signal?.aborted) return;
  throw signal.reason;
}
function machineDescriptor(type, vectorElement = false) {
  if (!type || typeof type.kind !== 'string') return null;
  // MachineType has already been normalized by the canonical IR owner. Bound
  // its detached projection again, and retain vector/predicate distinctions.
  if (type.kind === 'vector') {
    if (vectorElement || type.elementType?.kind === 'vector' || type.elementType?.kind === 'address') return null;
    const laneCount = exactInteger(type.laneCount, 'physical-type-lanes', { min: 1, max: 65536 });
    const element = machineDescriptor(type.elementType, true);
    if (!element || element.kind === 'vector') return null;
    const widthBits = laneCount * element.widthBits;
    exactInteger(widthBits, 'physical-type-vector-width', { min: 1, max: 1048576 });
    return { kind: 'vector', widthBits, laneCount, elementType: element };
  }
  if (!['bitvector', 'float', 'predicate', 'address'].includes(type.kind)) return null;
  const widthBits = exactInteger(type.widthBits, 'physical-type-width', { min: 1, max: 1048576 });
  const descriptor = { kind: exactString(type.kind, 'physical-type-kind'), widthBits };
  if (type.format != null) descriptor.format = exactString(type.format, 'physical-type-format');
  if (type.addressSpace != null) descriptor.addressSpace = exactString(type.addressSpace, 'physical-type-address-space');
  if (type.laneCount != null) descriptor.laneCount = exactInteger(type.laneCount, 'physical-type-predicate-lanes', { min: 1, max: 65536 });
  return descriptor;
}

/** Synchronous by design: runs inside the existing platform analysis worker. */
export function projectCanonicalPhysicalTypes(pipeline, entityIds, { snapshotId, worldId, signal = null } = {}) {
  const requested = stringSet(entityIds, 'physical-type-entity-ids', MAX_ENTITIES);
  if (!requested.length) contractFail('physical-type-empty-query');
  exactString(snapshotId, 'physical-type-snapshot'); exactString(worldId, 'physical-type-world');
  const ir = pipeline?.semanticIr, ssa = pipeline?.ssa;
  if (pipeline?.instrumentation?.v2Executed !== true || ir?.contractVersion !== SEMANTIC_IR_CONTRACT_VERSION
    || pipeline.functionId !== ir.functionId || !Array.isArray(ir.values) || !Array.isArray(ir.nodes)) {
    return deepFreeze({ schema: SCOPED_PHYSICAL_TYPES_SCHEMA, version: SCOPED_PHYSICAL_TYPES_VERSION,
      status: 'unsupported', reason: 'canonical-type-input-unavailable', exact: false });
  }
  // Enforced before indexing: no whole-binary or unbounded recursive type walk.
  if (ir.values.length > 2048 || ir.nodes.length > 1024 || (ssa?.definitions?.length ?? 0) > 4096
    || (ssa?.uses?.length ?? 0) > 8192) contractFail('physical-type-structural-budget');
  stop(signal);
  exactString(pipeline.binaryId, 'physical-type-binary');
  const values = new Map(), nodes = new Map();
  for (const value of ir.values) {
    stop(signal); exactString(value.id, 'physical-type-value-id');
    if (values.has(value.id)) contractFail('physical-type-ir-value-duplicate');
    values.set(value.id, value);
  }
  for (const node of ir.nodes) {
    stop(signal); exactString(node.id, 'physical-type-node-id');
    if (nodes.has(node.id) || !Array.isArray(node.outputs) || node.outputs.length > 256) contractFail('physical-type-ir-node-shape');
    nodes.set(node.id, node);
  }
  const hasSsa = ssa?.contractVersion === SEMANTIC_SSA_CONTRACT_VERSION && ssa.functionId === ir.functionId;
  const definitions = new Map(), uses = new Map(), valueDefinitions = new Map();
  if (hasSsa) {
    if (!Array.isArray(ssa.definitions) || !Array.isArray(ssa.uses)) contractFail('physical-type-ssa-shape');
    for (const d of ssa.definitions) {
      stop(signal); exactString(d.definitionId, 'physical-type-ssa-definition-id'); exactString(d.valueId, 'physical-type-ssa-value-id');
      if (definitions.has(d.definitionId) || valueDefinitions.has(d.valueId)) contractFail('physical-type-ssa-duplicate');
      definitions.set(d.definitionId, d); valueDefinitions.set(d.valueId, d);
    }
    for (const u of ssa.uses) {
      stop(signal); exactString(u.useId, 'physical-type-ssa-use-id');
      if (uses.has(u.useId)) contractFail('physical-type-ssa-use-duplicate');
      uses.set(u.useId, u);
    }
  }
  const graph = new TypeConstraintGraph({ snapshotId, limits: LIMITS });
  const evidence = [], relations = [], missing = [];
  const add = (entityId, descriptor, sourceEntityId, interpretation, origin) => {
    stop(signal);
    if (evidence.length >= 1024) contractFail('physical-type-evidence-budget');
    const identity = { worldId, snapshotId, functionId: ir.functionId, entityId,
      sourceEntityId, descriptor, interpretation, version: SCOPED_PHYSICAL_TYPES_VERSION };
    const id = createEntityId({ binaryId: pipeline.binaryId, kind: 'physical-type-owner-reference', identity });
    graph.addHardConstraint({ kind: 'access-width', origin: 'binary-evidence',
      claim: { entityId, layer: 'machine', descriptor }, evidenceIds: [id, sourceEntityId],
      providerVersion: ir.contractVersion, buildIdentity: snapshotId });
    evidence.push({ id, ...identity, origin: origin ?? null, authority: 'canonical-machine-type-declaration',
      independentQualification: 'not-checked', exact: false });
  };
  const mapValue = (entityId, value, sourceEntityId = value?.id) => {
    if (!value) return false;
    const descriptor = machineDescriptor(value.machineType);
    if (!descriptor) return false;
    add(entityId, descriptor, sourceEntityId, 'value-representation-not-language-type', value.origin);
    return true;
  };
  for (const entityId of requested) {
    stop(signal);
    if (values.has(entityId)) {
      if (!mapValue(entityId, values.get(entityId))) missing.push({ entityId, reason: 'canonical-value-type-unavailable' });
      continue;
    }
    const node = nodes.get(entityId);
    if (node) {
      if (node.memory) {
        const access = node.memory;
        add(entityId, { kind: 'memory-access', widthBits: exactInteger(access.widthBits, 'physical-memory-width', { min: 1, max: 1048576 }),
          addressSpace: exactString(access.addressSpace, 'physical-memory-address-space') }, entityId,
        'access-width-not-pointee-size', node.origin);
      }
      // Multi-result instructions do not get a fabricated common result type.
      // Refer to the output values separately and preserve their positions.
      for (let i = 0; i < node.outputs.length; i++) {
        const outputId = node.outputs[i], value = values.get(outputId);
        if (relations.length >= 4096) contractFail('physical-type-relation-budget');
        relations.push({ from: entityId, to: outputId, kind: 'canonical-output', index: i });
        if (!mapValue(outputId, value)) missing.push({ entityId: outputId, reason: 'canonical-output-type-unavailable' });
      }
      if (!node.memory && node.outputs.length === 0) missing.push({ entityId, reason: 'operation-has-no-value-type' });
      continue;
    }
    const use = uses.get(entityId);
    const definition = definitions.get(entityId) ?? valueDefinitions.get(entityId)
      ?? (use ? valueDefinitions.get(use.valueId) : null);
    if (definition) {
      const type = definition.proof?.machineType;
      const descriptor = type ? machineDescriptor(type) : null;
      if (descriptor) add(entityId, descriptor, definition.definitionId,
        use ? 'reaching-ssa-value-representation' : 'ssa-value-representation', definition.origin);
      else {
        const valueId = definition.proof?.sourceSemanticValueId;
        if (!mapValue(entityId, values.get(valueId), definition.definitionId)) missing.push({ entityId, reason: 'ssa-machine-type-unavailable' });
      }
      relations.push({ from: entityId, to: definition.definitionId, kind: 'canonical-ssa-type-source' });
      continue;
    }
    missing.push({ entityId, reason: 'entity-not-in-bound-canonical-function' });
  }
  const solvedIds = stringSet([...requested, ...relations.filter((r) => r.kind === 'canonical-output').map((r) => r.to)],
    'physical-type-solved-ids', 256);
  const results = [];
  for (const id of solvedIds) {
    stop(signal);
    const owner = graph.solveEntity(id, { signal });
    results.push({ entityId: id, owner, interpretation: 'owner-declarations-only', staticExact: false,
      obligations: ['instruction-semantics-qualification', 'scope-closure', 'language-type-unrecovered'] });
  }
  stop(signal);
  const body = snapshotContractData({ schema: SCOPED_PHYSICAL_TYPES_SCHEMA, version: SCOPED_PHYSICAL_TYPES_VERSION,
    binaryId: pipeline.binaryId, functionId: ir.functionId, worldId, snapshotId, requested,
    producerVersions: { semanticIr: ir.contractVersion, ssa: hasSsa ? ssa.contractVersion : null, typeGraph: TYPE_GRAPH_ANALYZER_VERSION },
    status: 'completed', evidence, relations, results, missing, exact: false,
    completeness: missing.length ? 'partial' : 'requested-declarations-only',
    unsupported: ['nominal-identity', 'layout-recovery', 'call-prototype-authority', 'independent-isa-type-qualification'] },
  { allowBigInt: true, maxBytes: 2 * 1024 * 1024, maxNodes: 65536 });
  return deepFreeze({ ...body, ownerDigest: stableDigest({ body, typed: lossyTypeWitness(body) }) });
}
