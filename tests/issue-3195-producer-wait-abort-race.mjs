import test from 'node:test';
import assert from 'node:assert/strict';

import { appProducerAbortError, waitForAppProducer } from '../js/analysis/producer-wait.js';

function entry(pending = true) {
  const controller = new AbortController();
  return {
    controller,
    settled: !pending,
    waiters: 0,
    promise: pending ? new Promise(() => {}) : Promise.resolve('done'),
  };
}

test('#3195 abort between pre-check and subscription detaches the consumer immediately', async () => {
  const producer = entry();
  const controller = new AbortController();
  const signal = controller.signal;

  const waiting = waitForAppProducer(producer, signal);
  // The race window: signal is not yet aborted when the pre-check ran, but is
  // aborted before the listener could ever observe an event dispatch.
  controller.abort('raced');
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

test('#3195 pre-aborted signal rejects before touching waiter state', async () => {
  const producer = entry();
  const controller = new AbortController();
  controller.abort('already gone');
  await assert.rejects(waitForAppProducer(producer, controller.signal), (error) => error.name === 'AbortError');
  assert.equal(producer.waiters, 0);
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
