import assert from 'node:assert/strict';
import test from 'node:test';

import { SolverSession } from '../../../js/symbolic/solver/session.js';
import { SOLVER_STATUS } from '../../../js/symbolic/solver/result.js';

class NeverSession extends SolverSession {
  constructor(options = {}) {
    super({ id: 'never-solver', version: '1' }, options);
    this.timeoutCount = 0;
    this.disposeCount = 0;
    this.executeCount = 0;
  }

  async _executeCheck() {
    this.executeCount += 1;
    return new Promise(() => {});
  }

  async _onTimeout() {
    this.timeoutCount += 1;
  }

  async _onDispose() {
    this.disposeCount += 1;
  }
}

async function settleWithin(promise, timeoutMs = 100) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('negative per-query timeout is rejected before starting an unbounded query', async () => {
  const session = new NeverSession({ timeoutMs: 10 });
  const pending = session.check({ queryHash: 'negative-timeout' }, { timeoutMs: -1 });
  try {
    const result = await settleWithin(pending);
    assert.ok(result, 'a negative timeout must not leave the query in flight forever');
    assert.equal(result.status, SOLVER_STATUS.INVALID_QUERY);
    assert.match(result.reason, /^invalid-budget:/);
    assert.equal(session.timeoutCount, 0);
    assert.equal(session.executeCount, 0);
    assert.equal(session._inFlight.size, 0);
  } finally {
    await session.dispose();
    await pending;
  }
});

test('invalid timeout values cannot start a query or disable its bounded lifecycle', async () => {
  for (const requestedTimeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5]) {
    const session = new NeverSession({ timeoutMs: 10 });
    const pending = session.check({ queryHash: `invalid-${String(requestedTimeoutMs)}` }, { timeoutMs: requestedTimeoutMs });
    try {
      const result = await settleWithin(pending);
      assert.ok(result, `invalid timeout ${String(requestedTimeoutMs)} must stay bounded`);
      assert.equal(result.status, SOLVER_STATUS.INVALID_QUERY);
      assert.match(result.reason, /^invalid-budget:/);
      assert.equal(session.timeoutCount, 0);
      assert.equal(session.executeCount, 0);
      assert.equal(session._inFlight.size, 0);
    } finally {
      await session.dispose();
      await pending;
    }
  }
});

test('zero remains an explicit no-timeout sentinel and cancellation still cleans up', async () => {
  const session = new NeverSession({ timeoutMs: 10 });
  const pending = session.check({ queryHash: 'zero-timeout' }, { timeoutMs: 0 });
  await session.cancel();
  const result = await pending;
  assert.equal(result.status, SOLVER_STATUS.CANCELLED);
  assert.equal(session.timeoutCount, 0);
  assert.equal(session.disposeCount, 0);
  await session.dispose();
  assert.equal(session.disposeCount, 1);
});

test('an invalid session timeout is rejected without acquiring a backend', () => {
  // The integration's canonical primitive-budget contract rejects invalid
  // options earlier than main's fallback timer. This preserves #4432's
  // no-unbounded-query invariant without substituting another caller budget.
  for (const timeoutMs of [-1, NaN, Infinity, -Infinity, 1.5]) {
    assert.throws(() => new NeverSession({ timeoutMs }), /primitive non-negative safe integer/);
  }
});

test('an omitted session timeout still uses the five-second bounded default', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  let observedDelay;
  globalThis.setTimeout = (callback, delay, ...args) => {
    observedDelay = delay;
    return originalSetTimeout(callback, 1, ...args);
  };
  const session = new NeverSession();
  let pending;
  try {
    pending = session.check({ queryHash: 'invalid-session-timeout' });
    await Promise.resolve();
    assert.equal(observedDelay, 5000);
    const result = await pending;
    assert.equal(result.status, SOLVER_STATUS.TIMEOUT);
  } finally {
    await session.dispose();
    if (pending) await pending;
    globalThis.setTimeout = originalSetTimeout;
  }
});

console.log('issue #4432 solver negative-timeout regressions: PASS');
