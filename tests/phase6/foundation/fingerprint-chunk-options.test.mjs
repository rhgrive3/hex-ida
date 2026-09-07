import assert from 'node:assert/strict';
import test from 'node:test';

import { fingerprintImage } from '../../../js/binary/fingerprint.js';

function residentImage(size = 8192) {
  const bytes = Uint8Array.from({ length: size }, (_, index) => index & 0xff);
  return {
    bytes,
    sections: [{ fileSize: BigInt(size), fileOffset: 0n, perms: { execute: true } }],
    segments: [],
  };
}

function sourceImage(size, reads) {
  return {
    bytes: null,
    source: {
      async readExactly(offset, length) {
        reads.push({ offset, length });
        return new Uint8Array(length);
      },
    },
    sections: [{ fileSize: BigInt(size), fileOffset: 0n, perms: { execute: true } }],
    segments: [],
  };
}

test('fingerprintImage falls back for invalid chunkBytes instead of throwing', () => {
  const image = residentImage();
  const expected = fingerprintImage(image);
  for (const chunkBytes of [NaN, 'abc']) {
    assert.deepEqual(fingerprintImage(image, { chunkBytes }), expected);
  }
});

test('fingerprintImage preserves the existing lower chunk clamp', async () => {
  const reads = [];
  await fingerprintImage(sourceImage(5000, reads), { chunkBytes: 1 });
  assert.deepEqual(reads.map((entry) => entry.length), [4096, 904]);
});

test('fingerprintImage preserves the existing upper chunk clamp', async () => {
  const reads = [];
  await fingerprintImage(sourceImage((1 << 20) + 1, reads), { chunkBytes: (1 << 20) + 4096 });
  assert.deepEqual(reads.map((entry) => entry.length), [1 << 20, 1]);
});
