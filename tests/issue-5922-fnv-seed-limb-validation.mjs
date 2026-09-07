import assert from 'node:assert/strict';
import test from 'node:test';

import { fnv1a64 } from '../js/binary/fingerprint.js';

test('#5922 canonical BigInt and {hi, lo} seeds keep their digests', () => {
  const bytes = Uint8Array.from([1, 2, 3, 4]);
  const fromBigInt = fnv1a64(bytes, 1n);
  const fromLimbs = fnv1a64(bytes, { hi: 0, lo: 1 });
  assert.equal(fromBigInt, fromLimbs);
  // Default seed digest unchanged.
  assert.equal(fnv1a64(bytes), fnv1a64(bytes, null));
});

test('#5922 malformed object seeds are rejected, not coerced', () => {
  assert.throws(() => fnv1a64(new Uint8Array(), {}), TypeError);
  assert.throws(() => fnv1a64(new Uint8Array(), { hi: ['1'], lo: true }), TypeError);
  assert.throws(() => fnv1a64(new Uint8Array(), { hi: 1.9, lo: -1 }), TypeError);
  assert.throws(() => fnv1a64(new Uint8Array(), { hi: 1 }), TypeError);
  assert.throws(() => fnv1a64(new Uint8Array(), { lo: 1 }), TypeError);
  assert.throws(() => fnv1a64(new Uint8Array(), { hi: 2 ** 32, lo: 0 }), TypeError);
  assert.throws(() => fnv1a64(new Uint8Array(), 'seed'), TypeError);
});

test('#5922 zero limbs remain expressible explicitly', () => {
  // {hi:0, lo:0} is a legitimate explicit seed and must keep working.
  assert.equal(typeof fnv1a64(new Uint8Array(), { hi: 0, lo: 0 }), 'bigint');
});
