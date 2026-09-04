import assert from 'node:assert/strict';
import { PagedArtifactReader } from '../js/core/artifacts/paging/index.js';

// #6122: readRange out-of-range prefetch failure must not fail requested bytes.
{
  const source = {
    size: 2n,
    maxReadLength: 1,
    async read(offset) {
      if (offset === 0n) return Uint8Array.of(0xaa);
      throw new Error('prefetch failed');
    },
  };
  const reader = new PagedArtifactReader(source, {
    sourceId: 'fixture-6122',
    pageSize: 1,
    maxRangeBytes: 1,
    maxRetainedPageBytes: 2,
    maxPrefetchPages: 1,
  });
  const result = await reader.readRange(0n, 1, { prefetchPages: 1 });
  assert.equal(result.bytes[0], 0xaa);
}

{
  const source = {
    size: 1n,
    maxReadLength: 1,
    async read() { throw new Error('requested failed'); },
  };
  const reader = new PagedArtifactReader(source, {
    sourceId: 'fixture-6122-requested',
    pageSize: 1,
    maxRangeBytes: 1,
    maxRetainedPageBytes: 2,
    maxPrefetchPages: 1,
  });
  await assert.rejects(reader.readRange(0n, 1, { prefetchPages: 1 }), /requested failed/);
}

{
  const source = {
    size: 1n,
    maxReadLength: 1,
    async read() { return Uint8Array.of(0xaa); },
  };
  const reader = new PagedArtifactReader(source, {
    sourceId: 'fixture-6122-noprefetch',
    pageSize: 1,
    maxRangeBytes: 1,
    maxRetainedPageBytes: 2,
    maxPrefetchPages: 1,
  });
  const result = await reader.readRange(0n, 1, { prefetchPages: 0 });
  assert.equal(result.bytes[0], 0xaa);
}

{
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const source = {
    size: 10n,
    maxReadLength: 10,
    async read(offset) {
      if (offset === 0n) return Uint8Array.of(0xaa);
      await gate;
      return Uint8Array.of(0xbb);
    },
  };
  const reader = new PagedArtifactReader(source, {
    sourceId: 'fixture-6122-abort',
    pageSize: 1,
    maxRangeBytes: 1,
    maxRetainedPageBytes: 10,
    maxPrefetchPages: 1,
  });
  const controller = new AbortController();
  const pending = reader.readRange(0n, 1, { prefetchPages: 1, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  release();
  await assert.rejects(pending, (error) => error?.name === 'ByteSourceCancelledError' || error?.name === 'AbortError');
}

{
  const calls = [];
  const source = {
    size: 2n,
    maxReadLength: 1,
    async read(offset) {
      calls.push(offset);
      if (offset === 1n && calls.filter((item) => item === 1n).length === 1) throw new Error('first prefetch fail');
      return Uint8Array.of(offset === 0n ? 0xaa : 0xbb);
    },
  };
  const reader = new PagedArtifactReader(source, {
    sourceId: 'fixture-6122-retry',
    pageSize: 1,
    maxRangeBytes: 1,
    maxRetainedPageBytes: 2,
    maxPrefetchPages: 1,
  });
  const first = await reader.readRange(0n, 1, { prefetchPages: 1 });
  assert.equal(first.bytes[0], 0xaa);
  const second = await reader.readRange(1n, 1, { prefetchPages: 0 });
  assert.equal(second.bytes[0], 0xbb);
}

console.log('issue-6122: PASS');
