import assert from 'node:assert/strict';
import {
  MemoryArtifactBackend,
  createArtifactBackend,
} from '../../js/core/artifacts/backends.js';
import {
  createArtifactDescriptor,
  createArtifactRecord,
  encodeArtifactPayload,
} from '../../js/core/artifacts/contracts.js';

const expectedInvalidEntriesError = (error) =>
  error instanceof TypeError && error.message === 'artifact-memory-backend-entries-invalid';

for (const entries of [
  [],
  {},
  new Set(),
  { values() { return [][Symbol.iterator](); } },
  {
    get() {},
    set() {},
    delete() {},
    has() {},
    values() { return new Map().values(); },
    size:0,
  },
]) {
  assert.throws(
    () => new MemoryArtifactBackend({ entries }),
    expectedInvalidEntriesError,
    'non-Map entries must fail at the constructor boundary',
  );
}

assert.throws(
  () => createArtifactBackend({ indexedDB:null, memoryEntries:[] }),
  expectedInvalidEntriesError,
  'memory fallback must enforce the same entries contract',
);

const defaultBackend = new MemoryArtifactBackend();
assert.equal(defaultBackend.stats().entries, 0);
assert.equal(defaultBackend.stats().bytes, 0);

class DerivedMap extends Map {}
const derivedBackend = new MemoryArtifactBackend({ entries:new DerivedMap() });
assert.equal(derivedBackend.stats().entries, 0);

function fixture(num) {
  const descriptor = createArtifactDescriptor({
    binaryId:'bin_sha256_' + '1'.repeat(64),
    passId:'issue-4233',
    artifactKind:'test-kind',
    producerId:'issue-4233-test',
    loaderVersion:'1.0.0',
    architectureSemanticVersion:'1.0.0',
    abiSemanticVersion:'1.0.0',
    semanticSchemaVersion:'1.0.0',
    config:{ num },
  });
  const payloadBytes = encodeArtifactPayload({ issue:4233, num });
  const record = createArtifactRecord(descriptor, payloadBytes, { completeness:'complete' });
  return { record, payloadBytes };
}

const first = fixture(1);
const seed = new MemoryArtifactBackend();
await seed.putAtomic(first.record, first.payloadBytes);
const preloadedEntries = new Map(seed.entries);
const backend = new MemoryArtifactBackend({ entries:preloadedEntries });

assert.equal(backend.stats().entries, 1);
assert.equal(backend.stats().bytes, first.payloadBytes.byteLength);
assert.equal(await backend.has(first.record.artifactId), true);
assert.deepEqual(
  [...(await backend.getRaw(first.record.artifactId)).payload],
  [...first.payloadBytes],
);

const second = fixture(2);
const published = await backend.putAtomic(second.record, second.payloadBytes);
assert.equal(published.duplicate, false);
assert.equal(await backend.has(second.record.artifactId), true);
assert.equal(backend.stats().entries, 2);
assert.equal(
  backend.stats().bytes,
  first.payloadBytes.byteLength + second.payloadBytes.byteLength,
);

assert.equal(await backend.delete(first.record.artifactId), true);
assert.equal(await backend.has(first.record.artifactId), false);
assert.equal(backend.stats().entries, 1);
assert.equal(backend.stats().bytes, second.payloadBytes.byteLength);

const fallback = createArtifactBackend({
  indexedDB:null,
  memoryEntries:new Map(),
});
assert.ok(fallback instanceof MemoryArtifactBackend);
assert.equal(fallback.stats().entries, 0);

console.log('issue-4233 memory artifact backend entries: PASS');
