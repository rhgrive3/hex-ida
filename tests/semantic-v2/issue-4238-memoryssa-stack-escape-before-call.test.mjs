import assert from 'node:assert/strict';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import { buildMemorySsa } from '../../js/semantics/memoryssa/build.js';

const origin = (id) => ({ instructionIds: [`instruction_${id}`] });
const addressType = { kind: 'address', widthBits: 64, addressSpace: 'memory' };
const bitvector64 = { kind: 'bitvector', widthBits: 64 };
const memory = (addressValueId) => ({ addressSpace: 'memory', addressValueId, widthBits: 32, endian: 'little', volatility: false, atomic: false, ordering: 'unknown' });
const stackRegion = { id: 'region_local_stack', kind: 'stack-fixed', functionId: 'fn_issue_4238', offset: -8, widthBits: 32 };
const globalRegion = { id: 'region_global', kind: 'global', functionId: 'fn_issue_4238', offset: 0, widthBits: 32 };
const provider = {
  resolveRegion: (mem) => (mem && String(mem.addressValueId) === 'addr_global' ? globalRegion : stackRegion),
  queryAlias: () => 'unknown',
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
const spRead = {
  id: 'read_sp', kind: 'state-read', blockId: 'entry', inputs: [], outputs: ['v_sp'],
  variable: { key: 'phys.sp', kind: 'physical-state', scope: 'function', physicalIdentity: { kind: 'register', registerId: 'sp' } },
  origin: origin('read_sp'),
};
const const8 = { id: 'const_8', kind: 'const', blockId: 'entry', operator: 'const', inputs: [], outputs: ['v_c8'], attributes: { bitvectorValue: { kind: 'bitvector', widthBits: 64, value: 8n } }, origin: origin('const_8') };
const const16 = { id: 'const_16', kind: 'const', blockId: 'entry', operator: 'const', inputs: [], outputs: ['v_c16'], attributes: { bitvectorValue: { kind: 'bitvector', widthBits: 64, value: 16n } }, origin: origin('const_16') };
const localAddress = { id: 'sub_local', kind: 'binary', blockId: 'entry', operator: 'sub', inputs: ['v_sp', 'v_c8'], outputs: ['v_local'], origin: origin('sub_local') };
const frameSlot = { id: 'sub_frame', kind: 'binary', blockId: 'entry', operator: 'sub', inputs: ['v_sp', 'v_c16'], outputs: ['v_frame'], origin: origin('sub_frame') };
const loadAfter = { id: 'load_after', kind: 'load', blockId: 'entry', inputs: [], outputs: ['v_ld'], memory: memory('v_local'), origin: origin('load_after') };

function publishTo(addressValueId, storedValueId, id) {
  return { id, kind: 'store', blockId: 'entry', inputs: [addressValueId, storedValueId], outputs: [], memory: memory(addressValueId), origin: origin(id) };
}

function stackClobberDefs(nodes) {
  const ir = createSemanticIrFunction({
    functionId: 'fn_issue_4238',
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', nodeIds: nodes.map((n) => n.id), origin: origin('entry') }],
    values: [
      { id: 'v_sp', kind: 'definition', definitionNodeId: 'read_sp', machineType: bitvector64, origin: origin('read_sp') },
      { id: 'v_c8', kind: 'definition', definitionNodeId: 'const_8', machineType: bitvector64, origin: origin('const_8') },
      { id: 'v_c16', kind: 'definition', definitionNodeId: 'const_16', machineType: bitvector64, origin: origin('const_16') },
      { id: 'v_local', kind: 'definition', definitionNodeId: 'sub_local', machineType: bitvector64, origin: origin('sub_local') },
      { id: 'v_frame', kind: 'definition', definitionNodeId: 'sub_frame', machineType: bitvector64, origin: origin('sub_frame') },
      { id: 'v_ld', kind: 'definition', definitionNodeId: 'load_after', machineType: { kind: 'bitvector', widthBits: 32 }, origin: origin('load_after') },
      { id: 'addr_global', kind: 'entry', machineType: addressType, origin: origin('addr_global') },
      { id: 'addr_unknown', kind: 'unknown', machineType: addressType, origin: origin('addr_unknown') },
    ],
    nodes,
    completeness: 'partial',
    unknowns: [{ reason: 'unresolved-call', categories: ['memory'] }],
    origin: origin('fn'),
  });
  const cfg = createSemanticCfg({ functionId: 'fn_issue_4238', entryBlockId: 'entry', blocks: [{ id: 'entry', successors: [] }] });
  const mssa = buildMemorySsa(ir, cfg, provider);
  return mssa.definitions.filter((d) => d.sourceEntityId === 'call_unknown' && d.kind === 'call-clobber' && d.regionId === stackRegion.id);
}

// #4238: the &local store publishes the stack address to a global before the
// call, so the argument-less unknown callee can still reach `local`.
assert.equal(stackClobberDefs([spRead, const8, const16, localAddress, frameSlot, publishTo('addr_global', 'v_local', 'store_esc'), unknownCall('call_unknown'), loadAfter]).length, 1,
  'a stack address published to a global must keep the unknown-call stack clobber');
assert.equal(stackClobberDefs([spRead, const8, const16, localAddress, frameSlot, publishTo('addr_unknown', 'v_local', 'store_esc'), unknownCall('call_unknown'), loadAfter]).length, 1,
  'a stack address published through an unknown pointer must keep the stack clobber');

// A proven non-escaping local keeps the existing precision, and a stack slot
// that only stores into another stack slot is not a publication.
assert.equal(stackClobberDefs([spRead, const8, const16, localAddress, frameSlot, unknownCall('call_unknown'), loadAfter]).length, 0,
  'a non-escaping stack local must keep the noEscapeStack precision');
assert.equal(stackClobberDefs([spRead, const8, const16, localAddress, frameSlot, publishTo('v_frame', 'v_local', 'store_frame'), unknownCall('call_unknown'), loadAfter]).length, 0,
  'storing a stack pointer into another stack slot is not an escape');

// The publication must be visible to the callee: a store after the call does
// not retroactively clobber the earlier call boundary.
assert.equal(stackClobberDefs([spRead, const8, const16, localAddress, frameSlot, unknownCall('call_unknown'), publishTo('addr_global', 'v_local', 'store_after'), loadAfter]).length, 0,
  'a publication after the call must not clobber that call');

console.log('MemorySSA stack-address escape before unknown call (#4238): PASS');
