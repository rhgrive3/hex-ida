import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalysisCache } from '../js/cache/analysis-cache.js';

const ARTIFACT_ID = `artifact_${'a'.repeat(32)}`;

function memoryCache(options = {}) {
  return new AnalysisCache({ indexedDB: null, memory: new Map(), ...options });
}

test('cache semantic identity rejects non-finite numeric options', () => {
  for (const limit of [NaN, Infinity, -Infinity]) {
    assert.throws(
      () => memoryCache({ semanticOptions: { limit } }),
      /analysis-cache-settings-invalid/,
    );
  }

  assert.doesNotThrow(() => memoryCache({ semanticOptions: { limit: 0 } }));
  assert.doesNotThrow(() => memoryCache({ semanticOptions: { limit: 1.5 } }));
});

test('cache semantic identity rejects own Symbol-keyed fields', () => {
  const semanticOptions = { mode: 'safe' };
  semanticOptions[Symbol('hidden-authority')] = true;

  assert.throws(
    () => memoryCache({ semanticOptions }),
    /analysis-cache-settings-invalid/,
  );
});

test('cache semantic identity rejects lossy array shapes', () => {
  const sparse = new Array(1);
  const withStringProperty = [];
  withStringProperty.mode = 'strict';
  const withSymbolProperty = [];
  withSymbolProperty[Symbol('mode')] = 'strict';

  for (const value of [sparse, withStringProperty, withSymbolProperty]) {
    assert.throws(
      () => memoryCache({ semanticOptions: { value } }),
      /analysis-cache-settings-invalid/,
    );
  }

  const denseA = memoryCache({
    semanticOptions: { value: [null, 1, { y: 2, x: 1 }] },
  });
  const denseB = memoryCache({
    semanticOptions: { value: [null, 1, { x: 1, y: 2 }] },
  });
  assert.equal(denseA.analysisIdentity, denseB.analysisIdentity);
});

test('artifact-id-only get rejects and removes canonical records without binaryHash', async () => {
  const cache = memoryCache();
  const key = cache.canonicalKey(ARTIFACT_ID);
  cache.memory.set(key, {
    key,
    schemaVersion: cache.schemaVersion,
    analysisIdentity: cache.analysisIdentity,
    canonicalArtifactId: ARTIFACT_ID,
    data: { analysisSummaries: [{ status: 'stale' }] },
  });

  assert.equal(await cache.get(null, { artifactId: ARTIFACT_ID }), null);
  assert.equal(cache.memory.has(key), false);
});

function controlledIndexedDB() {
  const transactions = [];
  let requestSuccesses = 0;
  const db = {
    objectStoreNames: { contains: () => true },
    close() {},
    transaction(_storeName, mode) {
      assert.equal(mode, 'readwrite');
      const makeRequest = () => {
        const request = { result:undefined, error:null, onsuccess:null, onerror:null };
        queueMicrotask(() => {
          requestSuccesses++;
          request.onsuccess?.();
        });
        return request;
      };
      const transaction = {
        error:null,
        oncomplete:null,
        onerror:null,
        onabort:null,
        objectStore() {
          return { put:makeRequest, delete:makeRequest, clear:makeRequest };
        },
      };
      transactions.push(transaction);
      return transaction;
    },
  };
  const indexedDB = {
    open() {
      const request = {
        result:db,
        error:null,
        onupgradeneeded:null,
        onsuccess:null,
        onerror:null,
        onblocked:null,
      };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };
  return {
    indexedDB,
    transactions,
    get requestSuccesses() { return requestSuccesses; },
    complete(index = 0) { transactions[index].oncomplete?.(); },
    abort(error, index = 0) {
      const transaction = transactions[index];
      transaction.error = error;
      transaction.onabort?.();
    },
  };
}

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

async function assertPendingAfterRequest(fake, promise) {
  let state = 'pending';
  promise.then(
    () => { state = 'resolved'; },
    () => { state = 'rejected'; },
  );
  await nextTurn();
  assert.equal(fake.transactions.length, 1, 'mutation must open one readwrite transaction');
  assert.equal(fake.requestSuccesses, 1, 'object-store request must have succeeded before transaction settlement');
  assert.equal(state, 'pending', 'request success must not settle the public mutation before transaction commit');
}

for (const [name, mutate] of [
  ['put', cache => cache.put('hash', { analysisSummaries:{ ok:true } })],
  ['delete', cache => cache.delete('hash')],
  ['clear', cache => cache.clear()],
]) {
  test(`#4482 AnalysisCache.${name} rejects a transaction abort after request success`, async () => {
    const fake = controlledIndexedDB();
    const cache = new AnalysisCache({ indexedDB:fake.indexedDB, fallbackMode:'error' });
    const abortError = new Error(`${name}-transaction-aborted`);
    const mutation = mutate(cache);

    await assertPendingAfterRequest(fake, mutation);
    fake.abort(abortError);

    await assert.rejects(mutation, error => error === abortError);
  });
}

test('#4482 successful mutation waits for transaction complete', async () => {
  const fake = controlledIndexedDB();
  const cache = new AnalysisCache({ indexedDB:fake.indexedDB, fallbackMode:'error' });
  const mutation = cache.put('hash', { analysisSummaries:{ committed:true } });

  await assertPendingAfterRequest(fake, mutation);
  fake.complete();

  assert.deepEqual(await mutation, { analysisSummaries:{ committed:true } });
  assert.equal(cache.memory, null, 'committed IndexedDB writes must not enter memory fallback');
});

test('#4482 transaction abort activates memory fallback before put resolves', async () => {
  const fake = controlledIndexedDB();
  const cache = new AnalysisCache({ indexedDB:fake.indexedDB });
  const mutation = cache.put('hash', { analysisSummaries:{ fallback:true } });

  await assertPendingAfterRequest(fake, mutation);
  fake.abort(new Error('transaction-aborted'));

  assert.deepEqual(await mutation, { analysisSummaries:{ fallback:true } });
  assert.ok(cache.memory instanceof Map);
  assert.equal((await cache.get('hash')).analysisSummaries.fallback, true);
});
