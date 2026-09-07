export const ANALYSIS_CACHE_SCHEMA = 1;
export const ANALYSIS_CACHE_FALLBACK = Object.freeze({ MEMORY:'memory', ERROR:'error' });
const ALLOWED_FIELDS = new Set(['formatMetadata', 'functionSeeds', 'stringsIndex', 'imports', 'analysisSummaries']);
const CANONICAL_ARTIFACT_ID = /^artifact_[0-9a-f]{32}$/i;

function stableValue(value) {
  if (value == null) return value;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object') throw new TypeError('analysis-cache-settings-invalid');
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length) throw new TypeError('analysis-cache-settings-invalid');
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) throw new TypeError('analysis-cache-settings-invalid');
    }
    if (Object.getOwnPropertyNames(value).length !== value.length + 1) {
      throw new TypeError('analysis-cache-settings-invalid');
    }
    return value.map(stableValue);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) throw new TypeError('analysis-cache-settings-invalid');
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError('analysis-cache-settings-invalid');
  const out = {};
  for (const key of Object.keys(value).sort()) Object.defineProperty(out, key, { value:stableValue(value[key]), enumerable:true, configurable:true, writable:true });
  return out;
}

function analysisIdentity(options = {}) {
  const candidate = options.analyzerVersion ?? options.analysisVersion ?? options.buildVersion;
  if (candidate != null && (typeof candidate !== 'string' || candidate.length === 0)) {
    throw new TypeError('analysis-cache-version-invalid');
  }
  const version = candidate ?? 'unknown';
  const settings = stableValue(options.semanticOptions ?? options.analysisSettings ?? options.settings ?? {});
  return `${version}:${JSON.stringify(settings)}`;
}

function canonicalArtifactId(options = {}) {
  const raw = options?.artifactId;
  if (raw == null) return null;
  if (typeof raw !== 'string') throw new TypeError('analysis-cache-artifact-id-not-canonical');
  const value = raw.trim();
  if (!value) return null;
  if (!CANONICAL_ARTIFACT_ID.test(value)) throw new TypeError('analysis-cache-artifact-id-not-canonical');
  return value.toLowerCase();
}

function canonicalBinaryHash(value, { required = false } = {}) {
  if (value == null) {
    if (required) throw new TypeError('binary hash is required');
    return null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError('analysis-cache-binary-hash-invalid');
  return value.trim();
}

export class AnalysisCache {
  constructor(options = {}) {
    this.schemaVersion = options.schemaVersion ?? ANALYSIS_CACHE_SCHEMA;
    this.dbName = options.dbName || 'hex-analysis-cache';
    this.indexedDB = options.indexedDB === undefined ? globalThis.indexedDB : options.indexedDB;
    this.analysisIdentity = analysisIdentity(options);
    this.fallbackMode = options.fallbackMode ?? ANALYSIS_CACHE_FALLBACK.MEMORY;
    if (!Object.values(ANALYSIS_CACHE_FALLBACK).includes(this.fallbackMode)) throw new TypeError('analysis-cache-fallback-mode-invalid');
    if (options.memory != null && !(options.memory instanceof Map)) throw new TypeError('analysis-cache-memory-backend-invalid');
    this.memory = options.memory || (!this.indexedDB && this.fallbackMode === ANALYSIS_CACHE_FALLBACK.MEMORY ? new Map() : null);
    this._db = null;
    this._dbPromise = null;
    this._idbFailed = false;
  }

  legacyKey(hash) { return `${this.schemaVersion}:${this.analysisIdentity}:${canonicalBinaryHash(hash, { required:true })}`; }
  canonicalKey(artifactId) {
    const id = canonicalArtifactId({ artifactId });
    if (!id) throw new TypeError('canonical artifact id is required');
    return `artifact:${id}`;
  }
  key(hash, options = {}) {
    const artifactId = canonicalArtifactId(options);
    const binaryHash = canonicalBinaryHash(hash, { required:!artifactId });
    return artifactId ? this.canonicalKey(artifactId) : this.legacyKey(binaryHash);
  }

  capabilities() {
    return Object.freeze({
      backend:this.memory ? 'memory' : 'indexeddb',
      persistent:!this.memory && !!this.indexedDB?.open,
      fallbackMode:this.fallbackMode,
      canonicalCompatibility:true,
    });
  }

  #fallback(error) {
    this._idbFailed = true;
    try { this._db?.close?.(); } catch { /* best effort */ }
    this._db = null;
    this.lastIndexedDBError = error || null;
    if (this.fallbackMode === ANALYSIS_CACHE_FALLBACK.ERROR) throw (error || new Error('IndexedDB unavailable'));
    if (!this.memory) this.memory = new Map();
    return this.memory;
  }

  #validRecord(record, hash, artifactId) {
    if (!record || record.schemaVersion !== this.schemaVersion) return false;
    if (artifactId) {
      // Canonical artifact identity binds the binary, but derived analysis is
      // still version/settings-sensitive. Do not let the artifact route bypass
      // the same semantic cache identity enforced by the legacy route (#197).
      return record.canonicalArtifactId === artifactId
        && record.analysisIdentity === this.analysisIdentity
        && (!hash || record.binaryHash === hash);
    }
    return record.binaryHash === hash && record.analysisIdentity === this.analysisIdentity && !record.canonicalArtifactId;
  }

  #isCorruptOrStale(record, artifactId) {
    if (!record || typeof record !== 'object') return true;
    if (record.schemaVersion !== this.schemaVersion) return true;
    if (artifactId) {
      if (record.canonicalArtifactId !== artifactId) return true;
      if (!CANONICAL_ARTIFACT_ID.test(record.canonicalArtifactId)) return true;
      if (typeof record.binaryHash !== 'string' || record.binaryHash.length === 0) return true;
    } else {
      if (!record.binaryHash || typeof record.binaryHash !== 'string') return true;
    }
    return false;
  }

  async get(hash, options = {}) {
    const artifactId = canonicalArtifactId(options);
    const binaryHash = canonicalBinaryHash(hash, { required:false });
    if (!binaryHash && !artifactId) return null;
    const key = this.key(binaryHash, { artifactId });
    let record;
    if (this.memory) record = this.memory.get(key) || null;
    else {
      try { record = await this.#idbGet(key); }
      catch (error) { const memory = this.#fallback(error); record = memory.get(key) || null; }
    }
    if (!record) return null;
    if (this.#isCorruptOrStale(record, artifactId)) {
      await this.delete(binaryHash, { artifactId });
      return null;
    }
    if (!this.#validRecord(record, binaryHash, artifactId)) {
      return null;
    }
    return structuredCloneSafe(record.data);
  }

  async put(hash, data = {}, options = {}) {
    const binaryHash = canonicalBinaryHash(hash, { required:true });
    const artifactId = canonicalArtifactId(options);
    const clean = {};
    for (const [key, value] of Object.entries(data)) if (ALLOWED_FIELDS.has(key)) clean[key] = value;
    const snapshot = structuredCloneSafe(clean);
    const record = {
      key:this.key(binaryHash, { artifactId }),
      schemaVersion:this.schemaVersion,
      analysisIdentity:this.analysisIdentity,
      binaryHash,
      canonicalArtifactId:artifactId,
      updatedAt:Date.now(),
      data:snapshot,
    };
    if (this.memory) this.memory.set(record.key, record);
    else {
      try { await this.#idbPut(record); }
      catch (error) { this.#fallback(error).set(record.key, record); }
    }
    return structuredCloneSafe(snapshot);
  }

  async delete(hash, options = {}) {
    const artifactId = canonicalArtifactId(options);
    const binaryHash = canonicalBinaryHash(hash, { required:!artifactId });
    const key = this.key(binaryHash, { artifactId });
    if (this.memory) { this.memory.delete(key); return; }
    try {
      const db = await this.#db();
      const tx = db.transaction('entries', 'readwrite');
      await transactionMutationPromise(tx, tx.objectStore('entries').delete(key));
    } catch (error) { this.#fallback(error).delete(key); }
  }

  async invalidateStale() {
    const stale = (key, record) => {
      if (record?.canonicalArtifactId) {
        if (!CANONICAL_ARTIFACT_ID.test(record.canonicalArtifactId)) return true;
        return record.schemaVersion !== this.schemaVersion
          || record.analysisIdentity !== this.analysisIdentity
          || key !== this.canonicalKey(record.canonicalArtifactId);
      }
      return record?.schemaVersion !== this.schemaVersion || record?.analysisIdentity !== this.analysisIdentity || !key.startsWith(`${this.schemaVersion}:${this.analysisIdentity}:`);
    };
    if (this.memory) {
      let removed = 0;
      for (const [key, record] of this.memory) {
        if (stale(key, record)) { this.memory.delete(key); removed++; }
      }
      return removed;
    }
    try {
      const db = await this.#db();
      return await new Promise((resolve, reject) => {
        let removed = 0;
        const tx = db.transaction('entries', 'readwrite');
        const req = tx.objectStore('entries').openCursor();
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          if (stale(cursor.key, cursor.value)) { cursor.delete(); removed++; }
          cursor.continue();
        };
        tx.oncomplete = () => resolve(removed);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      });
    } catch (error) { this.#fallback(error); return 0; }
  }

  async clear() {
    if (this.memory) { this.memory.clear(); return; }
    try {
      const db = await this.#db();
      const tx = db.transaction('entries', 'readwrite');
      await transactionMutationPromise(tx, tx.objectStore('entries').clear());
    } catch (error) { this.#fallback(error).clear(); }
  }

  async #db() {
    if (this._idbFailed || !this.indexedDB?.open) throw this.lastIndexedDBError || new Error('IndexedDB unavailable');
    if (this._db) return this._db;
    if (this._dbPromise) return this._dbPromise;

    const opening = new Promise((resolve, reject) => {
      let req;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      try { req = this.indexedDB.open(this.dbName, 1); } catch (error) { fail(error); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath: 'key' });
      };
      req.onsuccess = () => {
        const db = req.result;
        if (settled) {
          try { db?.close?.(); } catch { /* best effort */ }
          return;
        }
        db.onversionchange = () => {
          try { db?.close?.(); } catch { /* best effort */ }
          if (this._db === db) this._db = null;
        };
        settled = true;
        resolve(db);
      };
      req.onerror = () => fail(req.error || new Error('IndexedDB open failed'));
      req.onblocked = () => fail(new Error('IndexedDB open blocked'));
    });
    this._dbPromise = opening;
    try {
      const db = await opening;
      if (this._idbFailed) {
        try { db?.close?.(); } catch { /* best effort */ }
        throw this.lastIndexedDBError || new Error('IndexedDB unavailable');
      }
      this._db = db;
      return db;
    } finally {
      if (this._dbPromise === opening) this._dbPromise = null;
    }
  }

  async #idbGet(key) { const db = await this.#db(); return requestPromise(db.transaction('entries', 'readonly').objectStore('entries').get(key)); }
  async #idbPut(record) {
    const db = await this.#db();
    const tx = db.transaction('entries', 'readwrite');
    await transactionMutationPromise(tx, tx.objectStore('entries').put(record));
  }
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionMutationPromise(transaction, request) {
  const completion = new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
  return Promise.all([requestPromise(request), completion]).then(() => undefined);
}

function fallbackClone(value, seen = new WeakMap()) {
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) return new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    return value.slice ? value.slice() : new value.constructor(value);
  }
  if (value instanceof Map) { const out = new Map(); seen.set(value, out); for (const [k, v] of value) out.set(fallbackClone(k, seen), fallbackClone(v, seen)); return out; }
  if (value instanceof Set) { const out = new Set(); seen.set(value, out); for (const v of value) out.add(fallbackClone(v, seen)); return out; }
  if (Array.isArray(value)) { const out = []; seen.set(value, out); for (const v of value) out.push(fallbackClone(v, seen)); return out; }
  const out = {}; seen.set(value, out); for (const [k, v] of Object.entries(value)) Object.defineProperty(out, k, { value:fallbackClone(v, seen), enumerable:true, configurable:true, writable:true }); return out;
}

function structuredCloneSafe(value) { if (typeof structuredClone === 'function') return structuredClone(value); return fallbackClone(value); }