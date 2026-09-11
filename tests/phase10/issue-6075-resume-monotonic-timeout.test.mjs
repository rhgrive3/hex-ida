// Regression for #6075: the local sandbox resume timeout must be measured on
// a monotonic clock (injectable for tests), never on Date.now() differences —
// a wall-clock rollback deferred the budget past its deadline and a forward
// jump fired it early.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LocalFunctionSandboxAdapter } from '../../js/adapters/index.js';

function harness(monotonicNow) {
  const adapter = new LocalFunctionSandboxAdapter({}, { monotonicNow });
  const state = { stopReason: null };
  adapter.ensureSandbox = () => adapter.sandbox;
  adapter.sandbox = {
    emulator: {
      stopped: null,
      get: () => 0n,
    },
    run: async ({ onProgress }) => {
      // 30 progress events, each nominally 1000ms of budget time.
      for (let step = 0; step < 30; step++) {
        onProgress(step);
        if (adapter.sandbox.emulator.stopped === 'timeout') break;
      }
      return { steps: 3, stopped: adapter.sandbox.emulator.stopped };
    },
  };
  return { adapter, state };
}

test('#6075 timeout fires on monotonic budget exhaustion despite wall-clock rollback', async () => {
  const originalNow = Date.now;
  let monotonic = 10_000;
  let wall = 1_000_000;
  Date.now = () => wall;
  try {
    const { adapter } = harness(() => monotonic);
    adapter.sandbox.run = async ({ onProgress }) => {
      // Each step nominally consumes 1000ms of budget time while the wall
      // clock rolls back 10 seconds — the monotonic predicate must still
      // enforce the 2000ms budget at the right step.
      for (let step = 0; step < 30; step++) {
        monotonic += 1000;
        wall -= 10_000;
        onProgress(step);
        if (adapter.sandbox.emulator.stopped === 'timeout') break;
      }
      return { steps: 3, stopped: adapter.sandbox.emulator.stopped };
    };
    await adapter.resume({ timeoutMs: 2000, maxSteps: 100 });
    assert.equal(adapter.sandbox.emulator.stopped, 'timeout', 'the 2000ms budget must be enforced on the monotonic clock');
  } finally {
    Date.now = originalNow;
  }
});

test('#6075 monotonic clock does not fire before the budget elapses', async () => {
  let monotonic = 10_000;
  const { adapter } = harness(() => monotonic);
  // Wrap sandbox.run to advance the clock only slightly (below the budget).
  adapter.sandbox.run = async ({ onProgress }) => {
    for (let step = 0; step < 3; step++) {
      monotonic += 10;
      onProgress(step);
    }
    return { steps: 3, stopped: adapter.sandbox.emulator.stopped };
  };
  const result = await adapter.resume({ timeoutMs: 2000, maxSteps: 100 });
  assert.notEqual(adapter.sandbox.emulator.stopped, 'timeout');
  assert.ok(result);
});

test('#6075 no monotonic source fails closed instead of using Date.now', async () => {
  const performanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  const originalHrtimeBigint = process.hrtime.bigint;
  const originalDateNow = Date.now;
  try {
    Object.defineProperty(globalThis, 'performance', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    process.hrtime.bigint = () => { throw new Error('hrtime unavailable'); };
    Date.now = () => 123_456;
    const { adapter } = harness();
    await assert.rejects(
      adapter.resume({ timeoutMs: 2000, maxSteps: 100 }),
      (error) => error?.code === 'monotonic-clock-unavailable',
    );
    const noTimeout = harness();
    await noTimeout.adapter.resume({ maxSteps: 100 });
  } finally {
    if (performanceDescriptor) Object.defineProperty(globalThis, 'performance', performanceDescriptor);
    else delete globalThis.performance;
    process.hrtime.bigint = originalHrtimeBigint;
    Date.now = originalDateNow;
  }
});
