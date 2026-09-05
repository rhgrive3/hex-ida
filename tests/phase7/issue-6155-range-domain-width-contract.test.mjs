import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeRangeDomain,
  normalizeIntegerValue,
  normalizeRangeDomain,
  rangeWithDomain,
} from '../../js/range-domain.js';

test('valid and nullish widths preserve documented 64-bit default', () => {
  assert.equal(normalizeIntegerValue(256n, 8, false), 0n);
  assert.equal(normalizeIntegerValue(256n, null, false), 256n);
  assert.equal(normalizeIntegerValue(256n, undefined, false), 256n);
  assert.deepEqual(rangeWithDomain(0n, 255n, 8, false), {
    min: 0n, max: 255n, bits: 8, signed: false,
  });
  assert.equal(normalizeRangeDomain({ min: 0n, max: 255n, bits: 8, signed: false }, null, false)?.bits, 8);
});

test('scalar and range constructors reject explicit invalid widths', () => {
  for (const bits of [0, -1, 65, 64.5, NaN, Infinity]) {
    assert.throws(() => normalizeIntegerValue(1n, bits, false), RangeError);
    assert.throws(() => rangeWithDomain(0n, 0n, bits, false), RangeError);
  }
  for (const bits of ['64', true, false, [], {}, 64n]) {
    assert.throws(() => normalizeIntegerValue(1n, bits, false), TypeError);
    assert.throws(() => rangeWithDomain(0n, 0n, bits, false), TypeError);
  }
});

test('width validation does not execute coercion hooks', () => {
  let calls = 0;
  const bits = {
    valueOf() { calls += 1; return 64; },
    toString() { calls += 1; return '64'; },
    [Symbol.toPrimitive]() { calls += 1; return 64; },
  };
  assert.throws(() => normalizeIntegerValue(1n, bits, false), TypeError);
  assert.throws(() => rangeWithDomain(0n, 0n, bits, false), TypeError);
  assert.equal(normalizeRangeDomain({ min: 0n, max: 0n, bits: 64, signed: false }, bits, false), null);
  assert.equal(mergeRangeDomain({ min: 0n, max: 0n, bits: 64, signed: false }, null, bits, false), null);
  assert.equal(calls, 0);
});

test('normalizeRangeDomain fails closed on invalid requested or source widths', () => {
  const range64 = { min: 0n, max: 255n, bits: 64, signed: false };
  for (const bits of [0, -1, 65, 64.5, '64', true, [], {}]) {
    assert.equal(normalizeRangeDomain(range64, bits, false), null);
  }

  for (const bits of [0, -1, 65, 64.5, '64', true, [], {}]) {
    assert.equal(normalizeRangeDomain({ min: 0n, max: 255n, bits, signed: false }, null, false), null);
  }

  assert.deepEqual(normalizeRangeDomain(range64, 64, false), {
    min: 0n, max: 255n, bits: 64, signed: false,
  });
});

test('mergeRangeDomain rejects invalid target widths instead of laundering them to 64', () => {
  const a = { min: 0n, max: 7n, bits: 64, signed: false };
  const b = { min: 8n, max: 15n, bits: 64, signed: false };
  for (const bits of [0, -1, 65, 64.5, '64', true, [], {}]) {
    assert.equal(mergeRangeDomain(a, b, bits, false), null);
  }
  assert.deepEqual(mergeRangeDomain(a, b, 64, false), {
    min: 0n, max: 15n, bits: 64, signed: false,
  });
});

test('#5069 range-domain bounds and discontinuity semantics remain fail-closed', () => {
  assert.throws(() => rangeWithDomain(256n, 256n, 8, false), RangeError);
  assert.throws(() => rangeWithDomain(128n, 128n, 8, true), RangeError);
  assert.equal(normalizeRangeDomain({ min: 0n, max: 255n, bits: 8, signed: false }, 8, true), null);
  assert.equal(
    mergeRangeDomain(
      { min: -128n, max: -1n, bits: 8, signed: null },
      { min: 128n, max: 255n, bits: 8, signed: null },
      8,
      null,
    ),
    null,
  );
});
