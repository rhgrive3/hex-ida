import assert from 'node:assert/strict';
import test from 'node:test';

import { IndexedDbArtifactBackend } from '../../../js/core/artifacts/backends.js';
import { ArtifactStorageError } from '../../../js/core/artifacts/contracts.js';

// #5382: a truthy non-AbortSignal `signal` option used to reach listener
// registration past transaction creation, so `addEventListener` threw a raw
// TypeError, the storage-error mapping was bypassed, and the finally-cleanup
// raised its own TypeError over the primary failure.

function fakeIndexedDB({ beforeGetDelivery = null, getError = null } = {}) {
  const events = [];
  const db = {
    objectStoreNames: { contains: () => false },
    onversionchange: null,
    close() {},
    transaction() {
      const tx = {
        objectStore() {
          return {
            get() {
              const request = {};
              queueMicrotask(() => {
                beforeGetDelivery?.();
                if (getError) {
                  request.error = getError;
                  request.onerror?.();
                  return;
                }
                request.result = undefined;
                request.onsuccess?.();
              });
              return request;
            },
            add() {
              const request = {};
              queueMicrotask(() => request.onsuccess?.());
              return request;
            },
          };
        },
        abortCalls: 0,
        abort() { this.abortCalls++; },
        oncomplete: null, onerror: null, onabort: null,
      };
      events.push(tx);
      queueMicrotask(() => tx.oncomplete?.());
      return tx;
    },
  };
  return {
    events,
    indexedDB: {
      open() {
        const request = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
        queueMicrotask(() => { request.result = db; request.onsuccess?.(); });
        return request;
      },
    },
  };
}

function putWithSignal(signal, fakeOptions = {}) {
  const fake = fakeIndexedDB(fakeOptions);
  const backend = new IndexedDbArtifactBackend(fake);
  const outcome = backend.putAtomic(
    { artifactId: 'artifact_5382' },
    new Uint8Array([1]),
    { signal },
  ).then(
    (value) => ({ resolved: value }),
    (error) => ({ rejected: error }),
  );
  return { fake, outcome };
}

test('#5382 a malformed signal is rejected at the option boundary with the storage error contract', async () => {
  const { fake, outcome } = putWithSignal({ aborted: false });
  const { rejected } = await outcome;
  assert.ok(rejected instanceof ArtifactStorageError, `expected ArtifactStorageError, got ${rejected?.name}`);
  assert.equal(rejected.code, 'artifact-storage-signal-invalid');
  assert.equal(rejected.detail.operation, 'put');
  assert.equal(fake.events.length, 0, 'no transaction may be created for a malformed signal');
});

test('#5382 other malformed signal shapes are rejected the same way', async () => {
  for (const signal of [true, 1, 'abort', {}, { aborted: false, addEventListener: 'nope' }]) {
    const { outcome } = putWithSignal(signal);
    const { rejected } = await outcome;
    assert.ok(rejected instanceof ArtifactStorageError, `expected ArtifactStorageError for ${JSON.stringify(signal)}`);
    assert.equal(rejected.code, 'artifact-storage-signal-invalid');
  }
});

test('#5382 a pre-aborted malformed signal still fails closed with the storage contract', async () => {
  const { outcome } = putWithSignal({ aborted: true });
  const { rejected } = await outcome;
  assert.ok(rejected instanceof ArtifactStorageError);
  assert.equal(rejected.code, 'artifact-storage-signal-invalid');
});

test('#5382 throwing listener registration is mapped and retires its transaction', async () => {
  let removeCalls = 0;
  const signal = {
    aborted: false,
    addEventListener() { throw new TypeError('add-failed'); },
    removeEventListener() { removeCalls++; throw new TypeError('remove-failed'); },
  };
  const { fake, outcome } = putWithSignal(signal);
  const { rejected } = await outcome;
  assert.ok(rejected instanceof ArtifactStorageError, `expected ArtifactStorageError, got ${rejected?.name}`);
  assert.equal(rejected.code, 'artifact-storage-failure');
  assert.equal(rejected.detail.operation, 'put');
  assert.match(rejected.message, /add-failed/);
  assert.equal(fake.events.length, 1, 'registration fails only after the transaction is created');
  assert.equal(fake.events[0].abortCalls, 1, 'registration failure must retire its transaction');
  assert.equal(removeCalls, 0, 'failed registration must not be treated as a registered listener');
});

test('#5382 throwing listener cleanup cannot replace a successful put', async () => {
  let removeCalls = 0;
  const signal = {
    aborted: false,
    addEventListener() {},
    removeEventListener() { removeCalls++; throw new TypeError('remove-failed'); },
  };
  const { outcome } = putWithSignal(signal);
  const { resolved, rejected } = await outcome;
  assert.equal(rejected, undefined);
  assert.equal(resolved.duplicate, false);
  assert.equal(removeCalls, 1);
});

test('#5382 throwing listener cleanup cannot replace the primary storage error', async () => {
  let removeCalls = 0;
  const signal = {
    aborted: false,
    addEventListener() {},
    removeEventListener() { removeCalls++; throw new TypeError('remove-failed'); },
  };
  const { outcome } = putWithSignal(signal, { getError: new Error('get-failed') });
  const { rejected } = await outcome;
  assert.ok(rejected instanceof ArtifactStorageError, `expected ArtifactStorageError, got ${rejected?.name}`);
  assert.equal(rejected.code, 'artifact-storage-failure');
  assert.equal(rejected.detail.operation, 'put');
  assert.match(rejected.message, /get-failed/);
  assert.equal(removeCalls, 1);
});

test('#5382 real AbortSignal-compatible options keep working end to end', async () => {
  const { outcome } = putWithSignal(new AbortController().signal);
  const { resolved, rejected } = await outcome;
  assert.equal(rejected, undefined);
  assert.equal(resolved.duplicate, false);
});

test('#5382 aborting a real signal mid-put still aborts the transaction', async () => {
  const controller = new AbortController();
  const fake = fakeIndexedDB({ beforeGetDelivery: () => controller.abort() });
  const backend = new IndexedDbArtifactBackend(fake);
  const pending = backend.putAtomic(
    { artifactId: 'artifact_5382_abort' },
    new Uint8Array([1]),
    { signal: controller.signal },
  ).then(
    (value) => ({ resolved: value }),
    (error) => ({ rejected: error }),
  );
  const { rejected } = await pending;
  assert.ok(rejected, 'expected the put to reject after abort');
  assert.equal(rejected.name, 'AbortError');
  assert.equal(fake.events.length, 1, 'a valid signal path keeps its transaction');
});

test('#5382 unproven IndexedDB AbortError remains a storage failure', async () => {
  const { outcome } = putWithSignal(undefined, { getError: new DOMException('db-internal-abort', 'AbortError') });
  const { rejected } = await outcome;
  assert.ok(rejected instanceof ArtifactStorageError, `expected ArtifactStorageError, got ${rejected?.name}`);
  assert.equal(rejected.code, 'artifact-storage-failure');
  assert.equal(rejected.detail.operation, 'put');
  assert.match(rejected.message, /db-internal-abort/);
});
