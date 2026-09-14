import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, webcrypto } from 'node:crypto';
import { hashByteSource, sha256TreeByteSource } from '../../../js/platform/hash.js';
import { MemoryByteSource } from '../../../js/binary/source.js';
import { CachedByteSource } from '../../../js/bytesource/cached.js';

async function withDigestHook(hook, run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  let calls = 0;
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { subtle: { async digest(algorithm, bytes) {
      const result = await webcrypto.subtle.digest(algorithm, bytes);
      hook(++calls);
      return result;
    } } },
  });
  try { await run(() => calls); }
  finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else delete globalThis.crypto;
  }
}
const isHashAbort = (error) => error?.name === 'AbortError' && error?.code === 'ABORT_ERR';
const fixture = Uint8Array.of(1, 2, 3, 4);

test('FNV cannot return an identity after the final progress callback cancels it', async () => {
  const controller = new AbortController();
  await assert.rejects(hashByteSource(fixture, {
    signal: controller.signal,
    onProgress() { controller.abort(); },
  }), isHashAbort);
});

test('SHA-256 final progress cancellation prevents even the first digest', async () => {
  const controller = new AbortController();
  await withDigestHook(() => {}, async (calls) => {
    await assert.rejects(sha256TreeByteSource(fixture, {
      signal: controller.signal,
      onProgress() { controller.abort(); },
    }), isHashAbort);
    assert.equal(calls(), 0);
  });
});

test('SHA-256 cancellation during the final leaf cannot start a root digest', async () => {
  const controller = new AbortController();
  await withDigestHook((call) => { if (call === 1) controller.abort(); }, async (calls) => {
    await assert.rejects(sha256TreeByteSource(fixture, { signal: controller.signal }), isHashAbort);
    assert.equal(calls(), 1);
  });
});

for (const bytes of [new Uint8Array(0), fixture]) {
  test(`SHA-256 root cancellation cannot publish an identity (${bytes.length} bytes)`, async () => {
    const controller = new AbortController();
    const rootCall = bytes.length ? 2 : 1;
    await withDigestHook((call) => { if (call === rootCall) controller.abort(); }, async (calls) => {
      await assert.rejects(sha256TreeByteSource(bytes, { signal: controller.signal }), isHashAbort);
      assert.equal(calls(), rootCall);
    });
  });
}

test('SHA-256 assembly cancellation stops at the last admitted read', async () => {
  const controller = new AbortController();
  const progress = [];
  await withDigestHook(() => {}, async (calls) => {
    await assert.rejects(sha256TreeByteSource(new MemoryByteSource(fixture, { maxReadLength: 2 }), {
      signal: controller.signal,
      onProgress({ done }) {
        progress.push(done);
        if (done === 4n) controller.abort();
      },
    }), isHashAbort);
    assert.deepEqual(progress, [2n, 4n]);
    assert.equal(calls(), 0);
  });
});

test('one hash consumer cancelling does not cancel another cache-backed consumer', async () => {
  const controller = new AbortController();
  const cache = new CachedByteSource(fixture, { pageSize: 2, maxCachedBytes: 4 });
  const failed = hashByteSource(cache, { signal: controller.signal, onProgress() { controller.abort(); } });
  const rejected = assert.rejects(failed, isHashAbort);
  const survivor = hashByteSource(cache);
  await rejected;
  assert.equal(await survivor, await hashByteSource(fixture));
  assert.equal(cache.memoryStats().pendingReads, 0);
});

function independentFnv(bytes) {
  let value = 0xcbf29ce484222325n;
  for (const byte of bytes) value = BigInt.asUintN(64, (value ^ BigInt(byte)) * 0x100000001b3n);
  return `fnv1a64:${bytes.length.toString(16)}:${value.toString(16).padStart(16, '0')}`;
}
function independentTree(bytes, leafSize) {
  const leaves = [];
  for (let offset = 0; offset < bytes.length; offset += leafSize) {
    leaves.push(createHash('sha256').update(bytes.subarray(offset, offset + leafSize)).digest());
  }
  const header = Buffer.from(`hex-sha256-tree-v2\0${bytes.length}\0${leafSize}\0${leaves.length}\0`);
  const digest = createHash('sha256').update(Buffer.concat([header, ...leaves])).digest('hex');
  return `sha256tree:v2:${bytes.length.toString(16)}:${digest}`;
}

test('uncancelled identities retain their original algorithms and fixed-leaf domain', async () => {
  let cases = 0;
  for (const length of [0, 1, 7, 32, 65, 257]) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 73 + length) & 255);
    for (const chunkSize of [3, 17, 64]) {
      const fnv = independentFnv(bytes);
      const tree = independentTree(bytes, chunkSize);
      for (const maxReadLength of [1, 2, 11, 512]) {
        const source = new MemoryByteSource(bytes, { maxReadLength });
        assert.equal(await hashByteSource(source, { chunkSize }), fnv);
        assert.equal(await sha256TreeByteSource(source, { chunkSize }), tree);
        cases++;
      }
    }
  }
  assert.equal(cases, 72);
});
