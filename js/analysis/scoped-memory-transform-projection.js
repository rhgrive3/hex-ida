/** Capture the existing decompiler's canonical MemorySSA value-forwarding
 * receipts. Memory accesses remain inherited canonical effects: this proves a
 * value substitution, never that the rendered C may erase a faulting access.
 */
import { deepFreeze, stableStringify } from '../core/identity/index.js';
import { snapshotContractData } from '../core/identity/structured.js';
import { isCanonicalMemorySsaProducerArtifact } from '../semantics/memoryssa/build.js';
import { isCanonicalExactMemoryForwarding, canonicalMemoryForwardingContextForLoad } from '../semantics/memoryssa/queries.js';
import { MEMORY_TRANSFORM_PROGRAM_SCHEMA, normalizeMemoryTransformProgram } from '../core/evidence/memory-transform-proof.js';

export const CANONICAL_MEMORY_TRANSFORM_CAPTURE_SCHEMA = 'canonical-memory-transform-capture/v1';
const copy = value => snapshotContractData(value, { allowBigInt: true, maxNodes: 65536, maxBytes: 4194304 });
const tick = work => { work.charge('workUnits'); work.checkpoint(); };
function valueBytes(value, widthBits) {
  const n = BigInt(value);
  return Array.from({ length: widthBits / 8 }, (_, i) => Number((n >> BigInt(i * 8)) & 255n));
}
function matchesStatement(statement, load, fact) {
  const expression = statement.semantic?.expression;
  if (!statement.source?.ir?.includes(load.id) || expression?.kind !== 'const'
    || expression.bits !== fact.widthBits || !['number', 'string', 'bigint'].includes(typeof expression.value)) return false;
  try { return BigInt.asUintN(fact.widthBits, BigInt(expression.value)) === BigInt.asUintN(fact.widthBits, fact.value); }
  catch { return false; }
}

function captureCanonicalMemoryTransformsImpl(pipeline, decompiler, { worldId, snapshotId, concurrency, work }) {
  const mssa = pipeline.memorySsa, remaining = [];
  const base = { schema: CANONICAL_MEMORY_TRANSFORM_CAPTURE_SCHEMA, worldId, snapshotId, functionId: pipeline.functionId,
    ownerDigest: mssa?.canonicalDigest ?? null, proofStatus: 'not-checked', exact: false,
    scope: 'actual-canonical-forwarded-values-with-inherited-machine-events',
    renderedEventPreservation: 'unproved', canonicalAcceptance: 'read-only' };
  const finish = steps => {
    const result = copy({ ...base, steps, remaining: [...new Set(remaining)] });
    work.charge('residentBytes', stableStringify(result).length * 2); work.checkpoint(); return deepFreeze(result);
  };
  if (!isCanonicalMemorySsaProducerArtifact(mssa) || mssa.snapshotId !== snapshotId || mssa.functionId !== pipeline.functionId) {
    remaining.push('memory-transform-canonical-owner-unbound'); return finish([]);
  }
  if (mssa.completeness !== 'complete' || mssa.unknowns?.length || pipeline.semanticIr.unknowns?.length) {
    remaining.push('memory-transform-canonical-owner-incomplete'); return finish([]);
  }
  if (pipeline.cfg.blocks.length !== 1 || pipeline.cfg.blocks[0].successors.length
    || pipeline.semanticIr.nodes.some(n => !['state-read', 'state-write', 'const', 'address', 'load', 'store', 'return', 'unary', 'binary', 'extract', 'extend', 'truncate'].includes(n.kind))) {
    remaining.push('memory-transform-nonlinear-or-unmodeled-effects'); return finish([]);
  }
  if (mssa.accessMetadata.length > 128 || mssa.definitions.length > 256 || mssa.uses.length > 128 || decompiler.cAst.body.length > 128) {
    remaining.push('memory-transform-capture-budget'); return finish([]);
  }
  const definitions = new Map(mssa.definitions.map(row => [row.id, row]));
  const uses = new Map(mssa.uses.map(row => [row.id, row]));
  const nodes = new Map(pipeline.semanticIr.nodes.map(row => [row.id, row]));
  const operations = [], outputs = [];
  const ordered = [...mssa.accessMetadata].sort((a, b) => a.order - b.order);
  let previousOrder = -1;
  for (const row of ordered) {
    tick(work);
    const node = nodes.get(row.nodeId), entity = definitions.get(row.memorySsaEntityId) ?? uses.get(row.memorySsaEntityId);
    const r = row.byteRange, memory = row.memory;
    if (!node || !entity || entity.sourceEntityId !== node.id || row.sourceEntityId !== node.id
      || row.broad !== false || row.aliasRelation !== 'must' || !['load', 'store'].includes(row.sourceKind)
      || node.kind !== row.sourceKind || !r || !memory || memory.addressSpace !== 'memory'
      || !Number.isSafeInteger(row.order) || row.order <= previousOrder
      || !Number.isSafeInteger(memory.widthBits) || memory.widthBits < 8 || memory.widthBits > 128 || memory.widthBits % 8
      || !Array.isArray(memory.faults) || BigInt(r.end) - BigInt(r.start) !== BigInt(memory.widthBits / 8)) {
      remaining.push('memory-transform-access-or-clobber-unmodeled'); return finish([]);
    }
    previousOrder = row.order;
    if (row.sourceKind === 'store' && (row.canonicalValue?.valueKind !== 'bitvector' || row.canonicalValue?.value == null)) {
      remaining.push('memory-transform-store-operand-unavailable'); return finish([]);
    }
    const operation = { id: row.memorySsaEntityId, kind: row.sourceKind === 'load' ? 'read' : 'write', sourceEntityId: node.id,
      range: { domain: r.domain, start: r.start, bytes: memory.widthBits / 8 }, endian: memory.endian,
      effects: { volatile: memory.volatility, atomic: memory.atomic, ordering: memory.ordering ?? 'none',
        faults: memory.faults, exceptionTargets: [], addressSpace: memory.addressSpace },
      reachingDefinitions: row.sourceKind === 'load' ? [entity.reachingDefinitionId] : entity.previousDefinitionIds };
    if (row.sourceKind === 'load') { operation.target = entity.id; outputs.push(entity.id); }
    else operation.value = valueBytes(row.canonicalValue.value, memory.widthBits);
    operations.push(operation);
  }
  const unknowns = concurrency === 'single-thread' ? [] : ['memory-transform-concurrency-not-qualified'];
  remaining.push(...unknowns);
  let current = normalizeMemoryTransformProgram({ schema: MEMORY_TRANSFORM_PROGRAM_SCHEMA, worldId, snapshotId,
    functionId: pipeline.functionId, ownerDigest: mssa.canonicalDigest, inputs: [], operations, outputs, unknowns,
    control: 'linear-normal-exit-with-fault-prefixes', concurrency: 'single-thread-no-unmodeled-writers' }, { work });
  const steps = [];
  for (const load of pipeline.legacyV1.instructions) {
    tick(work);
    if (load.op !== 'load' || !load.memoryForwarding) continue;
    const fact = load.memoryForwarding;
    work.charge('workUnits', mssa.definitions.length + mssa.uses.length + mssa.accessMetadata.length + decompiler.cAst.body.length);
    work.checkpoint();
    const context = canonicalMemoryForwardingContextForLoad(fact, load, load.memoryForwardingContext ?? load.extra?.memoryForwardingContext);
    if (!isCanonicalExactMemoryForwarding(fact, context) || context.artifact !== mssa) continue;
    const statements = decompiler.cAst.body.map((row, index) => matchesStatement(row, load, fact) ? index : null).filter(index => index !== null);
    if (!statements.length) { remaining.push('memory-transform-final-statement-binding-unavailable'); continue; }
    const operationIndex = current.operations.findIndex(op => op.id === fact.useId && op.kind === 'read');
    if (operationIndex < 0) { remaining.push('memory-transform-forwarding-use-unavailable'); continue; }
    const old = current.operations[operationIndex];
    // Preserve the memory read, including its fault/order/device event. Only
    // its value projection changes to the already-consumed canonical constant.
    const nextOperations = [...current.operations];
    nextOperations.splice(operationIndex, 1, { ...old, target: null },
      { id: `${old.id}:forwarded-value`, kind: 'copy', target: old.target, value: valueBytes(fact.value, fact.widthBits) });
    const { id: ignored, ...body } = current;
    const after = normalizeMemoryTransformProgram({ ...body, operations: nextOperations }, { work });
    const step = { before: current, after, sourceReceipt: copy(fact), statementIndices: statements,
      statementBindings: statements.map(index => ({ index, text: decompiler.cAst.body[index].text, source: copy(decompiler.cAst.body[index].source) })),
      ruleId: 'canonical-memoryssa-value-forwarding-with-retained-events', ruleVersion: fact.proofVersion,
      canonicalSource: { artifactDigest: fact.artifactDigest, useId: fact.useId, contributingDefinitionIds: fact.contributingDefinitionIds },
      claim: 'equivalent-with-inherited-machine-events' };
    steps.push(step); current = after;
    if (steps.length === 32) { remaining.push('memory-transform-step-capture-limit'); break; }
  }
  if (!steps.length && !remaining.length) remaining.push('no-captured-canonical-memory-value-changes');
  return finish(steps);
}

export function captureCanonicalMemoryTransforms(pipeline, decompiler, context) {
  try { return captureCanonicalMemoryTransformsImpl(pipeline, decompiler, context); }
  catch (error) {
    // A bounded optional capture may be too large after expanding shared DAG
    // references. Keep that explicit without discarding unrelated cast proofs.
    // Cancellation/deadline/shared-work exhaustion always propagates.
    if (!/^analysis-contract-(?:byte|node|depth|property|string|key)-budget$/.test(error.code ?? '')) throw error;
    context.work.checkpoint();
    return deepFreeze({ schema: CANONICAL_MEMORY_TRANSFORM_CAPTURE_SCHEMA, worldId: context.worldId,
      snapshotId: context.snapshotId, functionId: pipeline.functionId, ownerDigest: pipeline.memorySsa?.canonicalDigest ?? null,
      proofStatus: 'not-checked', exact: false, scope: 'actual-canonical-forwarded-values-with-inherited-machine-events',
      renderedEventPreservation: 'unproved', canonicalAcceptance: 'read-only', steps: [], remaining: ['memory-transform-capture-budget'] });
  }
}
