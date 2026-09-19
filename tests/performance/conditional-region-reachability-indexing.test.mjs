import assert from 'node:assert/strict';
import test from 'node:test';

import { conditionalRegionFixture } from '../phase8/helpers/conditional-region-fixture.mjs';

test('conditional reachability reuses CFG adjacency and keyed branch trace indexes', async () => {
  const f = conditionalRegionFixture({ after:'branch' });
  assert.equal(f.structure.status, 'complete', f.structure.reason);
  const cfgEdges = f.structure.cfgEdges;
  const originalFilter = Array.prototype.filter;
  const originalSome = Array.prototype.some;
  let cfgEdgeFilters = 0;
  let branchIndexFilters = 0;
  let branchIndexSomes = 0;
  Array.prototype.filter = function patchedFilter(...args) {
    if (this === cfgEdges) cfgEdgeFilters += 1;
    if (this.length && this[0]?.instruction && Object.hasOwn(this[0], 'row') && Object.hasOwn(this[0], 'address')) {
      branchIndexFilters += 1;
    }
    return Reflect.apply(originalFilter, this, args);
  };
  Array.prototype.some = function patchedSome(...args) {
    if (this.length && this[0]?.instruction && Object.hasOwn(this[0], 'row') && Object.hasOwn(this[0], 'address')) {
      branchIndexSomes += 1;
    }
    return Reflect.apply(originalSome, this, args);
  };
  let result;
  try { result = await f.run(); }
  finally {
    Array.prototype.filter = originalFilter;
    Array.prototype.some = originalSome;
  }
  assert.equal(result.status, 'complete', result.reason);
  assert.equal(cfgEdgeFilters, 0, `reachability filtered the complete CFG edge list ${cfgEdgeFilters} times`);
  assert.equal(branchIndexFilters, 0, `reachability filtered the branch trace index ${branchIndexFilters} times`);
  assert.equal(branchIndexSomes, 0, `reachability linearly searched the branch trace index ${branchIndexSomes} times`);
});
