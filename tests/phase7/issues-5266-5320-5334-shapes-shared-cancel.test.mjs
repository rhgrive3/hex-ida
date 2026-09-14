import assert from 'node:assert/strict';
import test from 'node:test';

import { installDemandDrivenAnalysis } from '../../js/analysis/demand-driven-runtime.js';

/**
 * Issues #5266 / #5320 / #5334 (same root cause):
 * `installMultiRegionShapes()` captured the FIRST caller's AbortSignal (and
 * onProgress) into the shared single-flight producer. When that consumer
 * aborted, the backend `valueShapes` request itself was cancelled and every
 * other live consumer sharing `app.shapesBusy` failed too. Late joiners could
 * not even cancel their own wait: the busy fast-path returned the shared
 * promise without subscribing their signal.
 *
 * The producer lifetime is now decoupled from any single consumer via the
 * same entry + waitForShared contract the sibling producers in this file use:
 * a consumer abort rejects only that consumer, and the backend request is
 * cancelled only once the last waiter leaves.
 */

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeApp(gate, counters) {
  return {
    backend: {
      gen: 0,
      valueShapes(_regionId, _onProgress) {
        counters.calls++;
        const request = gate.promise;
        request.cancel = () => { counters.cancels++; };
        return request;
      },
    },
    programRegions: () => [{ id: 'r1', exec: true, size: 10n }],
  };
}

function install(gate, counters) {
  const app = makeApp(gate, counters);
  installDemandDrivenAnalysis(app);
  assert.equal(typeof app.ensureShapes, 'function');
  return app;
}

const pending = { pending: true };
async function outcome(promise, ms = 200) {
  return Promise.race([
    promise.then(
      (value) => ({ status: 'fulfilled', value }),
      (reason) => ({ status: 'rejected', reason }),
    ),
    new Promise((resolve) => setTimeout(() => resolve(pending), ms)),
  ]);
}

test('#5266/#5320/#5334 first-consumer abort does not fail live consumers', async () => {
  const gate = deferred(); const counters = { calls: 0, cancels: 0 };
  const app = install(gate, counters);
  const first = new AbortController(); const second = new AbortController();
  const p1 = app.ensureShapes({ signal: first.signal });
  const p2 = app.ensureShapes({ signal: second.signal });
  first.abort();
  const r1 = await outcome(p1);
  assert.equal(r1.status, 'rejected');
  assert.equal(r1.reason?.name, 'AbortError');
  assert.equal(await outcome(p2), pending, 'the surviving consumer must stay pending, not fail');
  assert.equal(counters.cancels, 0, 'backend must not be cancelled while a waiter remains');
  gate.resolve({ count: 0 });
  const late = await outcome(p2);
  assert.equal(late.status, 'fulfilled', 'the surviving consumer fulfills once the producer completes');
});

test('#5266/#5320/#5334 late-joiner abort rejects only itself', async () => {
  const gate = deferred(); const counters = { calls: 0, cancels: 0 };
  const app = install(gate, counters);
  const first = new AbortController(); const second = new AbortController();
  const p1 = app.ensureShapes({ signal: first.signal });
  const p2 = app.ensureShapes({ signal: second.signal });
  second.abort();
  const r2 = await outcome(p2);
  assert.equal(r2.status, 'rejected');
  assert.equal(r2.reason?.name, 'AbortError');
  assert.equal(await outcome(p1), pending, 'the first consumer must be unaffected by the late joiner abort');
  gate.resolve({ count: 0 });
  assert.equal((await outcome(p1)).status, 'fulfilled');
});

test('#5266/#5320/#5334 producer is cancelled once the last waiter leaves', async () => {
  const gate = deferred(); const counters = { calls: 0, cancels: 0 };
  const app = install(gate, counters);
  const first = new AbortController(); const second = new AbortController();
  const p1 = app.ensureShapes({ signal: first.signal });
  const p2 = app.ensureShapes({ signal: second.signal });
  first.abort();
  second.abort();
  const [r1, r2] = await Promise.allSettled([p1, p2]);
  assert.equal(r1.status, 'rejected');
  assert.equal(r2.status, 'rejected');
  assert.ok(counters.cancels >= 1, 'backend request must be cancelled when no waiter remains');
});

test('#5266/#5320/#5334 coalesced callers still share one backend scan', async () => {
  const gate = deferred(); const counters = { calls: 0, cancels: 0 };
  const app = install(gate, counters);
  const p1 = app.ensureShapes({});
  const p2 = app.ensureShapes({});
  gate.resolve({ count: 0 });
  await Promise.all([p1, p2]);
  assert.equal(counters.calls, 1, 'single-flight must not duplicate the backend scan');
});

test('#5266/#5320/#5334 pre-aborted consumer still fails fast', async () => {
  const gate = deferred(); const counters = { calls: 0, cancels: 0 };
  const app = install(gate, counters);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(app.ensureShapes({ signal: controller.signal }), (error) => error?.name === 'AbortError');
  assert.equal(counters.calls, 0, 'a pre-aborted caller must not start producer work');
});
