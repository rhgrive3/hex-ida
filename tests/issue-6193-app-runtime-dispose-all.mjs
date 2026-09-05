import assert from 'node:assert/strict';
import { runtimePlatformForApp, resetAppRuntime } from '../js/runtime/app-runtime.js';

function makeApp(hash) {
  return {
    store: {
      get: (key) => {
        if (key === 'fileInfo') return { hash, slices: [] };
        if (key === 'sliceIndex') return -1;
        if (key === 'regions') return [];
        return null;
      },
    },
    get project() { return { binaryHash: hash }; },
    backend: {
      readAt: async () => ({ found: false }),
      fetchChunk: async () => ({}),
      get contentHash() { return hash; },
    },
    symbols: { nameAt: () => null, label: () => null },
  };
}

// 1 session reset closes it.
{
  const app = makeApp('single-6193');
  const platform = await runtimePlatformForApp(app);
  const current = platform.sessions.current;
  assert.ok(current);
  await resetAppRuntime(app);
  assert.equal(current.closed, true);
}

// local + symbolic both closed regardless of current.
for (const switchToLocal of [false, true]) {
  const app = makeApp(`two-6193-${switchToLocal}`);
  const platform = await runtimePlatformForApp(app);
  const local = platform.sessions.current;
  const symbolic = await platform.startSession({ adapter: 'symbolic', binaryHash: local.binaryHash, connect: false });
  assert.equal(platform.sessions.sessions.size, 2);
  if (switchToLocal) platform.sessions.switch(local.id);
  await resetAppRuntime(app);
  assert.equal(local.closed, true);
  assert.equal(symbolic.closed, true);
  assert.equal(platform.sessions.sessions.size, 0);
}

// One disconnect throwing must not stop the other cleanup.
{
  const app = makeApp('throw-6193');
  const platform = await runtimePlatformForApp(app);
  const local = platform.sessions.current;
  const symbolic = await platform.startSession({ adapter: 'symbolic', binaryHash: local.binaryHash, connect: false });
  local.adapter.disconnect = async () => { throw new Error('disconnect boom'); };
  await resetAppRuntime(app);
  assert.equal(local.closed, true);
  assert.equal(symbolic.closed, true);
  assert.equal(platform.sessions.sessions.size, 0);
}

// Identity change closes old platform sessions and builds fresh state.
{
  let hash = 'old-6193';
  const app = {
    store: {
      get: (key) => {
        if (key === 'fileInfo') return { hash, slices: [] };
        if (key === 'sliceIndex') return -1;
        if (key === 'regions') return [];
        return null;
      },
    },
    get project() { return { binaryHash: hash }; },
    backend: {
      readAt: async () => ({ found: false }),
      fetchChunk: async () => ({}),
      get contentHash() { return hash; },
    },
    symbols: { nameAt: () => null, label: () => null },
  };
  const oldPlatform = await runtimePlatformForApp(app);
  const oldLocal = oldPlatform.sessions.current;
  const oldSymbolic = await oldPlatform.startSession({ adapter: 'symbolic', binaryHash: oldLocal.binaryHash, connect: false });
  hash = 'new-6193';
  const newPlatform = await runtimePlatformForApp(app);
  assert.equal(oldLocal.closed, true);
  assert.equal(oldSymbolic.closed, true);
  assert.notEqual(newPlatform, oldPlatform);
  assert.equal(newPlatform.sessions.sessions.size, 1);
  await resetAppRuntime(app);
}

console.log('issue-6193: PASS');
