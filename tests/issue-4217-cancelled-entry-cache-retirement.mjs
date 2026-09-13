import test from 'node:test';
import assert from 'node:assert/strict';

import { installDemandDrivenAnalysis, __demandDrivenInternalsForTests } from '../js/analysis/demand-driven-runtime.js';

// #4217: when the last waiter aborts, waitForShared() cancels the shared
// producer but the owner cache only drops the entry once the producer settles.
// The cancelled-entry reuse guard keeps a fresh caller off that producer, yet
// the abandoned producer's own late cleanup must not delete the replacement
// entry that the fresh caller installed under the same key.

const { discoveryProducersByApp } = __demandDrivenInternalsForTests;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const isAbort = (error) => error?.name === 'AbortError';

function deferredRequest(label) {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  const handle = {
    label,
    promise,
    cancelCount: 0,
    settle: (value) => resolve(value),
    fail: (error) => reject(error),
  };
  promise.cancel = () => {
    handle.cancelCount += 1;
    setTimeout(() => reject(Object.assign(new Error(`${label} cancelled`), { name: 'AbortError' })), 0);
  };
  return handle;
}

function discoveryHarness() {
  const regions = [{ id: 'text-a', vmAddr: '0x1000', size: 0x1000, exec: true }];
  const requests = [];
  const app = {
    store: { get: (key) => (key === 'regions' ? regions : null) },
    symbols: { gen: 0, functionCount: 0, functionStartsComplete: false, addFunctions: () => 0 },
    viewer: {},
    backend: { gen: 1 },
  };
  app.backend.guessFunctions = (regionId) => {
    const handle = deferredRequest(`producer-${requests.length + 1}:${regionId}`);
    requests.push(handle);
    return handle.promise;
  };
  installDemandDrivenAnalysis(app);
  return { app, requests, producers: discoveryProducersByApp.get(app), key: '1:text-a' };
}

test('#4217 a late-abandoned producer must not evict the entry that replaced it', async () => {
  const { app, requests, producers, key } = discoveryHarness();

  const abandonedSignal = new AbortController();
  const abandoned = app.ensureFunctions(null, { signal: abandonedSignal.signal });
  assert.equal(requests.length, 1, 'the first caller starts producer #1');
  abandonedSignal.abort();
  await assert.rejects(abandoned, isAbort, 'the aborting caller alone fails');
  assert.equal(requests[0].cancelCount, 1, 'the last-waiter abort cancels producer #1');

  const replacement = app.ensureFunctions(null, {});
  assert.equal(requests.length, 2, 'a fresh caller must not join the cancelled producer');
  const liveEntry = producers.get(key);
  assert.ok(liveEntry, 'the fresh caller installed its own entry');

  await tick();
  assert.equal(producers.get(key), liveEntry,
    'producer #1 late cleanup must be identity-guarded and cannot delete the replacement entry');

  requests[1].settle({ starts: [0x2000n], discoveryComplete: true });
  assert.deepEqual((await replacement).functionDiscovery.regions.map((item) => item.regionId), ['text-a']);
});

test('#4217 a caller arriving after the abandoned producer settled still coalesces', async () => {
  const { app, requests, producers, key } = discoveryHarness();

  const abandonedSignal = new AbortController();
  const abandoned = app.ensureFunctions(null, { signal: abandonedSignal.signal });
  abandonedSignal.abort();
  await assert.rejects(abandoned, isAbort);

  const first = app.ensureFunctions(null, {});
  assert.equal(requests.length, 2);
  await tick();
  assert.equal(producers.size, 1, 'the replacement entry survived the stale cleanup');

  const second = app.ensureFunctions(null, {});
  assert.equal(requests.length, 2, 'the live single-flight must still be reusable');
  requests[1].settle({ starts: [0x2000n], discoveryComplete: true });
  await Promise.all([first, second]);
});

test('#4217 one of two concurrent waiters aborting does not cancel the producer', async () => {
  const { app, requests } = discoveryHarness();

  const leavingSignal = new AbortController();
  const leaving = app.ensureFunctions(null, { signal: leavingSignal.signal });
  const staying = app.ensureFunctions(null, {});
  assert.equal(requests.length, 1, 'both callers share one producer');

  leavingSignal.abort();
  await assert.rejects(leaving, isAbort);
  assert.equal(requests[0].cancelCount, 0, 'an attached waiter must protect the shared producer');

  requests[0].settle({ starts: [0x2000n], discoveryComplete: true });
  const symbols = await staying;
  assert.equal(symbols.functionDiscovery.complete, true);
});

test('#4217 ordinary single-flight and success caching are unchanged', async () => {
  const { app, requests, producers, key } = discoveryHarness();

  const first = app.ensureFunctions(null, {});
  const second = app.ensureFunctions(null, {});
  assert.equal(requests.length, 1, 'concurrent callers coalesce');
  requests[0].settle({ starts: [0x2000n], discoveryComplete: true });
  await Promise.all([first, second]);
  assert.equal(producers.size, 1);
  assert.equal(producers.get(key).settled, true, 'a settled success keeps its cache entry');
});
