import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryByteSource } from '../js/binary/source.js';
import { parseMachOSource } from '../js/binary/macho-source-cache.js';
import { parseMachOSource as parseMachOSourceRaw } from '../js/binary/source-loaders.js';

// #5183 — cache-key identity must not launder typed parser options: a request
// the raw parser rejects must never be served from a cached parse of a
// differently-typed (but colliding) request.

function fatFixture() {
  const bytes = new Uint8Array(0x9000), dv = new DataView(bytes.buffer);
  dv.setUint32(0, 0xcafebabe, false); dv.setUint32(4, 2, false);
  const CPU_ARM64 = 0x0100000c;
  const writeFat = (p, subtype, off) => {
    dv.setUint32(p, CPU_ARM64, false); dv.setUint32(p + 4, subtype, false);
    dv.setUint32(p + 8, off, false); dv.setUint32(p + 12, 32, false); dv.setUint32(p + 16, 14, false);
  };
  writeFat(8, 2, 0x4000); writeFat(28, 0, 0x8000);
  const writeThin = (off, subtype) => {
    dv.setUint32(off, 0xfeedfacf, true);
    dv.setInt32(off + 4, CPU_ARM64, true); dv.setInt32(off + 8, subtype, true);
    dv.setUint32(off + 12, 2, true); dv.setUint32(off + 16, 0, true);
    dv.setUint32(off + 20, 0, true); dv.setUint32(off + 24, 0, true); dv.setUint32(off + 28, 0, true);
  };
  writeThin(0x4000, 2); writeThin(0x8000, 0);
  return bytes;
}

function cacheEligibleSource() {
  const inner = new MemoryByteSource(fatFixture());
  return {
    size: inner.size,
    maxReadLength: inner.maxReadLength,
    read: async (offset, length, options) => new Uint8Array(await inner.read(offset, length, options)),
  };
}

test('#5183 structured sliceIndex cannot be served from a cached valid-key parse', async () => {
  // The raw parser rejects a bigint sliceIndex outright.
  await assert.rejects(
    () => parseMachOSourceRaw(new MemoryByteSource(fatFixture()), { sliceIndex: 0n }),
    /not present in the universal binary/,
  );

  // Prime the cache with the VALID string '0' — normalizeScalar(0n) === '0'
  // gives the two requests the same key.
  const source = cacheEligibleSource();
  const first = await parseMachOSource(source, { sliceIndex: '0' });
  assert.equal(first.metadata.fat.selected.offset, 0x4000n);

  await assert.rejects(
    () => parseMachOSource(source, { sliceIndex: 0n }),
    /not present in the universal binary/,
    'bigint sliceIndex must be rejected even when a string-keyed parse is cached',
  );
});

test('#5183 structured sliceIndex cannot be served from a cached valid-key parse (ranges included)', async () => {
  await assert.rejects(
    () => parseMachOSourceRaw(new MemoryByteSource(fatFixture()), { sliceIndex: ['1'] }),
    /not present in the universal binary/,
  );

  // Prime with the VALID string sliceIndex '1'; the structured-array attack
  // ['1'] normalizes (String(['1']) === '1') to the same key.
  const source = cacheEligibleSource();
  const ranges = { pageSize: 65536, maxPageSize: 2 * 1024 * 1024, maxCachedBytes: 16 * 1024 * 1024, maxReads: 4096 };
  const first = await parseMachOSource(source, { sliceIndex: '1', ranges });
  assert.equal(first.metadata.fat.selected.offset, 0x8000n);

  await assert.rejects(
    () => parseMachOSource(source, { sliceIndex: ['1'], ranges }),
    /not present in the universal binary/,
    'structured sliceIndex must be rejected even when a colliding parse is cached',
  );
});
