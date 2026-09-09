import test from 'node:test';
import assert from 'node:assert/strict';

import { SparseByteBuffer, parseSourceRanges } from '../js/binary/source-reader.js';

// #5554: SourceRangeMissingError reports offset..(offset+length) spanning to
// the END of the parser's requested range even when that range's tail is
// already cached. The reader used to keep reading from the error offset and
// re-fetched the already-cached tail against the cache budget, throwing
// ByteSourceLimitError although every required byte was in the cache.

test('#5554 missingSpans reports only the genuinely uncached subranges', () => {
  const buffer = new SparseByteBuffer(100n);
  buffer.add(50n, new Uint8Array(50).fill(0xcd));
  assert.deepEqual(buffer.missingSpans(0n, 100n), [{ start: 0n, end: 50n }],
    'the cached tail [50,100) must not appear as missing');
  assert.deepEqual(buffer.missingSpans(0n, 100n).length, 1);
});

test('#5554 a fully cached range has no missing spans', () => {
  const buffer = new SparseByteBuffer(10n);
  buffer.add(0n, new Uint8Array(10));
  assert.deepEqual(buffer.missingSpans(0n, 10n), []);
});

test('#5554 a fully-cached-tail budget does not trigger a spurious limit error', async () => {
  const SIZE = 100n;
  let reads = 0;
  const source = {
    size: SIZE,
    maxReadLength: 64,
    async readExactly(offset, length) {
      reads += 1;
      const bytes = new Uint8Array(Number(length));
      bytes.fill(0xab);
      return bytes;
    },
  };
  const parser = (sparse) => {
    const data = sparse.subarray(0n, SIZE);
    return { data, metadata: {}, attachSource() {} };
  };
  // The tail [50,100) is pre-cached; the budget (100) is exactly consumed
  // after the first gap [0,50) is filled. The old loop then tried to re-read
  // the cached tail and threw ByteSourceLimitError.
  const image = await parseSourceRanges(source, parser, {}, {
    pageSize: 50,
    maxPageSize: 50,
    maxCachedBytes: 100,
    initial: [{ offset: 50n, bytes: new Uint8Array(50).fill(0xcd) }],
  });
  assert.equal(image.data.length, 100);
  assert.equal(reads, 1, 'only the genuinely missing gap may be fetched');
});

test('#5554 byte-level read tracking still charges real fetches', async () => {
  const SIZE = 120n;
  let reads = 0;
  const source = {
    size: SIZE,
    maxReadLength: 64,
    async readExactly(offset, length) {
      reads += 1;
      return new Uint8Array(Number(length)).fill(0xab);
    },
  };
  const parser = (sparse) => {
    const data = sparse.subarray(0n, SIZE);
    return { data, metadata: {}, attachSource() {} };
  };
  const image = await parseSourceRanges(source, parser, {}, {
    pageSize: 50,
    maxPageSize: 50,
    maxCachedBytes: 120,
  });
  assert.equal(image.data.length, 120);
  assert.ok(reads >= 3, 'uncached data is still fetched');
  assert.equal(image.metadata.sourceReads.requests, reads,
    'read accounting covers every real fetch');
});
