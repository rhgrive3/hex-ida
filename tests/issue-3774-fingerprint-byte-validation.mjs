import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compareFingerprints,
  fingerprintFunction,
  fingerprintFunctionFast,
} from '../js/fingerprint/index.js';

const base = { architecture:'arm64', size:1 };
const malformedBytes = [
  [256],
  [-1],
  ['170'],
  [true],
  [1.5],
  [Number.NaN],
  [Number.POSITIVE_INFINITY],
  [Number.NEGATIVE_INFINITY],
];

test('#3774 malformed byte arrays fail closed in full and fast fingerprints', () => {
  for (const bytes of malformedBytes) {
    assert.throws(() => fingerprintFunction({ ...base, bytes }), /function-fingerprint-bytes-invalid/);
    assert.throws(() => fingerprintFunctionFast({ ...base, bytes }), /function-fingerprint-bytes-invalid/);
  }
});

test('#3774 malformed byte arrays cannot manufacture exact identity', () => {
  for (const bytes of malformedBytes) {
    assert.throws(
      () => compareFingerprints({ ...base, bytes }, { ...base, bytes:new Uint8Array([0]) }),
      /function-fingerprint-bytes-invalid/,
    );
  }
});

test('#3774 valid numeric arrays preserve Uint8Array fingerprint hashes', () => {
  const numeric = [0, 1, 170, 255];
  const typed = Uint8Array.from(numeric);
  const input = { architecture:'arm64', size:numeric.length };
  const fullArray = fingerprintFunction({ ...input, bytes:numeric });
  const fullTyped = fingerprintFunction({ ...input, bytes:typed });
  const fastArray = fingerprintFunctionFast({ ...input, bytes:numeric });
  const fastTyped = fingerprintFunctionFast({ ...input, bytes:typed });

  assert.equal(fullArray.exactBytesHash, fullTyped.exactBytesHash);
  assert.equal(fullArray.normalizedBytesHash, fullTyped.normalizedBytesHash);
  assert.equal(fastArray.exactBytesHash, fastTyped.exactBytesHash);
  assert.equal(fastArray.normalizedBytesHash, fastTyped.normalizedBytesHash);
});

test('#3774 raw ArrayBuffer input keeps byte-for-byte semantics', () => {
  const typed = new Uint8Array([1, 2, 3, 4]);
  const input = { architecture:'arm64', size:typed.length };
  const fromTyped = fingerprintFunction({ ...input, bytes:typed });
  const fromBuffer = fingerprintFunction({ ...input, bytes:typed.buffer });
  assert.equal(fromTyped.exactBytesHash, fromBuffer.exactBytesHash);
  assert.equal(fromTyped.normalizedBytesHash, fromBuffer.normalizedBytesHash);
});
