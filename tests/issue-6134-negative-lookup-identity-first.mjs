import assert from 'node:assert/strict';
import test from 'node:test';

import { KnowledgeDB } from '../js/knowledge/index.js';

// Minimal production-faithful IndexedDB fake mirroring the semantics
// #negativeCandidates() relies on: a non-multiEntry index getAll(value, limit)
// returns the records whose indexed field equals value, in primary-key order,
// capped at limit.
function createFakeIndexedDB() {
  const stores = new Map();
  const makeRequest = () => ({ result: undefined, error: null, onsuccess: null, onerror: null });
  const settle = (request, result) => {
    queueMicrotask(() => {
      request.result = result;
      request.onsuccess?.();
    });
    return request;
  };
  const makeStore = (name, keyPath) => {
    const records = new Map();
    const indexes = new Set();
    const store = {
      get keyPath() { return keyPath; },
      indexNames: { contains: (indexName) => indexes.has(indexName) },
      createIndex: (indexName) => { indexes.add(indexName); return { name: indexName }; },
      put: (record) => settle(makeRequest(), undefined) && (records.set(record.id, structuredClone(record)), request_done(record)),
      index: (indexName) => ({
        getAll: (value, limit) => {
          if (!indexes.has(indexName)) throw new Error(`fake-idb: unknown index ${indexName}`);
          const matched = [...records.values()]
            .filter((record) => record[indexName] === value)
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          return settle(makeRequest(), matched.slice(0, limit));
        },
      }),
    };
    function request_done() {}
    // put must register the record before the request settles
    store.put = (record) => {
      records.set(record.id, structuredClone(record));
      return settle(makeRequest(), record.id);
    };
    stores.set(name, { records, indexes });
    return store;
  };
  const db = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore: (name, { keyPath } = {}) => makeStore(name, keyPath),
    close() {},
    transaction(storeNames) {
      const names = Array.isArray(storeNames) ? storeNames : [storeNames];
      return {
        objectStore: (name) => {
          if (!names.includes(name)) throw new Error(`fake-idb: store ${name} not in transaction`);
          const entry = stores.get(name);
          if (!entry) throw new Error(`fake-idb: unknown store ${name}`);
          const indexes = entry.indexes;
          const records = entry.records;
          return {
            indexNames: { contains: (indexName) => indexes.has(indexName) },
            put: (record) => {
              records.set(record.id, structuredClone(record));
              return settle(makeRequest(), record.id);
            },
            index: (indexName) => ({
              getAll: (value, limit) => {
                if (!indexes.has(indexName)) throw new Error(`fake-idb: unknown index ${indexName}`);
                const matched = [...records.values()]
                  .filter((record) => record[indexName] === value)
                  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
                return settle(makeRequest(), matched.slice(0, limit ?? Infinity));
              },
            }),
          };
        },
      };
    },
  };
  const indexedDB = {
    open(_name, _version) {
      const request = { result: db, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null, transaction: null };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  return indexedDB;
}

test('#6134 identity-based rejection is independent of same-name rejection count', async () => {
  const db = new KnowledgeDB({ indexedDB: createFakeIndexedDB() });
  for (let i = 0; i < 200; i++) {
    await db.reject({
      id: `a-${String(i).padStart(3, '0')}`,
      candidateName: 'common',
      candidateIdentity: `identity-${i}`,
      address: i,
      sourceBinaryHash: 'bin',
    });
  }
  await db.reject({
    id: 'z-target',
    candidateName: 'common',
    candidateIdentity: 'target-identity',
    address: 0x1000,
    sourceBinaryHash: 'bin',
  });

  const rejected = await db.isRejected({
    candidateName: 'common',
    candidateIdentity: 'target-identity',
    address: 0x1000,
    sourceBinaryHash: 'bin',
  });
  assert.equal(rejected, true, 'an explicitly rejected identity must stay rejected behind 200 same-name records');
});

test('#6134 name-only rejection path keeps working', async () => {
  const db = new KnowledgeDB({ indexedDB: createFakeIndexedDB() });
  await db.reject({ id: 'n-1', candidateName: 'by-name', address: 0x2000, sourceBinaryHash: 'bin' });
  assert.equal(await db.isRejected({ candidateName: 'by-name', address: 0x2000, sourceBinaryHash: 'bin' }), true);
  assert.equal(await db.isRejected({ candidateName: 'by-name', address: 0x3000, sourceBinaryHash: 'bin' }), false);
});

test('#6134 identity-only rejection path keeps working', async () => {
  const db = new KnowledgeDB({ indexedDB: createFakeIndexedDB() });
  await db.reject({ id: 'i-1', candidateIdentity: 'only-identity', address: 0x4000, sourceBinaryHash: 'bin' });
  assert.equal(await db.isRejected({ candidateIdentity: 'only-identity', address: 0x4000, sourceBinaryHash: 'bin' }), true);
});

test('#6134 identity query does not match records of a different identity', async () => {
  const db = new KnowledgeDB({ indexedDB: createFakeIndexedDB() });
  await db.reject({ id: 'x-1', candidateName: 'common', candidateIdentity: 'identity-A', address: 0x5000, sourceBinaryHash: 'bin' });
  assert.equal(
    await db.isRejected({ candidateName: 'common', candidateIdentity: 'identity-B', address: 0x5000, sourceBinaryHash: 'bin' }),
    false,
    'a different identity with the same name must not inherit the rejection',
  );
});
