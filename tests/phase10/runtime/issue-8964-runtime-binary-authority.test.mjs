import assert from 'node:assert/strict';
import test from 'node:test';

import { resetAppRuntime, runtimeIdentityForApp } from '../../../js/runtime/app-runtime.js';

const FNV_KEY = 'fnv1a64:1000:0123456789abcdef';
const STRONG_SHA256 = 'a'.repeat(64);
const STRONG_BINARY_ID = `bin_sha256_${'b'.repeat(64)}`;

function makeApp({ fileToken = {}, backend = {} } = {}) {
  const info = {
    name: 'fixture-8964.bin',
    slices: [{ info: { uuid: '8964-UUID', architecture: 'arm64' } }],
    ...fileToken,
  };
  const app = {
    store: {
      get(key) {
        if (key === 'fileInfo') return info;
        if (key === 'file') return backend.file ?? null;
        if (key === 'sliceIndex') return 0;
        if (key === 'architecture') return 'arm64';
        if (key === 'capability') return { architecture: 'arm64' };
        if (key === 'regions') return [{ id: 'region-0', exec: true, vmAddr: 0x1000n, size: 4n }];
        return null;
      },
    },
    backend: {
      file: { id: 'file-8964' },
      gen: 1,
      transportEpoch: 1,
      async readAt() { return { found: false, bytes: null }; },
      async fetchChunk() { return { mn: ['ret'], ops: [''] }; },
      ...backend,
    },
    symbols: null,
  };
  return app;
}

test('#8964 the platform FNV-1a64 content-hash cache key cannot become runtime binary authority', async () => {
  const app = makeApp({
    fileToken: { hash: FNV_KEY },
    backend: { contentHash: FNV_KEY, async ensureContentHash() { return FNV_KEY; } },
  });
  try {
    const identity = await runtimeIdentityForApp(app);
    assert.equal(identity.contentHash, null, 'a non-collision-resistant cache key must not be published as a binary identity');
    assert.match(identity.key, /^unhashed\|/, 'the runtime identity must stay explicitly unresolved instead of laundering the FNV key');
  } finally {
    resetAppRuntime(app);
  }
});

test('#8964 two byte-distinct binaries that collide on the same FNV key share no binary authority', async () => {
  const first = makeApp({ fileToken: { hash: FNV_KEY }, backend: { contentHash: FNV_KEY, async ensureContentHash() { return FNV_KEY; } } });
  const second = makeApp({ fileToken: { hash: FNV_KEY }, backend: { contentHash: FNV_KEY, async ensureContentHash() { return FNV_KEY; } } });
  try {
    assert.equal((await runtimeIdentityForApp(first)).contentHash, null);
    assert.equal((await runtimeIdentityForApp(second)).contentHash, null);
  } finally {
    resetAppRuntime(first);
    resetAppRuntime(second);
  }
});

test('#8964 an exact SHA-256 witness outranks the generic weak hash field', async () => {
  const app = makeApp({
    fileToken: { hash: FNV_KEY, sha256: STRONG_SHA256 },
    backend: { contentHash: FNV_KEY, async ensureContentHash() { return FNV_KEY; } },
  });
  try {
    const identity = await runtimeIdentityForApp(app);
    assert.equal(identity.contentHash, STRONG_SHA256, 'an existing strong digest must never be shadowed by the cache key');
    assert.equal(identity.key, `${STRONG_SHA256}|${identity.sliceIdentity}`);
  } finally {
    resetAppRuntime(app);
  }
});

test('#8964 the backend exact binary id is used instead of the FNV content-hash fallback', async () => {
  let contentHashCalls = 0;
  const app = makeApp({
    backend: {
      async ensureBinaryId() { return STRONG_BINARY_ID; },
      async ensureContentHash() { contentHashCalls += 1; return FNV_KEY; },
    },
  });
  try {
    const identity = await runtimeIdentityForApp(app);
    assert.equal(identity.contentHash, STRONG_BINARY_ID);
    assert.equal(contentHashCalls, 0, 'a strong binary id must be preferred over the cache-key computation');
  } finally {
    resetAppRuntime(app);
  }
});

test('#8964 a non-FNV content hash keeps working so only the cache-key shape is barred', async () => {
  const app = makeApp({
    fileToken: { hash: 'legacy-witness-8964' },
    backend: { contentHash: 'legacy-witness-8964' },
  });
  try {
    const identity = await runtimeIdentityForApp(app);
    assert.equal(identity.contentHash, 'legacy-witness-8964');
  } finally {
    resetAppRuntime(app);
  }
});
