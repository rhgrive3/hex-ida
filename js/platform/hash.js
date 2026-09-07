import { asByteSource } from '../binary/source.js';

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

const explicitProgressCallbacks = new WeakMap();
// A valid class expression may put a comment between `class` and its name or
// body. The slash alternative is intentionally syntax-only: Function#toString
// has already returned source for a function-valued input, so this does not
// attempt to execute or inspect the constructor.
const DIRECT_CLASS_SOURCE = /^\s*class(?:\s|\/|\{)/;
// Bound functions and Proxy-wrapped functions deliberately stringify as native
// code. Treat every such opaque callable as unsafe by default: the standard
// reflection API cannot distinguish a bound ordinary callback from a bound
// class constructor without invoking user code.
const OPAQUE_FUNCTION_SOURCE = /^\s*(?:async\s+)?function(?:\s+[^\s(]+)?\s*\([^)]*\)\s*\{\s*\[native code\]\s*\}\s*$/;

/**
 * Explicitly opt in an opaque function (for example, a bound ordinary
 * callback) after the caller has established that it is callable. The token is
 * intentionally not itself callable, so an unwrapped opaque value remains a
 * fail-closed no-op at the public option boundary.
 */
export function createProgressCallback(callback) {
  if (typeof callback !== 'function') throw new TypeError('progress callback must be a function');
  let source;
  try {
    source = Function.prototype.toString.call(callback);
  } catch {
    throw new TypeError('progress callback must be callable');
  }
  if (DIRECT_CLASS_SOURCE.test(source)) throw new TypeError('progress callback must be callable');
  const token = Object.freeze({});
  explicitProgressCallbacks.set(token, callback);
  return token;
}

function optionalProgressCallback(value) {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    const explicit = explicitProgressCallbacks.get(value);
    if (explicit) return explicit;
  }
  if (typeof value !== 'function') return null;
  try {
    // Only source-transparent functions are safe to classify as callbacks
    // without trial invocation. Direct class constructors and opaque
    // native/bound/proxy functions are fail-closed no-ops.
    const source = Function.prototype.toString.call(value);
    if (DIRECT_CLASS_SOURCE.test(source) || OPAQUE_FUNCTION_SOURCE.test(source)) return null;
    return value;
  } catch {
    return null;
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('hash cancelled');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  throw error;
}

export async function hashByteSource(input, options = {}) {
  const source = asByteSource(input);
  const onProgress = optionalProgressCallback(options.onProgress);
  throwIfAborted(options.signal);
  const chunkSize = Math.min(options.chunkSize ?? 1024 * 1024, source.maxReadLength);
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new TypeError('chunkSize must be a positive safe integer');
  let hash = FNV_OFFSET;
  let offset = 0n;
  while (offset < source.size) {
    throwIfAborted(options.signal);
    const remaining = source.size - offset;
    const length = Number(remaining < BigInt(chunkSize) ? remaining : BigInt(chunkSize));
    const bytes = await source.readExactly(offset, length, { signal: options.signal });
    for (let i = 0; i < bytes.length; i++) {
      hash ^= BigInt(bytes[i]);
      hash = (hash * FNV_PRIME) & MASK64;
    }
    offset += BigInt(bytes.length);
    if (onProgress) Reflect.apply(onProgress, options, [{ done: offset, total: source.size }]);
  }
  return `fnv1a64:${source.size.toString(16)}:${hash.toString(16).padStart(16, '0')}`;
}

export function hashBytes(bytes) {
  let hash = FNV_OFFSET;
  for (const b of bytes || []) {
    if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > 255) {
      throw new TypeError('hashBytes byte must be an integer 0..255');
    }
    hash ^= BigInt(b);
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash.toString(16).padStart(16, '0');
}


function bytesHex(bytes) {
  return Array.from(bytes || []).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Cryptographic identity for a ByteSource without materializing the whole file.
 * Every byte participates: each fixed-size chunk is SHA-256 hashed, then an
 * ordered, domain-separated manifest of those digests is SHA-256 hashed again.
 * This is a tree/content hash, not the conventional SHA-256(file) encoding.
 */
export async function sha256TreeByteSource(input, options = {}) {
  const source = asByteSource(input);
  const onProgress = optionalProgressCallback(options.onProgress);
  throwIfAborted(options.signal);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    const error = new Error('SubtleCrypto SHA-256 is unavailable');
    error.code = 'SHA256_UNAVAILABLE';
    throw error;
  }
  const chunkSize = Math.min(options.chunkSize ?? 4 * 1024 * 1024, source.maxReadLength);
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new TypeError('chunkSize must be a positive safe integer');

  const digests = [];
  let offset = 0n;
  while (offset < source.size) {
    throwIfAborted(options.signal);
    const remaining = source.size - offset;
    const length = Number(remaining < BigInt(chunkSize) ? remaining : BigInt(chunkSize));
    const bytes = await source.readExactly(offset, length, { signal: options.signal });
    digests.push(new Uint8Array(await subtle.digest('SHA-256', bytes)));
    offset += BigInt(bytes.byteLength);
    if (onProgress) Reflect.apply(onProgress, options, [{ done: offset, total: source.size }]);
  }

  const header = new TextEncoder().encode(
    `hex-sha256-tree-v1\0${source.size.toString()}\0${chunkSize}\0${digests.length}\0`);
  const manifest = new Uint8Array(header.byteLength + digests.length * 32);
  manifest.set(header, 0);
  let at = header.byteLength;
  for (const digest of digests) { manifest.set(digest, at); at += digest.byteLength; }
  const root = new Uint8Array(await subtle.digest('SHA-256', manifest));
  return `sha256tree:v1:${source.size.toString(16)}:${bytesHex(root)}`;
}
