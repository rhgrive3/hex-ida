import assert from 'node:assert/strict';
import test from 'node:test';
import { SolverSession, SESSION_STATE } from '../../../js/symbolic/solver/session.js';
import { SOLVER_STATUS } from '../../../js/symbolic/solver/result.js';

class SpySession extends SolverSession {
  constructor() {
    super({ id: 'spy', version: '1' });
    this.executions = 0;
    this.cancellations = 0;
    this.handler = () => ({ status: SOLVER_STATUS.UNSAT });
  }
  _executeCheck(_query, options) {
    this.executions++;
    this.executionSignal = options.signal;
    return this.handler();
  }
  async _onCancel() { this.cancellations++; }
}

function registrationSignal(dispatch) {
  const listeners = new Set();
  return {
    aborted: false, removals: 0,
    addEventListener(type, listener) {
      assert.equal(type, 'abort');
      listeners.add(listener);
      this.aborted = true;
      if (dispatch) listener();
    },
    removeEventListener(type, listener) {
      assert.equal(type, 'abort');
      this.removals++;
      listeners.delete(listener);
    },
    get listenerCount() { return listeners.size; },
  };
}

for (const dispatch of [false, true]) {
  test(`#4322 registration abort (dispatch=${dispatch}) settles once without starting solver/timer`, async () => {
    const signal = registrationSignal(dispatch);
    const session = new SpySession();
    let timers = 0;
    const originalSetTimeout = globalThis.setTimeout;
    const handles = [];
    globalThis.setTimeout = (...args) => {
      timers++;
      const handle = originalSetTimeout(...args);
      handles.push(handle);
      return handle;
    };
    try {
      const result = await session.check({}, { signal });
      assert.equal(result.status, SOLVER_STATUS.CANCELLED);
      assert.equal(result.lifecycle.publishable, false);
      assert.equal(session.executions, 0);
      assert.equal(session.cancellations, 1);
      assert.equal(session.state, SESSION_STATE.CANCELLED);
      assert.equal(session._inFlight.size, 0);
      assert.equal(signal.listenerCount, 0);
      assert.equal(signal.removals, 1);
      assert.equal(timers, 0, 'do not install a timer after synchronous cancellation');
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      for (const handle of handles) clearTimeout(handle);
      await session.dispose();
    }
  });
}

test('#4322 real AbortSignal aborted by synchronous session cleanup is rechecked after subscription', async () => {
  const controller = new AbortController();
  const session = new SpySession();
  session._invalidatePreviousQueries = () => controller.abort('superseded');
  const result = await session.check({}, { signal: controller.signal });
  assert.equal(result.status, SOLVER_STATUS.CANCELLED);
  assert.equal(result.lifecycle.publishable, false);
  assert.equal(session.executions, 0);
  assert.equal(session.cancellations, 1);
  assert.equal(session._inFlight.size, 0);
});

test('#4322 abort before the queued provider call prevents work', async () => {
  const session = new SpySession();
  const controller = new AbortController();
  const pending = session.check({}, { signal: controller.signal });
  controller.abort();
  const result = await pending;
  assert.equal(result.status, SOLVER_STATUS.CANCELLED);
  assert.equal(session.executions, 0);
  assert.equal(session.cancellations, 1);
  assert.equal(session._inFlight.size, 0);
});

test('#4322 a late SAT result after cancellation remains non-publishable', async () => {
  const session = new SpySession();
  const controller = new AbortController();
  let finish;
  session.handler = () => new Promise((resolve) => { finish = resolve; });
  const pending = session.check({}, { signal: controller.signal });
  await Promise.resolve();
  assert.equal(session.executions, 1);
  controller.abort();
  const result = await pending;
  finish({ status: SOLVER_STATUS.SAT });
  await Promise.resolve();
  assert.equal(result.status, SOLVER_STATUS.CANCELLED);
  assert.equal(result.lifecycle.publishable, false);
  assert.equal(session.executionSignal.aborted, true);
  assert.equal(session.cancellations, 1);
  assert.equal(session._inFlight.size, 0);
});

test('#4322 pre-aborted and successful queries retain their distinct lifecycle', async () => {
  const session = new SpySession();
  const pre = new AbortController();
  pre.abort();
  const cancelled = await session.check({}, { signal: pre.signal });
  assert.equal(cancelled.status, SOLVER_STATUS.CANCELLED);
  assert.equal(session.executions, 0);
  const live = new AbortController();
  const result = await session.check({}, { signal: live.signal });
  assert.equal(result.status, SOLVER_STATUS.UNSAT);
  assert.equal(result.lifecycle.publishable, true);
  live.abort();
  assert.equal(session.state, SESSION_STATE.ACTIVE, 'completed query listener must be detached');
  assert.equal(session.cancellations, 0);
  assert.equal(session._inFlight.size, 0);
});
