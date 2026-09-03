import assert from 'node:assert/strict';
import { clearMachOSourceCache, parseMachOSource } from '../../js/binary/index.js';
import { makeFatMachOFixture } from '../universal-binary.mjs';

const source = makeFatMachOFixture();
const ranges = { pageSize:128, maxPageSize:128, maxCachedBytes:2 * 1024 * 1024 };
const staleStringAbort = new AbortController();
staleStringAbort.abort(new Error('stale-string-consumer'));

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

  const healthyStringAbort = new AbortController();
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
} finally {
  clearMachOSourceCache(source);
}

console.log('macho-source-cache-cancellation: PASS');
