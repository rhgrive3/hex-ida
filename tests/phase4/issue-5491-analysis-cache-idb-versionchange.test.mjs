import assert from 'node:assert/strict';

import { AnalysisCache } from '../../js/cache/analysis-cache.js';

function controlledIndexedDB() {
  const requests = [];
  const connections = [];
  // A real IndexedDB delegate notifies every open connection through
  // versionchange before a deleteDatabase or a higher-version open proceeds.
  const notifyOpenConnections = () => {
    for (const db of connections) {
      queueMicrotask(() => db.onversionchange?.());
    }
  };
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
      deleteDatabase(name) {
        assert.equal(typeof name, 'string');
        notifyOpenConnections();
        return {};
      },
    },
    // A second context upgrading the database (external versioned open)
    // notifies every open connection the same way before the upgrade runs.
    openVersioned(name, version) {
      assert.equal(typeof name, 'string');
      assert.ok(version > 1);
      notifyOpenConnections();
      return { version };
    },
    resolveOpen(request, db) {
      connections.push(db);
      request.result = db;
      request.onsuccess();
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

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

const { indexedDB, requests, openVersioned, resolveOpen } = controlledIndexedDB();
const cache = new AnalysisCache({ indexedDB, dbName:'issue-5491' });

// Opening a cache connection must install a versionchange lifecycle hook.
const first = cache.get('hash-a');
assert.equal(requests.length, 1);
const db1 = readableDb();
resolveOpen(requests[0], db1);
assert.equal(await first, null);
assert.equal(typeof db1.onversionchange, 'function');

// A deleteDatabase from another context must release the held connection so
// the delete is not blocked, and the next operation must reopen.
indexedDB.deleteDatabase('issue-5491');
await flush();
assert.equal(db1.closeCalls, 1, 'versionchange must close the old IndexedDB connection');
const second = cache.get('hash-b');
assert.equal(requests.length, 2, 'versionchange must clear the tracked current connection');
const db2 = readableDb();
resolveOpen(requests[1], db2);
assert.equal(await second, null);
assert.equal(typeof db2.onversionchange, 'function');

// An external higher-version open notifies the current connection too.
openVersioned('issue-5491', 2);
await flush();
assert.equal(db2.closeCalls, 1, 'upgrade notification must close the current connection');
const third = cache.get('hash-c');
assert.equal(requests.length, 3, 'upgrade notification must clear the tracked current connection');
const db3 = readableDb();
resolveOpen(requests[2], db3);
assert.equal(await third, null);
assert.equal(typeof db3.onversionchange, 'function');

// A late notification from obsolete connections must not clear the newest
// canonical handle more than the single live release it deserves.
indexedDB.deleteDatabase('issue-5491');
await flush();
assert.equal(db1.closeCalls, 3, 'stale connection still closes itself on each late event');
assert.equal(db2.closeCalls, 2, 'superseded connection still closes itself on each late event');
assert.equal(db3.closeCalls, 1, 'current connection is released exactly once by the live event');
const fourth = cache.get('hash-d');
assert.equal(requests.length, 4, 'exactly one live release triggers exactly one reopen');
const db4 = readableDb();
resolveOpen(requests[3], db4);
assert.equal(await fourth, null);

console.log('issue #5491 AnalysisCache IndexedDB versionchange lifecycle regression: PASS');
