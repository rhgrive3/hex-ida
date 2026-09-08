import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalysisCache } from '../../js/cache/analysis-cache.js';

// #5934: AnalysisCache.get() cleaned a corrupt record with an UNCONDITIONAL
// delete in a second, later readwrite transaction. IndexedDB schedules
// overlapping transactions in creation order, so the sequence
//   R  (readonly get, reads the corrupt record)
//   W1 (readwrite put of a fresh, current-identity record)
//   W2 (the cleanup delete, created last)
// let W2 delete the record W1 had just written. The cleanup now re-reads the
// key inside its own readwrite transaction and deletes only when the record
// it observed is still the one stored.

function scriptedIndexedDB() {
  const store = new Map();
  const transactions = [];
  let heldGet = null;
  const db = {
    objectStoreNames: { contains: () => true },
    close() {},
    transaction(_name, mode) {
      const transaction = { mode, error: null, oncomplete: null, onerror: null, onabort: null };
      const objectStore = {
        get(key) {
          const request = { result: undefined, error: null, onsuccess: null, onerror: null };
          // A readonly transaction reads a consistent snapshot at request time
          // and completes once its requests settle.
          const snapshot = store.get(key);
          const settle = () => { request.result = snapshot; request.onsuccess?.(); transaction.oncomplete?.(); };
          if (heldGet) {
            heldGet.requests.push({ request, deliver: settle });
          } else {
            queueMicrotask(settle);
          }
          return request;
        },
        put(record) {
          const request = { result: undefined, error: null, onsuccess: null, onerror: null };
          queueMicrotask(() => {
            store.set(record.key, record);
            request.onsuccess?.();
            transaction.oncomplete?.();
          });
          return request;
        },
        delete(key) {
          const request = { result: undefined, error: null, onsuccess: null, onerror: null };
          queueMicrotask(() => {
            store.delete(key);
            request.onsuccess?.();
            transaction.oncomplete?.();
          });
          return request;
        },
      };
      transaction.objectStore = () => objectStore;
      transactions.push(transaction);
      return transaction;
    },
  };
  const indexedDB = {
    open() {
      const request = { result: db, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };
  return {
    indexedDB,
    store,
    transactions,
    // Holds readonly get deliveries so the test can interleave a writer
    // between the read and the cleanup — exactly the R -> W1 -> W2 order
    // IndexedDB transaction scheduling produces for this call sequence.
    holdNextGet() {
      heldGet = { requests: [] };
      return () => {
        const held = heldGet;
        heldGet = null;
        for (const entry of held.requests) entry.deliver();
      };
    },
  };
}

const CURRENT = { analyzerVersion: 'issue-5934-current' };

function corruptRecord(cache, hash, overrides = {}) {
  return {
    key: cache.key(hash),
    // A foreign schema version makes the record corrupt: get() must clean it
    // up, and that cleanup is what raced concurrent writers (#5934).
    schemaVersion: cache.schemaVersion + 100,
    analysisIdentity: 'issue-5934-foreign-identity',
    binaryHash: hash,
    canonicalArtifactId: null,
    updatedAt: 1,
    data: { analysisSummaries: [{ status: 'corrupt' }] },
    ...overrides,
  };
}

test('#5934 a concurrent put survives the corrupt-record cleanup (legacy hash route)', async () => {
  const fake = scriptedIndexedDB();
  const cache = new AnalysisCache({ indexedDB: fake.indexedDB, fallbackMode: 'error', ...CURRENT });
  const hash = 'a'.repeat(64);
  const key = cache.key(hash);
  fake.store.set(key, corruptRecord(cache, hash));

  const releaseGet = fake.holdNextGet();
  const pGet = cache.get(hash);
  // Writer W1 commits while the reader is still holding its corrupt snapshot.
  await cache.put(hash, { analysisSummaries: [{ status: 'fresh' }] });
  releaseGet();
  await pGet;

  const surviving = fake.store.get(key);
  assert.ok(surviving, 'the fresh record must survive the corrupt-record cleanup');
  assert.equal(surviving.analysisIdentity, new AnalysisCache(CURRENT).analysisIdentity);
  assert.deepEqual(surviving.data, { analysisSummaries: [{ status: 'fresh' }] });
});

test('#5934 a concurrent put survives the corrupt-record cleanup (canonical route)', async () => {
  const fake = scriptedIndexedDB();
  const cache = new AnalysisCache({ indexedDB: fake.indexedDB, fallbackMode: 'error', ...CURRENT });
  const hash = 'b'.repeat(64);
  const artifactId = 'artifact_' + '0123456789abcdef'.repeat(2);
  const key = cache.key(hash, { artifactId });
  fake.store.set(key, corruptRecord(cache, hash, { key, canonicalArtifactId: artifactId }));

  const releaseGet = fake.holdNextGet();
  const pGet = cache.get(null, { artifactId });
  await cache.put(hash, { analysisSummaries: [{ status: 'fresh' }] }, { artifactId });
  releaseGet();
  await pGet;

  const surviving = fake.store.get(key);
  assert.ok(surviving, 'the fresh canonical record must survive the corrupt-record cleanup');
  assert.equal(surviving.canonicalArtifactId, artifactId);
});

test('#5934 an unreplaced corrupt record is still cleaned up', async () => {
  const fake = scriptedIndexedDB();
  const cache = new AnalysisCache({ indexedDB: fake.indexedDB, fallbackMode: 'error', ...CURRENT });
  const hash = 'c'.repeat(64);
  const key = cache.key(hash);
  fake.store.set(key, corruptRecord(cache, hash));

  assert.equal(await cache.get(hash), null, 'a corrupt record is a miss');
  assert.equal(fake.store.has(key), false, 'an unreplaced corrupt record is still garbage-collected');
});

test('#5934 identity-stale but well-shaped records are preserved, not deleted', async () => {
  // #3626 semantics: a record from another analysis identity is a miss, but
  // the conditional cleanup must not delete it (only corrupt shapes are).
  const fake = scriptedIndexedDB();
  const cache = new AnalysisCache({ indexedDB: fake.indexedDB, fallbackMode: 'error', ...CURRENT });
  const hash = 'd'.repeat(64);
  const key = cache.key(hash);
  fake.store.set(key, {
    key,
    schemaVersion: cache.schemaVersion,
    analysisIdentity: 'issue-5934-other-identity',
    binaryHash: hash,
    canonicalArtifactId: null,
    updatedAt: 1,
    data: { analysisSummaries: [{ status: 'other-identity' }] },
  });

  assert.equal(await cache.get(hash), null);
  assert.ok(fake.store.has(key), 'an identity mismatch alone must not trigger deletion');
});

test('#5934 memory fallback cleanup removes only the record it observed', async () => {
  const memory = new Map();
  const cache = new AnalysisCache({ indexedDB: null, memory, ...CURRENT });
  const hash = 'e'.repeat(64);
  const key = cache.key(hash);
  const corrupt = corruptRecord(cache, hash);
  memory.set(key, corrupt);

  assert.equal(await cache.get(hash), null);
  assert.equal(memory.has(key), false, 'the observed corrupt record itself is removed');
});
