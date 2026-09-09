// Issue #5411 regression: createMemorySsaContract() accepted a memory-phi
// incoming whose definitionId exists and matches the region, but whose
// definition is block-local to the OPPOSITE predecessor edge. Canonical
// MemorySSA binds every phi argument to the definition produced on its own
// edge; a swapped assignment must fail closed.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createMemoryRegionRef, createMemorySsaContract } from '../../js/semantics/memoryssa/contract.js';

const origin = { instructionIds: ['instruction_fixture'] };

function diamondCfg() {
  return createSemanticCfg({ functionId: 'function_fixture', entryBlockId: 'entry', blocks: [
    { id: 'entry', successors: [{ to: 'left', kind: 'conditional-true' }, { to: 'right', kind: 'conditional-false' }] },
    { id: 'left', successors: [{ to: 'join', kind: 'branch' }] },
    { id: 'right', successors: [{ to: 'join', kind: 'branch' }] },
    { id: 'join', successors: [] },
  ] });
}

function fixture() {
  return {
    cfg: diamondCfg(),
    region: createMemoryRegionRef({ id: 'region_stack', kind: 'stack-fixed', functionId: 'function_fixture', binaryId: 'bin_fixture', offset: -16, widthBits: 8 }),
  };
}

test('#5411 a memory-phi argument defined in its own predecessor block stays canonical', () => {
  const { cfg, region } = fixture();
  const mssa = createMemorySsaContract({ functionId: 'function_fixture', regions: [region], definitions: [
    { id: 'mem_def_left', kind: 'memory-def', regionId: 'region_stack', blockId: 'left', sourceEntityId: 'entity_left', origin },
    { id: 'mem_def_right', kind: 'memory-def', regionId: 'region_stack', blockId: 'right', sourceEntityId: 'entity_right', origin },
    { id: 'mem_phi', kind: 'memory-phi', regionId: 'region_stack', blockId: 'join', sourceEntityId: 'entity_phi', incoming: [
      { predecessorBlockId: 'left', definitionId: 'mem_def_left' },
      { predecessorBlockId: 'right', definitionId: 'mem_def_right' },
    ], origin },
  ], uses: [{ id: 'mem_use', regionId: 'region_stack', reachingDefinitionId: 'mem_phi', blockId: 'join', sourceEntityId: 'entity_read', origin }] }, { cfg });
  assert.equal(mssa.reachingDefinitionLinks[0].definitionId, 'mem_phi');
});

test('#5411 a memory-phi argument attributed to the opposite edge is rejected', () => {
  const { cfg, region } = fixture();
  assert.throws(() => createMemorySsaContract({ functionId: 'function_fixture', regions: [region], definitions: [
    { id: 'mem_def_left', kind: 'memory-def', regionId: 'region_stack', blockId: 'left', sourceEntityId: 'entity_left', origin },
    { id: 'mem_def_right', kind: 'memory-def', regionId: 'region_stack', blockId: 'right', sourceEntityId: 'entity_right', origin },
    { id: 'mem_phi', kind: 'memory-phi', regionId: 'region_stack', blockId: 'join', sourceEntityId: 'entity_phi', incoming: [
      { predecessorBlockId: 'left', definitionId: 'mem_def_right' },
      { predecessorBlockId: 'right', definitionId: 'mem_def_left' },
    ], origin },
  ], uses: [{ id: 'mem_use', regionId: 'region_stack', reachingDefinitionId: 'mem_phi', blockId: 'join', sourceEntityId: 'entity_read', origin }] }, { cfg }),
  (error) => error?.message === 'memory-ssa-phi-incoming-edge-mismatch');
});

test('#5411 a definition without a block id stays unpinned to its edge', () => {
  const { cfg, region } = fixture();
  const mssa = createMemorySsaContract({ functionId: 'function_fixture', regions: [region], definitions: [
    { id: 'mem_entry', kind: 'entry', regionId: 'region_stack', blockId: null, sourceEntityId: 'entity_entry', origin },
    { id: 'mem_phi', kind: 'memory-phi', regionId: 'region_stack', blockId: 'join', sourceEntityId: 'entity_phi', incoming: [
      { predecessorBlockId: 'left', definitionId: 'mem_entry' },
      { predecessorBlockId: 'right', definitionId: 'mem_entry' },
    ], origin },
  ], uses: [{ id: 'mem_use', regionId: 'region_stack', reachingDefinitionId: 'mem_phi', blockId: 'join', sourceEntityId: 'entity_read', origin }] }, { cfg });
  assert.equal(mssa.reachingDefinitionLinks[0].definitionId, 'mem_phi');
});
