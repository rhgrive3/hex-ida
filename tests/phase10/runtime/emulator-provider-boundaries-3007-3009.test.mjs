import assert from 'node:assert/strict';
import test from 'node:test';

import { EmulatorProvider } from '../../../js/runtime/emulator-provider.js';

function providerFor(execute, options = {}) {
  return new EmulatorProvider({
    id: 'test-engine',
    version: '1',
    execute,
  }, options);
}

test('P10 #3007 observes aborts in the external signal check-to-listener window', async () => {
  let executeCalls = 0;
  const provider = providerFor(async () => {
    executeCalls += 1;
    return { termination: 'return' };
  });
  const session = await provider.openSession({ binaryId: 'bin-A', sessionNonce: 'abort-race' });
  const raceSignal = {
    aborted: false,
    reason: 'race-cancelled',
    addEventListener(type) {
      assert.equal(type, 'abort');
      this.aborted = true;
    },
    removeEventListener() {},
  };

  const result = await session.facets.emulator.run({}, { signal: raceSignal });

  assert.equal(executeCalls, 0);
  assert.equal(result.termination, 'cancelled');
  assert.equal(result.completeness, 'truncated');
  assert.equal(result.batch.completeness, 'truncated');
  assert.ok(result.batch.events.every((event) => event.completeness === 'truncated'));
  await session.close();
});

test('P10 #3008 rejects malformed deterministic authority and keeps replay gate boolean-only', async () => {
  for (const malformed of ['false', [], {}, 1]) {
    assert.throws(
      () => providerFor(async () => ({ termination: 'return' }), { deterministic: malformed }),
      (error) => error?.code === 'emulator-deterministic-invalid',
    );
  }

  const nondeterministic = providerFor(async () => ({ termination: 'return' }), { deterministic: false });
  assert.equal(nondeterministic.descriptor().capabilities.replay, false);
  const session = await nondeterministic.openSession({ binaryId: 'bin-A', sessionNonce: 'nondeterministic' });
  await assert.rejects(
    () => session.facets.emulator.replay(),
    (error) => error?.code === 'unsupported',
  );
  await session.close();

  const defaultDeterministic = providerFor(async () => ({ termination: 'return' }));
  assert.equal(defaultDeterministic.descriptor().capabilities.replay, true);
});

test('P10 #3009 malformed termination evidence fails closed to exception/truncated', async () => {
  const provider = providerFor(async () => ({ termination: ['return'] }));
  const session = await provider.openSession({ binaryId: 'bin-A', sessionNonce: 'bad-termination' });

  const result = await session.facets.emulator.run({});

  assert.equal(result.termination, 'exception');
  assert.equal(result.completeness, 'truncated');
  assert.equal(result.batch.completeness, 'truncated');
  assert.ok(result.batch.events.every((event) => event.completeness === 'truncated'));
  await session.close();
});

test('P10 #3009 preserves valid string termination classification', async () => {
  const provider = providerFor(async () => ({ termination: 'return' }));
  const session = await provider.openSession({ binaryId: 'bin-A', sessionNonce: 'good-termination' });

  const result = await session.facets.emulator.run({});

  assert.equal(result.termination, 'return');
  assert.equal(result.completeness, 'bounded');
  assert.equal(result.batch.completeness, 'bounded');
  assert.ok(result.batch.events.every((event) => event.completeness === 'bounded'));
  await session.close();
});
