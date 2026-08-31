import assert from 'node:assert/strict';
import { ArtifactStore, ArtifactHotCache, MemoryArtifactBackend } from '../../../js/core/artifacts/index.js';

const malformed = [
  ['artifact-A'],
  1,
  true,
  { toString(){ return 'artifact-A'; } },
];

const backend = new MemoryArtifactBackend();
for (const id of malformed) {
  await assert.rejects(() => backend.getRaw(id), /artifact-id-required/);
  await assert.rejects(() => backend.delete(id), /artifact-id-required/);
  await assert.rejects(() => backend.has(id), /artifact-id-required/);
}

const store = new ArtifactStore({ backend, hotCache:new ArtifactHotCache() });
for (const id of malformed) {
  await assert.rejects(() => store.get(id), /artifact-id-required/);
  await assert.rejects(() => store.delete(id), /artifact-id-required/);
  assert.throws(() => store.evictHot(id), /artifact-id-required/);
}

assert.equal((await store.get('missing-artifact')).status, 'miss');
console.log('phase4 strict artifact id boundaries: PASS');
