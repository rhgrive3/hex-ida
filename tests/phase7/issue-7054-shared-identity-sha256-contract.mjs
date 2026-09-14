// Issue #7054 regression: the shared binary-identity override must mint
// `bin_sha256_` identities only from an exact SHA-256 digest. The platform
// worker content hash is an FNV-1a cache key (`fnv1a64:<size>:<hex>`) and used
// to be fed straight into createBinaryIdFromDigest(), so every cold
// ensureBinaryId() failed with `binary-id-invalid-sha256`.
import assert from 'node:assert/strict';
import { MemoryByteSource } from '../../js/binary/source.js';
import { hashByteSource } from '../../js/platform/hash.js';
import { installSharedWorkerBinaryIdentity } from '../../js/analysis/shared-binary-identity.js';
import { installDemandDrivenAnalysis } from '../../js/analysis/demand-driven-runtime.js';

const bytes = Uint8Array.of(0x7f, 0x45, 0x4c, 0x46);
const fnvHash = await hashByteSource(new MemoryByteSource(bytes));
assert.match(fnvHash, /^fnv1a64:/, 'platform content hash must be the FNV cache key');

// A canonical SHA-256-shaped digest from ensureContentHash() still mints
// directly (worker producers that already emit SHA-256 keep their contract).
{
  const backend = { file: { size: bytes.length }, gen: 1, binaryId: null, async ensureContentHash() { return 'ab'.repeat(32); } };
  installSharedWorkerBinaryIdentity({ backend });
  const binaryId = await backend.ensureBinaryId();
  assert.equal(binaryId, `bin_sha256_${'ab'.repeat(32)}`);
}

// The issue repro: an FNV content hash must not throw
// `binary-id-invalid-sha256` and must not be laundered into an identity.
// The worker-backed path re-derives the digest with the canonical
// full-content SHA-256 producer over backend.file.
{
  const blob = {
    size: bytes.length,
    slice(start, end) {
      return { arrayBuffer: async () => bytes.slice(start, end).buffer };
    },
  };
  const backend = {
    file: blob,
    gen: 1,
    binaryId: null,
    contentHash: fnvHash,
    async ensureContentHash() { return this.contentHash; },
  };
  installSharedWorkerBinaryIdentity({ backend });
  const binaryId = await backend.ensureBinaryId();
  assert.match(binaryId, /^bin_sha256_[0-9a-f]{64}$/, 'cold identity must be a canonical SHA-256 BinaryId');
  assert.notEqual(binaryId, `bin_sha256_${fnvHash}`);
  const second = await backend.ensureBinaryId();
  assert.equal(second, binaryId, 'repeat requests must stay bound to the same identity');
}

// The demand-driven worker-backed identity override has the same contract.
{
  const blob = {
    size: bytes.length,
    slice(start, end) {
      return { arrayBuffer: async () => bytes.slice(start, end).buffer };
    },
  };
  const app = {
    backend: {
      file: blob,
      gen: 1,
      binaryId: null,
      contentHash: fnvHash,
      async ensureContentHash() { return this.contentHash; },
    },
    store: { get: () => null },
    ensureRecognition: async () => null,
  };
  installDemandDrivenAnalysis(app);
  const binaryId = await app.backend.ensureBinaryId();
  assert.match(binaryId, /^bin_sha256_[0-9a-f]{64}$/);
}

// A structured / non-hex hash value must fail closed into the SHA-256
// re-derivation, never become an identity.
{
  const backend = {
    file: {
      size: bytes.length,
      slice(start, end) { return { arrayBuffer: async () => bytes.slice(start, end).buffer }; },
    },
    gen: 1,
    binaryId: null,
    async ensureContentHash() { return ['fnv1a64:4:28b265382f1249f3']; },
  };
  installSharedWorkerBinaryIdentity({ backend });
  const binaryId = await backend.ensureBinaryId();
  assert.match(binaryId, /^bin_sha256_[0-9a-f]{64}$/);
}

console.log('issue #7054 shared binary identity sha256 contract: PASS');
