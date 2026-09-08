// Regression for #5729: a `root-only` canonical address proof (same root,
// offset NOT proven) must never become an exact offset-0 rooted-offset /
// stack-fixed region for a pointer reloaded through a stack slot. Exact-offset
// proofs keep refining.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import { buildSemanticSsa } from '../../js/semantics/ssa/build.js';
import { buildMemorySsa } from '../../js/semantics/memoryssa/build.js';
import { deriveCanonicalAddressProof } from '../../js/analysis/alias/index-v2.js';
import { classifySemanticMemoryRegion } from '../../js/analysis/alias/regions-v2.js';
import { createPhase7AliasSolver } from '../../js/analysis/alias/solver.js';
import { stableDigest } from '../../js/core/identity/index.js';

const origin = (id) => ({ instructionIds: [`instruction_${id}`] });
const addressType = { kind: 'address', widthBits: 64, addressSpace: 'memory' };
const bitvector64 = { kind: 'bitvector', widthBits: 64 };
const memory = (addressValueId) => ({
  addressSpace: 'memory', addressValueId, widthBits: 64,
  endian: 'little', volatility: false, atomic: false,
});

function buildFixture({ armBOffset }) {
  // armBOffset == null models a single-arm (exact) pointer proof.
  const nodes = [
    { id: 'node_base', kind: 'state-read', blockId: 'b0', inputs: [], outputs: ['base'], variable: { key: 'state:sp', kind: 'physical-state', scope: 'function' }, origin: origin('node_base') },
    { id: 'node_off8', kind: 'const', blockId: 'b0', inputs: [], outputs: ['off8'], attributes: { constant: { value: '8', widthBits: 64 } }, origin: origin('node_off8') },
  ];
  const values = [
    { id: 'base', kind: 'definition', machineType: addressType, definitionNodeId: 'node_base', origin: origin('base') },
    { id: 'off8', kind: 'definition', machineType: bitvector64, definitionNodeId: 'node_off8', origin: origin('off8') },
  ];
  const blocks = [{ id: 'b0', nodeIds: ['node_base', 'node_off8'], origin: origin('b0') }];
  let offsetCounter = 0;
  const addArm = (blockId, offsetValue) => {
    offsetCounter++;
    const constId = `off_${blockId}`;
    const addId = `add_${blockId}`;
    const swId = `sw_${blockId}`;
    nodes.push(
      { id: `node_${constId}`, kind: 'const', blockId, inputs: [], outputs: [constId], attributes: { constant: { value: offsetValue, widthBits: 64 } }, origin: origin(`node_${constId}`) },
      { id: `node_${addId}`, kind: 'binary', blockId, inputs: ['base', constId], outputs: [addId], operator: 'add', origin: origin(`node_${addId}`) },
      { id: `node_${swId}`, kind: 'state-write', blockId, inputs: [addId], outputs: [], variable: { key: 'state:pv', kind: 'physical-state', scope: 'function' }, origin: origin(`node_${swId}`) },
    );
    values.push(
      { id: constId, kind: 'definition', machineType: bitvector64, definitionNodeId: `node_${constId}`, origin: origin(constId) },
      { id: addId, kind: 'definition', machineType: addressType, definitionNodeId: `node_${addId}`, origin: origin(addId) },
    );
    return blockId;
  };
  addArm('b1', '8');
  if (armBOffset != null) addArm('b2', armBOffset);
  nodes.push(
    { id: 'node_pread', kind: 'state-read', blockId: 'b3', inputs: [], outputs: ['pvread'], variable: { key: 'state:pv', kind: 'physical-state', scope: 'function' }, origin: origin('node_pread') },
    { id: 'node_slot_store', kind: 'store', blockId: 'b3', inputs: ['base', 'pvread'], outputs: [], memory: memory('base'), origin: origin('node_slot_store') },
    { id: 'node_slot_load', kind: 'load', blockId: 'b3', inputs: ['base'], outputs: ['loaded1'], memory: memory('base'), origin: origin('node_slot_load') },
    { id: 'node_tmp_sw', kind: 'state-write', blockId: 'b3', inputs: ['loaded1'], outputs: [], variable: { key: 'state:tmp', kind: 'physical-state', scope: 'function' }, origin: origin('node_tmp_sw') },
    { id: 'node_tmp_read', kind: 'state-read', blockId: 'b3', inputs: [], outputs: ['tmpread'], variable: { key: 'state:tmp', kind: 'physical-state', scope: 'function' }, origin: origin('node_tmp_read') },
    { id: 'node_outer_off', kind: 'const', blockId: 'b3', inputs: [], outputs: ['outer_off'], attributes: { constant: { value: '4', widthBits: 64 } }, origin: origin('node_outer_off') },
    { id: 'node_outer_addr', kind: 'binary', blockId: 'b3', inputs: ['tmpread', 'outer_off'], outputs: ['outer_addr'], operator: 'add', origin: origin('node_outer_addr') },
    { id: 'node_outer_load', kind: 'load', blockId: 'b3', inputs: ['outer_addr'], outputs: ['loaded2'], memory: memory('outer_addr'), origin: origin('node_outer_load') },
  );
  values.push(
    { id: 'pvread', kind: 'definition', machineType: addressType, definitionNodeId: 'node_pread', origin: origin('pvread') },
    { id: 'loaded1', kind: 'definition', machineType: addressType, definitionNodeId: 'node_slot_load', origin: origin('loaded1') },
    { id: 'tmpread', kind: 'definition', machineType: addressType, definitionNodeId: 'node_tmp_read', origin: origin('tmpread') },
    { id: 'outer_off', kind: 'definition', machineType: bitvector64, definitionNodeId: 'node_outer_off', metadata: { constant: { kind: 'bitvector', value: '4', widthBits: 64 } }, origin: origin('outer_off') },
    { id: 'outer_addr', kind: 'definition', machineType: addressType, definitionNodeId: 'node_outer_addr', origin: origin('outer_addr') },
    { id: 'loaded2', kind: 'definition', machineType: addressType, definitionNodeId: 'node_outer_load', origin: origin('loaded2') },
  );
  blocks.push(
    { id: 'b1', nodeIds: nodes.filter((n) => n.blockId === 'b1').map((n) => n.id), origin: origin('b1') },
    { id: 'b3', nodeIds: nodes.filter((n) => n.blockId === 'b3').map((n) => n.id), origin: origin('b3') },
  );
  if (armBOffset != null) blocks.push({ id: 'b2', nodeIds: nodes.filter((n) => n.blockId === 'b2').map((n) => n.id), origin: origin('b2') });
  const order = ['b0', 'b1'];
  if (armBOffset != null) order.push('b2');
  order.push('b3');
  blocks.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

  const ir = createSemanticIrFunction({
    functionId: `fn_5729_${armBOffset == null ? 'exact' : 'rootonly'}`,
    entryBlockId: 'b0',
    blocks: blocks.map((block) => ({ ...block, nodeIds: block.nodeIds })),
    values, nodes, completeness: 'complete', origin: origin(irOriginName(armBOffset)),
  });
  const cfg = createSemanticCfg({
    functionId: ir.functionId,
    entryBlockId: 'b0',
    blocks: armBOffset == null
      ? [
          { id: 'b0', successors: [{ to: 'b1', kind: 'fallthrough' }] },
          { id: 'b1', successors: [{ to: 'b3', kind: 'fallthrough' }] },
          { id: 'b3', successors: [] },
        ]
      : [
          { id: 'b0', successors: [{ to: 'b1', kind: 'conditional-true' }, { to: 'b2', kind: 'conditional-false' }] },
          { id: 'b1', successors: [{ to: 'b3', kind: 'fallthrough' }] },
          { id: 'b2', successors: [{ to: 'b3', kind: 'fallthrough' }] },
          { id: 'b3', successors: [] },
        ],
  });
  const ssa = buildSemanticSsa(ir, cfg);
  const solver = createPhase7AliasSolver({ ir, cfg, ssa, options: { snapshotId: 'snapshot_5729' } });
  const semanticIrDigest = stableDigest(ir);
  const memorySsa = buildMemorySsa(ir, cfg, {
    resolveRegion: (mem, context) => classifySemanticMemoryRegion(ir, context.node, { binaryId: 'binary_5729', ssa }),
    queryAlias: solver.queryAlias,
    identity: {
      binaryId: 'binary_5729', sliceId: 'slice_5729', functionId: ir.functionId, snapshotId: 'snapshot_5729',
      semanticIrId: `ir-${semanticIrDigest}`, semanticIrContractVersion: ir.contractVersion, semanticIrDigest,
      scalarSsaId: `ssa-${stableDigest(ssa)}`, scalarSsaBuildVersion: '1.0.0', scalarSsaDigest: stableDigest(ssa),
      memorySsaId: 'mssa_5729', memorySsaBuildVersion: '1.0.0', analyzerVersion: 'memoryssa-fixture',
    },
    snapshotId: 'snapshot_5729',
    canonicalIrIdentity: { functionId: ir.functionId, semanticIrId: `ir-${semanticIrDigest}`, semanticIrContractVersion: ir.contractVersion, semanticIrDigest },
  });
  return { ir, cfg, ssa, memorySsa };
}

function irOriginName(armBOffset) {
  return armBOffset == null ? 'fn_5729_exact' : 'fn_5729_rootonly';
}

function outerLoadRegion(fixture, options = {}) {
  const outerLoad = fixture.ir.nodes.find((node) => node.id === 'node_outer_load');
  const region = classifySemanticMemoryRegion(fixture.ir, outerLoad, {
    binaryId: 'binary_5729',
    ssa: fixture.ssa,
    canonicalMemorySsa: fixture.memorySsa,
    ...options,
  });
  return Array.isArray(region) ? region[0] : region;
}

const stackOptions = {
  rootDescriptors: {
    'state:sp': { kind: 'stack-like', baseOffset: 0, linearOffsets: true },
  },
};

test('#5729 exact rooted proofs preserve reload refinement and displacement', () => {
  const fixture = buildFixture({ armBOffset: null });
  const region = outerLoadRegion(fixture);
  assert.equal(region.kind, 'rooted-offset');
  assert.equal(region.offset, '12', 'proven root+8 plus outer +4 must stay exact');
});

test('#5729 exact stack-like proofs preserve reload refinement and displacement', () => {
  const fixture = buildFixture({ armBOffset: null });
  const region = outerLoadRegion(fixture, stackOptions);
  assert.equal(region.kind, 'stack-fixed');
  assert.equal(region.offset, '12', 'proven stack +8 plus outer +4 must stay exact');
});

test('#5729 root-only rooted proof stays unknown with nonzero outer displacement', () => {
  const fixture = buildFixture({ armBOffset: '16' });
  const proof = deriveCanonicalAddressProof(fixture.ir, 'pvread', { ssa: fixture.ssa });
  assert.equal(proof.kind, 'root-only');
  assert.equal(proof.rootKind, 'rooted');
  const region = outerLoadRegion(fixture);
  assert.ok(region, 'classification must still produce a region object');
  assert.equal(region.kind, 'unknown');
});

test('#5729 root-only stack-like proof stays unknown with nonzero outer displacement', () => {
  const fixture = buildFixture({ armBOffset: '16' });
  const proof = deriveCanonicalAddressProof(fixture.ir, 'pvread', { ssa: fixture.ssa, ...stackOptions });
  assert.equal(proof.kind, 'root-only');
  assert.equal(proof.rootKind, 'stack-like');
  const region = outerLoadRegion(fixture, stackOptions);
  assert.ok(region, 'classification must produce a region object');
  assert.equal(region.kind, 'unknown');
});
