import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeModuleBindingTable } from '../../../js/runtime/provider-identity.js';

function binding(overrides = {}) {
  return {
    bindingKey: 'main',
    runtimeBase: 0x1000n,
    runtimeSize: 0x100n,
    staticBase: 0x4000n,
    binaryId: 'binary-A',
    identityState: 'exact',
    loadedSequence: 1,
    ...overrides,
  };
}

function assertCode(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

test('load rejects bindings that already declare an unload sequence (#4627)', () => {
  const table = new RuntimeModuleBindingTable('session:4627');

  assert.throws(
    () => table.load(binding({ unloadedSequence: 2 })),
    assertCode('invalid-module-sequence'),
  );
  assert.equal(table.active().length, 0);
  assert.equal(table.history().length, 0);
  assert.equal(table.resolve(0x1010n, { binaryId: 'binary-A' }).state, 'unresolved');

  const loaded = table.load(binding());
  assert.equal(loaded.generation, 1, 'rejected pre-unloaded input must not consume a generation');
});

test('zero and structured unloadedSequence values cannot enter active authority (#4627)', () => {
  for (const unloadedSequence of [0, {}, [2]]) {
    const table = new RuntimeModuleBindingTable('session:4627');
    assert.throws(
      () => table.load(binding({ unloadedSequence })),
      assertCode('invalid-module-sequence'),
    );
    assert.deepEqual(table.active(), []);
    assert.deepEqual(table.history(), []);
  }
});

test('load snapshots unloadedSequence once before committing active state (#4627)', () => {
  const table = new RuntimeModuleBindingTable('session:4627');
  let reads = 0;
  const input = binding();
  Object.defineProperty(input, 'unloadedSequence', {
    enumerable: true,
    get() {
      reads += 1;
      return 2;
    },
  });

  assert.throws(() => table.load(input), assertCode('invalid-module-sequence'));
  assert.equal(reads, 1);
  assert.equal(table.active().length, 0);
});

test('normal load, unload, and same-key reload preserve active generations (#4627)', () => {
  const table = new RuntimeModuleBindingTable('session:4627');
  const first = table.load(binding());

  assert.equal(first.generation, 1);
  assert.equal(table.active().length, 1);
  const firstResolution = table.resolve(0x1010n, { binaryId: 'binary-A' });
  assert.equal(firstResolution.state, 'exact');
  assert.equal(firstResolution.staticAddress, 0x4010n);

  const retired = table.unload('main', 2);
  assert.equal(retired.unloadedSequence, 2);
  assert.equal(table.active().length, 0);
  const retiredResolution = table.resolve(0x1010n, { binaryId: 'binary-A' });
  assert.equal(retiredResolution.state, 'unresolved');
  assert.equal(retiredResolution.method, 'no-active-module');

  const second = table.load(binding({
    runtimeBase: 0x2000n,
    staticBase: 0x5000n,
    loadedSequence: 3,
  }));
  assert.equal(second.generation, 2);
  assert.equal(table.active().length, 1);
  assert.equal(table.resolve(0x2010n, { binaryId: 'binary-A' }).staticAddress, 0x5010n);
});

test('active duplicate and unload ordering guards are preserved (#4627)', () => {
  const table = new RuntimeModuleBindingTable('session:4627');
  table.load(binding({ loadedSequence: 5 }));

  assert.throws(
    () => table.load(binding({ runtimeBase: 0x2000n })),
    assertCode('module-binding-already-loaded'),
  );
  assert.throws(
    () => table.unload('main', 4),
    assertCode('invalid-module-sequence'),
  );

  assert.equal(table.active().length, 1);
  assert.equal(table.active()[0].generation, 1);
});
