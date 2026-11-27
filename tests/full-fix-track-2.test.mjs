import assert from 'node:assert/strict';
import test from 'node:test';

import { createSemanticCfg } from '../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../js/semantics/ir/function.js';
import { buildMemorySsa } from '../js/semantics/memoryssa/build.js';

const origin = (id) => ({ instructionIds: [`inst_${id}`] });
const bv32 = { kind: 'bitvector', widthBits: 32 };
const bv64 = { kind: 'bitvector', widthBits: 64 };
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
  functionId: 'fn_track2',
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
    functionId: 'fn_track2',
    entryBlockId: blocks ? blocks[0].id : 'entry',
    blocks: blocks ? blocks.map(({ id, nodeIds, origin: blkOrigin }) => ({ id, nodeIds, origin: blkOrigin })) : [{ id: 'entry', nodeIds: nodes.map((n) => n.id), origin: origin('entry') }],
    values,
    nodes,
    completeness: 'partial',
    unknowns: [{ reason: 'unresolved-call', categories: ['memory'] }],
    origin: origin('fn'),
  });
  const cfg = createSemanticCfg({
    functionId: 'fn_track2',
    entryBlockId: blocks ? blocks[0].id : 'entry',
    blocks: (blocks ?? [{ id: 'entry' }]).map((b) => ({ id: b.id, successors: b.successors ?? [] })),
  });
  return buildMemorySsa(ir, cfg, {
    resolveRegion: () => stackRegion,
    queryAlias: () => 'unknown',
  });
}

function stackClobbers(mssa, callId = 'call_1') {
  return mssa.definitions.filter(
    (d) => d.sourceEntityId === callId && d.kind === 'call-clobber' && d.regionId === stackRegion.id,
  );
}

// ============================================================================
// Fix 1: [P1] AArch64 AAPCS64 indirect result (sret) register x8 / w8
// ============================================================================

test('1a. passing local stack address via add x8, sp, #16 blocks noEscapeStack on ABI-neutral call', () => {
  const nodes = [
    {
      id: 'read_sp', kind: 'state-read', blockId: 'entry', inputs: [], outputs: ['v_sp'],
      variable: { key: 'phys.sp', kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId: 'sp' } },
      origin: origin('read_sp'),
    },
    {
      id: 'c16', kind: 'const', blockId: 'entry', operator: 'const', inputs: [], outputs: ['v_c16'],
      attributes: { bitvectorValue: { kind: 'bitvector', widthBits: 64, value: 16n } }, origin: origin('c16'),
    },
    { id: 'add_sret', kind: 'binary', blockId: 'entry', operator: 'add', inputs: ['v_sp', 'v_c16'], outputs: ['v_sret_buf'], origin: origin('add_sret') },
    {
      id: 'sw_x8', kind: 'state-write', blockId: 'entry', inputs: ['v_sret_buf'], outputs: [],
      variable: { key: 'phys.x8', kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId: 'x8' } },
      origin: origin('sw_x8'),
    },
    unknownCall('call_1'),
    { id: 'ld', kind: 'load', blockId: 'entry', inputs: [], outputs: ['v_ld'], memory: mem32('v_sret_buf'), origin: origin('ld') },
  ];
  const values = [
    { id: 'v_sp', kind: 'definition', definitionNodeId: 'read_sp', machineType: bv64, origin: origin('read_sp') },
    { id: 'v_c16', kind: 'definition', definitionNodeId: 'c16', machineType: bv64, origin: origin('c16') },
    { id: 'v_sret_buf', kind: 'definition', definitionNodeId: 'add_sret', machineType: bv64, origin: origin('add_sret') },
    { id: 'v_ld', kind: 'definition', definitionNodeId: 'ld', machineType: bv32, origin: origin('ld') },
  ];
  const mssa = buildStackMssa(nodes, values);
  assert.equal(stackClobbers(mssa).length, 1, 'x8 sret stack buffer must block noEscapeStack and emit call-clobber');
});

test('1b. w8 lower alias carrying stack-derived or unknown value blocks noEscapeStack', () => {
  const nodes = [
    {
      id: 'read_sp', kind: 'state-read', blockId: 'entry', inputs: [], outputs: ['v_sp'],
      variable: { key: 'phys.sp', kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId: 'sp' } },
      origin: origin('read_sp'),
    },
    {
      id: 'sw_w8', kind: 'state-write', blockId: 'entry', inputs: ['v_sp'], outputs: [],
      variable: { key: 'phys.w8', kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId: 'w8' } },
      origin: origin('sw_w8'),
    },
    unknownCall('call_1'),
    { id: 'ld', kind: 'load', blockId: 'entry', inputs: [], outputs: ['v_ld'], memory: mem32('v_sp'), origin: origin('ld') },
  ];
  const values = [
    { id: 'v_sp', kind: 'definition', definitionNodeId: 'read_sp', machineType: bv64, origin: origin('read_sp') },
    { id: 'v_ld', kind: 'definition', definitionNodeId: 'ld', machineType: bv32, origin: origin('ld') },
  ];
  const mssa = buildStackMssa(nodes, values);
  assert.equal(stackClobbers(mssa).length, 1, 'w8 stack-derived write must block noEscapeStack');
});

test('1c. overwriting x8 with non-stack constant (via x8 or w8) preserves noEscapeStack precision', () => {
  for (const killReg of ['x8', 'w8']) {
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
        id: 'sw_x8_sp', kind: 'state-write', blockId: 'entry', inputs: ['v_sp'], outputs: [],
        variable: { key: 'phys.x8', kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId: 'x8' } },
        origin: origin('sw_x8_sp'),
      },
      {
        id: 'sw_kill', kind: 'state-write', blockId: 'entry', inputs: ['v_zero'], outputs: [],
        variable: { key: `phys.${killReg}`, kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId: killReg } },
        origin: origin('sw_kill'),
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
    assert.equal(stackClobbers(mssa).length, 0, `overwriting x8 via ${killReg}=0 must preserve noEscapeStack precision`);
  }
});

test('1d. writing non-stack constant to x0/d0 does not kill prior stack-derived x8 write', () => {
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
      id: 'sw_x8', kind: 'state-write', blockId: 'entry', inputs: ['v_sp'], outputs: [],
      variable: { key: 'phys.x8', kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId: 'x8' } },
      origin: origin('sw_x8'),
    },
    {
      id: 'sw_x0', kind: 'state-write', blockId: 'entry', inputs: ['v_zero'], outputs: [],
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
  assert.equal(stackClobbers(mssa).length, 1, 'x0/d0 writes must not kill x8 sret escape');
});

test('1e. diamond CFG x8 stack escape in one branch emits call-clobber at merge call', () => {
  const b0Nodes = [
    {
      id: 'read_sp', kind: 'state-read', blockId: 'b0', inputs: [], outputs: ['v_sp'],
      variable: { key: 'phys.sp', kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId: 'sp' } },
      origin: origin('read_sp'),
    },
    {
      id: 'c0', kind: 'const', blockId: 'b0', operator: 'const', inputs: [], outputs: ['v_zero'],
      attributes: { bitvectorValue: { kind: 'bitvector', widthBits: 64, value: 0n } }, origin: origin('c0'),
    },
  ];
  const b1Nodes = [
    {
      id: 'sw_x8_b1', kind: 'state-write', blockId: 'b1', inputs: ['v_sp'], outputs: [],
      variable: { key: 'phys.x8', kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId: 'x8' } },
      origin: origin('sw_x8_b1'),
    },
  ];
  const b2Nodes = [
    {
      id: 'sw_x8_b2', kind: 'state-write', blockId: 'b2', inputs: ['v_zero'], outputs: [],
      variable: { key: 'phys.x8', kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId: 'x8' } },
      origin: origin('sw_x8_b2'),
    },
  ];
  const b3Nodes = [
    unknownCall('call_1', 'b3'),
    { id: 'ld', kind: 'load', blockId: 'b3', inputs: [], outputs: ['v_ld'], memory: mem32('v_sp'), origin: origin('ld') },
  ];
  const values = [
    { id: 'v_sp', kind: 'definition', definitionNodeId: 'read_sp', machineType: bv64, origin: origin('read_sp') },
    { id: 'v_zero', kind: 'definition', definitionNodeId: 'c0', machineType: bv64, origin: origin('c0') },
    { id: 'v_ld', kind: 'definition', definitionNodeId: 'ld', machineType: bv32, origin: origin('ld') },
  ];
  const blocks = [
    { id: 'b0', nodeIds: b0Nodes.map((n) => n.id), successors: [{ to: 'b1', kind: 'conditional-true' }, { to: 'b2', kind: 'conditional-false' }], origin: origin('b0') },
    { id: 'b1', nodeIds: b1Nodes.map((n) => n.id), successors: [{ to: 'b3', kind: 'branch' }], origin: origin('b1') },
    { id: 'b2', nodeIds: b2Nodes.map((n) => n.id), successors: [{ to: 'b3', kind: 'branch' }], origin: origin('b2') },
    { id: 'b3', nodeIds: b3Nodes.map((n) => n.id), successors: [], origin: origin('b3') },
  ];
  const mssa = buildStackMssa([...b0Nodes, ...b1Nodes, ...b2Nodes, ...b3Nodes], values, blocks);
  assert.equal(stackClobbers(mssa).length, 1, 'x8 stack escape in either branch must emit call-clobber');
});

// ============================================================================
// Fix 2: [P1] Distinguish sp/rsp/esp vs fp/rbp/ebp/x29 in provenStackRootOffset
// ============================================================================

test('2a. storing &local to negative offset from sp/rsp/esp ([sp - 16], [rsp - 8], [esp - 4]) blocks noEscapeStack', () => {
  for (const [regId, widthBits, delta] of [['sp', 64, 16n], ['rsp', 64, 8n], ['esp', 32, 4n]]) {
    const type = widthBits === 64 ? bv64 : bv32;
    const nodes = [
      {
        id: 'read_sp', kind: 'state-read', blockId: 'entry', inputs: [], outputs: ['v_sp'],
        variable: { key: `phys.${regId}`, kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId: regId } },
        origin: origin('read_sp'),
      },
      {
        id: 'c_delta', kind: 'const', blockId: 'entry', operator: 'const', inputs: [], outputs: ['v_delta'],
        attributes: { bitvectorValue: { kind: 'bitvector', widthBits, value: delta } }, origin: origin('c_delta'),
      },
      {
        id: 'c_local', kind: 'const', blockId: 'entry', operator: 'const', inputs: [], outputs: ['v_off_local'],
        attributes: { bitvectorValue: { kind: 'bitvector', widthBits, value: 32n } }, origin: origin('c_local'),
      },
      { id: 'add_local', kind: 'binary', blockId: 'entry', operator: 'add', inputs: ['v_sp', 'v_off_local'], outputs: ['v_local'], origin: origin('add_local') },
      { id: 'sub_below_sp', kind: 'binary', blockId: 'entry', operator: 'sub', inputs: ['v_sp', 'v_delta'], outputs: ['v_below_sp'], origin: origin('sub_below_sp') },
      { id: 'st_below', kind: 'store', blockId: 'entry', inputs: ['v_below_sp', 'v_local'], outputs: [], memory: mem32('v_below_sp'), origin: origin('st_below') },
      unknownCall('call_1'),
      { id: 'ld', kind: 'load', blockId: 'entry', inputs: [], outputs: ['v_ld'], memory: mem32('v_local'), origin: origin('ld') },
    ];
    const values = [
      { id: 'v_sp', kind: 'definition', definitionNodeId: 'read_sp', machineType: type, origin: origin('read_sp') },
      { id: 'v_delta', kind: 'definition', definitionNodeId: 'c_delta', machineType: type, origin: origin('c_delta') },
      { id: 'v_off_local', kind: 'definition', definitionNodeId: 'c_local', machineType: type, origin: origin('c_local') },
      { id: 'v_local', kind: 'definition', definitionNodeId: 'add_local', machineType: type, origin: origin('add_local') },
      { id: 'v_below_sp', kind: 'definition', definitionNodeId: 'sub_below_sp', machineType: type, origin: origin('sub_below_sp') },
      { id: 'v_ld', kind: 'definition', definitionNodeId: 'ld', machineType: bv32, origin: origin('ld') },
    ];
    const mssa = buildStackMssa(nodes, values);
    assert.equal(
      stackClobbers(mssa).length,
      1,
      `storing &local to [${regId} - ${delta}] must be treated as outside local frame and block noEscapeStack`,
    );
  }
});

test('2b. chained negative offset from sp (add(sub(sp, 32), 8) = sp - 24) blocks noEscapeStack', () => {
  const nodes = [
    {
      id: 'read_sp', kind: 'state-read', blockId: 'entry', inputs: [], outputs: ['v_sp'],
      variable: { key: 'phys.sp', kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId: 'sp' } },
      origin: origin('read_sp'),
    },
    {
      id: 'c32', kind: 'const', blockId: 'entry', operator: 'const', inputs: [], outputs: ['v_c32'],
      attributes: { bitvectorValue: { kind: 'bitvector', widthBits: 64, value: 32n } }, origin: origin('c32'),
    },
    {
      id: 'c8', kind: 'const', blockId: 'entry', operator: 'const', inputs: [], outputs: ['v_c8'],
      attributes: { bitvectorValue: { kind: 'bitvector', widthBits: 64, value: 8n } }, origin: origin('c8'),
    },
    { id: 'sub_32', kind: 'binary', blockId: 'entry', operator: 'sub', inputs: ['v_sp', 'v_c32'], outputs: ['v_m32'], origin: origin('sub_32') },
    { id: 'add_8', kind: 'binary', blockId: 'entry', operator: 'add', inputs: ['v_m32', 'v_c8'], outputs: ['v_m24'], origin: origin('add_8') },
    { id: 'st_below', kind: 'store', blockId: 'entry', inputs: ['v_m24', 'v_sp'], outputs: [], memory: mem32('v_m24'), origin: origin('st_below') },
    unknownCall('call_1'),
    { id: 'ld', kind: 'load', blockId: 'entry', inputs: [], outputs: ['v_ld'], memory: mem32('v_sp'), origin: origin('ld') },
  ];
  const values = [
    { id: 'v_sp', kind: 'definition', definitionNodeId: 'read_sp', machineType: bv64, origin: origin('read_sp') },
    { id: 'v_c32', kind: 'definition', definitionNodeId: 'c32', machineType: bv64, origin: origin('c32') },
    { id: 'v_c8', kind: 'definition', definitionNodeId: 'c8', machineType: bv64, origin: origin('c8') },
    { id: 'v_m32', kind: 'definition', definitionNodeId: 'sub_32', machineType: bv64, origin: origin('sub_32') },
    { id: 'v_m24', kind: 'definition', definitionNodeId: 'add_8', machineType: bv64, origin: origin('add_8') },
    { id: 'v_ld', kind: 'definition', definitionNodeId: 'ld', machineType: bv32, origin: origin('ld') },
  ];
  const mssa = buildStackMssa(nodes, values);
  assert.equal(stackClobbers(mssa).length, 1, 'chained sp - 24 store must block noEscapeStack');
});

test('2c. storing &local to negative offset from fp/rbp/ebp/x29 preserves noEscapeStack precision', () => {
  for (const [regId, widthBits] of [['fp', 64], ['rbp', 64], ['ebp', 32], ['x29', 64]]) {
    const type = widthBits === 64 ? bv64 : bv32;
    const nodes = [
      {
        id: 'read_fp', kind: 'state-read', blockId: 'entry', inputs: [], outputs: ['v_fp'],
        variable: { key: `phys.${regId}`, kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId: regId } },
        origin: origin('read_fp'),
      },
      {
        id: 'c8', kind: 'const', blockId: 'entry', operator: 'const', inputs: [], outputs: ['v_c8'],
        attributes: { bitvectorValue: { kind: 'bitvector', widthBits, value: 8n } }, origin: origin('c8'),
      },
      {
        id: 'c16', kind: 'const', blockId: 'entry', operator: 'const', inputs: [], outputs: ['v_c16'],
        attributes: { bitvectorValue: { kind: 'bitvector', widthBits, value: 16n } }, origin: origin('c16'),
      },
      { id: 'sub_local', kind: 'binary', blockId: 'entry', operator: 'sub', inputs: ['v_fp', 'v_c8'], outputs: ['v_local'], origin: origin('sub_local') },
      { id: 'sub_slot', kind: 'binary', blockId: 'entry', operator: 'sub', inputs: ['v_fp', 'v_c16'], outputs: ['v_slot'], origin: origin('sub_slot') },
      { id: 'st_slot', kind: 'store', blockId: 'entry', inputs: ['v_slot', 'v_local'], outputs: [], memory: mem32('v_slot'), origin: origin('st_slot') },
      unknownCall('call_1'),
      { id: 'ld', kind: 'load', blockId: 'entry', inputs: [], outputs: ['v_ld'], memory: mem32('v_local'), origin: origin('ld') },
    ];
    const values = [
      { id: 'v_fp', kind: 'definition', definitionNodeId: 'read_fp', machineType: type, origin: origin('read_fp') },
      { id: 'v_c8', kind: 'definition', definitionNodeId: 'c8', machineType: type, origin: origin('c8') },
      { id: 'v_c16', kind: 'definition', definitionNodeId: 'c16', machineType: type, origin: origin('c16') },
      { id: 'v_local', kind: 'definition', definitionNodeId: 'sub_local', machineType: type, origin: origin('sub_local') },
      { id: 'v_slot', kind: 'definition', definitionNodeId: 'sub_slot', machineType: type, origin: origin('sub_slot') },
      { id: 'v_ld', kind: 'definition', definitionNodeId: 'ld', machineType: bv32, origin: origin('ld') },
    ];
    const mssa = buildStackMssa(nodes, values);
    assert.equal(
      stackClobbers(mssa).length,
      0,
      `storing &local into [${regId} - 16] is a proven local frame slot and must preserve noEscapeStack`,
    );
  }
});

test('2d. storing &local to non-negative offset from fp/rbp/x29 ([fp + 16]) still blocks noEscapeStack', () => {
  for (const regId of ['fp', 'rbp', 'x29']) {
    const nodes = [
      {
        id: 'read_fp', kind: 'state-read', blockId: 'entry', inputs: [], outputs: ['v_fp'],
        variable: { key: `phys.${regId}`, kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId: regId } },
        origin: origin('read_fp'),
      },
      {
        id: 'c8', kind: 'const', blockId: 'entry', operator: 'const', inputs: [], outputs: ['v_c8'],
        attributes: { bitvectorValue: { kind: 'bitvector', widthBits: 64, value: 8n } }, origin: origin('c8'),
      },
      {
        id: 'c16', kind: 'const', blockId: 'entry', operator: 'const', inputs: [], outputs: ['v_c16'],
        attributes: { bitvectorValue: { kind: 'bitvector', widthBits: 64, value: 16n } }, origin: origin('c16'),
      },
      { id: 'sub_local', kind: 'binary', blockId: 'entry', operator: 'sub', inputs: ['v_fp', 'v_c8'], outputs: ['v_local'], origin: origin('sub_local') },
      { id: 'add_caller', kind: 'binary', blockId: 'entry', operator: 'add', inputs: ['v_fp', 'v_c16'], outputs: ['v_caller'], origin: origin('add_caller') },
      { id: 'st_caller', kind: 'store', blockId: 'entry', inputs: ['v_caller', 'v_local'], outputs: [], memory: mem32('v_caller'), origin: origin('st_caller') },
      unknownCall('call_1'),
      { id: 'ld', kind: 'load', blockId: 'entry', inputs: [], outputs: ['v_ld'], memory: mem32('v_local'), origin: origin('ld') },
    ];
    const values = [
      { id: 'v_fp', kind: 'definition', definitionNodeId: 'read_fp', machineType: bv64, origin: origin('read_fp') },
      { id: 'v_c8', kind: 'definition', definitionNodeId: 'c8', machineType: bv64, origin: origin('c8') },
      { id: 'v_c16', kind: 'definition', definitionNodeId: 'c16', machineType: bv64, origin: origin('c16') },
      { id: 'v_local', kind: 'definition', definitionNodeId: 'sub_local', machineType: bv64, origin: origin('sub_local') },
      { id: 'v_caller', kind: 'definition', definitionNodeId: 'add_caller', machineType: bv64, origin: origin('add_caller') },
      { id: 'v_ld', kind: 'definition', definitionNodeId: 'ld', machineType: bv32, origin: origin('ld') },
    ];
    const mssa = buildStackMssa(nodes, values);
    assert.equal(
      stackClobbers(mssa).length,
      1,
      `storing &local into [${regId} + 16] (caller area) must block noEscapeStack`,
    );
  }
});
