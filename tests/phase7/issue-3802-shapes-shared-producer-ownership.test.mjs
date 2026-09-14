import assert from 'node:assert/strict';
import test from 'node:test';

import { installDemandDrivenAnalysis } from '../../js/analysis/demand-driven-runtime.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const pending = { pending: true };
async function outcome(promise, ms = 25) {
  return Promise.race([
    promise.then(
      (value) => ({ status: 'fulfilled', value }),
      (reason) => ({ status: 'rejected', reason }),
    ),
    new Promise((resolve) => setTimeout(() => resolve(pending), ms)),
  ]);
}

function makeApp(gate, counters) {
  const app = {
    backend: {
      gen: 0,
      valueShapes() {
        counters.calls++;
        const request = gate.promise;
        request.cancel = () => { counters.cancels++; };
        return request;
      },
    },
    programRegions: () => [{ id: 'r1', exec: true, size: 10n }],
  };
  installDemandDrivenAnalysis(app);
  assert.equal(typeof app.ensureShapes, 'function');
  return app;
}

test('#3802 shapes producer survives the first consumer abort', async () => {
  const gate = deferred(); const counters = { calls: 0, cancels: 0 };
  const app = makeApp(gate, counters);
  const a = new AbortController(); const b = new AbortController();
  const pa = app.ensureShapes({ signal: a.signal });
  const pb = app.ensureShapes({ signal: b.signal });
  a.abort();
  const ra = await outcome(pa);
  assert.equal(ra.status, 'rejected');
  assert.equal(ra.reason.name, 'AbortError');
  assert.equal(await outcome(pb), pending, 'the surviving consumer must keep waiting');
  assert.equal(counters.cancels, 0, 'producer must not be cancelled while a waiter remains');
  gate.resolve({ count: 0 });
  const rb = await outcome(pb);
  assert.equal(rb.status, 'fulfilled');
});

test('#3802 the joining consumer keeps ownership of its own signal', async () => {
  const gate = deferred(); const counters = { calls: 0, cancels: 0 };
  const app = makeApp(gate, counters);
  const a = new AbortController(); const b = new AbortController();
  const pa = app.ensureShapes({ signal: a.signal });
  const pb = app.ensureShapes({ signal: b.signal });
  b.abort();
  const rb = await outcome(pb);
  assert.equal(rb.status, 'rejected', 'a late joiner must be able to cancel its own wait');
  assert.equal(rb.reason.name, 'AbortError');
  assert.equal(await outcome(pa), pending, 'the remaining consumer keeps waiting');
  assert.equal(counters.cancels, 0);
  gate.resolve({ count: 0 });
  assert.equal((await outcome(pa)).status, 'fulfilled');
});

test('#3802 the backend request is cancelled only after the last waiter leaves', async () => {
  const gate = deferred(); const counters = { calls: 0, cancels: 0 };
  const app = makeApp(gate, counters);
  const a = new AbortController(); const b = new AbortController(); const c = new AbortController();
  const pa = app.ensureShapes({ signal: a.signal });
  const pb = app.ensureShapes({ signal: b.signal });
  const pc = app.ensureShapes({ signal: c.signal });
  a.abort(); b.abort();
  assert.equal((await outcome(pa)).status, 'rejected');
  assert.equal((await outcome(pb)).status, 'rejected');
  assert.equal(counters.cancels, 0, 'one waiter is still attached');
  c.abort();
  for (const p of [pa, pb, pc]) {
    const r = await outcome(p);
    assert.equal(r.status, 'rejected');
    assert.equal(r.reason.name, 'AbortError');
  }
  assert.equal(counters.cancels, 1, 'the last waiter releases the producer once');
});

test('#3802 coalescing keeps one shared scan per epoch', async () => {
  const gate = deferred(); const counters = { calls: 0, cancels: 0 };
  const app = makeApp(gate, counters);
  const a = new AbortController(); const b = new AbortController();
  const pa = app.ensureShapes({ signal: a.signal });
  const pb = app.ensureShapes({ signal: b.signal });
  const shapes = { count: 0 };
  gate.resolve(shapes);
  const [va, vb] = await Promise.all([pa, pb]);
  assert.equal(counters.calls, 1, 'same-epoch consumers share one producer');
  assert.equal(va, vb, 'both consumers receive the one coalesced result');
  assert.equal(app.shapes, va, 'the completed scan is published for the epoch');
});
