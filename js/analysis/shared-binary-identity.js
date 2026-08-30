import { createBinaryIdFromDigest } from '../core/identity/index.js';

function abortError(signal, message = 'Binary identity cancelled') {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function abortIfNeeded(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function scheduleBackground(signal) {
  abortIfNeeded(signal);
  if (globalThis.scheduler?.postTask) {
    return globalThis.scheduler.postTask(() => undefined, {
      priority:'background',
      signal:signal ?? undefined,
    });
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, abortError(signal));
    signal?.addEventListener('abort', onAbort, { once:true });
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => finish(resolve), { timeout:250 });
    } else {
      setTimeout(() => finish(resolve), 0);
    }
  });
}

function waitForEntry(entry, signal) {
  abortIfNeeded(signal);
  entry.waiters++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      entry.waiters = Math.max(0, entry.waiters - 1);
      fn(value);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      entry.waiters = Math.max(0, entry.waiters - 1);
      if (!entry.settled && entry.waiters === 0) entry.controller.abort('binary-identity-no-consumers');
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once:true });
    entry.promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

/**
 * Replace the compatibility BinaryId wrapper with one producer per file/epoch.
 * Consumer cancellation only detaches that waiter; the platform-worker hash is
 * cancelled when the last waiter leaves. Durable callers still receive the exact
 * full-content digest and stale file/epoch publication remains fail-closed.
 */
export function installSharedWorkerBinaryIdentity(app) {
  const backend = app?.backend;
  if (!backend || typeof backend.ensureContentHash !== 'function') return null;

  let current = null;
  backend.ensureBinaryId = function ensureSharedBinaryId(options = {}) {
    if (this.binaryId) return Promise.resolve(this.binaryId);
    if (!this.file) return Promise.reject(new Error('binary-id-file-unavailable'));

    const file = this.file;
    const epoch = Number(this.gen ?? this.analysisEpoch ?? 0);
    if (current && (current.file !== file || current.epoch !== epoch)) {
      if (!current.settled) current.controller.abort('binary-identity-binding-changed');
      current = null;
      this._binaryIdPromise = null;
    }

    if (!current) {
      const controller = new AbortController();
      const entry = {
        file, epoch, controller, waiters:0, settled:false, promise:null,
      };
      entry.promise = scheduleBackground(controller.signal)
        .then(() => this.ensureContentHash(options.onProgress, controller.signal))
        .then((hash) => {
          abortIfNeeded(controller.signal);
          if (this.file !== file || Number(this.gen ?? this.analysisEpoch ?? 0) !== epoch) {
            const error = new Error('stale binary identity');
            error.stale = true;
            throw error;
          }
          const binaryId = createBinaryIdFromDigest(hash);
          this.binaryId = binaryId;
          entry.settled = true;
          return binaryId;
        })
        .catch((error) => {
          if (current === entry) {
            current = null;
            this._binaryIdPromise = null;
          }
          throw error;
        });
      current = entry;
      this._binaryIdPromise = entry.promise;
    }

    return waitForEntry(current, options.signal ?? null);
  };

  return backend.ensureBinaryId;
}
