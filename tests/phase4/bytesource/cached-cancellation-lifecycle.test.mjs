import assert from 'node:assert/strict';
import { CachedByteSource, ByteSourceCancelledError } from '../../../js/bytesource/cached.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function soleConsumerAbortCancelsProducer() {
  let calls = 0;
  let observedSignal = null;
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const source = {
    size: 4n,
    maxReadLength: 4,
    async read(_offset, _length, { signal } = {}) {
      calls++;
      observedSignal = signal ?? null;
      startedResolve();
      return new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once:true });
      });
    },
  };
  const cached = new CachedByteSource(source, { pageSize:4, maxCachedBytes:4 });
  const controller = new AbortController();
  const pending = cached.read(0n, 4, { signal:controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, ByteSourceCancelledError);
  assert.equal(calls, 1);
  assert.ok(observedSignal instanceof AbortSignal);
  assert.equal(observedSignal.aborted, true, 'last waiter cancellation must reach the page producer');
  assert.equal(cached.memoryStats().pendingReads, 0, 'abandoned producer must stop blocking retry');
  assert.equal(cached.memoryStats().bytesCached, 0);
}

async function oneCancelledWaiterDoesNotAbortSharedProducer() {
  let calls = 0;
  let observedSignal = null;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const source = {
    size: 4n,
    maxReadLength: 4,
    async read(_offset, _length, { signal } = {}) {
      calls++;
      observedSignal = signal ?? null;
      startedResolve();
      await gate;
      return Uint8Array.of(1, 2, 3, 4);
    },
  };
  const cached = new CachedByteSource(source, { pageSize:4, maxCachedBytes:4 });
  const a = new AbortController();
  const pa = cached.read(0n, 4, { signal:a.signal });
  await started;
  const pb = cached.read(0n, 4);
  await tick();
  a.abort();
  await assert.rejects(pa, ByteSourceCancelledError);
  assert.equal(observedSignal.aborted, false, 'producer must remain alive while another waiter exists');
  assert.equal(cached.memoryStats().pendingReads, 1);
  release();
  assert.deepEqual([...await pb], [1, 2, 3, 4]);
  assert.equal(calls, 1, 'same-page waiters must remain single-flight');
  assert.equal(cached.memoryStats().bytesCached, 4);
}

async function allCancelledWaitersRetireHungEntryBeforeSettlement() {
  let calls = 0;
  let firstSignal = null;
  let releaseFirst;
  let firstStartedResolve;
  const firstStarted = new Promise((resolve) => { firstStartedResolve = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const source = {
    size: 4n,
    maxReadLength: 4,
    async read(_offset, _length, { signal } = {}) {
      calls++;
      if (calls === 1) {
        firstSignal = signal ?? null;
        firstStartedResolve();
        await firstGate;
        return Uint8Array.of(9, 9, 9, 9);
      }
      return Uint8Array.of(1, 2, 3, 4);
    },
  };
  const cached = new CachedByteSource(source, { pageSize:4, maxCachedBytes:4 });
  const a = new AbortController();
  const b = new AbortController();
  const pa = cached.read(0n, 4, { signal:a.signal });
  await firstStarted;
  const pb = cached.read(0n, 4, { signal:b.signal });
  await tick();
  a.abort();
  await assert.rejects(pa, ByteSourceCancelledError);
  assert.equal(firstSignal.aborted, false);
  b.abort();
  await assert.rejects(pb, ByteSourceCancelledError);
  assert.equal(firstSignal.aborted, true, 'last waiter must abort the old producer');
  assert.equal(cached.memoryStats().pendingReads, 0, 'retired hung entry must be evicted synchronously');

  const fresh = await cached.read(0n, 4);
  assert.deepEqual([...fresh], [1, 2, 3, 4]);
  assert.equal(calls, 2, 'fresh consumer must start a replacement producer immediately');

  releaseFirst();
  await tick();
  await tick();
  assert.deepEqual([...await cached.read(0n, 4)], [1, 2, 3, 4], 'late retired producer must not overwrite replacement cache state');
  assert.equal(calls, 2);
}

async function clearAbortsAndRevokesInflightProducer() {
  let calls = 0;
  let firstSignal = null;
  let releaseFirst;
  let firstStartedResolve;
  const firstStarted = new Promise((resolve) => { firstStartedResolve = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const source = {
    size: 4n,
    maxReadLength: 4,
    async read(_offset, _length, { signal } = {}) {
      calls++;
      if (calls === 1) {
        firstSignal = signal ?? null;
        firstStartedResolve();
        await firstGate;
        return Uint8Array.of(8, 8, 8, 8);
      }
      return Uint8Array.of(4, 3, 2, 1);
    },
  };
  const cached = new CachedByteSource(source, { pageSize:4, maxCachedBytes:4 });
  const stale = cached.read(0n, 4).catch((error) => error);
  await firstStarted;
  cached.clear();
  assert.equal(firstSignal.aborted, true, 'clear() must abort active page producers');
  assert.equal(cached.memoryStats().pendingReads, 0);
  assert.deepEqual([...await cached.read(0n, 4)], [4, 3, 2, 1]);
  releaseFirst();
  await stale;
  await tick();
  assert.deepEqual([...await cached.read(0n, 4)], [4, 3, 2, 1], 'pre-clear producer must not publish into the new generation');
  assert.equal(calls, 2);
}

await soleConsumerAbortCancelsProducer();
await oneCancelledWaiterDoesNotAbortSharedProducer();
await allCancelledWaitersRetireHungEntryBeforeSettlement();
await clearAbortsAndRevokesInflightProducer();
console.log('cached-cancellation-lifecycle: PASS');
