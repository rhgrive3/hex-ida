import assert from 'node:assert/strict';
import { IndexedDbArtifactBackend } from '../../../js/core/artifacts/backends.js';

function controlledIndexedDB() {
  const requests = [];
  return {
    requests,
    open() {
      const request = { result:null, error:null };
      requests.push(request);
      return request;
    },
  };
}

function readableDb(value = null) {
  let closeCount = 0;
  const db = {
    objectStoreNames:{ contains:() => true },
    close() { closeCount++; },
    transaction() {
      const tx = { error:null };
      const read = () => {
        const request = { result:undefined, error:null };
        queueMicrotask(() => {
          request.result = value;
          request.onsuccess?.();
          queueMicrotask(() => tx.oncomplete?.());
        });
        return request;
      };
      tx.objectStore = () => ({ get:read, getKey:read });
      return tx;
    },
  };
  return { db, closeCount:() => closeCount };
}

// A blocked open is failed fast for the caller. If that same request later
// succeeds, its otherwise unreachable connection must be closed without
// disturbing a successful retry.
{
  const indexedDB = controlledIndexedDB();
  const backend = new IndexedDbArtifactBackend({ indexedDB, navigator:null, dbName:'issue-4567-retry' });

  const firstRead = backend.getRaw('artifact_x');
  assert.equal(indexedDB.requests.length, 1);
  const firstRequest = indexedDB.requests[0];
  firstRequest.onblocked();
  await assert.rejects(firstRead, (error) => error?.code === 'artifact-storage-blocked');
  assert.equal(backend.stats().openFailures, 1);

  const retryRead = backend.getRaw('artifact_x');
  assert.equal(indexedDB.requests.length, 2);
  const secondRequest = indexedDB.requests[1];
  const live = readableDb(null);
  secondRequest.result = live.db;
  secondRequest.onsuccess();
  assert.equal(await retryRead, null);

  const stale = readableDb(null);
  firstRequest.result = stale.db;
  firstRequest.onsuccess();
  assert.equal(stale.closeCount(), 1, 'late-success connection must be closed');
  assert.equal(live.closeCount(), 0, 'late success must not close the retry connection');

  assert.equal(await backend.getRaw('artifact_y'), null);
  assert.equal(indexedDB.requests.length, 2, 'late success must not replace/reset the live connection');
  await backend.close();
  assert.equal(live.closeCount(), 1);
}

// A late error after blocked is ignored as an already-settled event and must
// not count as a second open failure.
{
  const indexedDB = controlledIndexedDB();
  const backend = new IndexedDbArtifactBackend({ indexedDB, navigator:null, dbName:'issue-4567-blocked-error' });
  const read = backend.getRaw('artifact_x');
  const request = indexedDB.requests[0];
  request.onblocked();
  await assert.rejects(read, (error) => error?.code === 'artifact-storage-blocked');
  request.error = new Error('late open failure');
  request.onerror();
  assert.equal(backend.stats().openFailures, 1);
}

// Normal success/error and versionchange-close behavior remain intact.
{
  const indexedDB = controlledIndexedDB();
  const backend = new IndexedDbArtifactBackend({ indexedDB, navigator:null, dbName:'issue-4567-normal-success' });
  const read = backend.getRaw('artifact_x');
  const live = readableDb(null);
  indexedDB.requests[0].result = live.db;
  indexedDB.requests[0].onsuccess();
  assert.equal(await read, null);
  assert.equal(typeof live.db.onversionchange, 'function');
  live.db.onversionchange();
  assert.equal(live.closeCount(), 1);
}

{
  const indexedDB = controlledIndexedDB();
  const backend = new IndexedDbArtifactBackend({ indexedDB, navigator:null, dbName:'issue-4567-normal-error' });
  const read = backend.getRaw('artifact_x');
  indexedDB.requests[0].error = new Error('open failed');
  indexedDB.requests[0].onerror();
  await assert.rejects(read, (error) => error?.code === 'artifact-storage-failure');
  assert.equal(backend.stats().openFailures, 1);
}

console.log('issue #4567 IndexedDB late-success lifecycle: PASS');
