import assert from 'node:assert/strict';
import {
  __machoSourceCacheForTests,
  clearMachOSourceCache,
  parseMachOSource,
} from '../../../js/binary/macho-source-cache.js';
import { makeFatMachOFixture } from '../../universal-binary.mjs';
import { MACHO_METADATA_LIMITS } from '../../../js/binary/macho-budget.js';

class StaticByteSource {
  constructor(bytes) {
    this.bytes = bytes;
    this.size = BigInt(bytes.length);
    this.maxReadLength = 1024 * 1024;
    this.reads = 0;
  }
  async read(offset, length) {
    this.reads++;
    const start = Number(offset);
    return this.bytes.slice(start, start + length);
  }
}

const ranges = { pageSize:128, maxPageSize:128, maxCachedBytes:2 * 1024 * 1024 };
const key = (metadataLimits) => __machoSourceCacheForTests.cacheKey({ sliceIndex:0, metadataLimits, ranges });

assert.deepEqual(
  Object.keys(JSON.parse(key({})).metadataLimits),
  Object.keys(MACHO_METADATA_LIMITS),
  'cache identity must derive from the canonical Mach-O metadata-limit schema so future budget fields cannot be omitted',
);

assert.notEqual(
  key({ records:1 }),
  key({ records:100_000 }),
  'metadata limits that change parser completeness must not alias in the slice cache',
);
assert.equal(
  key({ records:1, objects:2 }),
  key({ objects:2, records:1 }),
  'metadata limit property order must not fragment the semantic cache identity',
);
assert.equal(
  key({ records:'1' }),
  key({ records:1 }),
  'cache identity must use the same accepted numeric normalization as the Mach-O metadata budget',
);
assert.equal(
  key({ records:Number.NaN }),
  key({}),
  'invalid overrides that fall back to defaults must retain the default cache identity',
);

async function parse(source, records) {
  return parseMachOSource(source, { sliceIndex:0, metadataLimits:{ records }, ranges });
}

{
  const source = new StaticByteSource(makeFatMachOFixture());
  try {
    const full = await parse(source, 100_000);
    assert.equal(full.metadata.machoMetadata.complete, true);
    const readsAfterFull = source.reads;

    const limited = await parse(source, 0);
    assert.equal(limited.metadata.machoMetadata.complete, false, 'tight metadata budget must not reuse a prior complete image');
    assert.equal(limited.metadata.machoMetadata.limits.records, 0);
    assert.ok(source.reads > readsAfterFull, 'different metadata policy must start a distinct producer');
  } finally {
    clearMachOSourceCache(source);
  }
}

{
  const source = new StaticByteSource(makeFatMachOFixture());
  try {
    const limited = await parse(source, 0);
    assert.equal(limited.metadata.machoMetadata.complete, false);
    const readsAfterLimited = source.reads;

    const full = await parse(source, 100_000);
    assert.equal(full.metadata.machoMetadata.complete, true, 'wide metadata budget must not reuse a prior partial image');
    assert.equal(full.metadata.machoMetadata.limits.records, 100_000);
    assert.ok(source.reads > readsAfterLimited, 'reverse call order must remain policy-isolated');
  } finally {
    clearMachOSourceCache(source);
  }
}

{
  const source = new StaticByteSource(makeFatMachOFixture());
  try {
    const first = await parse(source, 100_000);
    const readsAfterFirst = source.reads;
    const second = await parse(source, '100000');
    assert.equal(second.metadata.machoMetadata.complete, first.metadata.machoMetadata.complete);
    assert.equal(source.reads, readsAfterFirst, 'semantically identical normalized metadata limits should still reuse the cache entry');
  } finally {
    clearMachOSourceCache(source);
  }
}

console.log('issue #4155 Mach-O source cache metadata-limit isolation: PASS');
