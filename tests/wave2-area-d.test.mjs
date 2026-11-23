import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeSemanticDominance, createSemanticCfg } from '../js/semantics/cfg/index.js';
import { createBitVectorValue, createMachineEffectBundle, createMachineOperation, createMachineValue, createTemporaryValue } from '../js/semantics/effects/index.js';
import { createSemanticIrFunction } from '../js/semantics/ir/function.js';
import { lowerMachineEffectBundleToSemanticIr } from '../js/semantics/ir/from-machine-effects.js';
import { createSemanticNode } from '../js/semantics/ir/nodes.js';
import { classifyMachineValueOpcode } from '../js/semantics/ir/normalize-effects.js';
import { createSemanticCallSummary } from '../js/semantics/ir/types.js';
import { stableDigest } from '../js/core/identity/index.js';
import { buildMemorySsa, MEMORY_SSA_BUILD_VERSION } from '../js/semantics/memoryssa/build.js';
import {
  CANONICAL_MEMORY_FORWARDING_CONSUMER,
  CANONICAL_MEMORY_FORWARDING_PURPOSE,
  forwardMemoryValue,
} from '../js/semantics/memoryssa/queries.js';

const origin = (id) => ({ instructionIds: [`inst_${id}`] });
const bv32 = { kind: 'bitvector', widthBits: 32 };
const bv64 = { kind: 'bitvector', widthBits: 64 };
const addr64 = { kind: 'address', widthBits: 64, addressSpace: 'memory' };
const mem32 = (addressValueId) => ({
  addressSpace: 'memory',
  addressValueId,
  widthBits: 32,
  endian: 'little',
  volatility: false,
  atomic: false,
  ordering: 'unknown',
});

const stackRegion = {
  id: 'region_local_stack',
  kind: 'stack-fixed',
  functionId: 'fn_wave2_d',
  offset: -8,
  widthBits: 32,
};

const unknownCall = (id, blockId = 'entry', inputs = [], argumentsList = []) => ({
  id,
  kind: 'call',
  blockId,
  inputs,
  outputs: [],
  call: {
    targetValueIds: [],
    targetEntityIds: [],
    arguments: argumentsList,
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

function buildStackMssa(nodes, values, blocks = null) {
  const ir = createSemanticIrFunction({
    functionId: 'fn_wave2_d',
    entryBlockId: 'entry',
    blocks: blocks ?? [{ id: 'entry', nodeIds: nodes.map((n) => n.id), origin: origin('entry') }],
    values,
    nodes,
    completeness: 'partial',
    unknowns: [{ reason: 'unresolved-call', categories: ['memory'] }],
    origin: origin('fn'),
  });
  const cfg = createSemanticCfg({
    functionId: 'fn_wave2_d',
    entryBlockId: 'entry',
    blocks: (blocks ?? [{ id: 'entry' }]).map((b) => ({ id: b.id, successors: b.successors ?? [] })),
  });
  return buildMemorySsa(ir, cfg, {
    resolveRegion: () => stackRegion,
    queryAlias: () => 'unknown',
  });
}

// ============================================================================
// 1. [P0] noEscapeStack soundness fixes
// ============================================================================

test('1a. state-write -> state-read via non-SP/FP register propagates stack escape', () => {
  const nodes = [
    {
      id: 'read_sp', kind: 'state-read', blockId: 'entry', inputs: [], outputs: ['v_sp'],
      variable: { key: 'phys.sp', kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId: 'sp' } },
      origin: origin('read_sp'),
    },
    {
      id: 'c8', kind: 'const', blockId: 'entry', operator: 'const', inputs: [], outputs: ['v_c8'],
      attributes: { bitvectorValue: { kind: 'bitvector', widthBits: 64, value: 8n } }, origin: origin('c8'),
    },
    { id: 'sub_local', kind: 'binary', blockId: 'entry', operator: 'sub', inputs: ['v_sp', 'v_c8'], outputs: ['v_local'], origin: origin('sub_local') },
    {
      id: 'sw_rax', kind: 'state-write', blockId: 'entry', inputs: ['v_local'], outputs: [],
      variable: { key: 'phys.rax', kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId: 'rax' } },
      origin: origin('sw_rax'),
    },
    {
      id: 'sr_rax', kind: 'state-read', blockId: 'entry', inputs: [], outputs: ['v_rax'],
      variable: { key: 'phys.rax', kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId: 'rax' } },
      origin: origin('sr_rax'),
    },
    {
      id: 'sw_rdi', kind: 'state-write', blockId: 'entry', inputs: ['v_rax'], outputs: [],
      variable: { key: 'phys.rdi', kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId: 'rdi' } },
      origin: origin('sw_rdi'),
    },
    unknownCall('call_1'),
    { id: 'ld', kind: 'load', blockId: 'entry', inputs: [], outputs: ['v_ld'], memory: mem32('v_local'), origin: origin('ld') },
  ];
  const values = [
    { id: 'v_sp', kind: 'definition', definitionNodeId: 'read_sp', machineType: bv64, origin: origin('read_sp') },
    { id: 'v_c8', kind: 'definition', definitionNodeId: 'c8', machineType: bv64, origin: origin('c8') },
    { id: 'v_local', kind: 'definition', definitionNodeId: 'sub_local', machineType: bv64, origin: origin('sub_local') },
    { id: 'v_rax', kind: 'definition', definitionNodeId: 'sr_rax', machineType: bv64, origin: origin('sr_rax') },
    { id: 'v_ld', kind: 'definition', definitionNodeId: 'ld', machineType: bv32, origin: origin('ld') },
  ];
  const mssa = buildStackMssa(nodes, values);
  const clobbers = mssa.definitions.filter((d) => d.sourceEntityId === 'call_1' && d.kind === 'call-clobber' && d.regionId === stackRegion.id);
  assert.equal(clobbers.length, 1, 'state-write -> state-read via rax must block noEscapeStack');
});

test('1b. FP/SIMD register write (d0/v0/xmm0) does not kill integer argument register (x0/rdi)', () => {
  const nodes = [
    {
      id: 'read_sp', kind: 'state-read', blockId: 'entry', inputs: [], outputs: ['v_sp'],
      variable: { key: 'phys.sp', kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId: 'sp' } },
      origin: origin('read_sp'),
    },
    {
      id: 'c0', kind: 'const', blockId: 'entry', operator: 'const', inputs: [], outputs: ['v_zero'],
      attributes: { bitvectorValue: { kind: 'bitvector', widthBits: 64, value: 0n } }, origin: origin('c0'),
    },
    {
      id: 'sw_x0', kind: 'state-write', blockId: 'entry', inputs: ['v_sp'], outputs: [],
      variable: { key: 'phys.x0', kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId: 'x0' } },
      origin: origin('sw_x0'),
    },
    {
      id: 'sw_d0', kind: 'state-write', blockId: 'entry', inputs: ['v_zero'], outputs: [],
      variable: { key: 'phys.d0', kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId: 'd0' } },
      origin: origin('sw_d0'),
    },
    unknownCall('call_1'),
    { id: 'ld', kind: 'load', blockId: 'entry', inputs: [], outputs: ['v_ld'], memory: mem32('v_sp'), origin: origin('ld') },
  ];
  const values = [
    { id: 'v_sp', kind: 'definition', definitionNodeId: 'read_sp', machineType: bv64, origin: origin('read_sp') },
    { id: 'v_zero', kind: 'definition', definitionNodeId: 'c0', machineType: bv64, origin: origin('c0') },
    { id: 'v_ld', kind: 'definition', definitionNodeId: 'ld', machineType: bv32, origin: origin('ld') },
  ];
  const mssa = buildStackMssa(nodes, values);
  const clobbers = mssa.definitions.filter((d) => d.sourceEntityId === 'call_1' && d.kind === 'call-clobber' && d.regionId === stackRegion.id);
  assert.equal(clobbers.length, 1, 'd0 write must not kill x0 stack-derived argument');
});

test('1c. storing &local to outgoing stack argument [sp + 8] blocks noEscapeStack', () => {
  const nodes = [
    {
      id: 'read_sp', kind: 'state-read', blockId: 'entry', inputs: [], outputs: ['v_sp'],
      variable: { key: 'phys.sp', kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId: 'sp' } },
      origin: origin('read_sp'),
    },
    {
      id: 'c8', kind: 'const', blockId: 'entry', operator: 'const', inputs: [], outputs: ['v_c8'],
      attributes: { bitvectorValue: { kind: 'bitvector', widthBits: 64, value: 8n } }, origin: origin('c8'),
    },
    { id: 'sub_local', kind: 'binary', blockId: 'entry', operator: 'sub', inputs: ['v_sp', 'v_c8'], outputs: ['v_local'], origin: origin('sub_local') },
    { id: 'add_arg', kind: 'binary', blockId: 'entry', operator: 'add', inputs: ['v_sp', 'v_c8'], outputs: ['v_stack_arg'], origin: origin('add_arg') },
    { id: 'st_arg', kind: 'store', blockId: 'entry', inputs: ['v_stack_arg', 'v_local'], outputs: [], memory: mem32('v_stack_arg'), origin: origin('st_arg') },
    unknownCall('call_1'),
    { id: 'ld', kind: 'load', blockId: 'entry', inputs: [], outputs: ['v_ld'], memory: mem32('v_local'), origin: origin('ld') },
  ];
  const values = [
    { id: 'v_sp', kind: 'definition', definitionNodeId: 'read_sp', machineType: bv64, origin: origin('read_sp') },
    { id: 'v_c8', kind: 'definition', definitionNodeId: 'c8', machineType: bv64, origin: origin('c8') },
    { id: 'v_local', kind: 'definition', definitionNodeId: 'sub_local', machineType: bv64, origin: origin('sub_local') },
    { id: 'v_stack_arg', kind: 'definition', definitionNodeId: 'add_arg', machineType: bv64, origin: origin('add_arg') },
    { id: 'v_ld', kind: 'definition', definitionNodeId: 'ld', machineType: bv32, origin: origin('ld') },
  ];
  const mssa = buildStackMssa(nodes, values);
  const clobbers = mssa.definitions.filter((d) => d.sourceEntityId === 'call_1' && d.kind === 'call-clobber' && d.regionId === stackRegion.id);
  assert.equal(clobbers.length, 1, 'storing &local to outgoing stack argument [sp+8] must block noEscapeStack');
});

test('1d. STACK_POINTER_REGISTER_IDS recognizes esp and ebp', () => {
  for (const regId of ['esp', 'ebp']) {
    const nodes = [
      {
        id: 'read_sp', kind: 'state-read', blockId: 'entry', inputs: [], outputs: ['v_sp'],
        variable: { key: `phys.${regId}`, kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId: regId } },
        origin: origin('read_sp'),
      },
      unknownCall('call_1', 'entry', ['v_sp'], ['v_sp']),
      { id: 'ld', kind: 'load', blockId: 'entry', inputs: [], outputs: ['v_ld'], memory: mem32('v_sp'), origin: origin('ld') },
    ];
    const values = [
      { id: 'v_sp', kind: 'definition', definitionNodeId: 'read_sp', machineType: bv32, origin: origin('read_sp') },
      { id: 'v_ld', kind: 'definition', definitionNodeId: 'ld', machineType: bv32, origin: origin('ld') },
    ];
    const mssa = buildStackMssa(nodes, values);
    const clobbers = mssa.definitions.filter((d) => d.sourceEntityId === 'call_1' && d.kind === 'call-clobber' && d.regionId === stackRegion.id);
    assert.equal(clobbers.length, 1, `${regId} must be recognized as stack/frame pointer`);
  }
});

test('1e. sub v_sp, 0xfffffffffffffff8 (64-bit -8) yields sp+8 and blocks noEscapeStack', () => {
  const nodes = [
    {
      id: 'read_sp', kind: 'state-read', blockId: 'entry', inputs: [], outputs: ['v_sp'],
      variable: { key: 'phys.sp', kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId: 'sp' } },
      origin: origin('read_sp'),
    },
    {
      id: 'c8', kind: 'const', blockId: 'entry', operator: 'const', inputs: [], outputs: ['v_c8'],
      attributes: { bitvectorValue: { kind: 'bitvector', widthBits: 64, value: 8n } }, origin: origin('c8'),
    },
    {
      id: 'c_neg8', kind: 'const', blockId: 'entry', operator: 'const', inputs: [], outputs: ['v_c_neg8'],
      attributes: { bitvectorValue: { kind: 'bitvector', widthBits: 64, value: 0xfffffffffffffff8n } }, origin: origin('c_neg8'),
    },
    { id: 'sub_local', kind: 'binary', blockId: 'entry', operator: 'sub', inputs: ['v_sp', 'v_c8'], outputs: ['v_local'], origin: origin('sub_local') },
    { id: 'sub_neg8', kind: 'binary', blockId: 'entry', operator: 'sub', inputs: ['v_sp', 'v_c_neg8'], outputs: ['v_stack_arg'], origin: origin('sub_neg8') },
    { id: 'st_arg', kind: 'store', blockId: 'entry', inputs: ['v_stack_arg', 'v_local'], outputs: [], memory: mem32('v_stack_arg'), origin: origin('st_arg') },
    unknownCall('call_1'),
    { id: 'ld', kind: 'load', blockId: 'entry', inputs: [], outputs: ['v_ld'], memory: mem32('v_local'), origin: origin('ld') },
  ];
  const values = [
    { id: 'v_sp', kind: 'definition', definitionNodeId: 'read_sp', machineType: bv64, origin: origin('read_sp') },
    { id: 'v_c8', kind: 'definition', definitionNodeId: 'c8', machineType: bv64, origin: origin('c8') },
    { id: 'v_c_neg8', kind: 'definition', definitionNodeId: 'c_neg8', machineType: bv64, origin: origin('c_neg8') },
    { id: 'v_local', kind: 'definition', definitionNodeId: 'sub_local', machineType: bv64, origin: origin('sub_local') },
    { id: 'v_stack_arg', kind: 'definition', definitionNodeId: 'sub_neg8', machineType: bv64, origin: origin('sub_neg8') },
    { id: 'v_ld', kind: 'definition', definitionNodeId: 'ld', machineType: bv32, origin: origin('ld') },
  ];
  const mssa = buildStackMssa(nodes, values);
  const clobbers = mssa.definitions.filter((d) => d.sourceEntityId === 'call_1' && d.kind === 'call-clobber' && d.regionId === stackRegion.id);
  assert.equal(clobbers.length, 1, 'sub v_sp, 0xfffffffffffffff8 ([sp+8]) must block noEscapeStack');
});

test('1f. sub (add v_sp, 64), 8 yields sp+56 in caller/outgoing area and blocks noEscapeStack', () => {
  const nodes = [
    {
      id: 'read_sp', kind: 'state-read', blockId: 'entry', inputs: [], outputs: ['v_sp'],
      variable: { key: 'phys.sp', kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId: 'sp' } },
      origin: origin('read_sp'),
    },
    {
      id: 'c8', kind: 'const', blockId: 'entry', operator: 'const', inputs: [], outputs: ['v_c8'],
      attributes: { bitvectorValue: { kind: 'bitvector', widthBits: 64, value: 8n } }, origin: origin('c8'),
    },
    {
      id: 'c64', kind: 'const', blockId: 'entry', operator: 'const', inputs: [], outputs: ['v_c64'],
      attributes: { bitvectorValue: { kind: 'bitvector', widthBits: 64, value: 64n } }, origin: origin('c64'),
    },
    { id: 'sub_local', kind: 'binary', blockId: 'entry', operator: 'sub', inputs: ['v_sp', 'v_c8'], outputs: ['v_local'], origin: origin('sub_local') },
    { id: 'add_high', kind: 'binary', blockId: 'entry', operator: 'add', inputs: ['v_sp', 'v_c64'], outputs: ['v_high'], origin: origin('add_high') },
    { id: 'sub_high', kind: 'binary', blockId: 'entry', operator: 'sub', inputs: ['v_high', 'v_c8'], outputs: ['v_outgoing'], origin: origin('sub_high') },
    { id: 'st_arg', kind: 'store', blockId: 'entry', inputs: ['v_outgoing', 'v_local'], outputs: [], memory: mem32('v_outgoing'), origin: origin('st_arg') },
    unknownCall('call_1'),
    { id: 'ld', kind: 'load', blockId: 'entry', inputs: [], outputs: ['v_ld'], memory: mem32('v_local'), origin: origin('ld') },
  ];
  const values = [
    { id: 'v_sp', kind: 'definition', definitionNodeId: 'read_sp', machineType: bv64, origin: origin('read_sp') },
    { id: 'v_c8', kind: 'definition', definitionNodeId: 'c8', machineType: bv64, origin: origin('c8') },
    { id: 'v_c64', kind: 'definition', definitionNodeId: 'c64', machineType: bv64, origin: origin('c64') },
    { id: 'v_local', kind: 'definition', definitionNodeId: 'sub_local', machineType: bv64, origin: origin('sub_local') },
    { id: 'v_high', kind: 'definition', definitionNodeId: 'add_high', machineType: bv64, origin: origin('add_high') },
    { id: 'v_outgoing', kind: 'definition', definitionNodeId: 'sub_high', machineType: bv64, origin: origin('sub_high') },
    { id: 'v_ld', kind: 'definition', definitionNodeId: 'ld', machineType: bv32, origin: origin('ld') },
  ];
  const mssa = buildStackMssa(nodes, values);
  const clobbers = mssa.definitions.filter((d) => d.sourceEntityId === 'call_1' && d.kind === 'call-clobber' && d.regionId === stackRegion.id);
  assert.equal(clobbers.length, 1, 'sub (add v_sp, 64), 8 ([sp+56]) must block noEscapeStack');
});

// ============================================================================
// 2. [P0] may-alias-clobber must not get false byteRange or be skipped by overlap
// ============================================================================

test('2. may-alias-clobber emits null byteRange and blocks forwarding even with non-overlapping metadata range', () => {
  const regionA = { id: 'region_a', kind: 'rooted-offset', functionId: 'fn_may_barrier', rootEntityId: 'root_a', offset: 0, widthBits: 32 };
  const regionMaybe = { id: 'region_maybe', kind: 'rooted-offset', functionId: 'fn_may_barrier', rootEntityId: 'root_maybe', offset: 0, widthBits: 32 };
  const ir = createSemanticIrFunction({
    functionId: 'fn_may_barrier',
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', nodeIds: ['c_val', 'st_exact', 'st_may', 'ld_exact'], origin: origin('entry') }],
    values: [
      { id: 'v_val', kind: 'definition', definitionNodeId: 'c_val', machineType: bv32, origin: origin('c_val') },
      { id: 'v_addr_exact', kind: 'entry', machineType: addr64, origin: origin('v_addr_exact') },
      { id: 'v_addr_may', kind: 'entry', machineType: addr64, origin: origin('v_addr_may') },
      { id: 'v_loaded', kind: 'definition', definitionNodeId: 'ld_exact', machineType: bv32, origin: origin('ld_exact') },
    ],
    nodes: [
      { id: 'c_val', kind: 'const', blockId: 'entry', operator: 'const', inputs: [], outputs: ['v_val'], attributes: { bitvectorValue: { kind: 'bitvector', widthBits: 32, value: 42n } }, origin: origin('c_val') },
      { id: 'st_exact', kind: 'store', blockId: 'entry', inputs: ['v_addr_exact', 'v_val'], outputs: [], memory: mem32('v_addr_exact'), origin: origin('st_exact') },
      { id: 'st_may', kind: 'store', blockId: 'entry', inputs: ['v_addr_may', 'v_val'], outputs: [], memory: mem32('v_addr_may'), origin: origin('st_may') },
      { id: 'ld_exact', kind: 'load', blockId: 'entry', inputs: [], outputs: ['v_loaded'], memory: mem32('v_addr_exact'), origin: origin('ld_exact') },
    ],
    completeness: 'complete',
    origin: origin('fn'),
  });
  const cfg = createSemanticCfg({ functionId: 'fn_may_barrier', entryBlockId: 'entry', blocks: [{ id: 'entry', successors: [] }] });
  const mssa = buildMemorySsa(ir, cfg, {
    resolveRegion: (access) => (access?.addressExpr?.valueId === 'v_addr_may' ? regionMaybe : regionA),
    queryAlias: (left, right) => {
      if ((left.id === regionMaybe.id && right.id === regionA.id) || (left.id === regionA.id && right.id === regionMaybe.id)) return 'may';
      return left.id === right.id ? 'must' : 'no';
    },
  });
  const mayDef = mssa.definitions.find((d) => d.kind === 'may-alias-clobber');
  assert.ok(mayDef, 'expected may-alias-clobber definition');
  const mayMeta = mssa.accessMetadata.find((m) => m.memorySsaEntityId === mayDef.id);
  assert.equal(mayMeta.byteRange, null, 'may-alias-clobber must not have a finite byteRange');

  const loadUse = mssa.uses.find((u) => u.sourceEntityId === 'ld_exact' && u.regionId === regionA.id);
  const fwd = forwardMemoryValue(mssa, loadUse, {
    consumerId: CANONICAL_MEMORY_FORWARDING_CONSUMER,
    purpose: CANONICAL_MEMORY_FORWARDING_PURPOSE,
    ir,
    cfg,
  });
  assert.notEqual(fwd.status, 'exact', 'may-alias-clobber must block forwarding');
});

// ============================================================================
// 3. [P0] Duplicate value IDs in node.inputs and call.arguments
// ============================================================================

test('3. createSemanticNode inputs and createSemanticCallSummary arguments allow legitimate duplicate value IDs', () => {
  const xorSelf = createSemanticNode({
    id: 'n_xor',
    kind: 'binary',
    blockId: 'entry',
    operator: 'xor',
    inputs: ['v0', 'v0'],
    outputs: ['v1'],
    origin: origin('n_xor'),
  });
  assert.deepEqual(xorSelf.inputs, ['v0', 'v0']);

  const callDup = createSemanticCallSummary({
    targetValueIds: [],
    targetEntityIds: ['fn_callee'],
    arguments: ['v0', 'v0'],
    returns: ['v2'],
    stateReads: [],
    stateWrites: [],
    memoryRead: { scope: 'none' },
    memoryWrite: { scope: 'none' },
    controlEffects: [],
    determinism: 'deterministic',
    noreturn: false,
    mayThrow: false,
    summarySource: 'fixture',
    completeness: 'complete',
  });
  assert.deepEqual(callDup.arguments, ['v0', 'v0']);
});

// ============================================================================
// 4. [P1] analyzeSemanticDominance entry block with single back-edge
// ============================================================================

test('4. analyzeSemanticDominance computes dominance frontier for entry block with single back-edge', () => {
  const cfg = createSemanticCfg({
    functionId: 'fn_entry_loop',
    entryBlockId: 'entry',
    blocks: [
      { id: 'entry', successors: [{ to: 'body', kind: 'branch' }] },
      { id: 'body', successors: [{ to: 'entry', kind: 'conditional-true' }, { to: 'exit', kind: 'conditional-false' }] },
      { id: 'exit', successors: [] },
    ],
  });
  const dom = analyzeSemanticDominance(cfg);
  assert.ok(dom.dominanceFrontier.body.includes('entry'), 'body -> entry back-edge must include entry in DF[body]');
  assert.ok(dom.dominanceFrontier.entry.includes('entry'), 'entry must be in DF[entry] when entry has a back-edge');
});

// ============================================================================
// 5. [P1] forwardingValidationBudgetKey avoids "[object Object]" collision
// ============================================================================

test('5. forwardingValidationBudgetKey does not collide distinct plain object validationBudgets', () => {
  const region = {
    id: 'r0',
    kind: 'global-absolute',
    binaryId: 'bin_budget',
    address: '0x2000',
    widthBits: 32,
    origin: origin('r0'),
  };
  const ir = createSemanticIrFunction({
    functionId: 'fn_budget',
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', nodeIds: ['n_addr', 'c1', 'st1', 'ld1'], origin: origin('entry') }],
    values: [
      { id: 'v_addr', kind: 'definition', definitionNodeId: 'n_addr', machineType: addr64, origin: origin('n_addr') },
      { id: 'v1', kind: 'definition', definitionNodeId: 'c1', machineType: bv32, origin: origin('c1'), metadata: { constant: { kind: 'bitvector', widthBits: 32, value: 7n } } },
      { id: 'v_out', kind: 'definition', definitionNodeId: 'ld1', machineType: bv32, origin: origin('ld1') },
    ],
    nodes: [
      { id: 'n_addr', kind: 'address', blockId: 'entry', inputs: [], outputs: ['v_addr'], attributes: { value: '0x2000' }, origin: origin('n_addr') },
      { id: 'c1', kind: 'const', blockId: 'entry', operator: 'const', inputs: [], outputs: ['v1'], attributes: { value: 7 }, origin: origin('c1') },
      { id: 'st1', kind: 'store', blockId: 'entry', inputs: ['v_addr', 'v1'], outputs: [], memory: mem32('v_addr'), attributes: { machineEffects: { operationMetadata: { addressing: { addressDisplacement: '0' } } } }, origin: origin('st1') },
      { id: 'ld1', kind: 'load', blockId: 'entry', inputs: ['v_addr'], outputs: ['v_out'], memory: mem32('v_addr'), attributes: { machineEffects: { operationMetadata: { addressing: { addressDisplacement: '0' } } } }, origin: origin('ld1') },
    ],
    completeness: 'complete',
    origin: origin('fn'),
  });
  const cfg = createSemanticCfg({ functionId: 'fn_budget', entryBlockId: 'entry', blocks: [{ id: 'entry', successors: [] }] });
  const identity = {
    binaryId: 'bin_budget', sliceId: 'slice_budget', functionId: ir.functionId,
    semanticIrId: 'ir_budget', scalarSsaId: 'ssa_budget', memorySsaId: 'mssa_budget',
    snapshotId: 'snap_budget', semanticIrContractVersion: '2.0.0',
    semanticIrDigest: stableDigest(ir), scalarSsaBuildVersion: '1.0.0',
    scalarSsaDigest: 'ssa_budget_digest', memorySsaBuildVersion: MEMORY_SSA_BUILD_VERSION,
    analyzerVersion: 'memoryssa-fixture',
  };
  const mssa = buildMemorySsa(ir, cfg, {
    regions: [region],
    resolveRegion: () => region,
    queryAlias: () => 'must',
    identity,
    snapshotId: 'snap_budget',
    canonicalIrIdentity: {
      functionId: ir.functionId,
      semanticIrId: 'ir_budget',
      semanticIrContractVersion: '2.0.0',
      semanticIrDigest: stableDigest(ir),
    },
  });
  const use = mssa.uses[0];

  const r1 = forwardMemoryValue(mssa, use, {
    consumerId: CANONICAL_MEMORY_FORWARDING_CONSUMER,
    purpose: CANONICAL_MEMORY_FORWARDING_PURPOSE,
    ir,
    cfg,
    snapshotId: 'snap_budget',
    validationBudget: { maxDefinitions: 100 },
  });
  const r2 = forwardMemoryValue(mssa, use, {
    consumerId: CANONICAL_MEMORY_FORWARDING_CONSUMER,
    purpose: CANONICAL_MEMORY_FORWARDING_PURPOSE,
    ir,
    cfg,
    snapshotId: 'snap_budget',
    validationBudget: { maxDefinitions: 0 },
  });
  assert.notEqual(r1.status, 'budget-limited');
  assert.equal(r2.status, 'unsupported', 'distinct validationBudget objects must not collide on [object Object]');
});

// ============================================================================
// 6. [P1] Unspecified 'div' opcode classification and lowering
// ============================================================================

test('6. unspecified div classifies as intrinsic and lowers without throwing in nodes.js', () => {
  assert.equal(classifyMachineValueOpcode('div').kind, 'intrinsic');
  assert.equal(classifyMachineValueOpcode('sdiv').kind, 'binary');
  assert.equal(classifyMachineValueOpcode('udiv').kind, 'binary');

  const bundle = createMachineEffectBundle({
    instructionId: 'inst_div',
    architectureId: 'synthetic-neutral-isa',
    mode: 'synthetic-mode',
    operations: [
      createMachineOperation({
        kind: 'value',
        id: 'effect.div',
        opcode: 'div',
        inputs: [createBitVectorValue(32, 10n), createBitVectorValue(32, 2n)],
        outputs: [createTemporaryValue('t0', createBitVectorValue(32))],
      }),
    ],
    controlEffect: { kind: 'return' },
    possibleFaults: [],
    completeness: 'exact',
    origin: origin('div'),
  });
  const lowered = lowerMachineEffectBundleToSemanticIr(bundle, { functionId: 'fn_div', blockId: 'entry', addressWidthBits: 64 });
  const divNode = lowered.nodes.find((n) => n.operator === 'div');
  assert.ok(divNode);
  assert.equal(divNode.kind, 'intrinsic');
});

// ============================================================================
// 7. [P1] validateNormalizedFunction checks call.targetValueIds for use-before-definition
// ============================================================================

test('7. validateNormalizedFunction rejects same-block use-before-definition in call.targetValueIds', () => {
  assert.throws(() => createSemanticIrFunction({
    functionId: 'fn_ubd_target',
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', nodeIds: ['call_1', 'def_target'], origin: origin('entry') }],
    values: [
      { id: 'v_target', kind: 'definition', definitionNodeId: 'def_target', machineType: addr64, origin: origin('def_target') },
    ],
    nodes: [
      {
        id: 'call_1',
        kind: 'call',
        blockId: 'entry',
        inputs: [],
        outputs: [],
        call: {
          targetValueIds: ['v_target'],
          targetEntityIds: [],
          arguments: [],
          returns: [],
          stateReads: [],
          stateWrites: [],
          memoryRead: { scope: 'none' },
          memoryWrite: { scope: 'none' },
          controlEffects: [],
          determinism: 'deterministic',
          noreturn: false,
          mayThrow: false,
          summarySource: 'fixture',
          completeness: 'complete',
        },
        origin: origin('call_1'),
      },
      {
        id: 'def_target',
        kind: 'const',
        blockId: 'entry',
        operator: 'const',
        inputs: [],
        outputs: ['v_target'],
        attributes: { bitvectorValue: { kind: 'bitvector', widthBits: 64, value: 0x4000n } },
        origin: origin('def_target'),
      },
    ],
    completeness: 'complete',
    origin: origin('fn'),
  }), (err) => err instanceof TypeError && err.message === 'semantic-ir-value-use-before-definition-in-block');
});

// ============================================================================
// 8. [P2] createMachineValue temporary cycle & deep nesting throw TypeError
// ============================================================================

test('8. createMachineValue rejects cyclic and deeply nested temporary valueTypes with TypeError', () => {
  const cyclic = { kind: 'temporary', temporaryId: 't_cyc' };
  cyclic.valueType = cyclic;
  assert.throws(
    () => createMachineValue(cyclic),
    (err) => err instanceof TypeError && err.message === 'machine-effects-cyclic-value',
  );

  let deep = { kind: 'bitvector', widthBits: 32 };
  for (let i = 0; i < 80; i++) {
    deep = { kind: 'temporary', temporaryId: `t_${i}`, valueType: deep };
  }
  assert.throws(
    () => createMachineValue(deep),
    (err) => err instanceof TypeError && err.message === 'machine-effects-value-nesting-too-deep',
  );
});
