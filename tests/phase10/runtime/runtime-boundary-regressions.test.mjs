import assert from 'node:assert/strict';
import test from 'node:test';

import { runtimeIdentityForApp } from '../../../js/runtime/app-runtime.js';
import { MemoryRegion, RuntimeMemoryMap } from '../../../js/runtime/memory.js';

function appWithSliceIndex(sliceIndex) {
  const fileInfo = {
    hash: 'fixture:runtime-boundary',
    slices: [
      { info: { uuid: 'slice-0' }, capability: { architecture: 'arm64' } },
      { info: { uuid: 'slice-1' }, capability: { architecture: 'arm64e' } },
    ],
  };
  return {
    store: {
      get(key) {
        if (key === 'fileInfo') return fileInfo;
        if (key === 'sliceIndex') return sliceIndex;
        if (key === 'architecture') return 'unknown';
        return null;
      },
    },
  };
}

function appWithHash(hash, ensureContentHash = null) {
  return {
    store: {
      get(key) {
        if (key === 'fileInfo') return { hash, slices:[] };
        if (key === 'sliceIndex') return -1;
        if (key === 'architecture') return 'unknown';
        return null;
      },
    },
    backend: ensureContentHash ? { ensureContentHash } : null,
  };
}

test('P10 runtime app identity rejects coercive slice indexes (#1633)', async () => {
  for (const value of [false, true, '', '   ', NaN, Infinity, 1.5, [], {}]) {
    const identity = await runtimeIdentityForApp(appWithSliceIndex(value));
    assert.match(identity.sliceIdentity, /^slice:-1:/, `unexpected active slice for ${String(value)}`);
  }

  assert.match((await runtimeIdentityForApp(appWithSliceIndex(0))).sliceIdentity, /^slice:0:slice-0:arm64$/);
  assert.match((await runtimeIdentityForApp(appWithSliceIndex('1'))).sliceIdentity, /^slice:1:slice-1:arm64e$/);
});

test('P10 runtime app identity rejects non-string content hashes (#2714)', async () => {
  for (const value of [{ source:'A' }, { source:'B' }, [], 1, true, '   ']) {
    await assert.rejects(runtimeIdentityForApp(appWithHash(value)), /runtime binary identity is unavailable/);
  }

  const exact = await runtimeIdentityForApp(appWithHash('sha256:fixture'));
  assert.equal(exact.contentHash, 'sha256:fixture');
  assert.match(exact.key, /^sha256:fixture\|slice:-1:/);
});

test('P10 runtime app identity validates ensureContentHash results (#2714)', async () => {
  await assert.rejects(
    runtimeIdentityForApp(appWithHash(null, async () => ({ source:'backend' }))),
    /runtime binary identity is unavailable/,
  );
  const exact = await runtimeIdentityForApp(appWithHash(null, async () => 'sha256:backend'));
  assert.equal(exact.contentHash, 'sha256:backend');
});

test('P10 runtime memory rejects coercive size and maxTransfer inputs (#1634)', () => {
  for (const value of [true, false, '', '   ', [], {}, 1.5, NaN, Infinity]) {
    assert.throws(() => new MemoryRegion({ start: 0n, size: value }), /positive safe integer|invalid-size/);
    assert.throws(() => new RuntimeMemoryMap([], { maxTransfer: value }), /positive safe integer|invalid-size/);
  }

  const region = new MemoryRegion({ start: 0n, size: 8 });
  for (const value of [true, false, '', '   ', [], {}, 1.5, NaN, Infinity]) {
    assert.throws(() => region.contains(0n, value), /positive safe integer|invalid-size/);
  }

  const map = new RuntimeMemoryMap([{ start: 0n, size: 8 }]);
  for (const value of [true, false, '', '   ', [], {}, 1.5, NaN, Infinity]) {
    assert.throws(() => map.find(0n, value), /positive safe integer|invalid-size/);
  }

  assert.equal(region.contains(0n, 1), true);
  assert.equal(region.contains(0n, '1'), true);
  assert.equal(map.find(0n, 1)?.size, 8);
  assert.equal(map.find(0n, '1')?.size, 8);
});