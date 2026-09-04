import assert from 'node:assert/strict';
import { hashBytes } from '../js/platform/hash.js';

// Existing valid hashes are preserved byte-for-byte.
{
  const fromArray = hashBytes([0, 1, 255]);
  const fromTyped = hashBytes(new Uint8Array([0, 1, 255]));
  assert.equal(fromArray, fromTyped);
  assert.match(fromArray, /^[0-9a-f]{16}$/);
}

// String elements must not coerce to byte values.
assert.throws(() => hashBytes(['1']), /integer 0\.\.255/);
// Domain violations are rejected.
assert.throws(() => hashBytes([-1]), /integer 0\.\.255/);
assert.throws(() => hashBytes([256]), /integer 0\.\.255/);
assert.throws(() => hashBytes([1.5]), /integer 0\.\.255/);
assert.throws(() => hashBytes([NaN]), /integer 0\.\.255/);
assert.throws(() => hashBytes([Infinity]), /integer 0\.\.255/);
assert.throws(() => hashBytes([true]), /integer 0\.\.255/);
assert.throws(() => hashBytes([null]), /integer 0\.\.255/);
assert.throws(() => hashBytes([undefined]), /integer 0\.\.255/);
assert.throws(() => hashBytes([[1]]), /integer 0\.\.255/);
assert.throws(() => hashBytes([{}]), /integer 0\.\.255/);

console.log('issue-6032 hashBytes byte-domain tests passed');
