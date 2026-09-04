import test from 'node:test';
import assert from 'node:assert/strict';
import { createBv } from '../js/symbolic/expr/factory.js';
import { wrap, toUnsigned, toSigned, bvAdd, bvUlt } from '../js/symbolic/expr/bitvector.js';

test('issue #4943: createBv rejects structured values (Array, boolean, plain object)', () => {
  assert.throws(() => createBv(8, [1]), TypeError);
  assert.throws(() => createBv(8, ['255']), TypeError);
  assert.throws(() => createBv(8, true), TypeError);
  assert.throws(() => createBv(8, false), TypeError);
  assert.throws(() => createBv(8, { valueOf: () => 1 }), TypeError);
  assert.throws(() => createBv(8, null), TypeError);
  assert.throws(() => createBv(8, undefined), TypeError);
  assert.throws(() => createBv(8, 1.5), TypeError);
});

test('issue #4943: wrap, toSigned, and low-level arithmetic reject structured values', () => {
  assert.throws(() => wrap([1], 8), TypeError);
  assert.throws(() => wrap(true, 8), TypeError);
  assert.throws(() => toSigned([1], 8), TypeError);
  assert.throws(() => bvAdd([1], 2n, 8), TypeError);
  assert.throws(() => bvUlt([1], 2n, 8), TypeError);
});

test('issue #4943: createBv and wrap preserve valid bigint, integer number, and integer strings', () => {
  assert.equal(createBv(8, 255n).value, 255n);
  assert.equal(createBv(8, 255).value, 255n);
  assert.equal(createBv(8, '0xff').value, 255n);
  assert.equal(createBv(8, '255').value, 255n);
  assert.equal(createBv(8, 256n).value, 0n); // wraparound preserved
  assert.equal(createBv(8, -1n).value, 255n); // negative wrap preserved
});
