import assert from 'node:assert/strict';
import { BinaryImage } from '../../../js/binary/model.js';

// BinaryImage.addSegment/addSection and the meta BigInt fields are the canonical
// mapping boundary. Raw BigInt() is a conversion API (BigInt(true) === 1n,
// BigInt(['16']) === 16n), so schema-invalid structured values must not be
// laundered into real address-space authority (#5195). Accept only exact
// integers: bigint, safe-integer number, or canonical integer decimal string.

function expectExactIntegerRejected(operation) {
  assert.throws(operation, (error) => {
    assert.equal(error instanceof TypeError, true, `expected TypeError, got ${error}`);
    assert.match(error.message, /exact integer/);
    return true;
  });
}

// Issue-body counterexample: boolean/array coercions must not mint a segment.
{
  const image = new BinaryImage(new Uint8Array(32), { format: 'test', arch: 'arm64' });
  expectExactIntegerRejected(() => image.addSegment({
    name: 'bad', address: true, size: ['16'], fileOffset: false, fileSize: ['16'],
    perms: { read: true, execute: true },
  }));
  assert.equal(image.segments.length, 0, 'rejected segment must not be stored');
}

// Same for sections, including the fileSize ?? size fallback path.
{
  const image = new BinaryImage(new Uint8Array(32), { format: 'test', arch: 'arm64' });
  expectExactIntegerRejected(() => image.addSection({
    name: '.bad', address: ['4096'], size: true, fileOffset: ['8'], fileSize: true,
  }));
  expectExactIntegerRejected(() => image.addSection({
    name: '.bad2', address: 0x2000n, size: 0x10n, fileOffset: 0n, fileSize: ['16'],
  }));
  assert.equal(image.sections.length, 0, 'rejected sections must not be stored');
}

// Meta BigInt fields: imageBase/entrypoint/fileOffset/fileSize coercion.
{
  expectExactIntegerRejected(() => new BinaryImage(new Uint8Array(8), {
    format: 'test', imageBase: true,
  }));
  expectExactIntegerRejected(() => new BinaryImage(new Uint8Array(8), {
    format: 'test', entrypoint: ['0x20'],
  }));
  expectExactIntegerRejected(() => new BinaryImage(new Uint8Array(8), {
    format: 'test', fileOffset: [0],
  }));
  expectExactIntegerRejected(() => new BinaryImage(new Uint8Array(8), {
    format: 'test', fileSize: {},
  }));
  expectExactIntegerRejected(() => new BinaryImage(new Uint8Array(8), {
    format: 'test', imageBase: 1.5,
  }));
}

// Exact-integer strings that BigInt() would launder through hex spelling.
{
  const image = new BinaryImage(new Uint8Array(32), { format: 'test' });
  expectExactIntegerRejected(() => image.addSegment({
    name: 'hex', address: '0x10', size: 0x10n, fileOffset: 0n, fileSize: 0x10n,
  }));
}

// Fractional and unsafe numbers must fail closed.
{
  const image = new BinaryImage(new Uint8Array(32), { format: 'test' });
  expectExactIntegerRejected(() => image.addSegment({
    name: 'frac', address: 16.5, size: 0x10n, fileOffset: 0n, fileSize: 0x10n,
  }));
  expectExactIntegerRejected(() => image.addSegment({
    name: 'unsafe', address: 2 ** 53, size: 0x10n, fileOffset: 0n, fileSize: 0x10n,
  }));
}

// Legitimate exact-integer shapes keep working end to end.
{
  const image = new BinaryImage(new Uint8Array(32), {
    format: 'test', imageBase: 0x1000, entrypoint: '4098', fileSize: 32,
  });
  assert.equal(image.imageBase, 0x1000n);
  assert.equal(image.entrypoint, 4098n);
  assert.equal(image.fileSize, 32n);
  image.addSegment({ name: 's', address: 4096, size: '16', fileOffset: 0n, fileSize: '16' });
  assert.equal(image.segments[0].address, 4096n);
  assert.equal(image.segments[0].size, 16n);
  image.addSection({ name: '.s', address: '4112', size: 16n, fileOffset: 16n, fileSize: 16n });
  assert.equal(image.sections[0].address, 4112n);
  assert.equal(image.addressToOffset(4100n), 4n);
}
