import assert from 'node:assert/strict';
import test from 'node:test';
import { stableDigest } from '../../js/core/identity/index.js';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import { validateSemanticIrFunction } from '../../js/semantics/ir/index.js';
import { createMemoryRegionRef } from '../../js/semantics/memoryssa/contract.js';
import {
  buildMemorySsa,
  MEMORY_SSA_BUILD_VERSION,
} from '../../js/semantics/memoryssa/build.js';
import { canonicalStoreValueProof } from '../../js/semantics/memoryssa/proof-core.js';
import {
  CANONICAL_MEMORY_FORWARDING_CONSUMER,
  CANONICAL_MEMORY_FORWARDING_PURPOSE,
  forwardMemoryValue,
} from '../../js/semantics/memoryssa/queries.js';

const origin = (id, address = 0x1000n) => ({
  instructionIds: [`ins_${id}`],
  virtualRanges: [{ start: address, end: address + 4n }],
});
const bit16 = { kind: 'bitvector', widthBits: 16 };
const bit32 = { kind: 'bitvector', widthBits: 32 };
const bit64 = { kind: 'bitvector', widthBits: 64 };
const addr64 = { kind: 'address', widthBits: 64, addressSpace: 'memory' };
const memory = (addressValueId, widthBits = 32) => ({
  addressSpace: 'memory',
  addressExpr: { valueId: addressValueId },
  widthBits,
  endian: 'little',
  alignment: Math.max(1, widthBits / 8),
  volatility: false,
  atomic: false,
  ordering: 'unknown',
  faults: [],
});

const unknownCall = (id, blockId) => ({
  id,
  kind: 'call',
  blockId,
  inputs: [],
  outputs: [],
  call: {
    targetValueIds: [],
    targetEntityIds: [],
    arguments: [],
    returns: [],
    stateReads: [],
    stateWrites: [],
    memoryRead: { scope: 'unknown' },
    memoryWrite: { scope: 'unknown' },
    controlEffects: [],
    determinism: 'unknown',
    noreturn: 'unknown',
    mayThrow: 'unknown',
    summarySource: 'fixture',
    completeness: 'unknown',
    unknownEffects: { reason: 'unresolved-call', categories: ['memory'] },
  },
  completeness: 'unknown',
  unknown: { reason: 'unresolved-call', categories: ['memory'] },
  origin: origin(id),
});

const spReadNode = (id, blockId, outputId = 'v_sp') => ({
  id,
  kind: 'state-read',
  blockId,
  inputs: [],
  outputs: [outputId],
  variable: {
    key: 'phys.sp',
    kind: 'physical-state',
    scope: 'function',
    physicalIdentity: { kind: 'register', registerId: 'sp' },
  },
  origin: origin(id),
});

const argWriteNode = (id, blockId, inputId, registerId = 'x0') => ({
  id,
  kind: 'state-write',
  blockId,
  inputs: [inputId],
  outputs: [],
  variable: {
    key: `phys.${registerId}`,
    kind: 'physical-state',
    scope: 'function',
    physicalIdentity: { kind: 'register', registerId },
  },
  origin: origin(id),
});

const const64Node = (id, blockId, outputId, value = 0n) => ({
  id,
  kind: 'const',
  blockId,
  operator: 'const',
  inputs: [],
  outputs: [outputId],
  attributes: { bitvectorValue: { kind: 'bitvector', widthBits: 64, value } },
  origin: origin(id),
});

test('1. diamond CFG stack escape in either branch emits call-clobber on stack region', () => {
  const runDiamond = (b1WritesSp, b2WritesSp, b0WritesSp = false) => {
    const fnId = 'fn_diamond_escape';
    const stackRegion = createMemoryRegionRef({
      id: 'reg_stack',
      kind: 'stack-fixed',
      functionId: fnId,
      offset: -8,
      widthBits: 32,
    });
    const b0Nodes = [
      spReadNode('n_sp', 'b0', 'v_sp'),
      const64Node('n_zero', 'b0', 'v_zero', 0n),
      ...(b0WritesSp ? [argWriteNode('n_w0', 'b0', 'v_sp', 'x0')] : []),
    ];
    const b1Nodes = [
      ...(b1WritesSp == null ? [] : [argWriteNode('n_w1', 'b1', b1WritesSp ? 'v_sp' : 'v_zero', 'x0')]),
    ];
    const b2Nodes = [
      ...(b2WritesSp == null ? [] : [argWriteNode('n_w2', 'b2', b2WritesSp ? 'v_sp' : 'v_zero', 'x0')]),
    ];
    const b3Nodes = [
      unknownCall('n_call', 'b3'),
      { id: 'n_load', kind: 'load', blockId: 'b3', inputs: ['v_sp'], outputs: ['v_ld'], memory: memory('v_sp', 32), origin: origin('n_load') },
    ];
    const ir = createSemanticIrFunction({
      functionId: fnId,
      entryBlockId: 'b0',
      blocks: [
        { id: 'b0', nodeIds: b0Nodes.map((n) => n.id), origin: origin('b0') },
        { id: 'b1', nodeIds: b1Nodes.map((n) => n.id), origin: origin('b1') },
        { id: 'b2', nodeIds: b2Nodes.map((n) => n.id), origin: origin('b2') },
        { id: 'b3', nodeIds: b3Nodes.map((n) => n.id), origin: origin('b3') },
      ],
      values: [
        { id: 'v_sp', kind: 'definition', definitionNodeId: 'n_sp', machineType: bit64, origin: origin('n_sp') },
        { id: 'v_zero', kind: 'definition', definitionNodeId: 'n_zero', machineType: bit64, origin: origin('n_zero') },
        { id: 'v_ld', kind: 'definition', definitionNodeId: 'n_load', machineType: bit32, origin: origin('n_load') },
      ],
      nodes: [...b0Nodes, ...b1Nodes, ...b2Nodes, ...b3Nodes],
      completeness: 'partial',
      unknowns: [{ reason: 'unresolved-call', categories: ['memory'] }],
      origin: origin('fn'),
    });
    const cfg = createSemanticCfg({
      functionId: fnId,
      entryBlockId: 'b0',
      blocks: [
        { id: 'b0', successors: [{ to: 'b1', kind: 'conditional-true' }, { to: 'b2', kind: 'conditional-false' }] },
        { id: 'b1', successors: [{ to: 'b3', kind: 'branch' }] },
        { id: 'b2', successors: [{ to: 'b3', kind: 'branch' }] },
        { id: 'b3', successors: [] },
      ],
    });
    const mssa = buildMemorySsa(ir, cfg, {
      regions: [stackRegion],
      resolveRegion: () => stackRegion,
      queryAlias: () => 'unknown',
    });
    return mssa.definitions.filter(
      (d) => d.sourceEntityId === 'n_call' && d.kind === 'call-clobber' && d.regionId === stackRegion.id,
    );
  };

  assert.equal(runDiamond(false, true).length, 1, 'b1=0, b2=sp must emit call-clobber on stack');
  assert.equal(runDiamond(true, false).length, 1, 'b1=sp, b2=0 must emit call-clobber on stack');
  assert.equal(runDiamond(false, null, true).length, 1, 'b0=sp flowing past untouched b2 must emit call-clobber');
  assert.equal(runDiamond(false, false, true).length, 0, 'both branches overwriting x0 with non-stack keeps noEscapeStack precision');
});

test('2. loop-carried stack address publication after call in CFG emits call-clobber', () => {
  const buildLoop = ({ backEdge }) => {
    const fnId = 'fn_loop_publish';
    const stackRegion = createMemoryRegionRef({
      id: 'reg_stack',
      kind: 'stack-fixed',
      functionId: fnId,
      offset: -8,
      widthBits: 32,
    });
    const globalRegion = createMemoryRegionRef({
      id: 'reg_global',
      kind: 'global-absolute',
      binaryId: 'bin_fixture',
      address: '0x5000',
      widthBits: 64,
    });
    const b0Nodes = [
      spReadNode('n_sp', 'b0', 'v_sp'),
    ];
    const b1Nodes = [
      unknownCall('n_call', 'b1'),
      { id: 'n_load', kind: 'load', blockId: 'b1', inputs: ['v_sp'], outputs: ['v_ld'], memory: memory('v_sp', 32), origin: origin('n_load') },
    ];
    const b2Nodes = [
      { id: 'n_pub', kind: 'store', blockId: 'b2', inputs: ['addr_global', 'v_sp'], outputs: [], memory: memory('addr_global', 64), origin: origin('n_pub') },
    ];
    const b3Nodes = [
      { id: 'n_ret', kind: 'return', blockId: 'b3', inputs: ['v_ld'], outputs: [], origin: origin('n_ret') },
    ];
    const ir = createSemanticIrFunction({
      functionId: fnId,
      entryBlockId: 'b0',
      blocks: [
        { id: 'b0', nodeIds: b0Nodes.map((n) => n.id), origin: origin('b0') },
        { id: 'b1', nodeIds: b1Nodes.map((n) => n.id), origin: origin('b1') },
        { id: 'b2', nodeIds: b2Nodes.map((n) => n.id), origin: origin('b2') },
        { id: 'b3', nodeIds: b3Nodes.map((n) => n.id), origin: origin('b3') },
      ],
      values: [
        { id: 'v_sp', kind: 'definition', definitionNodeId: 'n_sp', machineType: bit64, origin: origin('n_sp') },
        { id: 'v_ld', kind: 'definition', definitionNodeId: 'n_load', machineType: bit32, origin: origin('n_load') },
        { id: 'addr_global', kind: 'entry', machineType: addr64, origin: origin('addr_global') },
      ],
      nodes: [...b0Nodes, ...b1Nodes, ...b2Nodes, ...b3Nodes],
      completeness: 'partial',
      unknowns: [{ reason: 'unresolved-call', categories: ['memory'] }],
      origin: origin('fn'),
    });
    const cfg = createSemanticCfg({
      functionId: fnId,
      entryBlockId: 'b0',
      blocks: [
        { id: 'b0', successors: [{ to: 'b1', kind: 'branch' }] },
        { id: 'b1', successors: [{ to: 'b2', kind: 'conditional-true' }, { to: 'b3', kind: 'conditional-false' }] },
        { id: 'b2', successors: [{ to: backEdge ? 'b1' : 'b3', kind: 'branch' }] },
        { id: 'b3', successors: [] },
      ],
    });
    const mssa = buildMemorySsa(ir, cfg, {
      regions: [stackRegion, globalRegion],
      resolveRegion: (mem) => (String(mem?.addressExpr?.valueId) === 'addr_global' ? globalRegion : stackRegion),
      queryAlias: () => 'unknown',
    });
    return mssa.definitions.filter(
      (d) => d.sourceEntityId === 'n_call' && d.kind === 'call-clobber' && d.regionId === stackRegion.id,
    );
  };

  assert.equal(buildLoop({ backEdge: true }).length, 1, 'loop back-edge from stack-publishing block must emit call-clobber');
  assert.equal(buildLoop({ backEdge: false }).length, 0, 'post-call publication without loop back-edge must keep noEscapeStack precision');
});

test('3. canonicalStoreValueProof and forwardMemoryValue accept sext(-1:i16 -> i32)', () => {
  const fnId = 'fn_sext_neg_const';
  const identity = {
    binaryId: 'bin_fixture',
    sliceId: 'slice_fixture',
    functionId: fnId,
    semanticIrId: 'ir_sext',
    scalarSsaId: 'ssa_sext',
    memorySsaId: 'mssa_sext',
    snapshotId: 'snap_sext',
    semanticIrContractVersion: '2.0.0',
    scalarSsaBuildVersion: '1.0.0',
    scalarSsaDigest: 'ssa_sext_digest',
    memorySsaBuildVersion: MEMORY_SSA_BUILD_VERSION,
    analyzerVersion: 'memoryssa-fixture',
  };

  const narrowUnsigned = {
    id: 'v_narrow_u16',
    kind: 'definition',
    definitionNodeId: 'n_const16',
    sourceEntityId: 'n_const16',
    machineType: bit16,
    metadata: { constant: { kind: 'bitvector', widthBits: 16, value: '65535' } },
    origin: origin('n_const16', 0x2004n),
  };
  const narrowSigned = {
    ...narrowUnsigned,
    id: 'v_narrow_s16',
    metadata: { constant: { kind: 'bitvector', widthBits: 16, value: '-1' } },
  };
  const wideValue = {
    id: 'v_sext_i32',
    kind: 'definition',
    definitionNodeId: 'n_sext',
    sourceEntityId: 'n_sext',
    machineType: bit32,
    origin: origin('n_sext', 0x2008n),
  };

  const proofFromUnsigned = canonicalStoreValueProof({
    semanticValue: wideValue,
    memorySsaEntityId: 'memdef_sext_u16',
    valueId: wideValue.id,
    sourceEntityId: 'n_store',
    value: 0xffffffffn,
    widthBits: 32,
    identity,
    functionId: fnId,
    resolvedSemanticValue: narrowUnsigned,
    resolvedValueId: narrowUnsigned.id,
    scalarSsaDigest: identity.scalarSsaDigest,
  });
  assert.ok(proofFromUnsigned, 'sext(65535:i16 -> 0xffffffff:i32) proof must be accepted');
  assert.equal(proofFromUnsigned.value, '4294967295');

  const proofFromSigned = canonicalStoreValueProof({
    semanticValue: wideValue,
    memorySsaEntityId: 'memdef_sext_s16',
    valueId: wideValue.id,
    sourceEntityId: 'n_store',
    value: 0xffffffffn,
    widthBits: 32,
    identity,
    functionId: fnId,
    resolvedSemanticValue: narrowSigned,
    resolvedValueId: narrowSigned.id,
    scalarSsaDigest: identity.scalarSsaDigest,
  });
  assert.ok(proofFromSigned, 'sext(-1:i16 -> 0xffffffff:i32) proof must be accepted');
  assert.equal(proofFromSigned.value, '4294967295');

  const bogusProof = canonicalStoreValueProof({
    semanticValue: wideValue,
    memorySsaEntityId: 'memdef_sext_bogus',
    valueId: wideValue.id,
    sourceEntityId: 'n_store',
    value: 0x12345678n,
    widthBits: 32,
    identity,
    functionId: fnId,
    resolvedSemanticValue: narrowUnsigned,
    resolvedValueId: narrowUnsigned.id,
    scalarSsaDigest: identity.scalarSsaDigest,
  });
  assert.equal(bogusProof, null, 'unrelated 32-bit value for narrow 16-bit constant must still be rejected');

  // End-to-end MemorySSA build + forwardMemoryValue verification
  const nodes = [
    { id: 'n_addr', kind: 'address', blockId: 'b0', inputs: [], outputs: ['addr'], attributes: { value: '0x4000' }, origin: origin('n_addr', 0x2000n) },
    { id: 'n_const16', kind: 'const', blockId: 'b0', inputs: [], outputs: ['v_narrow_u16'], attributes: { value: 65535 }, origin: origin('n_const16', 0x2004n) },
    { id: 'n_sext', kind: 'sext', blockId: 'b0', inputs: ['v_narrow_u16'], outputs: ['v_sext_i32'], attributes: { fromBits: 16, toBits: 32 }, origin: origin('n_sext', 0x2008n) },
    { id: 'n_store', kind: 'store', blockId: 'b0', inputs: ['addr', 'v_sext_i32'], outputs: [], memory: memory('addr', 32), attributes: { machineEffects: { operationMetadata: { addressing: { addressDisplacement: '0' } } } }, origin: origin('n_store', 0x200cn) },
    { id: 'n_load', kind: 'load', blockId: 'b0', inputs: ['addr'], outputs: ['v_loaded'], memory: memory('addr', 32), attributes: { machineEffects: { operationMetadata: { addressing: { addressDisplacement: '0' } } } }, origin: origin('n_load', 0x2010n) },
    { id: 'n_ret', kind: 'return', blockId: 'b0', inputs: ['v_loaded'], outputs: [], origin: origin('n_ret', 0x2014n) },
  ];
  const ir = validateSemanticIrFunction({
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId: fnId,
    entryBlockId: 'b0',
    blocks: [{ id: 'b0', nodeIds: nodes.map((n) => n.id), origin: origin('b0', 0x2000n) }],
    values: [
      { id: 'addr', kind: 'definition', definitionNodeId: 'n_addr', sourceEntityId: 'n_addr', machineType: addr64, origin: origin('n_addr', 0x2000n) },
      narrowUnsigned,
      wideValue,
      { id: 'v_loaded', kind: 'definition', definitionNodeId: 'n_load', sourceEntityId: 'n_load', machineType: bit32, origin: origin('n_load', 0x2010n) },
    ],
    nodes,
    completeness: 'complete',
    unknowns: [],
    origin: origin('fn', 0x2000n),
  });
  const cfg = createSemanticCfg({
    functionId: fnId,
    entryBlockId: 'b0',
    blocks: [{ id: 'b0', successors: [] }],
  });
  const region = createMemoryRegionRef({
    id: 'r_global_sext',
    kind: 'global-absolute',
    binaryId: 'bin_fixture',
    address: '0x4000',
    widthBits: 32,
    origin: origin('region', 0x4000n),
  });
  const fullIdentity = { ...identity, semanticIrDigest: stableDigest(ir) };
  const mssa = buildMemorySsa(ir, cfg, {
    regions: [region],
    resolveRegion: () => region,
    queryAlias: () => ({
      relation: 'must',
      reasonCodes: ['identical-region-identity'],
      evidenceIds: ['canonical-fixture-alias'],
      proof: {
        analyzerId: 'phase7.alias.solver',
        analyzerVersion: '1.1.1',
        completeness: 'complete',
        stopReason: null,
      },
    }),
    identity: fullIdentity,
    snapshotId: 'snap_sext',
    canonicalIrIdentity: {
      functionId: fnId,
      semanticIrId: 'ir_sext',
      semanticIrContractVersion: '2.0.0',
      semanticIrDigest: stableDigest(ir),
    },
  });
  const loadUse = mssa.uses.find((u) => u.sourceEntityId === 'n_load');
  assert.ok(loadUse, 'load use must exist');
  const forwarded = forwardMemoryValue(mssa, loadUse.id, {
    functionId: fnId,
    ir,
    consumerId: CANONICAL_MEMORY_FORWARDING_CONSUMER,
    purpose: CANONICAL_MEMORY_FORWARDING_PURPOSE,
  });
  assert.equal(forwarded.status, 'exact', 'sext(-1:i16 -> i32) store must forward cleanly');
  assert.equal(forwarded.value, 0xffffffffn);
});

test('4. conservativeWriteRegionIds treats unknown-memory-effect on noEscapeStack call consistently', () => {
  const fnId = 'fn_noescape_unknown_effect';
  const stackRegion = createMemoryRegionRef({
    id: 'reg_stack',
    kind: 'stack-fixed',
    functionId: fnId,
    offset: -8,
    widthBits: 32,
  });
  const nodes = [
    { id: 'n_addr', kind: 'address', blockId: 'b0', inputs: [], outputs: ['v_slot'], attributes: { value: '0x100' }, origin: origin('n_addr', 0x3000n) },
    { id: 'n_const', kind: 'const', blockId: 'b0', inputs: [], outputs: ['v_c'], attributes: { value: 42 }, origin: origin('n_const', 0x3004n) },
    { id: 'n_store', kind: 'store', blockId: 'b0', inputs: ['v_slot', 'v_c'], outputs: [], memory: memory('v_slot', 32), origin: origin('n_store', 0x3008n) },
    unknownCall('n_call', 'b0'),
    { id: 'n_load', kind: 'load', blockId: 'b0', inputs: ['v_slot'], outputs: ['v_ld'], memory: memory('v_slot', 32), origin: origin('n_load', 0x3010n) },
  ];
  const ir = createSemanticIrFunction({
    functionId: fnId,
    entryBlockId: 'b0',
    blocks: [{ id: 'b0', nodeIds: nodes.map((n) => n.id), origin: origin('b0', 0x3000n) }],
    values: [
      { id: 'v_slot', kind: 'definition', definitionNodeId: 'n_addr', machineType: addr64, origin: origin('n_addr', 0x3000n) },
      { id: 'v_c', kind: 'definition', definitionNodeId: 'n_const', machineType: bit32, metadata: { constant: { kind: 'bitvector', widthBits: 32, value: 42n } }, origin: origin('n_const', 0x3004n) },
      { id: 'v_ld', kind: 'definition', definitionNodeId: 'n_load', machineType: bit32, origin: origin('n_load', 0x3010n) },
    ],
    nodes,
    completeness: 'partial',
    unknowns: [{ reason: 'unresolved-call', categories: ['memory'] }],
    origin: origin('fn', 0x3000n),
  });
  const cfg = createSemanticCfg({
    functionId: fnId,
    entryBlockId: 'b0',
    blocks: [{ id: 'b0', successors: [] }],
  });
  const mssa = buildMemorySsa(ir, cfg, {
    regions: [stackRegion],
    resolveRegion: () => stackRegion,
    queryAlias: (left, right) => (left.id === right.id ? 'must' : 'unknown'),
  });
  const loadUse = mssa.uses.find((u) => u.sourceEntityId === 'n_load');
  const coverage = mssa.byteCoverage.find((c) => c.useId === loadUse.id);
  assert.ok(coverage, 'byteCoverage entry must exist for stack load');
  const unknownRegionAlias = coverage.regionAliasStates.find((r) => r.regionId !== stackRegion.id);
  assert.ok(unknownRegionAlias, 'unknown fallback region alias entry must exist');
  assert.equal(unknownRegionAlias.aliasRelation, 'no', 'noEscapeStack call must not keep unknown fallback region in conservativeWriteRegionIds');
  assert.equal(unknownRegionAlias.aliasProof?.kind, 'canonical-memory-stack-no-escape');
});
