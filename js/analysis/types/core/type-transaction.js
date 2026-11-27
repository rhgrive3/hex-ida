// Atomic undo/redo transaction manager for interactive type & recovery edits (§9.3).
// Supports snapshot, commit, rollback, bounded undo/redo stack (FIFO limit 50, <= 2 MiB),
// exception-safe peek-before-pop undo/redo, array delta accumulation, BigInt/Map/Set cloning,
// inflight Worker abort callback, and dirty-cone invalidation list emission.
// Pure architecture-neutral core (INV-005).

export const DEFAULT_UNDO_LIMIT = 50;
export const DEFAULT_MAX_TX_BYTES = 2 * 1024 * 1024;

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Recursive deep clone preserving BigInt, Map, Set, TypedArrays, ArrayBuffer, Date,
 * RegExp, Arrays, and plain objects without JSON BigInt stringification.
 */
export function deepClone(val, seen = new WeakMap()) {
  if (val === null || val === undefined) return val;
  const t = typeof val;
  if (t !== 'object') return val; // preserves bigint, number, string, boolean, symbol

  if (seen.has(val)) return seen.get(val);

  if (val instanceof Date) return new Date(val.getTime());
  if (val instanceof RegExp) return new RegExp(val.source, val.flags);
  if (val instanceof ArrayBuffer) return val.slice(0);
  if (ArrayBuffer.isView(val)) {
    return new val.constructor(
      val.buffer.slice(val.byteOffset, val.byteOffset + val.byteLength)
    );
  }
  if (Array.isArray(val)) {
    const out = new Array(val.length);
    seen.set(val, out);
    for (let i = 0; i < val.length; i++) {
      out[i] = deepClone(val[i], seen);
    }
    return out;
  }
  if (val instanceof Map) {
    const out = new Map();
    seen.set(val, out);
    for (const [k, v] of val.entries()) {
      out.set(deepClone(k, seen), deepClone(v, seen));
    }
    return out;
  }
  if (val instanceof Set) {
    const out = new Set();
    seen.set(val, out);
    for (const item of val.values()) {
      out.add(deepClone(item, seen));
    }
    return out;
  }

  const proto = Object.getPrototypeOf(val);
  const out = proto === null ? Object.create(null) : {};
  seen.set(val, out);
  for (const key of Object.keys(val)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    out[key] = deepClone(val[key], seen);
  }
  return out;
}

function estimateBytes(obj, seen = new WeakSet()) {
  if (obj === null || obj === undefined) return 8;
  const t = typeof obj;
  if (t === 'boolean') return 4;
  if (t === 'number') return 8;
  if (t === 'bigint') return 16;
  if (t === 'string') return obj.length * 2 + 16;
  if (t !== 'object') return 16;
  if (seen.has(obj)) return 8;
  seen.add(obj);

  if (ArrayBuffer.isView(obj)) return obj.byteLength + 16;
  if (obj instanceof ArrayBuffer) return obj.byteLength + 16;
  if (Array.isArray(obj)) {
    let total = 32;
    for (let i = 0; i < obj.length; i++) total += estimateBytes(obj[i], seen);
    return total;
  }
  if (obj instanceof Map) {
    let total = 32;
    for (const [k, v] of obj.entries()) {
      total += estimateBytes(k, seen) + estimateBytes(v, seen);
    }
    return total;
  }
  if (obj instanceof Set) {
    let total = 32;
    for (const v of obj.values()) total += estimateBytes(v, seen);
    return total;
  }
  let total = 32;
  for (const key of Object.keys(obj)) {
    total += key.length * 2 + estimateBytes(obj[key], seen);
  }
  return total;
}

const TRACKED_DELTA_KEYS = Object.freeze([
  'sigDelta',
  'pinMaskDelta',
  'notesDelta',
  'globalTypeDelta',
  'displayHintsDelta',
  'manualSegmentsDelta',
  'funcChunksDelta',
  'customAbisDelta',
  'stackSlotOverridesDelta',
  'shiftedPtrsDelta',
]);

export class TypeTransactionManager {
  constructor(options = {}) {
    this.undoLimit = options.undoLimit ?? DEFAULT_UNDO_LIMIT;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_TX_BYTES;
    this.dirtyConeIndex = options.dirtyConeIndex || null;
    this.onAbortInflight =
      typeof options.onAbortInflight === 'function' ? options.onAbortInflight : null;
    this.applyDelta = typeof options.applyDelta === 'function' ? options.applyDelta : null;
    this.captureSnapshot =
      typeof options.captureSnapshot === 'function' ? options.captureSnapshot : null;
    this.restoreSnapshot =
      typeof options.restoreSnapshot === 'function' ? options.restoreSnapshot : null;

    this._state = deepClone(options.initialState || {});
    this.undoStack = [];
    this.redoStack = [];
    this.activeTx = null;
    this.revision = 0;
    this.totalBytes = 0;
    this._nextTxId = 1;
  }

  getState() {
    return this._state;
  }

  _takeSnapshot() {
    if (this.captureSnapshot) return deepClone(this.captureSnapshot());
    return deepClone(this._state);
  }

  _loadSnapshot(snap) {
    const cloned = deepClone(snap);
    if (this.restoreSnapshot) {
      this.restoreSnapshot(cloned);
    } else {
      this._state = cloned;
    }
  }

  begin(meta = {}) {
    if (this.activeTx) {
      throw new Error(`Transaction ${this.activeTx.id} already active; commit or rollback first`);
    }
    const beforeSnapshot = this._takeSnapshot();
    const tx = {
      id: this._nextTxId++,
      label: String(meta.label || 'type-edit'),
      startedAt: Date.now(),
      beforeSnapshot,
      afterSnapshot: null,
      deltas: Object.create(null),
      dirtySeeds: Array.isArray(meta.dirtySeeds) ? meta.dirtySeeds.slice() : [],
      requiresPathA2ReDecompile: Boolean(meta.requiresPathA2ReDecompile),
      status: 'open',
    };
    this.activeTx = tx;
    return tx;
  }

  /**
   * Record a typed delta inside the active transaction (accumulated as array per deltaKey).
   * Rejects prototype-pollution keys (__proto__, constructor, prototype).
   */
  recordDelta(deltaKey, payload, options = {}) {
    if (!this.activeTx || this.activeTx.status !== 'open') {
      throw new Error('No active transaction');
    }
    if (!TRACKED_DELTA_KEYS.includes(deltaKey)) {
      throw new Error(`Unknown transaction delta key: ${deltaKey}`);
    }
    if (payload && typeof payload === 'object' && 'key' in payload) {
      const kStr = String(payload.key);
      if (FORBIDDEN_KEYS.has(kStr)) {
        throw new Error(`Forbidden delta key: ${kStr}`);
      }
    }

    const clonedPayload = deepClone(payload);
    if (this.applyDelta) {
      this.applyDelta(deltaKey, clonedPayload, 'forward');
    } else if (clonedPayload && typeof clonedPayload === 'object' && 'key' in clonedPayload && 'after' in clonedPayload) {
      if (!Object.hasOwn(this._state, deltaKey) || !this._state[deltaKey]) {
        this._state[deltaKey] = Object.create(null);
      }
      if (clonedPayload.after === undefined) {
        delete this._state[deltaKey][clonedPayload.key];
      } else {
        this._state[deltaKey][clonedPayload.key] = deepClone(clonedPayload.after);
      }
    }

    if (!Array.isArray(this.activeTx.deltas[deltaKey])) {
      this.activeTx.deltas[deltaKey] = [];
    }
    this.activeTx.deltas[deltaKey].push(clonedPayload);

    if (options.dirtySeed !== undefined) {
      this.activeTx.dirtySeeds.push(options.dirtySeed);
    }
    if (options.requiresPathA2ReDecompile) {
      this.activeTx.requiresPathA2ReDecompile = true;
    }
  }

  _computeInvalidation(seeds, options = {}) {
    if (!this.dirtyConeIndex || !seeds || seeds.length === 0) {
      return { ordered: [], syncWave: [], asyncWave: [], truncated: false };
    }
    return this.dirtyConeIndex.computeDirtyCone({ kind: 'multi', seeds }, options);
  }

  _evictIfNeeded() {
    while (
      this.undoStack.length > this.undoLimit ||
      (this.totalBytes > this.maxBytes && this.undoStack.length > 1)
    ) {
      const evicted = this.undoStack.shift();
      this.totalBytes = Math.max(0, this.totalBytes - (evicted.approxBytes || 0));
    }
  }

  commit(txArg = null, options = {}) {
    const tx = txArg || this.activeTx;
    if (!tx || tx !== this.activeTx || tx.status !== 'open') {
      throw new Error('Cannot commit: transaction is not active/open');
    }
    // Perform all fallible operations BEFORE committing stack/state transitions
    const afterSnapshot = this._takeSnapshot();
    const dirtyCone = this._computeInvalidation(tx.dirtySeeds, options);
    const approxBytes = estimateBytes({
      beforeSnapshot: tx.beforeSnapshot,
      afterSnapshot,
      deltas: tx.deltas,
    });

    tx.afterSnapshot = afterSnapshot;
    tx.approxBytes = approxBytes;
    tx.status = 'committed';
    this.activeTx = null;

    this.undoStack.push(tx);
    this.totalBytes += approxBytes;
    this.redoStack.length = 0;
    this._evictIfNeeded();
    this.revision += 1;

    return {
      ok: true,
      txId: tx.id,
      revision: this.revision,
      invalidated: dirtyCone.ordered,
      dirtyCone,
      requiresPathA2ReDecompile: tx.requiresPathA2ReDecompile,
    };
  }

  rollback(txArg = null) {
    const tx = txArg || this.activeTx;
    if (!tx || tx !== this.activeTx || tx.status !== 'open') {
      return { ok: false, reason: 'no_active_tx' };
    }
    this._loadSnapshot(tx.beforeSnapshot);
    tx.status = 'rolled_back';
    this.activeTx = null;
    return { ok: true, txId: tx.id, revision: this.revision };
  }

  /**
   * Helper to run a mutating callback atomically with automatic rollback on throw.
   */
  runAtomic(meta, fn, commitOptions = {}) {
    const tx = this.begin(meta);
    try {
      fn(tx, this);
      return this.commit(tx, commitOptions);
    } catch (err) {
      this.rollback(tx);
      throw err;
    }
  }

  canUndo() {
    return this.undoStack.length > 0 && !this.activeTx;
  }

  canRedo() {
    return this.redoStack.length > 0 && !this.activeTx;
  }

  undo(options = {}) {
    if (this.activeTx) {
      throw new Error('Cannot undo while a transaction is active');
    }
    if (this.undoStack.length === 0) {
      return { ok: false, reason: 'empty_undo_stack', revision: this.revision, invalidated: [] };
    }
    // Peek first; only mutate stacks/totalBytes/revision after all hooks & snapshot restore succeed
    const tx = this.undoStack[this.undoStack.length - 1];
    if (this.onAbortInflight) {
      this.onAbortInflight('undo-redo');
    }
    this._loadSnapshot(tx.beforeSnapshot);
    const dirtyCone = this._computeInvalidation(tx.dirtySeeds, options);

    this.undoStack.pop();
    this.totalBytes = Math.max(0, this.totalBytes - (tx.approxBytes || 0));
    this.redoStack.push(tx);
    this.revision += 1;

    return {
      ok: true,
      txId: tx.id,
      revision: this.revision,
      invalidated: dirtyCone.ordered,
      dirtyCone,
      requiresPathA2ReDecompile: tx.requiresPathA2ReDecompile,
    };
  }

  redo(options = {}) {
    if (this.activeTx) {
      throw new Error('Cannot redo while a transaction is active');
    }
    if (this.redoStack.length === 0) {
      return { ok: false, reason: 'empty_redo_stack', revision: this.revision, invalidated: [] };
    }
    // Peek first; only mutate stacks/totalBytes/revision after all hooks & snapshot restore succeed
    const tx = this.redoStack[this.redoStack.length - 1];
    if (this.onAbortInflight) {
      this.onAbortInflight('undo-redo');
    }
    this._loadSnapshot(tx.afterSnapshot);
    const dirtyCone = this._computeInvalidation(tx.dirtySeeds, options);

    this.redoStack.pop();
    this.undoStack.push(tx);
    this.totalBytes += tx.approxBytes || 0;
    this._evictIfNeeded();
    this.revision += 1;

    return {
      ok: true,
      txId: tx.id,
      revision: this.revision,
      invalidated: dirtyCone.ordered,
      dirtyCone,
      requiresPathA2ReDecompile: tx.requiresPathA2ReDecompile,
    };
  }

  clear() {
    this.activeTx = null;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.totalBytes = 0;
  }
}
