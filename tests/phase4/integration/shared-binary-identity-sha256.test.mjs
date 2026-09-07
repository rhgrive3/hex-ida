import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { Backend } from '../../../js/backend.js';
import { installSharedWorkerBinaryIdentity } from '../../../js/analysis/shared-binary-identity.js';
import { createBinaryIdFromDigest } from '../../../js/core/identity/index.js';
import { MemoryByteSource } from '../../../js/binary/source.js';
import { hashByteSource, sha256ByteSource } from '../../../js/platform/hash.js';

const bytes = Uint8Array.from({ length: 257 }, (_, index) => (index * 37 + 11) & 0xff);
const source = new MemoryByteSource(bytes, { maxReadLength: 64 });
const fnv = await hashByteSource(source, { chunkSize: 64 });
const sha256 = await sha256ByteSource(source, { chunkSize: 64 });
const expectedSha256 = createHash('sha256').update(bytes).digest('hex');

assert.match(fnv, /^fnv1a64:/, 'contentHash keeps its cheap FNV contract');
assert.equal(sha256, expectedSha256, 'canonical worker digest must be conventional SHA-256');
assert.throws(() => createBinaryIdFromDigest(fnv), /binary-id-invalid-sha256/);
assert.equal(createBinaryIdFromDigest(sha256), `bin_sha256_${expectedSha256}`);

const backend = Object.create(Backend.prototype);
backend.file = { size: bytes.byteLength };
backend.analysisEpoch = 1;
backend.transportEpoch = 1;
backend.sha256ContentHash = null;
backend.contentHash = null;
backend._callTo = (_worker, type) => {
  if (type === 'hash') return Promise.resolve({ hash: fnv });
  if (type === 'sha256') return Promise.resolve({ hash: sha256 });
  throw new Error(`unexpected backend request: ${type}`);
};
assert.equal(await backend.ensureContentHash(), fnv);
assert.equal(await backend.ensureSha256ContentHash(), expectedSha256);
assert.equal(backend.contentHash, fnv, 'FNV contentHash must remain separate from SHA-256 identity');

let cancelled = 0;
const cancellableBackend = Object.create(Backend.prototype);
cancellableBackend.file = { size: bytes.byteLength };
cancellableBackend.analysisEpoch = 1;
cancellableBackend.transportEpoch = 1;
cancellableBackend.sha256ContentHash = null;
cancellableBackend._callTo = () => {
  let rejectOperation;
  const operation = new Promise((_, reject) => { rejectOperation = reject; });
  operation.cancel = () => {
    cancelled++;
    const error = new Error('worker SHA-256 cancelled');
    error.name = 'AbortError';
    rejectOperation(error);
  };
  return operation;
};
const cancellation = new AbortController();
const pendingSha = cancellableBackend.ensureSha256ContentHash(null, cancellation.signal);
cancellation.abort(new DOMException('last waiter left', 'AbortError'));
await assert.rejects(pendingSha, (error) => error?.name === 'AbortError');
assert.equal(cancelled, 1, 'last BinaryId waiter cancellation must cancel the SHA-256 worker request');

let canonicalCalls = 0;
const shared = {
  binaryId: null,
  file: { size: bytes.byteLength },
  gen: 1,
  ensureContentHash: async () => fnv,
  ensureSha256ContentHash: async () => { canonicalCalls++; return sha256; },
};
installSharedWorkerBinaryIdentity({ backend: shared });
const [first, second] = await Promise.all([shared.ensureBinaryId(), shared.ensureBinaryId()]);
assert.equal(first, `bin_sha256_${expectedSha256}`);
assert.equal(second, first);
assert.equal(canonicalCalls, 1, 'shared BinaryId consumers must deduplicate the canonical producer');

const invalid = {
  binaryId: null,
  file: { size: bytes.byteLength },
  gen: 1,
  ensureSha256ContentHash: async () => fnv,
};
installSharedWorkerBinaryIdentity({ backend: invalid });
await assert.rejects(() => invalid.ensureBinaryId(), /binary-id-invalid-sha256/);

console.log('shared binary identity SHA-256 contract: PASS');
