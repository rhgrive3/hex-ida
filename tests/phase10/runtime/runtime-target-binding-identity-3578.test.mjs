import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeTargetBinding } from '../../../js/runtime/provider-identity.js';

const base = Object.freeze({ runtimeSessionId: 'session-1', providerId: 'debugger' });

for (const field of ['primaryBinaryId', 'primarySliceId']) {
  test(`P10 runtime target ${field} rejects identity coercion (#3578)`, () => {
    for (const bad of [{ a: 1 }, { b: 2 }, ['fixture-id'], 7, true, '', '   ']) {
      assert.throws(
        () => createRuntimeTargetBinding({ ...base, [field]: bad }),
        (error) => error?.code === 'invalid-runtime-identity'
          && error?.details?.name === field,
      );
    }
  });
}

test('P10 runtime target primary identities preserve valid strings and nullish values (#3578)', () => {
  const literal = createRuntimeTargetBinding({
    ...base,
    primaryBinaryId: '[object Object]',
    primarySliceId: 'fixture-slice',
  });
  assert.equal(literal.primaryBinaryId, '[object Object]');
  assert.equal(literal.primarySliceId, 'fixture-slice');

  const missing = createRuntimeTargetBinding(base);
  assert.equal(missing.primaryBinaryId, null);
  assert.equal(missing.primarySliceId, null);
});

test('P10 runtime target legacy identity aliases use the same strict boundary (#3578)', () => {
  const valid = createRuntimeTargetBinding({ ...base, binaryId: 'binary-A', sliceId: 'slice-A' });
  assert.equal(valid.primaryBinaryId, 'binary-A');
  assert.equal(valid.primarySliceId, 'slice-A');

  assert.throws(
    () => createRuntimeTargetBinding({ ...base, binaryId: { binary: 'A' } }),
    (error) => error?.code === 'invalid-runtime-identity'
      && error?.details?.name === 'primaryBinaryId',
  );
  assert.throws(
    () => createRuntimeTargetBinding({ ...base, sliceId: ['slice-A'] }),
    (error) => error?.code === 'invalid-runtime-identity'
      && error?.details?.name === 'primarySliceId',
  );
});

test('P10 runtime target non-identity metadata keeps existing coercion compatibility (#3578)', () => {
  const binding = createRuntimeTargetBinding({
    ...base,
    processKey: 7,
    platform: true,
    architecture: ['arm64'],
  });
  assert.equal(binding.processKey, '7');
  assert.equal(binding.platform, 'true');
  assert.equal(binding.architecture, 'arm64');
});
