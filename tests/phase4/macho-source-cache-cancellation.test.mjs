import assert from 'node:assert/strict';
import {
  __machoSourceCacheForTests,
  clearMachOSourceCache,
  parseMachOSource,
} from '../../js/binary/macho-source-cache.js';
import { makeFatMachOFixture } from '../universal-binary.mjs';

const source = makeFatMachOFixture();
const ranges = { pageSize:128, maxPageSize:128, maxCachedBytes:2 * 1024 * 1024 };
const staleStringAbort = new AbortController();
staleStringAbort.abort(new Error('stale-string-consumer'));
const healthyStringAbort = new AbortController();

assert.equal(
  __machoSourceCacheForTests.cacheKey({
    sliceIndex:0,
    strings:{ minLength:4, signal:staleStringAbort.signal },
    ranges,
  }),
  __machoSourceCacheForTests.cacheKey({
    sliceIndex:0,
    strings:{ minLength:4, signal:healthyStringAbort.signal },
    ranges,
  }),
  'consumer signal identity/state must not change the semantic cache key',
);
assert.notEqual(
  __machoSourceCacheForTests.cacheKey({ sliceIndex:0, strings:{ minLength:4 }, ranges }),
  __machoSourceCacheForTests.cacheKey({ sliceIndex:0, strings:{ minLength:5 }, ranges }),
  'semantic string scan options must remain part of the cache key',
);
assert.notEqual(
  __machoSourceCacheForTests.cacheKey({ sliceIndex:0, source:{ maxReadLength:4096 }, ranges }),
  __machoSourceCacheForTests.cacheKey({ sliceIndex:0, source:{ maxReadLength:1024 * 1024 }, ranges }),
  'source maxReadLength must remain part of the cache identity',
);

try {
  const first = await parseMachOSource(source, {
    sliceIndex:0,
    strings:{ minLength:4, signal:staleStringAbort.signal },
    ranges,
  });
  assert.equal(
    first.metadata.sourceStrings?.cancelled,
    false,
    'consumer-owned strings.signal must not cancel the shared Mach-O cache producer',
  );

  const second = await parseMachOSource(source, {
    sliceIndex:0,
    strings:{ minLength:4, signal:healthyStringAbort.signal },
    ranges,
  });
  assert.equal(
    second.metadata.sourceStrings?.cancelled,
    false,
    'a stale nested signal must not poison the cache entry reused by a healthy caller',
  );

  const loose = await parseMachOSource(source, {
    sliceIndex:0,
    source:{ maxReadLength:1024 * 1024 },
    ranges,
  });
  const tight = await parseMachOSource(source, {
    sliceIndex:0,
    source:{ maxReadLength:4096 },
    ranges,
  });
  assert.equal(loose.source?.maxReadLength, 1024 * 1024);
  assert.equal(tight.source?.maxReadLength, 4096);

  const tightFirst = await parseMachOSource(source, {
    sliceIndex:0,
    source:{ maxReadLength:4096 },
    strings:{ minLength:5 },
    ranges,
  });
  const looseSecond = await parseMachOSource(source, {
    sliceIndex:0,
    source:{ maxReadLength:1024 * 1024 },
    strings:{ minLength:5 },
    ranges,
  });
  assert.equal(tightFirst.source?.maxReadLength, 4096);
  assert.equal(looseSecond.source?.maxReadLength, 1024 * 1024);
} finally {
  clearMachOSourceCache(source);
}

console.log('macho-source-cache-cancellation: PASS');
