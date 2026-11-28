/**
 * IndexedDB delta/snapshot store for Hex NoteStore and ProductWorkspace.
 *
 * Database: `hex-notes-v1` (version 1)
 * Object stores:
 *  - `entries`:  keyPath `['storeId', 'kind', 'key']`, index `byStore` on `storeId`
 *  - `meta`:     keyPath `'storeId'`
 *  - `projects`: keyPath `'projectKey'`
 *
 * All mutating operations are serialized through a single-writer Promise queue
 * (`_enqueueWrite`) to avoid overlapping IndexedDB transactions. Errors are
 * normalized with `{ code: 'QUOTA_EXCEEDED' | 'IDB_ERROR', message, cause }`.
 */

export const NOTES_IDB_NAME = 'hex-notes-v1';
export const NOTES_IDB_VERSION = 1;
export const NOTES_STORE_ENTRIES = 'entries';
export const NOTES_STORE_META = 'meta';
export const NOTES_STORE_PROJECTS = 'projects';
export const NOTES_INDEX_BY_STORE = 'byStore';

const VALID_KINDS = new Set(['names', 'comments', 'vars', 'types']);
const DEFAULT_CHUNK_SIZE = 2000;

/**
 * Return true when IndexedDB is usable in the given environment.
 * Returns false in Node test environments, opaque `origin === 'null'` contexts,
 * or when `indexedDB.open` is absent.
 *
 * @param {object} [env=globalThis]
 * @returns {boolean}
 */
export function isNotesIdbAvailable(env = globalThis) {
  try {
    if (!env) return false;
    if (env.location && env.location.origin === 'null') return false;
    const factory = env.indexedDB;
    return Boolean(factory && typeof factory.open === 'function');
  } catch {
    return false;
  }
}

function isQuotaError(err) {
  if (!err) return false;
  if (err.code === 'QUOTA_EXCEEDED') return true;
  if (err.name === 'QuotaExceededError') return true;
  if (err.code === 22 || err.code === 1014) return true;
  if (typeof err.message === 'string' && /quota/i.test(err.message)) return true;
  return false;
}

/**
 * Normalize any IndexedDB / DOMException error into a structured Error
 * carrying `{ code: 'QUOTA_EXCEEDED' | 'IDB_ERROR', message, cause }`.
 *
 * @param {unknown} err
 * @param {string} [fallbackMessage]
 * @returns {Error & { code: 'QUOTA_EXCEEDED' | 'IDB_ERROR', cause: unknown }}
 */
export function normalizeNotesIdbError(err, fallbackMessage = 'IndexedDB operation failed') {
  if (err && typeof err === 'object' && (err.code === 'QUOTA_EXCEEDED' || err.code === 'IDB_ERROR') && err instanceof Error) {
    return err;
  }
  const quota = isQuotaError(err);
  const code = quota ? 'QUOTA_EXCEEDED' : 'IDB_ERROR';
  const rawMessage = err && typeof err === 'object' && typeof err.message === 'string' && err.message
    ? err.message
    : (typeof err === 'string' && err ? err : fallbackMessage);
  const out = new Error(rawMessage);
  out.name = quota ? 'QuotaExceededError' : 'NotesIdbError';
  out.code = code;
  out.cause = err ?? null;
  return out;
}

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(normalizeNotesIdbError(req.error, 'IndexedDB request failed'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    tx.oncomplete = () => finish(resolve);
    tx.onerror = () => finish(reject, normalizeNotesIdbError(tx.error, 'IndexedDB transaction failed'));
    tx.onabort = () => finish(reject, normalizeNotesIdbError(tx.error, 'IndexedDB transaction aborted'));
  });
}

function normalizeChunkSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CHUNK_SIZE;
  return Math.floor(n);
}

function toEntriesList(source) {
  if (!source) return [];
  if (source instanceof Map) return [...source.entries()];
  if (Array.isArray(source)) {
    const out = [];
    for (const item of source) {
      if (Array.isArray(item) && item.length >= 2) {
        out.push([String(item[0]), item[1]]);
      } else if (item && typeof item === 'object' && item.key != null) {
        out.push([String(item.key), item.value]);
      }
    }
    return out;
  }
  if (typeof source === 'object') return Object.entries(source);
  return [];
}

function toRecordMap(source) {
  const map = new Map();
  if (!source) return map;
  if (source instanceof Map) {
    for (const [k, v] of source.entries()) map.set(String(k), v);
    return map;
  }
  if (typeof source === 'object') {
    for (const [k, v] of Object.entries(source)) map.set(String(k), v);
  }
  return map;
}

function makeCompositeKey(kind, key) {
  return `${kind}:${key}`;
}

function parseCompositeKey(compositeKey) {
  const idx = compositeKey.indexOf(':');
  if (idx <= 0) return null;
  const kind = compositeKey.slice(0, idx);
  const key = compositeKey.slice(idx + 1);
  if (!VALID_KINDS.has(kind)) return null;
  return { kind, key };
}

function normalizeStoreId(storeId) {
  if (typeof storeId !== 'string' || !storeId) {
    throw normalizeNotesIdbError(new TypeError('storeId must be a non-empty string'), 'Invalid storeId');
  }
  return storeId;
}

function normalizeKind(kind) {
  if (!VALID_KINDS.has(kind)) {
    throw normalizeNotesIdbError(new TypeError(`Unsupported entry kind: ${String(kind)}`), 'Invalid entry kind');
  }
  return kind;
}

export class NotesIdbBackend {
  constructor({ dbName = NOTES_IDB_NAME, indexedDB = globalThis.indexedDB } = {}) {
    this._dbName = dbName || NOTES_IDB_NAME;
    this._idbFactory = indexedDB ?? null;
    this._db = null;
    this._openPromise = null;
    this._writeQueue = Promise.resolve();
    this._closed = false;
  }

  /**
   * Open (or return the already-open) IndexedDB database.
   * Concurrent calls share a single in-flight open request.
   *
   * @returns {Promise<IDBDatabase>}
   */
  async open() {
    if (this._db) return this._db;
    if (this._openPromise) return this._openPromise;
    if (!this._idbFactory || typeof this._idbFactory.open !== 'function') {
      throw normalizeNotesIdbError(new Error('IndexedDB is unavailable'), 'IndexedDB is unavailable');
    }

    this._closed = false;
    this._openPromise = new Promise((resolve, reject) => {
      let req;
      try {
        req = this._idbFactory.open(this._dbName, NOTES_IDB_VERSION);
      } catch (err) {
        this._openPromise = null;
        reject(normalizeNotesIdbError(err, 'Failed to open IndexedDB'));
        return;
      }

      req.onupgradeneeded = (event) => {
        const db = event?.target?.result || req.result;
        if (!db.objectStoreNames.contains(NOTES_STORE_ENTRIES)) {
          const entryStore = db.createObjectStore(NOTES_STORE_ENTRIES, {
            keyPath: ['storeId', 'kind', 'key'],
          });
          entryStore.createIndex(NOTES_INDEX_BY_STORE, 'storeId', { unique: false });
        } else if (req.transaction) {
          const entryStore = req.transaction.objectStore(NOTES_STORE_ENTRIES);
          if (!entryStore.indexNames.contains(NOTES_INDEX_BY_STORE)) {
            entryStore.createIndex(NOTES_INDEX_BY_STORE, 'storeId', { unique: false });
          }
        }
        if (!db.objectStoreNames.contains(NOTES_STORE_META)) {
          db.createObjectStore(NOTES_STORE_META, { keyPath: 'storeId' });
        }
        if (!db.objectStoreNames.contains(NOTES_STORE_PROJECTS)) {
          db.createObjectStore(NOTES_STORE_PROJECTS, { keyPath: 'projectKey' });
        }
      };

      req.onsuccess = () => {
        const db = req.result;
        this._db = db;
        this._openPromise = null;
        if (typeof db.onversionchange !== 'undefined' || 'onversionchange' in db) {
          db.onversionchange = () => {
            try { db.close(); } catch { /* ignore */ }
            if (this._db === db) this._db = null;
          };
        }
        resolve(db);
      };

      req.onerror = () => {
        this._openPromise = null;
        reject(normalizeNotesIdbError(req.error, 'Failed to open IndexedDB'));
      };

      req.onblocked = () => {
        // Leave pending until unblocked or errored; do not hang silently if factory errors.
      };
    });

    return this._openPromise;
  }

  /**
   * Serialize all mutating operations through a single-writer Promise chain.
   * A failure in one write does not poison subsequent queued writes.
   */
  _enqueueWrite(fn) {
    const run = this._writeQueue.then(fn, fn);
    this._writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Load all entries, tombstones, and metadata for a given storeId.
   *
   * @param {string} storeId
   * @returns {Promise<{ found: boolean, entries: { names: Map, comments: Map, vars: Map, types: Map }, tombstones: Map<string, { rev: number, updatedAt: number }>, meta: object | null }>}
   */
  async loadStore(storeId) {
    const id = normalizeStoreId(storeId);
    const db = await this.open();
    try {
      const tx = db.transaction([NOTES_STORE_META, NOTES_STORE_ENTRIES], 'readonly');
      const done = txDone(tx);
      const metaStore = tx.objectStore(NOTES_STORE_META);
      const entryStore = tx.objectStore(NOTES_STORE_ENTRIES);
      const byStore = entryStore.index(NOTES_INDEX_BY_STORE);

      const [meta, rows] = await Promise.all([
        requestToPromise(metaStore.get(id)),
        requestToPromise(byStore.getAll(id)),
      ]);
      await done;

      const entries = {
        names: new Map(),
        comments: new Map(),
        vars: new Map(),
        types: new Map(),
      };
      const tombstones = new Map();
      const list = Array.isArray(rows) ? rows : [];

      for (const row of list) {
        if (!row || !VALID_KINDS.has(row.kind) || typeof row.key !== 'string') continue;
        if (row.deleted) {
          tombstones.set(makeCompositeKey(row.kind, row.key), {
            rev: Number.isFinite(row.rev) ? row.rev : 0,
            updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
          });
        } else {
          entries[row.kind].set(row.key, row.value == null ? '' : String(row.value));
        }
      }

      const found = Boolean(meta || list.length > 0);
      return {
        found,
        entries,
        tombstones,
        meta: meta || null,
      };
    } catch (err) {
      throw normalizeNotesIdbError(err, 'Failed to load store from IndexedDB');
    }
  }

  /**
   * Persist a single delta entry in O(1).
   * When `value == null`, writes a tombstone record (`deleted: true`) rather than
   * physically deleting, so concurrent tabs performing OCC merges preserve the deletion.
   *
   * @param {string} storeId
   * @param {'names'|'comments'|'vars'|'types'} kind
   * @param {string} key
   * @param {string|null|undefined} value
   * @param {{ generation?: string, rev?: number, updatedAt?: number }} [options]
   * @returns {Promise<{ revision: number }>}
   */
  putDelta(storeId, kind, key, value, { generation, rev, updatedAt } = {}) {
    const id = normalizeStoreId(storeId);
    const validKind = normalizeKind(kind);
    const entryKey = String(key);

    return this._enqueueWrite(async () => {
      const db = await this.open();
      try {
        const tx = db.transaction([NOTES_STORE_META, NOTES_STORE_ENTRIES], 'readwrite');
        const done = txDone(tx);
        const metaStore = tx.objectStore(NOTES_STORE_META);
        const entryStore = tx.objectStore(NOTES_STORE_ENTRIES);

        const existingMeta = await requestToPromise(metaStore.get(id));
        const currentRev = Number.isFinite(existingMeta?.revision) ? existingMeta.revision : 0;
        const requestedRev = Number.isFinite(rev) ? rev : 0;
        const nextRevision = Math.max(currentRev + 1, requestedRev);
        const ts = Number.isFinite(updatedAt) ? updatedAt : Date.now();
        const deleted = value == null;

        entryStore.put({
          storeId: id,
          kind: validKind,
          key: entryKey,
          value: deleted ? null : String(value),
          deleted,
          updatedAt: ts,
          rev: nextRevision,
        });

        metaStore.put({
          storeId: id,
          revision: nextRevision,
          generation: generation ?? existingMeta?.generation ?? '',
          structs: Array.isArray(existingMeta?.structs) ? existingMeta.structs : [],
          cleared: false,
          updatedAt: ts,
          migratedFromLocalStorage: Boolean(existingMeta?.migratedFromLocalStorage),
        });

        await done;
        return { revision: nextRevision };
      } catch (err) {
        throw normalizeNotesIdbError(err, 'Failed to write delta to IndexedDB');
      }
    });
  }

  /**
   * Persist a full store snapshot in chunks to avoid memory spikes and long
   * main-thread stalls.
   *
   * - `replace === true`: explicit full replacement (e.g. `.hexproj` import or
   *   migration); removes stale records not in the new snapshot and writes new
   *   records in `chunkSize` batches.
   * - `replace === false`: OCC merge against existing IDB records so concurrent
   *   edits from another tab are never silently overwritten.
   *
   * @param {string} storeId
   * @param {object} snapshot
   * @param {{ chunkSize?: number, replace?: boolean }} [options]
   * @returns {Promise<{ revision: number }>}
   */
  replaceStore(storeId, snapshot = {}, { chunkSize = DEFAULT_CHUNK_SIZE, replace = false } = {}) {
    const id = normalizeStoreId(storeId);
    const batchSize = normalizeChunkSize(chunkSize);

    return this._enqueueWrite(async () => {
      const db = await this.open();
      try {
        const ts = Number.isFinite(snapshot?.updatedAt) ? snapshot.updatedAt : Date.now();
        const snapshotEntries = snapshot?.entries && typeof snapshot.entries === 'object'
          ? snapshot.entries
          : snapshot;

        // Collect incoming live entries into a composite map.
        const incomingLive = new Map();
        for (const kind of VALID_KINDS) {
          for (const [k, v] of toEntriesList(snapshotEntries?.[kind])) {
            if (v == null) continue;
            incomingLive.set(makeCompositeKey(kind, k), {
              kind,
              key: String(k),
              value: String(v),
            });
          }
        }
        const incomingTombstones = toRecordMap(snapshot?.tombstones);
        const localDirty = toRecordMap(snapshot?.localDirty);

        if (replace) {
          // Read existing meta & entry keys, then delete stale keys in chunks,
          // write new records in chunks, and commit meta last.
          const readTx = db.transaction([NOTES_STORE_META, NOTES_STORE_ENTRIES], 'readonly');
          const readDone = txDone(readTx);
          const [existingMeta, existingRows] = await Promise.all([
            requestToPromise(readTx.objectStore(NOTES_STORE_META).get(id)),
            requestToPromise(readTx.objectStore(NOTES_STORE_ENTRIES).index(NOTES_INDEX_BY_STORE).getAll(id)),
          ]);
          await readDone;

          const currentRev = Number.isFinite(existingMeta?.revision) ? existingMeta.revision : 0;
          const requestedRev = Number.isFinite(snapshot?.revision)
            ? snapshot.revision
            : (Number.isFinite(snapshot?.rev) ? snapshot.rev : 0);
          const nextRevision = Math.max(currentRev + 1, requestedRev);

          const toWrite = [];
          const keepCompositeKeys = new Set();

          for (const [compKey, item] of incomingLive.entries()) {
            keepCompositeKeys.add(compKey);
            toWrite.push({
              storeId: id,
              kind: item.kind,
              key: item.key,
              value: item.value,
              deleted: false,
              updatedAt: ts,
              rev: nextRevision,
            });
          }
          for (const [compKey, tomb] of incomingTombstones.entries()) {
            if (keepCompositeKeys.has(compKey)) continue;
            const parsed = parseCompositeKey(compKey);
            if (!parsed) continue;
            keepCompositeKeys.add(compKey);
            toWrite.push({
              storeId: id,
              kind: parsed.kind,
              key: parsed.key,
              value: null,
              deleted: true,
              updatedAt: Number.isFinite(tomb?.updatedAt) ? tomb.updatedAt : ts,
              rev: Number.isFinite(tomb?.rev) ? Math.max(tomb.rev, nextRevision) : nextRevision,
            });
          }

          const staleKeys = [];
          for (const row of Array.isArray(existingRows) ? existingRows : []) {
            if (!row || typeof row.kind !== 'string' || typeof row.key !== 'string') continue;
            if (!keepCompositeKeys.has(makeCompositeKey(row.kind, row.key))) {
              staleKeys.push([id, row.kind, row.key]);
            }
          }

          // Delete stale records in chunks.
          for (let i = 0; i < staleKeys.length; i += batchSize) {
            const slice = staleKeys.slice(i, i + batchSize);
            const delTx = db.transaction([NOTES_STORE_ENTRIES], 'readwrite');
            const store = delTx.objectStore(NOTES_STORE_ENTRIES);
            for (const keyTuple of slice) store.delete(keyTuple);
            await txDone(delTx);
          }

          // Write replacement records in chunks.
          for (let i = 0; i < toWrite.length; i += batchSize) {
            const slice = toWrite.slice(i, i + batchSize);
            const putTx = db.transaction([NOTES_STORE_ENTRIES], 'readwrite');
            const store = putTx.objectStore(NOTES_STORE_ENTRIES);
            for (const rec of slice) store.put(rec);
            await txDone(putTx);
          }

          // Commit metadata after all entry chunks succeed.
          const metaTx = db.transaction([NOTES_STORE_META], 'readwrite');
          metaTx.objectStore(NOTES_STORE_META).put({
            storeId: id,
            revision: nextRevision,
            generation: snapshot?.generation ?? existingMeta?.generation ?? '',
            structs: Array.isArray(snapshot?.structs)
              ? snapshot.structs
              : (Array.isArray(existingMeta?.structs) ? existingMeta.structs : []),
            cleared: Boolean(snapshot?.cleared),
            updatedAt: ts,
            migratedFromLocalStorage: snapshot?.migratedFromLocalStorage != null
              ? Boolean(snapshot.migratedFromLocalStorage)
              : Boolean(existingMeta?.migratedFromLocalStorage),
          });
          await txDone(metaTx);

          return { revision: nextRevision };
        }

        // OCC merge path (`replace === false`):
        // Read existing records & meta, merge without clobbering untouched entries
        // written by concurrent tabs, then write merged records.
        const buildMergedRecords = (existingMeta, existingRows) => {
          const currentRev = Number.isFinite(existingMeta?.revision) ? existingMeta.revision : 0;
          const requestedRev = Number.isFinite(snapshot?.revision)
            ? snapshot.revision
            : (Number.isFinite(snapshot?.rev) ? snapshot.rev : 0);
          const baseRev = Number.isFinite(snapshot?.baseRevision)
            ? snapshot.baseRevision
            : (Number.isFinite(snapshot?.revision) ? snapshot.revision : currentRev);
          const nextRevision = Math.max(currentRev + 1, requestedRev);

          const existingByComp = new Map();
          for (const row of Array.isArray(existingRows) ? existingRows : []) {
            if (!row || !VALID_KINDS.has(row.kind) || typeof row.key !== 'string') continue;
            existingByComp.set(makeCompositeKey(row.kind, row.key), row);
          }

          const recordsToPut = [];
          const handled = new Set();

          // 1. Apply explicit localDirty mutations first (caller-wins for keys edited in this tab).
          for (const [compKey, dirty] of localDirty.entries()) {
            const parsed = parseCompositeKey(compKey);
            if (!parsed || !dirty) continue;
            handled.add(compKey);
            const isDeleted = Boolean(dirty.deleted) || dirty.value == null;
            recordsToPut.push({
              storeId: id,
              kind: parsed.kind,
              key: parsed.key,
              value: isDeleted ? null : String(dirty.value),
              deleted: isDeleted,
              updatedAt: Number.isFinite(dirty.updatedAt) ? dirty.updatedAt : ts,
              rev: nextRevision,
            });
          }

          // 2. Apply incoming tombstones not already handled via localDirty.
          for (const [compKey, tomb] of incomingTombstones.entries()) {
            if (handled.has(compKey)) continue;
            const parsed = parseCompositeKey(compKey);
            if (!parsed) continue;
            const existing = existingByComp.get(compKey);
            const existingRev = Number.isFinite(existing?.rev) ? existing.rev : 0;
            const tombRev = Number.isFinite(tomb?.rev) ? tomb.rev : 0;
            const tombTs = Number.isFinite(tomb?.updatedAt) ? tomb.updatedAt : ts;
            // Keep newer remote live entry if remote rev > baseRev and remote is strictly newer.
            if (existing && !existing.deleted && existingRev > baseRev && existingRev > tombRev && (existing.updatedAt ?? 0) > tombTs) {
              handled.add(compKey);
              continue;
            }
            handled.add(compKey);
            recordsToPut.push({
              storeId: id,
              kind: parsed.kind,
              key: parsed.key,
              value: null,
              deleted: true,
              updatedAt: tombTs,
              rev: nextRevision,
            });
          }

          // 3. Apply incoming live entries, respecting newer concurrent remote entries/tombstones.
          for (const [compKey, item] of incomingLive.entries()) {
            if (handled.has(compKey)) continue;
            const existing = existingByComp.get(compKey);
            if (existing) {
              const existingRev = Number.isFinite(existing.rev) ? existing.rev : 0;
              // Another tab updated or deleted this key after our baseRevision: keep remote.
              if (existingRev > baseRev) {
                handled.add(compKey);
                continue;
              }
              // Unchanged value already persisted: skip redundant write.
              if (!existing.deleted && existing.value === item.value) {
                handled.add(compKey);
                continue;
              }
            }
            handled.add(compKey);
            recordsToPut.push({
              storeId: id,
              kind: item.kind,
              key: item.key,
              value: item.value,
              deleted: false,
              updatedAt: ts,
              rev: nextRevision,
            });
          }

          // Note: Any existing records in IDB not in incomingLive / incomingTombstones / localDirty
          // are untouched entries from another tab and are deliberately preserved!

          const nextMeta = {
            storeId: id,
            revision: nextRevision,
            generation: snapshot?.generation ?? existingMeta?.generation ?? '',
            structs: Array.isArray(snapshot?.structs)
              ? snapshot.structs
              : (Array.isArray(existingMeta?.structs) ? existingMeta.structs : []),
            cleared: Boolean(snapshot?.cleared),
            updatedAt: ts,
            migratedFromLocalStorage: snapshot?.migratedFromLocalStorage != null
              ? Boolean(snapshot.migratedFromLocalStorage)
              : Boolean(existingMeta?.migratedFromLocalStorage),
          };

          return { nextRevision, recordsToPut, nextMeta };
        };

        // Fast path: when total incoming items fit inside a single chunk, perform
        // read + OCC merge + write atomically inside ONE readwrite transaction.
        const estimatedWork = incomingLive.size + incomingTombstones.size + localDirty.size;
        if (estimatedWork <= batchSize) {
          const tx = db.transaction([NOTES_STORE_META, NOTES_STORE_ENTRIES], 'readwrite');
          const done = txDone(tx);
          const metaStore = tx.objectStore(NOTES_STORE_META);
          const entryStore = tx.objectStore(NOTES_STORE_ENTRIES);
          const [existingMeta, existingRows] = await Promise.all([
            requestToPromise(metaStore.get(id)),
            requestToPromise(entryStore.index(NOTES_INDEX_BY_STORE).getAll(id)),
          ]);
          const { nextRevision, recordsToPut, nextMeta } = buildMergedRecords(existingMeta, existingRows);
          for (const rec of recordsToPut) entryStore.put(rec);
          metaStore.put(nextMeta);
          await done;
          return { revision: nextRevision };
        }

        // Chunked path for large snapshots (> batchSize).
        const readTx = db.transaction([NOTES_STORE_META, NOTES_STORE_ENTRIES], 'readonly');
        const readDone = txDone(readTx);
        const [existingMeta, existingRows] = await Promise.all([
          requestToPromise(readTx.objectStore(NOTES_STORE_META).get(id)),
          requestToPromise(readTx.objectStore(NOTES_STORE_ENTRIES).index(NOTES_INDEX_BY_STORE).getAll(id)),
        ]);
        await readDone;

        const { nextRevision, recordsToPut, nextMeta } = buildMergedRecords(existingMeta, existingRows);
        for (let i = 0; i < recordsToPut.length; i += batchSize) {
          const slice = recordsToPut.slice(i, i + batchSize);
          const putTx = db.transaction([NOTES_STORE_ENTRIES], 'readwrite');
          const store = putTx.objectStore(NOTES_STORE_ENTRIES);
          for (const rec of slice) store.put(rec);
          await txDone(putTx);
        }

        const metaTx = db.transaction([NOTES_STORE_META], 'readwrite');
        metaTx.objectStore(NOTES_STORE_META).put(nextMeta);
        await txDone(metaTx);

        return { revision: nextRevision };
      } catch (err) {
        throw normalizeNotesIdbError(err, 'Failed to replace store in IndexedDB');
      }
    });
  }

  /**
   * Remove all entry records for `storeId` and mark `meta.cleared = true`.
   *
   * @param {string} storeId
   * @param {{ generation?: string, rev?: number, updatedAt?: number, chunkSize?: number }} [options]
   * @returns {Promise<{ revision: number }>}
   */
  clearStore(storeId, { generation, rev, updatedAt, chunkSize = DEFAULT_CHUNK_SIZE } = {}) {
    const id = normalizeStoreId(storeId);
    const batchSize = normalizeChunkSize(chunkSize);

    return this._enqueueWrite(async () => {
      const db = await this.open();
      try {
        const readTx = db.transaction([NOTES_STORE_META, NOTES_STORE_ENTRIES], 'readonly');
        const readDone = txDone(readTx);
        const [existingMeta, existingRows] = await Promise.all([
          requestToPromise(readTx.objectStore(NOTES_STORE_META).get(id)),
          requestToPromise(readTx.objectStore(NOTES_STORE_ENTRIES).index(NOTES_INDEX_BY_STORE).getAll(id)),
        ]);
        await readDone;

        const currentRev = Number.isFinite(existingMeta?.revision) ? existingMeta.revision : 0;
        const requestedRev = Number.isFinite(rev) ? rev : 0;
        const nextRevision = Math.max(currentRev + 1, requestedRev);
        const ts = Number.isFinite(updatedAt) ? updatedAt : Date.now();

        const keys = [];
        for (const row of Array.isArray(existingRows) ? existingRows : []) {
          if (row && typeof row.kind === 'string' && typeof row.key === 'string') {
            keys.push([id, row.kind, row.key]);
          }
        }

        for (let i = 0; i < keys.length; i += batchSize) {
          const slice = keys.slice(i, i + batchSize);
          const delTx = db.transaction([NOTES_STORE_ENTRIES], 'readwrite');
          const store = delTx.objectStore(NOTES_STORE_ENTRIES);
          for (const keyTuple of slice) store.delete(keyTuple);
          await txDone(delTx);
        }

        const metaTx = db.transaction([NOTES_STORE_META], 'readwrite');
        metaTx.objectStore(NOTES_STORE_META).put({
          storeId: id,
          revision: nextRevision,
          generation: generation ?? existingMeta?.generation ?? '',
          structs: [],
          cleared: true,
          updatedAt: ts,
          migratedFromLocalStorage: Boolean(existingMeta?.migratedFromLocalStorage),
        });
        await txDone(metaTx);

        return { revision: nextRevision };
      } catch (err) {
        throw normalizeNotesIdbError(err, 'Failed to clear store in IndexedDB');
      }
    });
  }

  /**
   * Persist a serialized compact `.hexproj` JSON string in the `projects` store.
   *
   * @param {string} projectKey
   * @param {string} compactJson
   * @param {{ revision?: number }} [options]
   * @returns {Promise<void>}
   */
  saveProject(projectKey, compactJson, { revision } = {}) {
    if (typeof projectKey !== 'string' || !projectKey) {
      return Promise.reject(normalizeNotesIdbError(new TypeError('projectKey must be a non-empty string'), 'Invalid projectKey'));
    }
    const payload = typeof compactJson === 'string' ? compactJson : String(compactJson ?? '');

    return this._enqueueWrite(async () => {
      const db = await this.open();
      try {
        const tx = db.transaction([NOTES_STORE_PROJECTS], 'readwrite');
        const done = txDone(tx);
        const store = tx.objectStore(NOTES_STORE_PROJECTS);
        const existing = await requestToPromise(store.get(projectKey));
        const currentRev = Number.isFinite(existing?.revision) ? existing.revision : 0;
        const nextRev = Number.isFinite(revision) ? Math.max(currentRev + 1, revision) : currentRev + 1;
        store.put({
          projectKey,
          payload,
          revision: nextRev,
          updatedAt: Date.now(),
        });
        await done;
      } catch (err) {
        throw normalizeNotesIdbError(err, 'Failed to save project to IndexedDB');
      }
    });
  }

  /**
   * Load a saved `.hexproj` JSON record from the `projects` store.
   *
   * @param {string} projectKey
   * @returns {Promise<{ payload: string, revision: number, updatedAt: number } | null>}
   */
  async loadProject(projectKey) {
    if (typeof projectKey !== 'string' || !projectKey) return null;
    const db = await this.open();
    try {
      const tx = db.transaction([NOTES_STORE_PROJECTS], 'readonly');
      const done = txDone(tx);
      const row = await requestToPromise(tx.objectStore(NOTES_STORE_PROJECTS).get(projectKey));
      await done;
      if (!row || typeof row.payload !== 'string') return null;
      return {
        payload: row.payload,
        revision: Number.isFinite(row.revision) ? row.revision : 0,
        updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
      };
    } catch (err) {
      throw normalizeNotesIdbError(err, 'Failed to load project from IndexedDB');
    }
  }

  /**
   * Wait for all currently queued write operations to finish.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    await this._writeQueue;
  }

  /**
   * Flush pending writes and close the database connection.
   *
   * @returns {Promise<void>}
   */
  async close() {
    if (this._closed && !this._db) return;
    this._closed = true;
    await this.flush();
    if (this._openPromise) {
      try { await this._openPromise; } catch { /* ignore */ }
    }
    if (this._db) {
      try { this._db.close(); } catch { /* ignore */ }
      this._db = null;
    }
    this._openPromise = null;
  }
}
