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

const indexedDB = controlledIndexedDB();
const backend = new IndexedDbArtifactBackend({ indexedDB, navigator:null, dbName:'issue-4567-versionchange' });

const firstRead = backend.getRaw('artifact_x');
assert.equal(indexedDB.requests.length, 1);
const firstDb = readableDb(null);
indexedDB.requests[0].result = firstDb.db;
indexedDB.requests[0].onsuccess();
assert.equal(await firstRead, null);

firstDb.db.onversionchange();
assert.equal(firstDb.closeCount(), 1, 'versionchange must close the old connection');

const secondRead = backend.getRaw('artifact_y');
assert.equal(indexedDB.requests.length, 2, 'versionchange must clear the cached connection and reopen IndexedDB');
const secondDb = readableDb(null);
indexedDB.requests[1].result = secondDb.db;
indexedDB.requests[1].onsuccess();
assert.equal(await secondRead, null);
assert.equal(secondDb.closeCount(), 0, 'reopened connection must stay live');

await backend.close();
assert.equal(secondDb.closeCount(), 1);

console.log('issue #4567 IndexedDB versionchange reopen: PASS');
