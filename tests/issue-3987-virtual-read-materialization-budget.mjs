import assert from 'node:assert/strict';
import * as model from '../js/binary/model.js';
import { MemoryByteSource } from '../js/binary/source.js';

const { BinaryImage } = model;

function zeroFillImage(size, meta = {}, input = new Uint8Array(1)) {
  const image = new BinaryImage(input, meta);
  image.addSegment({
    name: 'huge-bss',
    address: 0n,
    size,
    fileOffset: 0n,
    fileSize: 0n,
    perms: { read: true, write: true, execute: false },
  });
  return image;
}

function isVirtualReadLimit(error, requested, limit) {
  return error?.code === 'BINARY_VIRTUAL_READ_RESOURCE_LIMIT'
    && error?.resource === 'residentBytes'
    && error?.requested === requested
    && error?.limit === limit;
}

// A caller/environment-specific cap must reject before any requested output is materialized.
{
  const image = zeroFillImage(16n, { maxVirtualReadBytes: 8 });
  assert.throws(
    () => image.readVirtual(0n, 9n),
    (error) => isVirtualReadLimit(error, 9n, 8n),
    'resident virtual reads above the explicit cap must fail with a typed resource-limit error',
  );
  assert.deepEqual([...image.readVirtual(0n, 8n)], new Array(8).fill(0));
}

// Source-backed reads use the same materialization authority and must fail before touching the source.
{
  let reads = 0;
  const source = new MemoryByteSource(new Uint8Array(16).fill(0xaa), { maxReadLength: 1 });
  const originalReadExactly = source.readExactly.bind(source);
  source.readExactly = async (...args) => { reads++; return originalReadExactly(...args); };
  const image = new BinaryImage(null, { source, fileSize: 16n, maxVirtualReadBytes: 8 });
  image.addSegment({
    name: 'file-backed', address: 0n, size: 16n, fileOffset: 0n, fileSize: 16n, perms: { read: true },
  });
  await assert.rejects(
    image.readVirtualAsync(0n, 9n),
    (error) => isVirtualReadLimit(error, 9n, 8n),
  );
  assert.equal(reads, 0, 'rejected materialization must not trigger ByteSource IO');
}

// A ResourceBudget-style residentBytes remainder further tightens the configured/environment cap.
{
  const budget = {
    remaining(resource) {
      assert.equal(resource, 'residentBytes');
      return 4;
    },
  };
  const image = zeroFillImage(16n, { maxVirtualReadBytes: 8, resourceBudget: budget });
  assert.throws(
    () => image.readVirtual(0n, 5n),
    (error) => isVirtualReadLimit(error, 5n, 4n),
  );
  assert.deepEqual([...image.readVirtual(0n, 4n)], [0, 0, 0, 0]);
}


// Limit inputs are typed rather than coerced from structured or string values.
{
  assert.throws(() => zeroFillImage(1n, { maxVirtualReadBytes: '8' }), TypeError);
  assert.throws(() => zeroFillImage(1n, { maxVirtualReadBytes: 1.5 }), TypeError);
  assert.throws(() => zeroFillImage(1n, { maxVirtualReadBytes: -1 }), TypeError);
}

// Invalid/unmapped remains distinct from a resource limit.
{
  const image = zeroFillImage(16n, { maxVirtualReadBytes: 8 });
  assert.equal(image.readVirtual(-1n, 9n), null);
  assert.equal(image.readVirtual(32n, 1n), null);
}

// The default cap protects the original MAX_SAFE zero-fill counterexample without relying on
// engine-specific TypedArray allocation failure.
{
  const image = zeroFillImage(BigInt(Number.MAX_SAFE_INTEGER));
  assert.throws(
    () => image.readVirtual(0n, BigInt(Number.MAX_SAFE_INTEGER)),
    (error) => error?.code === 'BINARY_VIRTUAL_READ_RESOURCE_LIMIT'
      && error.requested === BigInt(Number.MAX_SAFE_INTEGER)
      && error.limit > 0n
      && error.limit < error.requested,
  );
}

// Large logical ranges remain available through a bounded async chunk path.  Only a few chunks
// are consumed here; the fixture is 256 MiB but peak materialization is the requested 1 MiB chunk.
{
  const logicalSize = 256n * 1024n * 1024n;
  const image = zeroFillImage(logicalSize);
  let chunks = 0;
  let bytes = 0;
  for await (const chunk of image.readVirtualChunks(0n, logicalSize, { maxChunkLength: 1024 * 1024 })) {
    chunks++;
    bytes += chunk.length;
    assert.ok(chunk.length <= 1024 * 1024);
    assert.ok(chunk.every((byte) => byte === 0));
    if (chunks === 3) break;
  }
  assert.equal(chunks, 3);
  assert.equal(bytes, 3 * 1024 * 1024);
}

// File-backed streaming is also bounded and preserves byte/zero-fill composition.
{
  const source = new MemoryByteSource(Uint8Array.from([0x10, 0x11, 0x12, 0x13]), { maxReadLength: 2 });
  const image = new BinaryImage(null, { source, fileSize: 4n, maxVirtualReadBytes: 4 });
  image.addSegment({
    name: 'mixed', address: 0x1000n, size: 8n,
    fileOffset: 0n, fileSize: 4n, perms: { read: true },
  });
  const got = [];
  for await (const chunk of image.readVirtualChunks(0x1000n, 8n, { maxChunkLength: 2 })) {
    got.push(...chunk);
  }
  assert.deepEqual(got, [0x10, 0x11, 0x12, 0x13, 0, 0, 0, 0]);
}

console.log('issue #3987 virtual-read materialization budget regression: ok');
