import test from 'node:test';
import assert from 'node:assert/strict';

import { AnalysisResumeStore } from '../js/cache/analysis-resume.js';

/**
 * Spec-compliant IndexedDB mock where IDBCursor.prototype.delete() on a
 * key-only cursor (opened via store.openKeyCursor()) throws InvalidStateError,
 * matching W3C IndexedDB 3.0 §4.7.
 */
function createSpecCompliantIndexedDB({ omitPrimaryKey = false } = {}) {
  const records = new Map();
  let created = false;
  let cursorDeleteCalls = 0;
  const storeDeleteCalls = [];

  const db = {
    objectStoreNames: { contains: () => created },
    createObjectStore() { created = true; return {}; },
    close() {},
    transaction(_storeName, _mode = 'readonly') {
      let pendingRequests = 0;
      let aborted = false;
      let completed = false;
      const tx = {
        error: null,
        oncomplete: null,
        onabort: null,
        onerror: null,
        abort() {
          if (aborted || completed) return;
          aborted = true;
          tx.error = new Error('Transaction aborted');
          queueMicrotask(() => tx.onabort?.());
        },
      };

      const finishRequest = () => {
        pendingRequests -= 1;
        if (pendingRequests === 0 && !aborted && !completed) {
          queueMicrotask(() => {
            if (pendingRequests === 0 && !aborted && !completed) {
              completed = true;
              tx.oncomplete?.();
            }
          });
        }
      };

      const makeRequest = (exec) => {
        pendingRequests += 1;
        const req = { result: undefined, error: null, onsuccess: null, onerror: null };
        queueMicrotask(() => {
          if (aborted) return;
          try {
            req.result = exec();
            req.onsuccess?.();
          } catch (err) {
            req.error = err;
            req.onerror?.();
          }
          finishRequest();
        });
        return req;
      };

      tx.objectStore = () => ({
        get(key) {
          return makeRequest(() => (records.has(key) ? structuredClone(records.get(key)) : undefined));
        },
        put(value, key) {
          return makeRequest(() => {
            records.set(key, structuredClone(value));
            return key;
          });
        },
        delete(key) {
          storeDeleteCalls.push(key);
          return makeRequest(() => {
            records.delete(key);
            return undefined;
          });
        },
        openKeyCursor() {
          const keys = [...records.keys()];
          let index = 0;
          pendingRequests += 1;
          const req = { result: undefined, error: null, onsuccess: null, onerror: null };

          const step = () => {
            queueMicrotask(() => {
              if (aborted) return;
              if (index >= keys.length) {
                req.result = null;
                req.onsuccess?.();
                finishRequest();
                return;
              }
              const key = keys[index++];
              const cursor = {
                key,
                delete() {
                  cursorDeleteCalls += 1;
                  const err = typeof DOMException === 'function'
                    ? new DOMException('Failed to execute \'delete\' on \'IDBCursor\': The cursor is a key-only cursor.', 'InvalidStateError')
                    : Object.assign(new Error('The cursor is a key-only cursor.'), { name: 'InvalidStateError' });
                  throw err;
                },
                continue() {
                  step();
                },
              };
              if (!omitPrimaryKey) {
                cursor.primaryKey = key;
              }
              req.result = cursor;
              req.onsuccess?.();
            });
          };

          step();
          return req;
        },
      });

      return tx;
    },
  };

  return {
    records,
    storeDeleteCalls,
    get cursorDeleteCalls() { return cursorDeleteCalls; },
    open() {
      const req = { result: db, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => {
        if (!created) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

test('[FullFix-Track9][P1] deleteSessionsForBinary deletes matching sessions via store.delete() on spec-compliant key-only cursor', async () => {
  const indexedDB = createSpecCompliantIndexedDB();
  const store = new AnalysisResumeStore({ indexedDB, analysisIdentity: 'track9-test', storage: null });

  await store.save('bin-1', 0, { lastGoal: { id: 'g0' } });
  await store.save('bin-1', 1, { lastGoal: { id: 'g1' } });
  await store.save('bin-1', 2, { lastGoal: { id: 'g2' } });
  await store.save('bin-10', 0, { lastGoal: { id: 'prefix-neighbor' } });
  await store.save('bin-2', 0, { lastGoal: { id: 'other' } });
  await store.put('last-file-meta', { schemaVersion: 1, name: 'sample.bin' });

  const deleted = await store.deleteSessionsForBinary('bin-1');
  assert.equal(deleted, true);
  assert.equal(indexedDB.cursorDeleteCalls, 0, 'cursor.delete() must never be called on a key-only cursor');
  assert.deepEqual(
    indexedDB.storeDeleteCalls.slice().sort(),
    ['session:bin-1:0', 'session:bin-1:1', 'session:bin-1:2'],
  );

  assert.equal(indexedDB.records.has('session:bin-1:0'), false);
  assert.equal(indexedDB.records.has('session:bin-1:1'), false);
  assert.equal(indexedDB.records.has('session:bin-1:2'), false);
  assert.equal(indexedDB.records.has('session:bin-10:0'), true, 'prefix boundary must not delete bin-10');
  assert.equal(indexedDB.records.has('session:bin-2:0'), true, 'other binary sessions must remain intact');
  assert.equal(indexedDB.records.has('last-file-meta'), true, 'non-session records must remain intact');
});

test('[FullFix-Track9][P1] deleteSessionsForBinary falls back to cursor.key when cursor.primaryKey is absent', async () => {
  const indexedDB = createSpecCompliantIndexedDB({ omitPrimaryKey: true });
  const store = new AnalysisResumeStore({ indexedDB, analysisIdentity: 'track9-fallback', storage: null });

  await store.save('bin-fallback', 0, { lastGoal: { id: 'a' } });
  await store.save('bin-fallback', 3, { lastGoal: { id: 'b' } });
  await store.save('bin-keep', 0, { lastGoal: { id: 'c' } });

  const deleted = await store.deleteSessionsForBinary('bin-fallback');
  assert.equal(deleted, true);
  assert.equal(indexedDB.cursorDeleteCalls, 0);
  assert.equal(indexedDB.records.has('session:bin-fallback:0'), false);
  assert.equal(indexedDB.records.has('session:bin-fallback:3'), false);
  assert.equal(indexedDB.records.has('session:bin-keep:0'), true);
});

test('[FullFix-Track9][P1] updateLastFileMeta cleans up superseded binary sessions on spec-compliant IndexedDB', async () => {
  const indexedDB = createSpecCompliantIndexedDB();
  const store = new AnalysisResumeStore({ indexedDB, analysisIdentity: 'track9-supersede', storage: null });

  const fileA = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'application/octet-stream' });
  fileA.name = 'a.bin';
  fileA.lastModified = 1000;
  await store.saveLastFile(fileA, { binaryId: 'bin-old' });
  await store.save('bin-old', 0, { lastGoal: { id: 'old-0' } });
  await store.save('bin-old', 1, { lastGoal: { id: 'old-1' } });

  const fileB = new Blob([new Uint8Array([5, 6, 7, 8])], { type: 'application/octet-stream' });
  fileB.name = 'b.bin';
  fileB.lastModified = 2000;
  await store.saveLastFile(fileB);
  await store.updateLastFileMeta({ binaryId: 'bin-new' });

  assert.equal(indexedDB.cursorDeleteCalls, 0);
  assert.equal(indexedDB.records.has('session:bin-old:0'), false, 'superseded binary session 0 must be deleted');
  assert.equal(indexedDB.records.has('session:bin-old:1'), false, 'superseded binary session 1 must be deleted');
});

test('[FullFix-Track9][P1] deleteSessionsForBinary returns false for empty binaryId and succeeds when no sessions match', async () => {
  const indexedDB = createSpecCompliantIndexedDB();
  const store = new AnalysisResumeStore({ indexedDB, analysisIdentity: 'track9-edge', storage: null });

  assert.equal(await store.deleteSessionsForBinary(''), false);
  assert.equal(await store.deleteSessionsForBinary(null), false);

  await store.save('bin-keep', 0, { lastGoal: { id: 'keep' } });
  assert.equal(await store.deleteSessionsForBinary('bin-missing'), true);
  assert.equal(indexedDB.records.has('session:bin-keep:0'), true);
  assert.equal(indexedDB.storeDeleteCalls.length, 0);
});
