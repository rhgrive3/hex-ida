import test from 'node:test';
import assert from 'node:assert/strict';
import * as current from '../../js/binary/fingerprint.js';
import * as original from '../helpers/fingerprint-baseline-oracle.mjs';

test('binary fingerprint retains exact default, BigInt and limb-seeded identities', () => {
  let state = 0xa40f7921;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  for (let repeat = 0; repeat < 600; repeat++) {
    const bytes = Uint8Array.from({ length: random() % 257 }, () => random() & 255);
    const hi = random(), lo = random();
    const seed = (BigInt(hi) << 32n) | BigInt(lo);
    for (const input of [null, seed, seed + (1n << 90n), -seed, { hi, lo }]) {
      assert.equal(current.fnv1a64(bytes, input), original.fnv1a64(bytes, input));
    }
    assert.equal(current.fingerprintBytes(bytes), original.fingerprintBytes(bytes));
  }
});

test('binary fingerprint keeps legacy indexed coercion and strict seed errors', () => {
  const cases = [[], [0, 255, 256, -1, 3.75, NaN, undefined, '17'], new Uint8Array(33).subarray(3, 28), { length: 3, 0: 11, 1: 22, 2: 33 }];
  for (const bytes of cases) assert.equal(current.fingerprintBytes(bytes), original.fingerprintBytes(bytes));
  const view = Uint8Array.of(3, 4, 5);
  view[Symbol.iterator] = () => { throw new Error('must not iterate'); };
  assert.equal(current.fingerprintBytes(view), original.fingerprintBytes(view));
  for (const seed of [{}, [], { hi: -1, lo: 0 }, { hi: 0, lo: 2 ** 32 }, { hi: 1.5, lo: 0 }, Object.create({ hi: 1, lo: 0 }), 'seed']) {
    for (const fn of [current.fnv1a64, original.fnv1a64]) assert.throws(() => fn(view, seed), { name: 'TypeError', message: 'FNV seed must be BigInt or {hi, lo}' });
  }
  let calls = 0;
  const accessor = { lo: 0, get hi() { calls++; return 1; } };
  assert.throws(() => current.fnv1a64(view, accessor), TypeError);
  assert.equal(calls, 0);
});
