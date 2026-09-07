// Regression for #5902: cancel() must not permanently poison the emulator
// engine — a new resume() on the same launch clears the previous run's
// terminal 'cancelled' state (exactly like 'paused' already was).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LocalFunctionSandboxAdapter } from '../js/adapters/index.js';

function harness() {
  const adapter = new LocalFunctionSandboxAdapter({}, {});
  const state = { executed: 0 };
  adapter.ensureSandbox = () => adapter.sandbox;
  adapter.sandbox = {
    emulator: { stopped: null, get: () => 0n },
    run: async ({ maxSteps }) => {
      let n = 0;
      while (n < maxSteps && !adapter.sandbox.emulator.stopped) {
        state.executed += 1;
        n += 1;
      }
      return { steps: n, stopped: adapter.sandbox.emulator.stopped };
    },
  };
  return { adapter, state };
}

test('#5902 resume after cancel executes again on the same launch', async () => {
  const { adapter, state } = harness();
  const first = adapter.resume({ maxSteps: 1000000 });
  await adapter.cancel();
  const firstResult = await first;
  assert.equal(firstResult?.cancelled ?? adapter.cancelled, true);
  const executedAfterFirst = state.executed;
  assert.ok(executedAfterFirst > 0);

  const second = await adapter.resume({ maxSteps: 1 });
  assert.equal(state.executed, executedAfterFirst + 1, 'the second resume must execute exactly 1 step');
  assert.equal(second?.steps, 1);
  assert.notEqual(adapter.sandbox.emulator.stopped, 'cancelled', 'the new run must not inherit the cancelled terminal state');
});

test('#5902 pause->resume keeps clearing the paused state too', async () => {
  const { adapter } = harness();
  adapter.sandbox.emulator.stopped = 'paused';
  const run = adapter.resume({ maxSteps: 1 });
  // The run loop sees no stopped state and finishes its single step.
  const result = await run;
  assert.equal(result?.steps, 1);
});
