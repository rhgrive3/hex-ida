import assert from 'node:assert/strict';
import test from 'node:test';

import { EmulatorProvider } from '../../../js/runtime/emulator-provider.js';

const binaryId = 'bin_sha256_' + '43'.repeat(32);

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded its provider bound`)), 250);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('#4385 timeout keeps a signal-ignoring execute session non-ready until the real operation settles', async () => {
  let signal;
  let rejectLate;
  let calls = 0;
  const engine = {
    execute(_input, options) {
      calls++;
      signal = options.signal;
      if (calls === 1) return new Promise((_resolve, reject) => { rejectLate = reject; });
      return { termination: 'return', value: calls };
    },
  };
  const provider = new EmulatorProvider(engine);
  const session = await provider.openSession({ binaryId, sessionNonce: 'issue-4385-timeout' }, { connect: false });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const result = await bounded(session.facets.emulator.run({}, { timeoutMs: 10 }), 'timeout run');
    assert.equal(result.termination, 'timeout');
    assert.equal(result.completeness, 'truncated');
    assert.equal(signal.aborted, true);
    assert.equal(session.controllers.size, 0);
    assert.equal(session.state, 'running', 'bounded return must not publish ready while execute still owns engine authority');
    assert.equal(calls, 1);

    await assert.rejects(
      session.facets.emulator.run({}, { timeoutMs: 10 }),
      /unsettled operation/,
      'same-session reuse must fail closed while the timed-out execute is still live',
    );
    assert.equal(calls, 1);

    rejectLate(new Error('late engine failure'));
    await nextTurn();
    assert.deepEqual(unhandled, []);
    assert.equal(session.state, 'ready', 'actual execute settlement must restore the same live session to ready');

    const reused = await bounded(session.facets.emulator.run({}, { timeoutMs: 100 }), 'post-settlement execute reuse');
    assert.equal(reused.termination, 'return');
    assert.equal(calls, 2);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    await session.close();
  }
});

test('#4385 close/reopen cannot bypass an unsettled execute quarantine', async () => {
  let settleExecute;
  let calls = 0;
  const engine = {
    execute() {
      calls++;
      if (calls === 1) return new Promise((resolve) => { settleExecute = resolve; });
      return { termination: 'return' };
    },
  };
  const provider = new EmulatorProvider(engine);
  const session = await provider.openSession({ binaryId, sessionNonce: 'issue-4385-reopen' }, { connect: false });
  const result = await bounded(session.facets.emulator.run({}, { timeoutMs: 10 }), 'reopen quarantine timeout');
  assert.equal(result.termination, 'timeout');
  assert.equal(session.state, 'running');
  await session.close();

  await assert.rejects(
    provider.openSession({ binaryId, sessionNonce: 'issue-4385-reopen-blocked' }, { connect: false }),
    /unsettled operation/,
    'close/reopen must remain blocked while the old execute operation is live',
  );
  assert.equal(calls, 1);

  settleExecute({ termination: 'return' });
  await nextTurn();
  const reopened = await provider.openSession({ binaryId, sessionNonce: 'issue-4385-reopened' }, { connect: false });
  assert.equal(reopened.state, 'ready');
  const reused = await bounded(reopened.facets.emulator.run({}, { timeoutMs: 100 }), 'post-settlement reopen reuse');
  assert.equal(reused.termination, 'return');
  assert.equal(calls, 2);
  await reopened.close();
});

test('#4385 external cancellation keeps a signal-ignoring execute session non-ready until settlement', async () => {
  const external = new AbortController();
  let markStarted;
  let settleExecute;
  let calls = 0;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const engine = {
    execute() {
      calls++;
      if (calls === 1) {
        markStarted();
        return new Promise((resolve) => { settleExecute = resolve; });
      }
      return { termination: 'return' };
    },
  };
  const session = await new EmulatorProvider(engine).openSession({ binaryId, sessionNonce: 'issue-4385-external' }, { connect: false });
  const run = session.facets.emulator.run({}, { timeoutMs: 1000, signal: external.signal });
  await started;
  external.abort('caller-cancelled');
  const result = await bounded(run, 'external cancellation');
  assert.equal(result.termination, 'cancelled');
  assert.equal(result.completeness, 'truncated');
  assert.equal(session.controllers.size, 0);
  assert.equal(session.state, 'running');
  await assert.rejects(session.facets.emulator.run({}, { timeoutMs: 100 }), /unsettled operation/);
  assert.equal(calls, 1);

  settleExecute({ termination: 'return' });
  await nextTurn();
  assert.equal(session.state, 'ready');
  const reused = await bounded(session.facets.emulator.run({}, { timeoutMs: 100 }), 'post-cancel settlement reuse');
  assert.equal(reused.termination, 'return');
  assert.equal(calls, 2);
  await session.close();
});

test('#4385 completion before timeout keeps the normal result and session state', async () => {
  const engine = {
    async execute() {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { termination: 'return', value: 42 };
    },
  };
  const session = await new EmulatorProvider(engine).openSession({ binaryId, sessionNonce: 'issue-4385-complete' }, { connect: false });
  const result = await bounded(session.facets.emulator.run({}, { timeoutMs: 100 }), 'early completion');
  assert.equal(result.termination, 'return');
  assert.equal(result.completeness, 'bounded');
  assert.equal(session.controllers.size, 0);
  assert.equal(session.state, 'ready');
  const reused = await bounded(session.facets.emulator.run({}, { timeoutMs: 100 }), 'completed-engine reuse');
  assert.equal(reused.termination, 'return');
  await session.close();
});

test('#4385 timeout keeps signal-ignoring launch/resume non-ready until resume settles', async () => {
  let resumeSignal;
  let settleResume;
  let resumeCalls = 0;
  const engine = {
    async launch() {},
    resume(options) {
      resumeCalls++;
      resumeSignal = options.signal;
      if (resumeCalls === 1) return new Promise((resolve) => { settleResume = resolve; });
      return { termination: 'return' };
    },
  };
  const provider = new EmulatorProvider(engine);
  const session = await provider.openSession({ binaryId, sessionNonce: 'issue-4385-resume' }, { connect: false });
  const result = await bounded(session.facets.emulator.run({}, { timeoutMs: 10 }), 'resume timeout');
  assert.equal(result.termination, 'timeout');
  assert.equal(result.completeness, 'truncated');
  assert.equal(resumeSignal.aborted, true);
  assert.equal(session.controllers.size, 0);
  assert.equal(session.state, 'running', 'bounded return must not publish ready while resume still owns engine authority');
  assert.equal(resumeCalls, 1);

  await assert.rejects(session.facets.emulator.run({}, { timeoutMs: 10 }), /unsettled operation/);
  assert.equal(resumeCalls, 1);

  settleResume({ termination: 'return' });
  await nextTurn();
  assert.equal(session.state, 'ready', 'actual resume settlement must restore the same live session to ready');
  const reused = await bounded(session.facets.emulator.run({}, { timeoutMs: 100 }), 'post-settlement resume reuse');
  assert.equal(reused.termination, 'return');
  assert.equal(resumeCalls, 2);
  await session.close();
});

test('#4385 a cooperative abort settles the engine and permits reuse', async () => {
  let calls = 0;
  const engine = {
    execute(_input, { signal }) {
      calls++;
      if (calls > 1) return { termination: 'return' };
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cooperative abort')), { once: true });
      });
    },
  };
  const session = await new EmulatorProvider(engine).openSession({ binaryId, sessionNonce: 'issue-4385-cooperative' }, { connect: false });
  const timedOut = await bounded(session.facets.emulator.run({}, { timeoutMs: 10 }), 'cooperative timeout');
  assert.equal(timedOut.termination, 'timeout');
  await nextTurn();
  assert.equal(session.state, 'ready');
  const reused = await bounded(session.facets.emulator.run({}, { timeoutMs: 100 }), 'cooperative reuse');
  assert.equal(reused.termination, 'return');
  assert.equal(calls, 2);
  await session.close();
});
