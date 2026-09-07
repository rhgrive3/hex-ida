import assert from 'node:assert/strict';
import { MemoryByteSource } from '../../js/binary/source.js';
import { hashByteSource, sha256TreeByteSource } from '../../js/platform/hash.js';

const bytes = Uint8Array.of(1, 2, 3, 4, 5);
const source = () => new MemoryByteSource(bytes, { maxReadLength: 2 });
const expectedFnv = await hashByteSource(source(), { chunkSize: 2 });
const expectedTree = await sha256TreeByteSource(source(), { chunkSize: 2 });

class ProgressCallback {}
class WrappedProgressCallback {}
const proxyWrappedClass = new Proxy(WrappedProgressCallback, {});
for (const onProgress of [
  undefined, null, true, false, {}, [], 1, 0, '', 'progress', Symbol('progress'),
  ProgressCallback, class {}, proxyWrappedClass,
]) {
  assert.equal(await hashByteSource(source(), { chunkSize: 2, onProgress }), expectedFnv);
  assert.equal(await sha256TreeByteSource(source(), { chunkSize: 2, onProgress }), expectedTree);
}

const expectedProgress = [
  { done: 2n, total: 5n },
  { done: 4n, total: 5n },
  { done: 5n, total: 5n },
];

const fnvProgress = [];
assert.equal(
  await hashByteSource(source(), { chunkSize: 2, onProgress: (value) => fnvProgress.push(value) }),
  expectedFnv,
);
assert.deepEqual(fnvProgress, expectedProgress);

const treeProgress = [];
assert.equal(
  await sha256TreeByteSource(source(), { chunkSize: 2, onProgress: (value) => treeProgress.push(value) }),
  expectedTree,
);
assert.deepEqual(treeProgress, expectedProgress);

for (const hash of [hashByteSource, sha256TreeByteSource]) {
  const boundEvents = [];
  function progress(value) {
    boundEvents.push(value);
  }
  const boundProgress = progress.bind({ ignored: true });
  assert.equal(
    await hash(source(), { chunkSize: 2, onProgress: boundProgress }),
    hash === hashByteSource ? expectedFnv : expectedTree,
  );
  assert.deepEqual(boundEvents, expectedProgress, 'bound ordinary callbacks remain valid callbacks');

  const lockedPrototypeEvents = [];
  function lockedPrototypeProgress(value) {
    lockedPrototypeEvents.push(value);
  }
  Object.defineProperty(lockedPrototypeProgress, 'prototype', { writable: false });
  assert.equal(
    await hash(source(), { chunkSize: 2, onProgress: lockedPrototypeProgress }),
    hash === hashByteSource ? expectedFnv : expectedTree,
  );
  assert.deepEqual(
    lockedPrototypeEvents,
    expectedProgress,
    'ordinary callbacks remain valid when their own prototype is non-writable',
  );

  const boundCallbackError = new Error('bound progress callback failure');
  const throwingBoundProgress = function throwingProgress() {
    throw boundCallbackError;
  }.bind(null);
  await assert.rejects(
    hash(source(), { chunkSize: 2, onProgress: throwingBoundProgress }),
    (error) => error === boundCallbackError,
  );

  const classLikeCallbackError = new TypeError("Class constructor X cannot be invoked without 'new'");
  const throwingClassLikeBoundProgress = function throwingProgress() {
    throw classLikeCallbackError;
  }.bind(null);
  await assert.rejects(
    hash(source(), { chunkSize: 2, onProgress: throwingClassLikeBoundProgress }),
    (error) => error === classLikeCallbackError,
  );

  const boundClass = WrappedProgressCallback.bind(null);
  await assert.rejects(
    hash(source(), { chunkSize: 2, onProgress: boundClass }),
    (error) => error instanceof TypeError && /cannot be invoked without ['"]new['"]/.test(error.message),
  );

  await assert.rejects(
    hash(source(), { chunkSize: 0 }),
    /chunkSize must be a positive safe integer/,
  );

  const events = [];
  const options = { chunkSize: 2, onProgress(value) {
    assert.equal(this, options);
    events.push(value);
  } };
  options.onProgress.call = null;
  assert.equal(await hash(source(), options), hash === hashByteSource ? expectedFnv : expectedTree);
  assert.deepEqual(events, expectedProgress);

  const proxiedEvents = [];
  const proxiedOptions = { chunkSize: 2 };
  proxiedOptions.onProgress = new Proxy(function onProgress(value) {
    assert.equal(this, proxiedOptions);
    proxiedEvents.push(value);
  }, {});
  assert.equal(await hash(source(), proxiedOptions), hash === hashByteSource ? expectedFnv : expectedTree);
  assert.deepEqual(proxiedEvents, expectedProgress, 'ordinary callable proxies remain valid callbacks');

  const callbackError = new Error('progress callback failure');
  await assert.rejects(
    hash(source(), { chunkSize: 2, onProgress() { throw callbackError; } }),
    (error) => error === callbackError,
  );
  let emptyCallbacks = 0;
  await hash(new MemoryByteSource(new Uint8Array()), { onProgress() { emptyCallbacks++; } });
  assert.equal(emptyCallbacks, 0, 'empty sources must not synthesize progress callbacks');

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    hash(source(), { chunkSize: 2, signal: controller.signal }),
    (error) => error?.name === 'AbortError' && error?.code === 'ABORT_ERR',
  );
}

console.log('issue-3857-platform-hash-progress: PASS');
