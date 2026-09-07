import assert from 'node:assert/strict';
import test from 'node:test';

import { CAST_OP } from '../../../js/symbolic/expr/kinds.js';
import { createBool, createBv, createCast, createExtract } from '../../../js/symbolic/expr/factory.js';

const bv64 = createBv(64, 0xffn);

test('Expr factory preserves canonical primitive scalar inputs', () => {
  assert.equal(createBool(false).value, false);
  const extracted = createExtract(bv64, 7, 0);
  assert.equal(extracted.high, 7);
  assert.equal(extracted.low, 0);
  assert.equal(extracted.sort.width, 8);
  const cast = createCast(CAST_OP.TRUNC, bv64, 32);
  assert.equal(cast.targetWidth, 32);
  assert.equal(cast.sort.width, 32);
});

test('Expr factory rejects coercible structured scalar inputs', () => {
  for (const invalid of ['false', ['false'], 0, 1, null]) {
    assert.throws(() => createBool(invalid), TypeError);
  }
  for (const invalid of [['7'], '7', true, { valueOf: () => 7 }, NaN, Infinity, 7.5]) {
    assert.throws(() => createExtract(bv64, invalid, 0), RangeError);
  }
  for (const invalid of [['32'], '32', true, { valueOf: () => 32 }, NaN, Infinity, 32.5]) {
    assert.throws(() => createCast(CAST_OP.TRUNC, bv64, invalid), RangeError);
  }
});
