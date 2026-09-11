import assert from 'node:assert/strict';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import { buildMemorySsa } from '../../js/semantics/memoryssa/build.js';

const origin = (id) => ({ instructionIds: [`instruction_${id}`] });
const addressType = { kind: 'address', widthBits: 64, addressSpace: 'memory' };
const bitvector64 = { kind: 'bitvector', widthBits: 64 };
const memory = (addressValueId) => ({ addressSpace: 'memory', addressValueId, widthBits: 32, endian: 'little', volatility: false, atomic: false, ordering: 'unknown' });
const stackRegion = { id: 'region_local_stack', kind: 'stack-fixed', functionId: 'fn_issue_5848', offset: -8, widthBits: 32 };
const provider = {
  resolveRegion() { return stackRegion; },
  queryAlias() { return 'unknown'; },
};
const unknownCall = (id) => ({
  id, kind: 'call', blockId: 'entry', inputs: [], outputs: [],
  call: {
    targetValueIds: [], targetEntityIds: [], arguments: [], returns: [], stateReads: [], stateWrites: [],
    memoryRead: { scope: 'unknown' }, memoryWrite: { scope: 'unknown' }, controlEffects: [],
    determinism: 'unknown', noreturn: 'unknown', mayThrow: 'unknown', summarySource: 'fixture',
    completeness: 'unknown', unknownEffects: { reason: 'unresolved-call', categories: ['memory'] },
  },
  completeness: 'unknown', unknown: { reason: 'unresolved-call', categories: ['memory'] }, origin: origin(id),
});

function stackPointerRead(registerId) {
  return {
    id: 'read_sp', kind: 'state-read', blockId: 'entry', inputs: [], outputs: ['v_sp'],
    variable: { key: `phys.${registerId}`, kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId } },
    origin: origin('read_sp'),
  };
}

function argumentWrite(registerId, idSuffix = '') {
  return {
    id: `write_${registerId}`, kind: 'state-write', blockId: 'entry', inputs: ['v_local'], outputs: [],
    variable: { key: `phys.${registerId}`, kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId } },
    origin: origin(`write_${registerId}${idSuffix}`),
  };
}

function irFor(nodes) {
  return createSemanticIrFunction({
    functionId: 'fn_issue_5848',
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', nodeIds: nodes.map((n) => n.id), origin: origin('entry') }],
    values: [
      { id: 'v_sp', kind: 'definition', definitionNodeId: 'read_sp', machineType: bitvector64, origin: origin('read_sp') },
      { id: 'v_c8', kind: 'definition', definitionNodeId: 'const_8', machineType: bitvector64, origin: origin('const_8') },
      { id: 'v_local', kind: 'definition', definitionNodeId: 'sub_local', machineType: bitvector64, origin: origin('sub_local') },
      { id: 'v_ld', kind: 'definition', definitionNodeId: 'load_after', machineType: { kind: 'bitvector', widthBits: 32 }, origin: origin('load_after') },
      { id: 'addr_A', kind: 'entry', machineType: addressType, origin: origin('addr_A') },
    ],
    nodes,
    completeness: 'partial',
    unknowns: [{ reason: 'unresolved-call', categories: ['memory'] }],
    origin: origin('fn'),
  });
}

const cfg = createSemanticCfg({ functionId: 'fn_issue_5848', entryBlockId: 'entry', blocks: [{ id: 'entry', successors: [] }] });
const baseNodes = [
  stackPointerRead('rsp'),
  { id: 'const_8', kind: 'const', blockId: 'entry', operator: 'const', inputs: [], outputs: ['v_c8'], attributes: { bitvectorValue: { kind: 'bitvector', widthBits: 64, value: 8n } }, origin: origin('const_8') },
  { id: 'sub_local', kind: 'binary', blockId: 'entry', operator: 'sub', inputs: ['v_sp', 'v_c8'], outputs: ['v_local'], origin: origin('sub_local') },
];
const loadAfter = { id: 'load_after', kind: 'load', blockId: 'entry', inputs: [], outputs: ['v_ld'], memory: memory('addr_A'), origin: origin('load_after') };

function stackClobberDefs(nodes) {
  const mssa = buildMemorySsa(irFor(nodes), cfg, provider);
  return mssa.definitions.filter((d) => d.sourceEntityId === 'call_unknown' && d.kind === 'call-clobber' && d.regionId === stackRegion.id);
}

// #5848 case A: stack-derived pointer through SysV `rdi` must keep the
// unknown-call stack clobber. The arm64-sp heuristic could not see `rsp`
// stack roots nor the `rdi` argument write and minted noEscapeStack=true.
{
  const defs = stackClobberDefs([...baseNodes, argumentWrite('rdi'), unknownCall('call_unknown'), loadAfter]);
  assert.equal(defs.length, 1, 'x86-64 rdi stack-derived argument must block noEscapeStack');
}
// Every SysV argument register blocks the claim; Win64 r8/r9 are shared.
for (const registerId of ['rsi', 'rdx', 'rcx', 'r8', 'r9']) {
  const defs = stackClobberDefs([...baseNodes, argumentWrite(registerId), unknownCall('call_unknown'), loadAfter]);
  assert.equal(defs.length, 1, `x86-64 ${registerId} argument write must block noEscapeStack`);
}
// ARM64 canonical spelling keeps working (regression guard for sp/x29).
{
  const defs = stackClobberDefs([
    stackPointerRead('x29'), { id: 'const_8', kind: 'const', blockId: 'entry', operator: 'const', inputs: [], outputs: ['v_c8'], attributes: { bitvectorValue: { kind: 'bitvector', widthBits: 64, value: 8n } }, origin: origin('const_8') },
    { id: 'sub_local', kind: 'binary', blockId: 'entry', operator: 'sub', inputs: ['v_sp', 'v_c8'], outputs: ['v_local'], origin: origin('sub_local') },
    { id: 'write_x0', kind: 'state-write', blockId: 'entry', inputs: ['v_local'], outputs: [], variable: { key: 'phys.x0', kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId: 'x0' } }, origin: origin('write_x0') },
    unknownCall('call_unknown'), loadAfter,
  ]);
  assert.equal(defs.length, 1, 'arm64 x29 root + x0 argument write must still block noEscapeStack');
}
// An unknown value in a recognized argument register stays conservative.
{
  const nodes = [
    stackPointerRead('rsp'),
    { id: 'const_8', kind: 'const', blockId: 'entry', operator: 'const', inputs: [], outputs: ['v_c8'], attributes: { bitvectorValue: { kind: 'bitvector', widthBits: 64, value: 8n } }, origin: origin('const_8') },
    { id: 'sub_local', kind: 'binary', blockId: 'entry', operator: 'sub', inputs: ['v_sp', 'v_c8'], outputs: ['v_local'], origin: origin('sub_local') },
    argumentWrite('rdx'), unknownCall('call_unknown'), loadAfter,
  ];
  const defs = stackClobberDefs(nodes);
  assert.equal(defs.length, 1, 'unknown argument definitions must stay conservative');
}

console.log('MemorySSA x86-64 stack-escape noEscapeStack regressions (#5848): PASS');
