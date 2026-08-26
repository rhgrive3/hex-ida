import assert from 'node:assert/strict';
import { MemoryByteSource } from '../js/binary/source.js';
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

console.log('platform-bytesource: PASS');
