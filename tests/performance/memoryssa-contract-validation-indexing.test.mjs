import assert from 'node:assert/strict';
import test from 'node:test';

import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createMemoryRegionRef, createMemorySsaContract } from '../../js/semantics/memoryssa/contract.js';

const origin = { instructionIds:['instruction_fixture'] };

test('MemorySSA PHIs reuse canonical CFG predecessor facts instead of rescanning the same block', () => {
  const functionId = 'memoryssa_contract_indexing';
  const predecessorCount = 40;
  const phiCount = 40;
  const predecessorIds = Array.from({ length:predecessorCount }, (_, index) => `pred_${String(index).padStart(3, '0')}`);
  const cfg = createSemanticCfg({
    functionId,
    entryBlockId:'entry',
    blocks:[
      { id:'entry', successors:predecessorIds.map((to) => ({ to, kind:'branch' })) },
      ...predecessorIds.map((id) => ({ id, successors:[{ to:'join', kind:'branch' }] })),
      { id:'join', successors:[] },
    ],
  });
  const join = cfg.blocks.find((block) => block.id === 'join');
  assert.ok(join);

  const regions = [];
  const definitions = [];
  for (let index = 0; index < phiCount; index += 1) {
    const regionId = `region_${String(index).padStart(3, '0')}`;
    const entryId = `entry_${String(index).padStart(3, '0')}`;
    regions.push(createMemoryRegionRef({
      id:regionId, kind:'rooted-offset', functionId, rootEntityId:`root_${index}`, offset:0, widthBits:32,
    }));
    definitions.push({
      id:entryId, kind:'entry', regionId, blockId:null, sourceEntityId:`source_entry_${index}`, origin,
    });
    definitions.push({
      id:`phi_${String(index).padStart(3, '0')}`,
      kind:'memory-phi', regionId, blockId:'join', sourceEntityId:`source_phi_${index}`, origin,
      incoming:predecessorIds.map((predecessorBlockId) => ({ predecessorBlockId, definitionId:entryId })),
    });
  }

  const originalIncludes = Array.prototype.includes;
  const originalSlice = Array.prototype.slice;
  let predecessorIncludes = 0;
  let predecessorSlices = 0;
  Array.prototype.includes = function (...args) {
    if (this === join.predecessors) predecessorIncludes += 1;
    return Reflect.apply(originalIncludes, this, args);
  };
  Array.prototype.slice = function (...args) {
    if (this === join.predecessors) predecessorSlices += 1;
    return Reflect.apply(originalSlice, this, args);
  };
  let contract;
  try {
    contract = createMemorySsaContract({ functionId, regions, definitions, uses:[] }, {
      cfg,
      budget:{ maxRegions:100, maxDefinitions:200, maxUses:1, maxWorkItems:100000 },
    });
  } finally {
    Array.prototype.includes = originalIncludes;
    Array.prototype.slice = originalSlice;
  }
  assert.equal(contract.definitions.length, phiCount * 2);
  // Legacy validation calls join.predecessors.includes() once per incoming edge
  // (1,600 times here) and re-slices/sorts the same predecessor row per PHI.
  assert.ok(predecessorIncludes <= 1, `join predecessors were membership-scanned ${predecessorIncludes} times`);
  assert.ok(predecessorSlices <= 2, `join predecessors were re-sliced ${predecessorSlices} times`);
});
