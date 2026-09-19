import assert from 'node:assert/strict';
import test from 'node:test';

import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import { createMemoryRegionRef } from '../../js/semantics/memoryssa/contract.js';
import { buildMemorySsa } from '../../js/semantics/memoryssa/build.js';

const functionId = 'memoryssa_stack_escape_index_perf';
const origin = (id) => ({ instructionIds:[`instruction_${id}`] });
const bit64 = { kind:'bitvector', widthBits:64 };
const regs = ['x0','x1','x2','x3','x4','x5','x6','x7'];

function fixture(callCount = 40) {
  const values = [];
  const nodes = [];
  for (let index = 0; index < regs.length; index += 1) {
    values.push({
      id:`value_${index}`, kind:'definition', definitionNodeId:`const_${index}`,
      machineType:bit64, origin:origin(`value_${index}`),
    });
    nodes.push({
      id:`const_${index}`, kind:'const', blockId:'entry', inputs:[], outputs:[`value_${index}`],
      operator:'const', attributes:{ bitvectorValue:{ kind:'bitvector', widthBits:64, value:BigInt(index) } },
      origin:origin(`const_${index}`),
    });
    nodes.push({
      id:`write_${index}`, kind:'state-write', blockId:'entry', inputs:[`value_${index}`], outputs:[],
      variable:{ key:`phys.${regs[index]}`, kind:'physical-state', scope:'function', physicalIdentity:{ kind:'register', registerId:regs[index] } },
      origin:origin(`write_${index}`),
    });
  }
  for (let index = 0; index < callCount; index += 1) nodes.push({
    id:`call_${index}`, kind:'call', blockId:'entry', inputs:[], outputs:[],
    call:{
      targetValueIds:[], targetEntityIds:[], arguments:[], returns:[], stateReads:[], stateWrites:[],
      memoryRead:{scope:'unknown'}, memoryWrite:{scope:'unknown'}, controlEffects:[],
      determinism:'unknown', noreturn:'unknown', mayThrow:'unknown', summarySource:'fixture',
      completeness:'unknown', unknownEffects:{reason:'unresolved-call',categories:['memory']},
    },
    completeness:'unknown', unknown:{reason:'unresolved-call',categories:['memory']}, origin:origin(`call_${index}`),
  });
  const ir = createSemanticIrFunction({
    functionId, entryBlockId:'entry',
    blocks:[{ id:'entry', nodeIds:nodes.map((node) => node.id), origin:origin('entry') }],
    values, nodes, completeness:'partial', unknowns:[{reason:'unresolved-call',categories:['memory']}], origin:origin('function'),
  });
  const cfg = createSemanticCfg({ functionId, entryBlockId:'entry', blocks:[{ id:'entry', successors:[] }] });
  const region = createMemoryRegionRef({ id:'region', kind:'rooted-offset', functionId, rootEntityId:'root', offset:0, widthBits:32 });
  return { ir, cfg, region };
}

test('MemorySSA reuses canonical stack-escape value/node indexes across unresolved calls', () => {
  const { ir, cfg, region } = fixture();
  const originalMap = Array.prototype.map;
  let valueMaps = 0;
  let nodeMaps = 0;
  Array.prototype.map = function (...args) {
    if (this === ir.values) valueMaps += 1;
    if (this === ir.nodes) nodeMaps += 1;
    return Reflect.apply(originalMap, this, args);
  };
  let memorySsa;
  try {
    memorySsa = buildMemorySsa(ir, cfg, {
      regions:[region], resolveRegion() { return region; }, queryAlias(left, right) { return left.id === right.id ? 'must' : 'no'; },
    });
  } finally {
    Array.prototype.map = originalMap;
  }
  assert.ok(memorySsa.definitions.length > 0);
  // Legacy behavior rebuilt values once per call and nodes once per recovered
  // argument state-write: 42 and 323 full-array maps for this fixture.
  assert.ok(valueMaps <= 3, `values were re-indexed ${valueMaps} times`);
  assert.ok(nodeMaps <= 5, `nodes were re-indexed ${nodeMaps} times`);
});
