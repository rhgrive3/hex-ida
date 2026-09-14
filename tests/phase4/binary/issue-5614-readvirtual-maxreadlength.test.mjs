import assert from 'node:assert/strict';

import { BinaryImage } from '../../../js/binary/model.js';
import { ByteSource, MemoryByteSource } from '../../../js/binary/source.js';

class TrackingByteSource extends ByteSource {
  constructor(bytes, maxReadLength) {
    super(BigInt(bytes.length), { maxReadLength });
    this.bytes = bytes;
    this.reads = [];
  }

  async read(offset, length, options = {}) {
    const range = this.validateRange(offset, length);
    this.reads.push({ offset: range.offset, length: range.length, signal: options.signal ?? null });
    const start = Number(range.offset);
    return this.bytes.subarray(start, start + range.length);
  }
}

function sourceImage(source, segments) {
  const image = new BinaryImage(null, { format: 'test', source, fileSize: source.size });
  for (const segment of segments) image.addSegment(segment);
  return image;
}

// Minimal counterexample: the virtual request is valid, but it is one byte
// larger than the source's per-read ceiling. readVirtualAsync must compose the
// result without weakening ByteSource.maxReadLength.
{
  const data = Uint8Array.from([1, 2, 3, 4, 5]);
  const source = new TrackingByteSource(data, 4);
  const streamed = sourceImage(source, [{
    address: 0n,
    size: 5n,
    fileOffset: 0n,
    fileSize: 5n,
    perms: { read: true },
  }]);

  const got = await streamed.readVirtualAsync(0n, 5n);
  assert.deepEqual([...got], [...data]);
  assert.deepEqual(source.reads.map((read) => read.length), [4, 1]);
  assert.ok(source.reads.every((read) => read.length <= source.maxReadLength));

  const resident = new BinaryImage(data, { format: 'test' });
  resident.addSegment({ address: 0n, size: 5n, fileOffset: 0n, fileSize: 5n, perms: { read: true } });
  assert.deepEqual([...got], [...resident.readVirtual(0n, 5n)], 'resident/source-backed virtual bytes must agree');
}

// Mapping boundaries remain authoritative: split each file-backed mapping by
// the source ceiling, while preserving VA-contiguous composition across
// non-contiguous file offsets.
{
  const data = Uint8Array.from([0x10, 0x11, 0x12, 0xee, 0xee, 0x20, 0x21, 0x22]);
  const source = new TrackingByteSource(data, 2);
  const image = sourceImage(source, [
    { address: 0x1000n, size: 3n, fileOffset: 0n, fileSize: 3n, perms: { read: true } },
    { address: 0x1003n, size: 3n, fileOffset: 5n, fileSize: 3n, perms: { read: true } },
  ]);

  assert.deepEqual([...await image.readVirtualAsync(0x1000n, 6n)], [0x10, 0x11, 0x12, 0x20, 0x21, 0x22]);
  assert.deepEqual(source.reads.map(({ offset, length }) => [offset, length]), [
    [0n, 2], [2n, 1], [5n, 2], [7n, 1],
  ]);
}

// Zero-fill tails still synthesize bytes and never generate source reads for
// the non-file-backed portion.
{
  const data = Uint8Array.from([0xa0, 0xa1, 0xa2, 0xa3, 0xa4]);
  const source = new TrackingByteSource(data, 3);
  const image = sourceImage(source, [{
    address: 0x2000n,
    size: 7n,
    fileOffset: 0n,
    fileSize: 5n,
    perms: { read: true, write: true },
  }]);

  assert.deepEqual([...await image.readVirtualAsync(0x2000n, 7n)], [0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0, 0]);
  assert.deepEqual(source.reads.map((read) => read.length), [3, 2]);
}

// Invalid virtual/file spans remain fail-closed and must not be made readable
// merely by chunking.
{
  const source = new TrackingByteSource(Uint8Array.from([1, 2, 3, 4, 5]), 2);
  const outsideFile = sourceImage(source, [{
    address: 0x3000n,
    size: 3n,
    fileOffset: 3n,
    fileSize: 3n,
    perms: { read: true },
  }]);
  assert.equal(await outsideFile.readVirtualAsync(0x3000n, 3n), null);
  assert.equal(source.reads.length, 0, 'file bounds must be checked before any split read');

  const gap = sourceImage(source, [
    { address: 0x4000n, size: 2n, fileOffset: 0n, fileSize: 2n, perms: { read: true } },
    { address: 0x5000n, size: 2n, fileOffset: 2n, fileSize: 2n, perms: { read: true } },
  ]);
  assert.equal(await gap.readVirtualAsync(0x4001n, 2n), null);
}

// Compatibility: BinaryImage historically accepts source-like objects whose
// readExactly contract predates maxReadLength. Absence of a declared ceiling
// must keep the single-read behavior rather than inventing a limit.
{
  const data = Uint8Array.from([9, 8, 7, 6, 5]);
  const reads = [];
  const source = {
    size: 5n,
    async readExactly(offset, length) {
      reads.push({ offset, length });
      return data.subarray(Number(offset), Number(offset + BigInt(length)));
    },
  };
  const image = sourceImage(source, [{
    address: 0x6000n,
    size: 5n,
    fileOffset: 0n,
    fileSize: 5n,
    perms: { read: true },
  }]);

  assert.deepEqual([...await image.readVirtualAsync(0x6000n, 5n)], [...data]);
  assert.deepEqual(reads, [{ offset: 0n, length: 5n }]);
}

// ByteSource's own validation remains authoritative: a direct oversized read
// still fails, proving this regression fixes the BinaryImage composition layer
// rather than weakening the per-read source contract.
{
  const source = new MemoryByteSource(new Uint8Array(5), { maxReadLength: 4 });
  await assert.rejects(() => source.readExactly(0n, 5n), /exceeds the 4-byte limit/);
}

console.log('issue-5614 readVirtualAsync maxReadLength regression: PASS');
