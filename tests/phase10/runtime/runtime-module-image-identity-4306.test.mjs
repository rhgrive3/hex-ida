import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeAddressResolution, RuntimeModuleBindingTable } from '../../../js/runtime/provider-identity.js';

function baseBinding(imageId) {
  return {
    bindingKey: 'main',
    runtimeBase: 0x1000n,
    runtimeSize: 0x100n,
    staticBase: 0x2000n,
    binaryId: 'bin-A',
    imageId,
    identityState: 'exact',
  };
}

for (const imageId of [['image-A'], {}, 7, true, Object('image-A')]) {
  test(`P10.9 module binding rejects non-string imageId: ${Object.prototype.toString.call(imageId)}`, () => {
    const table = new RuntimeModuleBindingTable('runtime-session-4306');
    assert.throws(
      () => table.load(baseBinding(imageId)),
      (error) => error?.code === 'invalid-runtime-identity',
    );
    assert.equal(table.active().length, 0);
  });
}

test('P10.9 module binding preserves primitive-string and nullish imageId semantics', () => {
  const exact = new RuntimeModuleBindingTable('runtime-session-4306-string');
  const loaded = exact.load(baseBinding('image-A'));
  assert.equal(loaded.imageId, 'image-A');
  const resolved = exact.resolve(0x1010n, { binaryId: 'bin-A' });
  assert.equal(resolved.state, 'exact');
  assert.equal(resolved.imageId, 'image-A');

  const nullish = new RuntimeModuleBindingTable('runtime-session-4306-null');
  assert.equal(nullish.load(baseBinding(undefined)).imageId, null);
});

for (const imageId of [['image-A'], {}, 7, false, Object('image-A')]) {
  test(`P10.9 runtime address resolution rejects non-string imageId: ${Object.prototype.toString.call(imageId)}`, () => {
    assert.throws(
      () => createRuntimeAddressResolution({
        runtimeSessionId: 'runtime-session-4306-resolution',
        runtimeAddress: 0x1010n,
        staticAddress: 0x2010n,
        binaryId: 'bin-A',
        imageId,
        state: 'exact',
      }),
      (error) => error?.code === 'invalid-runtime-identity',
    );
  });
}

test('P10.9 runtime address resolution preserves string and nullish imageId', () => {
  const exact = createRuntimeAddressResolution({
    runtimeSessionId: 'runtime-session-4306-resolution',
    runtimeAddress: 0x1010n,
    staticAddress: 0x2010n,
    binaryId: 'bin-A',
    imageId: 'image-A',
    state: 'exact',
  });
  assert.equal(exact.imageId, 'image-A');
  assert.equal(exact.binaryId, 'bin-A');
  assert.equal(exact.sliceId, null);

  const unresolved = createRuntimeAddressResolution({
    runtimeSessionId: 'runtime-session-4306-resolution',
    runtimeAddress: 0x1010n,
    binaryId: 'bin-A',
    imageId: null,
    state: 'unresolved',
  });
  assert.equal(unresolved.imageId, null);
});
