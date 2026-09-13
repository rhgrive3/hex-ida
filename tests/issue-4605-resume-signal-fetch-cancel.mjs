// Regression for #4605: LocalFunctionSandboxAdapter.resume must propagate its
// AbortSignal (and adapter.cancel) through FunctionSandbox.run into
// Emulator.run/step so a pending io.fetch is cancelled via awaitAbortable and
// resume settles instead of hanging forever.
import assert from 'node:assert/strict';
import test from 'node:test';

import { LocalFunctionSandboxAdapter } from '../js/adapters/index.js';

function deferredCancelable() {
  let resolve;
  let reject;
  let cancelCount = 0;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.cancel = () => { cancelCount++; };
  return { promise, resolve, reject, get cancelCount() { return cancelCount; } };
}

function gate() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

async function within(promise, ms = 500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('test-timeout')), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function launchedAdapter(program) {
  const adapter = new LocalFunctionSandboxAdapter({ fetch: program }, {});
  await adapter.launch({ address: 0x1000n });
  return adapter;
}

test('#4605 external signal abort settles resume while io.fetch is pending and cancels the fetch once', async () => {
  const fetchStarted = gate();
  const op = deferredCancelable();
  const adapter = await launchedAdapter(() => { fetchStarted.resolve(); return op.promise; });
  const controller = new AbortController();
  const running = adapter.resume({ signal: controller.signal, maxSteps: 5000 });
  await within(fetchStarted.promise);
  controller.abort();
  const result = await within(running);
  assert.equal(result.stop.kind, 'cancelled');
  assert.equal(op.cancelCount, 1, 'the pending fetch cancellation must fire exactly once');
  assert.equal(adapter.activeRun, null);
  assert.equal(adapter.running, false);
});

test('#4605 adapter.cancel releases the same pending fetch and resets run state', async () => {
  const fetchStarted = gate();
  const op = deferredCancelable();
  const adapter = await launchedAdapter(() => { fetchStarted.resolve(); return op.promise; });
  const running = adapter.resume({ maxSteps: 5000 });
  await within(fetchStarted.promise);
  await within(adapter.cancel());
  const result = await within(running);
  assert.equal(result.stop.kind, 'cancelled');
  assert.equal(op.cancelCount, 1, 'cancel() must abort the pending fetch exactly once');
  assert.equal(adapter.activeRun, null);
  assert.equal(adapter.running, false);
  assert.equal(adapter.cancelled, true);
});

test('#4605 normal resume still completes and preserves state after cleanup', async () => {
  const adapter = await launchedAdapter(async () => ({ mn: 'ret', ops: '' }));
  const result = await within(adapter.resume({ maxSteps: 500 }));
  assert.equal(result.stop.kind, 'return');
  assert.equal(result.steps >= 1, true);
  assert.equal(adapter.activeRun, null);
  assert.equal(adapter.running, false);
  assert.equal(adapter.cancelled, false);
});

test('#4605 pause is not cancellation: a pending fetch is untouched and the run stays resumable', async () => {
  const fetchStarted = gate();
  const op = deferredCancelable();
  const adapter = await launchedAdapter(() => { fetchStarted.resolve(); return op.promise; });
  const running = adapter.resume({ maxSteps: 5000 });
  await within(fetchStarted.promise);
  const paused = await within(adapter.pause());
  assert.equal(paused.paused, true);
  assert.equal(adapter.sandbox.emulator.stopped, 'paused');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(op.cancelCount, 0, 'pause must not cancel an in-flight fetch');
  assert.notEqual(adapter.activeRun, null, 'pause keeps the run resumable rather than tearing it down');
  await within(adapter.cancel());
  const result = await within(running);
  assert.equal(result.stop.kind, 'cancelled');
  assert.equal(adapter.activeRun, null);
});

test('#4605 the caller-supplied external signal listener is cleaned up exactly once', async () => {
  const fetchStarted = gate();
  const op = deferredCancelable();
  const adapter = await launchedAdapter(() => { fetchStarted.resolve(); return op.promise; });
  const controller = new AbortController();
  let adds = 0;
  let removes = 0;
  let registered = null;
  const real = controller.signal;
  const signal = {
    get aborted() { return real.aborted; },
    get reason() { return real.reason; },
    addEventListener(type, listener, options) {
      assert.equal(type, 'abort');
      assert.deepEqual(options, { once: true });
      adds++;
      registered = listener;
      real.addEventListener('abort', () => { if (!signal.abortedFlag) { signal.abortedFlag = true; listener(); } });
    },
    removeEventListener(type, listener) {
      assert.equal(type, 'abort');
      assert.equal(listener, registered);
      removes++;
    },
  };
  const running = adapter.resume({ signal, maxSteps: 5000 });
  await within(fetchStarted.promise);
  controller.abort();
  const result = await within(running);
  assert.equal(result.stop.kind, 'cancelled');
  assert.equal(op.cancelCount, 1);
  assert.equal(adds, 1, 'the external abort listener must be registered exactly once');
  assert.equal(removes, 1, 'the external abort listener must be removed exactly once');
  assert.equal(adapter.activeRun, null);
});
