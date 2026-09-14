import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeIntegerValue, rangeWithDomain, normalizeRangeDomain, mergeRangeDomain } from '../../js/range-domain.js';

// #6155: `validBits()` collapsed "unspecified", "invalid", "unsupported" and
// "malformed" widths all to 64, laundering an explicitly invalid bit width
// into a canonical 64-bit range and defeating the `srcBits !== width` guard
// in `normalizeRangeDomain()`. An omitted width keeps the documented default;
// an explicit invalid width must fail closed instead of being repaired.

const RANGE = { min: 0n, max: 255n, bits: 64, signed: false };

test('#6155: omitted width keeps the documented 64-bit default', () => {
  assert.equal(rangeWithDomain(0n, 255n).bits, 64);
  assert.equal(normalizeIntegerValue(0x100n).toString(), '256');
  assert.equal(normalizeRangeDomain(RANGE, null, false)?.bits, 64);
  assert.equal(mergeRangeDomain({ min: 0n, max: 1n, bits: 64, signed: false }, null, null, false)?.bits, 64);
});

test('#6155: explicit valid widths are preserved', () => {
  for (const bits of [1, 8, 16, 32, 64]) {
    const max = (1n << BigInt(bits)) - 1n;
    assert.equal(rangeWithDomain(0n, max, bits, false).bits, bits);
    assert.equal(normalizeRangeDomain({ min: 0n, max, bits, signed: false }, bits, false)?.bits, bits);
  }
});

test('#6155: normalizeRangeDomain returns null for explicitly invalid widths', () => {
  for (const bits of [0, -1, 65, 64.5, Number.NaN, '64', ['64'], true]) {
    assert.equal(normalizeRangeDomain(RANGE, bits, false), null, `requested bits ${String(bits)}`);
  }
});

test('#6155: normalizeRangeDomain returns null for invalid source widths', () => {
  for (const bits of [0, -1, 65, 64.5, '64']) {
    assert.equal(normalizeRangeDomain({ ...RANGE, bits }, 64, false), null, `source bits ${String(bits)}`);
  }
});

test('#6155: normalizeIntegerValue and rangeWithDomain reject explicitly invalid widths', () => {
  for (const bits of [0, -1, 65, 64.5, '64']) {
    assert.throws(() => normalizeIntegerValue(0x100n, bits, false), TypeError, `value bits ${String(bits)}`);
    assert.throws(() => rangeWithDomain(0n, 255n, bits, false), TypeError, `range bits ${String(bits)}`);
  }
});

test('#6155: mergeRangeDomain does not repair an invalid target width to 64', () => {
  const a = { min: 0n, max: 1n, bits: 64, signed: false };
  const b = { min: 0n, max: 2n, bits: 64, signed: false };
  for (const bits of [0, -1, 65, 64.5, '64']) {
    assert.equal(mergeRangeDomain(a, b, bits, false), null, `merge bits ${String(bits)}`);
  }
});

test('#6155: the width-mismatch guard regains meaning for unsupported widths', () => {
  // A 65-bit request against a 64-bit source used to collapse both to 64 and
  // return a canonical range; it must stay null.
  assert.equal(normalizeRangeDomain(RANGE, 65, false), null);
  // A coherent same-width normalization still succeeds.
  assert.deepEqual(
    normalizeRangeDomain(RANGE, 64, false),
    { min: 0n, max: 255n, bits: 64, signed: false },
  );
});

test('#6155: valid signed/unsigned discontinuity fail-closed behavior is unchanged', () => {
  assert.equal(
    normalizeRangeDomain({ min: 0n, max: 255n, bits: 8, signed: false }, 8, true),
    null,
  );
  assert.deepEqual(
    normalizeRangeDomain({ min: 0n, max: 127n, bits: 8, signed: false }, 8, true),
    { min: 0n, max: 127n, bits: 8, signed: true },
  );
  assert.deepEqual(
    normalizeRangeDomain({ min: -1n, max: 1n, bits: 8, signed: true }, 8, false),
    null,
  );
  // A fully negative signed interval reinterprets cleanly into unsigned.
  assert.deepEqual(
    normalizeRangeDomain({ min: -2n, max: -1n, bits: 8, signed: true }, 8, false),
    { min: 254n, max: 255n, bits: 8, signed: false },
  );
});