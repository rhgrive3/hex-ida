import assert from 'node:assert/strict';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import { createMemoryRegionRef } from '../../js/semantics/memoryssa/contract.js';
import { buildMemorySsa } from '../../js/semantics/memoryssa/build.js';

const functionId = 'function_issue_3618';
const origin = (id) => ({ instructionIds: [`instruction_${id}`] });
const addressType = { kind: 'address', widthBits: 64, addressSpace: 'memory' };
const cfg = createSemanticCfg({
  functionId,
  entryBlockId: 'entry',
  blocks: [{ id: 'entry', successors: [] }],
});
const region = createMemoryRegionRef({
  id: 'region_issue_3618_root',
  kind: 'rooted-offset',
  functionId,
  rootEntityId: 'root_issue_3618',
  offset: 0,
  widthBits: 32,
});

function build(addressDisplacement) {
  const store = {
    id: 'store',
    kind: 'store',
    blockId: 'entry',
    inputs: [],
    outputs: [],
    origin: origin('store'),
    memory: {
      addressSpace: 'memory',
      addressValueId: 'addr',
      widthBits: 32,
      endian: 'little',
      volatility: false,
      atomic: false,
      ordering: 'unknown',
    },
    attributes: {
      machineEffects: {
        operationMetadata: {
          addressing: { addressDisplacement },
        },
      },
    },
  };
  const ir = createSemanticIrFunction({
    functionId,
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', nodeIds: ['store'], origin: origin('entry') }],
    values: [{ id: 'addr', kind: 'entry', machineType: addressType, origin: origin('addr') }],
    nodes: [store],
    completeness: 'complete',
    unknowns: [],
    origin: origin('function'),
  });
  return buildMemorySsa(ir, cfg, {
    regions: [region],
    resolveRegion() { return region; },
    queryAlias() { return 'unknown'; },
  });
}

function storeDefinition(memorySsa) {
  return memorySsa.definitions.find((definition) =>
    definition.sourceEntityId === 'store' && definition.regionId === region.id);
}

// Primitive integer metadata remains eligible for exact byte-range refinement.
assert.equal(storeDefinition(build('8')), undefined);
assert.equal(storeDefinition(build(8)), undefined);

// Structured metadata must not be coerced into exact byte-range authority.
for (const malformed of [['8'], [8]]) {
  const definition = storeDefinition(build(malformed));
  assert.ok(definition, 'malformed displacement must conservatively clobber the region');
  assert.equal(definition.kind, 'unknown-clobber');
  assert.equal(definition.aliasRelation, 'unknown');
  assert.notEqual(
    definition.proof?.providerProof?.evidenceIds?.includes('canonical-memory-byte-range-disjoint'),
    true,
  );
}

console.log('issue #3618 MemorySSA displacement type boundary: PASS');
