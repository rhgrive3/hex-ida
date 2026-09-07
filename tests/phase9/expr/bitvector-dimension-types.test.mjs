import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mask,
  wrap,
  bvTrunc,
  bvExtract,
  bvConcat,
} from '../../../js/symbolic/expr/bitvector.js';

test('bitvector dimensions accept canonical primitive integers', () => {
  assert.equal(mask(8), 0xffn);
  assert.equal(wrap(0x1ffn, 8), 0xffn);
  assert.equal(bvTrunc(0xffn, 16, 8), 0xffn);
  assert.equal(bvExtract(0xffn, 8, 7, 0), 0xffn);
  assert.equal(bvConcat(1n, 8, 2n, 8), 0x102n);
});

test('bitvector dimensions reject coercible structured and noncanonical values', () => {
  for (const invalid of [['8'], '8', true, { valueOf: () => 8 }, NaN, Infinity, 8.5]) {
    assert.throws(() => mask(invalid), RangeError);
    assert.throws(() => wrap(1n, invalid), RangeError);
    assert.throws(() => bvTrunc(1n, 16, invalid), RangeError);
    assert.throws(() => bvExtract(1n, 8, invalid, 0), RangeError);
    assert.throws(() => bvConcat(1n, invalid, 2n, 8), RangeError);
  }
});
