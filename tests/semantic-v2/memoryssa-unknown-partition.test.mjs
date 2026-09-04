import assert from 'node:assert/strict';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import {
  buildMemorySsa,
  createMemoryRegionRef,
  validateMemorySsa,
} from '../../js/semantics/memoryssa/index.js';
import { reachingMemoryDefinition } from '../../js/semantics/memoryssa/queries.js';

const functionId = 'function_memoryssa_unknown_partition';
const origin = (id) => ({ instructionIds: [`instruction_${id}`] });
const addressType = { kind: 'address', widthBits: 64, addressSpace: 'memory' };
const memory = (addressValueId) => ({
  addressSpace: 'memory',
  addressValueId,
  widthBits: 64,
  endian: 'little',
  volatility: false,
  atomic: false,
  ordering: 'unknown',
});

const count = 12;
const regions = Array.from({ length: count }, (_, index) => createMemoryRegionRef({
  id: `region_unknown_${index}`,
  kind: 'unknown',
  functionId,
  uncertaintyIdentity: { fixture: 'unresolved-pointer', index },
}));
const regionByAddress = new Map(regions.map((region, index) => [`addr_${index}`, region]));
const nodes = [
  ...regions.map((_, index) => ({
    id: `store_${index}`,
    kind: 'store',
    blockId: 'entry',
    inputs: [],
    outputs: [],
    origin: origin(`store_${index}`),
    memory: memory(`addr_${index}`),
  })),
  {
    id: 'load_last',
    kind: 'load',
    blockId: 'entry',
    inputs: [],
    outputs: [],
    origin: origin('load_last'),
    memory: memory(`addr_${count - 1}`),
  },
];
const values = regions.map((_, index) => ({
  id: `addr_${index}`,
  kind: 'entry',
  machineType: addressType,
  origin: origin(`addr_${index}`),
}));
const ir = createSemanticIrFunction({
  functionId,
  entryBlockId: 'entry',
  blocks: [{ id: 'entry', nodeIds: nodes.map((node) => node.id), origin: origin('entry') }],
  values,
  nodes,
  completeness: 'complete',
  unknowns: [],
  origin: origin('function'),
});
const cfg = createSemanticCfg({
  functionId,
  entryBlockId: 'entry',
  blocks: [{ id: 'entry', successors: [] }],
});
const memorySsa = buildMemorySsa(ir, cfg, {
  resolveRegion(access) { return regionByAddress.get(access.addressExpr.valueId); },
  queryAlias(left, right) {
    if (left.kind === 'unknown' || right.kind === 'unknown') return 'may';
    return left.id === right.id ? 'must' : 'no';
  },
});

const unknownRegions = memorySsa.regions.filter((region) => region.kind === 'unknown');
assert.equal(
  unknownRegions.length,
  1,
  'unresolved accesses must share one conservative MemorySSA state partition',
);
const storeDefinitions = memorySsa.definitions.filter((definition) =>
  String(definition.sourceEntityId).startsWith('store_'));
assert.equal(
  storeDefinitions.length,
  count,
  'N unresolved stores must create O(N), not O(N^2), state definitions',
);
const use = memorySsa.uses.find((candidate) => candidate.sourceEntityId === 'load_last');
assert.ok(use, 'final unresolved load must remain represented');
assert.equal(use.aliasRelation, 'may', 'partition collapse must not manufacture MustAlias');
assert.equal(reachingMemoryDefinition(memorySsa, use).sourceEntityId, `store_${count - 1}`);
assert.doesNotThrow(() => validateMemorySsa(memorySsa, { cfg }));

console.log('semantic-v2 MemorySSA canonical unknown partition: PASS');
