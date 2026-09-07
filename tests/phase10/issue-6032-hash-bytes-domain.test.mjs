import assert from 'node:assert/strict';
import { hashBytes } from '../../js/platform/hash.js';

// Existing valid hashes are preserved byte-for-byte.
{
  const fromArray = hashBytes([0, 1, 255]);
  const fromTyped = hashBytes(new Uint8Array([0, 1, 255]));
  assert.equal(fromArray, fromTyped);
  assert.match(fromArray, /^[0-9a-f]{16}$/);
}

const rejectsInvalidByte = (value) => {
  assert.throws(
    () => hashBytes([value]),
    (error) => error instanceof TypeError && /integer 0\.\.255/.test(error.message),
  );
};

// String elements must not coerce to byte values.
rejectsInvalidByte('1');
// Domain violations are rejected with the public TypeError contract.
for (const value of [-1, 256, 1.5, NaN, Infinity, true, null, undefined, [1], {}]) {
  rejectsInvalidByte(value);
}

console.log('issue-6032 hashBytes byte-domain tests passed');
