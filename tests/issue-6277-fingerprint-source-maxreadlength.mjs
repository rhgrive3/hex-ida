import assert from 'node:assert/strict';
import { ByteSource, MemoryByteSource } from '../js/binary/source.js';
import { fingerprintImage } from '../js/binary/fingerprint.js';

// Custom ByteSource that strictly enforces maxReadLength: 4
class SmallCeilingByteSource extends ByteSource {
  constructor(bytes, maxReadLength = 4) {
    super(BigInt(bytes.length), { maxReadLength });
    this.bytes = bytes;
    this.reads = [];
  }

  async read(offset, length) {
    assert.ok(length <= this.maxReadLength, `Read length ${length} exceeds maxReadLength ${this.maxReadLength}`);
    this.reads.push({ offset, length });
    const start = Number(offset);
    return this.bytes.subarray(start, start + length);
  }
}

// 1 & 2 & 5. maxReadLength=4, 5-byte executable mapping, chunkBytes:4 -> fingerprint成功 & all reads <= 4 & resident parity
{
  const data = Uint8Array.from([10, 20, 30, 40, 50]);
  const source = new SmallCeilingByteSource(data, 4);

  const sourceImg = {
    bytes: null,
    source,
    sections: [{ fileSize: 5n, fileOffset: 0n, perms: { execute: true } }],
    segments: [],
  };

  const residentImg = {
    bytes: data,
    sections: [{ fileSize: 5n, fileOffset: 0n, perms: { execute: true } }],
    segments: [],
  };

  const sourceResult = await fingerprintImage(sourceImg, { chunkBytes: 4 });
  const residentResult = fingerprintImage(residentImg);

  assert.equal(sourceResult.hash, residentResult.hash, 'resident and source-backed hash must match');
  assert.equal(sourceResult.bytes, 5);
  assert.equal(source.reads.length, 2);
  assert.deepEqual(source.reads.map((r) => r.length), [4, 1], 'reads must be split into [4, 1]');
  assert.ok(source.reads.every((r) => r.length <= 4), 'all reads must be <= maxReadLength');
}

// 3. maxReadLength=4, default chunkBytes -> 同様に成功
{
  const data = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const source = new SmallCeilingByteSource(data, 4);

  const sourceImg = {
    bytes: null,
    source,
    sections: [{ fileSize: 9n, fileOffset: 0n, perms: { execute: true } }],
    segments: [],
  };

  const residentImg = {
    bytes: data,
    sections: [{ fileSize: 9n, fileOffset: 0n, perms: { execute: true } }],
    segments: [],
  };

  const sourceResult = await fingerprintImage(sourceImg); // default chunkBytes (256KB)
  const residentResult = fingerprintImage(residentImg);

  assert.equal(sourceResult.hash, residentResult.hash);
  assert.equal(sourceResult.bytes, 9);
  assert.deepEqual(source.reads.map((r) => r.length), [4, 4, 1]);
  assert.ok(source.reads.every((r) => r.length <= 4));
}

// 4. maxReadLength > chunkBytes -> caller の chunk budget を維持
{
  const data = new Uint8Array(20000);
  data.fill(42);
  const source = new SmallCeilingByteSource(data, 16384);

  const sourceImg = {
    bytes: null,
    source,
    sections: [{ fileSize: 20000n, fileOffset: 0n, perms: { execute: true } }],
    segments: [],
  };

  // chunkBytes: 4096 (lower clamp), maxReadLength: 16384 -> should read in 4096 chunks
  const result = await fingerprintImage(sourceImg, { chunkBytes: 4096 });
  assert.equal(result.bytes, 20000);
  assert.deepEqual(source.reads.map((r) => r.length), [4096, 4096, 4096, 4096, 3616]);
}

// 6. Multiple sections / segments fallback semantics preserved
{
  const data = Uint8Array.from([1, 2, 3, 4, 5, 6]);
  const source = new SmallCeilingByteSource(data, 2);

  // sections has no executable, fallback to segments
  const sourceImg = {
    bytes: null,
    source,
    sections: [{ fileSize: 6n, fileOffset: 0n, perms: { execute: false } }],
    segments: [{ fileSize: 6n, fileOffset: 0n, perms: { execute: true } }],
  };

  const result = await fingerprintImage(sourceImg);
  assert.equal(result.bytes, 6);
  assert.deepEqual(source.reads.map((r) => r.length), [2, 2, 2]);
}

console.log('issue-6277 regression test: PASS');
