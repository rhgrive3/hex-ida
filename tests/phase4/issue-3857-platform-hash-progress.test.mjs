import assert from 'node:assert/strict';
import { MemoryByteSource } from '../../js/binary/source.js';
import { createProgressCallback, hashByteSource, sha256TreeByteSource } from '../../js/platform/hash.js';

const bytes = Uint8Array.of(1, 2, 3, 4, 5);
const source = () => new MemoryByteSource(bytes, { maxReadLength: 2 });
const expectedFnv = await hashByteSource(source(), { chunkSize: 2 });
const expectedTree = await sha256TreeByteSource(source(), { chunkSize: 2 });

class ProgressCallback {}
class WrappedProgressCallback {}
let proxyClassApplyCount = 0;
const proxyWrappedClass = new Proxy(WrappedProgressCallback, {
  apply() {
    proxyClassApplyCount++;
    throw new Error('opaque class proxy must not be invoked');
  },
});
const boundClass = WrappedProgressCallback.bind(null);
for (const onProgress of [
  undefined, null, true, false, {}, [], 1, 0, '', 'progress', Symbol('progress'),
  ProgressCallback, class {}, proxyWrappedClass, boundClass,
]) {
  assert.equal(await hashByteSource(source(), { chunkSize: 2, onProgress }), expectedFnv);
  assert.equal(await sha256TreeByteSource(source(), { chunkSize: 2, onProgress }), expectedTree);
}
assert.equal(proxyClassApplyCount, 0, 'opaque class proxies must not be trial-invoked');
assert.throws(() => createProgressCallback(null), /must be a function/);
assert.throws(() => createProgressCallback(ProgressCallback), /must be callable/);

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
  const boundProgress = createProgressCallback(progress.bind({ ignored: true }));
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

  const replacedConstructorEvents = [];
  function replacedConstructorProgress(value) {
    replacedConstructorEvents.push(value);
  }
  replacedConstructorProgress.prototype.constructor = class Marker {};
  assert.equal(
    await hash(source(), { chunkSize: 2, onProgress: replacedConstructorProgress }),
    hash === hashByteSource ? expectedFnv : expectedTree,
  );
  assert.deepEqual(
    replacedConstructorEvents,
    expectedProgress,
    'ordinary callbacks remain valid when prototype.constructor is replaced',
  );

  const boundCallbackError = new Error('bound progress callback failure');
  const throwingBoundProgress = createProgressCallback(function throwingProgress() {
    throw boundCallbackError;
  }.bind(null));
  await assert.rejects(
    hash(source(), { chunkSize: 2, onProgress: throwingBoundProgress }),
    (error) => error === boundCallbackError,
  );

  const classLikeCallbackError = new TypeError("Class constructor X cannot be invoked without 'new'");
  const throwingClassLikeBoundProgress = createProgressCallback(function throwingProgress() {
    throw classLikeCallbackError;
  }.bind(null));
  await assert.rejects(
    hash(source(), { chunkSize: 2, onProgress: throwingClassLikeBoundProgress }),
    (error) => error === classLikeCallbackError,
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
  proxiedOptions.onProgress = createProgressCallback(new Proxy(function onProgress(value) {
    assert.equal(this, proxiedOptions);
    proxiedEvents.push(value);
  }, {}));
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
