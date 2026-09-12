import assert from 'node:assert/strict';
import test from 'node:test';
import { globalReferenceStats } from '../../../js/analysis/global-ref-stats.js';

async function rejected(signal) {
  try {
    await globalReferenceStats(null, null, { signal });
  } catch (error) {
    return error;
  }
  assert.fail('expected a pre-aborted request to reject');
}

function abortedWith(reason) {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
}

for (const [label, reason, message] of [
  ['string', 'project-switched', 'project-switched'],
  ['zero', 0, '0'],
  ['false', false, 'false'],
  ['empty string', '', ''],
  ['null', null, 'null'],
]) {
  test(`#4355 preserves an explicit ${label} cancellation reason`, async () => {
    const error = await rejected(abortedWith(reason));
    assert.equal(error.name, 'AbortError');
    assert.equal(error.message, message);
    assert.equal(error.cause, reason);
  });
}

test('#4355 reuses a caller AbortError unchanged', async () => {
  const reason = Object.assign(new Error('caller abort'), { name: 'AbortError', code: 'CALLER_ABORT' });
  const error = await rejected(abortedWith(reason));
  assert.equal(error, reason);
  assert.equal(reason.name, 'AbortError');
  assert.equal(reason.code, 'CALLER_ABORT');
});

test('#4355 wraps another Error without mutating caller-owned state', async () => {
  const reason = Object.assign(new Error('deadline exceeded'), { name: 'TimeoutError', code: 'ETIME' });
  Object.freeze(reason);
  const error = await rejected(abortedWith(reason));
  assert.notEqual(error, reason);
  assert.equal(error.name, 'AbortError');
  assert.equal(error.message, 'deadline exceeded');
  assert.equal(error.cause, reason);
  assert.equal(reason.name, 'TimeoutError');
  assert.equal(reason.code, 'ETIME');
});

test('#4355 falls back only when no cancellation reason is available', async () => {
  const error = await rejected({ aborted: true });
  assert.equal(error.name, 'AbortError');
  assert.equal(error.message, 'Operation aborted');
  assert.equal(Object.hasOwn(error, 'cause'), false);
});

test('#4355 opaque non-Error reasons remain available as cause when stringification fails', async () => {
  const reason = Object.freeze({ toString() { throw new Error('must not escape cancellation'); } });
  const error = await rejected(abortedWith(reason));
  assert.equal(error.name, 'AbortError');
  assert.equal(error.message, 'Operation aborted');
  assert.equal(error.cause, reason);
});

test('#4355 a hostile reason accessor cannot turn cancellation into an arbitrary failure', async () => {
  const signal = { aborted: true, get reason() { throw new Error('hostile reason getter'); } };
  const error = await rejected(signal);
  assert.equal(error.name, 'AbortError');
  assert.equal(error.message, 'Operation aborted');
  assert.equal(Object.hasOwn(error, 'cause'), false);
});

test('#4355 a hostile Error name accessor is wrapped without mutation', async () => {
  const reason = new Error('opaque error');
  Object.defineProperty(reason, 'name', { configurable: false, get() { throw new Error('name getter'); } });
  Object.freeze(reason);
  const error = await rejected(abortedWith(reason));
  assert.notEqual(error, reason);
  assert.equal(error.name, 'AbortError');
  assert.equal(error.message, 'opaque error');
  assert.equal(error.cause, reason);
});

test('#4355 result and coverage semantics remain unchanged for live calls', async () => {
  const stats = Object.freeze({ counts: new Map([['g', 2]]), scannedRefs: 2, complete: true, reason: null, producer: 'program-region-ref-aggregate/v1' });
  assert.equal(await globalReferenceStats({ globalReferenceStats: stats }, null), stats);

  const unavailable = await globalReferenceStats(null, null);
  assert.equal(unavailable.complete, false);
  assert.equal(unavailable.reason, 'program-index-unavailable');
  assert.equal(unavailable.producer, 'program-region-ref-aggregate/v1');
});
