import { Backend as BaseBackend } from './backend-base.js';
import { createBinaryIdFromDigest } from './core/identity/index.js';

export * from './backend-base.js';

function binaryIdAbortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(signal?.reason == null ? 'Binary identity cancelled' : String(signal.reason));
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

/**
 * Canonical Backend keeps verified content identity on the platform-worker hash
 * route even when the UI bootstrap has not installed the shared/ref-counted
 * BinaryId wrapper yet. No pure-JS full-file SHA-256 work is allowed here.
 */
export class Backend extends BaseBackend {
  async ensureBinaryId(options = {}) {
    if (this.binaryId) return this.binaryId;
    if (!this.file) throw new Error('binary-id-file-unavailable');
    if (options.signal?.aborted) throw binaryIdAbortError(options.signal);

    const file = this.file;
    const epoch = Number(this.gen ?? this.analysisEpoch ?? 0);
    if (!this._binaryIdPromise) {
      let promise;
      promise = Promise.resolve(this.ensureContentHash(options.onProgress, options.signal ?? null))
        .then((hash) => {
          if (options.signal?.aborted) throw binaryIdAbortError(options.signal);
          if (this.file !== file || Number(this.gen ?? this.analysisEpoch ?? 0) !== epoch) {
            const error = new Error('stale binary identity');
            error.name = 'StaleRequestError';
            error.stale = true;
            throw error;
          }
          const binaryId = createBinaryIdFromDigest(hash);
          this.binaryId = binaryId;
          return binaryId;
        })
        .catch((error) => {
          if (this._binaryIdPromise === promise) this._binaryIdPromise = null;
          throw error;
        });
      this._binaryIdPromise = promise;
    }
    return this._binaryIdPromise;
  }
}
