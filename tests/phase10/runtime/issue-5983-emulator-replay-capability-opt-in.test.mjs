import assert from 'node:assert/strict';
import test from 'node:test';

import { EmulatorProvider } from '../../../js/runtime/emulator-provider.js';

function providerFor(execute, options = {}) {
  return new EmulatorProvider({ id: 'test-engine', version: '1', execute }, options);
}

test('#5983 an engine that never declares deterministic does not gain replay', async () => {
  let n = 0;
  // Nondeterministic engine with no deterministic declaration anywhere.
  const provider = providerFor(async () => ({ termination: 'return', value: ++n }));

  assert.equal(provider.engineDescriptor.deterministic, false);
  assert.equal(provider.descriptor().capabilities.replay, false);

  const session = await provider.openSession({ binaryId: 'bin-A', sessionNonce: '5983-unspecified' });
  const run = await session.facets.emulator.run({ input: 1 });
  assert.equal(run.termination, 'return');
  await assert.rejects(
    () => session.facets.emulator.replay(run.recording),
    (error) => error?.code === 'unsupported',
  );
  await session.close();
});

test('#5983 engine-descriptor and options opt-ins still authorize replay', async () => {
  const engineDeclared = new EmulatorProvider({
    id: 'declared-engine',
    version: '1',
    deterministic: true,
    async execute() { return { termination: 'return' }; },
  });
  assert.equal(engineDeclared.engineDescriptor.deterministic, true);
  assert.equal(engineDeclared.descriptor().capabilities.replay, true);

  const engineDescriptorDeclared = new EmulatorProvider({
    id: 'descriptor-engine',
    version: '1',
    descriptor() { return { id: 'descriptor-engine', version: '1', deterministic: true }; },
    async execute() { return { termination: 'return' }; },
  });
  assert.equal(engineDescriptorDeclared.engineDescriptor.deterministic, true);
  assert.equal(engineDescriptorDeclared.descriptor().capabilities.replay, true);

  const optionsDeclared = providerFor(async () => ({ termination: 'return' }), { deterministic: true });
  assert.equal(optionsDeclared.engineDescriptor.deterministic, true);
  assert.equal(optionsDeclared.descriptor().capabilities.replay, true);

  for (const provider of [engineDeclared, engineDescriptorDeclared, optionsDeclared]) {
    const session = await provider.openSession({ binaryId: 'bin-A', sessionNonce: '5983-opt-in' });
    const run = await session.facets.emulator.run({});
    const replay = await session.facets.emulator.replay(run.recording);
    assert.equal(replay.termination, 'return');
    await session.close();
  }
});

test('#5983 explicit false and non-boolean authority stay rejected/false', () => {
  const explicitFalse = providerFor(async () => ({ termination: 'return' }), { deterministic: false });
  assert.equal(explicitFalse.descriptor().capabilities.replay, false);

  const descriptorFalse = new EmulatorProvider({
    id: 'false-descriptor-engine',
    version: '1',
    descriptor() { return { id: 'x', version: '1', deterministic: false }; },
    async execute() { return { termination: 'return' }; },
  });
  assert.equal(descriptorFalse.descriptor().capabilities.replay, false);

  assert.throws(
    () => providerFor(async () => ({ termination: 'return' }), { deterministic: 'true' }),
    (error) => error?.code === 'emulator-deterministic-invalid',
  );
  assert.throws(
    () => new EmulatorProvider({
      id: 'truthy-descriptor-engine',
      version: '1',
      descriptor() { return { id: 'x', version: '1', deterministic: 'yes' }; },
      async execute() { return { termination: 'return' }; },
    }),
    (error) => error?.code === 'emulator-deterministic-invalid',
  );
});
