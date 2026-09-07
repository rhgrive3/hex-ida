import assert from 'node:assert/strict';
import {
  ArtifactHotCache,
  ArtifactStore,
  MemoryArtifactBackend,
} from '../../js/core/artifacts/index.js';

function validBackend() {
  return {
    capabilities() { return Object.freeze({ backend:'test', persistent:false }); },
    async getRaw() { return null; },
    async putAtomic() { throw new Error('unused'); },
    async delete() { return false; },
    async close() {},
  };
}

function validHotCache() {
  return {
    get() { return null; },
    put() { return true; },
    delete() { return false; },
    clear() {},
    stats() { return Object.freeze({}); },
  };
}

const backendInvalid = (hook, value) => {
  const backend = validBackend();
  backend[hook] = value;
  assert.throws(
    () => new ArtifactStore({ backend, hotCache:validHotCache() }),
    (error) => error instanceof TypeError && error.message === 'artifact-backend-invalid',
    `backend hook ${hook} must fail at construction`,
  );
};

const hotCacheInvalid = (hook, value) => {
  const hotCache = validHotCache();
  hotCache[hook] = value;
  assert.throws(
    () => new ArtifactStore({ backend:validBackend(), hotCache }),
    (error) => error instanceof TypeError && error.message === 'artifact-hot-cache-invalid',
    `hot-cache hook ${hook} must fail at construction`,
  );
};

for (const [hook, value] of [
  ['getRaw', true],
  ['putAtomic', {}],
  ['delete', []],
  ['capabilities', 'yes'],
  ['close', 1],
]) backendInvalid(hook, value);

for (const [hook, value] of [
  ['get', true],
  ['put', {}],
  ['delete', []],
  ['clear', 'yes'],
  ['stats', 1],
]) hotCacheInvalid(hook, value);

assert.doesNotThrow(() => new ArtifactStore({ backend:validBackend(), hotCache:validHotCache() }));

const optionalHooksAbsent = validBackend();
delete optionalHooksAbsent.deleteIfMatches;
delete optionalHooksAbsent.stats;
assert.doesNotThrow(() => new ArtifactStore({ backend:optionalHooksAbsent, hotCache:validHotCache() }));

{
  const backend = validBackend();
  let reads = 0;
  Object.defineProperty(backend, 'getRaw', {
    configurable:true,
    get() {
      reads++;
      if (reads !== 1) return true;
      return async function getRaw() {
        assert.equal(this, backend, 'snapshotted backend hook must preserve receiver semantics');
        return null;
      };
    },
  });
  const store = new ArtifactStore({ backend, hotCache:validHotCache() });
  assert.equal(reads, 1, 'required backend hook must be read exactly once at construction');
  assert.equal((await store.get('snapshot-backend-hook')).status, 'miss');
  assert.equal(reads, 1, 'backend use must call the validated snapshot instead of rereading the property');
  await store.close();
}

{
  const hotCache = validHotCache();
  let reads = 0;
  Object.defineProperty(hotCache, 'get', {
    configurable:true,
    get() {
      reads++;
      if (reads !== 1) return true;
      return function get() {
        assert.equal(this, hotCache, 'snapshotted hot-cache hook must preserve receiver semantics');
        return null;
      };
    },
  });
  const store = new ArtifactStore({ backend:validBackend(), hotCache });
  assert.equal(reads, 1, 'required hot-cache hook must be read exactly once at construction');
  assert.equal((await store.get('snapshot-hot-cache-hook')).status, 'miss');
  assert.equal(reads, 1, 'hot-cache use must call the validated snapshot instead of rereading the property');
  await store.close();
}

for (const [target, hook, errorMessage] of [
  [validBackend(), 'getRaw', 'artifact-backend-invalid'],
  [validHotCache(), 'get', 'artifact-hot-cache-invalid'],
]) {
  Object.defineProperty(target, hook, {
    configurable:true,
    get() { throw new Error('hostile-hook-getter'); },
  });
  assert.throws(
    () => new ArtifactStore({
      backend:errorMessage === 'artifact-backend-invalid' ? target : validBackend(),
      hotCache:errorMessage === 'artifact-hot-cache-invalid' ? target : validHotCache(),
    }),
    (error) => error instanceof TypeError && error.message === errorMessage,
    `${hook} getter failures must normalize to ${errorMessage}`,
  );
}

const canonicalStore = new ArtifactStore({
  backend:new MemoryArtifactBackend(),
  hotCache:new ArtifactHotCache(),
});
assert.equal(canonicalStore.capabilities().persistent, false);
await canonicalStore.close();

console.log('issue-5063-artifact-store-hook-contract: PASS');
