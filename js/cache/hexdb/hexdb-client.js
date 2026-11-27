/**
 * HEX-DB Main-Thread Async RPC Client
 *
 * Provides automatic backend tier selection (`opfs` -> `idb` -> `memory`),
 * request timeouts, AbortSignal cancellation, `messageerror` handling,
 * and clean idempotent `dispose()` without unhandled rejection races.
 */

import {
  HexDbWorkerHost,
  HEXDB_RPC_REQ,
  HEXDB_RPC_RES,
  HEXDB_RPC_CANCEL,
} from './hexdb-worker.js';

export const DEFAULT_RPC_TIMEOUT_MS = 10000;

export class HexDbRpcError extends Error {
  constructor(message, code = 'HEXDB_RPC_ERROR') {
    super(message);
    this.name = 'HexDbRpcError';
    this.code = code;
  }
}

function makeAbortError(signal) {
  const err = new HexDbRpcError(
    signal?.reason?.message || (typeof signal?.reason === 'string' ? signal.reason : 'HEX-DB request cancelled'),
    'HEXDB_CANCELLED'
  );
  err.name = 'AbortError';
  return err;
}

export class HexDbClient {
  constructor(options = {}) {
    this._defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this._worker = options.worker ?? null;
    this._ownsWorker = false;
    this._localHost = options.host ?? null;
    this._hostOptions = options.hostOptions ?? {};
    this._nextId = 1;
    this._pending = new Map();
    this._disposed = false;
    this._tier = null;

    if (!this._worker && typeof options.workerFactory === 'function') {
      this._worker = options.workerFactory();
      this._ownsWorker = true;
    }

    if (this._worker) {
      this._onMessage = (event) => this._handleMessage(event?.data ?? event);
      this._onError = (event) => {
        const msg = event?.message || 'HEX-DB worker error';
        this._rejectAllPending(new HexDbRpcError(msg, 'HEXDB_WORKER_ERROR'));
      };
      this._onMessageError = () => {
        this._rejectAllPending(new HexDbRpcError('HEX-DB worker message deserialization error', 'HEXDB_MESSAGE_ERROR'));
      };
      if (typeof this._worker.addEventListener === 'function') {
        this._worker.addEventListener('message', this._onMessage);
        this._worker.addEventListener('error', this._onError);
        this._worker.addEventListener('messageerror', this._onMessageError);
      } else {
        this._worker.onmessage = this._onMessage;
        this._worker.onerror = this._onError;
        this._worker.onmessageerror = this._onMessageError;
      }
    } else if (!this._localHost) {
      this._localHost = new HexDbWorkerHost(this._hostOptions);
    }
  }

  get tier() {
    return this._tier;
  }

  get disposed() {
    return this._disposed;
  }

  get pendingCount() {
    return this._pending.size;
  }

  _handleMessage(msg) {
    if (!msg || typeof msg !== 'object' || msg.type !== HEXDB_RPC_RES) return;
    const entry = this._pending.get(msg.id);
    if (!entry) return;
    this._pending.delete(msg.id);
    if (entry.timer != null) clearTimeout(entry.timer);
    if (entry.cleanupAbort) entry.cleanupAbort();

    if (msg.ok) {
      entry.resolve(msg.result);
    } else {
      const code = msg.error?.code || 'HEXDB_RPC_ERROR';
      const err = new HexDbRpcError(msg.error?.message || 'HEX-DB RPC failed', code);
      if (code === 'HEXDB_CANCELLED') err.name = 'AbortError';
      entry.reject(err);
    }
  }

  _rejectAllPending(error) {
    for (const [, entry] of this._pending) {
      if (entry.timer != null) clearTimeout(entry.timer);
      if (entry.cleanupAbort) entry.cleanupAbort();
      entry.reject(error);
    }
    this._pending.clear();
  }

  _sendCancel(id) {
    if (this._worker) {
      try {
        this._worker.postMessage({ type: HEXDB_RPC_CANCEL, id });
      } catch {
        // Ignore postMessage failure during teardown
      }
    } else if (this._localHost) {
      void this._localHost.handleMessage({ type: HEXDB_RPC_CANCEL, id });
    }
  }

  /**
   * Explicitly cancel an in-flight request by ID.
   */
  cancelRequest(id) {
    const entry = this._pending.get(id);
    if (!entry) return false;
    this._pending.delete(id);
    if (entry.timer != null) clearTimeout(entry.timer);
    if (entry.cleanupAbort) entry.cleanupAbort();
    this._sendCancel(id);
    const err = new HexDbRpcError('HEX-DB request cancelled', 'HEXDB_CANCELLED');
    err.name = 'AbortError';
    entry.reject(err);
    return true;
  }

  /**
   * Issue an RPC call with optional timeoutMs and AbortSignal.
   */
  call(method, params = {}, { timeoutMs = this._defaultTimeoutMs, signal = null } = {}) {
    if (this._disposed) {
      return Promise.reject(new HexDbRpcError('HEX-DB client has been disposed', 'HEXDB_DISPOSED'));
    }
    if (signal?.aborted) {
      return Promise.reject(makeAbortError(signal));
    }

    const id = this._nextId++;

    return new Promise((resolve, reject) => {
      let timer = null;
      let cleanupAbort = null;

      if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!this._pending.has(id)) return;
          this._pending.delete(id);
          if (cleanupAbort) cleanupAbort();
          this._sendCancel(id);
          reject(new HexDbRpcError(`HEX-DB request '${method}' timed out after ${timeoutMs}ms`, 'HEXDB_TIMEOUT'));
        }, timeoutMs);
      }

      if (signal) {
        const onAbort = () => {
          if (!this._pending.has(id)) return;
          this._pending.delete(id);
          if (timer != null) clearTimeout(timer);
          this._sendCancel(id);
          reject(makeAbortError(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        cleanupAbort = () => signal.removeEventListener('abort', onAbort);
      }

      this._pending.set(id, { resolve, reject, timer, cleanupAbort });

      const req = { type: HEXDB_RPC_REQ, id, method, params };
      if (this._worker) {
        try {
          this._worker.postMessage(req);
        } catch (err) {
          this._pending.delete(id);
          if (timer != null) clearTimeout(timer);
          if (cleanupAbort) cleanupAbort();
          reject(new HexDbRpcError(err?.message || 'postMessage failed', 'HEXDB_TRANSPORT_ERROR'));
        }
      } else {
        // Capture host in closure and guard against concurrent dispose() to prevent Unhandled Rejection.
        const host = this._localHost;
        Promise.resolve()
          .then(() => {
            if (this._disposed || !host) return;
            return host.handleMessage(req, (response) => {
              if (!this._disposed) this._handleMessage(response);
            });
          })
          .catch((err) => {
            if (!this._disposed && this._pending.has(id)) {
              this._handleMessage({
                type: HEXDB_RPC_RES,
                id,
                ok: false,
                error: { code: err?.code || 'HEXDB_RPC_ERROR', message: err?.message || String(err) },
              });
            }
          });
      }
    });
  }

  async open(options = {}, rpcOpts = {}) {
    const res = await this.call('open', options, rpcOpts);
    this._tier = res?.tier ?? null;
    return res;
  }

  get(shard, key, rpcOpts = {}) {
    return this.call('get', { shard, key }, rpcOpts);
  }

  put(shard, key, value, rpcOpts = {}) {
    return this.call('put', { shard, key, value }, rpcOpts);
  }

  del(shard, key, rpcOpts = {}) {
    return this.call('del', { shard, key }, rpcOpts);
  }

  batch(ops, rpcOpts = {}) {
    return this.call('batch', { ops }, rpcOpts);
  }

  checkpoint(rpcOpts = {}) {
    return this.call('checkpoint', {}, rpcOpts);
  }

  listKeys(shard, rpcOpts = {}) {
    return this.call('listKeys', { shard }, rpcOpts);
  }

  stats(rpcOpts = {}) {
    return this.call('stats', {}, rpcOpts);
  }

  close(rpcOpts = {}) {
    return this.call('close', {}, rpcOpts);
  }

  enqueueConvergerTask(task, rpcOpts = {}) {
    return this.call('converger.enqueue', task, rpcOpts);
  }

  stepConverger(budgetMs, maxItems, rpcOpts = {}) {
    return this.call('converger.step', { budgetMs, maxItems }, rpcOpts);
  }

  getConvergerStatus(rpcOpts = {}) {
    return this.call('converger.status', {}, rpcOpts);
  }

  async dispose() {
    if (this._disposed) return;
    this._disposed = true;

    this._rejectAllPending(new HexDbRpcError('HEX-DB client disposed', 'HEXDB_DISPOSED'));

    if (this._worker) {
      if (typeof this._worker.removeEventListener === 'function') {
        this._worker.removeEventListener('message', this._onMessage);
        this._worker.removeEventListener('error', this._onError);
        this._worker.removeEventListener('messageerror', this._onMessageError);
      } else {
        this._worker.onmessage = null;
        this._worker.onerror = null;
        this._worker.onmessageerror = null;
      }
      if (this._ownsWorker && typeof this._worker.terminate === 'function') {
        this._worker.terminate();
      }
      this._worker = null;
    }

    if (this._localHost) {
      const host = this._localHost;
      this._localHost = null;
      await host.dispose();
    }
  }
}
