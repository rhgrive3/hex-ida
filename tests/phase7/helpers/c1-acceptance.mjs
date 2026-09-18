/** C1 combined acceptance fixtures; no semantic implementation or private test imports. */
import { fixture, origin } from './fixtures.mjs';
import { createFunctionSummary } from '../../../js/analysis/summary/contract.js';
import { createPhase7AliasSolver } from '../../../js/analysis/alias/solver.js';
import { classifySemanticMemoryRegion } from '../../../js/analysis/alias/regions-v2.js';
import { buildMemorySsa, MEMORY_SSA_BUILD_VERSION } from '../../../js/semantics/memoryssa/build.js';
import { buildSemanticSsa } from '../../../js/semantics/ssa/build.js';
import { stableDigest } from '../../../js/core/identity/index.js';

export const SNAPSHOT = 'user-c1-combined-acceptance';
export const RETURN_KINDS = Object.freeze(['arg', 'root', 'allocation']);

export function finiteSummary(kind, functionId, index = 0) {
  const fact = { kind, returnIndex:0, offset:String(16 + 16 * index),
    ...(kind === 'arg' ? { argIndex:0 }
      : kind === 'root' ? { rootEntityId:`root_${index}`, addressSpace:'memory' }
        : { allocationSiteId:`allocation_${index}`, addressSpace:'memory' }) };
  return createFunctionSummary({ functionId, inputs:['arg'], returnValues:['result'], returnProvenance:[fact],
    noreturn:false, mayThrow:false,
    status:{ snapshotId:SNAPSHOT, analyzerId:'c1-acceptance-declared-summary', analyzerVersion:'1', completeness:'complete' } });
}

/** Reuse the canonical microfixture builder and alias/MemorySSA owners. */
export function callerFixture({ functionId = 'caller', targets = ['leaf_a'], spill = true,
  memoryMode = 'ordinary', endian = 'little', returnOffset = 0, incompleteCall = false, argumentBits = 64 } = {}) {
  const f = fixture(functionId).block('entry');
  f.stateRead('arg', 'state:x0', { machineType:{ kind:'address', widthBits:argumentBits, addressSpace:'memory' } });
  f.values.find(value => value.id === 'arg').metadata = { argumentIndex:0 };
  if (spill) {
    f.stateRead('base', 'state:sp');
    f.constant('zero', 0);
    f.binary('slot', 'add', 'base', 'zero');
  }
  if (targets.length > 1) f.stateRead('callee_pointer', 'state:x9');
  const callId = f.pureCall('returned', { calleeId:targets[0] });
  const call = f.nodes.find(node => node.id === callId);
  call.inputs = ['arg']; call.outputs = ['returned'];
  call.call.arguments = ['arg']; call.call.returns = ['returned'];
  call.call.targetEntityIds = targets;
  call.call.targetValueIds = targets.length > 1 ? ['callee_pointer'] : [];
  if (incompleteCall) {
    call.completeness = call.call.completeness = 'partial';
    call.unknown = call.call.unknownEffects = { reason:'non-exhaustive-indirect-targets', categories:['control'] };
  }
  f.values.push({ id:'returned', kind:'definition', definitionNodeId:callId,
    machineType:{ kind:'address', widthBits:64, addressSpace:'memory' }, origin:origin('returned') });
  if (spill) {
    f.store('spill', 'slot', 'returned', { widthBits:64 });
    if (memoryMode === 'unknown-call') f.unknownCall('clobber');
    f.load('loaded', 'slot', { widthBits:64 });
    f.values.find(value => value.id === 'loaded').machineType = { kind:'address', widthBits:64, addressSpace:'memory' };
    const store = f.nodes.find(node => node.id === 'node_spill');
    const load = f.nodes.find(node => node.id === 'node_loaded');
    store.memory.endian = load.memory.endian = endian;
    if (memoryMode === 'width-conflict') store.memory.widthBits = 32;
    if (memoryMode === 'endian-conflict') store.memory.endian = endian === 'little' ? 'big' : 'little';
    if (memoryMode === 'atomic') store.memory.atomic = true;
    if (memoryMode === 'volatile') load.memory.volatility = true;
    f.constant('field_offset', 8);
    f.binary('field', 'add', 'loaded', 'field_offset');
  }
  let returnValue = spill ? 'loaded' : 'returned';
  if (returnOffset) {
    f.constant('wrapper_offset', returnOffset);
    f.binary('wrapper_return', 'add', returnValue, 'wrapper_offset');
    returnValue = 'wrapper_return';
  }
  const retId = f.ret('exit');
  f.nodes.find(node => node.id === retId).inputs = [returnValue];
  const ir = f.ir(), cfg = f.cfg(), ssa = buildSemanticSsa(ir, cfg);
  if (!spill) return { ir, cfg, ssa, memorySsa:null };
  const semanticIrDigest = stableDigest(ir), scalarSsaDigest = stableDigest(ssa);
  const identity = { binaryId:f.binaryId, sliceId:'slice_c1_acceptance', functionId,
    snapshotId:SNAPSHOT, semanticIrId:`ir-${semanticIrDigest}`, semanticIrDigest,
    semanticIrContractVersion:ir.contractVersion, scalarSsaId:`ssa-${scalarSsaDigest}`,
    scalarSsaDigest, scalarSsaBuildVersion:'1.0.0', memorySsaId:`mssa-${functionId}`,
    memorySsaBuildVersion:MEMORY_SSA_BUILD_VERSION, analyzerVersion:'c1-acceptance-fixture' };
  const alias = createPhase7AliasSolver({ ir, cfg, ssa, options:{ snapshotId:SNAPSHOT } });
  let memorySsa = buildMemorySsa(ir, cfg, {
    resolveRegion:(_memory, context) => classifySemanticMemoryRegion(ir, context.node, { binaryId:f.binaryId, ssa }),
    queryAlias:memoryMode === 'may-alias'
      ? (...args) => ({ ...alias.queryAlias(...args), relation:'may' }) : alias.queryAlias,
    identity, snapshotId:SNAPSHOT,
    canonicalIrIdentity:{ functionId, semanticIrId:identity.semanticIrId, semanticIrContractVersion:ir.contractVersion, semanticIrDigest },
  });
  if (memoryMode === 'copied-memoryssa') memorySsa = structuredClone(memorySsa);
  return { ir, cfg, ssa, memorySsa };
}
