import assert from 'node:assert/strict';
import { ByteSource } from '../js/binary/source.js';
import { ByteSourceCancelledError } from '../js/bytesource/cached.js';
import { PagedArtifactReader } from '../js/core/artifacts/paging/index.js';

// 1. caller signal abort -> ByteSourceCancelledError
{
  const source = {
    size: 16n,
    maxReadLength: 16,
    async read() {
      await new Promise((r) => setTimeout(r, 20));
      return new Uint8Array(16);
    },
  };
  const reader = new PagedArtifactReader(source, { sourceId: 'req1', pageSize: 16 });
  const ac = new AbortController();
  const promise = reader.readPage(0n, { signal: ac.signal });
  ac.abort();
  await assert.rejects(promise, (err) => err instanceof ByteSourceCancelledError);
  assert.equal(reader.metrics().cancelledRequests, 1);
}

// 2. internal controller 未abort + source が独立した DOMException('...', 'AbortError') -> 元 error を保持
{
  const independentAbort = new DOMException('Custom fetch timeout', 'AbortError');
  const source = {
    size: 16n,
    maxReadLength: 16,
    async read() {
      throw independentAbort;
    },
  };
  const reader = new PagedArtifactReader(source, { sourceId: 'req2', pageSize: 16 });
  const error = await reader.readPage(0n).catch((e) => e);
  assert.equal(error, independentAbort);
  assert.equal(error.name, 'AbortError');
  assert.equal(error instanceof ByteSourceCancelledError, false);
  assert.equal(reader.metrics().cancelledRequests, 0);
}

// 3. internal controller 未abort + source が Error -> 元 error を保持
{
  const sourceError = new Error('Disk I/O error');
  const source = {
    size: 16n,
    maxReadLength: 16,
    async read() {
      throw sourceError;
    },
  };
  const reader = new PagedArtifactReader(source, { sourceId: 'req3', pageSize: 16 });
  const error = await reader.readPage(0n).catch((e) => e);
  assert.equal(error, sourceError);
  assert.equal(reader.metrics().cancelledRequests, 0);
}

// 4. source が正規 ByteSourceCancelledError を返す場合は維持
{
  const customCancelled = new ByteSourceCancelledError('underlying channel cancelled');
  const source = {
    size: 16n,
    maxReadLength: 16,
    async read() {
      throw customCancelled;
    },
  };
  const reader = new PagedArtifactReader(source, { sourceId: 'req4', pageSize: 16 });
  const error = await reader.readPage(0n).catch((e) => e);
  assert.equal(error, customCancelled);
  assert.equal(error instanceof ByteSourceCancelledError, true);
}

// 5. last waiter 消失で internal controller abort -> cancellation
{
  let sourceSignal = null;
  const source = {
    size: 16n,
    maxReadLength: 16,
    async read(offset, length, options) {
      sourceSignal = options.signal;
      await new Promise((resolve, reject) => {
        if (options.signal?.aborted) return reject(options.signal.reason);
        options.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
      return new Uint8Array(16);
    },
  };
  const reader = new PagedArtifactReader(source, { sourceId: 'req5', pageSize: 16 });
  const ac = new AbortController();
  const promise = reader.readPage(0n, { signal: ac.signal });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(sourceSignal, 'source should have received signal');
  assert.equal(sourceSignal.aborted, false);
  ac.abort();
  await assert.rejects(promise, (err) => err instanceof ByteSourceCancelledError);
  assert.equal(sourceSignal.aborted, true);
}

// 6. concurrent same-page waiters isolation: waiter A aborts, waiter B succeeds
{
  let unblock;
  const gate = new Promise((r) => { unblock = r; });
  const source = {
    size: 16n,
    maxReadLength: 16,
    async read() {
      await gate;
      return new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    },
  };
  const reader = new PagedArtifactReader(source, { sourceId: 'req6', pageSize: 16 });
  const ac = new AbortController();
  const promiseA = reader.readPage(0n, { signal: ac.signal });
  const promiseB = reader.readPage(0n);

  ac.abort();
  await assert.rejects(promiseA, (err) => err instanceof ByteSourceCancelledError);

  unblock();
  const pageB = await promiseB;
  assert.equal(pageB.bytes.length, 16);
  assert.equal(reader.metrics().pagesFetched, 1);
  assert.equal(reader.metrics().cancelledRequests, 1);
}

console.log('issue-6292 regression test: PASS');
