import assert from 'node:assert/strict';
import test from 'node:test';

import { installDemandDrivenAnalysis } from '../../js/analysis/demand-driven-runtime.js';

// Issue 5860: the shared demand function-discovery producer kept only the
// first consumer's progress callback. Later waiters never heard progress, and
// an aborted first consumer left the producer notifying a dead observer.

function makeApp() {
  const region = { id: 'text', vmAddr: 0x1000n, size: 0x1000n, exec: true };
  const progressCallbacks = [];
  let releaseScan = null;
  const app = {
    backend: {
      gen: 0,
      binaryId: 'bin-5860',
      guessFunctions(_regionId, _share, onProgress) {
        progressCallbacks.push(onProgress);
        const request = new Promise((resolve) => { releaseScan = () => resolve({ starts: [0x1004n], discoveryComplete: true }); });
        request.cancel = () => {};
        return request;
      },
    },
    analysisEpoch: 0,
    projectRevision: 0,
    symbols: {
      gen: 0,
      functionCount: 0,
      functionStartsComplete: false,
      funcs: [],
      functionAt() { return null; },
      addFunctions() {},
    },
    programRegions() { return [region]; },
    executableRegionFor(addr) { return addr >= 0x1000n && addr < 0x2000n ? region : null; },
  };
  installDemandDrivenAnalysis(app);
  return { app, progressCallbacks, release: () => releaseScan?.(), region };
}

test('5860: every attached consumer observes shared producer progress', async () => {
  const { app, progressCallbacks, release, region } = makeApp();
  const seenA = [];
  const seenB = [];

  const promiseA = app.ensureFunctions(region, { onProgress: (p) => seenA.push(p) });
  await Promise.resolve();
  const promiseB = app.ensureFunctions(region, { onProgress: (p) => seenB.push(p) });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(progressCallbacks.length, 1, 'the producer is shared, not duplicated');
  progressCallbacks[0]({ done: 1, all: 2 });

  assert.equal(seenA.length, 1);
  assert.equal(seenB.length, 1, 'a later waiter must receive the same progress events');
  assert.deepEqual(seenB[0], seenA[0]);

  release();
  await Promise.all([promiseA, promiseB]);
});

test('5860: an aborted first consumer does not strand the producer notifications', async () => {
  const { app, progressCallbacks, release, region } = makeApp();
  const controllerA = new AbortController();
  const seenA = [];
  const seenB = [];

  const promiseA = app.ensureFunctions(region, { signal: controllerA.signal, onProgress: (p) => seenA.push(p) });
  await Promise.resolve();
  const promiseB = app.ensureFunctions(region, { onProgress: (p) => seenB.push(p) });
  await Promise.resolve();
  await Promise.resolve();

  controllerA.abort();
  await promiseA.catch(() => {});
  await Promise.resolve();

  // B survives the shared producer; its observer must still be live, while A
  // is detached immediately on consumer abort.
  assert.equal(progressCallbacks.length, 1);
  progressCallbacks[0]({ done: 1, all: 2 });
  assert.equal(seenA.length, 0, 'an aborted consumer must not receive later progress');
  assert.equal(seenB.length, 1, 'the surviving consumer keeps receiving progress');

  release();
  await promiseB;
  const beforeLateProgress = [seenA.length, seenB.length];
  // A backend may deliver a late callback after its request resolves; settled
  // consumers must not remain retained by the shared producer.
  progressCallbacks[0]({ done: 2, all: 2 });
  assert.deepEqual([seenA.length, seenB.length], beforeLateProgress,
    'settled consumers must be detached from the observer set');
});
