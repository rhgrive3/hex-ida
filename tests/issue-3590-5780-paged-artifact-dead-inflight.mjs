import assert from 'node:assert/strict';
import { ByteSourceCancelledError } from '../js/bytesource/cached.js';
import { PagedArtifactReader } from '../js/core/artifacts/paging/index.js';

const bytes = () => new Uint8Array([1, 2, 3, 4]);
const readerOptions = {
  sourceId: 'issue-3590',
  pageSize: 4,
  maxRangeBytes: 4,
  maxRetainedPageBytes: 4,
};

// A dead generation left in inflight after its last waiter cancels must not
// capture a fresh reader. Keep the old producer unsettled to make the race
// deterministic, then verify its finally() cannot delete the replacement.
{
  let calls = 0;
  let firstReject;
  let secondResolve;
  let firstProducerSignal;
  const source = {
    size: 4n,
    maxReadLength: 4,
    read(_offset, _length, { signal } = {}) {
      calls++;
      if (calls === 1) {
        firstProducerSignal = signal;
        return new Promise((_resolve, reject) => { firstReject = reject; });
      }
      if (calls === 2) {
        return new Promise((resolve) => { secondResolve = resolve; });
      }
      throw new Error(`unexpected source read ${calls}`);
    },
  };

  const reader = new PagedArtifactReader(source, readerOptions);
  const controller = new AbortController();
  const first = reader.readPage(0n, { signal: controller.signal });
  await Promise.resolve();
  assert.equal(calls, 1);

  controller.abort();
  await assert.rejects(first, (error) => error instanceof ByteSourceCancelledError);
  assert.equal(firstProducerSignal.aborted, true, 'last waiter must still abort its producer');

  const second = reader.readPage(0n);
  await Promise.resolve();
  assert.equal(calls, 2, 'fresh reader must start a new producer instead of joining discarded inflight work');
  assert.equal(reader.metrics().rangeRequestCount, 2);
  assert.equal(reader.metrics().pagesReused, 0, 'dead inflight work is not a reuse');
  assert.equal(reader.metrics().pendingRequests, 1);

  firstReject(new DOMException('old producer aborted', 'AbortError'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(reader.metrics().pendingRequests, 1, 'stale producer finally must not remove the replacement');

  secondResolve(bytes());
  const page = await second;
  assert.deepEqual([...page.bytes], [1, 2, 3, 4]);
  assert.equal(reader.metrics().pagesFetched, 1);
  assert.equal(reader.metrics().pendingRequests, 0);
}

// A still-live generation remains single-flight: cancelling one of two
// existing waiters must not abort the producer or force a replacement read.
{
  let calls = 0;
  let resolveRead;
  let producerSignal;
  const source = {
    size: 4n,
    maxReadLength: 4,
    read(_offset, _length, { signal } = {}) {
      calls++;
      producerSignal = signal;
      return new Promise((resolve) => { resolveRead = resolve; });
    },
  };

  const reader = new PagedArtifactReader(source, { ...readerOptions, sourceId: 'issue-3590-live' });
  const controller = new AbortController();
  const first = reader.readPage(0n, { signal: controller.signal });
  const second = reader.readPage(0n);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(reader.metrics().pagesReused, 1);

  controller.abort();
  await assert.rejects(first, (error) => error instanceof ByteSourceCancelledError);
  assert.equal(producerSignal.aborted, false, 'remaining waiter keeps the shared producer alive');

  resolveRead(bytes());
  const page = await second;
  assert.deepEqual([...page.bytes], [1, 2, 3, 4]);
  assert.equal(calls, 1);
}

// clear() marks the old producer discarded and removes it from the map. Its
// delayed settlement must not interfere with the fresh generation installed
// under the same page key.
{
  let calls = 0;
  let firstReject;
  let secondResolve;
  const source = {
    size: 4n,
    maxReadLength: 4,
    read() {
      calls++;
      if (calls === 1) return new Promise((_resolve, reject) => { firstReject = reject; });
      if (calls === 2) return new Promise((resolve) => { secondResolve = resolve; });
      throw new Error(`unexpected source read ${calls}`);
    },
  };

  const reader = new PagedArtifactReader(source, { ...readerOptions, sourceId: 'issue-3590-clear' });
  const oldRead = reader.readPage(0n);
  await Promise.resolve();
  reader.clear();

  const freshRead = reader.readPage(0n);
  await Promise.resolve();
  assert.equal(calls, 2);
  assert.equal(reader.metrics().pendingRequests, 1);

  firstReject(new DOMException('cleared producer aborted', 'AbortError'));
  await assert.rejects(oldRead, (error) => error instanceof ByteSourceCancelledError);
  await Promise.resolve();
  assert.equal(reader.metrics().pendingRequests, 1);

  secondResolve(bytes());
  const page = await freshRead;
  assert.deepEqual([...page.bytes], [1, 2, 3, 4]);
  assert.equal(reader.metrics().pendingRequests, 0);
}

console.log('issue-3590/5780 paged artifact dead-inflight regression: PASS');
