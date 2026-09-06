import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeModuleBindingTable } from '../../../js/runtime/provider-identity.js';

function loadModule(loadedSequence = null) {
  const table = new RuntimeModuleBindingTable('runtime-session-4258');
  const binding = table.load({
    bindingKey: 'module',
    runtimeBase: 0x1000n,
    runtimeSize: 0x100n,
    loadedSequence,
  });
  return { table, binding };
}

for (const bad of ['10', '010', '+10', ' 10 ', ['10'], true, 10n, {}]) {
  test(`P10.9 module load rejects coerced sequence ${String(bad)}`, () => {
    assert.throws(() => loadModule(bad), /invalid-sequence/);
  });

  test(`P10.9 module unload rejects coerced sequence ${String(bad)}`, () => {
    const { table, binding } = loadModule(10);
    assert.throws(() => table.unload(binding.bindingKey, bad), /invalid-sequence/);
    assert.equal(table.get(binding.bindingKey), binding);
  });
}

test('P10.9 module sequence accepts canonical primitive safe integers and nullish values', () => {
  const { table, binding } = loadModule(10);
  assert.equal(binding.loadedSequence, 10);
  const retired = table.unload(binding.bindingKey, 11);
  assert.equal(retired.unloadedSequence, 11);

  const withoutSequence = loadModule(null).binding;
  assert.equal(withoutSequence.loadedSequence, null);
});

test('P10.9 module sequence preserves numeric range and ordering validation', () => {
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => loadModule(bad), /invalid-sequence/);
  }

  const { table, binding } = loadModule(10);
  assert.throws(() => table.unload(binding.bindingKey, 9), /invalid-module-sequence/);
  assert.equal(table.get(binding.bindingKey), binding);
});
