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

const canonicalStore = new ArtifactStore({
  backend:new MemoryArtifactBackend(),
  hotCache:new ArtifactHotCache(),
});
assert.equal(canonicalStore.capabilities().persistent, false);
await canonicalStore.close();

console.log('issue-5063-artifact-store-hook-contract: PASS');
