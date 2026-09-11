import assert from 'node:assert/strict';
import test from 'node:test';

import { installDemandDrivenAnalysis } from '../../js/analysis/demand-driven-runtime.js';

function makeApp(search) {
  return {
    backend: {
      gen: 1,
      binaryId: 'binary-test-4757',
      search,
    },
  };
}

function deferredRequest(onCancel = () => {}) {
  let resolve;
  let reject;
  const request = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  request.cancel = onCancel;
  return { request, resolve, reject };
}

function timeoutReject(label, ms = 100) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(label)), ms);
  });
}

async function snapshotFor(app) {
  installDemandDrivenAnalysis(app);
  return app.analysisQueries.snapshot();
}

test('pre-aborted search does not start backend work (#4757)', async () => {
  let calls = 0;
  const app = makeApp(() => {
    calls += 1;
    return Promise.resolve({ results: [], capped: false, cancelled: false });
  });
  const snapshot = await snapshotFor(app);
  const controller = new AbortController();
  controller.abort('already-closed');

  await assert.rejects(
    app.analysisQueries.search(snapshot, { kind: 'text', query: 'x' }, {}, { signal: controller.signal }),
    (error) => error === 'already-closed' || error?.name === 'AbortError',
  );
  assert.equal(calls, 0);
});

test('abort during backend search creation is observed after listener registration (#4757)', async () => {
  const controller = new AbortController();
  let cancelCalls = 0;
  const deferred = deferredRequest(() => { cancelCalls += 1; });
  const app = makeApp(() => {
    controller.abort('closed-during-request-creation');
    return deferred.request;
  });
  const snapshot = await snapshotFor(app);

  const pending = app.analysisQueries.search(
    snapshot,
    { kind: 'text', query: 'x' },
    {},
    { signal: controller.signal },
  );

  try {
    await assert.rejects(
      Promise.race([pending, timeoutReject('registration-race-timeout')]),
      (error) => error?.name === 'AbortError',
    );
    assert.equal(cancelCalls, 1, 'the backend request must be cancelled exactly once');
  } finally {
    deferred.resolve({ results: [], capped: false, cancelled: false });
    await pending.catch(() => {});
  }
});

test('abort after registration still cancels and rejects exactly once (#4757)', async () => {
  const controller = new AbortController();
  let cancelCalls = 0;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const deferred = deferredRequest(() => { cancelCalls += 1; });
  const app = makeApp(() => {
    markStarted();
    return deferred.request;
  });
  const snapshot = await snapshotFor(app);
  const pending = app.analysisQueries.search(
    snapshot,
    { kind: 'text', query: 'x' },
    {},
    { signal: controller.signal },
  );

  await started;
  controller.abort('closed-after-registration');
  await assert.rejects(
    Promise.race([pending, timeoutReject('registered-abort-timeout')]),
    (error) => error?.name === 'AbortError',
  );
  assert.equal(cancelCalls, 1);
  deferred.resolve({ results: [], capped: false, cancelled: false });
  await pending.catch(() => {});
});

test('abort wins a same-turn resolve race without double settlement (#4757)', async () => {
  const controller = new AbortController();
  let cancelCalls = 0;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const deferred = deferredRequest(() => { cancelCalls += 1; });
  const app = makeApp(() => {
    markStarted();
    return deferred.request;
  });
  const snapshot = await snapshotFor(app);
  const pending = app.analysisQueries.search(
    snapshot,
    { kind: 'text', query: 'x' },
    {},
    { signal: controller.signal },
  );

  await started;
  controller.abort('same-turn-abort');
  deferred.resolve({ results: [{ addr: 7n }], capped: false, cancelled: false });
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  assert.equal(cancelCalls, 1);
});

test('late backend rejection after consumer abort is observed, not unhandled (#4757)', async () => {
  const controller = new AbortController();
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const deferred = deferredRequest();
  const app = makeApp(() => {
    markStarted();
    return deferred.request;
  });
  const snapshot = await snapshotFor(app);
  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);

  try {
    const pending = app.analysisQueries.search(
      snapshot,
      { kind: 'text', query: 'x' },
      {},
      { signal: controller.signal },
    );
    await started;
    controller.abort('consumer-left');
    await assert.rejects(pending, (error) => error?.name === 'AbortError');
    deferred.reject(new Error('backend-stopped-after-cancel'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('signal-less completion and capped completeness remain unchanged (#4757)', async () => {
  let capped = false;
  const app = makeApp(() => Promise.resolve({
    results: [{ addr: 1n }],
    capped,
    cancelled: false,
  }));
  const snapshot = await snapshotFor(app);

  const complete = await app.analysisQueries.search(snapshot, { kind: 'text', query: 'x' });
  assert.equal(complete.status.completeness, 'complete');
  assert.deepEqual(complete.value, [{ addr: 1n }]);

  capped = true;
  const partial = await app.analysisQueries.search(snapshot, { kind: 'text', query: 'x' });
  assert.equal(partial.status.completeness, 'partial');
  assert.equal(partial.status.reason, 'search-result-cap');
});
