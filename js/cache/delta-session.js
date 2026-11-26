/*
 * Lightweight Delta Session Persistence & BookmarkStore Core.
 *
 * Pure JS (zero DOM imports, zero js/semantics/ imports).
 * Persists ONLY lightweight user-authored deltas (renames, comments, vars,
 * types, structs, bookmarks, patches, project annotations) and minimal resume
 * pointers (last address/function/region/mode/route/history/goal).
 * Never persists raw binary bytes or derived analysis caches.
 */

export const DELTA_SESSION_FORMAT = 'hex-delta-session';
export const DELTA_SESSION_VERSION = 1;
export const MAX_BOOKMARKS = 500;
export const MAX_RECENT_DELTAS = 25;
export const MAX_DELTA_ENTRY_BYTES = 512 * 1024;      // 512 KiB per-binary
export const MAX_DELTA_TOTAL_BYTES = 2 * 1024 * 1024; // 2 MiB total localStorage budget

const DB_NAME = 'hex-delta-session-v1';
const DB_VERSION = 1;
const SESSIONS_STORE = 'sessions';
const RECENTS_STORE = 'recents';
const LS_PREFIX = 'hex.delta.v1.';
const LS_RECENTS_KEY = 'hex.delta.v1.recents';
const MAX_HISTORY_ENTRIES = 200;

const DECIMAL_RE = /^\d+$/;
const HEX_RE = /^0x[0-9a-f]+$/i;

/* ── Address & Value Helpers ─────────────────────────────────── */

function toBigIntAddress(value) {
  if (value == null) return null;
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) return null;
    return BigInt(value);
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    if (DECIMAL_RE.test(text) || HEX_RE.test(text)) {
      try {
        const parsed = BigInt(text);
        return parsed >= 0n ? parsed : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function toAddressDecimalString(value) {
  const big = toBigIntAddress(value);
  return big == null ? null : big.toString();
}

function stringOrNull(value, maxLen = 512) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLen) : null;
}

function toSafeSize(value) {
  if (typeof value === 'bigint') return value >= 0n ? value.toString() : null;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (DECIMAL_RE.test(trimmed)) {
      const num = Number(trimmed);
      return Number.isSafeInteger(num) ? num : trimmed;
    }
  }
  return null;
}

function byteLengthUtf8(text) {
  if (typeof TextEncoder === 'function') {
    return new TextEncoder().encode(text).byteLength;
  }
  return Buffer.byteLength(text, 'utf8');
}

function sanitizeJsonValue(value, depth = 0) {
  if (depth > 16 || value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return null;
  }
  if (value === null) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item, depth + 1));
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    // Zero-Bloat invariant: never serialize raw binary buffers/typed arrays.
    return null;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
      if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) continue;
      out[k] = sanitizeJsonValue(v, depth + 1);
    }
    return out;
  }
  return null;
}

function normalizeStringMap(input, { addressKeys = false, maxValueLen = 500 } = {}) {
  const out = {};
  if (!input) return out;
  const entries = input instanceof Map
    ? input.entries()
    : (typeof input === 'object' && !Array.isArray(input) ? Object.entries(input) : []);
  for (const [rawKey, rawVal] of entries) {
    if (rawKey === '__proto__' || rawKey === 'constructor' || rawKey === 'prototype') continue;
    if (rawVal == null) continue;
    const key = addressKeys ? toAddressDecimalString(rawKey) : String(rawKey).trim();
    if (!key) continue;
    const val = String(rawVal).slice(0, maxValueLen).trim();
    if (!val) continue;
    out[key] = val;
  }
  return out;
}

function normalizeBookmarkForStorage(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const addrStr = toAddressDecimalString(entry.addr ?? entry.address);
  if (!addrStr) return null;
  const name = entry.name != null && String(entry.name).trim()
    ? String(entry.name).trim().slice(0, 120)
    : null;
  const note = entry.note != null ? String(entry.note).slice(0, 500).trim() : '';
  const tag = entry.tag != null ? String(entry.tag).slice(0, 40).trim() : '';
  const createdAt = Number.isFinite(Number(entry.createdAt)) ? Number(entry.createdAt) : Date.now();
  return { addr: addrStr, name, note, tag, createdAt };
}

function hydrateBookmark(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const addr = toBigIntAddress(entry.addr ?? entry.address);
  if (addr == null) return null;
  const name = entry.name != null && String(entry.name).trim()
    ? String(entry.name).trim().slice(0, 120)
    : null;
  const note = entry.note != null ? String(entry.note).slice(0, 500).trim() : '';
  const tag = entry.tag != null ? String(entry.tag).slice(0, 40).trim() : '';
  const createdAt = Number.isFinite(Number(entry.createdAt)) ? Number(entry.createdAt) : Date.now();
  return { addr, name, note, tag, createdAt };
}

function normalizePatchForStorage(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const offset = toAddressDecimalString(entry.offset);
  if (!offset) return null;
  const before = Array.isArray(entry.before) || ArrayBuffer.isView(entry.before)
    ? Array.from(entry.before, (b) => Number(b) & 255)
    : [];
  const after = Array.isArray(entry.after) || ArrayBuffer.isView(entry.after)
    ? Array.from(entry.after, (b) => Number(b) & 255)
    : [];
  return {
    offset,
    before,
    after,
    addr: toAddressDecimalString(entry.addr),
    label: stringOrNull(entry.label, 120),
    reason: stringOrNull(entry.reason, 240),
  };
}

function hydratePatch(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const offset = toBigIntAddress(entry.offset);
  if (offset == null) return null;
  const before = Array.isArray(entry.before) ? entry.before.map((b) => Number(b) & 255) : [];
  const after = Array.isArray(entry.after) ? entry.after.map((b) => Number(b) & 255) : [];
  return {
    offset,
    before,
    after,
    addr: toBigIntAddress(entry.addr),
    label: stringOrNull(entry.label, 120),
    reason: stringOrNull(entry.reason, 240),
  };
}

function normalizeHistoryEntryForStorage(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const addr = toAddressDecimalString(entry.addr);
  if (!addr) return null;
  return {
    key: stringOrNull(entry.key, 200),
    regionId: stringOrNull(entry.regionId, 120),
    addr,
    mode: entry.mode === 'asm' || entry.mode === 'hex' ? entry.mode : null,
    label: stringOrNull(entry.label, 120),
  };
}

function hydrateHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const addr = toBigIntAddress(entry.addr);
  if (addr == null) return null;
  return {
    key: stringOrNull(entry.key, 200),
    regionId: stringOrNull(entry.regionId, 120),
    addr,
    mode: entry.mode === 'asm' || entry.mode === 'hex' ? entry.mode : null,
    label: stringOrNull(entry.label, 120),
  };
}

function normalizeFingerprint(fp) {
  const src = fp && typeof fp === 'object' && !Array.isArray(fp) ? fp : {};
  const sha256 = typeof src.sha256 === 'string' && src.sha256.trim()
    ? src.sha256.trim().toLowerCase().slice(0, 128)
    : null;
  const prefix = typeof src.prefix === 'string' && src.prefix.trim()
    ? src.prefix.trim().toLowerCase().slice(0, 64)
    : (sha256 ? sha256.slice(0, 16) : null);
  return {
    sha256,
    prefix,
    name: stringOrNull(src.name, 256),
    size: toSafeSize(src.size),
    format: stringOrNull(src.format, 64),
    sliceIndex: Number.isSafeInteger(src.sliceIndex) ? src.sliceIndex : -1,
    uuid: stringOrNull(src.uuid, 128),
    architecture: stringOrNull(src.architecture, 64),
  };
}

function normalizeLastGoal(goal) {
  if (!goal) return null;
  if (typeof goal === 'string') {
    const text = goal.trim().slice(0, 240);
    return text ? { text } : null;
  }
  if (typeof goal === 'object' && typeof goal.text === 'string') {
    const text = goal.text.trim().slice(0, 240);
    return text ? { text } : null;
  }
  return null;
}

function normalizeDeltaForStorage(input) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const rawDelta = src.delta && typeof src.delta === 'object' && !Array.isArray(src.delta) ? src.delta : {};
  const rawResume = src.resume && typeof src.resume === 'object' && !Array.isArray(src.resume) ? src.resume : {};

  const bookmarks = [];
  if (Array.isArray(rawDelta.bookmarks)) {
    const seen = new Set();
    for (const item of rawDelta.bookmarks.slice(-MAX_BOOKMARKS)) {
      const normalized = normalizeBookmarkForStorage(item);
      if (!normalized || seen.has(normalized.addr)) continue;
      seen.add(normalized.addr);
      bookmarks.push(normalized);
    }
  }

  const patches = [];
  if (Array.isArray(rawDelta.patches)) {
    for (const item of rawDelta.patches) {
      const normalized = normalizePatchForStorage(item);
      if (normalized) patches.push(normalized);
    }
  }

  const structs = Array.isArray(rawDelta.structs)
    ? rawDelta.structs.map((s) => sanitizeJsonValue(s)).filter((s) => s != null)
    : [];

  const projectAnnotations = Array.isArray(rawDelta.projectAnnotations)
    ? rawDelta.projectAnnotations.map((a) => sanitizeJsonValue(a)).filter((a) => a != null)
    : [];

  const delta = {
    names: normalizeStringMap(rawDelta.names, { addressKeys: true, maxValueLen: 120 }),
    comments: normalizeStringMap(rawDelta.comments, { addressKeys: true, maxValueLen: 500 }),
    vars: normalizeStringMap(rawDelta.vars, { addressKeys: false, maxValueLen: 120 }),
    types: normalizeStringMap(rawDelta.types, { addressKeys: false, maxValueLen: 80 }),
    structs,
    bookmarks,
    patches,
    projectAnnotations,
  };

  const history = Array.isArray(rawResume.history)
    ? rawResume.history
      .slice(-MAX_HISTORY_ENTRIES)
      .map(normalizeHistoryEntryForStorage)
      .filter(Boolean)
    : [];

  let historyIndex = -1;
  if (history.length > 0) {
    const rawIdx = Number(rawResume.historyIndex);
    historyIndex = Number.isSafeInteger(rawIdx)
      ? Math.max(0, Math.min(history.length - 1, rawIdx))
      : history.length - 1;
  }

  const resume = {
    lastAddress: toAddressDecimalString(rawResume.lastAddress),
    lastFunction: toAddressDecimalString(rawResume.lastFunction),
    lastRegionId: stringOrNull(rawResume.lastRegionId, 120),
    displayMode: rawResume.displayMode === 'asm' || rawResume.displayMode === 'hex'
      ? rawResume.displayMode
      : null,
    routePath: stringOrNull(rawResume.routePath, 240),
    history,
    historyIndex,
    lastGoal: normalizeLastGoal(rawResume.lastGoal),
  };

  const updatedAt = Number.isFinite(Number(src.updatedAt)) ? Number(src.updatedAt) : Date.now();
  const savedCount = countDeltaItems(delta);

  return {
    format: DELTA_SESSION_FORMAT,
    version: DELTA_SESSION_VERSION,
    fingerprint: normalizeFingerprint(src.fingerprint),
    updatedAt,
    savedCount,
    delta,
    resume,
  };
}

function hydrateDeltaRecord(stored) {
  if (!stored || typeof stored !== 'object') return null;
  const normalized = normalizeDeltaForStorage(stored);
  return {
    format: normalized.format,
    version: normalized.version,
    fingerprint: normalized.fingerprint,
    updatedAt: normalized.updatedAt,
    savedCount: normalized.savedCount,
    delta: {
      names: normalized.delta.names,
      comments: normalized.delta.comments,
      vars: normalized.delta.vars,
      types: normalized.delta.types,
      structs: normalized.delta.structs,
      bookmarks: normalized.delta.bookmarks.map(hydrateBookmark).filter(Boolean),
      patches: normalized.delta.patches.map(hydratePatch).filter(Boolean),
      projectAnnotations: normalized.delta.projectAnnotations,
    },
    resume: {
      lastAddress: toBigIntAddress(normalized.resume.lastAddress),
      lastFunction: toBigIntAddress(normalized.resume.lastFunction),
      lastRegionId: normalized.resume.lastRegionId,
      displayMode: normalized.resume.displayMode,
      routePath: normalized.resume.routePath,
      history: normalized.resume.history.map(hydrateHistoryEntry).filter(Boolean),
      historyIndex: normalized.resume.historyIndex,
      lastGoal: normalized.resume.lastGoal,
    },
  };
}

/* ── Exported Pure Helpers ───────────────────────────────────── */

export function makeDeltaKey(fingerprint) {
  if (!fingerprint || typeof fingerprint !== 'object') return null;
  const sha256 = typeof fingerprint.sha256 === 'string' ? fingerprint.sha256.trim().toLowerCase() : '';
  const prefix = typeof fingerprint.prefix === 'string' ? fingerprint.prefix.trim().toLowerCase() : '';
  const name = typeof fingerprint.name === 'string' ? fingerprint.name.trim() : '';
  const size = toSafeSize(fingerprint.size);
  const base = sha256 || prefix || (name && size != null ? `meta:${name}:${String(size)}` : '');
  if (!base) return null;
  const slicePart = Number.isSafeInteger(fingerprint.sliceIndex) && fingerprint.sliceIndex >= 0
    ? String(fingerprint.sliceIndex)
    : '';
  const uuidPart = typeof fingerprint.uuid === 'string' ? fingerprint.uuid.trim().toLowerCase() : '';
  const archPart = typeof fingerprint.architecture === 'string' ? fingerprint.architecture.trim().toLowerCase() : '';
  return [base, slicePart, uuidPart || archPart].join('|');
}

export function countDeltaItems(delta) {
  if (!delta || typeof delta !== 'object') return 0;
  const mapCount = (v) => {
    if (!v) return 0;
    if (v instanceof Map) return v.size;
    if (Array.isArray(v)) return v.length;
    if (typeof v === 'object') return Object.keys(v).length;
    return 0;
  };
  const arrCount = (v) => (Array.isArray(v) ? v.length : 0);
  return (
    mapCount(delta.names)
    + mapCount(delta.comments)
    + mapCount(delta.vars)
    + mapCount(delta.types)
    + arrCount(delta.structs)
    + arrCount(delta.bookmarks)
    + arrCount(delta.patches)
    + arrCount(delta.projectAnnotations)
  );
}

export function serializeDeltaJson(record) {
  const normalized = normalizeDeltaForStorage(record);
  return JSON.stringify(normalized, null, 2);
}

export function parseDeltaJson(text, expectedSha256 = null) {
  if (typeof text !== 'string') {
    return { ok: false, record: null, hashMismatch: false, error: 'delta-json-not-string' };
  }
  if (byteLengthUtf8(text) > MAX_DELTA_ENTRY_BYTES) {
    return { ok: false, record: null, hashMismatch: false, error: 'delta-json-too-large' };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, record: null, hashMismatch: false, error: 'delta-json-invalid-syntax' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, record: null, hashMismatch: false, error: 'delta-json-invalid-root' };
  }
  if (parsed.format !== DELTA_SESSION_FORMAT) {
    return { ok: false, record: null, hashMismatch: false, error: 'delta-json-invalid-format' };
  }
  if (parsed.version !== DELTA_SESSION_VERSION) {
    return { ok: false, record: null, hashMismatch: false, error: 'delta-json-unsupported-version' };
  }
  if (!parsed.delta || typeof parsed.delta !== 'object' || Array.isArray(parsed.delta)) {
    return { ok: false, record: null, hashMismatch: false, error: 'delta-json-invalid-delta' };
  }
  if (parsed.fingerprint != null && (typeof parsed.fingerprint !== 'object' || Array.isArray(parsed.fingerprint))) {
    return { ok: false, record: null, hashMismatch: false, error: 'delta-json-invalid-fingerprint' };
  }
  if (parsed.resume != null && (typeof parsed.resume !== 'object' || Array.isArray(parsed.resume))) {
    return { ok: false, record: null, hashMismatch: false, error: 'delta-json-invalid-resume' };
  }

  const record = hydrateDeltaRecord(parsed);
  const normExpected = typeof expectedSha256 === 'string' && expectedSha256.trim()
    ? expectedSha256.trim().toLowerCase()
    : null;
  const normActual = record.fingerprint?.sha256 || null;
  const hashMismatch = Boolean(normExpected && normActual && normExpected !== normActual);
  return { ok: true, record, hashMismatch, error: null };
}

/* ── BookmarkStore ───────────────────────────────────────────── */

export class BookmarkStore {
  constructor({ onChange = null, maxEntries = MAX_BOOKMARKS } = {}) {
    this.items = new Map();
    this.onChange = typeof onChange === 'function' ? onChange : null;
    const cap = Number(maxEntries);
    this._maxEntries = Number.isSafeInteger(cap) && cap > 0 ? Math.min(cap, MAX_BOOKMARKS) : MAX_BOOKMARKS;
    this._listeners = new Set();
  }

  get count() {
    return this.items.size;
  }

  _notify(event) {
    if (typeof this.onChange === 'function') {
      try { this.onChange(event); } catch { /* observer isolation */ }
    }
    for (const fn of this._listeners) {
      try { fn(event); } catch { /* observer isolation */ }
    }
  }

  subscribe(fn) {
    if (typeof fn !== 'function') throw new TypeError('bookmark-subscriber-invalid');
    this._listeners.add(fn);
    return () => { this._listeners.delete(fn); };
  }

  has(addr) {
    const k = toAddressDecimalString(addr);
    return k != null && this.items.has(k);
  }

  get(addr) {
    const k = toAddressDecimalString(addr);
    if (k == null) return null;
    const item = this.items.get(k);
    return item ? { ...item } : null;
  }

  list() {
    return Array.from(this.items.values(), (item) => ({ ...item }));
  }

  toggle(addr, meta = {}) {
    const big = toBigIntAddress(addr);
    if (big == null) return false;
    const k = big.toString();
    if (this.items.has(k)) {
      const prev = this.items.get(k);
      this.items.delete(k);
      this._notify({ type: 'remove', addr: big, item: prev ? { ...prev } : null });
      return false;
    }
    if (this.items.size >= this._maxEntries) {
      const oldestKey = this.items.keys().next().value;
      if (oldestKey !== undefined) this.items.delete(oldestKey);
    }
    const item = {
      addr: big,
      name: meta?.name != null && String(meta.name).trim()
        ? String(meta.name).trim().slice(0, 120)
        : null,
      note: meta?.note != null ? String(meta.note).slice(0, 500).trim() : '',
      tag: meta?.tag != null ? String(meta.tag).slice(0, 40).trim() : '',
      createdAt: Number.isFinite(Number(meta?.createdAt)) ? Number(meta.createdAt) : Date.now(),
    };
    this.items.set(k, item);
    this._notify({ type: 'add', addr: big, item: { ...item } });
    return true;
  }

  setNote(addr, { note, tag, name } = {}) {
    const big = toBigIntAddress(addr);
    if (big == null) return null;
    const k = big.toString();
    let item = this.items.get(k);
    if (!item) {
      if (this.items.size >= this._maxEntries) {
        const oldestKey = this.items.keys().next().value;
        if (oldestKey !== undefined) this.items.delete(oldestKey);
      }
      item = {
        addr: big,
        name: null,
        note: '',
        tag: '',
        createdAt: Date.now(),
      };
      this.items.set(k, item);
    }
    if (note !== undefined) item.note = note != null ? String(note).slice(0, 500).trim() : '';
    if (tag !== undefined) item.tag = tag != null ? String(tag).slice(0, 40).trim() : '';
    if (name !== undefined) {
      item.name = name != null && String(name).trim() ? String(name).trim().slice(0, 120) : null;
    }
    const copy = { ...item };
    this._notify({ type: 'update', addr: big, item: copy });
    return copy;
  }

  remove(addr) {
    const big = toBigIntAddress(addr);
    if (big == null) return false;
    const k = big.toString();
    if (!this.items.has(k)) return false;
    const prev = this.items.get(k);
    this.items.delete(k);
    this._notify({ type: 'remove', addr: big, item: prev ? { ...prev } : null });
    return true;
  }

  clear({ silent = false } = {}) {
    const had = this.items.size > 0;
    this.items.clear();
    if (!silent && had) this._notify({ type: 'clear' });
    return had;
  }

  restore(items, { silent = false } = {}) {
    this.items.clear();
    if (Array.isArray(items)) {
      for (const raw of items.slice(-this._maxEntries)) {
        const hydrated = hydrateBookmark(raw);
        if (!hydrated) continue;
        const k = hydrated.addr.toString();
        if (this.items.size >= this._maxEntries && !this.items.has(k)) {
          const oldestKey = this.items.keys().next().value;
          if (oldestKey !== undefined) this.items.delete(oldestKey);
        }
        this.items.set(k, hydrated);
      }
    }
    if (!silent) this._notify({ type: 'restore', count: this.items.size });
    return this.items.size;
  }
}

/* ── IndexedDB Helpers ───────────────────────────────────────── */

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('indexeddb-request-failed'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('indexeddb-transaction-aborted'));
    tx.onerror = () => reject(tx.error || new Error('indexeddb-transaction-failed'));
  });
}

/* ── DeltaSessionStore ───────────────────────────────────────── */

export class DeltaSessionStore {
  constructor(options = {}) {
    this.indexedDB = options.indexedDB === undefined ? globalThis.indexedDB : options.indexedDB;
    this.localStorage = options.localStorage === undefined ? globalThis.localStorage : options.localStorage;
    this.maxEntryBytes = Number.isSafeInteger(options.maxEntryBytes) && options.maxEntryBytes > 0
      ? options.maxEntryBytes
      : MAX_DELTA_ENTRY_BYTES;
    this.maxTotalBytes = Number.isSafeInteger(options.maxTotalBytes) && options.maxTotalBytes > 0
      ? options.maxTotalBytes
      : MAX_DELTA_TOTAL_BYTES;
    this.maxRecents = Number.isSafeInteger(options.maxRecents) && options.maxRecents > 0
      ? options.maxRecents
      : MAX_RECENT_DELTAS;
    this.dbPromise = null;
    this._writeChain = Promise.resolve();
    this.lastError = null;
  }

  async _openDb() {
    if (!this.indexedDB || typeof this.indexedDB.open !== 'function') return null;
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      let settled = false;
      let request;
      try {
        request = this.indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
          db.createObjectStore(SESSIONS_STORE, { keyPath: 'deltaKey' });
        }
        if (!db.objectStoreNames.contains(RECENTS_STORE)) {
          const recents = db.createObjectStore(RECENTS_STORE, { keyPath: 'deltaKey' });
          recents.createIndex('lastOpenedAt', 'lastOpenedAt', { unique: false });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        if (settled) {
          try { db.close?.(); } catch { /* ignore */ }
          return;
        }
        settled = true;
        db.onversionchange = () => {
          try { db.close?.(); } catch { /* ignore */ }
          this.dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        reject(request.error || new Error('delta-session-db-open-failed'));
      };
      request.onblocked = () => {
        if (settled) return;
        settled = true;
        reject(new Error('delta-session-db-open-blocked'));
      };
    }).catch(() => {
      this.dbPromise = null;
      return null;
    });
    return this.dbPromise;
  }

  _lsKey(deltaKey) {
    return `${LS_PREFIX}${deltaKey}`;
  }

  _readLsRecents() {
    if (!this.localStorage) return [];
    try {
      const raw = this.localStorage.getItem(LS_RECENTS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((r) => r && typeof r.deltaKey === 'string') : [];
    } catch {
      return [];
    }
  }

  _writeLsRecents(recents) {
    if (!this.localStorage) return false;
    try {
      this.localStorage.setItem(LS_RECENTS_KEY, JSON.stringify(recents.slice(0, this.maxRecents)));
      return true;
    } catch {
      return false;
    }
  }

  _measureLsUsage(excludeKey = null) {
    if (!this.localStorage) return { totalBytes: 0, entries: [] };
    let totalBytes = 0;
    const entries = [];
    try {
      for (let i = 0; i < this.localStorage.length; i++) {
        const k = this.localStorage.key(i);
        if (typeof k !== 'string' || !k.startsWith(LS_PREFIX) || k === LS_RECENTS_KEY) continue;
        if (k === excludeKey) continue;
        const val = this.localStorage.getItem(k);
        const bytes = val != null ? byteLengthUtf8(val) : 0;
        totalBytes += bytes;
        entries.push({ storageKey: k, deltaKey: k.slice(LS_PREFIX.length), bytes });
      }
    } catch { /* ignore */ }
    return { totalBytes, entries };
  }

  _saveLocalStorage(deltaKey, storageRecord, json, bytes, recentEntry) {
    if (!this.localStorage) {
      this.lastError = { code: 'STORAGE_UNAVAILABLE', message: 'localStorage unavailable' };
      return false;
    }
    const targetKey = this._lsKey(deltaKey);
    const recents = this._readLsRecents().filter((r) => r.deltaKey !== deltaKey);
    const recentsByKey = new Map(recents.map((r) => [r.deltaKey, r]));

    // Enforce total budget via LRU eviction of oldest entries.
    const { totalBytes, entries } = this._measureLsUsage(targetKey);
    let currentTotal = totalBytes;
    const evictable = entries.sort((a, b) => {
      const ta = Number(recentsByKey.get(a.deltaKey)?.lastOpenedAt || 0);
      const tb = Number(recentsByKey.get(b.deltaKey)?.lastOpenedAt || 0);
      return ta - tb; // oldest first
    });

    const evictedKeys = new Set();
    while (currentTotal + bytes > this.maxTotalBytes && evictable.length > 0) {
      const victim = evictable.shift();
      try { this.localStorage.removeItem(victim.storageKey); } catch { /* ignore */ }
      currentTotal -= victim.bytes;
      evictedKeys.add(victim.deltaKey);
    }

    if (currentTotal + bytes > this.maxTotalBytes) {
      this.lastError = {
        code: 'TOTAL_QUOTA_EXCEEDED',
        bytes,
        maxTotalBytes: this.maxTotalBytes,
      };
      return false;
    }

    // Attempt write; on QuotaExceededError evict oldest remaining entries and retry.
    let wrote = false;
    while (!wrote) {
      try {
        this.localStorage.setItem(targetKey, json);
        wrote = true;
      } catch (err) {
        if (evictable.length === 0) {
          this.lastError = { code: err?.name || 'QUOTA_EXCEEDED', message: err?.message || String(err) };
          return false;
        }
        const victim = evictable.shift();
        try { this.localStorage.removeItem(victim.storageKey); } catch { /* ignore */ }
        evictedKeys.add(victim.deltaKey);
      }
    }

    const nextRecents = [
      recentEntry,
      ...recents.filter((r) => !evictedKeys.has(r.deltaKey)),
    ].sort((a, b) => Number(b.lastOpenedAt || 0) - Number(a.lastOpenedAt || 0));

    if (nextRecents.length > this.maxRecents) {
      const overflow = nextRecents.splice(this.maxRecents);
      for (const old of overflow) {
        try { this.localStorage.removeItem(this._lsKey(old.deltaKey)); } catch { /* ignore */ }
      }
    }

    this._writeLsRecents(nextRecents);
    this.lastError = null;
    return true;
  }

  async _saveIndexedDB(db, deltaKey, storageRecord, recentEntry) {
    const tx = db.transaction([SESSIONS_STORE, RECENTS_STORE], 'readwrite');
    const sessions = tx.objectStore(SESSIONS_STORE);
    const recents = tx.objectStore(RECENTS_STORE);
    sessions.put({ deltaKey, ...storageRecord });
    recents.put(recentEntry);
    await txDone(tx);

    // Enforce maxRecents cap (25) by pruning oldest entries.
    try {
      const readTx = db.transaction([RECENTS_STORE], 'readonly');
      const readDone = txDone(readTx);
      const allRecents = await idbRequest(readTx.objectStore(RECENTS_STORE).getAll());
      await readDone;
      if (Array.isArray(allRecents) && allRecents.length > this.maxRecents) {
        const sorted = allRecents.slice().sort(
          (a, b) => Number(b.lastOpenedAt || 0) - Number(a.lastOpenedAt || 0),
        );
        const victims = sorted.slice(this.maxRecents);
        const pruneTx = db.transaction([SESSIONS_STORE, RECENTS_STORE], 'readwrite');
        const sStore = pruneTx.objectStore(SESSIONS_STORE);
        const rStore = pruneTx.objectStore(RECENTS_STORE);
        for (const v of victims) {
          if (v?.deltaKey) {
            sStore.delete(v.deltaKey);
            rStore.delete(v.deltaKey);
          }
        }
        await txDone(pruneTx);
      }
    } catch { /* best-effort pruning */ }

    this.lastError = null;
    return true;
  }

  async save(deltaKey, payload) {
    if (typeof deltaKey !== 'string' || !deltaKey.trim()) {
      this.lastError = { code: 'INVALID_DELTA_KEY', message: 'deltaKey is required' };
      return false;
    }
    const cleanKey = deltaKey.trim();
    const task = async () => {
      const storageRecord = normalizeDeltaForStorage(payload);
      const json = JSON.stringify(storageRecord);
      const bytes = byteLengthUtf8(json);
      if (bytes > this.maxEntryBytes) {
        this.lastError = {
          code: 'ENTRY_TOO_LARGE',
          bytes,
          maxBytes: this.maxEntryBytes,
        };
        return false;
      }

      const recentEntry = {
        deltaKey: cleanKey,
        name: storageRecord.fingerprint.name,
        size: storageRecord.fingerprint.size,
        format: storageRecord.fingerprint.format,
        architecture: storageRecord.fingerprint.architecture,
        sha256: storageRecord.fingerprint.sha256,
        prefix: storageRecord.fingerprint.prefix,
        sliceIndex: storageRecord.fingerprint.sliceIndex,
        uuid: storageRecord.fingerprint.uuid,
        savedCount: storageRecord.savedCount,
        lastOpenedAt: storageRecord.updatedAt,
        updatedAt: storageRecord.updatedAt,
        bytes,
      };

      const db = await this._openDb();
      if (db) {
        try {
          return await this._saveIndexedDB(db, cleanKey, storageRecord, recentEntry);
        } catch {
          // Fall back to localStorage if IDB transaction fails.
        }
      }
      return this._saveLocalStorage(cleanKey, storageRecord, json, bytes, recentEntry);
    };

    const pending = this._writeChain.then(task, task);
    this._writeChain = pending.catch(() => false);
    return pending;
  }

  async load(deltaKey) {
    if (typeof deltaKey !== 'string' || !deltaKey.trim()) return null;
    const cleanKey = deltaKey.trim();

    const db = await this._openDb();
    if (db) {
      try {
        const tx = db.transaction([SESSIONS_STORE], 'readonly');
        const done = txDone(tx);
        const raw = await idbRequest(tx.objectStore(SESSIONS_STORE).get(cleanKey));
        await done;
        if (raw && raw.format === DELTA_SESSION_FORMAT && raw.version === DELTA_SESSION_VERSION) {
          return hydrateDeltaRecord(raw);
        }
      } catch {
        // Fall through to localStorage fallback.
      }
    }

    if (this.localStorage) {
      try {
        const rawText = this.localStorage.getItem(this._lsKey(cleanKey));
        if (!rawText) return null;
        const parsed = JSON.parse(rawText);
        if (parsed && parsed.format === DELTA_SESSION_FORMAT && parsed.version === DELTA_SESSION_VERSION) {
          return hydrateDeltaRecord(parsed);
        }
      } catch {
        return null;
      }
    }
    return null;
  }

  async remove(deltaKey) {
    if (typeof deltaKey !== 'string' || !deltaKey.trim()) return false;
    const cleanKey = deltaKey.trim();
    const task = async () => {
      let removed = false;
      const db = await this._openDb();
      if (db) {
        try {
          const tx = db.transaction([SESSIONS_STORE, RECENTS_STORE], 'readwrite');
          tx.objectStore(SESSIONS_STORE).delete(cleanKey);
          tx.objectStore(RECENTS_STORE).delete(cleanKey);
          await txDone(tx);
          removed = true;
        } catch { /* fall through */ }
      }
      if (this.localStorage) {
        try {
          this.localStorage.removeItem(this._lsKey(cleanKey));
          const recents = this._readLsRecents().filter((r) => r.deltaKey !== cleanKey);
          this._writeLsRecents(recents);
          removed = true;
        } catch { /* ignore */ }
      }
      return removed;
    };
    const pending = this._writeChain.then(task, task);
    this._writeChain = pending.catch(() => false);
    return pending;
  }

  async listRecent({ onlyWithDelta = false, limit = 10 } = {}) {
    const cap = Number.isSafeInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 10;
    let items = null;

    const db = await this._openDb();
    if (db) {
      try {
        const tx = db.transaction([RECENTS_STORE], 'readonly');
        const done = txDone(tx);
        const all = await idbRequest(tx.objectStore(RECENTS_STORE).getAll());
        await done;
        if (Array.isArray(all)) items = all;
      } catch {
        items = null;
      }
    }

    if (items === null) {
      items = this._readLsRecents();
    }

    const sorted = items
      .filter((entry) => entry && typeof entry.deltaKey === 'string')
      .sort((a, b) => Number(b.lastOpenedAt || 0) - Number(a.lastOpenedAt || 0));

    const filtered = onlyWithDelta
      ? sorted.filter((entry) => Number(entry.savedCount || 0) > 0)
      : sorted;

    return filtered.slice(0, cap).map((entry) => ({ ...entry }));
  }

  async clearAll() {
    const task = async () => {
      let cleared = false;
      const db = await this._openDb();
      if (db) {
        try {
          const tx = db.transaction([SESSIONS_STORE, RECENTS_STORE], 'readwrite');
          tx.objectStore(SESSIONS_STORE).clear();
          tx.objectStore(RECENTS_STORE).clear();
          await txDone(tx);
          cleared = true;
        } catch { /* fall through */ }
      }
      if (this.localStorage) {
        try {
          const toDelete = [];
          for (let i = 0; i < this.localStorage.length; i++) {
            const k = this.localStorage.key(i);
            if (typeof k === 'string' && k.startsWith(LS_PREFIX)) toDelete.push(k);
          }
          for (const k of toDelete) this.localStorage.removeItem(k);
          cleared = true;
        } catch { /* ignore */ }
      }
      return cleared;
    };
    const pending = this._writeChain.then(task, task);
    this._writeChain = pending.catch(() => false);
    return pending;
  }
}
