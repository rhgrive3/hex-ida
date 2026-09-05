import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalysisCache } from '../../../js/cache/analysis-cache.js';

function controlledIndexedDB() {
  const requests = [];
  const indexedDB = {
    open() {
      const request = {
        result:null,
        error:null,
        onupgradeneeded:null,
        onsuccess:null,
        onerror:null,
        onblocked:null,
      };
      requests.push(request);
      return request;
    },
  };
  const request = (index = 0) => {
    assert.ok(requests[index], `expected IndexedDB open request ${index}`);
    return requests[index];
  };
  return {
    indexedDB,
    requests,
    blocked(index = 0) { request(index).onblocked?.(); },
    success(db, index = 0) {
      const openRequest = request(index);
      openRequest.result = db;
      openRequest.onsuccess?.();
    },
    error(error, index = 0) {
      const openRequest = request(index);
      openRequest.error = error;
      openRequest.onerror?.();
    },
  };
}

function readableDb() {
  let closes = 0;
  const db = {
    objectStoreNames:{ contains:() => true },
    close() { closes++; },
    transaction(storeName, mode) {
      assert.equal(storeName, 'entries');
      assert.equal(mode, 'readonly');
      return {
        objectStore(name) {
          assert.equal(name, 'entries');
          return {
            get() {
              const request = { result:null, error:null, onsuccess:null, onerror:null };
              queueMicrotask(() => request.onsuccess?.());
              return request;
            },
          };
        },
      };
    },
  };
  return { db, get closes() { return closes; } };
}

test('#4567 AnalysisCache closes a DB from blocked then late success', async () => {
  const fake = controlledIndexedDB();
  const late = readableDb();
  const cache = new AnalysisCache({ indexedDB:fake.indexedDB, fallbackMode:'error' });
  const get = cache.get('hash');

  assert.equal(fake.requests.length, 1);
  fake.blocked();
  await assert.rejects(get, /IndexedDB open blocked/);

  fake.success(late.db);
  assert.equal(late.closes, 1, 'late successful connection must be discarded exactly once');
});

test('#4567 AnalysisCache ignores a late error after blocked settlement', async () => {
  const fake = controlledIndexedDB();
  const cache = new AnalysisCache({ indexedDB:fake.indexedDB, fallbackMode:'error' });
  const get = cache.get('hash');

  fake.blocked();
  await assert.rejects(get, /IndexedDB open blocked/);
  assert.doesNotThrow(() => fake.error(new Error('late-open-error')));
});

test('#4567 AnalysisCache keeps ownership of a normal successful open', async () => {
  const fake = controlledIndexedDB();
  const live = readableDb();
  const cache = new AnalysisCache({ indexedDB:fake.indexedDB, fallbackMode:'error' });
  const first = cache.get('hash');

  fake.success(live.db);
  assert.equal(await first, null);
  assert.equal(live.closes, 0, 'accepted connection must remain owned by the cache');

  assert.equal(await cache.get('hash'), null);
  assert.equal(fake.requests.length, 1, 'accepted connection must be reused');
  assert.equal(live.closes, 0);
});

test('#4567 AnalysisCache preserves normal open errors', async () => {
  const fake = controlledIndexedDB();
  const cache = new AnalysisCache({ indexedDB:fake.indexedDB, fallbackMode:'error' });
  const expected = new Error('open-failed');
  const get = cache.get('hash');

  fake.error(expected);
  await assert.rejects(get, error => error === expected);
});
