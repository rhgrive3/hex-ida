import assert from 'node:assert/strict';
import { AnalysisCache } from '../../js/cache/analysis-cache.js';

function controlledIndexedDB() {
  const requests = [];
  return {
    requests,
    indexedDB: {
      open() {
        const request = {};
        requests.push(request);
        return request;
      },
    },
  };
}

function readableDb({ failReads = false } = {}) {
  const transactions = [];
  let closeCalls = 0;
  const db = {
    get closeCalls() { return closeCalls; },
    transactions,
    close() { closeCalls++; },
    transaction(storeName, mode) {
      assert.equal(storeName, 'entries');
      assert.equal(mode, 'readonly');
      transactions.push(db);
      return {
        objectStore(name) {
          assert.equal(name, 'entries');
          return {
            get() {
              const request = {};
              queueMicrotask(() => {
                if (failReads) {
                  request.error = new Error('read-failed');
                  request.onerror?.();
                } else {
                  request.result = undefined;
                  request.onsuccess?.();
                }
              });
              return request;
            },
          };
        },
      };
    },
  };
  return db;
}

// Concurrent first access must share one IndexedDB open and one canonical handle.
{
  const { indexedDB, requests } = controlledIndexedDB();
  const cache = new AnalysisCache({ indexedDB });
  const first = cache.get('hash-a');
  const second = cache.get('hash-b');

  assert.equal(requests.length, 1, 'fresh concurrent callers must single-flight indexedDB.open()');
  const db = readableDb();
  requests[0].result = db;
  requests[0].onsuccess();

  assert.deepEqual(await Promise.all([first, second]), [null, null]);
  assert.equal(db.transactions.length, 2);
  assert.ok(db.transactions.every((handle) => handle === db), 'all callers must use the same IDBDatabase handle');

  assert.equal(await cache.get('hash-c'), null);
  assert.equal(requests.length, 1, 'warm access must reuse the canonical connection');
  assert.equal(db.transactions.length, 3);
}

// A failed shared open keeps fallback semantics, while any late success is closed.
{
  const { indexedDB, requests } = controlledIndexedDB();
  const cache = new AnalysisCache({ indexedDB });
  const first = cache.get('hash-a');
  const second = cache.get('hash-b');

  assert.equal(requests.length, 1);
  const openError = new Error('open-failed');
  requests[0].error = openError;
  requests[0].onerror();

  assert.deepEqual(await Promise.all([first, second]), [null, null]);
  assert.equal(cache.capabilities().backend, 'memory');
  assert.equal(cache.lastIndexedDBError, openError);

  const lateDb = readableDb();
  requests[0].result = lateDb;
  requests[0].onsuccess();
  assert.equal(lateDb.closeCalls, 1, 'late success after a failed open must not leak a connection');

  assert.equal(await cache.get('hash-c'), null);
  assert.equal(requests.length, 1, 'fallback mode must not attempt another IndexedDB open');
}

// Once a canonical handle exists, an IndexedDB operation failure still closes it on fallback.
{
  const { indexedDB, requests } = controlledIndexedDB();
  const cache = new AnalysisCache({ indexedDB });
  const pending = cache.get('hash-a');
  const db = readableDb({ failReads:true });

  assert.equal(requests.length, 1);
  requests[0].result = db;
  requests[0].onsuccess();

  assert.equal(await pending, null);
  assert.equal(db.closeCalls, 1, 'fallback must close the tracked canonical connection');
  assert.equal(cache.capabilities().backend, 'memory');
}

console.log('issue #4593 AnalysisCache IndexedDB open single-flight regression: PASS');
