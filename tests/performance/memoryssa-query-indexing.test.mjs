import assert from 'node:assert/strict';
import test from 'node:test';

import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import { createMemoryRegionRef } from '../../js/semantics/memoryssa/contract.js';
import { buildMemorySsa } from '../../js/semantics/memoryssa/build.js';
import { explainMemoryPath, getMemoryDefinition, getMemoryUse, memoryVersionAtBlock, reachingMemoryDefinition } from '../../js/semantics/memoryssa/queries.js';

const origin = (id) => ({ instructionIds:[`instruction_${id}`] });
const bit64 = { kind:'address', widthBits:64, addressSpace:'memory' };
const memory = { addressSpace:'memory', addressValueId:'addr', widthBits:32, endian:'little', volatility:false, atomic:false, ordering:'unknown' };

function fixture(count = 64) {
  const functionId = `memory_query_index_${count}`;
  const nodes = [];
  for (let index = 0; index < count; index += 1) nodes.push({
    id:`store_${index}`, kind:'store', blockId:'entry', inputs:[], outputs:[], origin:origin(`store_${index}`), memory,
  });
  for (let index = 0; index < count; index += 1) nodes.push({
    id:`load_${index}`, kind:'load', blockId:'entry', inputs:[], outputs:[], origin:origin(`load_${index}`), memory,
  });
  const ir = createSemanticIrFunction({
    functionId, entryBlockId:'entry',
    blocks:[{ id:'entry', nodeIds:nodes.map((node) => node.id), origin:origin('entry') }],
    values:[{ id:'addr', kind:'entry', machineType:bit64, origin:origin('addr') }],
    nodes, completeness:'complete', unknowns:[], origin:origin('function'),
  });
  const cfg = createSemanticCfg({ functionId, entryBlockId:'entry', blocks:[{ id:'entry', successors:[] }] });
  const region = createMemoryRegionRef({ id:'region', kind:'rooted-offset', functionId, rootEntityId:'root', offset:0, widthBits:32 });
  return buildMemorySsa(ir, cfg, {
    regions:[region], resolveRegion() { return region; }, queryAlias(left, right) { return left.id === right.id ? 'must' : 'no'; },
  });
}

test('canonical MemorySSA point queries build definition/use indexes once', () => {
  const memorySsa = fixture();
  const originalMap = Array.prototype.map;
  let definitionMapCalls = 0;
  let useMapCalls = 0;
  Array.prototype.map = function patchedMap(...args) {
    if (this === memorySsa.definitions) definitionMapCalls += 1;
    if (this === memorySsa.uses) useMapCalls += 1;
    return Reflect.apply(originalMap, this, args);
  };
  try {
    for (const definition of memorySsa.definitions) assert.equal(getMemoryDefinition(memorySsa, definition.id), definition);
    for (const use of memorySsa.uses) {
      assert.equal(getMemoryUse(memorySsa, use.id), use);
      assert.equal(reachingMemoryDefinition(memorySsa, use).id, use.reachingDefinitionId);
    }
  } finally {
    Array.prototype.map = originalMap;
  }
  assert.ok(definitionMapCalls <= 1, `definitions were re-indexed ${definitionMapCalls} times`);
  assert.ok(useMapCalls <= 1, `uses were re-indexed ${useMapCalls} times`);
});

test('canonical MemorySSA block-version queries reuse the per-region state index', () => {
  const memorySsa = fixture(8);
  const state = memorySsa.blockStates.find((item) => item.blockId === 'entry');
  assert.ok(state);
  const expectedEntry = state.entry.find((item) => item.regionId === 'region')?.definitionId ?? null;
  const expectedExit = state.exit.find((item) => item.regionId === 'region')?.definitionId ?? null;
  const originalFind = Array.prototype.find;
  let entryScans = 0;
  let exitScans = 0;
  Array.prototype.find = function patchedFind(...args) {
    if (this === state.entry) entryScans += 1;
    if (this === state.exit) exitScans += 1;
    return Reflect.apply(originalFind, this, args);
  };
  try {
    for (let index = 0; index < 128; index += 1) {
      assert.equal(memoryVersionAtBlock(memorySsa, 'entry', 'region', 'entry'), expectedEntry);
      assert.equal(memoryVersionAtBlock(memorySsa, 'entry', 'region', 'exit'), expectedExit);
      assert.equal(memoryVersionAtBlock(memorySsa, 'entry', 'missing', 'exit'), null);
    }
  } finally {
    Array.prototype.find = originalFind;
  }
  assert.ok(entryScans <= 1, `entry state was rescanned ${entryScans} times`);
  assert.ok(exitScans <= 1, `exit state was rescanned ${exitScans} times`);
});

test('mutable unbranded MemorySSA query inputs retain live observation semantics', () => {
  const definition = { id:'definition_before', regionId:'region' };
  const use = { id:'use_before', reachingDefinitionId:'definition_before' };
  const entry = { regionId:'region', definitionId:'definition_before' };
  const mutable = {
    definitions:[definition], uses:[use], defUseLinks:[], accessMetadata:[],
    blockStates:[{ blockId:'entry', entry:[entry], exit:[] }],
  };
  assert.equal(getMemoryDefinition(mutable, 'definition_before'), definition);
  assert.equal(getMemoryUse(mutable, 'use_before'), use);
  assert.equal(memoryVersionAtBlock(mutable, 'entry', 'region', 'entry'), 'definition_before');
  definition.id = 'definition_after';
  use.id = 'use_after';
  entry.definitionId = 'definition_after';
  assert.equal(getMemoryDefinition(mutable, 'definition_before'), null);
  assert.equal(getMemoryDefinition(mutable, 'definition_after'), definition);
  assert.equal(getMemoryUse(mutable, 'use_before'), null);
  assert.equal(getMemoryUse(mutable, 'use_after'), use);
  assert.equal(memoryVersionAtBlock(mutable, 'entry', 'region', 'entry'), 'definition_after');
});


test('MemorySSA path traversal keeps lexical priority without repeatedly sorting the work queue', () => {
  const fanIn = 1200;
  const leaves = Array.from({ length:fanIn }, (_, index) => ({
    id:`d_${String(index).padStart(5, '0')}`,
    previousDefinitionIds:[], incoming:[],
  }));
  const memorySsa = {
    definitions:[...leaves, { id:'root', previousDefinitionIds:leaves.map((item) => item.id), incoming:[] }],
    uses:[{ id:'use', reachingDefinitionId:'root' }],
  };
  let largeSorts = 0;
  const originalSort = Array.prototype.sort;
  Array.prototype.sort = function (...args) {
    if (this.length >= 500) largeSorts += 1;
    return Reflect.apply(originalSort, this, args);
  };
  let path;
  try {
    path = explainMemoryPath(memorySsa, 'use', { maxDefinitions:fanIn + 2 });
  } finally {
    Array.prototype.sort = originalSort;
  }
  assert.equal(path.nodes.length, fanIn + 1);
  assert.equal(path.nodes[0].id, 'd_00000');
  assert.equal(path.nodes.at(-1).id, 'root');
  // Final node/edge canonicalization still sorts; the traversal queue must not.
  assert.ok(largeSorts <= 4, `path traversal performed ${largeSorts} large-array sorts`);
});
