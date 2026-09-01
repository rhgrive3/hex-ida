import assert from 'node:assert/strict';
import test from 'node:test';

import { bvSort, SORT_KIND } from '../../../js/symbolic/expr/kinds.js';

test('bvSort preserves canonical primitive positive safe integers', () => {
  const sort = bvSort(64);
  assert.equal(sort.kind, SORT_KIND.BV);
  assert.equal(sort.width, 64);
});

test('bvSort rejects coercible and noncanonical widths', () => {
  for (const invalid of [['64'], '64', true, false, { valueOf: () => 64 }, NaN, Infinity, 64.5, 0, -1]) {
    assert.throws(() => bvSort(invalid), TypeError);
  }
});
