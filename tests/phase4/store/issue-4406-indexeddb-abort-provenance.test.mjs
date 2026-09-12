import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalysisScheduler } from '../../../js/core/scheduler/index.js';
import {
  ArtifactStorageError,
  ArtifactStore,
  IndexedDbArtifactBackend,
} from '../../../js/core/artifacts/index.js';
import { createArtifactRecord, encodeArtifactPayload } from '../../../js/core/artifacts/contracts.js';
import { descriptor } from './support.mjs';

// This double keeps the IndexedDbArtifactBackend boundary under test without
// making the regression depend on a browser. The independent mode models an
// IndexedDB transaction abort whose cause is not the caller's AbortSignal.
function scriptedIndexedDB({ mode = 'complete', onAdd = null, afterIndependentAbort = null } = {}) {
  const rows = new Map();
  let schemaCreated = false;
  let openCount = 0;

  const db = {
    objectStoreNames: { contains: (name) => schemaCreated && name === 'artifacts' },
    createObjectStore() { schemaCreated = true; },
    close() {},
    transaction(_name, transactionMode) {
      const snapshot = new Map(rows);
      const pendingRequests = new Set();
      let ended = false;
      const transaction = {
        mode: transactionMode,
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        abort() {
          if (ended) {
            if (mode === 'independent-late-signal') throw new DOMException('transaction already aborted', 'InvalidStateError');
            return;
          }
          ended = true;
          rows.clear();
          for (const [key, value] of snapshot) rows.set(key, value);
          const error = transaction.error ?? new DOMException('IndexedDB transaction aborted', 'AbortError');
          for (const request of pendingRequests) {
            request.error = error;
            request.onerror?.();
          }
          pendingRequests.clear();
          if (mode === 'independent-late-signal') {
            queueMicrotask(() => {
              afterIndependentAbort?.();
              transaction.onabort?.();
            });
          } else queueMicrotask(() => transaction.onabort?.());
        },
      };

      const finish = () => {
        if (ended) return;
        ended = true;
        queueMicrotask(() => transaction.oncomplete?.());
      };
      const requestFor = (result = undefined) => ({
        result,
        error: null,
        onsuccess: null,
        onerror: null,
      });
      const objectStore = {
        get(key) {
          const request = requestFor();
          pendingRequests.add(request);
          queueMicrotask(() => {
            if (ended) return;
            pendingRequests.delete(request);
            request.result = rows.get(key);
            request.onsuccess?.();
            if (transactionMode === 'readonly') queueMicrotask(finish);
          });
          return request;
        },
        getKey(key) {
          const request = requestFor();
          pendingRequests.add(request);
          queueMicrotask(() => {
            if (ended) return;
            pendingRequests.delete(request);
            request.result = rows.has(key) ? key : undefined;
            request.onsuccess?.();
            if (transactionMode === 'readonly') queueMicrotask(finish);
          });
          return request;
        },
        add(row) {
          const request = requestFor();
          pendingRequests.add(request);
          queueMicrotask(() => {
            if (ended) return;
            onAdd?.({ request, transaction });
            if (ended) return;
            if (rows.has(row.artifactId)) {
              request.error = new DOMException('Key already exists', 'ConstraintError');
              pendingRequests.delete(request);
              request.onerror?.();
              transaction.error = request.error;
              transaction.abort();
              return;
            }
            rows.set(row.artifactId, row);
            pendingRequests.delete(request);
            request.result = row.artifactId;
            request.onsuccess?.();
            if (mode === 'independent') queueMicrotask(() => transaction.abort());
            else queueMicrotask(finish);
          });
          return request;
        },
      };
      transaction.objectStore = () => objectStore;
      return transaction;
    },
  };

  const indexedDB = {
    open() {
      openCount++;
      const request = {
        result: db,
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
      };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };

  return { indexedDB, openCount: () => openCount, rows };
}

function fixture(name) {
  const artifactDescriptor = descriptor(name);
  const payloadBytes = encodeArtifactPayload({ name, value: 1 });
  return {
    descriptor: artifactDescriptor,
    record: createArtifactRecord(artifactDescriptor, payloadBytes),
    payloadBytes,
  };
}

function backendWith(fake) {
  return new IndexedDbArtifactBackend({ indexedDB: fake.indexedDB, navigator: null, dbName: 'issue-4406' });
}

test('#4406 an independent IndexedDB AbortError is a storage failure without a signal', async () => {
  const fake = scriptedIndexedDB({ mode: 'independent' });
  const backend = backendWith(fake);
  const { record, payloadBytes } = fixture('independent-no-signal');

  await assert.rejects(backend.putAtomic(record, payloadBytes), (error) => {
    assert.equal(error.name, 'ArtifactStorageError');
    assert.equal(error.code, 'artifact-storage-failure');
    return true;
  });
  assert.equal(fake.openCount(), 1);
  assert.equal(fake.rows.has(record.artifactId), false, 'an aborted transaction must not publish');
  await backend.close();
});

test('#4406 an independent IndexedDB AbortError stays a storage failure with a live signal', async () => {
  const fake = scriptedIndexedDB({ mode: 'independent' });
  const backend = backendWith(fake);
  const { record, payloadBytes } = fixture('independent-live-signal');
  const controller = new AbortController();

  await assert.rejects(backend.putAtomic(record, payloadBytes, { signal: controller.signal }), (error) => {
    assert.equal(error.name, 'ArtifactStorageError');
    assert.equal(error.code, 'artifact-storage-failure');
    return true;
  });
  assert.equal(controller.signal.aborted, false);
  await backend.close();
});

test('#4406 a late caller signal cannot rewrite an observed independent transaction failure', async () => {
  const controller = new AbortController();
  const reason = new DOMException('late caller cancellation', 'AbortError');
  const fake = scriptedIndexedDB({
    mode: 'independent-late-signal',
    onAdd: ({ transaction }) => transaction.abort(),
    afterIndependentAbort: () => controller.abort(reason),
  });
  const backend = backendWith(fake);
  const { record, payloadBytes } = fixture('independent-late-signal');

  await assert.rejects(backend.putAtomic(record, payloadBytes, { signal: controller.signal }), (error) => {
    assert.equal(error.name, 'ArtifactStorageError');
    assert.equal(error.code, 'artifact-storage-failure');
    return true;
  });
  assert.equal(controller.signal.aborted, true);
  assert.equal(fake.rows.has(record.artifactId), false);
  await backend.close();
});

test('#4406 a transaction abort caused by the caller remains cancellation', async () => {
  const controller = new AbortController();
  const reason = new DOMException('caller cancelled', 'AbortError');
  const fake = scriptedIndexedDB({ mode: 'complete', onAdd: () => controller.abort(reason) });
  const backend = backendWith(fake);
  const { record, payloadBytes } = fixture('caller-cancel');

  await assert.rejects(backend.putAtomic(record, payloadBytes, { signal: controller.signal }), (error) => error === reason);
  assert.equal(controller.signal.aborted, true);
  assert.equal(fake.rows.has(record.artifactId), false);
  await backend.close();
});

test('#4406 pre-aborted signals still fail before opening IndexedDB', async () => {
  const fake = scriptedIndexedDB();
  const backend = backendWith(fake);
  const { record, payloadBytes } = fixture('pre-aborted');
  const controller = new AbortController();
  controller.abort(new DOMException('already cancelled', 'AbortError'));

  await assert.rejects(backend.putAtomic(record, payloadBytes, { signal: controller.signal }), (error) => error === controller.signal.reason);
  assert.equal(fake.openCount(), 0);
});

test('#4406 immutable conflicts keep their ArtifactStorageError after transaction abort', async () => {
  const fake = scriptedIndexedDB();
  const backend = backendWith(fake);
  const { record, payloadBytes } = fixture('immutable-conflict');
  await backend.putAtomic(record, payloadBytes);
  const differentPayload = encodeArtifactPayload({ name: 'immutable-conflict', value: 2 });

  await assert.rejects(backend.putAtomic(record, differentPayload), (error) => {
    assert.equal(error.name, 'ArtifactStorageError');
    assert.equal(error.code, 'artifact-immutable-conflict');
    return true;
  });
  await backend.close();
});

test('#4406 normal IndexedDB commit remains successful', async () => {
  const fake = scriptedIndexedDB();
  const backend = backendWith(fake);
  const { record, payloadBytes } = fixture('normal-commit');

  const result = await backend.putAtomic(record, payloadBytes);
  assert.equal(result.duplicate, false);
  assert.equal((await backend.getRaw(record.artifactId)).record.artifactId, record.artifactId);
  await backend.close();
});

test('#4406 scheduler records an independent backend abort as storage.failed', async () => {
  const fake = scriptedIndexedDB({ mode: 'independent' });
  const backend = backendWith(fake);
  const store = new ArtifactStore({ backend });
  const events = [];
  const scheduler = new AnalysisScheduler({ store, maxConcurrency: 1, onEvent: (event) => events.push(event) });
  const target = descriptor('scheduler-independent-abort');

  const error = await scheduler.request({
    descriptor: target,
    produce: async () => ({ value: 1 }),
  }).catch((caught) => caught);

  assert.equal(error.name, 'ArtifactStorageError');
  assert.equal(error.code, 'artifact-storage-failure');
  assert.equal(scheduler.state(target.artifactId), 'failed');
  assert.equal(scheduler.stats().storageFailures, 1);
  assert.equal(scheduler.stats().cancelledJobs, 0);
  assert.ok(events.some((event) => event.type === 'storage.failed'));
  assert.equal(events.some((event) => event.type === 'job.cancelled'), false);
  await backend.close();
});

console.log('issue #4406 IndexedDB abort provenance: PASS');
