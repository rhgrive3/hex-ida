import assert from 'node:assert/strict';
import test from 'node:test';

import { align4 } from '../../../js/managed/cil/parser-base.js';

test('CIL align4 preserves safe offsets across 32-bit boundaries (#4715)', () => {
  assert.equal(align4(0),0);
  assert.equal(align4(1),4);
  assert.equal(align4(0x7fffffff),0x80000000);
  assert.equal(align4(0x80000000),0x80000000);
  assert.equal(align4(0xfffffffd),0x100000000);
});

test('CIL align4 rejects invalid and overflowing offsets (#4715)', () => {
  for (const value of [-1,1.5,'4',null,Number.NaN,Number.POSITIVE_INFINITY]) {
    assert.throws(() => align4(value),/cil-offset-invalid/);
  }
  assert.throws(() => align4(Number.MAX_SAFE_INTEGER),/cil-offset-overflow/);
});
