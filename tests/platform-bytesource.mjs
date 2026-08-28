import assert from 'node:assert/strict';
import { MemoryByteSource, SubrangeByteSource, asByteSource } from '../js/binary/source.js';
import { ByteView } from '../js/binary/reader.js';
import { CachedByteSource, InstrumentedByteSource, ByteSourceCancelledError } from '../js/bytesource/cached.js';
import { scanSourceStrings } from '../js/bytesource/strings.js';
import { hashByteSource } from '../js/platform/hash.js';

const bytes = Uint8Array.from({ length: 4096 }, (_, i) => i & 0xff);
const instrumented = new InstrumentedByteSource(new MemoryByteSource(bytes, { maxReadLength: 1024 }));
const cached = new CachedByteSource(instrumented, { pageSize: 256, maxCachedBytes: 512, maxReadLength: 1024 });
assert.deepEqual([...await cached.read(300n, 4)], [...bytes.subarray(300, 304)]);
await cached.read(301n, 8);
assert.ok(cached.memoryStats().hits >= 1);
assert.ok(cached.memoryStats().bytesCached <= 512);
assert.ok(instrumented.metrics().largestSingleRead <= 256);
assert.equal(instrumented.reads.some((x) => x.length === bytes.length), false, 'range source must never read the whole file in one request');

const controller = new AbortController();
controller.abort();
await assert.rejects(() => cached.read(0n, 4, { signal: controller.signal }), ByteSourceCancelledError);

const hash = await hashByteSource(new MemoryByteSource(bytes, { maxReadLength: 1024 }), { chunkSize: 512 });
assert.match(hash, /^fnv1a64:1000:[0-9a-f]{16}$/);

const stringImage = {
  sections: [],
  segments: [],
  endian: 'little',
  offsetToAddress(offset) { return offset; },
};
const stringBytes = new TextEncoder().encode('AAAA\0BBBB\0CCCC\0');
const zeroLimitStrings = await scanSourceStrings(stringImage, stringBytes, {
  minLength: 4,
  utf16: false,
  limit: 0,
});
assert.equal(zeroLimitStrings.results.length, 1, 'explicit limit=0 must clamp to the minimum limit of 1');
assert.equal(zeroLimitStrings.capped, true);

const strictBackend = new MemoryByteSource(bytes, { maxReadLength: 64 });
assert.doesNotThrow(() => new CachedByteSource(strictBackend, { pageSize: 64, maxCachedBytes: 64 }));
assert.throws(
  () => new CachedByteSource(strictBackend, { pageSize: 65, maxCachedBytes: 65 }),
  /pageSize must not exceed source maxReadLength/,
);

const customBackingBytes = Uint8Array.of(0x7f, 0x00);
const customBacking = {
  __binaryByteBacking: true,
  size: 2n,
  subarray(start, end) { return customBackingBytes.subarray(Number(start), Number(end)); },
};
const bigintView = new ByteView(customBacking);
assert.equal(bigintView.u8(0), 0x7f);
assert.equal(bigintView.data(0, 1n).view.getUint8(0), 0x7f);
assert.equal(bigintView.data(0, 2n).view.byteLength, 2);

const limitedParent = new MemoryByteSource(bytes, { maxReadLength: 64 });
assert.equal(new SubrangeByteSource(limitedParent, 0n, 128n, { maxReadLength: 128 }).maxReadLength, 64);
assert.equal(new SubrangeByteSource(limitedParent, 0n, 128n, { maxReadLength: 32 }).maxReadLength, 32);
assert.equal(asByteSource(limitedParent, { maxReadLength: 128 }).maxReadLength, 64);
assert.equal(asByteSource(limitedParent, { maxReadLength: 32 }).maxReadLength, 32);

const utf16leBytes = Uint8Array.of(0x41, 0, 0x42, 0, 0x43, 0, 0x44, 0, 0x45, 0, 0x46, 0, 0, 0);
const utf16Split = await scanSourceStrings(stringImage, utf16leBytes, {
  minLength: 2,
  maxLength: 3,
  utf16: 'le',
  chunkSize: 64,
});
assert.deepEqual(
  utf16Split.results.filter((x) => x.encoding === 'utf16le').map((x) => x.text),
  ['ABC', 'DEF'],
  'UTF-16 continuation at maxLength must not skip the next code unit',
);

console.log('platform-bytesource: PASS');
