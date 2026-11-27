/**
 * 3-Tier Persistent TIL Pack Storage Abstraction (OPFS / IndexedDB / In-Memory LRU)
 * + SHA-256 Integrity Verification (browser SubtleCrypto & pure-JS fallback).
 * Spec: hex_ida_beyond_ida_design.md §10.1, §18.1
 * INV-005: ZERO imports from js/targets/architecture/.
 */

export const DEFAULT_STORAGE_LIMITS = Object.freeze({
  OPFS_MAX_BYTES: 64 * 1024 * 1024,
  IDB_MAX_BYTES: 24 * 1024 * 1024,
  MEMORY_MAX_BYTES: 8 * 1024 * 1024,
  IDB_DB_NAME: 'hex_til_pack_cache_v1',
  IDB_STORE_NAME: 'packs',
});

// ---------------------------------------------------------------------------
// Compact Pure-JS SHA-256 (works synchronously in Node, Worker, & Opaque Origin)
// ---------------------------------------------------------------------------
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x, n) {
  return (x >>> n) | (x << (32 - n));
}

export function sha256HexSync(input) {
  const data = input instanceof Uint8Array
    ? input
    : input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new TextEncoder().encode(String(input || ''));

  const bitLen = BigInt(data.length) * 8n;
  const paddedLen = Math.ceil((data.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(data, 0);
  padded[data.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(paddedLen - 8, Number((bitLen >> 32n) & 0xffffffffn), false);
  dv.setUint32(paddedLen - 4, Number(bitLen & 0xffffffffn), false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = dv.getUint32(off + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ ((~e) & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((x) => x.toString(16).padStart(8, '0'))
    .join('');
}

export async function sha256Hex(input) {
  const bytes = input instanceof Uint8Array
    ? input
    : input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new TextEncoder().encode(String(input || ''));
  if (globalThis.crypto && globalThis.crypto.subtle && typeof globalThis.crypto.subtle.digest === 'function') {
    try {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    } catch {
      // Fall back to pure JS SHA-256
    }
  }
  return sha256HexSync(bytes);
}

export async function verifySha256(bytes, expectedHex) {
  if (!expectedHex || typeof expectedHex !== 'string') {
    return { ok: false, actual: '', expected: String(expectedHex || '') };
  }
  const actual = await sha256Hex(bytes);
  const expected = expectedHex.trim().toLowerCase();
  return { ok: actual === expected, actual, expected };
}

// ---------------------------------------------------------------------------
// Tier S3: In-Memory LRU Storage (always available, Opaque Origin & Node safe)
// ---------------------------------------------------------------------------
export class MemoryTilStorage {
  constructor({ maxBytes = DEFAULT_STORAGE_LIMITS.MEMORY_MAX_BYTES, maxEntries = 24 } = {}) {
    this.tier = 'memory';
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.entries = new Map();
    this.totalBytes = 0;
    this._accessSeq = 0;
  }

  async get(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    entry.lastAccess = ++this._accessSeq;
    this.entries.set(key, entry);
    return { bytes: entry.bytes, meta: entry.meta };
  }

  async put(key, bytes, meta = {}) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u8.byteLength > this.maxBytes) {
      throw new Error(`MemoryTilStorage: item '${key}' (${u8.byteLength}B) exceeds maxBytes (${this.maxBytes}B)`);
    }
    if (this.entries.has(key)) {
      this.totalBytes -= this.entries.get(key).size;
      this.entries.delete(key);
    }
    while (
      this.entries.size > 0 &&
      (this.totalBytes + u8.byteLength > this.maxBytes || this.entries.size >= this.maxEntries)
    ) {
      const oldestKey = this.entries.keys().next().value;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      this.totalBytes -= oldest.size;
    }
    this.entries.set(key, {
      key,
      bytes: u8,
      meta: { ...meta, storedAt: Date.now() },
      size: u8.byteLength,
      lastAccess: ++this._accessSeq,
    });
    this.totalBytes += u8.byteLength;
    return true;
  }

  async delete(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.totalBytes -= entry.size;
    this.entries.delete(key);
    return true;
  }

  async has(key) {
    return this.entries.has(key);
  }

  async list() {
    return Array.from(this.entries.values()).map((e) => ({
      key: e.key,
      size: e.size,
      meta: e.meta,
      lastAccess: e.lastAccess,
    }));
  }

  async clear() {
    this.entries.clear();
    this.totalBytes = 0;
  }

  getStats() {
    return {
      tier: this.tier,
      count: this.entries.size,
      totalBytes: this.totalBytes,
      maxBytes: this.maxBytes,
      maxEntries: this.maxEntries,
    };
  }
}

// ---------------------------------------------------------------------------
// Tier S2: IndexedDB Storage with retry-safe _open() & maxBytes LRU eviction
// ---------------------------------------------------------------------------
export class IndexedDbTilStorage {
  constructor({
    dbName = DEFAULT_STORAGE_LIMITS.IDB_DB_NAME,
    storeName = DEFAULT_STORAGE_LIMITS.IDB_STORE_NAME,
    maxBytes = DEFAULT_STORAGE_LIMITS.IDB_MAX_BYTES,
    indexedDBImpl = null,
  } = {}) {
    this.tier = 'indexeddb';
    this.dbName = dbName;
    this.storeName = storeName;
    this.maxBytes = maxBytes;
    this._idb = indexedDBImpl || (typeof globalThis.indexedDB !== 'undefined' ? globalThis.indexedDB : null);
    this._dbPromise = null;
    this._accessSeq = 0;
    this._lastAccessCache = new Map();
  }

  isAvailable() {
    return Boolean(this._idb);
  }

  _nextAccessStamp() {
    const now = Date.now();
    this._accessSeq = Math.max(now, this._accessSeq + 1);
    return this._accessSeq;
  }

  _open() {
    if (!this._idb) return Promise.reject(new Error('IndexedDB unavailable'));
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise((resolve, reject) => {
      let req;
      try {
        req = this._idb.open(this.dbName, 1);
      } catch (err) {
        this._dbPromise = null;
        reject(err);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        this._dbPromise = null;
        reject(req.error || new Error('IndexedDB open failed'));
      };
      req.onblocked = () => {
        this._dbPromise = null;
        reject(new Error('IndexedDB open blocked'));
      };
    });
    return this._dbPromise;
  }

  async get(key) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const req = tx.objectStore(this.storeName).get(key);
      req.onsuccess = () => {
        const rec = req.result;
        if (!rec) return resolve(null);
        this._lastAccessCache.set(key, this._nextAccessStamp());
        resolve({ bytes: new Uint8Array(rec.bytes), meta: rec.meta || {} });
      };
      req.onerror = () => reject(req.error);
    });
  }

  async put(key, bytes, meta = {}) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u8.byteLength > this.maxBytes) {
      throw new Error(`IndexedDbTilStorage: item '${key}' (${u8.byteLength}B) exceeds maxBytes (${this.maxBytes}B)`);
    }
    const db = await this._open();
    const stamp = this._nextAccessStamp();
    this._lastAccessCache.set(key, stamp);

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const getAllReq = store.getAll();

      getAllReq.onsuccess = () => {
        const existing = Array.isArray(getAllReq.result) ? getAllReq.result : [];
        let totalBytes = 0;
        const others = [];
        for (const rec of existing) {
          if (!rec || rec.key === key) continue;
          const sz = rec.size ?? (rec.bytes ? rec.bytes.byteLength : 0);
          totalBytes += sz;
          const effLastAccess = Math.max(
            rec.lastAccess || 0,
            this._lastAccessCache.get(rec.key) || 0
          );
          others.push({ key: rec.key, size: sz, lastAccess: effLastAccess });
        }

        // Evict oldest lastAccess entries until new item fits within maxBytes
        if (totalBytes + u8.byteLength > this.maxBytes) {
          others.sort((a, b) => a.lastAccess - b.lastAccess);
          for (const victim of others) {
            if (totalBytes + u8.byteLength <= this.maxBytes) break;
            store.delete(victim.key);
            this._lastAccessCache.delete(victim.key);
            totalBytes -= victim.size;
          }
        }

        store.put({
          key,
          bytes: u8,
          meta: { ...meta, storedAt: Date.now() },
          size: u8.byteLength,
          lastAccess: stamp,
        });
      };

      getAllReq.onerror = () => reject(getAllReq.error || new Error('IndexedDB getAll failed'));
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB put transaction failed'));
    });
  }

  async delete(key) {
    const db = await this._open();
    this._lastAccessCache.delete(key);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      tx.objectStore(this.storeName).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async has(key) {
    return (await this.get(key)) !== null;
  }

  async list() {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const req = tx.objectStore(this.storeName).getAll();
      req.onsuccess = () => {
        resolve((req.result || []).map((r) => ({
          key: r.key,
          size: r.size || 0,
          meta: r.meta || {},
          lastAccess: Math.max(r.lastAccess || 0, this._lastAccessCache.get(r.key) || 0),
        })));
      };
      req.onerror = () => reject(req.error);
    });
  }

  async clear() {
    const db = await this._open();
    this._lastAccessCache.clear();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      tx.objectStore(this.storeName).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }
}

export function createTilStorage(options = {}) {
  if (options.preferMemory || typeof globalThis.indexedDB === 'undefined') {
    return new MemoryTilStorage(options);
  }
  try {
    const isOpaque = typeof globalThis.location !== 'undefined' && globalThis.location.origin === 'null';
    if (isOpaque) return new MemoryTilStorage(options);
  } catch {
    return new MemoryTilStorage(options);
  }
  return new IndexedDbTilStorage(options);
}
