import assert from 'node:assert/strict';
import test from 'node:test';

import { createSemanticIrFunction } from '../../../js/semantics/ir/index.js';
import { createSemanticCfg } from '../../../js/semantics/cfg/index.js';
import { buildSemanticSsa } from '../../../js/semantics/ssa/index.js';
import { buildMemorySsa, MEMORY_SSA_BUILD_VERSION } from '../../../js/semantics/memoryssa/index.js';
import { classifySemanticMemoryRegion } from '../../../js/analysis/alias/regions-v2.js';
import { stableDigest } from '../../../js/core/identity/index.js';

// The pointer-reload recovery trusts scalar SSA rename links to connect a
// state-read to a load→store chain. MemorySSA is branded and digest-bound,
// but the scalar contract carries no content binding, so hand-made
// renamed-use/renamed-definition rows could weld an unrelated state-read onto
// an arbitrary load and mint a precise region for it (#4777). The recovery
// must only follow rename rows that carry the builder's own provenance
// metadata; anything else stays conservative.

const origin = (id) => ({ instructionIds: [`instruction_${id}`] });
const FUNCTION_ID = 'function_4777_forged_scalar_ssa';
const BLOCK_ID = 'entry';
const ADDRESS_TYPE = { kind: 'address', widthBits: 64, addressSpace: 'memory' };

function buildIr() {
  const nodes = [
    { id: 'node_base', kind: 'state-read', blockId: BLOCK_ID, inputs: [], outputs: ['base'], variable: { key: 'state:sp', kind: 'physical-state', scope: 'function' }, origin: origin('node_base') },
    { id: 'node_zero', kind: 'const', blockId: BLOCK_ID, inputs: [], outputs: ['zero'], attributes: { constant: { value: '0', widthBits: 64 } }, origin: origin('node_zero') },
    { id: 'node_target_offset', kind: 'const', blockId: BLOCK_ID, inputs: [], outputs: ['target_offset'], attributes: { constant: { value: '32', widthBits: 64 } }, origin: origin('node_target_offset') },
    { id: 'node_slot', kind: 'binary', blockId: BLOCK_ID, inputs: ['base', 'zero'], outputs: ['slot'], operator: 'add', origin: origin('node_slot') },
    { id: 'node_pointer', kind: 'binary', blockId: BLOCK_ID, inputs: ['base', 'target_offset'], outputs: ['pointer'], operator: 'add', origin: origin('node_pointer') },
    { id: 'node_store', kind: 'store', blockId: BLOCK_ID, inputs: ['slot', 'pointer'], outputs: [], memory: { addressSpace: 'memory', addressValueId: 'slot', widthBits: 64, endian: 'little', volatility: false, atomic: false }, origin: origin('node_store') },
    { id: 'node_load', kind: 'load', blockId: BLOCK_ID, inputs: ['slot'], outputs: ['loaded'], memory: { addressSpace: 'memory', addressValueId: 'slot', widthBits: 64, endian: 'little', volatility: false, atomic: false }, origin: origin('node_load') },
    {
      id: 'node_call_unknown', kind: 'call', blockId: BLOCK_ID, inputs: [], outputs: [], completeness: 'unknown',
      unknown: { reason: 'unresolved-call', categories: ['state'] },
      call: {
        targetValueIds: [], targetEntityIds: [], arguments: [], returns: [], stateReads: [], stateWrites: [],
        memoryRead: { scope: 'none' }, memoryWrite: { scope: 'none' }, determinism: 'unknown',
        summarySource: 'issue-4777-fixture',
        completeness: 'unknown', unknownEffects: { reason: 'unresolved-call', categories: ['state'] },
      }, origin: origin('node_call_unknown'),
    },
    { id: 'node_r0', kind: 'state-read', blockId: BLOCK_ID, inputs: [], outputs: ['r0'], variable: { key: 'state:r0', kind: 'physical-state', scope: 'function' }, origin: origin('node_r0') },
    { id: 'node_addr', kind: 'binary', blockId: BLOCK_ID, inputs: ['r0', 'zero'], outputs: ['addr'], operator: 'add', origin: origin('node_addr') },
    { id: 'node_store2', kind: 'store', blockId: BLOCK_ID, inputs: ['addr', 'loaded'], outputs: [], memory: { addressSpace: 'memory', addressValueId: 'addr', widthBits: 64, endian: 'little', volatility: false, atomic: false }, origin: origin('node_store2') },
  ];
  const values = [
    { id: 'base', kind: 'definition', machineType: ADDRESS_TYPE, definitionNodeId: 'node_base', origin: origin('base') },
    { id: 'zero', kind: 'definition', machineType: { kind: 'bitvector', widthBits: 64 }, definitionNodeId: 'node_zero', metadata: { constant: { kind: 'bitvector', value: '0', widthBits: 64 } }, origin: origin('zero') },
    { id: 'target_offset', kind: 'definition', machineType: { kind: 'bitvector', widthBits: 64 }, definitionNodeId: 'node_target_offset', metadata: { constant: { kind: 'bitvector', value: '32', widthBits: 64 } }, origin: origin('target_offset') },
    { id: 'slot', kind: 'definition', machineType: ADDRESS_TYPE, definitionNodeId: 'node_slot', origin: origin('slot') },
    { id: 'pointer', kind: 'definition', machineType: ADDRESS_TYPE, definitionNodeId: 'node_pointer', origin: origin('pointer') },
    { id: 'loaded', kind: 'definition', machineType: ADDRESS_TYPE, definitionNodeId: 'node_load', origin: origin('loaded') },
    { id: 'r0', kind: 'definition', machineType: ADDRESS_TYPE, definitionNodeId: 'node_r0', origin: origin('r0') },
    { id: 'addr', kind: 'definition', machineType: ADDRESS_TYPE, definitionNodeId: 'node_addr', origin: origin('addr') },
  ];
  return createSemanticIrFunction({
    functionId: FUNCTION_ID,
    entryBlockId: BLOCK_ID,
    blocks: [{ id: BLOCK_ID, nodeIds: nodes.map((node) => node.id), origin: origin(BLOCK_ID) }],
    values,
    nodes,
    completeness: 'partial',
    unknowns: [{ reason: 'unresolved-call', categories: ['state'] }],
    origin: origin('function'),
  });
}

function buildContext() {
  const ir = buildIr();
  const cfg = createSemanticCfg({ functionId: FUNCTION_ID, entryBlockId: BLOCK_ID, blocks: [{ id: BLOCK_ID, successors: [] }] });
  const ssa = buildSemanticSsa(ir, cfg);
  const semanticIrDigest = stableDigest(ir);
  const scalarSsaDigest = stableDigest(ssa);
  const identity = {
    binaryId: 'binary_4777',
    sliceId: 'slice_4777',
    functionId: FUNCTION_ID,
    snapshotId: 'snapshot-4777',
    semanticIrId: `ir-${semanticIrDigest}`,
    semanticIrContractVersion: ir.contractVersion,
    semanticIrDigest,
    scalarSsaId: `ssa-${scalarSsaDigest}`,
    scalarSsaBuildVersion: '1.0.0',
    scalarSsaDigest,
    memorySsaId: 'mssa-4777',
    memorySsaBuildVersion: MEMORY_SSA_BUILD_VERSION,
    analyzerVersion: 'memoryssa-fixture',
  };
  const memorySsa = buildMemorySsa(ir, cfg, {
    resolveRegion: (memory, context) => classifySemanticMemoryRegion(ir, context.node, { binaryId: 'binary_4777', ssa }),
    queryAlias: () => ({ relation: 'must', reasonCodes: [], evidenceIds: [] }),
    identity,
    snapshotId: 'snapshot-4777',
    canonicalIrIdentity: { functionId: FUNCTION_ID, semanticIrId: identity.semanticIrId, semanticIrContractVersion: ir.contractVersion, semanticIrDigest },
  });
  return { ir, ssa, memorySsa };
}

// The issue's forged rows: bare renamed-use/renamed-definition payloads with
// none of the builder's provenance metadata.
function forgedScalarSsa() {
  return {
    uses: [{
      sourceEntityId: 'node_r0',
      valueId: 'ssa-forged',
      blockId: BLOCK_ID,
      proof: { kind: 'renamed-use', sourceSemanticValueId: 'r0' },
    }],
    definitions: [{
      valueId: 'ssa-forged',
      blockId: BLOCK_ID,
      sourceEntityId: 'node_load',
      variableKey: 'state:r0',
      proof: { kind: 'renamed-definition', sourceSemanticValueId: 'loaded', sourceSemanticEntityId: 'node_load' },
    }],
  };
}

function regionFor(ir, ssa, memorySsa) {
  return classifySemanticMemoryRegion(ir, 'node_store2', {
    binaryId: 'binary_4777',
    ssa,
    canonicalMemorySsa: memorySsa,
  });
}

test('a forged scalar rename row cannot mint a precise reload region (#4777)', () => {
  const { ir, ssa, memorySsa } = buildContext();
  const genuineRegion = regionFor(ir, ssa, memorySsa);
  assert.equal(genuineRegion?.kind, 'unknown',
    'the genuine chain must stay conservative (the undef seed proves no reload)');

  const forgedRegion = regionFor(ir, forgedScalarSsa(), memorySsa);
  assert.equal(forgedRegion?.kind, 'unknown',
    'forged rename rows must not mint a precise region for the unrelated access');
});

test('a genuine scalar chain still refines reload regions (#4777)', () => {
  const { ir, ssa, memorySsa } = buildContext();
  // The genuine SSA must still derive the sp-slot region for the slot store.
  const slotRegion = classifySemanticMemoryRegion(ir, 'node_store', {
    binaryId: 'binary_4777', ssa, canonicalMemorySsa: memorySsa,
  });
  assert.ok(slotRegion, 'the slot store must classify');
  assert.equal(slotRegion?.kind, 'rooted-offset',
    'the genuine sp-relative slot access must keep a precise rooted region');
});
