import { sha256BlobHex } from '../cache/content-identity.js';

const SHA256_HEX_DIGEST = /^[0-9a-f]{64}$/;
const SUBTLE_SHA256_MAX_BYTES = 64 * 1024 * 1024;

function abortError(signal) {
  if (signal?.reason !== undefined) return signal.reason;
  if (typeof DOMException === 'function') return new DOMException('Aborted', 'AbortError');
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function awaitWorkerRequest(request, signal) {
  const promise = Promise.resolve(request);
  if (!signal) return promise;
  if (signal.aborted) {
    try { request?.cancel?.(); } catch { /* best effort */ }
    void promise.catch(() => {});
    return Promise.reject(abortError(signal));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener?.('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      try { request?.cancel?.(); } catch { /* best effort */ }
      finish(reject, abortError(signal));
    };
    signal.addEventListener?.('abort', onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

async function workerSha256Digest(backend, signal, onProgress) {
  if (typeof backend?._callTo !== 'function' || !backend.platformWorker) return null;
  try {
    const result = await awaitWorkerRequest(
      backend._callTo('platform', 'sha256', {}, null, onProgress),
      signal,
    );
    return canonicalSha256DigestOrNull(result?.hex ?? result?.sha256 ?? result?.digest ?? result);
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.stale) {
      throw error;
    }
    return null;
  }
}

async function subtleSha256BlobHex(blob, signal, onProgress) {
  const subtle = globalThis.crypto?.subtle;
  if (typeof subtle?.digest !== 'function') return null;
  if (!blob || !Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > SUBTLE_SHA256_MAX_BYTES) return null;
  if (typeof blob.slice !== 'function' && typeof blob.arrayBuffer !== 'function') return null;
  throwIfAborted(signal);
  let buffer;
  if (blob.size === 0) {
    buffer = new ArrayBuffer(0);
  } else if (typeof blob.slice === 'function') {
    const part = blob.slice(0, blob.size);
    if (!part || typeof part.arrayBuffer !== 'function') return null;
    buffer = await part.arrayBuffer();
  } else {
    buffer = await blob.arrayBuffer();
  }
  throwIfAborted(signal);
  if (buffer.byteLength !== blob.size) {
    throw new Error(`sha256 truncated read: expected ${blob.size}, received ${buffer.byteLength}`);
  }
  const digest = await subtle.digest('SHA-256', buffer);
  throwIfAborted(signal);
  const hex = bytesToHex(new Uint8Array(digest));
  if (typeof onProgress === 'function') {
    onProgress({ bytesRead: blob.size, totalBytes: blob.size, reads: blob.size > 0 ? 1 : 0 });
  }
  return hex;
}

// `bin_sha256_` identities bind an exact SHA-256 digest. The platform-worker
// content hash is an FNV-1a cache key (`fnv1a64:<size>:<hex>`); laundering it
// into createBinaryIdFromDigest() failed every cold ensureBinaryId() with
// `binary-id-invalid-sha256` (#7054). A hash that is not already a canonical
// digest is re-derived from the same full-content SHA-256 producer the default
// identity path uses; identity contract is never weakened to accept it.
export function canonicalSha256DigestOrNull(hash) {
  if (typeof hash !== 'string') return null;
  const normalized = hash.toLowerCase().replace(/^sha256:/, '');
  return SHA256_HEX_DIGEST.test(normalized) ? normalized : null;
}

export async function canonicalContentDigest(backend, hash, signal, onProgress) {
  const digest = canonicalSha256DigestOrNull(hash);
  if (digest != null) return digest;
  throwIfAborted(signal);
  const fromWorker = await workerSha256Digest(backend, signal, onProgress);
  if (fromWorker != null) return fromWorker;
  throwIfAborted(signal);
  const fromSubtle = await subtleSha256BlobHex(backend?.file, signal, onProgress);
  if (fromSubtle != null) return fromSubtle;
  const result = await sha256BlobHex(backend.file, { signal, onProgress });
  return result.hex;
}
