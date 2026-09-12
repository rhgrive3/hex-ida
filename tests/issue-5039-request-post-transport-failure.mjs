import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { createDevWorkerParentRpc, createDevWorkerParentRpcClient } from '../js/userscript/dev/parent-rpc.js';

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const BOUND_MS = 250;

await requestSendFailureRejectsImmediately();
await requestSendFailureLeavesNoTimer();
await waitEventSendFailureRejectsImmediately();
await requestSendFailureDetachesAbortListener();
await unsafeParamsLeaveNoPendingState();
await healthyRoundTripStillResolves();
await bestEffortCancelPostStaysSwallowed();

console.log('issue #5039 request send-failure regressions PASS');

function deadPort() {
  const listeners = new Set();
  return {
    posts: 0,
    listeners: () => listeners.size,
    addEventListener(type, handler) {
      if (type === 'message') listeners.add(handler);
    },
    removeEventListener(type, handler) {
      if (type === 'message') listeners.delete(handler);
    },
    start() {},
    postMessage() {
      this.posts += 1;
      throw new Error('closed port');
    },
  };
}

function trackingSignal() {
  const controller = new AbortController();
  const counts = { added: 0, removed: 0 };
  const signal = {
    get aborted() { return controller.signal.aborted; },
    get reason() { return controller.signal.reason; },
    addEventListener(type, handler, options) {
      if (type === 'abort') counts.added += 1;
      controller.signal.addEventListener(type, handler, options);
    },
    removeEventListener(type, handler, options) {
      if (type === 'abort') counts.removed += 1;
      controller.signal.removeEventListener(type, handler, options);
    },
  };
  return { controller, counts, signal };
}

function settleWithin(promise, ms = BOUND_MS) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (outcome) => {
      if (done) return;
      done = true;
      realClearTimeout(guard);
      resolve(outcome);
    };
    const guard = realSetTimeout(() => finish({ status: 'pending' }), ms);
    promise.then(
      (value) => finish({ status: 'resolved', value }),
      (error) => finish({ status: 'rejected', error }),
    );
  });
}

async function instrumentTimers(fn) {
  const created = new Set();
  const cleared = new Set();
  globalThis.setTimeout = (handler, ms, ...args) => {
    const timer = realSetTimeout(handler, ms, ...args);
    created.add(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    cleared.add(timer);
    return realClearTimeout(timer);
  };
  try {
    return await fn(created, cleared);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}

async function requestSendFailureRejectsImmediately() {
  const port = deadPort();
  const client = createDevWorkerParentRpcClient({ port, timeoutMs: 3000 });
  const outcome = await settleWithin(client.result({ workerId: 'w1' }));
  assert.equal(outcome.status, 'rejected', 'a request whose postMessage throws must reject, not stay pending');
  assert.equal(outcome.error?.code, 'transport-failure');
  assert.doesNotMatch(String(outcome.error?.message || ''), /timed out/i, 'send failure must not be reported as a timeout');
  client.close();
}

async function requestSendFailureLeavesNoTimer() {
  const port = deadPort();
  const client = createDevWorkerParentRpcClient({ port, timeoutMs: 3000 });
  await instrumentTimers(async (created, cleared) => {
    const outcome = await settleWithin(client.observe({ workerId: 'w1' }));
    assert.equal(outcome.status, 'rejected', 'a timed request must reject as soon as its send fails');
    assert.ok(created.size >= 1, 'the request must have armed a timeout timer');
    assert.ok(
      [...created].every((timer) => cleared.has(timer)),
      'the request timeout timer must be released when its send fails',
    );
  });
  client.close();
}

async function waitEventSendFailureRejectsImmediately() {
  const port = deadPort();
  const client = createDevWorkerParentRpcClient({ port, timeoutMs: 3000 });
  const outcome = await settleWithin(client.waitEvent({ events: ['worker.completed'] }));
  assert.equal(outcome.status, 'rejected', 'waitEvent has timeoutMs 0, so a failed send must still reject');
  assert.equal(outcome.error?.code, 'transport-failure');
  client.close();
}

async function requestSendFailureDetachesAbortListener() {
  const port = deadPort();
  const client = createDevWorkerParentRpcClient({ port, timeoutMs: 3000 });
  const { controller, counts, signal } = trackingSignal();
  const outcome = await settleWithin(client.send({ workerId: 'w1', text: 'hi' }, { signal }));
  assert.equal(outcome.status, 'rejected');
  assert.equal(counts.added, 1);
  assert.equal(counts.removed, 1, 'the abort listener must be detached when the request send fails');
  const posts = port.posts;
  controller.abort('late');
  assert.equal(port.posts, posts, 'a late abort must not emit a cancel for an already-failed request');
  client.close();
}

async function unsafeParamsLeaveNoPendingState() {
  const port = deadPort();
  const client = createDevWorkerParentRpcClient({ port, timeoutMs: 3000 });
  await instrumentTimers(async (created, cleared) => {
    const cycle = {};
    cycle.self = cycle;
    const outcome = await settleWithin(client.send({ payload: cycle }));
    assert.equal(outcome.status, 'rejected', 'unsanitizable params must reject the request');
    assert.equal(outcome.error?.code, 'transport-failure');
    assert.ok(
      [...created].every((timer) => cleared.has(timer)),
      'a request that never reached postMessage must not leave a timeout timer behind',
    );
  });
  client.close();
}

async function healthyRoundTripStillResolves() {
  const { port1, port2 } = new MessageChannel();
  const server = createDevWorkerParentRpc({
    port: port1,
    runtime: {
      async result() { return { done: true }; },
    },
  });
  const client = createDevWorkerParentRpcClient({ port: port2, timeoutMs: 3000 });
  assert.deepEqual(await client.result({ workerId: 'w1' }), { done: true });
  client.close();
  server.close();
  port1.close();
  port2.close();
}

async function bestEffortCancelPostStaysSwallowed() {
  const { port1, port2 } = new MessageChannel();
  let failAfterFirst = false;
  const wrapped = {
    addEventListener: (type, handler, options) => port2.addEventListener(type, handler, options),
    removeEventListener: (type, handler, options) => port2.removeEventListener(type, handler, options),
    start: () => port2.start(),
    postMessage: (value) => {
      if (failAfterFirst) throw new Error('closed port');
      failAfterFirst = true;
      port2.postMessage(value);
    },
  };
  const server = createDevWorkerParentRpc({ port: port1, runtime: { result: () => new Promise(() => {}) } });
  const client = createDevWorkerParentRpcClient({ port: wrapped, timeoutMs: 20 });
  const outcome = await settleWithin(client.result({ workerId: 'w1' }), 1000);
  assert.equal(outcome.status, 'rejected', 'a request that never answers must hit its timeout');
  assert.match(String(outcome.error?.message || ''), /timed out/i);
  client.close();
  server.close();
  port1.close();
  port2.close();
}
