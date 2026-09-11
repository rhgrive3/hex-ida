import assert from 'node:assert/strict';
import { installSharedAppArtifacts } from '../../js/analysis/shared-app-artifacts.js';

// Issue #5816: a consumer can abort while a shared producer is starting,
// before attach() registers the first waiter. The zero-waiter producer must be
// detached/cancelled, and its later finalizer must not clear a same-epoch
// retry's busy ownership.

function abortErrorMatcher(error) {
  return error?.name === 'AbortError';
}

function pendingRequest(onCancel) {
  const request = new Promise(() => {});
  request.cancel = onCancel;
  return request;
}

{
  const firstConsumer = new AbortController();
  const retryConsumer = new AbortController();
  let calls = 0;
  let cancelled = 0;
  const app = {
    backend: {
      gen: 0,
      strings: () => {
        calls++;
        if (calls === 1) firstConsumer.abort('cancel-during-producer-start');
        return pendingRequest(() => { cancelled++; });
      },
    },
    store: {
      get: (key) => (key === 'regions'
        ? [{ id: 'r1', section: '__cstring', size: 64n, vmAddr: 0x1000n }]
        : null),
    },
  };
  installSharedAppArtifacts(app);

  assert.throws(
    () => app.ensureStrings({ signal: firstConsumer.signal }),
    abortErrorMatcher,
    'the producer-start-aborted consumer must fail immediately',
  );

  const retry = app.ensureStrings({ signal: retryConsumer.signal });
  const retryBusy = app.stringsBusy;
  assert.ok(retryBusy, 'same-epoch retry must install a fresh strings busy owner');

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    app.stringsBusy,
    retryBusy,
    'the old string producer finalizer must not clear the retry busy owner',
  );
  assert.equal(cancelled, 1, 'the orphaned first string request must be cancelled');
  assert.equal(app.stringIndex, undefined, 'the aborted first producer must not publish strings');

  retryConsumer.abort('test-cleanup');
  await assert.rejects(retry, abortErrorMatcher);
  await Promise.resolve();
  assert.equal(cancelled, 2, 'cleanup must cancel the retry request as its last waiter leaves');
  assert.equal(app.stringIndex, undefined, 'cancelled retry must not publish strings');
}

{
  const firstConsumer = new AbortController();
  const retryConsumer = new AbortController();
  let ensureFunctionCalls = 0;
  let producerAborts = 0;
  let scanCalls = 0;
  const app = {
    backend: {
      gen: 0,
      scanProgram: () => {
        scanCalls++;
        throw new Error('scanProgram must not run while ensureFunctions is pending/aborted');
      },
    },
    symbols: { gen: 0, functionStartsComplete: true },
    ensureFunctions: (_region, { signal }) => {
      ensureFunctionCalls++;
      if (ensureFunctionCalls === 1) firstConsumer.abort('cancel-program-during-producer-start');
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          producerAborts++;
          const error = new Error('program producer aborted');
          error.name = 'AbortError';
          error.code = 'ABORT_ERR';
          reject(error);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    },
    store: {
      get: (key) => (key === 'regions'
        ? [{ id: 'text', section: '__text', exec: true, size: 64n, vmAddr: 0x1000n }]
        : null),
    },
  };
  installSharedAppArtifacts(app);

  assert.throws(
    () => app.ensureProgram({ signal: firstConsumer.signal }),
    abortErrorMatcher,
    'the program producer-start-aborted consumer must fail immediately',
  );
  assert.equal(producerAborts, 1, 'the zero-waiter program producer must be aborted');

  const retry = app.ensureProgram({ signal: retryConsumer.signal });
  const retryBusy = app.programBusy;
  assert.ok(retryBusy, 'same-epoch retry must install a fresh program busy owner');

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    app.programBusy,
    retryBusy,
    'the old program producer finalizer must not clear the retry busy owner',
  );
  assert.equal(scanCalls, 0, 'aborted/pending program producers must not reach scanProgram');
  assert.equal(app.program, undefined, 'the aborted first program producer must not publish a program');

  retryConsumer.abort('test-cleanup');
  await assert.rejects(retry, abortErrorMatcher);
  await Promise.resolve();
  assert.equal(producerAborts, 2, 'cleanup must abort the retry program producer');
  assert.equal(scanCalls, 0, 'cancelled retry must not scan or publish');
  assert.equal(app.program, undefined, 'cancelled retry must not publish a program');
}

console.log('issue-5816 zero-waiter producer retry ownership: ok');
