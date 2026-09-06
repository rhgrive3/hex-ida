import assert from 'node:assert/strict';

import { AnalysisCache } from '../../js/cache/analysis-cache.js';

function controlledIndexedDB() {
  const requests = [];
  return {
    requests,
    indexedDB: {
      open(name, version) {
        assert.equal(typeof name, 'string');
        assert.equal(version, 1);
        const request = {};
        requests.push(request);
        return request;
      },
    },
  };
}

function readableDb() {
  let closeCalls = 0;
  const db = {
    onversionchange:null,
    get closeCalls() { return closeCalls; },
    close() { closeCalls++; },
    transaction(storeName, mode) {
      assert.equal(storeName, 'entries');
      assert.equal(mode, 'readonly');
      return {
        objectStore(name) {
          assert.equal(name, 'entries');
          return {
            get() {
              const request = {};
              queueMicrotask(() => {
                request.result = undefined;
                request.onsuccess?.();
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

function resolveOpen(request, db) {
  request.result = db;
  request.onsuccess();
}

const { indexedDB, requests } = controlledIndexedDB();
const cache = new AnalysisCache({ indexedDB, dbName:'issue-5491' });

// Opening a cache connection must install a versionchange lifecycle hook.
const first = cache.get('hash-a');
assert.equal(requests.length, 1);
const db1 = readableDb();
resolveOpen(requests[0], db1);
assert.equal(await first, null);
assert.equal(typeof db1.onversionchange, 'function');

// Upgrade/delete notification releases the held connection so another context is not blocked.
const staleVersionchange = db1.onversionchange;
staleVersionchange();
assert.equal(db1.closeCalls, 1, 'versionchange must close the old IndexedDB connection');

// The next cache operation must reopen instead of reusing the closed handle.
const second = cache.get('hash-b');
assert.equal(requests.length, 2, 'versionchange must clear the tracked current connection');
const db2 = readableDb();
resolveOpen(requests[1], db2);
assert.equal(await second, null);
assert.equal(typeof db2.onversionchange, 'function');

// A late event from an obsolete connection must not clear a newer canonical handle.
staleVersionchange();
assert.equal(db1.closeCalls, 2);
assert.equal(await cache.get('hash-c'), null);
assert.equal(requests.length, 2, 'stale versionchange must not invalidate the replacement connection');
assert.equal(db2.closeCalls, 0);

// The replacement connection has the same release contract (including deleteDatabase-triggered versionchange).
db2.onversionchange();
assert.equal(db2.closeCalls, 1);
const third = cache.get('hash-d');
assert.equal(requests.length, 3);
const db3 = readableDb();
resolveOpen(requests[2], db3);
assert.equal(await third, null);

console.log('issue #5491 AnalysisCache IndexedDB versionchange lifecycle regression: PASS');
