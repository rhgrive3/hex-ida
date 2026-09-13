import assert from 'node:assert/strict';
import { createMemoryRegionRef, createMemorySsaContract } from '../../js/semantics/memoryssa/contract.js';
import { validateMemorySsa } from '../../js/semantics/memoryssa/validate.js';

const origin = { instructionIds: ['i0'] };

// #5359: a function-local (stack-fixed) region owned by a *different* function
// must not be accepted into this function's MemorySSA contract.

const foreignStack = createMemoryRegionRef({
  id: 'r_foreign',
  kind: 'stack-fixed',
  functionId: 'foreign',
  offset: 0,
});

assert.throws(
  () => createMemorySsaContract({
    functionId: 'owner',
    regions: [foreignStack],
    definitions: [{
      id: 'd',
      kind: 'entry',
      regionId: 'r_foreign',
      sourceEntityId: 'entry',
      origin,
    }],
    uses: [],
  }),
  (error) => error instanceof TypeError && error.message === 'memory-ssa-region-function-mismatch',
);

// A function-local region owned by the contract function stays valid.
const ownStack = createMemoryRegionRef({
  id: 'r_own',
  kind: 'stack-fixed',
  functionId: 'owner',
  offset: -16,
});
const own = createMemorySsaContract({
  functionId: 'owner',
  regions: [ownStack],
  definitions: [{
    id: 'd_own',
    kind: 'entry',
    regionId: 'r_own',
    sourceEntityId: 'entry',
    origin,
  }],
  uses: [],
});
assert.equal(own.functionId, 'owner');
assert.equal(own.regions[0].functionId, 'owner');

// Function-unscoped regions (functionId null) are unaffected.
const globalRegion = createMemoryRegionRef({
  id: 'r_global',
  kind: 'global-absolute',
  binaryId: 'bin_fixture',
  address: 0x2000n,
});
const withGlobal = createMemorySsaContract({
  functionId: 'owner',
  regions: [globalRegion],
  definitions: [{
    id: 'd_global',
    kind: 'entry',
    regionId: 'r_global',
    sourceEntityId: 'entry',
    origin,
  }],
  uses: [],
});
assert.equal(withGlobal.regions[0].functionId, null);

// The same rejection arrives through validateMemorySsa: it rebuilds the
// contract from the raw artifact fields, so a foreign-function region is
// fail-closed there too — with and without a definition referencing it.
assert.throws(
  () => validateMemorySsa({
    functionId: 'owner',
    regions: [{ ...foreignStack }],
    definitions: [],
    uses: [],
  }),
  (error) => error instanceof TypeError && error.message === 'memory-ssa-region-function-mismatch',
);
assert.throws(
  () => validateMemorySsa({
    functionId: 'owner',
    regions: [{ ...foreignStack }],
    definitions: [{
      id: 'd_foreign',
      kind: 'entry',
      regionId: 'r_foreign',
      sourceEntityId: 'entry',
      origin,
    }],
    uses: [],
  }),
  (error) => error instanceof TypeError && error.message === 'memory-ssa-region-function-mismatch',
);
assert.doesNotThrow(
  () => validateMemorySsa({
    functionId: 'owner',
    regions: [{ ...ownStack }],
    definitions: [{
      id: 'd_own',
      kind: 'entry',
      regionId: 'r_own',
      sourceEntityId: 'entry',
      origin,
    }],
    uses: [],
  }),
);

console.log('issue-5359 foreign-function stack region contract: ok');
