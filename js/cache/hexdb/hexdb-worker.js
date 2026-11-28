/**
 * HEX-DB Dedicated Module Worker Entrypoint & Pure RPC Host (`HexDbWorkerHost`)
 *
 * Hosts OPFS / IndexedDB / Memory sharded backend + WAL + Background Converger
 * over structured-clone RPC messages.
 *
 * Hardening:
 * - Never spreads `this._env` when probing OPFS (preserves non-enumerable
 *   prototype getters like `DedicatedWorkerGlobalScope.prototype.navigator`).
 * - Immediately skips OPFS/IDB and degrades to Tier C (`memory`) on opaque
 *   origins (`env?.location?.origin === 'null'`).
 * - Tracks `_inFlightIds` and cleans up `_cancelledIds` in `finally` to prevent
 *   unbounded Set growth.
 * - Unregisters `MemoryBudget` evictors cleanly on re-`open()`, `close()`, and `dispose()`.
 * - Serializes mutating RPCs (`open`, `put`, `del`, `batch`, `checkpoint`, `close`)
 *   through a single-writer Promise queue.
 */

import { HexDbOpfsBackend, isOpfsSyncAvailable } from './hexdb-opfs.js';
import { HexDbIdbBackend, isIdbAvailable } from './hexdb-idb.js';
import { HexDbMemoryBackend } from './hexdb-memory.js';
import { HexDbConverger } from './hexdb-converger.js';
import { detectRuntimeProfile } from '../../core/budgets/runtime-profile.js';
import { MemoryBudget, MEMORY_CATEGORY_HEXDB } from '../../core/budgets/memory-budget.js';

export const HEXDB_RPC_REQ = 'hexdb:req';
export const HEXDB_RPC_RES = 'hexdb:res';
export const HEXDB_RPC_CANCEL = 'hexdb:cancel';
export const HEXDB_RPC_EVENT = 'hexdb:event';

const FOREGROUND_METHODS = new Set(['get', 'put', 'del', 'batch', 'listKeys']);
const MUTATING_METHODS = new Set(['open', 'put', 'del', 'batch', 'checkpoint', 'close']);

export class HexDbWorkerHost {
  constructor(options = {}) {
    this._env = options.env ?? globalThis;
    this._opfsRoot = options.opfsRoot ?? null;
    this._indexedDB = options.indexedDB ?? null;
    this._profile = options.runtimeProfile ?? detectRuntimeProfile({ env: this._env });
    this._memoryBudget = options.memoryBudget ?? new MemoryBudget({ profile: this._profile });
    this._backend = options.backend ?? null;
    this._converger = options.converger ?? new HexDbConverger({
      sliceBudgetMs: this._profile.converger.sliceBudgetMs,
      checkpointEveryBatches: this._profile.converger.checkpointEveryBatches,
      checkpointIntervalMs: this._profile.converger.checkpointIntervalMs,
      ...(options.convergerOptions ?? {}),
    });
    this._inFlightIds = new Set();
    this._cancelledIds = new Set();
    this._unregisterEvictor = null;
    this._writeQueue = Promise.resolve();
    this._postMessage = options.postMessage ?? null;
    this._disposed = false;

    this._unsubscribePressure = this._memoryBudget.onPressureChange((ev) => {
      if (ev.pauseBackground) {
        this._converger.pauseForPressure();
      } else {
        this._converger.resumeFromPressure();
      }
    });
  }

  get backend() {
    return this._backend;
  }

  get converger() {
    return this._converger;
  }

  get memoryBudget() {
    return this._memoryBudget;
  }

  get profile() {
    return this._profile;
  }

  _enqueueWrite(fn) {
    const next = this._writeQueue.then(fn, fn);
    this._writeQueue = next.then(() => {}, () => {});
    return next;
  }

  _clearEvictor() {
    if (this._unregisterEvictor) {
      try {
        this._unregisterEvictor();
      } catch {
        // Ignore cleanup errors
      }
      this._unregisterEvictor = null;
    }
  }

  _isOpaqueOrigin() {
    try {
      return this._env?.location?.origin === 'null';
    } catch {
      return true;
    }
  }

  async _selectAndOpenBackend(params = {}) {
    const preferred = params.preferredTier ?? 'auto';
    const binaryKey = params.binaryKey ?? 'default';
    const shardMaxBytes = params.shardMaxBytes ?? this._profile.hexdb.shardMaxBytes;
    const walMaxBytes = params.walMaxBytes ?? this._profile.hexdb.walMaxBytes;

    // Opaque origin (e.g. sandboxed Userscript iframe with origin === 'null'):
    // immediately skip OPFS & IDB and degrade cleanly to Tier C (memory).
    const opaque = this._isOpaqueOrigin();
    let tryOrder;
    if (opaque) {
      tryOrder = ['memory'];
    } else if (preferred === 'auto') {
      tryOrder = ['opfs', 'idb', 'memory'];
    } else {
      tryOrder = [preferred, 'memory'];
    }

    let lastErr = null;
    for (let i = 0; i < tryOrder.length; i++) {
      const tier = tryOrder[i];
      try {
        if (tier === 'opfs') {
          const explicitRoot = params.opfsRoot ?? this._opfsRoot ?? null;
          // Pass `this._env` directly WITHOUT spreading so non-enumerable
          // prototype getters (e.g. DedicatedWorkerGlobalScope.prototype.navigator) work.
          const ok = await isOpfsSyncAvailable(this._env, { rootDir: explicitRoot });
          if (!ok) continue;
          const resolvedRoot = explicitRoot ?? (await this._env?.navigator?.storage?.getDirectory?.());
          if (!resolvedRoot) continue;
          const backend = new HexDbOpfsBackend({
            rootDir: resolvedRoot,
            binaryKey,
            shardMaxBytes,
            walMaxBytes,
          });
          const res = await backend.open({ binaryKey, shardMaxBytes, walMaxBytes });
          this._backend = backend;
          this._converger._store = backend;
          return res;
        }
        if (tier === 'idb') {
          const idb = params.indexedDB ?? this._indexedDB ?? this._env?.indexedDB;
          if (!isIdbAvailable({ indexedDB: idb, location: this._env?.location })) continue;
          const backend = new HexDbIdbBackend({
            indexedDB: idb,
            dbName: params.dbName,
            binaryKey,
            shardMaxBytes,
            walMaxBytes,
          });
          const res = await backend.open({ binaryKey, shardMaxBytes, walMaxBytes });
          this._backend = backend;
          this._converger._store = backend;
          return res;
        }
        if (tier === 'memory') {
          const backend = new HexDbMemoryBackend({
            binaryKey,
            maxBytes: params.maxBytes ?? this._profile.hexdb.memoryFallbackCapBytes,
            shardMaxBytes,
            walMaxBytes,
          });
          const res = await backend.open({ binaryKey, shardMaxBytes, walMaxBytes });
          this._backend = backend;
          this._converger._store = backend;
          this._clearEvictor();
          this._unregisterEvictor = this._memoryBudget.registerEvictor('hexdb-memory-backend', {
            category: MEMORY_CATEGORY_HEXDB,
            priority: 0,
            evict: (needed) => {
              const cur = backend._totalBytes;
              const target = Math.max(0, cur - needed);
              return backend.evictToBytes(target);
            },
          });
          return res;
        }
      } catch (err) {
        lastErr = err;
        if (preferred !== 'auto' && tier === preferred && params.strictTier) {
          throw err;
        }
      }
    }
    throw lastErr || new Error('HEXDB_NO_BACKEND_AVAILABLE');
  }

  _requireBackend() {
    if (!this._backend) {
      throw new Error('HEXDB_NOT_OPEN: call open() before storage operations');
    }
    return this._backend;
  }

  async _syncMemoryAccounting() {
    if (!this._backend) return;
    try {
      const s = await this._backend.stats();
      this._memoryBudget.setUsage(MEMORY_CATEGORY_HEXDB, s.totalBytes + s.walBytes);
    } catch {
      // Ignore accounting errors if closed
    }
  }

  async _executeMethod(method, params, reqId) {
    if (this._disposed) {
      throw new Error('HEXDB_HOST_DISPOSED');
    }
    if (reqId != null && this._cancelledIds.has(reqId)) {
      const err = new Error('Request cancelled');
      err.code = 'HEXDB_CANCELLED';
      throw err;
    }

    switch (method) {
      case 'ping':
        return { pong: true, tier: this._backend?.tier ?? null };

      case 'open': {
        this._clearEvictor();
        if (this._backend) {
          await this._backend.close();
          this._backend = null;
        }
        const res = await this._selectAndOpenBackend(params);
        await this._syncMemoryAccounting();
        return res;
      }

      case 'get': {
        const b = this._requireBackend();
        return await b.get(params.shard, params.key);
      }

      case 'put': {
        const b = this._requireBackend();
        const res = await b.put(params.shard, params.key, params.value);
        await this._syncMemoryAccounting();
        return res;
      }

      case 'del': {
        const b = this._requireBackend();
        const res = await b.del(params.shard, params.key);
        await this._syncMemoryAccounting();
        return res;
      }

      case 'batch': {
        const b = this._requireBackend();
        const res = await b.batch(params.ops);
        await this._syncMemoryAccounting();
        return res;
      }

      case 'checkpoint': {
        const b = this._requireBackend();
        const res = await b.checkpoint();
        await this._syncMemoryAccounting();
        return res;
      }

      case 'listKeys': {
        const b = this._requireBackend();
        return await b.listKeys(params.shard);
      }

      case 'stats': {
        const b = this._requireBackend();
        const st = await b.stats();
        return {
          ...st,
          converger: this._converger.getProgress(),
          memoryBudget: this._memoryBudget.getSnapshot(),
        };
      }

      case 'close': {
        this._converger.stop();
        this._clearEvictor();
        if (this._backend) {
          await this._backend.close();
          this._backend = null;
        }
        this._memoryBudget.setUsage(MEMORY_CATEGORY_HEXDB, 0);
        return { closed: true };
      }

      case 'converger.enqueue': {
        const id = this._converger.enqueue(params);
        return { id, progress: this._converger.getProgress() };
      }

      case 'converger.step': {
        return await this._converger.runSlice(params.budgetMs, params.maxItems);
      }

      case 'converger.start': {
        this._converger.start();
        return this._converger.getProgress();
      }

      case 'converger.pause': {
        this._converger.pause();
        return this._converger.getProgress();
      }

      case 'converger.resume': {
        this._converger.resume();
        return this._converger.getProgress();
      }

      case 'converger.status': {
        return this._converger.getProgress();
      }

      default: {
        const err = new Error(`HEXDB_UNKNOWN_METHOD: ${method}`);
        err.code = 'HEXDB_UNKNOWN_METHOD';
        throw err;
      }
    }
  }

  /**
   * Handle a single RPC method invocation.
   * Mutating methods are serialized through `_writeQueue`; foreground methods
   * immediately yield the background converger.
   */
  async dispatch(method, params = {}, reqId = null) {
    if (this._disposed) {
      throw new Error('HEXDB_HOST_DISPOSED');
    }

    const run = async () => {
      const isForeground = FOREGROUND_METHODS.has(method);
      if (isForeground) {
        this._converger.notifyForegroundStart();
      }
      try {
        return await this._executeMethod(method, params, reqId);
      } finally {
        if (isForeground) {
          this._converger.notifyForegroundEnd();
        }
      }
    };

    if (MUTATING_METHODS.has(method)) {
      return this._enqueueWrite(run);
    }
    return run();
  }

  /**
   * Handle an incoming structured-clone message (`hexdb:req` or `hexdb:cancel`).
   */
  async handleMessage(msg, reply = this._postMessage) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === HEXDB_RPC_CANCEL) {
      if (msg.id != null && this._inFlightIds.has(msg.id)) {
        this._cancelledIds.add(msg.id);
      }
      return;
    }
    if (msg.type !== HEXDB_RPC_REQ) return;

    const { id, method, params } = msg;
    this._inFlightIds.add(id);
    try {
      const result = await this.dispatch(method, params, id);
      if (this._cancelledIds.has(id)) {
        reply?.({
          type: HEXDB_RPC_RES,
          id,
          ok: false,
          error: { code: 'HEXDB_CANCELLED', message: 'Request cancelled' },
        });
        return;
      }
      const transfer = [];
      if (result instanceof Uint8Array && result.byteOffset === 0 && result.byteLength === result.buffer.byteLength) {
        transfer.push(result.buffer);
      }
      reply?.({ type: HEXDB_RPC_RES, id, ok: true, result }, transfer);
    } catch (err) {
      reply?.({
        type: HEXDB_RPC_RES,
        id,
        ok: false,
        error: {
          code: err?.code || 'HEXDB_ERROR',
          message: err?.message || String(err),
        },
      });
    } finally {
      this._inFlightIds.delete(id);
      this._cancelledIds.delete(id);
    }
  }

  async dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._unsubscribePressure?.();
    this._clearEvictor();
    this._converger.dispose();
    if (this._backend) {
      await this._backend.close();
      this._backend = null;
    }
    this._memoryBudget.setUsage(MEMORY_CATEGORY_HEXDB, 0);
    this._inFlightIds.clear();
    this._cancelledIds.clear();
  }
}

// Auto-bind only inside a real Dedicated Web Worker (never in Node or Window).
const isDedicatedWorker = typeof self !== 'undefined'
  && typeof self.postMessage === 'function'
  && typeof window === 'undefined'
  && typeof process === 'undefined';

if (isDedicatedWorker) {
  const host = new HexDbWorkerHost({
    postMessage: (payload, transfer) => self.postMessage(payload, transfer ?? []),
  });
  self.onmessage = (event) => {
    void host.handleMessage(event?.data);
  };
}
