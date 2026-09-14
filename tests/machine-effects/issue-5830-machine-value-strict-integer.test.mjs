import assert from 'node:assert/strict';
import test from 'node:test';

import { createMachineValue } from '../../js/semantics/effects/index.js';

// Machine payloads are exact facts. Only bigint, safe integer, or a strict
// integer literal may become a canonical machine value: ECMAScript BigInt()
// coercion launders '' -> 0, booleans -> 0/1, and arrays -> their single
// element, minting exact constants from malformed payloads (#5830).

test('#5830: blank, boolean, and array bitvector payloads are rejected', () => {
  for (const value of ['', '  ', true, false, [], ['15'], {}, { toString: () => '7' }]) {
    assert.throws(
      () => createMachineValue({ kind: 'bitvector', widthBits: 8, value }),
      (error) => error?.message === 'machine-effects-invalid-bitvector-value',
      `payload ${JSON.stringify(value)} must not become a machine constant`,
    );
  }
});

test('#5830: float bitPattern applies the same strict contract', () => {
  for (const bitPattern of ['', '  ', true, false, [], ['15'], {}]) {
    assert.throws(
      () => createMachineValue({ kind: 'float', widthBits: 32, format: 'ieee754', bitPattern }),
      (error) => error?.message === 'machine-effects-invalid-float-bit-pattern',
    );
  }
});

test('#5830: strict integer literals, safe integers, and bigints stay accepted', () => {
  assert.equal(createMachineValue({ kind: 'bitvector', widthBits: 8, value: 15n }).value, '15');
  assert.equal(createMachineValue({ kind: 'bitvector', widthBits: 8, value: 0 }).value, '0');
  assert.equal(createMachineValue({ kind: 'bitvector', widthBits: 8, value: '15' }).value, '15');
  assert.equal(createMachineValue({ kind: 'bitvector', widthBits: 16, value: '0xFF' }).value, '255');
  assert.equal(createMachineValue({ kind: 'float', widthBits: 32, format: 'ieee754', bitPattern: 0x3f800000 }).bitPattern, '1065353216');
});

test('#5830: fractional and unsafe-number payloads fail closed; negatives never mint a value', () => {
  for (const value of [1.5, 2 ** 53]) {
    assert.throws(
      () => createMachineValue({ kind: 'bitvector', widthBits: 8, value }),
      (error) => error?.message === 'machine-effects-invalid-bitvector-value',
    );
  }
  // -1 parses as an integer but is rejected by the width range check.
  assert.throws(
    () => createMachineValue({ kind: 'bitvector', widthBits: 8, value: -1 }),
    (error) => error?.message === 'machine-effects-bitvector-value-out-of-range',
  );
});

test('#5830: width range checks still apply after strict parsing', () => {
  assert.throws(
    () => createMachineValue({ kind: 'bitvector', widthBits: 8, value: 256 }),
    (error) => error?.message === 'machine-effects-bitvector-value-out-of-range',
  );
  assert.throws(
    () => createMachineValue({ kind: 'float', widthBits: 32, format: 'ieee754', bitPattern: '0x100000000' }),
    (error) => error?.message === 'machine-effects-float-bit-pattern-out-of-range',
  );
});
