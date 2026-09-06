import assert from 'node:assert/strict';
import { ArtifactHotCache, ArtifactStore } from '../../../js/core/artifacts/index.js';
import { artifactHotEntrySize } from '../../../js/core/artifacts/storage/integrity.js';
import { encodeArtifactPayload } from '../../../js/core/artifacts/contracts.js';
import { PersistentMemoryBackend, descriptor } from '../../../tests/phase4/store/support.mjs';

// The payload fits the budget, but the retained record plus payload does not.
// A payload-only cache admission would incorrectly make the next read a hot hit.
const entries = new Map();
const payload = { value:'payload-only-fit' };
const payloadBytes = encodeArtifactPayload(payload);
const maxBytes = payloadBytes.byteLength;
const store = new ArtifactStore({
  backend:new PersistentMemoryBackend({ entries }),
  hotCache:new ArtifactHotCache({ maxBytes, maxEntries:1 }),
});
const artifact = descriptor('payload-only-fit');
await store.publish(artifact, payload);

const raw = entries.get(artifact.artifactId);
const retainedBytes = artifactHotEntrySize(raw.record, raw.payload);
assert.equal(new Uint8Array(raw.payload).byteLength, payloadBytes.byteLength);
assert.ok(retainedBytes > maxBytes, 'the canonical record must count against the payload-sized budget');
assert.equal(store.stats().hotCache.entries, 0, 'full retained entry must be rejected when only payload fits');
assert.equal(store.stats().hotCache.bytes, 0);

const cold = await store.get(artifact);
assert.equal(cold.status, 'hit');
assert.equal(cold.source, 'persistent', 'payload-only accounting must not turn this read into a hot hit');
assert.equal(store.stats().hotCache.entries, 0);
assert.equal(store.stats().hotCache.bytes, 0);

console.log('T056 cache-accounting negative: PASS');
