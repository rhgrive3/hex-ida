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
 * 保存先はブラウザの localStorage で、ファイルごとに分かれています
 * （内容fingerprint・active slice UUID/archで見分ける）。どこにも送信しません。
 */

import { asByteSource } from './binary/source.js';
import { hashByteSource, sha256TreeByteSource } from './platform/hash.js';

const PREFIX = 'hex.notes.';
const MAX_BYTES = 2 * 1024 * 1024;   // 1 ファイルぶんの上限（保存が壊れないように）
const NOTE_KEY_CACHE = new WeakMap(); // File/ByteSource -> resolved slice identities

/** BigInt でも Number でも同じ鍵になるように、10 進の文字列にそろえる。 */
function key(addr) {
  if (addr == null) return '';
  return typeof addr === 'bigint' ? addr.toString() : String(BigInt(Math.trunc(Number(addr))));
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
    for (let i = 0; i < storage.length; i++) {
      const candidate = storage.key(i);
      if (typeof candidate !== 'string' || !candidate.startsWith(prefix)) continue;
      if (candidate.includes('.delta.', prefix.length)) continue;
      return candidate.slice(PREFIX.length);
    }
  } catch { return null; }
  return null;
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
  constructor(id, legacyIds = []) {
    this.id = id || null;
    this.legacyIds = Array.from(new Set((legacyIds || []).filter((x) => x && x !== this.id)));
    this.migratedFrom = null;
    this.legacyCandidate = null;
    this.lastSaveError = null;
    this.lastMutationSaved = true;
    this._snapshotBytes = 0;
    this._deltaBytes = new Map();
    this._deltaTotalBytes = 0;
    this._deltaPrefix = this.id ? `${PREFIX}${this.id}.delta.` : null;
    this.names = new Map();      // addr -> 名前
    this.comments = new Map();   // addr -> メモ
    this.vars = new Map();       // 'func:key' -> 呼び名
    this.types = new Map();      // 'func:key' -> 型
    this.structs = [];           // 自分で作った構造体（types.js が読む）
    this.dirty = false;
    this.load();
  }

  /* ── 読み書き ─────────────────────────────────────────── */

  _applyPayload(o) {
    for (const [k, v] of Object.entries(o.names || {})) this.names.set(k, v);
    for (const [k, v] of Object.entries(o.comments || {})) this.comments.set(k, v);
    for (const [k, v] of Object.entries(o.vars || {})) this.vars.set(k, v);
    for (const [k, v] of Object.entries(o.types || {})) this.types.set(k, v);
    this.structs = Array.isArray(o.structs) ? o.structs : [];
  }

  load() {
    if (!this.id) return;
    let raw = null;
    try { raw = localStorage.getItem(PREFIX + this.id); } catch { return; }
    if (raw) {
      try {
        this._snapshotBytes = new TextEncoder().encode(raw).byteLength;
        const o = JSON.parse(raw);
        if (o && o.cleared === true) {
          this.dirty = false; this.lastSaveError = null; this.lastMutationSaved = true;
          this.migratedFrom = null; this.legacyCandidate = null; return;
        }
        this._applyPayload(o || {});
        this._loadDeltas();
      } catch { }
      return;
    }
    for (const old of this.legacyIds) {
      let legacyRaw = null;
      try { legacyRaw = localStorage.getItem(PREFIX + old); } catch { return; }
      if (!legacyRaw) continue;
      try {
        const payload = JSON.parse(legacyRaw);
        if (!payload || payload.cleared === true) continue;
        this.legacyCandidate = { sourceId: old, payload };
      } catch { }
      return;
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

  _loadDeltas() {
    if (!this._deltaPrefix || typeof localStorage === 'undefined') return;
    this._deltaBytes.clear(); this._deltaTotalBytes = 0;
    const keys = [];
    try {
      for (let index = 0; index < localStorage.length; index++) {
        const storageKey = localStorage.key(index);
        if (storageKey?.startsWith(this._deltaPrefix)) keys.push(storageKey);
      }
      keys.sort();
      for (const storageKey of keys) {
        const raw = localStorage.getItem(storageKey);
        if (raw == null) continue;
        const bytes = new TextEncoder().encode(raw).byteLength;
        this._deltaBytes.set(storageKey, bytes); this._deltaTotalBytes += bytes;
        const delta = JSON.parse(raw);
        const map = this._mapForDelta(delta?.kind);
        if (!map || typeof delta?.key !== 'string') continue;
        if (delta.deleted) map.delete(delta.key); else map.set(delta.key, String(delta.value ?? ''));
      }
    } catch { /* base snapshot remains valid if a delta is unreadable */ }
  }

  _clearDeltas() {
    for (const storageKey of this._deltaBytes.keys()) { try { localStorage.removeItem(storageKey); } catch { /* stale overlay is idempotent */ } }
    this._deltaBytes.clear(); this._deltaTotalBytes = 0;
  }

  _persistDelta(kind, recordKey, value) {
    if (!this.id || !this._deltaPrefix) return this._saveFailure('NO_ID');
    // A delta overlay needs a durable base. The first mutation of a fresh store
    // creates that base once; subsequent ordinary mutations stay record-local.
    if (this._snapshotBytes === 0) return this.save();
    const storageKey = this._deltaKey(kind, recordKey);
    const text = JSON.stringify({ kind, key:String(recordKey), deleted:value == null, ...(value == null ? {} : { value:String(value) }) });
    const bytes = new TextEncoder().encode(text).byteLength;
    const previousBytes = this._deltaBytes.get(storageKey) || 0;
    const projected = this._snapshotBytes + this._deltaTotalBytes - previousBytes + bytes;
    if (projected > MAX_BYTES) return this.save();
    try {
      localStorage.setItem(storageKey, text);
      this._deltaBytes.set(storageKey, bytes);
      this._deltaTotalBytes += bytes - previousBytes;
      this.dirty = false; this.lastSaveError = null; this.lastMutationSaved = true;
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
    return false;
  }

  save() {
    if (!this.id) return this._saveFailure('NO_ID');
    const o = {
      v: 2,
      names: Object.fromEntries(this.names),
      comments: Object.fromEntries(this.comments),
      vars: Object.fromEntries(this.vars),
      types: Object.fromEntries(this.types),
      structs: this.structs,
    };
    let text;
    try { text = JSON.stringify(o); } catch (error) { return this._saveFailure('SERIALIZE_ERROR', error); }
    const bytes = new TextEncoder().encode(text).byteLength;
    if (bytes > MAX_BYTES) return this._saveFailure('TOO_LARGE', null, { bytes, maxBytes: MAX_BYTES });
    try {
      localStorage.setItem(PREFIX + this.id, text);
      this._snapshotBytes = bytes;
      this._clearDeltas();
      this.dirty = false;
      this.lastSaveError = null;
      this.lastMutationSaved = true;
      return true;
    } catch (error) {
      return this._saveFailure(error?.name || 'STORAGE_ERROR', error);
    }
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
    try {
      return await fn();
    } finally {
      this._transactionDepth--;
      if (this._transactionDepth === 0 && this.dirty) {
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
    this.dirty = true;
    if (this._transactionDepth > 0 || !save) return true;
    return this._persistDelta('names', k, clean || null);
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
    const clean = (text || '').toString().slice(0, 500).trim();
    if (clean) this.comments.set(k, clean);
    else this.comments.delete(k);
    this.dirty = true;
    if (this._transactionDepth > 0 || !save) return true;
    return this._persistDelta('comments', k, clean || null);
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
    this.dirty = true;
    if (this._transactionDepth > 0 || !save) return true;
    return this._persistDelta('vars', kk, clean || null);
  }

  typeOf(func, k) { return this.types.get(key(func) + ':' + k) || null; }

  setType(func, k, type, { save = true } = {}) {
    const kk = key(func) + ':' + k;
    if (!key(func)) return this._saveFailure('INVALID_KEY');
    const clean = (type || '').toString().slice(0, 80).trim();
    if (clean) this.types.set(kk, clean);
    else this.types.delete(kk);
    this.dirty = true;
    if (this._transactionDepth > 0 || !save) return true;
    return this._persistDelta('types', kk, clean || null);
  }

  /* ── まとめて ─────────────────────────────────────────── */

  get count() { return this.names.size + this.comments.size + this.vars.size + this.types.size; }

  clear() {
    this.names.clear(); this.comments.clear(); this.vars.clear(); this.types.clear();
    this.structs = [];
    this.dirty = true;
    if (!this.id) return this._saveFailure('NO_ID');
    // Keep the legacy payload intact for old app versions, but atomically write
    // a primary-key tombstone so this version never migrates it again.
    try {
      const tombstone = JSON.stringify({ v: 2, cleared: true });
      localStorage.setItem(PREFIX + this.id, tombstone);
      this._snapshotBytes = new TextEncoder().encode(tombstone).byteLength;
      this._clearDeltas();
      this.dirty = false;
      this.lastSaveError = null;
      this.lastMutationSaved = true;
      this.migratedFrom = null;
      return true;
    } catch (error) {
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
    if (!o || typeof o !== 'object') throw new Error('invalid-notes-import');
    if (o.id != null && this.id != null && String(o.id) !== String(this.id)) throw new Error('notes-file-mismatch');
    let n = 0;
    for (const [k, v] of Object.entries(o.names || {})) { this.names.set(k, v); n++; }
    for (const [k, v] of Object.entries(o.comments || {})) { this.comments.set(k, v); n++; }
    for (const [k, v] of Object.entries(o.vars || {})) { this.vars.set(k, v); n++; }
    for (const [k, v] of Object.entries(o.types || {})) { this.types.set(k, v); n++; }
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
  if (s.length > 120) s = s.slice(0, 120);
  return s;
}

/** 何も保存しない置き場（ファイル未選択のとき）。 */
export const EMPTY_NOTES = new NoteStore(null);
