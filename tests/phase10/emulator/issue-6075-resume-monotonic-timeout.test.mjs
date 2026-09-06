import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalFunctionSandboxAdapter } from '../../../js/adapters/index.js';

function loopingIo() {
  return {
    fetch: async (address) => BigInt(address) === 0x1000n ? { mn: 'b', ops: '#0x1000' } : null,
    read: async () => null,
    isExecutable: (address) => BigInt(address) === 0x1000n,
    symbolFor: () => null,
  };
}

async function launched() {
  const adapter = new LocalFunctionSandboxAdapter(loopingIo());
  await adapter.connect();
  await adapter.launch({ address: 0x1000n, objectAsArg0: false });
  return adapter;
}

// NOTE: a steps-exhausted stop also classifies as kind 'timeout', so the
// discriminating signal is stop.message === 'timeout' (the emulator's own
// timeout marker) versus the steps-exhausted message.

test('6075: timeout fires on monotonic elapsed time', async () => {
  const adapter = await launched();
  try {
    let now = 0;
    const result = await adapter.resume({
      maxSteps: 5000,
      timeoutMs: 10,
      monotonicNow: () => now,
      onProgress: () => { now += 6; },
    });
    assert.equal(result.stop?.message, 'timeout');
  } finally {
    await adapter.disconnect();
  }
});

test('6075: wall-clock rollback does not delay the timeout', async () => {
  const adapter = await launched();
  const originalNow = Date.now;
  try {
    let now = 0;
    Date.now = () => 0; // wall clock pinned at the epoch; monotonic time still advances
    const result = await adapter.resume({
      maxSteps: 5000,
      timeoutMs: 10,
      monotonicNow: () => now,
      onProgress: () => { now += 6; },
    });
    assert.equal(result.stop?.message, 'timeout');
  } finally {
    Date.now = originalNow;
    await adapter.disconnect();
  }
});

test('6075: wall-clock forward jump does not fast-fire the timeout', async () => {
  const adapter = await launched();
  const originalNow = Date.now;
  try {
    let jumped = false;
    const result = await adapter.resume({
      maxSteps: 5000,
      timeoutMs: 30000,
      monotonicNow: () => 0,
      onProgress: () => {
        // Jump the wall clock far ahead mid-run; monotonic time stands still.
        if (!jumped) { jumped = true; Date.now = () => originalNow() + 1e12; }
      },
    });
    assert.notEqual(result.stop?.message, 'timeout');
  } finally {
    Date.now = originalNow;
    await adapter.disconnect();
  }
});

test('6075: no premature timeout before the budget elapses', async () => {
  const io = {
    fetch: async (address) => BigInt(address) === 0x1000n ? { mn: 'ret', ops: '' } : null,
    read: async () => null,
    isExecutable: (address) => BigInt(address) === 0x1000n,
    symbolFor: () => null,
  };
  const adapter = new LocalFunctionSandboxAdapter(io);
  await adapter.connect();
  await adapter.launch({ address: 0x1000n, objectAsArg0: false });
  try {
    const result = await adapter.resume({
      maxSteps: 400,
      timeoutMs: 30000,
      monotonicNow: () => 0,
    });
    assert.equal(result.timeout, false);
  } finally {
    await adapter.disconnect();
  }
});

test('6075: throwing initial clock read does not leak the active run', async () => {
  const adapter = await launched();
  try {
    await assert.rejects(
      () => adapter.resume({
        maxSteps: 400,
        timeoutMs: 30000,
        monotonicNow: () => { throw new Error('clock-boom'); },
      }),
      /clock-boom/,
    );
    assert.equal(adapter.activeRun, null, 'failed clock sample must release the active run');
    // The adapter must accept a new run afterwards instead of reporting
    // already-running (any terminal result is fine here).
    let alreadyRunning = false;
    try {
      await adapter.resume({
        maxSteps: 400,
        timeoutMs: 30000,
        monotonicNow: () => 0,
      });
    } catch (error) {
      alreadyRunning = /already-running/.test(String(error?.message || error));
      if (alreadyRunning) throw error;
    }
    assert.equal(alreadyRunning, false);
  } finally {
    await adapter.disconnect();
  }
});
