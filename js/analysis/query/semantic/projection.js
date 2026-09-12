/** Disposable relational projection of existing Semantic IR / SSA / MemorySSA.
 * No operation is evaluated here. No AST, alias relation or new memory fact is
 * invented. A graph path is a possible dependence, not execution feasibility.
 */
import { createEntityId, deepFreeze, stableDigest, stableStringify, lossyTypeWitness } from '../../../core/identity/index.js';
import { assertWorldScope, assertAssumptionSet, worldContains } from '../../../core/identity/world.js';
import { snapshotContractData, recordFields, unsignedAddress, exactString, exactInteger, compareIdentity, stringSet, contractFail } from '../../../core/identity/structured.js';
import { assertScopedAnalysisWork } from '../../../core/budgets/scoped-work.js';
import { SEMANTIC_IR_SCHEMA_VERSION, SEMANTIC_IR_CONTRACT_VERSION } from '../../../semantics/ir/index.js';
import { SEMANTIC_SSA_CONTRACT_VERSION } from '../../../semantics/ssa/contract.js';
import { MEMORY_SSA_CONTRACT_VERSION } from '../../../semantics/memoryssa/contract.js';
import { MEMORY_SSA_BUILD_VERSION } from '../../../semantics/memoryssa/build.js';
import { classifyCallTargetProof } from '../../summary/contract.js';

export const SEMANTIC_PROJECTION_VERSION = '1.4.0';
const CONSTRUCTOR = Symbol('canonical-query-projection');
const PROJECTIONS = new WeakSet();
const boundArrays = (value, fields, work) => {
  let count = 0;
  for (const field of fields) {
    if (!Array.isArray(value?.[field])) contractFail(`query-projection-array:${field}`);
    count += value[field].length;
  }
  return count;
};

/** Detach an entire bounded function snapshot before the first await. The
 * owner cannot mutate a later collection between yields and produce a mixed
 * IR/SSA/MSSA identity. Work/deadline checks still bound this synchronous copy;
 * a worker supplies isolation for a maximum-sized native function.
 */
function captureCollections(collections, metadata, work) {
  const captured = {};
  for (const [name, records] of collections) {
    const owned = [];
    for (const record of records) {
      work.charge('workUnits');
      const copy = snapshotContractData(record, { allowBigInt: true, maxBytes: 262144, maxNodes: 8192, maxDepth: 32 });
      work.charge('residentBytes', stableStringify(copy).length * 2 + 64);
      owned.push(copy);
    }
    captured[name] = Object.freeze(owned);
  }
  return Object.freeze({ captured: Object.freeze(captured), metadata: snapshotContractData(metadata, { allowBigInt: true }) });
}
async function fingerprintCollections(owner, capture, work) {
  const fingerprints = [];
  for (const [name, records] of Object.entries(capture.captured)) {
    const rows = [];
    for (const record of records) {
      work.charge('workUnits');
      rows.push(stableDigest({ value: record, typed: lossyTypeWitness(record) }));
      await work.yieldIfNeeded();
    }
    fingerprints.push([name, rows]);
  }
  return stableDigest({ owner, version: SEMANTIC_PROJECTION_VERSION, metadata: capture.metadata, fingerprints });
}

export class CanonicalQueryProjection {
  #records; #order; #edges; #outgoing; #incoming; #origin; #sources; #closed = false;
  #world; #assumptions; #inputIdentity; #frontier; #id; #functionId;
  #edgeOrder; #valueReferences; #ownerReferences; #semanticValues; #blocks; #memoryRegions; #memoryBlockStates;
  constructor(token, state) {
    if (token !== CONSTRUCTOR) contractFail('query-projection-use-builder');
    this.#records = state.records; this.#order = state.order; this.#edges = state.edges;
    this.#outgoing = state.outgoing; this.#incoming = state.incoming; this.#origin = state.origins;
    this.#sources = state.sources; this.#world = state.world; this.#assumptions = state.assumptions;
    this.#inputIdentity = state.inputIdentity; this.#frontier = deepFreeze(state.frontier);
    this.#id = state.id; this.#functionId = state.functionId;
    this.#edgeOrder = [...state.edges.keys()].sort(compareIdentity);
    this.#semanticValues = state.semanticValues ?? new Map();
    this.#valueReferences = state.valueReferences ?? new Map();
    this.#ownerReferences = state.ownerReferences ?? new Map();
    this.#blocks = state.blocks ?? new Map();
    this.#memoryRegions = state.memoryRegions ?? new Map();
    this.#memoryBlockStates = state.memoryBlockStates ?? new Map();
    PROJECTIONS.add(this);
  }
  get id() { return this.#id; }
  get functionId() { return this.#functionId; }
  get worldId() { return this.#world.id; }
  get assumptionsId() { return this.#assumptions.id; }
  get size() { return this.#records.size; }
  get edgeCount() { return this.#edges.size; }
  get frontier() { return this.#frontier; }
  get inputIdentity() { return this.#inputIdentity; }
  #check() { if (this.#closed) contractFail('query-projection-released'); }
  record(id) { this.#check(); return this.#records.get(id) ?? null; }
  edge(id) { this.#check(); return this.#edges.get(id) ?? null; }
  recordAt(index) {
    this.#check(); exactInteger(index, 'query-projection-index');
    return this.#records.get(this.#order[index]) ?? null;
  }
  edgeAt(index) {
    this.#check(); exactInteger(index, 'query-projection-edge-index');
    return this.#edges.get(this.#edgeOrder[index]) ?? null;
  }
  /** Only references to original owner entities, never a guessed variable. */
  entityReference(owner, entityId) {
    this.#check(); return this.#ownerReferences.get(`${owner}\u0000${entityId}`) ?? null;
  }
  canonicalValue(valueId) { this.#check(); return this.#semanticValues.get(valueId) ?? null; }
  canonicalBlock(blockId) { this.#check(); return this.#blocks.get(blockId) ?? null; }
  canonicalMemoryRegion(regionId) { this.#check(); return this.#memoryRegions.get(regionId) ?? null; }
  canonicalMemoryBlockState(blockId) { this.#check(); return this.#memoryBlockStates.get(blockId) ?? null; }
  valueReferenceIds(valueId) {
    this.#check(); return this.#valueReferences.get(valueId) ?? EMPTY;
  }
  adjacent(id, direction = 'forward') {
    this.#check();
    if (!['forward', 'backward'].includes(direction)) contractFail('query-projection-direction');
    return (direction === 'forward' ? this.#outgoing : this.#incoming).get(id) ?? EMPTY;
  }
  source(id) { this.#check(); return this.#sources.get(id) ?? null; }
  origin(id) { this.#check(); return this.#origin.get(id) ?? null; }
  present(id, { includeOrigins = false } = {}) {
    this.#check(); const record = this.record(id);
    return record ? deepFreeze({ ...record, ...(includeOrigins ? { origin: this.#origin.get(id) ?? null } : {}) }) : null;
  }
  release() {
    this.#closed = true;
    this.#records.clear(); this.#edges.clear(); this.#outgoing.clear(); this.#incoming.clear();
    this.#origin.clear(); this.#sources.clear(); this.#order.length = 0;
    this.#edgeOrder.length = 0; this.#valueReferences.clear(); this.#ownerReferences.clear(); this.#semanticValues.clear();
    this.#blocks.clear(); this.#memoryRegions.clear(); this.#memoryBlockStates.clear();
  }
}
const EMPTY = Object.freeze([]);
export function assertCanonicalQueryProjection(projection, { world = null, assumptions = null } = {}) {
  if (!PROJECTIONS.has(projection) || (world && projection.worldId !== assertWorldScope(world).id)
    || (assumptions && projection.assumptionsId !== assertAssumptionSet(assumptions).id)) contractFail('query-projection-unbound');
  return projection;
}

/**
 * Input is a current, host-owned production pipeline, never a query argument.
 * The per-record content hashes bind its values, not just advertised versions.
 * Validation here establishes a projection binding, not instruction correctness.
 */
export async function buildCanonicalQueryProjection(pipeline, { world, assumptions, snapshotId, work, sourceStatus = 'partial', producerArtifactId = null, sourceLocation = null, functionLocator = null } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world); assertScopedAnalysisWork(work);
  exactString(snapshotId, 'query-projection-snapshot');
  if (producerArtifactId !== null) exactString(producerArtifactId, 'query-producer-artifact');
  if (functionLocator !== null) exactString(functionLocator, 'query-function-locator');
  let ir = pipeline?.semanticIr;
  if (!ir || ir.schemaVersion !== SEMANTIC_IR_SCHEMA_VERSION || ir.contractVersion !== SEMANTIC_IR_CONTRACT_VERSION) contractFail('query-projection-canonical-ir-required');
  const binaryId = exactString(pipeline.binaryId, 'query-projection-binary-id');
  const functionId = exactString(ir.functionId, 'query-projection-function-id');
  if (!worldContains(world, binaryId) || (pipeline.functionId !== undefined && pipeline.functionId !== functionId)) contractFail('query-projection-world-binding');
  if (pipeline.snapshotId !== undefined && pipeline.snapshotId !== snapshotId) contractFail('query-projection-stale-snapshot');
  const count = boundArrays(ir, ['nodes', 'values', 'blocks'], work);
  work.charge('nodes', count);
  let ssa = pipeline.ssa, mssa = pipeline.memorySsa;
  const hasSsa = ssa?.functionId === functionId && ssa.contractVersion === SEMANTIC_SSA_CONTRACT_VERSION;
  const hasMemory = mssa?.functionId === functionId && mssa.contractVersion === MEMORY_SSA_CONTRACT_VERSION
    && mssa.buildVersion === MEMORY_SSA_BUILD_VERSION && (mssa.snapshotId === undefined || mssa.snapshotId === snapshotId);
  if (hasSsa) work.charge('nodes', boundArrays(ssa, ['definitions', 'uses', 'useDefLinks'], work));
  if (hasMemory) work.charge('nodes', boundArrays(mssa, ['definitions', 'uses'], work));
  const irCapture = captureCollections([['nodes', ir.nodes], ['values', ir.values], ['blocks', ir.blocks]],
    { schemaVersion: ir.schemaVersion, contractVersion: ir.contractVersion, functionId,
      entryBlockId: ir.entryBlockId ?? null, completeness: ir.completeness ?? 'unknown', unknowns: ir.unknowns ?? [] }, work);
  const ssaCapture = hasSsa ? captureCollections([['definitions', ssa.definitions], ['uses', ssa.uses], ['useDefLinks', ssa.useDefLinks]],
    { contractVersion: ssa.contractVersion, functionId }, work) : null;
  const memoryCapture = hasMemory ? captureCollections([['definitions', mssa.definitions], ['uses', mssa.uses],
    ['regions', mssa.regions ?? []], ['blockStates', mssa.blockStates ?? []]],
    { contractVersion: mssa.contractVersion, buildVersion: mssa.buildVersion, functionId }, work) : null;
  ir = { ...irCapture.metadata, ...irCapture.captured };
  if (hasSsa) ssa = { ...ssaCapture.metadata, ...ssaCapture.captured };
  if (hasMemory) mssa = { ...memoryCapture.metadata, ...memoryCapture.captured };
  const irDigest = await fingerprintCollections('semantic-ir', irCapture, work);
  const ssaDigest = hasSsa ? await fingerprintCollections('ssa', ssaCapture, work) : null;
  const memoryDigest = hasMemory ? await fingerprintCollections('memoryssa', memoryCapture, work) : null;
  let location = null;
  if (sourceLocation !== null) {
    const value = snapshotContractData(sourceLocation, { allowBigInt: true });
    recordFields(value, ['start', 'end', 'snapshotId'], 'query-source-location-fields');
    const start = unsignedAddress(value.start, { bits: 64 }), end = unsignedAddress(value.end, { bits: 64, allowEnd: true });
    if (value.snapshotId !== snapshotId || BigInt(end) <= BigInt(start) || !worldContains(world, binaryId, pipeline.sliceId)) contractFail('query-source-location-binding');
    location = { binaryId, sliceId: pipeline.sliceId, start, end, snapshotId,
      authority: 'source-bound-selected-extent; not-a-function-boundary-proof' };
  }
  const inputIdentity = deepFreeze({ binaryId, functionId, snapshotId,
    ...(functionLocator === null ? {} : { functionLocator }), ...(location ? { sourceLocation: location } : {}), worldId: world.id, assumptionsId: assumptions.id,
    producerArtifactId,
    ownerVersions: { ir: ir.contractVersion, ssa: hasSsa ? ssa.contractVersion : null, memoryssa: hasMemory ? mssa.buildVersion : null },
    ownerDigests: { ir: irDigest, ssa: ssaDigest, memoryssa: memoryDigest } });
  const projectionId = createEntityId({ binaryId, kind: 'canonical-query-projection', identity: { version: SEMANTIC_PROJECTION_VERSION, inputIdentity } });
  const records = new Map(), edges = new Map(), outgoing = new Map(), incoming = new Map(), origins = new Map(), sources = new Map(), frontier = [];
  const operationIds = new Map(), definitionIds = new Map(), useIds = new Map(), valueDefinitions = new Map(), memoryDefinitions = new Map(), memoryUses = new Map();
  const sourceNodes = new Map(ir.nodes.map((node) => [node.id, node]));
  const ownerReferences = new Map(), valueReferences = new Map(), semanticValues = new Map();
  const indexOwnerRows = (rows, field, code) => {
    const index = new Map();
    for (const row of rows) {
      work.charge('workUnits'); work.charge('residentBytes', 64);
      const key = exactString(row[field], code);
      if (index.has(key)) contractFail(code);
      index.set(key, row);
    }
    return index;
  };
  const blocks = indexOwnerRows(ir.blocks, 'id', 'query-block-identity');
  const memoryRegions = indexOwnerRows(hasMemory ? mssa.regions : [], 'id', 'query-memory-region-identity');
  const memoryBlockStates = indexOwnerRows(hasMemory ? mssa.blockStates : [], 'blockId', 'query-memory-block-state-identity');
  for (const value of ir.values) {
    exactString(value.id, 'query-semantic-value-id');
    if (semanticValues.has(value.id)) contractFail('query-semantic-value-duplicate');
    semanticValues.set(value.id, deepFreeze(value));
  }
  const artifact = (owner) => owner === 'semantic-ir' ? irDigest : owner === 'ssa' ? ssaDigest : memoryDigest;
  const addRecord = (owner, entityId, source, fields = {}) => {
    work.charge('workUnits'); work.charge('residentBytes', 512);
    exactString(entityId, 'query-source-entity');
    const id = createEntityId({ binaryId, kind: 'query-entity-reference', identity: { projectionId, owner, entityId } });
    if (records.has(id)) contractFail('query-projection-duplicate-entity');
    const reference = deepFreeze({ binaryId, functionId, projectionId, ...(functionLocator === null ? {} : { functionLocator }), owner, artifactId: producerArtifactId, ownerDigest: artifact(owner), entityId, snapshotId });
    const record = deepFreeze({ id, entityId, functionId, owner, kind: null, operator: null, blockId: null,
      addressSpace: null, variableKey: null, callTargets: [], roles: [], unknownFields: [], ...fields, reference,
      authority: 'canonical-owner-projection; not-execution-proof' });
    records.set(id, record); origins.set(id, source.origin ?? null); sources.set(id, source);
    ownerReferences.set(`${owner}\u0000${entityId}`, id);
    return id;
  };
  const addEdge = (from, to, kind, witness, obligations = [], flowKinds = null) => {
    work.charge('workUnits'); work.charge('edges'); work.charge('residentBytes', 384);
    if (!from || !to || !records.has(from) || !records.has(to)) {
      frontier.push({ reason: 'canonical-link-endpoint-missing', kind, source: witness }); return;
    }
    const body = { from, to, kind, witness, obligations, ...(flowKinds ? { flowKinds } : {}),
      relation: 'possible-dependence', executablePathProven: false };
    const id = createEntityId({ binaryId, kind: 'query-dependence-reference', identity: { projectionId, ...body } });
    if (edges.has(id)) return;
    const edge = deepFreeze({ ...body, id }); edges.set(id, edge);
    if (!outgoing.has(from)) outgoing.set(from, []); outgoing.get(from).push(id);
    if (!incoming.has(to)) incoming.set(to, []); incoming.get(to).push(id);
  };
  for (const node of ir.nodes) {
    const targetProof = node.call ? classifyCallTargetProof(node.call) : null;
    operationIds.set(node.id, addRecord('semantic-ir', node.id, node, { kind: node.kind, operator: node.operator,
      blockId: node.blockId, addressSpace: node.memory?.addressSpace ?? null, variableKey: node.variable?.key ?? null,
      callTargets: node.call?.targetEntityIds ?? [], roles: [node.kind],
      unknownFields: targetProof && !targetProof.exhaustive ? ['callTargets'] : [] }));
    if (node.completeness !== 'complete' || node.unknown) frontier.push({ entityId: node.id, reason: node.unknown?.reason ?? 'instruction-semantics-incomplete' });
    if (node.call) frontier.push({ entityId: node.id, reason: 'call-summary-flow-closure-unverified' });
    await work.yieldIfNeeded();
  }
  if (hasSsa) {
    for (const definition of ssa.definitions) {
      const id = addRecord('ssa', definition.definitionId, definition, { kind: definition.kind, blockId: definition.blockId,
        variableKey: definition.variableKey, roles: ['definition', definition.kind] });
      if (valueDefinitions.has(definition.valueId)) contractFail('query-projection-duplicate-ssa-value');
      definitionIds.set(definition.definitionId, id); valueDefinitions.set(definition.valueId, id);
      for (const valueId of new Set([definition.valueId, definition.proof?.sourceSemanticValueId].filter((value) => typeof value === 'string'))) {
        if (!valueReferences.has(valueId)) valueReferences.set(valueId, []);
        valueReferences.get(valueId).push(id);
      }
      if (['undef', 'unknown'].includes(definition.kind)) frontier.push({ entityId: definition.definitionId, reason: `ssa-${definition.kind}` });
      await work.yieldIfNeeded();
    }
    for (const use of ssa.uses) {
      const id = addRecord('ssa', use.useId, use, { kind: 'use', blockId: use.blockId,
        variableKey: use.proof?.variableIdentity?.key ?? null, roles: use.proof?.roles ?? ['state-use'] });
      useIds.set(use.useId, id);
      const operation = operationIds.get(use.sourceEntityId);
      const sourceNode = sourceNodes.get(use.sourceEntityId), roles = use.proof?.roles ?? [];
      // Only role-bearing owner inputs narrow facts. SSA links and arithmetic
      // remain neutral: an address may be copied/computed before its typed use.
      const flowKinds = roles.includes('memory-address') || sourceNode?.kind === 'address' ? ['address']
        : roles.some(role => ['control-condition', 'branch-condition', 'branch-target', 'call-target'].includes(role))
          || ['branch', 'conditional-branch', 'switch'].includes(sourceNode?.kind) ? ['control']
          : sourceNode?.kind === 'store' ? ['data', 'memory', 'capture', 'return'] : null;
      if (operation) addEdge(id, operation, 'operation-input', { owner: 'ssa', artifactId: producerArtifactId, ownerDigest: ssaDigest,
        useId: use.useId, sourceEntityId: use.sourceEntityId, roles: use.proof?.roles ?? [], proof: use.proof?.transform ?? null },
        ['operation-input-role-and-path-feasibility'], flowKinds);
      else frontier.push({ entityId: use.useId, reason: 'ssa-use-operation-binding-missing' });
      await work.yieldIfNeeded();
    }
    for (const link of ssa.useDefLinks) {
      addEdge(definitionIds.get(link.definitionId), useIds.get(link.useId), 'ssa-use-def',
        { owner: 'ssa', artifactId: producerArtifactId, ownerDigest: ssaDigest, definitionId: link.definitionId, useId: link.useId, valueId: link.valueId });
      await work.yieldIfNeeded();
    }
    for (const definition of ssa.definitions) {
      const to = definitionIds.get(definition.definitionId);
      if (definition.kind === 'phi') {
        for (const predecessor of definition.incoming ?? []) addEdge(valueDefinitions.get(predecessor.valueId), to, 'ssa-phi',
          { owner: 'ssa', artifactId: producerArtifactId, ownerDigest: ssaDigest, definitionId: definition.definitionId, predecessor }, ['phi-edge-feasibility']);
      } else {
        const producer = definition.proof?.sourceDefinitionNodeId ?? (sourceNodes.has(definition.sourceEntityId) ? definition.sourceEntityId : null);
        if (producer) addEdge(operationIds.get(producer), to, 'operation-output',
          { owner: 'ssa', artifactId: producerArtifactId, ownerDigest: ssaDigest, definitionId: definition.definitionId, sourceEntityId: producer, proof: definition.proof?.transform ?? null },
          definition.kind === 'definition' ? ['operation-output-dependence-not-equivalence'] : ['unknown-output-value']);
      }
      await work.yieldIfNeeded();
    }
  } else frontier.push({ reason: 'canonical-ssa-unavailable-or-unbound' });
  if (hasMemory) {
    for (const definition of mssa.definitions) {
      const id = addRecord('memoryssa', definition.id, definition, { kind: definition.kind, blockId: definition.blockId ?? null,
        roles: ['memory-definition', definition.kind] });
      memoryDefinitions.set(definition.id, id);
      if (definition.kind.includes('clobber')) frontier.push({ entityId: definition.id, reason: definition.kind });
      await work.yieldIfNeeded();
    }
    for (const use of mssa.uses) {
      const id = addRecord('memoryssa', use.id, use, { kind: 'memory-use', blockId: use.blockId ?? null, roles: ['memory-use'] });
      memoryUses.set(use.id, id);
      addEdge(memoryDefinitions.get(use.reachingDefinitionId), id, 'memory-reaching', { owner: 'memoryssa', artifactId: producerArtifactId, ownerDigest: memoryDigest,
        useId: use.id, definitionId: use.reachingDefinitionId, aliasRelation: use.aliasRelation, regionId: use.regionId },
        ['byte-coverage-and-alias-proof-not-replayed']);
      const operation = operationIds.get(use.sourceEntityId);
      if (operation) addEdge(id, operation, 'memory-output', { owner: 'memoryssa', artifactId: producerArtifactId, ownerDigest: memoryDigest, useId: use.id, sourceEntityId: use.sourceEntityId });
      else frontier.push({ entityId: use.id, reason: 'memory-use-operation-binding-missing' });
      await work.yieldIfNeeded();
    }
    for (const definition of mssa.definitions) {
      const to = memoryDefinitions.get(definition.id), operation = operationIds.get(definition.sourceEntityId);
      if (operation) addEdge(operation, to, 'memory-input', { owner: 'memoryssa', artifactId: producerArtifactId, ownerDigest: memoryDigest, definitionId: definition.id, sourceEntityId: definition.sourceEntityId },
        ['stored-value-address-role-and-byte-coverage']);
      // Ordinary stores KILL the previous memory version for their exact bytes.
      // Do not turn the version chain into a false old-value-to-new-value edge.
      if (definition.kind === 'memory-phi' || definition.kind.includes('clobber')) {
        const previous = stringSet([...(definition.previousDefinitionIds ?? []), ...(definition.incoming ?? []).map((item) => item.definitionId)]);
        for (const id of previous) addEdge(memoryDefinitions.get(id), to, 'memory-merge',
          { owner: 'memoryssa', artifactId: producerArtifactId, ownerDigest: memoryDigest, definitionId: definition.id, previousDefinitionId: id }, ['memory-merge-and-path-feasibility']);
      }
      await work.yieldIfNeeded();
    }
  } else frontier.push({ reason: 'canonical-memoryssa-unavailable-or-unbound' });
  if (sourceStatus !== 'complete' || ir.completeness !== 'complete') frontier.push({ reason: 'function-coverage-open' });
  if (producerArtifactId === null) frontier.push({ reason: 'canonical-producer-artifact-unbound' });
  frontier.push({ reason: 'whole-world-closure-not-qualified' });
  for (const list of [...outgoing.values(), ...incoming.values()]) { list.sort(compareIdentity); Object.freeze(list); }
  const order = [...records.keys()].sort(compareIdentity);
  for (const rows of valueReferences.values()) { rows.sort(compareIdentity); Object.freeze(rows); }
  work.checkpoint();
  return new CanonicalQueryProjection(CONSTRUCTOR, { records, order, edges, outgoing, incoming, origins, sources,
    world, assumptions, inputIdentity, frontier, id: projectionId, functionId, valueReferences, ownerReferences, semanticValues,
    blocks, memoryRegions, memoryBlockStates });
}


/**
 * Merge an EXPLICIT, bounded function scope into a disposable reference view.
 * bridgeRows are first-party owner references checked by the scope builder;
 * they are still possible dependencies, never new machine facts or closures.
 * Source artifacts and their individual hashes remain attached to every row.
 */
export async function composeCanonicalQueryProjections(projections, bridgeRows, extraFrontier,
  { world, assumptions, snapshotId, work } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world); assertScopedAnalysisWork(work);
  exactString(snapshotId, 'query-composite-snapshot');
  if (!Array.isArray(projections) || !projections.length || projections.length > 16
    || !Array.isArray(bridgeRows) || bridgeRows.length > 4096
    || !Array.isArray(extraFrontier) || extraFrontier.length > 4096) contractFail('query-composite-bounds');
  const members = projections.map((projection) => assertCanonicalQueryProjection(projection, { world, assumptions }));
  const functions = new Set();
  for (const projection of members) {
    if (functions.has(projection.functionId) || projection.inputIdentity.snapshotId !== snapshotId) contractFail('query-composite-member-binding');
    functions.add(projection.functionId);
  }
  if (members.reduce((sum, projection) => sum + projection.size, 0) > 65536
    || members.reduce((sum, projection) => sum + projection.edgeCount, 0) + bridgeRows.length > 262144) contractFail('query-composite-structural-budget');
  const canonicalInputs = members.map((projection) => projection.inputIdentity).sort((a, b) => compareIdentity(a.functionId, b.functionId));
  const functionId = createEntityId({ binaryId: world.binarySet[0].binaryId, kind: 'explicit-function-query-scope',
    identity: { worldId: world.id, assumptionsId: assumptions.id, functions: [...functions].sort(compareIdentity) } });
  const bridges = snapshotContractData(bridgeRows, { allowBigInt: true, maxBytes: 4 * 1024 * 1024, maxNodes: 131072 });
  const inputIdentity = deepFreeze({ binaryId: world.binarySet[0].binaryId, functionId, snapshotId,
    worldId: world.id, assumptionsId: assumptions.id, producerArtifactId: null,
    ownerVersions: { projection: SEMANTIC_PROJECTION_VERSION, composition: 'explicit-call-context/v1' },
    ownerDigests: { members: stableDigest(canonicalInputs), bridges: stableDigest({ bridges, typed: lossyTypeWitness(bridges) }) },
    canonicalInputs, authority: 'derived-reference-container-not-canonical-artifact' });
  const id = createEntityId({ binaryId: world.binarySet[0].binaryId, kind: 'scoped-query-projection', identity: inputIdentity });
  const records = new Map(), edges = new Map(), outgoing = new Map(), incoming = new Map(), origins = new Map(), sources = new Map();
  const frontier = [], valueReferences = new Map(), ownerReferences = new Map();
  const addEdge = (edge) => {
    work.charge('workUnits'); work.charge('residentBytes', 112);
    if (!records.has(edge.from) || !records.has(edge.to) || edges.has(edge.id)) contractFail('query-composite-edge-binding');
    edges.set(edge.id, edge);
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []); outgoing.get(edge.from).push(edge.id);
    if (!incoming.has(edge.to)) incoming.set(edge.to, []); incoming.get(edge.to).push(edge.id);
  };
  for (const projection of members) {
    for (let index = 0; index < projection.size; index++) {
      work.charge('workUnits'); work.charge('residentBytes', 160);
      const record = projection.recordAt(index);
      if (records.has(record.id)) contractFail('query-composite-record-duplicate');
      records.set(record.id, record); origins.set(record.id, projection.present(record.id, { includeOrigins: true }).origin);
      sources.set(record.id, projection.source(record.id));
      // Function prefixes intentionally prevent cross-function SSA ID aliasing.
      ownerReferences.set(`${record.functionId}\u0000${record.owner}\u0000${record.entityId}`, record.id);
      await work.yieldIfNeeded();
    }
    for (const gap of projection.frontier) frontier.push({ ...gap, functionId: projection.functionId });
  }
  for (const projection of members) for (let index = 0; index < projection.edgeCount; index++) {
    addEdge(projection.edgeAt(index)); await work.yieldIfNeeded();
  }
  for (const bridge of bridges) {
    if (!['enter', 'return'].includes(bridge.boundary?.direction) || bridge.kind !== 'call-summary'
      || bridge.executablePathProven !== false || bridge.relation !== 'possible-dependence') contractFail('query-composite-bridge-contract');
    const from = records.get(bridge.from), to = records.get(bridge.to);
    if (!from || !to) contractFail('query-composite-bridge-endpoints');
    exactString(bridge.id, 'query-composite-bridge-id'); exactString(bridge.boundary.callSite, 'query-composite-call-context');
    const entering = bridge.boundary.direction === 'enter';
    if (from.functionId !== (entering ? bridge.boundary.callerFunctionId : bridge.boundary.calleeFunctionId)
      || to.functionId !== (entering ? bridge.boundary.calleeFunctionId : bridge.boundary.callerFunctionId)) contractFail('query-composite-bridge-function-binding');
    addEdge(bridge); await work.yieldIfNeeded();
  }
  for (const gap of snapshotContractData(extraFrontier, { allowBigInt: true, maxNodes: 65536 })) frontier.push(gap);
  frontier.push({ reason: 'interprocedural-context-and-boundary-qualification-pending', functionId: null });
  for (const rows of [...outgoing.values(), ...incoming.values()]) { rows.sort(compareIdentity); Object.freeze(rows); }
  work.checkpoint();
  return new CanonicalQueryProjection(CONSTRUCTOR, { records, order: [...records.keys()].sort(compareIdentity), edges,
    outgoing, incoming, origins, sources, world, assumptions, inputIdentity, frontier, id, functionId, valueReferences, ownerReferences });
}
