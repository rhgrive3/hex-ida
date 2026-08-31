import assert from 'node:assert/strict';
import { EmulatorProvider } from '../../js/runtime/emulator-provider.js';

function providerFor(execute, options = {}) {
  return new EmulatorProvider({
    id: 'test-engine',
    version: '1',
    execute,
  }, options);
}

// #3008: malformed truthy deterministic metadata must not authorize replay.
for (const malformed of ['false', [], {}, 1]) {
  assert.throws(
    () => providerFor(async () => ({ termination: 'return' }), { deterministic: malformed }),
    /emulator deterministic flag must be a boolean|emulator-deterministic-invalid/,
  );
}
{
  const nondeterministic = providerFor(async () => ({ termination: 'return' }), { deterministic: false });
  assert.equal(nondeterministic.descriptor().capabilities.replay, false);
  const session = await nondeterministic.openSession({ binaryId: 'bin-A', sessionNonce: 'nondeterministic' });
  await assert.rejects(() => session.facets.emulator.replay(), /does not advertise deterministic replay|unsupported/);
  await session.close();
}

// #3009: non-string termination/status evidence fails closed to exception.
{
  const provider = providerFor(async () => ({ termination: ['return'] }));
  const session = await provider.openSession({ binaryId: 'bin-A', sessionNonce: 'bad-termination' });
  const result = await session.facets.emulator.run({});
  assert.equal(result.termination, 'exception');
  assert.equal(result.completeness, 'truncated');
  await session.close();
}
{
  const provider = providerFor(async () => ({ termination: 'return' }));
  const session = await provider.openSession({ binaryId: 'bin-A', sessionNonce: 'good-termination' });
  const result = await session.facets.emulator.run({});
  assert.equal(result.termination, 'return');
  assert.equal(result.completeness, 'bounded');
  await session.close();
}

// #3007: abort that happens in the check->listener window must be observed.
{
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
      // Model an abort delivered after the caller's first check but before the
      // listener can observe an event. The post-registration check must catch it.
      this.aborted = true;
    },
    removeEventListener() {},
  };
  const result = await session.facets.emulator.run({}, { signal: raceSignal });
  assert.equal(executeCalls, 0);
  assert.equal(result.termination, 'cancelled');
  assert.equal(result.completeness, 'truncated');
  await session.close();
}

console.log('runtime emulator provider boundaries: PASS');