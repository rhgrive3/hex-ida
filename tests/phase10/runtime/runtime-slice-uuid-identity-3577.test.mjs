import assert from 'node:assert/strict';
import test from 'node:test';

import { runtimeIdentityForApp } from '../../../js/runtime/app-runtime.js';

function makeApp(uuid, { omitUuid = false } = {}) {
  const info = {
    hash: 'same-binary',
    slices: [{
      info: {
        architecture: 'arm64',
        ...(omitUuid ? {} : { uuid }),
      },
    }],
  };
  const values = new Map([
    ['fileInfo', info],
    ['sliceIndex', 0],
  ]);
  return {
    store: { get: (key) => values.get(key) },
    backend: {},
  };
}

test('P10 runtime slice UUID rejects structured identity coercion (#3577)', async () => {
  for (const bad of [{ a: 1 }, { b: 2 }, ['fixture-slice'], 7, true, '']) {
    await assert.rejects(
      () => runtimeIdentityForApp(makeApp(bad)),
      (error) => error instanceof TypeError && error.message === 'runtime-slice-uuid-invalid',
    );
  }
});

test('P10 runtime slice UUID preserves existing non-empty string identities (#3577)', async () => {
  for (const uuid of ['fixture-slice', '[object Object]', '01234567-89ab-cdef-0123-456789abcdef']) {
    const identity = await runtimeIdentityForApp(makeApp(uuid));
    assert.equal(identity.sliceIdentity, `slice:0:${uuid}:arm64`);
    assert.equal(identity.key, `same-binary|slice:0:${uuid}:arm64`);
  }
});

test('P10 runtime slice UUID keeps the existing missing-UUID marker (#3577)', async () => {
  const omitted = await runtimeIdentityForApp(makeApp(undefined, { omitUuid: true }));
  const nullUuid = await runtimeIdentityForApp(makeApp(null));
  assert.equal(omitted.sliceIdentity, 'slice:0:-:arm64');
  assert.equal(nullUuid.sliceIdentity, 'slice:0:-:arm64');
});
