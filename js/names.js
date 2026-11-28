/*
 * 自分で付けた名前とメモ（IDA でいう Rename / Comment）。
 *
 * 解析でいちばん効くのは、じつは高度なアルゴリズムではなく
 * 「分かったことにその場で名前を付ける」ことです。sub_1004A2C0 のままだと
 * 10 分後にはもう何だったか忘れますが、`ダメージ計算` と付けておけば
 * 呼び出し元の一覧を見るだけで流れが読めます。
 *
 * ここに置くもの:
 *   - 関数やアドレスに付けた名前   nameOf(addr) / setName(addr, name)
 *   - 行に書いたメモ               comment(addr) / setComment(addr, text)
 *   - 関数の中の変数の呼び名       varName(func, key) / setVarName(...)
 *   - 引数・戻り値に決めた型       typeOf(func, key) / setType(...)
 *
 * 保存先はブラウザの IndexedDB（利用不可環境では localStorage）で、ファイルごとに分かれています
 * （内容fingerprint・active slice UUID/archで見分ける）。どこにも送信しません。
 */

import { asByteSource } from './binary/source.js';
import { hashByteSource, sha256TreeByteSource } from './platform/hash.js';
import {
  MAX_PROJECT_BYTES,
  MAX_NAME_LENGTH,
  MAX_COMMENT_LENGTH,
  MAX_TYPE_LENGTH,
} from './project/limits.js';

const PREFIX = 'hex.notes.';
export const MAX_NOTES_BYTES = MAX_PROJECT_BYTES;   // 16 MiB（MAX_PROJECT_BYTES と統一）
export { MAX_NAME_LENGTH, MAX_COMMENT_LENGTH, MAX_TYPE_LENGTH };
const SYNC_CHANNEL_NAME = 'hex.notes.sync.v1';
const NOTE_KEY_CACHE = new WeakMap(); // File/ByteSource -> resolved slice identities
const SNAPSHOT_MISSING = 'missing';
const SNAPSHOT_VALID = 'valid';
const SNAPSHOT_TOMBSTONE = 'tombstone';
const SNAPSHOT_INVALID = 'invalid';
const SNAPSHOT_UNAVAILABLE = 'unavailable';
const STORE_KINDS = ['names', 'comments', 'vars', 'types'];
let noteGenerationCounter = 0;

/** Opaque identity for one committed base snapshot and its delta overlay. */
function nextNoteGeneration() {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  } catch { /* deterministic fallback below keeps old browsers usable */ }
  noteGenerationCounter += 1;
  return `${Date.now().toString(36)}-${noteGenerationCounter.toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function normalizeSaveError(error, fallbackCode = 'IDB_ERROR') {
  if (error && typeof error === 'object' && typeof error.code === 'string' && error.code) {
    return {
      code: error.code,
      message: error.message || String(error),
      ...(error.cause ? { cause: error.cause } : {}),
    };
  }
  const code = error?.name === 'QuotaExceededError' ? 'QUOTA_EXCEEDED' : (error?.name || fallbackCode);
  return {
    code,
    message: error?.message || String(error || ''),
  };
}

function iterEntries(source) {
  if (!source) return [];
  if (source instanceof Map) return source.entries();
  if (Array.isArray(source)) return source;
  if (typeof source === 'object') return Object.entries(source);
  return [];
}

/** BigInt でも Number でも同じ鍵になるように、10 進の文字列にそろえる。 */
function key(addr) {
  if (addr == null) return '';
  if (typeof addr === 'bigint') return addr.toString();
  if (typeof addr === 'number') {
    if (!Number.isSafeInteger(addr)) return '';
    return BigInt(addr).toString();
  }
  if (typeof addr === 'string') {
    // Decimal/hex strings are exact identities and must not pass through
    // Number, which silently rounds > 2^53 addresses into each other (#5909).
    const text = addr.trim();
    if (!text) return '';
    try {
      if (/^-?(?:0x[0-9a-f]+|\d+)$/i.test(text)) {
        const negative = text.startsWith('-');
        const parsed = BigInt(negative ? text.slice(1) : text);
        return (negative ? -parsed : parsed).toString();
      }
    } catch { /* fall through: not an address */ }
    return '';
  }
  return '';
}

/**
 * このファイルを見分けるための鍵。
 * 同じアプリを開き直したら、前に付けた名前がそのまま戻ってくる。
 */
/**
 * 旧版（fingerprint導入前）が使っていた鍵。
 * 2026-08-13以前の版は active slice を区別せず、
 * name|size|最初に見つかったUUID だけで保存していた。
 * 新形式へ一度だけコピーするために正確な旧式を残しておく。
 */
export function legacyNoteKeyFor(file, fileInfo, _sliceIndex = null) {
  const parts=[];
  if (file?.name) parts.push(file.name);
  if (file?.size != null) parts.push(String(file.size));
  const slices=fileInfo?.slices || [];
  const firstWithUuid=slices.find((entry)=>entry?.info?.uuid);
  if (firstWithUuid?.info?.uuid) parts.push(firstWithUuid.info.uuid);
  return parts.length ? parts.join('|') : null;
}

export function canonicalLegacyNoteSliceIndex(fileInfo) {
  const slices=fileInfo?.slices || [];
  if (!slices.length) return -1;
  let index=slices.findIndex((entry)=>entry?.info?.isArm64);
  if (index < 0) index=slices.findIndex((entry)=>entry?.info);
  return index;
}

export function legacyNoteKeyForSlice(file, fileInfo, sliceIndex) {
  return canonicalLegacyNoteSliceIndex(fileInfo) === sliceIndex
    ? legacyNoteKeyFor(file, fileInfo)
    : null;
}

export async function legacyV2NoteKeyFor(file, fileInfo, sliceIndex) {
  if (!file) return null;
  const slices = fileInfo && fileInfo.slices || [];
  const slice = Number.isInteger(sliceIndex) && sliceIndex >= 0 ? slices[sliceIndex] : null;
  const info = slice && slice.info;
  const identity = [
    'v2', String(file.size == null ? 0 : file.size),
    info && info.uuid || '', info && info.cpu || '', info && info.cpuSub || '',
    slice && slice.offset != null ? slice.offset.toString() : '',
  ].join('|');
  const chunk = 64 * 1024;
  const size = Number(file.size || 0);
  const starts = Array.from(new Set([0, Math.max(0, Math.floor(size / 2) - Math.floor(chunk / 2)), Math.max(0, size - chunk)]));
  const pieces = [new TextEncoder().encode(identity)];
  for (const sampleStart of starts) {
    const bytes = new Uint8Array(await file.slice(sampleStart, Math.min(size, sampleStart + chunk)).arrayBuffer());
    pieces.push(bytes);
  }
  const total = pieces.reduce((n, piece) => n + piece.length, 0);
  const input = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) { input.set(piece, at); at += piece.length; }
  let digest;
  if (globalThis.crypto && globalThis.crypto.subtle) {
    digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input));
  } else {
    let h = 2166136261;
    for (const b of input) { h ^= b; h = Math.imul(h, 16777619); }
    digest = Uint8Array.from([(h >>> 24) & 255, (h >>> 16) & 255, (h >>> 8) & 255, h & 255]);
  }
  return identity + '|sha256:' + Array.from(digest).map((b) => b.toString(16).padStart(2, '0')).join('');
}


function noteSliceIdentityParts(file, fileInfo, sliceIndex) {
  if (!file) return null;
  const source = asByteSource(file);
  const slices = fileInfo && fileInfo.slices || [];
  const slice = Number.isInteger(sliceIndex) && sliceIndex >= 0 ? slices[sliceIndex] : null;
  const info = slice && slice.info;
  let sliceOffset = null, sliceSize = null;
  if (slice && slice.offset != null && slice.size != null) {
    try {
      const offset = BigInt(slice.offset), size = BigInt(slice.size);
      if (offset >= 0n && size >= 0n && offset <= source.size && size <= source.size - offset) {
        sliceOffset = offset; sliceSize = size;
      }
    } catch { /* invalid coordinates remain explicitly unbound */ }
  }
  return {
    sourceSize:source.size.toString(),
    uuid:info && info.uuid || '',
    cpu:info && info.cpu || '',
    cpuSub:info && info.cpuSub || '',
    architecture:info && (info.architecture || info.arch) || slice?.capability?.architecture || '',
    sliceOffset:sliceOffset == null ? '' : sliceOffset.toString(),
    sliceSize:sliceSize == null ? '' : sliceSize.toString(),
  };
}

function isLegacyV3DigestKey(value) {
  // v1 tree identities and the pre-WebCrypto FNV fallback are the only
  // historical digest namespaces this migration boundary may recover when a
  // current digest was computed but has not yet been persisted.
  return /(?:^|\|)(?:sha256tree:v1|fnv1a64):/.test(value);
}

/** Exact note namespace without a second full traversal of the active slice. */
export function noteKeyFromBinaryId(file, fileInfo, sliceIndex, binaryId) {
  if (typeof binaryId !== 'string' || !binaryId.trim()) throw new TypeError('note-binary-id-required');
  const p = noteSliceIdentityParts(file, fileInfo, sliceIndex);
  if (!p) return null;
  return ['v4', binaryId.trim(), p.sourceSize, p.uuid, p.cpu, p.cpuSub, p.architecture, p.sliceOffset, p.sliceSize].join('|');
}

/**
 * Locate an already-persisted v3 namespace by its cheap identity prefix.  The
 * expensive sha256tree suffix is already part of the localStorage key, so
 * migration does not need to recompute it.
 */
export function findLegacyV3NoteKey(file, fileInfo, sliceIndex, storage = globalThis.localStorage) {
  if (!storage || !file) return null;
  const p = noteSliceIdentityParts(file, fileInfo, sliceIndex);
  if (!p) return null;
  const identity = ['v3', p.sourceSize, p.uuid, p.cpu, p.cpuSub, p.sliceOffset, p.sliceSize].join('|');
  const prefix = PREFIX + identity + '|';
  try {
    const matches = new Set();
    for (let i = 0; i < storage.length; i++) {
      const candidate = storage.key(i);
      if (typeof candidate !== 'string' || !candidate.startsWith(prefix)) continue;
      if (candidate.includes('.delta.', prefix.length)) continue;
      matches.add(candidate.slice(PREFIX.length));
    }
    const cacheable = (typeof file === 'object' && file !== null) || typeof file === 'function';
    const cachedKey = cacheable ? NOTE_KEY_CACHE.get(file)?.get(identity) : null;
    if (cachedKey) {
      if (matches.has(cachedKey)) return cachedKey;
      // A current v2 key in the in-memory cache must not hide the one old v1
      // namespace that still needs migration.  Require a single explicitly
      // recognized legacy digest so a stale/ambiguous namespace remains
      // conservative.
      if (matches.size === 1) {
        const [legacy] = matches;
        if (isLegacyV3DigestKey(legacy)) return legacy;
      }
      return null;
    }
    if (matches.size === 1) {
      return matches.values().next().value;
    }
    return null;
  } catch { return null; }
}

export async function noteKeyFor(file, fileInfo, sliceIndex, options = {}) {
  if (!file) return null;
  const slices = fileInfo && fileInfo.slices || [];
  const slice = Number.isInteger(sliceIndex) && sliceIndex >= 0 ? slices[sliceIndex] : null;
  const info = slice && slice.info;
  const source = asByteSource(file);
  let content = source;
  let sliceOffset = null;
  let sliceSize = null;
  if (slice && slice.offset != null && slice.size != null) {
    try {
      sliceOffset = BigInt(slice.offset);
      sliceSize = BigInt(slice.size);
      if (sliceOffset >= 0n && sliceSize >= 0n && sliceOffset <= source.size && sliceSize <= source.size - sliceOffset) {
        content = source.subrange(sliceOffset, sliceSize);
      } else { sliceOffset = null; sliceSize = null; }
    } catch { sliceOffset = null; sliceSize = null; }
  }
  const identity = [
    'v3', source.size.toString(),
    info && info.uuid || '', info && info.cpu || '', info && info.cpuSub || '',
    sliceOffset == null ? '' : sliceOffset.toString(),
    sliceSize == null ? '' : sliceSize.toString(),
  ].join('|');
  const cacheable = (typeof file === 'object' && file !== null) || typeof file === 'function';
  let cache = cacheable ? NOTE_KEY_CACHE.get(file) : null;
  if (cache?.has(identity)) return cache.get(identity);
  if (options.signal?.aborted) {
    const error=new Error('note identity cancelled'); error.name='AbortError'; error.code='ABORT_ERR'; throw error;
  }
  let digest;
  try {
    digest = await sha256TreeByteSource(content, { signal:options.signal, onProgress:options.onProgress });
  } catch (error) {
    if (error?.code !== 'SHA256_UNAVAILABLE') throw error;
    digest = await hashByteSource(content, { signal:options.signal, onProgress:options.onProgress });
  }
  const result = identity + '|' + digest;
  if (cacheable) {
    if (!cache) { cache=new Map(); NOTE_KEY_CACHE.set(file,cache); }
    cache.set(identity,result);
  }
  return result;
}

export class NoteStore {
  constructor(id, legacyIds = [], options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    this.id = id || null;
    this.legacyIds = Array.from(new Set((legacyIds || []).filter((x) => x && x !== this.id)));
    this._maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : MAX_NOTES_BYTES;
    this._hasCustomStorage = Object.prototype.hasOwnProperty.call(opts, 'storage');
    this._customStorage = this._hasCustomStorage ? opts.storage : null;
    this._windowObj = Object.prototype.hasOwnProperty.call(opts, 'windowObj')
      ? opts.windowObj
      : (typeof window !== 'undefined' ? window : null);
    this._idb = opts.idb || null;
    this._useIdb = Boolean(this._idb && this.id);
    this._enableSync = opts.enableSync !== false && Boolean(this.id);
    this._tabId = nextNoteGeneration();
    this._revCounter = 0;
    this._idbRevision = 0;
    this._idbPendingWrites = 0;
    this._localDirty = new Map();
    this._pingKey = this.id ? `${PREFIX}ping.${this.id}` : null;
    this._disposed = false;
    this._idbQueue = Promise.resolve();
    this._channel = null;
    this._ownsChannel = false;
    this._onStorage = null;
    this._onBroadcast = null;
    this.onSaveError = typeof opts.onSaveError === 'function' ? opts.onSaveError : null;
    this.onSaveSuccess = typeof opts.onSaveSuccess === 'function' ? opts.onSaveSuccess : null;
    this.migratedFrom = null;
    this.legacyCandidate = null;
    this.lastSaveError = null;
    this.lastMutationSaved = true;
    this._snapshotBytes = 0;
    this._snapshotState = SNAPSHOT_MISSING;
    this._snapshotLoadError = null;
    this._snapshotGeneration = null;
    this._deltaBytes = new Map();
    this._deltaTotalBytes = 0;
    this._deltaScanComplete = true;
    this._unreadableDeltaKeys = new Set();
    this._cleanupPending = false;
    this._deltaPrefix = this.id ? `${PREFIX}${this.id}.delta.` : null;
    this.names = new Map();      // addr -> 名前
    this.comments = new Map();   // addr -> メモ
    this.vars = new Map();       // 'func:key' -> 呼び名
    this.types = new Map();      // 'func:key' -> 型
    this.structs = [];           // 自分で作った構造体（types.js が読む）
    this.dirty = false;
    this.onChange = null;
    this._listeners = new Set();
    this.load();
    this._setupSync(opts.broadcastChannel || null);
  }

  _storage() {
    if (this._hasCustomStorage) return this._customStorage;
    return typeof localStorage !== 'undefined' ? localStorage : null;
  }

  _setupSync(providedChannel) {
    if (!this._enableSync || !this.id) return;
    if (this._windowObj && typeof this._windowObj.addEventListener === 'function') {
      this._onStorage = (event) => this._handleStorageEvent(event);
      try { this._windowObj.addEventListener('storage', this._onStorage); }
      catch { this._onStorage = null; }
    }
    if (providedChannel) {
      this._channel = providedChannel;
      this._ownsChannel = false;
    } else if (typeof globalThis.BroadcastChannel === 'function') {
      try {
        this._channel = new globalThis.BroadcastChannel(SYNC_CHANNEL_NAME);
        this._channel.unref?.();
        this._ownsChannel = true;
      } catch {
        this._channel = null;
        this._ownsChannel = false;
      }
    }
    if (this._channel) {
      this._onBroadcast = (event) => this._handleBroadcastMessage(event?.data ?? event);
      if (typeof this._channel.addEventListener === 'function') {
        this._channel.addEventListener('message', this._onBroadcast);
      } else {
        this._channel.onmessage = this._onBroadcast;
      }
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._windowObj && this._onStorage && typeof this._windowObj.removeEventListener === 'function') {
      try { this._windowObj.removeEventListener('storage', this._onStorage); } catch { /* ignore */ }
    }
    if (this._channel) {
      if (this._onBroadcast && typeof this._channel.removeEventListener === 'function') {
        try { this._channel.removeEventListener('message', this._onBroadcast); } catch { /* ignore */ }
      } else if (this._channel.onmessage === this._onBroadcast) {
        try { this._channel.onmessage = null; } catch { /* ignore */ }
      }
      if (this._ownsChannel && typeof this._channel.close === 'function') {
        try { this._channel.close(); } catch { /* ignore */ }
      }
    }
    this._onStorage = null;
    this._onBroadcast = null;
    this._channel = null;
    this._ownsChannel = false;
  }

  setOnChange(fn) {
    this.onChange = typeof fn === 'function' ? fn : null;
  }

  subscribe(fn) {
    if (typeof fn !== 'function') throw new TypeError('note-subscriber-invalid');
    this._listeners.add(fn);
    return () => { this._listeners.delete(fn); };
  }

  _notifyChange(kind, detail = null) {
    const event = { kind, detail, count: this.count, remote: kind === 'remote-sync' };
    if (typeof this.onChange === 'function') {
      try { this.onChange(event); }
      catch { /* observer isolation */ }
    }
    for (const fn of this._listeners) {
      try { fn(event); }
      catch { /* observer isolation */ }
    }
  }

  _markLocalDirty(kind, recordKey, value) {
    const rev = ++this._revCounter;
    const updatedAt = Date.now();
    this._localDirty.set(`${kind}:${recordKey}`, {
      kind,
      key: String(recordKey),
      value: value == null ? null : String(value),
      deleted: value == null,
      rev,
      updatedAt,
    });
    return { rev, updatedAt };
  }

  _snapshotObject(generation = null) {
    return {
      v: 2,
      generation: generation || this._snapshotGeneration || nextNoteGeneration(),
      names: Object.fromEntries(this.names),
      comments: Object.fromEntries(this.comments),
      vars: Object.fromEntries(this.vars),
      types: Object.fromEntries(this.types),
      structs: this.structs,
    };
  }

  _broadcastSync(payload) {
    if (!this._channel || this._disposed || !this.id) return;
    try {
      this._channel.postMessage({
        tabId: this._tabId,
        storeId: this.id,
        ...payload,
      });
    } catch { /* ignore cross-tab broadcast failure */ }
  }

  _writePing(rev) {
    const storage = this._storage();
    if (!storage || !this._pingKey || this._disposed) return;
    try {
      storage.setItem(this._pingKey, JSON.stringify({
        tabId: this._tabId,
        rev,
        ts: Date.now(),
      }));
    } catch { /* ping is best effort */ }
  }

  _updateIdbRevision(revision) {
    if (Number.isFinite(revision) && revision > this._idbRevision) {
      this._idbRevision = revision;
    }
  }

  _queueIdbWrite(workFn, onDone = null) {
    this._idbPendingWrites++;
    const task = this._idbQueue.then(async () => {
      try {
        if (this._disposed) return;
        const result = await workFn();
        if (this._disposed) return;
        this._updateIdbRevision(result?.revision);
        onDone?.(result);
        if (this._idbPendingWrites <= 1) {
          if (this._localDirty.size === 0) this.dirty = false;
          this.lastMutationSaved = true;
          this.lastSaveError = null;
          this.onSaveSuccess?.();
        }
      } catch (error) {
        if (this._disposed) return;
        this.dirty = true;
        this.lastMutationSaved = false;
        this.lastSaveError = normalizeSaveError(error);
        this.onSaveError?.(this.lastSaveError);
      } finally {
        this._idbPendingWrites = Math.max(0, this._idbPendingWrites - 1);
      }
    });
    this._idbQueue = task;
    return task;
  }

  async flush() {
    await this._idbQueue;
    if (this._idb && typeof this._idb.flush === 'function') {
      await this._idb.flush();
    }
  }

  async saveAsync({ replace = false } = {}) {
    if (!this._useIdb) return this.save({ replace });
    const ok = this.save({ replace });
    if (!ok) return false;
    await this.flush();
    return this.lastSaveError == null;
  }

  async hydrateFromIdb() {
    if (!this._useIdb || !this._idb || this._disposed) return { found: false, migrated: false };
    let loaded;
    try {
      loaded = await this._idb.loadStore(this.id);
    } catch (error) {
      this.lastSaveError = normalizeSaveError(error);
      this.onSaveError?.(this.lastSaveError);
      return { found: false, migrated: false, error: this.lastSaveError };
    }
    if (this._disposed) return { found: false, migrated: false };
    if (loaded?.found) {
      const tombstones = loaded.tombstones instanceof Map
        ? loaded.tombstones
        : new Map(Object.entries(loaded.tombstones || {}));
      if (loaded.meta?.cleared) {
        for (const kind of STORE_KINDS) {
          const map = this._mapForDelta(kind);
          for (const k of [...map.keys()]) {
            if (!this._localDirty.has(`${kind}:${k}`)) map.delete(k);
          }
        }
        this._snapshotState = SNAPSHOT_TOMBSTONE;
      } else {
        this._snapshotState = SNAPSHOT_VALID;
      }
      this._updateIdbRevision(loaded.meta?.revision);
      for (const kind of STORE_KINDS) {
        const map = this._mapForDelta(kind);
        const incoming = loaded.entries?.[kind];
        const incomingKeys = new Set();
        for (const [k, v] of iterEntries(incoming)) {
          const keyStr = String(k);
          incomingKeys.add(keyStr);
          const dirtyKey = `${kind}:${keyStr}`;
          if (this._localDirty.has(dirtyKey)) continue;
          if (tombstones.has(dirtyKey)) {
            map.delete(keyStr);
            continue;
          }
          map.set(keyStr, String(v));
        }
        if (!loaded.meta?.cleared) {
          for (const k of [...map.keys()]) {
            if (!incomingKeys.has(k) && !this._localDirty.has(`${kind}:${k}`)) {
              map.delete(k);
            }
          }
        }
        for (const [tKey] of tombstones) {
          if (!tKey.startsWith(`${kind}:`) || this._localDirty.has(tKey)) continue;
          map.delete(tKey.slice(kind.length + 1));
        }
      }
      if (Array.isArray(loaded.meta?.structs) && (!this.dirty || this.structs.length === 0)) {
        this.structs = loaded.meta.structs.slice();
      }
      if (typeof loaded.meta?.generation === 'string' && loaded.meta.generation) {
        this._snapshotGeneration = loaded.meta.generation;
      }
      this._notifyChange('remote-sync', { source: 'idb-hydrate' });
      return { found: true, migrated: false };
    }
    const hasLocalData = this.count > 0 || this.structs.length > 0 || this._snapshotState === SNAPSHOT_VALID;
    if (hasLocalData) {
      try {
        const res = await this._idb.replaceStore(
          this.id,
          { ...this._snapshotObject(), migratedFromLocalStorage: true },
          { replace: true },
        );
        if (this._disposed) return { found: false, migrated: false };
        this._updateIdbRevision(res?.revision);
        this._clearDeltas();
        return { found: false, migrated: true };
      } catch (error) {
        this.lastSaveError = normalizeSaveError(error);
        this.onSaveError?.(this.lastSaveError);
        return { found: false, migrated: false, error: this.lastSaveError };
      }
    }
    return { found: false, migrated: false };
  }

  /* ── タブ間同期受信 ───────────────────────────────────── */

  _mergeRemoteSnapshot(o, { replace = false } = {}) {
    if (!o || typeof o !== 'object') return;
    if (o.cleared === true) {
      for (const kind of STORE_KINDS) {
        const map = this._mapForDelta(kind);
        for (const k of [...map.keys()]) {
          if (!this._localDirty.has(`${kind}:${k}`)) map.delete(k);
        }
      }
      if (!this.dirty) this.structs = [];
      this._snapshotState = SNAPSHOT_TOMBSTONE;
      if (typeof o.generation === 'string' && o.generation) this._snapshotGeneration = o.generation;
      return;
    }
    for (const kind of STORE_KINDS) {
      const map = this._mapForDelta(kind);
      const section = o[kind];
      const remoteObj = section && typeof section === 'object' && !Array.isArray(section) ? section : {};
      if (replace) {
        map.clear();
        for (const [k, v] of Object.entries(remoteObj)) map.set(k, String(v));
      } else {
        for (const k of [...map.keys()]) {
          if (!Object.prototype.hasOwnProperty.call(remoteObj, k) && !this._localDirty.has(`${kind}:${k}`)) {
            map.delete(k);
          }
        }
        for (const [k, v] of Object.entries(remoteObj)) {
          if (!this._localDirty.has(`${kind}:${k}`)) map.set(k, String(v));
        }
      }
    }
    if (Array.isArray(o.structs) && (replace || !this.dirty || this.structs.length === 0)) {
      this.structs = o.structs.slice();
    }
    this._snapshotState = SNAPSHOT_VALID;
    if (typeof o.generation === 'string' && o.generation) this._snapshotGeneration = o.generation;
  }

  _handleStorageEvent(event) {
    if (this._disposed || !this.id || !event) return;
    const changedKey = event.key;
    if (changedKey === this._pingKey) {
      if (!event.newValue) return;
      try {
        const ping = JSON.parse(event.newValue);
        if (ping?.tabId === this._tabId) return;
      } catch { /* treat as external ping */ }
      if (this._useIdb) void this.hydrateFromIdb();
      return;
    }
    if (this._useIdb) return;
    if (changedKey === PREFIX + this.id) {
      if (!event.newValue) return;
      try {
        const o = JSON.parse(event.newValue);
        this._validatePayload(o);
        if (o.generation && o.generation === this._snapshotGeneration) return;
        this._mergeRemoteSnapshot(o);
        this._snapshotBytes = new TextEncoder().encode(event.newValue).byteLength;
        this._notifyChange('remote-sync', { op: o.cleared ? 'clear' : 'save', generation: o.generation || null });
      } catch { /* ignore malformed remote event */ }
      return;
    }
    if (this._deltaPrefix && typeof changedKey === 'string' && changedKey.startsWith(this._deltaPrefix)) {
      if (!event.newValue) return;
      try {
        const delta = JSON.parse(event.newValue);
        if (!delta || typeof delta !== 'object') return;
        const map = this._mapForDelta(delta.kind);
        if (!map || typeof delta.key !== 'string') return;
        if (delta.generation != null && this._snapshotGeneration != null && delta.generation !== this._snapshotGeneration) return;
        const dirtyKey = `${delta.kind}:${delta.key}`;
        if (delta.deleted) map.delete(delta.key);
        else map.set(delta.key, String(delta.value ?? ''));
        this._localDirty.delete(dirtyKey);
        this._notifyChange('remote-sync', {
          op: 'delta',
          kind: delta.kind,
          key: delta.key,
          value: delta.deleted ? null : String(delta.value ?? ''),
        });
      } catch { /* ignore malformed remote delta */ }
    }
  }

  _handleBroadcastMessage(msg) {
    if (this._disposed || !msg || typeof msg !== 'object') return;
    if (msg.tabId === this._tabId || msg.storeId !== this.id) return;
    if (msg.op === 'delta') {
      const map = this._mapForDelta(msg.kind);
      if (!map || typeof msg.key !== 'string') return;
      if (msg.deleted || msg.value == null) map.delete(msg.key);
      else map.set(msg.key, String(msg.value));
      this._localDirty.delete(`${msg.kind}:${msg.key}`);
      this._notifyChange('remote-sync', {
        op: 'delta',
        kind: msg.kind,
        key: msg.key,
        value: msg.deleted || msg.value == null ? null : String(msg.value),
      });
      return;
    }
    if (msg.op === 'clear') {
      this.names.clear();
      this.comments.clear();
      this.vars.clear();
      this.types.clear();
      this.structs = [];
      this._localDirty.clear();
      this._snapshotState = SNAPSHOT_TOMBSTONE;
      if (typeof msg.generation === 'string' && msg.generation) this._snapshotGeneration = msg.generation;
      this._notifyChange('remote-sync', { op: 'clear', generation: msg.generation || null });
      return;
    }
    if (msg.op === 'save') {
      if (this._useIdb) {
        void this.hydrateFromIdb();
        return;
      }
      if (msg.snapshot) {
        this._mergeRemoteSnapshot(msg.snapshot, { replace: Boolean(msg.replace) });
      } else {
        const storage = this._storage();
        try {
          const raw = storage?.getItem(PREFIX + this.id);
          if (raw) {
            const o = JSON.parse(raw);
            this._validatePayload(o);
            this._mergeRemoteSnapshot(o, { replace: Boolean(msg.replace) });
          }
        } catch { /* ignore */ }
      }
      this._notifyChange('remote-sync', { op: 'save', generation: msg.generation || null });
    }
  }

  /* ── 読み書き ─────────────────────────────────────────── */

  _applyPayload(o) {
    for (const [k, v] of Object.entries(o.names || {})) this.names.set(k, v);
    for (const [k, v] of Object.entries(o.comments || {})) this.comments.set(k, v);
    for (const [k, v] of Object.entries(o.vars || {})) this.vars.set(k, v);
    for (const [k, v] of Object.entries(o.types || {})) this.types.set(k, v);
    this.structs = Array.isArray(o.structs) ? o.structs : [];
  }

  _validatePayload(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('invalid-notes-snapshot');
    if (Object.prototype.hasOwnProperty.call(o, 'generation') &&
        (typeof o.generation !== 'string' || !o.generation)) {
      throw new Error('invalid-notes-snapshot');
    }
    if (o.cleared === true) return;
    for (const field of STORE_KINDS) {
      const value = o[field];
      if (value != null && (typeof value !== 'object' || Array.isArray(value))) {
        throw new Error('invalid-notes-snapshot');
      }
    }
    if (o.structs != null && !Array.isArray(o.structs)) throw new Error('invalid-notes-snapshot');
  }

  _snapshotFailure(state, error) {
    this._snapshotState = state;
    this._snapshotBytes = 0;
    this._snapshotGeneration = null;
    this._snapshotLoadError = error || null;
    this.lastSaveError = {
      code: state === SNAPSHOT_UNAVAILABLE ? 'SNAPSHOT_READ_ERROR' : 'INVALID_SNAPSHOT',
      message: error?.message || String(error || ''),
    };
  }

  load() {
    if (!this.id) return;
    const storage = this._storage();
    if (!storage) return;
    this._cleanupPending = false;
    let raw = null;
    try { raw = storage.getItem(PREFIX + this.id); }
    catch (error) {
      this._snapshotFailure(SNAPSHOT_UNAVAILABLE, error);
      this._loadDeltas({ apply: false });
      return;
    }
    if (raw !== null) {
      try {
        const bytes = new TextEncoder().encode(raw).byteLength;
        const o = JSON.parse(raw);
        this._validatePayload(o);
        const generation = typeof o.generation === 'string' ? o.generation : null;
        if (o && o.cleared === true) {
          this._snapshotBytes = bytes;
          this._snapshotState = SNAPSHOT_TOMBSTONE;
          this._snapshotGeneration = generation;
          this._snapshotLoadError = null;
          this.dirty = false; this.lastSaveError = null; this.lastMutationSaved = true;
          this.migratedFrom = null; this.legacyCandidate = null;
          this._loadDeltas({ apply: false });
          return;
        }
        this._applyPayload(o || {});
        this._snapshotBytes = bytes;
        this._snapshotState = SNAPSHOT_VALID;
        this._snapshotGeneration = generation;
        this._snapshotLoadError = null;
        this.lastSaveError = null;
        this.lastMutationSaved = true;
        this._loadDeltas();
      } catch (error) {
        // A raw byte count is only durable after decode and apply both succeed.
        // Keep the unreadable primary and any deltas untouched for explicit
        // recovery; ordinary mutations must not fall through to delta writes.
        this._snapshotFailure(SNAPSHOT_INVALID, error);
        this._loadDeltas({ apply: false });
      }
      return;
    }
    this._snapshotState = SNAPSHOT_MISSING;
    this._snapshotBytes = 0;
    this._snapshotGeneration = null;
    this._snapshotLoadError = null;
    this.lastSaveError = null;
    this._loadDeltas({ apply: false });
    for (const old of this.legacyIds) {
      let legacyRaw = null;
      try { legacyRaw = storage.getItem(PREFIX + old); }
      catch (error) {
        this._snapshotFailure(SNAPSHOT_UNAVAILABLE, error);
        return;
      }
      if (!legacyRaw) continue;
      try {
        const payload = JSON.parse(legacyRaw);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.cleared === true) continue;
        this.legacyCandidate = { sourceId: old, payload };
        return;
      } catch { continue; }
    }
  }

  importLegacyCandidate({ save = true } = {}) {
    const candidate = this.legacyCandidate;
    if (!candidate?.payload) return false;
    this._applyPayload(candidate.payload);
    this.dirty = true;
    if (save && !this.save()) return false;
    this.migratedFrom = candidate.sourceId;
    this.legacyCandidate = null;
    return true;
  }

  _mapForDelta(kind) {
    return kind === 'names' ? this.names : kind === 'comments' ? this.comments : kind === 'vars' ? this.vars : kind === 'types' ? this.types : null;
  }

  _deltaKey(kind, recordKey) {
    return `${this._deltaPrefix}${encodeURIComponent(kind)}.${encodeURIComponent(String(recordKey))}`;
  }

  _loadDeltas({ apply = true, preserveRecoveryKeys = null } = {}) {
    this._deltaScanComplete = true;
    const storage = this._storage();
    if (!this._deltaPrefix || !storage) return { complete: true };
    this._deltaBytes.clear(); this._deltaTotalBytes = 0;
    this._unreadableDeltaKeys.clear();
    const keys = [];
    try {
      for (let index = 0; index < storage.length; index++) {
        const storageKey = storage.key(index);
        if (storageKey?.startsWith(this._deltaPrefix)) keys.push(storageKey);
      }
    } catch {
      this._deltaScanComplete = false;
      return { complete: false };
    }
    keys.sort();
    // One unreadable delta must not abandon the rest of the overlay: each
    // record is decoded and applied independently, and a malformed record is
    // skipped on its own so later valid deltas still restore (issue #6307).
    for (const storageKey of keys) {
      let raw = null;
      try { raw = storage.getItem(storageKey); }
      catch {
        this._unreadableDeltaKeys.add(storageKey);
        this._deltaScanComplete = false;
        continue;
      }
      if (raw == null) continue;
      const preserve = preserveRecoveryKeys?.get(storageKey) === raw;
      try {
        const bytes = new TextEncoder().encode(raw).byteLength;
        this._deltaBytes.set(storageKey, bytes); this._deltaTotalBytes += bytes;
        const delta = JSON.parse(raw);
        const hasGeneration = !!delta && typeof delta === 'object' &&
          Object.prototype.hasOwnProperty.call(delta, 'generation');
        const generation = hasGeneration ? delta.generation : null;
        if (hasGeneration && (typeof generation !== 'string' || !generation)) {
          this._unreadableDeltaKeys.add(storageKey);
          this._deltaScanComplete = false;
          continue;
        }
        if (this._snapshotState === SNAPSHOT_MISSING) {
          if (!preserve) {
            this._unreadableDeltaKeys.add(storageKey);
            this._deltaScanComplete = false;
          }
          continue;
        }
        // A missing generation belongs to the pre-generation format. It is
        // replayable only while the base is also legacy; a committed base
        // with an exact generation ignores all older overlays.
        if (generation !== this._snapshotGeneration) {
          // A delta found without a base has no safe generation to bind to.
          // Keep it as recovery evidence rather than compacting it away.
          if (this._snapshotGeneration == null && generation != null) {
            if (!preserve) {
              this._unreadableDeltaKeys.add(storageKey);
              this._deltaScanComplete = false;
            }
          }
          continue;
        }
        if (!apply) continue;
        const map = this._mapForDelta(delta?.kind);
        if (!map || typeof delta?.key !== 'string') {
          this._unreadableDeltaKeys.add(storageKey);
          this._deltaScanComplete = false;
          continue;
        }
        if (delta.deleted) map.delete(delta.key); else map.set(delta.key, String(delta.value ?? ''));
      } catch {
        // Keep malformed raw bytes accounted and block a full rewrite. A
        // later explicit recovery can decide what to do with this evidence.
        this._unreadableDeltaKeys.add(storageKey);
        this._deltaScanComplete = false;
      }
    }
    return { complete: this._deltaScanComplete };
  }

  /**
   * Optimistic Concurrency Control (OCC) pre-write merge for localStorage mode:
   * Before overwriting PREFIX + this.id, re-read the persisted base snapshot
   * and any live deltas for that base's generation. Remote additions/edits on
   * keys not locally modified are preserved, while `_localDirty` (including
   * local deletion tombstones) wins for keys edited in this tab.
   */
  _mergeStorageBeforeSave(storage) {
    if (!storage || !this.id) return;
    let remoteRaw = null;
    try { remoteRaw = storage.getItem(PREFIX + this.id); }
    catch { return; }
    let remoteGen = this._snapshotGeneration;
    let remoteChanged = false;
    if (remoteRaw !== null) {
      try {
        const remote = JSON.parse(remoteRaw);
        this._validatePayload(remote);
        const parsedGen = typeof remote.generation === 'string' ? remote.generation : null;
        if (parsedGen !== this._snapshotGeneration) {
          remoteChanged = true;
          remoteGen = parsedGen;
          if (remote.cleared === true) {
            for (const kind of STORE_KINDS) {
              const map = this._mapForDelta(kind);
              for (const k of [...map.keys()]) {
                if (!this._localDirty.has(`${kind}:${k}`)) map.delete(k);
              }
            }
          } else {
            for (const kind of STORE_KINDS) {
              const map = this._mapForDelta(kind);
              const section = remote[kind];
              const remoteObj = section && typeof section === 'object' && !Array.isArray(section) ? section : {};
              for (const k of [...map.keys()]) {
                if (!Object.prototype.hasOwnProperty.call(remoteObj, k) && !this._localDirty.has(`${kind}:${k}`)) {
                  map.delete(k);
                }
              }
              for (const [k, v] of Object.entries(remoteObj)) {
                if (!this._localDirty.has(`${kind}:${k}`)) map.set(k, String(v));
              }
            }
            if (Array.isArray(remote.structs) && (!this.dirty || this.structs.length === 0)) {
              this.structs = remote.structs.slice();
            }
          }
        }
      } catch { return; }
    }
    // Also incorporate any live deltas written by another tab under remoteGen.
    if (!this._deltaPrefix) return;
    const keys = [];
    try {
      for (let i = 0; i < storage.length; i++) {
        const sk = storage.key(i);
        if (sk?.startsWith(this._deltaPrefix)) keys.push(sk);
      }
    } catch { return; }
    keys.sort();
    for (const sk of keys) {
      let raw = null;
      try { raw = storage.getItem(sk); } catch { continue; }
      if (raw == null) continue;
      if (!this._deltaBytes.has(sk)) {
        try {
          const bytes = new TextEncoder().encode(raw).byteLength;
          this._deltaBytes.set(sk, bytes);
          this._deltaTotalBytes += bytes;
        } catch { /* ignore */ }
      }
      try {
        const delta = JSON.parse(raw);
        if (!delta || typeof delta !== 'object') continue;
        const deltaGen = Object.prototype.hasOwnProperty.call(delta, 'generation') ? delta.generation : null;
        if (deltaGen !== remoteGen) continue;
        const map = this._mapForDelta(delta.kind);
        if (!map || typeof delta.key !== 'string') continue;
        const dirtyKey = `${delta.kind}:${delta.key}`;
        if (this._localDirty.has(dirtyKey)) continue;
        if (delta.deleted) {
          if (remoteChanged || map.has(delta.key)) map.delete(delta.key);
        } else {
          map.set(delta.key, String(delta.value ?? ''));
        }
      } catch { /* ignore */ }
    }
  }

  /**
   * Structural revalidation for a delta record that was unreadable at load
   * time (#7160): mirrors the _loadDeltas decode boundary. Returns false when
   * the record still fails the boundary, `current` for a live record that
   * needs a fresh ordered reload, `reconstructable` for a valid delta that
   * can be adopted by explicit recovery, and `ignorable` for stale evidence
   * that the current base already supersedes.
   */
  _isUnreadableDeltaRecord(raw) {
    try {
      const delta = JSON.parse(raw);
      if (!delta || typeof delta !== 'object') return false;
      const hasGeneration = Object.prototype.hasOwnProperty.call(delta, 'generation');
      if (hasGeneration && (typeof delta.generation !== 'string' || !delta.generation)) return false;
      const map = this._mapForDelta(delta.kind);
      if (!map || typeof delta.key !== 'string') return false;
      const generation = hasGeneration ? delta.generation : null;
      if (this._snapshotState === SNAPSHOT_MISSING) return 'reconstructable';
      if (this._snapshotState !== SNAPSHOT_VALID) return 'current';
      if (generation !== this._snapshotGeneration) {
        // A committed generation makes all other well-formed overlays stale;
        // they cannot affect a normal reload and may be collected safely.
        if (this._snapshotGeneration != null) return 'ignorable';
        // A generated overlay without a generated base can be adopted only by
        // explicit recovery after the complete set of deltas is revalidated.
        return 'reconstructable';
      }
      return 'current';
    } catch {
      return false;
    }
  }

  /**
   * Quarantine (or explicitly discard) only delta records that failed the
   * structural read/parse/schema boundary. Readable deltas remain intact, and
   * a successful recovery re-enables full snapshot compaction without using
   * clear() as a destructive escape hatch.
   */
  recoverUnreadableDeltas({ quarantine = true } = {}) {
    const storage = this._storage();
    if (!this._deltaPrefix || !storage) return true;
    // A failed scan with no per-key evidence may have skipped valid overlay
    // records before this instance could apply them. A metadata-only retry
    // cannot establish that this in-memory view incorporated those records.
    const priorScanIncompleteWithoutKeys = !this._deltaScanComplete &&
      this._unreadableDeltaKeys.size === 0;
    const pending = [...this._unreadableDeltaKeys];
    const failed = [];
    const reloadRequired = [];
    const reconstructed = new Map();
    const dirtyAtStart = this.dirty;
    const quarantinePrefix = PREFIX + this.id + '.quarantine.';
    for (const storageKey of pending) {
      let raw = null;
      try { raw = storage.getItem(storageKey); }
      catch { failed.push(storageKey); continue; }
      if (raw == null) continue;
      const status = this._isUnreadableDeltaRecord(raw);
      if (status === 'current') {
        // Repaired live record (transient read failure at load time): it stays
        // live. Recovery is blocked with an explicit reload requirement — the
        // caller must re-read the store so the record is incorporated in
        // normal delta order; deleting it here would destroy live evidence.
        if (!this._deltaBytes.has(storageKey)) {
          try {
            const bytes = new TextEncoder().encode(raw).byteLength;
            this._deltaBytes.set(storageKey, bytes); this._deltaTotalBytes += bytes;
          } catch { failed.push(storageKey); continue; }
        }
        reloadRequired.push(storageKey);
        continue;
      }
      if (status === 'reconstructable') {
        if (dirtyAtStart) {
          failed.push(storageKey);
          continue;
        }
        try {
          const delta = JSON.parse(raw);
          const map = this._mapForDelta(delta.kind);
          if (!map || typeof delta.key !== 'string') {
            failed.push(storageKey);
            continue;
          }
          if (delta.deleted) map.delete(delta.key);
          else map.set(delta.key, String(delta.value ?? ''));
          reconstructed.set(storageKey, raw);
          continue;
        } catch {
          failed.push(storageKey);
          continue;
        }
      }
      try {
        if (quarantine) storage.setItem(
          quarantinePrefix + encodeURIComponent(storageKey),
          raw,
        );
        storage.removeItem(storageKey);
      } catch { failed.push(storageKey); }
    }
    const retry = this._loadDeltas({ apply: false, preserveRecoveryKeys: reconstructed });
    // Do not let a successful retry erase uncertainty from a failed read or
    // enumeration. The raw records remain live until a fresh ordered load.
    for (const storageKey of failed) this._unreadableDeltaKeys.add(storageKey);
    if (failed.length || priorScanIncompleteWithoutKeys) this._deltaScanComplete = false;
    // A repaired delta remains live. Keep recovery scan-incomplete so save()
    // cannot compact it away before a fresh reload establishes its ordering.
    for (const storageKey of reloadRequired) this._unreadableDeltaKeys.add(storageKey);
    if (reloadRequired.length) this._deltaScanComplete = false;
    const scanReloadRequired = priorScanIncompleteWithoutKeys;
    if (retry.complete && failed.length === 0 && !scanReloadRequired &&
        this._unreadableDeltaKeys.size === 0) {
      this._deltaScanComplete = true;
    }
    const ok = failed.length === 0 && reloadRequired.length === 0 &&
      !scanReloadRequired &&
      this._deltaScanComplete && this._unreadableDeltaKeys.size === 0;
    if (ok) {
      if (!this._cleanupPending) this.lastSaveError = null;
      return true;
    }
    this.lastSaveError = {
      code: reloadRequired.length ? 'DELTA_RECOVERY_REPAIRED' : 'DELTA_RECOVERY_FAILED',
      message: reloadRequired.length || scanReloadRequired
        ? 'a fresh reload is required before recovery'
        : 'unreadable delta recovery remains pending',
      recoveryRequired: true,
      ...((reloadRequired.length || scanReloadRequired) ? { reloadRequired: true } : {}),
      pendingKeys: [...new Set([...failed, ...this._unreadableDeltaKeys])],
    };
    return false;
  }

  _clearDeltas() {
    const storage = this._storage();
    const remaining = new Map();
    const failedKeys = [];
    for (const [storageKey, bytes] of this._deltaBytes) {
      try { storage?.removeItem(storageKey); }
      catch {
        remaining.set(storageKey, bytes);
        failedKeys.push(storageKey);
      }
    }
    this._deltaBytes = remaining;
    this._deltaTotalBytes = [...remaining.values()].reduce((total, bytes) => total + bytes, 0);
    return {
      ok: this._deltaScanComplete && failedKeys.length === 0,
      failedKeys,
      scanIncomplete: !this._deltaScanComplete,
    };
  }

  _cleanupStatus(result) {
    if (result.ok) return null;
    return {
      code: result.scanIncomplete ? 'DELTA_SCAN_INCOMPLETE' : 'DELTA_CLEANUP_ERROR',
      message: result.scanIncomplete
        ? 'delta overlay scan was incomplete; cleanup remains pending'
        : 'base snapshot committed; stale delta cleanup remains pending',
      cleanupPending: true,
      durability: 'committed',
      pendingKeys: result.failedKeys,
    };
  }

  _persistDelta(kind, recordKey, value, meta = null) {
    if (!this.id || !this._deltaPrefix) return this._saveFailure('NO_ID');
    const rev = meta?.rev ?? ++this._revCounter;
    const updatedAt = meta?.updatedAt ?? Date.now();
    if (this._useIdb) {
      const generation = this._snapshotGeneration || nextNoteGeneration();
      this._snapshotGeneration = generation;
      this._snapshotState = SNAPSHOT_VALID;
      this.dirty = false;
      this.lastMutationSaved = true;
      const dirtyKey = `${kind}:${recordKey}`;
      this._queueIdbWrite(
        () => this._idb.putDelta(this.id, kind, String(recordKey), value, { generation, rev, updatedAt }),
        () => {
          const cur = this._localDirty.get(dirtyKey);
          if (cur && cur.rev === rev) this._localDirty.delete(dirtyKey);
          this._broadcastSync({
            op: 'delta',
            kind,
            key: String(recordKey),
            value: value == null ? null : String(value),
            deleted: value == null,
            generation,
            rev,
            updatedAt,
          });
          this._writePing(rev);
        },
      );
      return true;
    }
    const storage = this._storage();
    if (!storage) return this._saveFailure('STORAGE_ERROR');
    if (this._snapshotState === SNAPSHOT_INVALID || this._snapshotState === SNAPSHOT_UNAVAILABLE) {
      return this._saveFailure(
        this._snapshotState === SNAPSHOT_UNAVAILABLE ? 'SNAPSHOT_READ_ERROR' : 'INVALID_SNAPSHOT',
        this._snapshotLoadError,
        { recoveryRequired: true },
      );
    }
    // A delta overlay needs a durable, replayable base. The first mutation of
    // a fresh store and the first mutation after a clear tombstone create a
    // real snapshot; a tombstone short-circuits delta loading on reopen.
    if (this._snapshotState !== SNAPSHOT_VALID || this._snapshotGeneration == null) return this.save();
    const storageKey = this._deltaKey(kind, recordKey);
    const text = JSON.stringify({
      kind,
      key: String(recordKey),
      deleted: value == null,
      generation: this._snapshotGeneration,
      ...(value == null ? {} : { value: String(value) }),
    });
    const bytes = new TextEncoder().encode(text).byteLength;
    const previousBytes = this._deltaBytes.get(storageKey) || 0;
    const projected = this._snapshotBytes + this._deltaTotalBytes - previousBytes + bytes;
    if (projected > this._maxBytes) return this.save();
    try {
      storage.setItem(storageKey, text);
      this._deltaBytes.set(storageKey, bytes);
      this._deltaTotalBytes += bytes - previousBytes;
      this.dirty = false;
      if (!this._cleanupPending) this.lastSaveError = null;
      this.lastMutationSaved = true;
      this.onSaveSuccess?.();
      this._broadcastSync({
        op: 'delta',
        kind,
        key: String(recordKey),
        value: value == null ? null : String(value),
        deleted: value == null,
        generation: this._snapshotGeneration,
        rev,
        updatedAt,
      });
      return true;
    } catch (error) { return this._saveFailure(error?.name || 'STORAGE_ERROR', error); }
  }

  _saveFailure(code, error = null, detail = {}) {
    this.dirty = true;
    this.lastMutationSaved = false;
    this.lastSaveError = {
      code: code || 'STORAGE_ERROR',
      message: error?.message || String(error || ''),
      ...detail,
    };
    this.onSaveError?.(this.lastSaveError);
    return false;
  }

  save({ replace = false } = {}) {
    if (!this.id) return this._saveFailure('NO_ID');
    if (this._useIdb) {
      const generation = nextNoteGeneration();
      const rev = ++this._revCounter;
      const snapshot = this._snapshotObject(generation);
      const dirtySnapshot = new Map(this._localDirty);
      this._snapshotGeneration = generation;
      this._snapshotState = SNAPSHOT_VALID;
      this.dirty = false;
      this.lastMutationSaved = true;
      this._queueIdbWrite(
        () => this._idb.replaceStore(
          this.id,
          { ...snapshot, baseRevision: this._idbRevision, localDirty: dirtySnapshot },
          { replace },
        ),
        () => {
          for (const [k, meta] of dirtySnapshot) {
            const cur = this._localDirty.get(k);
            if (cur && cur.rev === meta.rev) this._localDirty.delete(k);
          }
          this._broadcastSync({ op: 'save', replace, generation, rev });
          this._writePing(rev);
        },
      );
      this._notifyChange('save');
      return true;
    }
    const storage = this._storage();
    if (!storage) return this._saveFailure('STORAGE_ERROR');
    if (this._snapshotState === SNAPSHOT_INVALID || this._snapshotState === SNAPSHOT_UNAVAILABLE) {
      return this._saveFailure(
        this._snapshotState === SNAPSHOT_UNAVAILABLE ? 'SNAPSHOT_READ_ERROR' : 'INVALID_SNAPSHOT',
        this._snapshotLoadError,
        { recoveryRequired: true },
      );
    }
    // A full rewrite can compact the overlay only when every delta was read.
    // An unreadable key may still contain the newest edit, so preserve it for
    // explicit recovery instead of declaring the in-memory subset durable.
    if (!this._deltaScanComplete && this._snapshotState !== SNAPSHOT_TOMBSTONE) {
      return this._saveFailure('DELTA_SCAN_INCOMPLETE', null, { recoveryRequired: true });
    }
    if (!replace) {
      this._mergeStorageBeforeSave(storage);
    }
    const generation = nextNoteGeneration();
    const o = this._snapshotObject(generation);
    let text;
    try { text = JSON.stringify(o); } catch (error) { return this._saveFailure('SERIALIZE_ERROR', error); }
    const bytes = new TextEncoder().encode(text).byteLength;
    if (bytes > this._maxBytes) return this._saveFailure('TOO_LARGE', null, { bytes, maxBytes: this._maxBytes });
    try {
      storage.setItem(PREFIX + this.id, text);
      this._snapshotBytes = bytes;
      this._snapshotState = SNAPSHOT_VALID;
      this._snapshotGeneration = generation;
      this._snapshotLoadError = null;
      const cleanup = this._clearDeltas();
      this._cleanupPending = !cleanup.ok;
      this.dirty = false;
      this._localDirty.clear();
      this.lastSaveError = this._cleanupStatus(cleanup);
      this.lastMutationSaved = true;
      if (!this.lastSaveError) this.onSaveSuccess?.();
      this._broadcastSync({ op: 'save', replace, generation });
      this._notifyChange('save');
      return true;
    } catch (error) {
      return this._saveFailure(error?.name || 'STORAGE_ERROR', error);
    }
  }

  replaceAll({ names, comments, vars, types, structs } = {}, { replaceVars = true, save = true } = {}) {
    this.names.clear();
    this.comments.clear();
    this.types.clear();
    if (replaceVars) this.vars.clear();
    this._localDirty.clear();
    for (const [k, v] of iterEntries(names)) {
      if (v != null && v !== '') this.names.set(String(k), String(v));
    }
    for (const [k, v] of iterEntries(comments)) {
      if (v != null && v !== '') this.comments.set(String(k), String(v));
    }
    for (const [k, v] of iterEntries(types)) {
      if (v != null && v !== '') this.types.set(String(k), String(v));
    }
    if (replaceVars) {
      for (const [k, v] of iterEntries(vars)) {
        if (v != null && v !== '') this.vars.set(String(k), String(v));
      }
    }
    this.structs = Array.isArray(structs) ? structs.slice() : [];
    this.dirty = true;
    if (!save) return true;
    return this.save({ replace: true });
  }

  /* ── トランザクション ─────────────────────────────────── */

  transaction(fn) {
    this._transactionDepth = (this._transactionDepth || 0) + 1;
    try {
      return fn();
    } finally {
      this._transactionDepth--;
      if (this._transactionDepth === 0 && this.dirty) {
        this.save();
      }
    }
  }

  async transactionAsync(fn) {
    this._transactionDepth = (this._transactionDepth || 0) + 1;
    let succeeded = false;
    try {
      const result = await fn();
      succeeded = true;
      return result;
    } finally {
      this._transactionDepth--;
      if (succeeded && this._transactionDepth === 0 && this.dirty) {
        this.save();
      }
    }
  }

  /* ── 名前 ─────────────────────────────────────────────── */

  nameOf(addr) { return this.names.get(key(addr)) || null; }

  setName(addr, name, { save = true } = {}) {
    const k = key(addr);
    if (!k) return this._saveFailure('INVALID_KEY');
    const clean = cleanName(name);
    if (clean) this.names.set(k, clean);
    else this.names.delete(k);
    const meta = this._markLocalDirty('names', k, clean || null);
    this.dirty = true;
    if (this._transactionDepth > 0 || !save) {
      this._notifyChange('name', { key: k, value: clean || null });
      return true;
    }
    const ok = this._persistDelta('names', k, clean || null, meta);
    this._notifyChange('name', { key: k, value: clean || null });
    return ok;
  }

  /** 保存済みの名前をぜんぶ [{addr, name}] で返す（起動時に索引へ流し込む）。 */
  nameEntries() {
    const out = [];
    for (const [k, v] of this.names) {
      try { out.push({ addr: BigInt(k), name: v }); } catch { /* skip */ }
    }
    return out;
  }

  /* ── メモ ─────────────────────────────────────────────── */

  comment(addr) { return this.comments.get(key(addr)) || null; }

  setComment(addr, text, { save = true } = {}) {
    const k = key(addr);
    if (!k) return this._saveFailure('INVALID_KEY');
    const clean = (text || '').toString().slice(0, MAX_COMMENT_LENGTH).trim();
    if (clean) this.comments.set(k, clean);
    else this.comments.delete(k);
    const meta = this._markLocalDirty('comments', k, clean || null);
    this.dirty = true;
    if (this._transactionDepth > 0 || !save) {
      this._notifyChange('comment', { key: k, value: clean || null });
      return true;
    }
    const ok = this._persistDelta('comments', k, clean || null, meta);
    this._notifyChange('comment', { key: k, value: clean || null });
    return ok;
  }

  commentCount() { return this.comments.size; }

  /* ── 変数と型 ─────────────────────────────────────────── */

  varName(func, k) { return this.vars.get(key(func) + ':' + k) || null; }

  setVarName(func, k, name, { save = true } = {}) {
    const kk = key(func) + ':' + k;
    if (!key(func)) return this._saveFailure('INVALID_KEY');
    const clean = cleanName(name);
    if (clean) this.vars.set(kk, clean);
    else this.vars.delete(kk);
    const meta = this._markLocalDirty('vars', kk, clean || null);
    this.dirty = true;
    if (this._transactionDepth > 0 || !save) {
      this._notifyChange('var', { key: kk, value: clean || null });
      return true;
    }
    const ok = this._persistDelta('vars', kk, clean || null, meta);
    this._notifyChange('var', { key: kk, value: clean || null });
    return ok;
  }

  typeOf(func, k) { return this.types.get(key(func) + ':' + k) || null; }

  setType(func, k, type, { save = true } = {}) {
    const kk = key(func) + ':' + k;
    if (!key(func)) return this._saveFailure('INVALID_KEY');
    const clean = (type || '').toString().slice(0, MAX_TYPE_LENGTH).trim();
    if (clean) this.types.set(kk, clean);
    else this.types.delete(kk);
    const meta = this._markLocalDirty('types', kk, clean || null);
    this.dirty = true;
    if (this._transactionDepth > 0 || !save) {
      this._notifyChange('type', { key: kk, value: clean || null });
      return true;
    }
    const ok = this._persistDelta('types', kk, clean || null, meta);
    this._notifyChange('type', { key: kk, value: clean || null });
    return ok;
  }

  /* ── まとめて ─────────────────────────────────────────── */

  get count() { return this.names.size + this.comments.size + this.vars.size + this.types.size; }

  clear() {
    this.names.clear(); this.comments.clear(); this.vars.clear(); this.types.clear();
    this.structs = [];
    this._localDirty.clear();
    this.dirty = true;
    if (!this.id) {
      this._notifyChange('clear');
      return this._saveFailure('NO_ID');
    }
    if (this._useIdb) {
      const generation = nextNoteGeneration();
      const rev = ++this._revCounter;
      const updatedAt = Date.now();
      this._snapshotState = SNAPSHOT_TOMBSTONE;
      this._snapshotGeneration = generation;
      this._snapshotLoadError = null;
      this.dirty = false;
      this.lastMutationSaved = true;
      this.migratedFrom = null;
      this._queueIdbWrite(
        () => this._idb.clearStore(this.id, { generation, rev, updatedAt }),
        () => {
          this._broadcastSync({ op: 'clear', generation, rev });
          this._writePing(rev);
        },
      );
      this._notifyChange('clear');
      return true;
    }
    const storage = this._storage();
    if (!storage) {
      this._notifyChange('clear');
      return this._saveFailure('STORAGE_ERROR');
    }
    // Keep the legacy payload intact for old app versions, but atomically write
    // a primary-key tombstone so this version never migrates it again.
    try {
      const generation = nextNoteGeneration();
      const tombstone = JSON.stringify({ v: 2, cleared: true, generation });
      storage.setItem(PREFIX + this.id, tombstone);
      this._snapshotBytes = new TextEncoder().encode(tombstone).byteLength;
      this._snapshotState = SNAPSHOT_TOMBSTONE;
      this._snapshotGeneration = generation;
      this._snapshotLoadError = null;
      this._deltaScanComplete = true;
      this._unreadableDeltaKeys.clear();
      const cleanup = this._clearDeltas();
      this._cleanupPending = !cleanup.ok;
      this.dirty = false;
      this.lastSaveError = this._cleanupStatus(cleanup);
      this.lastMutationSaved = true;
      this.migratedFrom = null;
      if (!this.lastSaveError) this.onSaveSuccess?.();
      this._broadcastSync({ op: 'clear', generation });
      this._notifyChange('clear');
      return true;
    } catch (error) {
      this._notifyChange('clear');
      return this._saveFailure(error?.name || 'STORAGE_ERROR', error);
    }
  }

  /** 書き出し（バックアップ・共有用）。 */
  toJSON() {
    return JSON.stringify({
      v: 1, id: this.id,
      names: Object.fromEntries(this.names),
      comments: Object.fromEntries(this.comments),
      vars: Object.fromEntries(this.vars),
      types: Object.fromEntries(this.types),
      structs: this.structs,
    }, null, 1);
  }

  /** 読み込み（書き出したものを戻す）。既存の内容とまぜる。 */
  fromJSON(text) {
    const o = JSON.parse(text);
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('invalid-notes-import');
    // Identity comparison stays type-preserving: a structured id must never
    // launder into this store's namespace through String() coercion (#5968).
    if (o.id != null && typeof o.id !== 'string') throw new Error('notes-file-mismatch');
    if (o.id != null && this.id != null && o.id !== this.id) throw new Error('notes-file-mismatch');
    const plainSection = (value) => {
      if (value == null) return null;
      if (typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-notes-import');
      return value;
    };
    const names = plainSection(o.names);
    const comments = plainSection(o.comments);
    const vars = plainSection(o.vars);
    const types = plainSection(o.types);
    if (o.structs != null && !Array.isArray(o.structs)) throw new Error('invalid-notes-import');
    let n = 0;
    if (names) {
      for (const [k, v] of Object.entries(names)) {
        if (typeof v !== 'string') continue;
        const clean = cleanName(v);
        if (!clean) continue;
        this.names.set(k, clean);
        this._markLocalDirty('names', k, clean);
        n++;
      }
    }
    if (comments) {
      for (const [k, v] of Object.entries(comments)) {
        if (typeof v !== 'string') continue;
        const clean = v.slice(0, MAX_COMMENT_LENGTH).trim();
        if (!clean) continue;
        this.comments.set(k, clean);
        this._markLocalDirty('comments', k, clean);
        n++;
      }
    }
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        if (typeof v !== 'string') continue;
        const clean = cleanName(v);
        if (!clean) continue;
        this.vars.set(k, clean);
        this._markLocalDirty('vars', k, clean);
        n++;
      }
    }
    if (types) {
      for (const [k, v] of Object.entries(types)) {
        if (typeof v !== 'string') continue;
        const clean = v.slice(0, MAX_TYPE_LENGTH).trim();
        if (!clean) continue;
        this.types.set(k, clean);
        this._markLocalDirty('types', k, clean);
        n++;
      }
    }
    if (Array.isArray(o.structs)) this.structs = this.structs.concat(o.structs);
    this.dirty = true;
    this.lastMutationSaved = this.save();
    return n;
  }
}

/**
 * 名前として使える形に整える。
 * 記号だらけの名前は、あとで検索やスクリプトから引けなくなるので落とす。
 */
export function cleanName(name) {
  if (name == null) return '';
  let s = String(name).replace(/[\r\n\t]/g, ' ').trim();
  if (!s) return '';
  if (s.length > MAX_NAME_LENGTH) s = s.slice(0, MAX_NAME_LENGTH);
  return s;
}

/** 何も保存しない置き場（ファイル未選択のとき）。 */
export const EMPTY_NOTES = new NoteStore(null);
