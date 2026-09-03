import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeFunctionCached, clearAnalysisCache } from '../../js/analyze.js';
import { waitForAppProducer } from '../../js/analysis/producer-wait.js';

function pendingOperation() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function sharedEntry(promise) {
  return {
    settled: false,
    waiters: 0,
    promise,
    controller: new AbortController(),
  };
}

test('#3646 malformed app-producer signal cannot leave a ghost waiter', async () => {
  const { promise } = pendingOperation();
  const entry = sharedEntry(promise);

  await assert.rejects(
    waitForAppProducer(entry, { aborted: false }),
    /analysis-invalid-abort-signal/,
  );

  assert.equal(entry.waiters, 0);
  assert.equal(entry.controller.signal.aborted, true, 'sole malformed consumer must not keep the producer alive');
});

test('#3646 malformed app-producer signal does not cancel another live waiter', async () => {
  const { promise } = pendingOperation();
  const entry = sharedEntry(promise);
  const live = new AbortController();
  const liveWait = waitForAppProducer(entry, live.signal);

  assert.equal(entry.waiters, 1);
  await assert.rejects(
    waitForAppProducer(entry, { aborted: false }),
    /analysis-invalid-abort-signal/,
  );

  assert.equal(entry.waiters, 1);
  assert.equal(entry.controller.signal.aborted, false, 'malformed peer must not abort a producer with a live waiter');

  live.abort('test-live-waiter-done');
  await assert.rejects(liveWait, (error) => error?.name === 'AbortError');
  assert.equal(entry.waiters, 0);
  assert.equal(entry.controller.signal.aborted, true, 'last real waiter still owns producer cancellation');
});

test('#3646 null signal preserves the existing non-cancellable wait contract', async () => {
  const entry = sharedEntry(Promise.resolve('ok'));
  assert.equal(await waitForAppProducer(entry, null), 'ok');
  assert.equal(entry.waiters, 0);
});

test('#3646 analyzeFunctionCached registration failure detaches only the malformed waiter', async () => {
  clearAnalysisCache();
  let started = 0;
  let cancelled = 0;
  const { promise: operation } = pendingOperation();
  operation.cancel = () => { cancelled += 1; };
  const backend = {
    fetchChunk() {
      started += 1;
      return operation;
    },
  };
  const region = { id: 'issue-3646', vmAddr: 0n, size: 4n, revision: 1 };
  const live = new AbortController();
  const liveWait = analyzeFunctionCached(backend, region, 0, 0, null, null, {
    signal: live.signal,
    texts: false,
  });

  assert.equal(started, 1);
  const throwingSignal = {
    aborted: false,
    addEventListener() { throw new Error('listener-registration-failed'); },
    removeEventListener() {},
  };
  await assert.rejects(
    analyzeFunctionCached(backend, region, 0, 0, null, null, {
      signal: throwingSignal,
      texts: false,
    }),
    /listener-registration-failed/,
  );

  assert.equal(started, 1, 'shared producer must remain single-flight');
  assert.equal(cancelled, 0, 'malformed peer must not cancel another live consumer');

  live.abort('test-final-consumer');
  await assert.rejects(liveWait, (error) => error?.name === 'AbortError');
  await Promise.resolve();
  assert.equal(cancelled, 1, 'producer must cancel when the final valid waiter leaves');
  clearAnalysisCache();
});
