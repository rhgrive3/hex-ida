import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ByteSourceLimitError,
  MemoryByteSource,
  SubrangeByteSource,
  asByteSource,
} from '../js/binary/source.js';

function expectInvalidLimit(makeSource, value) {
  assert.throws(
    () => makeSource(value),
    (error) => error instanceof ByteSourceLimitError
      && error.code === 'BYTE_SOURCE_LIMIT_ERROR'
      && error.message === 'maxReadLength must be a positive safe integer',
  );
}

test('SubrangeByteSource rejects maxReadLength values before parent-limit composition', () => {
  const parent = new MemoryByteSource(new Uint8Array(4096), { maxReadLength: 2048 });
  const makeSource = (maxReadLength) => new SubrangeByteSource(parent, 0, 4096, { maxReadLength });

  for (const value of [
    '1024',
    ['1024'],
    true,
    false,
    { valueOf: () => 1024 },
    1.5,
    NaN,
    Infinity,
    0,
    -1,
  ]) {
    expectInvalidLimit(makeSource, value);
  }
});

test('asByteSource wrapping rejects structured or coercible maxReadLength values', () => {
  const parent = new MemoryByteSource(new Uint8Array(4096), { maxReadLength: 2048 });
  for (const value of ['512', ['512'], true, { toString: () => '512' }]) {
    expectInvalidLimit((maxReadLength) => asByteSource(parent, { maxReadLength }), value);
  }

  const delegate = {
    size: 4096n,
    maxReadLength: 2048,
    async read(offset, length) {
      return new Uint8Array(length);
    },
  };
  expectInvalidLimit((maxReadLength) => asByteSource(delegate, { maxReadLength }), ['512']);
});

test('valid numeric limits retain parent clamp and nullish inheritance', () => {
  const parent = new MemoryByteSource(new Uint8Array(4096), { maxReadLength: 2048 });

  assert.equal(new SubrangeByteSource(parent, 0, 4096).maxReadLength, 2048);
  assert.equal(new SubrangeByteSource(parent, 0, 4096, { maxReadLength: 1024 }).maxReadLength, 1024);
  assert.equal(new SubrangeByteSource(parent, 0, 4096, { maxReadLength: 4096 }).maxReadLength, 2048);

  assert.equal(asByteSource(parent, { maxReadLength: 1024 }).maxReadLength, 1024);
  assert.equal(asByteSource(parent, { maxReadLength: 4096 }).maxReadLength, 2048);
  assert.equal(asByteSource(parent), parent);
});
