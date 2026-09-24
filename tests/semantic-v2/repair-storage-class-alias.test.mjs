import assert from 'node:assert/strict';
import { createMemoryRegionRef } from '../../js/semantics/memoryssa/contract.js';
import { aliasMemoryRegions } from '../../js/analysis/alias/index-v2.js';

const origin = { instructionIds:['instruction.storage-class-proof'] };
const stack = createMemoryRegionRef({
  id:'region.stack',
  kind:'stack-fixed',
  functionId:'function.storage-class-proof',
  binaryId:'binary.storage-class-proof',
  offset:'16',
  widthBits:32,
  origin,
  metadata:{ canonicalRootStorageClass:'function-local-stack' },
});
const external = createMemoryRegionRef({
  id:'region.external',
  kind:'rooted-offset',
  functionId:'function.storage-class-proof',
  binaryId:'binary.storage-class-proof',
  rootEntityId:'entity.external-entry',
  offset:'32',
  widthBits:32,
  origin,
  metadata:{ canonicalRootStorageClass:'external-entry-memory' },
});
const unclassified = createMemoryRegionRef({
  id:'region.unclassified',
  kind:'rooted-offset',
  functionId:'function.storage-class-proof',
  binaryId:'binary.storage-class-proof',
  rootEntityId:'entity.unclassified',
  offset:'32',
  widthBits:32,
  origin,
});

// #5130: entry-argument storage class does not prove separation from local stack
// (an entry argument can numerically equal a stack address), so local stack vs
// external entry memory remains conservative may-alias.
assert.equal(aliasMemoryRegions(stack, external), 'may', 'entry-argument storage class does not mint false stack NoAlias');
assert.equal(aliasMemoryRegions(stack, unclassified), 'may', 'an arbitrary rooted pointer remains conservative against stack');
console.log('semantic-v2 proven storage-class alias separation: PASS');
