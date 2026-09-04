import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mergeRangeDomain,
  normalizeRangeDomain,
  rangeWithDomain,
} from '../../js/range-domain.js';

test('rangeWithDomain rejects endpoints outside the declared unsigned domain', () => {
  assert.deepEqual(rangeWithDomain(0n, 255n, 8, false), { min:0n, max:255n, bits:8, signed:false });
  assert.throws(() => rangeWithDomain(-1n, 1n, 8, false), RangeError);
  assert.throws(() => rangeWithDomain(0n, 256n, 8, false), RangeError);
});

test('rangeWithDomain rejects endpoints outside the declared signed domain', () => {
  assert.deepEqual(rangeWithDomain(-128n, 127n, 8, true), { min:-128n, max:127n, bits:8, signed:true });
  assert.throws(() => rangeWithDomain(-129n, 0n, 8, true), RangeError);
  assert.throws(() => rangeWithDomain(0n, 128n, 8, true), RangeError);
});

test('normalizeRangeDomain fails closed on source ranges outside their domain', () => {
  assert.equal(normalizeRangeDomain({ min:-1n, max:1n, bits:8, signed:false }, 8, false), null);
  assert.equal(normalizeRangeDomain({ min:0n, max:256n, bits:8, signed:false }, 8, false), null);
  assert.equal(normalizeRangeDomain({ min:-129n, max:0n, bits:8, signed:true }, 8, true), null);
  assert.equal(normalizeRangeDomain({ min:0n, max:128n, bits:8, signed:true }, 8, true), null);
});

test('64-bit boundaries stay exact', () => {
  const u64Max = (1n << 64n) - 1n;
  const s64Min = -(1n << 63n);
  const s64Max = (1n << 63n) - 1n;
  assert.deepEqual(normalizeRangeDomain({ min:0n, max:u64Max, bits:64, signed:false }, 64, false),
    { min:0n, max:u64Max, bits:64, signed:false });
  assert.equal(normalizeRangeDomain({ min:0n, max:u64Max + 1n, bits:64, signed:false }, 64, false), null);
  assert.deepEqual(normalizeRangeDomain({ min:s64Min, max:s64Max, bits:64, signed:true }, 64, true),
    { min:s64Min, max:s64Max, bits:64, signed:true });
  assert.equal(normalizeRangeDomain({ min:s64Min - 1n, max:0n, bits:64, signed:true }, 64, true), null);
  assert.equal(normalizeRangeDomain({ min:0n, max:s64Max + 1n, bits:64, signed:true }, 64, true), null);
});

test('signedness reinterpretation keeps existing discontinuity semantics', () => {
  assert.deepEqual(normalizeRangeDomain({ min:128n, max:255n, bits:8, signed:false }, 8, true),
    { min:-128n, max:-1n, bits:8, signed:true });
  assert.deepEqual(normalizeRangeDomain({ min:-128n, max:-1n, bits:8, signed:true }, 8, false),
    { min:128n, max:255n, bits:8, signed:false });
  assert.equal(normalizeRangeDomain({ min:127n, max:128n, bits:8, signed:false }, 8, true), null);
  assert.equal(normalizeRangeDomain({ min:-1n, max:1n, bits:8, signed:true }, 8, false), null);
});

test('unknown signedness still requires one coherent 8-bit interpretation', () => {
  assert.deepEqual(normalizeRangeDomain({ min:-128n, max:127n, bits:8, signed:null }, 8, null),
    { min:-128n, max:127n, bits:8, signed:null });
  assert.deepEqual(normalizeRangeDomain({ min:0n, max:255n, bits:8, signed:null }, 8, null),
    { min:0n, max:255n, bits:8, signed:null });
  assert.equal(normalizeRangeDomain({ min:-1n, max:255n, bits:8, signed:null }, 8, null), null);
});

test('mergeRangeDomain cannot reintroduce an out-of-domain source range', () => {
  assert.equal(mergeRangeDomain(
    { min:0n, max:256n, bits:8, signed:false },
    { min:1n, max:2n, bits:8, signed:false },
    8,
    false,
  ), null);
});

test('mergeRangeDomain fails closed when unknown-signedness hull has no coherent domain', () => {
  assert.equal(mergeRangeDomain(
    { min:-128n, max:-1n, bits:8, signed:null },
    { min:128n, max:255n, bits:8, signed:null },
    8,
    null,
  ), null);
});
