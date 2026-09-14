import assert from 'node:assert/strict';
import { createMemoryRegionRef } from '../../js/semantics/memoryssa/contract.js';

const base = {
  id: 'region_rooted_tls',
  kind: 'rooted-offset',
  functionId: 'function_fixture',
  rootEntityId: 'root_tls',
  offset: 0,
  widthBits: 64,
};

const tls = createMemoryRegionRef({ ...base, addressSpace: 'tls' });
assert.equal(tls.addressSpace, 'tls', 'rooted-offset must preserve a proven storage domain');
assert.equal(Object.isFrozen(tls), true, 'normalized region refs remain immutable');
assert.throws(
  () => createMemoryRegionRef({ ...base, addressSpace: '' }),
  /memory-ssa-region-address-space-required/,
  'an explicitly supplied rooted address space must be validated',
);
assert.equal(
  createMemoryRegionRef({ ...base, addressSpace: 'io' }).addressSpace,
  'io',
);
assert.equal(
  createMemoryRegionRef({ ...base }).addressSpace,
  undefined,
  'space-less rooted-offsets retain the flat-memory shape',
);

console.log('issue-5901 memoryssa rooted address-space contract: PASS');
