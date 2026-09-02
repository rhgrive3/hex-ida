import test from 'node:test';
import assert from 'node:assert/strict';

import { appProducerAbortError, waitForAppProducer } from '../js/analysis/producer-wait.js';

function entry(pending = true, { rejectOnAbort = false } = {}) {
  const controller = new AbortController();
  let promise;
  if (!pending) {
    promise = Promise.resolve('done');
  } else if (rejectOnAbort) {
    promise = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('producer aborted')), { once:true });
    });
  } else {
    promise = new Promise(() => {});
  }
  return {
    controller,
    settled: !pending,
    waiters: 0,
    promise,
  };
}

function signalThatAbortsDuringSubscription(controller) {
  const signal = controller.signal;
  return {
    get aborted() { return signal.aborted; },
    get reason() { return signal.reason; },
    addEventListener(type, listener, options) {
      if (type === 'abort' && !signal.aborted) controller.abort('raced-before-listener');
      signal.addEventListener(type, listener, options);
    },
    removeEventListener(type, listener, options) {
      signal.removeEventListener(type, listener, options);
    },
  };
}

test('#3195 abort between pre-check and subscription detaches the consumer immediately', async () => {
  const producer = entry(true, { rejectOnAbort: true });
  const controller = new AbortController();
  const signal = signalThatAbortsDuringSubscription(controller);

  // The pre-check sees aborted=false. addEventListener then aborts before the
  // listener is installed, so only the post-subscription re-check can collect
  // the race.
  const waiting = waitForAppProducer(producer, signal);
  await assert.rejects(waiting, (error) => error.name === 'AbortError');
  assert.equal(producer.waiters, 0, 'waiter count must drop');
  assert.equal(producer.controller.signal.aborted, true, 'last consumer aborts the producer');
  assert.equal(producer.controller.signal.reason, 'analysis-producer-no-consumers');
});

test('#3195 raced consumer does not double-detach when the listener also fires', async () => {
  const producer = entry();
  const controller = new AbortController();
  const waiting = waitForAppProducer(producer, controller.signal);
  controller.abort('raced');
  await assert.rejects(waiting, (error) => error.name === 'AbortError');
  assert.equal(producer.waiters, 0);
});

test('#3195 normal cancel after subscription still aborts the producer once', async () => {
  const producer = entry();
  const controller = new AbortController();
  const waiting = waitForAppProducer(producer, controller.signal);
  assert.equal(producer.waiters, 1);
  controller.abort('cancelled');
  await assert.rejects(waiting, (error) => error.name === 'AbortError');
  assert.equal(producer.waiters, 0);
  assert.equal(producer.controller.signal.reason, 'analysis-producer-no-consumers');
});

test('#3195 surviving consumers keep the producer alive when one detaches', async () => {
  const producer = entry();
  const first = new AbortController();
  const second = new AbortController();
  const keep = waitForAppProducer(producer, second.signal);
  const leave = waitForAppProducer(producer, first.signal);
  assert.equal(producer.waiters, 2);
  first.abort('first left');
  await assert.rejects(leave, (error) => error.name === 'AbortError');
  assert.equal(producer.waiters, 1);
  assert.equal(producer.controller.signal.aborted, false, 'producer keeps running for the survivor');
  second.abort('second left');
  await assert.rejects(keep, (error) => error.name === 'AbortError');
  assert.equal(producer.controller.signal.reason, 'analysis-producer-no-consumers');
});

test('#3195 settled producer resolves waiters without aborting anything', async () => {
  const producer = entry(false);
  const controller = new AbortController();
  const waiting = waitForAppProducer(producer, controller.signal);
  assert.equal(await waiting, 'done');
  assert.equal(producer.waiters, 0);
  assert.equal(producer.controller.signal.aborted, false);
});

test('#3195 pre-aborted initial consumer cancels an unobserved producer', async () => {
  const producer = entry(true, { rejectOnAbort: true });
  const controller = new AbortController();
  controller.abort('already gone');
  await assert.rejects(waitForAppProducer(producer, controller.signal), (error) => error.name === 'AbortError');
  assert.equal(producer.waiters, 0);
  assert.equal(producer.controller.signal.aborted, true);
  assert.equal(producer.controller.signal.reason, 'analysis-producer-no-consumers');
});

test('#3195 pre-aborted extra consumer does not cancel a producer with surviving waiters', async () => {
  const producer = entry();
  const survivor = new AbortController();
  const keep = waitForAppProducer(producer, survivor.signal);
  const alreadyGone = new AbortController();
  alreadyGone.abort('already gone');
  await assert.rejects(waitForAppProducer(producer, alreadyGone.signal), (error) => error.name === 'AbortError');
  assert.equal(producer.waiters, 1);
  assert.equal(producer.controller.signal.aborted, false);
  survivor.abort('done');
  await assert.rejects(keep, (error) => error.name === 'AbortError');
});

test('#3195 abort reason preservation and error shaping', () => {
  const controller = new AbortController();
  const reason = new TypeError('custom reason');
  controller.abort(reason);
  assert.equal(appProducerAbortError(controller.signal), reason);
  const plain = new AbortController();
  plain.abort('plain-string');
  const error = appProducerAbortError(plain.signal);
  assert.equal(error.name, 'AbortError');
  assert.equal(error.message, 'plain-string');
  assert.equal(appProducerAbortError(null).message, 'Analysis producer aborted');
});