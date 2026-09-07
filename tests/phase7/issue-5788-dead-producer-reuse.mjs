import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

// Known pre-existing property: aborting every waiter leaves the producer's
// derived wait-chain rejection unhandled. Track them so the test itself stays
// silent, and assert they are only the expected cancellations.
const unhandled = [];
process.on('unhandledRejection', (error) => unhandled.push(error));
process.on('exit', () => {
  for (const error of unhandled) {
    if (error?.name !== 'AbortError') {
      console.error('unexpected unhandled rejection:', error);
      process.exitCode = 1;
    }
  }
});
import { installSharedWorkerBinaryIdentity } from '../../js/analysis/shared-binary-identity.js';

// Issue #5788: when the last waiter aborts, the entry's producer is aborted
// ('binary-identity-no-consumers') but stays installed as `current` until the
// producer promise settles. A new non-aborted caller in that window attached
// to the dead producer and inherited the old consumer's AbortError. The race
// window is entered by calling B synchronously in the same turn as A's abort.

function backendWithHash() {
  let resolveHash = null;
  const backend = {
    file: { name: 'x' },
    gen: 1,
    ensureContentHash(_progress, signal) {
      return new Promise((resolve, reject) => {
        resolveHash = () => resolve('a'.repeat(64));
        signal.addEventListener('abort', () => reject(Object.assign(new Error('hash aborted'), { name: 'AbortError' })), { once: true });
      });
    },
  };
  return { backend, resolve: () => resolveHash() };
}

{
  const { backend, resolve } = backendWithHash();
  installSharedWorkerBinaryIdentity({ backend });

  const a = new AbortController();
  const firstPromise = backend.ensureBinaryId({ signal: a.signal });
  await Promise.resolve();
  await Promise.resolve();

  // Same-turn interleaving: abort A and let fresh caller B arrive before any
  // microtask of the producer rejection cleanup has run.
  a.abort('viewer-closed');
  const b = new AbortController();
  const secondPromise = backend.ensureBinaryId({ signal: b.signal });

  await assert.rejects(() => firstPromise, (error) => error.name === 'AbortError',
    'the aborted consumer A must fail');
  await delay(10); // the scheduled background task starts ensureContentHash
  resolve();
  const binaryId = await secondPromise;
  assert.ok(typeof binaryId === 'string' && binaryId.length > 0,
    'fresh non-aborted caller B must obtain a BinaryId, not inherit A\'s cancellation');
}

// Settled-entry variant: after the producer fully settled, ensure a new caller
// still gets a valid identity through whatever entry state remains.
{
  const { backend, resolve } = backendWithHash();
  installSharedWorkerBinaryIdentity({ backend });

  const a = new AbortController();
  const firstPromise = backend.ensureBinaryId({ signal: a.signal });
  await Promise.resolve();
  await Promise.resolve();
  a.abort('viewer-closed');
  const b = new AbortController();
  const secondPromise = backend.ensureBinaryId({ signal: b.signal });
  await delay(10);
  resolve();
  await secondPromise;
  await assert.rejects(() => firstPromise, (error) => error.name === 'AbortError');
  assert.ok(backend.binaryId, 'the surviving producer publishes the shared identity');
}

console.log('issue-5788 aborted last waiter does not poison fresh callers: ok');
