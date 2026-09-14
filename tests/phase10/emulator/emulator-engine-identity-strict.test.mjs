import assert from 'node:assert/strict';
import test from 'node:test';

import { EmulatorProvider } from '../../../js/runtime/emulator-provider.js';

function engine(descriptor = {}) {
  return {
    descriptor: () => ({ id: 'engine', version: '1', ...descriptor }),
    async execute() { return { stop: { kind: 'return' } }; },
  };
}

for (const bad of [[], {}, 7, true]) {
  test(`P10.9 emulator engine id rejects ${typeof bad} coercion`, () => {
    assert.throws(() => new EmulatorProvider(engine({ id: bad })), /engine id must be a non-empty string/);
    assert.throws(() => new EmulatorProvider(engine(), { engineId: bad }), /engine id must be a non-empty string/);
  });

  test(`P10.9 emulator engine version rejects ${typeof bad} coercion`, () => {
    assert.throws(() => new EmulatorProvider(engine({ version: bad })), /engine version must be a non-empty string/);
    assert.throws(() => new EmulatorProvider(engine(), { engineVersion: bad }), /engine version must be a non-empty string/);
  });
}

test('P10.9 valid string engine identity is preserved without coercion', () => {
  const provider = new EmulatorProvider(engine({ id: 'fixture-engine', version: '2.1' }));
  assert.equal(provider.engineDescriptor.id, 'fixture-engine');
  assert.equal(provider.engineDescriptor.version, '2.1');
  assert.equal(provider.descriptor().id, 'emulator:fixture-engine');
});
