import assert from 'node:assert/strict';
import test from 'node:test';

import { createSemanticIrFunction } from '../../../js/semantics/ir/index.js';
import { createSemanticCfg } from '../../../js/semantics/cfg/index.js';
import { buildSemanticSsa } from '../../../js/semantics/ssa/index.js';
import { buildMemorySsa, MEMORY_SSA_BUILD_VERSION } from '../../../js/semantics/memoryssa/index.js';
import {
  canonicalMemoryPointerRegionEvidence,
  classifySemanticMemoryRegion,
  deriveMemoryRegion,
  genuineRenamedDefinitionRow,
  genuineRenamedUseRow,
} from '../../../js/analysis/alias/regions-v2.js';
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

function buildIr({ withUnknownCall = true } = {}) {
  const nodes = [
    { id: 'node_base', kind: 'state-read', blockId: BLOCK_ID, inputs: [], outputs: ['base'], variable: { key: 'state:sp', kind: 'physical-state', scope: 'function' }, origin: origin('node_base') },
    { id: 'node_zero', kind: 'const', blockId: BLOCK_ID, inputs: [], outputs: ['zero'], attributes: { constant: { value: '0', widthBits: 64 } }, origin: origin('node_zero') },
    { id: 'node_target_offset', kind: 'const', blockId: BLOCK_ID, inputs: [], outputs: ['target_offset'], attributes: { constant: { value: '32', widthBits: 64 } }, origin: origin('node_target_offset') },
    { id: 'node_slot', kind: 'binary', blockId: BLOCK_ID, inputs: ['base', 'zero'], outputs: ['slot'], operator: 'add', origin: origin('node_slot') },
    { id: 'node_pointer', kind: 'binary', blockId: BLOCK_ID, inputs: ['base', 'target_offset'], outputs: ['pointer'], operator: 'add', origin: origin('node_pointer') },
    { id: 'node_store', kind: 'store', blockId: BLOCK_ID, inputs: ['slot', 'pointer'], outputs: [], memory: { addressSpace: 'memory', addressValueId: 'slot', widthBits: 64, endian: 'little', volatility: false, atomic: false }, origin: origin('node_store') },
    { id: 'node_load', kind: 'load', blockId: BLOCK_ID, inputs: ['slot'], outputs: ['loaded'], memory: { addressSpace: 'memory', addressValueId: 'slot', widthBits: 64, endian: 'little', volatility: false, atomic: false }, origin: origin('node_load') },
    ...(withUnknownCall ? [{
      id: 'node_call_unknown', kind: 'call', blockId: BLOCK_ID, inputs: [], outputs: [], completeness: 'unknown',
      unknown: { reason: 'unresolved-call', categories: ['state'] },
      call: {
        targetValueIds: [], targetEntityIds: [], arguments: [], returns: [], stateReads: [], stateWrites: [],
        memoryRead: { scope: 'none' }, memoryWrite: { scope: 'none' }, determinism: 'unknown',
        summarySource: 'issue-4777-fixture',
        completeness: 'unknown', unknownEffects: { reason: 'unresolved-call', categories: ['state'] },
      }, origin: origin('node_call_unknown'),
    }] : []),
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
    completeness: withUnknownCall ? 'partial' : 'complete',
    ...(withUnknownCall ? { unknowns: [{ reason: 'unresolved-call', categories: ['state'], detail: { nodeId: 'node_call_unknown' } }] } : {}),
    origin: origin('function'),
  });
}

function connectedReloadIr({ targetOffset = '32' } = {}) {
  const raw = structuredClone(buildIr({ withUnknownCall: true }));
  const callIndex = raw.nodes.findIndex((node) => node.id === 'node_call_unknown');
  assert.notEqual(callIndex, -1);
  raw.nodes[callIndex] = {
    id: 'node_r0_write', kind: 'state-write', blockId: BLOCK_ID,
    inputs: ['loaded'], outputs: [],
    variable: { key: 'state:r0', kind: 'physical-state', scope: 'function' },
    origin: origin('node_r0_write'),
  };
  raw.blocks[0].nodeIds = raw.blocks[0].nodeIds.map((id) => id === 'node_call_unknown' ? 'node_r0_write' : id);
  raw.completeness = 'complete';
  raw.unknowns = [];
  const targetNode = raw.nodes.find((node) => node.id === 'node_target_offset');
  const targetValue = raw.values.find((value) => value.id === 'target_offset');
  targetNode.attributes.constant.value = targetOffset;
  targetValue.metadata.constant.value = targetOffset;
  return createSemanticIrFunction(raw);
}

function buildContext(target = buildIr(), options = {}) {
  const ir = target && target.nodes ? target : buildIr(target);
  const cfg = createSemanticCfg({ functionId: FUNCTION_ID, entryBlockId: BLOCK_ID, blocks: [{ id: BLOCK_ID, successors: [] }] });
  const snapshotId = options.snapshotId ?? 'snapshot-4777';
  const ssa = options.ssa ?? buildSemanticSsa(ir, cfg, { snapshotId });
  const semanticIrDigest = stableDigest(ir);
  const scalarSsaDigest = stableDigest(ssa);
  const identity = {
    binaryId: 'binary_4777',
    sliceId: 'slice_4777',
    functionId: FUNCTION_ID,
    snapshotId,
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
    snapshotId,
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

function metadataCompleteForgedScalarSsa() {
  const variableIdentity = { key: 'state:r0', kind: 'physical-state', scope: 'function' };
  const valueId = 'ssa-forged';
  return {
    uses: [{
      useId: 'ssa_use_forged',
      sourceEntityId: 'node_r0',
      valueId,
      blockId: BLOCK_ID,
      proof: {
        kind: 'renamed-use',
        sourceSemanticValueId: 'r0',
        sourceSemanticEntityId: 'node_r0',
        variableIdentity,
        transform: { ruleId: 'rename-use', proofKind: 'dominance-renaming' },
      },
    }],
    definitions: [{
      definitionId: `ssa_def_${stableDigest({ functionId: FUNCTION_ID, valueId })}`,
      valueId,
      blockId: BLOCK_ID,
      sourceEntityId: 'node_load',
      variableKey: 'state:r0',
      proof: {
        kind: 'renamed-definition',
        sourceSemanticValueId: 'loaded',
        sourceSemanticEntityId: 'node_load',
        variableIdentity,
        transform: { ruleId: 'rename-definition', proofKind: 'dominance-renaming' },
      },
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

test('metadata-complete forged scalar rows cannot mint reload authority (#4777)', () => {
  const { ir, memorySsa } = buildContext();
  const forgedRegion = regionFor(ir, metadataCompleteForgedScalarSsa(), memorySsa);
  assert.equal(forgedRegion?.kind, 'unknown',
    'builder-shaped public metadata must not substitute for canonical scalar-SSA producer authority');
});

test('a genuine scalar chain still refines reload regions (#4777)', () => {
  // #8809 sync: canonical fixture without the function-level state unknown so
  // the exact SP root precondition is meaningful; #5239's conservative
  // clobber is exercised unchanged by the forged-row test above.
  const { ir, ssa, memorySsa } = buildContext({ withUnknownCall: false });
  // The genuine SSA must still derive the sp-slot region for the slot store.
  const slotRegion = classifySemanticMemoryRegion(ir, 'node_store', {
    binaryId: 'binary_4777', ssa, canonicalMemorySsa: memorySsa,
  });
  assert.ok(slotRegion, 'the slot store must classify');
  assert.equal(slotRegion?.kind, 'rooted-offset',
    `the genuine sp-relative slot access must keep a precise rooted region: ${JSON.stringify(slotRegion)}`);
});

test('canonical scalar SSA remains required for a genuine pointer reload (#4777)', () => {
  const ir = connectedReloadIr();
  const { ssa, memorySsa } = buildContext(ir);
  const region = regionFor(ir, ssa, memorySsa);
  assert.equal(region?.kind, 'rooted-offset');
  assert.equal(region?.offset, '32');
});

test('canonical scalar SSA is bound to the exact Semantic IR content (#4777)', () => {
  const originalIr = connectedReloadIr({ targetOffset: '32' });
  const stale = buildContext(originalIr);
  const currentIr = connectedReloadIr({ targetOffset: '48' });
  const current = buildContext(currentIr);

  assert.equal(stableDigest(stale.ssa), stableDigest(current.ssa),
    'the scalar rows intentionally stay byte-identical so the IR binding is what rejects staleness');
  assert.equal(regionFor(currentIr, current.ssa, current.memorySsa)?.kind, 'rooted-offset');
  assert.equal(regionFor(currentIr, stale.ssa, current.memorySsa)?.kind, 'unknown',
    'SSA built from a different Semantic IR snapshot must not authorize reload refinement');
});

test('deriveMemoryRegion directly rejects metadata-complete forged scalar rows (#4777)', () => {
  const { ir, memorySsa } = buildContext();
  const targetNode = ir.nodes.find((node) => node.id === 'node_store2');
  const forgedRegion = deriveMemoryRegion({
    functionId: ir.functionId,
    binaryId: 'binary_4777',
    memory: targetNode.memory,
    origin: targetNode.origin,
    sourceEntityId: targetNode.id,
    addressValueId: targetNode.memory.addressValueId,
  }, null, {
    binaryId: 'binary_4777',
    canonicalMemorySsa: memorySsa,
    ssa: metadataCompleteForgedScalarSsa(),
  });
  assert.equal(forgedRegion?.kind, 'unknown',
    'deriveMemoryRegion must reject forged scalar rows directly without depending on wrapper options');
});

test('genuineRenamedUseRow and genuineRenamedDefinitionRow directly reject forged rows (#4777)', () => {
  const { ir, ssa } = buildContext();
  const forged = metadataCompleteForgedScalarSsa();
  const addressRead = ir.nodes.find((n) => n.id === 'node_r0');
  const blockIdByNode = new Map(ir.blocks.flatMap((b) => b.nodeIds.map((id) => [id, b.id])));
  const nodesById = new Map(ir.nodes.map((n) => [n.id, n]));
  const validBinding = { functionId: ir.functionId, semanticIrDigest: stableDigest(ir), snapshotId: 'snapshot-4777' };

  assert.equal(
    genuineRenamedUseRow(ir, forged.uses[0], addressRead, 'r0', blockIdByNode, { ssa, binding: validBinding }),
    false,
    'genuineRenamedUseRow must reject unbranded forged use row',
  );

  assert.equal(
    genuineRenamedDefinitionRow(ir, forged.definitions[0], forged.uses[0], addressRead, 'loaded', nodesById, { ssa, binding: validBinding }),
    false,
    'genuineRenamedDefinitionRow must reject unbranded forged definition row',
  );

  // Missing ssa or binding
  assert.equal(genuineRenamedUseRow(ir, forged.uses[0], addressRead, 'r0', blockIdByNode), false);
  assert.equal(genuineRenamedDefinitionRow(ir, forged.definitions[0], forged.uses[0], addressRead, 'loaded', nodesById), false);
});

test('genuineRenamedUseRow and genuineRenamedDefinitionRow accept genuine rows and reject mismatched bindings (#4777)', () => {
  const ir = connectedReloadIr();
  const { ssa } = buildContext(ir);
  const addressRead = ir.nodes.find((n) => n.id === 'node_r0');
  const blockIdByNode = new Map(ir.blocks.flatMap((b) => b.nodeIds.map((id) => [id, b.id])));
  const nodesById = new Map(ir.nodes.map((n) => [n.id, n]));
  const genuineUse = ssa.uses.find((u) => u.sourceEntityId === 'node_r0');
  const genuineDef = ssa.definitions.find((d) => d.variableKey === 'state:r0');
  const validBinding = { functionId: ir.functionId, semanticIrDigest: stableDigest(ir), snapshotId: 'snapshot-4777' };

  assert.ok(genuineUse, 'genuine use must exist');
  assert.ok(genuineDef, 'genuine definition must exist');

  // Genuine passes with valid binding
  assert.equal(
    genuineRenamedUseRow(ir, genuineUse, addressRead, 'r0', blockIdByNode, { ssa, binding: validBinding }),
    true,
    'genuineRenamedUseRow must accept genuine row with matching binding',
  );
  assert.equal(
    genuineRenamedDefinitionRow(ir, genuineDef, genuineUse, addressRead, genuineDef.proof.sourceSemanticValueId, nodesById, { ssa, binding: validBinding }),
    true,
    'genuineRenamedDefinitionRow must accept genuine row with matching binding',
  );

  // Mismatched snapshotId
  assert.equal(
    genuineRenamedUseRow(ir, genuineUse, addressRead, 'r0', blockIdByNode, {
      ssa, binding: { ...validBinding, snapshotId: 'mismatched-snapshot' },
    }),
    false,
    'genuineRenamedUseRow must reject mismatched snapshotId',
  );
  assert.equal(
    genuineRenamedDefinitionRow(ir, genuineDef, genuineUse, addressRead, genuineDef.proof.sourceSemanticValueId, nodesById, {
      ssa, binding: { ...validBinding, snapshotId: 'mismatched-snapshot' },
    }),
    false,
    'genuineRenamedDefinitionRow must reject mismatched snapshotId',
  );

  // Mismatched functionId
  assert.equal(
    genuineRenamedUseRow(ir, genuineUse, addressRead, 'r0', blockIdByNode, {
      ssa, binding: { ...validBinding, functionId: 'other-function' },
    }),
    false,
    'genuineRenamedUseRow must reject mismatched functionId',
  );

  // Mismatched semanticIrDigest
  assert.equal(
    genuineRenamedUseRow(ir, genuineUse, addressRead, 'r0', blockIdByNode, {
      ssa, binding: { ...validBinding, semanticIrDigest: 'digest-mismatch' },
    }),
    false,
    'genuineRenamedUseRow must reject mismatched semanticIrDigest',
  );
});

test('canonicalMemoryPointerRegionEvidence rejects forged rows and mismatched snapshot bindings (#4777)', () => {
  const { ir, ssa, memorySsa } = buildContext();
  const targetNode = ir.nodes.find((n) => n.id === 'node_store2');

  const forgedEvidence = canonicalMemoryPointerRegionEvidence(ir, targetNode, {
    canonicalMemorySsa: memorySsa,
    ssa: metadataCompleteForgedScalarSsa(),
  });
  assert.equal(forgedEvidence, null, 'forged scalar rows must yield null region evidence');

  // Mismatched snapshot binding
  const mismatchedMemorySsa = {
    ...memorySsa,
    snapshotId: 'other-snapshot',
    identity: { ...memorySsa.identity, snapshotId: 'other-snapshot' },
  };
  const mismatchedEvidence = canonicalMemoryPointerRegionEvidence(ir, targetNode, {
    canonicalMemorySsa: mismatchedMemorySsa,
    ssa,
  });
  assert.equal(mismatchedEvidence, null, 'mismatched snapshot must reject');
});

test('pointer reload is rejected when scalar SSA has a different snapshot binding (#4777)', () => {
  const ir = connectedReloadIr();
  const context = buildContext(ir);
  const cfg = createSemanticCfg({ functionId: FUNCTION_ID, entryBlockId: BLOCK_ID, blocks: [{ id: BLOCK_ID, successors: [] }] });
  const differentSnapshotSsa = buildSemanticSsa(ir, cfg, { snapshotId: 'different-snapshot' });
  const region = regionFor(ir, differentSnapshotSsa, context.memorySsa);
  assert.equal(region?.kind, 'unknown',
    'scalar SSA from a different snapshot must not authorize pointer reload refinement');
});

test('pointer reload is rejected when scalar SSA has a different function binding (#4777)', () => {
  const ir = connectedReloadIr();
  const context = buildContext(ir);
  const otherFunctionId = 'function_4777_other';
  const otherIr = { ...ir, functionId: otherFunctionId };
  const cfg = createSemanticCfg({ functionId: otherFunctionId, entryBlockId: BLOCK_ID, blocks: [{ id: BLOCK_ID, successors: [] }] });
  const differentFunctionSsa = buildSemanticSsa(otherIr, cfg, { snapshotId: 'snapshot-4777' });
  const region = regionFor(ir, differentFunctionSsa, context.memorySsa);
  assert.equal(region?.kind, 'unknown',
    'scalar SSA from a different function must not authorize pointer reload refinement');
});
