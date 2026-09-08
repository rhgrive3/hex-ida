import { asByteSource } from '../binary/source.js';

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

// A valid class expression may put a comment between `class` and its name or
// body. The slash alternative is intentionally syntax-only: Function#toString
// has already returned source for a function-valued input, so this does not
// attempt to execute or inspect the constructor.
const DIRECT_CLASS_SOURCE = /^\s*class(?:\s|\/|\{)/;

function optionalProgressCallback(value) {
  if (typeof value !== 'function') return null;
  try {
    // The linked issue's public boundary is `typeof value === 'function'`.
    // Direct class syntax is the one constructor-only form that can be
    // identified without running user code; opaque function values retain the
    // existing callback behavior because standard reflection cannot distinguish
    // a bound ordinary callback from a bound class constructor.
    const source = Function.prototype.toString.call(value);
    if (DIRECT_CLASS_SOURCE.test(source)) return null;
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
  // Identity contract: the tree leaf size is a fixed default (or the explicit
  // option) and must not drift with the source's I/O read ceiling (#5942) —
  // identical byte sequences hash to one identity no matter how the source
  // chunks its reads. Reads larger than maxReadLength are assembled from
  // multiple bounded reads before digesting.
  const leafSize = options.chunkSize ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(leafSize) || leafSize <= 0) throw new TypeError('chunkSize must be a positive safe integer');
  const readSize = Math.max(1, Math.min(leafSize, source.maxReadLength));
  const reportProgress = (done) => {
    if (onProgress) Reflect.apply(onProgress, options, [{ done, total: source.size }]);
  };

  const digests = [];
  let offset = 0n;
  while (offset < source.size) {
    throwIfAborted(options.signal);
    const remaining = source.size - offset;
    const leafLength = Number(remaining < BigInt(leafSize) ? remaining : BigInt(leafSize));
    let bytes;
    if (leafLength <= readSize) {
      bytes = await source.readExactly(offset, leafLength, { signal: options.signal });
      reportProgress(offset + BigInt(bytes.byteLength));
    } else {
      bytes = new Uint8Array(leafLength);
      for (let at = 0; at < leafLength; at += readSize) {
        const take = Math.min(readSize, leafLength - at);
        const chunk = await source.readExactly(offset + BigInt(at), take, { signal: options.signal });
        bytes.set(chunk, at);
        // Preserve the historical progress contract: callbacks observe each
        // bounded source read, even when several reads form one logical leaf.
        reportProgress(offset + BigInt(at + chunk.byteLength));
      }
    }
    digests.push(new Uint8Array(await subtle.digest('SHA-256', bytes)));
    offset += BigInt(bytes.byteLength);
  }

  // The leaf boundary is part of the digest algorithm.  The previous v1
  // implementation silently used maxReadLength as that boundary, so changing
  // it while retaining the v1 marker would make old persisted v1 identities
  // indistinguishable from this algorithm.  Keep the fixed-leaf contract
  // explicitly versioned; note migration handles existing v1 namespaces.
  const header = new TextEncoder().encode(
    `hex-sha256-tree-v2\0${source.size.toString()}\0${leafSize}\0${digests.length}\0`);
  const manifest = new Uint8Array(header.byteLength + digests.length * 32);
  manifest.set(header, 0);
  let at = header.byteLength;
  for (const digest of digests) { manifest.set(digest, at); at += digest.byteLength; }
  const root = new Uint8Array(await subtle.digest('SHA-256', manifest));
  return `sha256tree:v2:${source.size.toString(16)}:${bytesHex(root)}`;
}
