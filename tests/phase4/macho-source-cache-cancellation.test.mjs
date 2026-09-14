import assert from 'node:assert/strict';
import {
  __machoSourceCacheForTests,
  clearMachOSourceCache,
  parseMachOSource,
} from '../../js/binary/macho-source-cache.js';
import { makeFatMachOFixture } from '../universal-binary.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

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

const raceBytes = makeFatMachOFixture();
const firstReadStarted = deferred();
const oldProducerAborted = deferred();
const releaseOldRead = deferred();
let raceReads = 0;
const raceSource = {
  size:BigInt(raceBytes.length),
  maxReadLength:1024 * 1024,
  async read(offset, length, { signal } = {}) {
    raceReads++;
    if (raceReads === 1) {
      firstReadStarted.resolve();
      if (!signal?.aborted) {
        await new Promise((resolve) => {
          signal?.addEventListener('abort', () => {
            oldProducerAborted.resolve();
            releaseOldRead.promise.then(resolve);
          }, { once:true });
        });
      } else {
        oldProducerAborted.resolve();
        await releaseOldRead.promise;
      }
      const error = new Error('old Mach-O producer aborted');
      error.name = 'AbortError';
      throw error;
    }
    const start = Number(offset);
    return raceBytes.subarray(start, start + length);
  },
};

try {
  const consumerA = new AbortController();
  const stale = parseMachOSource(raceSource, { sliceIndex:0, signal:consumerA.signal, ranges });
  await firstReadStarted.promise;
  consumerA.abort(new Error('caller A cancelled'));
  await assert.rejects(stale, /caller A cancelled/);
  await oldProducerAborted.promise;

  const readsBeforeFresh = raceReads;
  const fresh = parseMachOSource(raceSource, { sliceIndex:0, ranges });
  assert.ok(raceReads > readsBeforeFresh, 'fresh caller must start a replacement producer before old rejection cleanup');

  releaseOldRead.resolve();
  const freshImage = await fresh;
  assert.equal(freshImage.format, 'macho');

  await Promise.resolve();
  const readsBeforeReuse = raceReads;
  const reused = await parseMachOSource(raceSource, { sliceIndex:0, ranges });
  assert.equal(reused.format, 'macho');
  assert.equal(raceReads, readsBeforeReuse, 'old producer cleanup must not delete the replacement cache entry');
} finally {
  releaseOldRead.resolve();
  clearMachOSourceCache(raceSource);
}

console.log('macho-source-cache-cancellation: PASS');
