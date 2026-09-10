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

test('#5554 a chunk beyond the requested range must not duplicate the tail gap', () => {
  // Reviewer counterexample: cached chunk [20,30) lies entirely after the
  // requested range [0,10). The tail gap must be returned exactly once.
  const buffer = new SparseByteBuffer(30n);
  buffer.add(20n, new Uint8Array(10));
  assert.deepEqual(buffer.missingSpans(0n, 10n), [{ start: 0n, end: 10n }]);
  assert.deepEqual(buffer.missingSpans(0n, 30n), [{ start: 0n, end: 20n }]);
  assert.deepEqual(buffer.missingSpans(25n, 30n), [], 'fully covered range');
});

test('#5554 multiple cached chunks yield every gap exactly once, in order', () => {
  const buffer = new SparseByteBuffer(100n);
  buffer.add(10n, new Uint8Array(10));
  buffer.add(50n, new Uint8Array(20));
  assert.deepEqual(buffer.missingSpans(0n, 100n), [
    { start: 0n, end: 10n },
    { start: 20n, end: 50n },
    { start: 70n, end: 100n },
  ]);
});

test('#5554 a duplicate span fetch still fails closed at a real budget exhaustion', async () => {
  // The budget itself stays authoritative: once the cache is at its limit
  // and the parser still needs MORE bytes, the limit error must fire.
  const SIZE = 60n;
  const source = {
    size: SIZE,
    maxReadLength: 64,
    async readExactly(offset, length) {
      return new Uint8Array(Number(length)).fill(0xab);
    },
  };
  const parser = (sparse) => {
    const data = sparse.subarray(0n, SIZE);
    return { data, metadata: {}, attachSource() {} };
  };
  await assert.rejects(
    parseSourceRanges(source, parser, {}, {
      pageSize: 50,
      maxPageSize: 50,
      maxCachedBytes: 10, // too small for the 60 bytes the parser needs
    }),
    (error) => error.name === 'ByteSourceLimitError',
    'a genuinely unsatisfiable budget must still fail closed',
  );
});

test('#5554 a satisfied parser restart does not consume reads', async () => {
  const SIZE = 100n;
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
  // Tail pre-cached + exact budget: the old code re-read the cached tail and
  // threw; the fix must neither throw nor spend a second read.
  const image = await parseSourceRanges(source, parser, {}, {
    pageSize: 50,
    maxPageSize: 50,
    maxCachedBytes: 100,
    initial: [{ offset: 50n, bytes: new Uint8Array(50).fill(0xcd) }],
  });
  assert.equal(image.data.length, 100);
  assert.equal(reads, 1, 'no redundant fetch for the cached tail');
  assert.equal(image.metadata.sourceReads.requests, 1);
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

test('#5554 multiple gaps are fetched once each and merge into one buffer', async () => {
  const SIZE = 120n;
  const fetched = [];
  const source = {
    size: SIZE,
    maxReadLength: 64,
    async readExactly(offset, length) {
      fetched.push([offset, Number(length)]);
      return new Uint8Array(Number(length)).fill(0xab);
    },
  };
  const parser = (sparse) => {
    const data = sparse.subarray(0n, SIZE);
    return { data, metadata: {}, attachSource() {} };
  };
  // Pre-cache two islands so the parser sees three gaps: [0,20), [40,60), [80,120).
  const image = await parseSourceRanges(source, parser, {}, {
    pageSize: 20,
    maxPageSize: 20,
    maxCachedBytes: 120,
    initial: [
      { offset: 20n, bytes: new Uint8Array(20).fill(0xcd) },
      { offset: 60n, bytes: new Uint8Array(20).fill(0xcd) },
    ],
  });
  assert.equal(image.data.length, 120);
  // Every fetched byte must land in a genuinely missing span: no fetch may
  // overlap the pre-cached islands.
  for (const [offset, length] of fetched) {
    const start = BigInt(offset);
    const end = start + BigInt(length);
    const overlaps = (island) => start < island[1] && island[0] < end;
    assert.ok(!overlaps([20n, 40n]) && !overlaps([60n, 80n]),
      `fetch [${start},${end}) must not overlap a cached island`);
  }
  const fetchedBytes = fetched.reduce((sum, [, length]) => sum + length, 0);
  assert.equal(fetchedBytes, 80, 'exactly the 80 missing bytes are fetched');
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
