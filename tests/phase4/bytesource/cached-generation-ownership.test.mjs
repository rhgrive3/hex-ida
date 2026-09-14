import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { CachedByteSource, ByteSourceCancelledError } from '../../../js/bytesource/cached.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('test deadline exceeded')), 500); }),
    ]);
  } finally { clearTimeout(timer); }
}
const cacheOptions = { pageSize: 4, maxCachedBytes: 8 };
const cases = [];
const check = (name, run) => cases.push({ name, run });

check('cached pages own bytes instead of retaining or aliasing a larger source buffer', async () => {
  const storage = new Uint8Array(1024 * 1024).fill(1);
  const cached = new CachedByteSource(storage, cacheOptions);
  const first = await cached.read(0n, 4);
  const page = cached.cache.get('0');
  assert.notEqual(page.buffer, storage.buffer, 'cached page must not retain the full source buffer');
  assert.equal(page.buffer.byteLength, 4, 'retained buffer size must match cache accounting');
  storage.fill(9, 0, 4);
  first.fill(7);
  assert.deepEqual([...await cached.read(0n, 4)], [1, 1, 1, 1], 'cached bytes are a stable page snapshot');
  cached.clear();
  assert.deepEqual([...await cached.read(0n, 4)], [9, 9, 9, 9], 'clear explicitly refreshes the snapshot');
});

check('reused Buffer storage cannot corrupt previously cached pages', async () => {
  const scratch = Buffer.alloc(4);
  const cached = new CachedByteSource({
    size: 8n,
    async read(offset) { scratch.fill(offset === 0n ? 1 : 2); return scratch; },
  }, cacheOptions);
  await cached.read(0n, 4);
  await cached.read(4n, 4);
  assert.deepEqual([...await cached.read(0n, 4)], [1, 1, 1, 1]);
  assert.deepEqual([...await cached.read(4n, 4)], [2, 2, 2, 2]);
});

check('clear invalidates a pending cache-hit continuation', async () => {
  const cached = new CachedByteSource(Uint8Array.of(1, 2, 3, 4), cacheOptions);
  await cached.read(0n, 4);
  const stale = cached.read(0n, 4);
  const rejected = assert.rejects(stale, ByteSourceCancelledError);
  cached.clear();
  await rejected;
  assert.equal(cached.memoryStats().bytesCached, 0);
});

check('clear rejects waiters even when the old backend never settles', async () => {
  const started = deferred();
  const release = deferred();
  let calls = 0;
  const cached = new CachedByteSource({
    size: 4n,
    async read() {
      if (++calls === 1) { started.resolve(); await release.promise; }
      return Uint8Array.of(4, 3, 2, 1);
    },
  }, cacheOptions);
  const stale = cached.read(0n, 4);
  const rejected = assert.rejects(stale, ByteSourceCancelledError);
  await started.promise;
  cached.clear();
  try {
    await bounded(rejected);
    assert.deepEqual([...await cached.read(0n, 4)], [4, 3, 2, 1]);
    assert.equal(calls, 2);
  } finally { release.resolve(); await stale.catch(() => {}); await rejected.catch(() => {}); }
});

check('clear detaches old entries before backend abort callbacks retry the same page', async () => {
  const started = deferred();
  let retry;
  let calls = 0;
  const cached = new CachedByteSource({
    size: 4n,
    async read(_offset, _length, { signal }) {
      if (++calls > 1) return Uint8Array.of(2, 2, 2, 2);
      started.resolve();
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          retry = cached.read(0n, 4);
          retry.catch(() => {});
          reject(signal.reason);
        }, { once: true });
      });
    },
  }, cacheOptions);
  const stale = cached.read(0n, 4).catch(() => {});
  await started.promise;
  cached.clear();
  await stale;
  assert.deepEqual([...await bounded(retry)], [2, 2, 2, 2]);
  assert.equal(calls, 2);
  assert.equal(cached.memoryStats().bytesCached, 4);
});

check('clear does not visit replacement entries started for a different page', async () => {
  const started = deferred();
  let retry;
  const signals = [];
  const cached = new CachedByteSource({
    size: 8n,
    async read(offset, _length, { signal }) {
      signals.push(signal);
      if (offset === 4n) return Uint8Array.of(5, 5, 5, 5);
      started.resolve();
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          retry = cached.read(4n, 4);
          retry.catch(() => {});
          reject(signal.reason);
        }, { once: true });
      });
    },
  }, cacheOptions);
  const stale = cached.read(0n, 4).catch(() => {});
  await started.promise;
  cached.clear();
  await stale;
  assert.deepEqual([...await bounded(retry)], [5, 5, 5, 5]);
  assert.equal(signals.length, 2);
  assert.equal(signals[1].aborted, false);
});

check('a synchronously reentrant backend joins the reserved producer', async () => {
  let nested;
  let calls = 0;
  const cached = new CachedByteSource({
    size: 4n,
    async read() {
      if (++calls === 1) { nested = cached.read(0n, 4); nested.catch(() => {}); }
      return Uint8Array.of(3, 3, 3, 3);
    },
  }, cacheOptions);
  const outer = await cached.read(0n, 4);
  assert.deepEqual([...outer], [3, 3, 3, 3]);
  assert.deepEqual([...await bounded(nested)], [3, 3, 3, 3]);
  assert.equal(calls, 1, 'reserve before invoking backend code');
});

check('abandoned listener setup never leaks an unhandled producer rejection', async () => {
  const moduleUrl = new URL('../../../js/bytesource/cached.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { CachedByteSource } from ${JSON.stringify(moduleUrl)};
    const setupError = new Error('listener setup failed');
    const cached = new CachedByteSource({ size:4n, async read() { throw new Error('backend failure'); } }, {pageSize:4});
    const signal = { aborted:false, addEventListener() { throw setupError; }, removeEventListener() {} };
    await assert.rejects(cached.read(0n, 4, {signal}), (error) => error === setupError);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(cached.memoryStats().pendingReads, 0);
  `], { timeout: 5_000, encoding: 'utf8' });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr || child.stdout);
});


check('clear inside a later page cannot return a mixed-generation multi-page result', async () => {
  let cleared = false;
  const bytes = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
  const cached = new CachedByteSource({
    size: 8n,
    async read(offset, length) {
      if (offset === 4n && !cleared) { cleared = true; cached.clear(); }
      return bytes.subarray(Number(offset), Number(offset) + length);
    },
  }, cacheOptions);
  await assert.rejects(cached.read(0n, 8), ByteSourceCancelledError);
  assert.equal(cached.memoryStats().pendingReads, 0);
  assert.deepEqual([...await cached.read(0n, 8)], [...bytes]);
});

check('a backend synchronously aborting its caller cannot orphan its own rejection', async () => {
  const moduleUrl = new URL('../../../js/bytesource/cached.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { CachedByteSource, ByteSourceCancelledError } from ${JSON.stringify(moduleUrl)};
    const controller = new AbortController();
    const cached = new CachedByteSource({
      size:4n,
      async read() { controller.abort(); throw new Error('backend failure after abort'); },
    }, {pageSize:4});
    await assert.rejects(cached.read(0n, 4, {signal:controller.signal}), ByteSourceCancelledError);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(cached.memoryStats().pendingReads, 0);
    assert.equal(cached.memoryStats().bytesCached, 0);
  `], { timeout: 5_000, encoding: 'utf8' });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

check('a throwing listener cleanup cannot hang or leak a completed consumer', async () => {
  const moduleUrl = new URL('../../../js/bytesource/cached.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { CachedByteSource } from ${JSON.stringify(moduleUrl)};
    const signal = { aborted:false, addEventListener() {}, removeEventListener() { throw new Error('cleanup failed'); } };
    const cached = new CachedByteSource(Uint8Array.of(1,2,3,4), {pageSize:4});
    const timer = setTimeout(() => { throw new Error('consumer did not settle'); }, 500);
    try { assert.deepEqual([...await cached.read(0n, 4, {signal})], [1,2,3,4]); }
    finally { clearTimeout(timer); }
    assert.equal(cached.memoryStats().pendingReads, 0);
  `], { timeout: 5_000, encoding: 'utf8' });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

check('257 consumers keep single-flight ownership while independently cancelling', async () => {
  const started = deferred();
  const release = deferred();
  let calls = 0;
  let backendSignal;
  const cached = new CachedByteSource({
    size: 4n,
    async read(_offset, _length, { signal }) {
      calls++;
      backendSignal = signal;
      started.resolve();
      await release.promise;
      return Uint8Array.of(1, 2, 3, 4);
    },
  }, cacheOptions);
  const controllers = Array.from({ length: 257 }, () => new AbortController());
  const consumers = controllers.map(({ signal }) => cached.read(0n, 4, { signal }).then(
    (bytes) => ({ bytes: [...bytes] }),
    (error) => ({ error }),
  ));
  await started.promise;
  controllers.forEach((controller, i) => { if (i % 3 === 0) controller.abort(); });
  assert.equal(backendSignal.aborted, false);
  release.resolve();
  const results = await Promise.all(consumers);
  for (let i = 0; i < results.length; i++) {
    if (i % 3 === 0) assert.ok(results[i].error instanceof ByteSourceCancelledError);
    else assert.deepEqual(results[i].bytes, [1, 2, 3, 4]);
  }
  assert.equal(calls, 1);
  assert.equal(cached.memoryStats().pendingReads, 0);
  assert.equal(cached.memoryStats().bytesCached, 4);
});

for (const revocation of ['clear', 'abort']) {
  check(`readExactly observes ${revocation} between a warm read and its own publication`, async () => {
    const cached = new CachedByteSource(Uint8Array.of(1, 2, 3, 4), cacheOptions);
    await cached.read(0n, 4);
    const controller = new AbortController();
    const pending = cached.readExactly(0n, 4, { signal: controller.signal });
    // A warm read resumes first; this microtask runs before readExactly resumes.
    queueMicrotask(() => { if (revocation === 'clear') cached.clear(); else controller.abort(); });
    await assert.rejects(pending, ByteSourceCancelledError);
    assert.deepEqual([...await cached.readExactly(0n, 4)], [1, 2, 3, 4]);
  });
}

check('cold read and readExactly preserve synchronous backend startup', async () => {
  for (const method of ['read', 'readExactly']) {
    let started = false;
    const cached = new CachedByteSource({
      size: 4n,
      async read() { started = true; return Uint8Array.of(1, 2, 3, 4); },
    }, cacheOptions);
    const pending = cached[method](0n, 4);
    assert.equal(started, true, `${method} must initiate backend I/O before returning`);
    assert.deepEqual([...await pending], [1, 2, 3, 4]);
  }
});

const failures = [];
for (const { name, run } of cases) {
  try { await run(); console.log(`PASS cached-generation-ownership: ${name}`); }
  catch (error) {
    failures.push(error);
    console.error(`FAIL cached-generation-ownership: ${name}\n${error.stack}`);
  }
  await turn();
}
if (failures.length) throw new AggregateError(failures, `cached-generation-ownership: ${failures.length}/${cases.length} failed`);
console.log(`cached-generation-ownership: PASS (${cases.length} cases)`);
