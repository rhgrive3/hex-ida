import assert from 'node:assert/strict';
import test from 'node:test';

import { EmulatorProvider } from '../../../js/runtime/emulator-provider.js';

function providerFor(execute) {
  return new EmulatorProvider({
    id: 'termination-authority-engine',
    version: '1',
    execute,
  });
}

async function runStatus(status, nonce) {
  const provider = providerFor(async () => ({ status }));
  const session = await provider.openSession({ binaryId: 'bin-A', sessionNonce: nonce });
  try {
    return await session.facets.emulator.run({});
  } finally {
    await session.close();
  }
}

test('P10 #4248 provider timeout dominates a non-cooperative late success', async () => {
  const provider = providerFor(async (_input, { signal }) => {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    return { status: 'success' };
  });
  const session = await provider.openSession({ binaryId: 'bin-A', sessionNonce: 'late-success-timeout' });

  const result = await session.facets.emulator.run({}, { timeoutMs: 10 });

  assert.equal(result.termination, 'timeout');
  assert.equal(result.completeness, 'truncated');
  assert.equal(result.batch.completeness, 'truncated');
  assert.ok(result.batch.events.every((event) => event.completeness === 'truncated'));
  assert.equal(result.recording.termination, 'timeout');
  assert.equal(result.recording.completeness, 'truncated');
  await session.close();
});

test('P10 #4248 provider timeout also dominates a late engine exception', async () => {
  const provider = providerFor(async (_input, { signal }) => {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    throw new Error('late engine failure');
  });
  const session = await provider.openSession({ binaryId: 'bin-A', sessionNonce: 'late-throw-timeout' });

  const result = await session.facets.emulator.run({}, { timeoutMs: 10 });

  assert.equal(result.termination, 'timeout');
  assert.equal(result.completeness, 'truncated');
  await session.close();
});

test('P10 #4248 external cancellation dominates a late success without becoming timeout', async () => {
  const external = new AbortController();
  const provider = providerFor(async () => {
    external.abort('user-cancelled');
    await Promise.resolve();
    return { status: 'success' };
  });
  const session = await provider.openSession({ binaryId: 'bin-A', sessionNonce: 'late-success-cancelled' });

  const result = await session.facets.emulator.run({}, { signal: external.signal, timeoutMs: 1000 });

  assert.equal(result.termination, 'cancelled');
  assert.equal(result.completeness, 'truncated');
  assert.equal(result.batch.completeness, 'truncated');
  await session.close();
});

test('P10 #4248 success before the deadline remains return/bounded', async () => {
  const result = await runStatus('success', 'success-before-deadline');
  assert.equal(result.termination, 'return');
  assert.equal(result.completeness, 'bounded');
});

test('P10 #4254 termination aliases require exact normalized tokens', async () => {
  const accepted = new Map([
    ['return', 'return'],
    ['timeout', 'timeout'],
    ['cancelled', 'cancelled'],
    ['fault', 'fault'],
    ['success', 'return'],
    ['complete', 'return'],
    ['limit', 'timeout'],
    ['cancel', 'cancelled'],
    ['crash', 'fault'],
    ['oob', 'fault'],
    ['unmapped', 'fault'],
    [' SUCCESS ', 'return'],
  ]);

  let index = 0;
  for (const [status, expected] of accepted) {
    const result = await runStatus(status, `accepted-${index++}`);
    assert.equal(result.termination, expected, status);
  }
});

test('P10 #4254 compound or negated status strings cannot mint return authority', async () => {
  for (const [index, status] of ['unsuccessful', 'incomplete', 'not-success', 'returning', 'completed', 'successful'].entries()) {
    const result = await runStatus(status, `rejected-${index}`);
    assert.equal(result.termination, 'exception', status);
    assert.equal(result.completeness, 'truncated', status);
    assert.equal(result.batch.completeness, 'truncated', status);
    assert.ok(result.batch.events.every((event) => event.completeness === 'truncated'), status);
  }
});
