import assert from 'node:assert/strict';
import test from 'node:test';

import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import { buildMemorySsa } from '../../js/semantics/memoryssa/build.js';
import { createMemoryRegionRef } from '../../js/semantics/memoryssa/contract.js';

function fixture(count = 48) {
  const functionId = 'compat_memory_definition_indexing';
  const origin = id => ({ instructionIds:[id], virtualRanges:[{ start:0x1000n, end:0x1004n }] });
  const values = [{ id:'addr', kind:'entry', machineType:{ kind:'address', widthBits:64, addressSpace:'memory' }, sourceEntityId:functionId, origin:origin('addr') }];
  const nodes = [];
  const memory = { addressSpace:'memory', addressExpr:{ valueId:'addr' }, widthBits:32, endian:'little', alignment:4, volatility:false, atomic:false, ordering:'unknown', faults:[] };
  for (let index = 0; index < count; index += 1) {
    values.push(
      { id:`stored_${index}`, kind:'entry', machineType:{ kind:'bitvector', widthBits:32 }, sourceEntityId:functionId, origin:origin(`stored_${index}`) },
      { id:`loaded_${index}`, kind:'definition', machineType:{ kind:'bitvector', widthBits:32 }, definitionNodeId:`load_${index}`, sourceEntityId:`load_${index}`, origin:origin(`loaded_${index}`) },
    );
    nodes.push(
      { id:`store_${index}`, kind:'store', blockId:'b0', inputs:['addr', `stored_${index}`], outputs:[], memory, origin:origin(`store_${index}`) },
      { id:`load_${index}`, kind:'load', blockId:'b0', inputs:['addr'], outputs:[`loaded_${index}`], memory, origin:origin(`load_${index}`) },
    );
  }
  nodes.push({ id:'ret', kind:'return', blockId:'b0', inputs:[`loaded_${count - 1}`], outputs:[], origin:origin('ret') });
  const ir = createSemanticIrFunction({ schemaVersion:2, contractVersion:'2.0.0', functionId, entryBlockId:'b0',
    blocks:[{ id:'b0', nodeIds:nodes.map(node => node.id), origin:origin('block') }], values, nodes,
    completeness:'complete', unknowns:[], origin:origin('function') });
  const cfg = createSemanticCfg({ functionId, entryBlockId:'b0', blocks:[{ id:'b0', successors:[] }] });
  const region = createMemoryRegionRef({ id:'region', kind:'rooted-offset', functionId, rootEntityId:'root', offset:0, widthBits:32, origin:origin('region') });
  const memorySsa = buildMemorySsa(ir, cfg, { regions:[region], resolveRegion() { return region; }, queryAlias() { return 'must'; } });
  return { ir, cfg, memorySsa };
}

test('compat memory projection indexes canonical definitions instead of finding them per load', () => {
  const { ir, cfg, memorySsa } = fixture();
  const originalFind = Array.prototype.find;
  let definitionScans = 0;
  Array.prototype.find = function patchedFind(...args) {
    if (this === memorySsa.definitions) definitionScans += 1;
    return Reflect.apply(originalFind, this, args);
  };
  let projected;
  try { projected = projectSemanticIrV2ToLegacyV1(ir, { memorySsa, cfg }); }
  finally { Array.prototype.find = originalFind; }
  assert.equal(projected.instructions.filter(inst => inst.semanticNodeId?.startsWith('load_')).length, 48);
  assert.equal(definitionScans, 0, `compat projection rescanned canonical MemorySSA definitions ${definitionScans} times`);
});
