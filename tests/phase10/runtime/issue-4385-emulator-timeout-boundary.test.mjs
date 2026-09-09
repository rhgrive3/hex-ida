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

test('#4385 provider timeout bounds an engine that never settles and absorbs a late rejection', async () => {
  let signal;
  let rejectLate;
  const engine = {
    execute(_input, options) {
      signal = options.signal;
      return new Promise((_resolve, reject) => { rejectLate = reject; });
    },
  };
  const session = await new EmulatorProvider(engine).openSession({ binaryId, sessionNonce: 'issue-4385-timeout' }, { connect: false });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const result = await bounded(session.facets.emulator.run({}, { timeoutMs: 10 }), 'timeout run');
    assert.equal(result.termination, 'timeout');
    assert.equal(result.completeness, 'truncated');
    assert.equal(signal.aborted, true);
    assert.equal(session.controllers.size, 0);
    assert.equal(session.state, 'ready');

    rejectLate(new Error('late engine failure'));
    await nextTurn();
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    await session.close();
  }
});

test('#4385 provider bounds external cancellation for a signal-ignoring engine', async () => {
  const external = new AbortController();
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const engine = {
    execute() {
      markStarted();
      return new Promise(() => {});
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
  assert.equal(session.state, 'ready');
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
  await session.close();
});

test('#4385 provider timeout also bounds the launch/resume engine shape', async () => {
  let resumeSignal;
  const engine = {
    async launch() {},
    resume(_options) {
      resumeSignal = _options.signal;
      return new Promise(() => {});
    },
  };
  const session = await new EmulatorProvider(engine).openSession({ binaryId, sessionNonce: 'issue-4385-resume' }, { connect: false });
  const result = await bounded(session.facets.emulator.run({}, { timeoutMs: 10 }), 'resume timeout');
  assert.equal(result.termination, 'timeout');
  assert.equal(result.completeness, 'truncated');
  assert.equal(resumeSignal.aborted, true);
  assert.equal(session.controllers.size, 0);
  assert.equal(session.state, 'ready');
  await session.close();
});
