import assert from 'node:assert/strict';
import test from 'node:test';

import { waitForAppProducer } from '../../js/analysis/producer-wait.js';

function pendingEntry() {
  return {
    settled: false,
    waiters: 0,
    controller: new AbortController(),
    promise: new Promise(() => {}),
  };
}

async function rejectionOf(promise) {
  try {
    await promise;
  } catch (reason) {
    return reason;
  }
  assert.fail('expected producer wait to reject');
}

for (const [label, reason] of [
  ['string', 'view-closed'],
  ['zero', 0],
  ['false', false],
  ['empty-string', ''],
  ['null', null],
  ['object', Object.freeze({ kind:'superseded', generation:7 })],
  ['error', new Error('caller-cancelled')],
]) {
  test(`#4290 pre-aborted ${label} reason keeps exact identity`, async () => {
    const consumer = new AbortController();
    consumer.abort(reason);
    const producer = pendingEntry();

    const rejected = await rejectionOf(waitForAppProducer(producer, consumer.signal));

    assert.ok(Object.is(rejected, reason), `${label} AbortSignal.reason must be rejected unchanged`);
    assert.equal(producer.waiters, 0, 'pre-aborted consumer never becomes a waiter');
    assert.equal(producer.controller.signal.aborted, true, 'sole pre-aborted consumer cancels producer');
    assert.equal(producer.controller.signal.reason, 'analysis-producer-no-consumers');
  });
}

test('#4290 abort event preserves structured reason and exact-once detach', async () => {
  const reason = Object.freeze({ kind:'deadline', deadlineMs:25 });
  const consumer = new AbortController();
  const producer = pendingEntry();
  const waiting = waitForAppProducer(producer, consumer.signal);
  assert.equal(producer.waiters, 1);

  consumer.abort(reason);
  const rejected = await rejectionOf(waiting);

  assert.equal(rejected, reason);
  assert.equal(producer.waiters, 0, 'aborted waiter detaches exactly once');
  assert.equal(producer.controller.signal.aborted, true, 'last departing consumer still cancels producer');
});

test('#4290 structured reason is never stringified', async () => {
  let stringifications = 0;
  const reason = {
    kind:'budget',
    limit:1000,
    toString() {
      stringifications += 1;
      throw new Error('must-not-stringify-abort-reason');
    },
  };
  const consumer = new AbortController();
  consumer.abort(reason);
  const producer = pendingEntry();

  const rejected = await rejectionOf(waitForAppProducer(producer, consumer.signal));

  assert.equal(rejected, reason);
  assert.equal(stringifications, 0);
  assert.equal(producer.waiters, 0);
});

test('#4290 unavailable reason falls back to standard AbortError', async () => {
  const signal = {
    aborted: true,
    get reason() { return undefined; },
    addEventListener() {},
    removeEventListener() {},
  };
  const producer = pendingEntry();

  const rejected = await rejectionOf(waitForAppProducer(producer, signal));

  assert.equal(rejected?.name, 'AbortError');
  assert.equal(rejected?.code, 'ABORT_ERR');
  assert.equal(rejected?.message, 'Analysis producer aborted');
  assert.equal(producer.waiters, 0);
});

test('#4290 throwing reason getter falls back without bypassing cleanup', async () => {
  const signal = {
    aborted: true,
    get reason() { throw new Error('poisoned-reason-getter'); },
    addEventListener() {},
    removeEventListener() {},
  };
  const producer = pendingEntry();

  const rejected = await rejectionOf(waitForAppProducer(producer, signal));

  assert.equal(rejected?.name, 'AbortError');
  assert.equal(rejected?.code, 'ABORT_ERR');
  assert.equal(producer.waiters, 0);
  assert.equal(producer.controller.signal.aborted, true);
});

function signalThatAbortsDuringSubscription(controller) {
  const source = controller.signal;
  return {
    get aborted() { return source.aborted; },
    get reason() { return source.reason; },
    addEventListener(type, listener, options) {
      if (type === 'abort' && !source.aborted) controller.abort('raced-before-listener');
      source.addEventListener(type, listener, options);
    },
    removeEventListener(type, listener, options) {
      source.removeEventListener(type, listener, options);
    },
  };
}

test('#4290 preserves #3195 subscribe-race cleanup while keeping exact reason', async () => {
  const consumer = new AbortController();
  const producer = pendingEntry();
  const signal = signalThatAbortsDuringSubscription(consumer);

  const rejected = await rejectionOf(waitForAppProducer(producer, signal));

  assert.equal(rejected, 'raced-before-listener');
  assert.equal(producer.waiters, 0, 'raced consumer must detach exactly once');
  assert.equal(producer.controller.signal.aborted, true, 'raced final consumer must still cancel producer');
  assert.equal(producer.controller.signal.reason, 'analysis-producer-no-consumers');
});
