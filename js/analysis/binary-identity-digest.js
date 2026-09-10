import { sha256BlobHex } from '../cache/content-identity.js';

const SHA256_HEX_DIGEST = /^[0-9a-f]{64}$/;

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

export function canonicalContentDigest(backend, hash, signal, onProgress) {
  const digest = canonicalSha256DigestOrNull(hash);
  if (digest != null) return Promise.resolve(digest);
  return sha256BlobHex(backend.file, { signal, onProgress }).then((result) => result.hex);
}
