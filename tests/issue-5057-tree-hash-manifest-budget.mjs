// Issue #5057 regression: tree-hash leaf metadata must be admitted before any
// source I/O so tiny explicit leaves cannot amplify a bounded input into an
// unbounded number of digest objects / WebCrypto calls / manifest bytes.
import assert from 'node:assert/strict';
import { sha256TreeByteSource } from '../js/platform/hash.js';
import { sha256TreeByteSource as baselineTreeHash } from './helpers/platform-hash-baseline-oracle.mjs';

const RESOURCE_CODE = 'SHA256_TREE_RESOURCE_LIMIT';

function unreadableSource(size, { maxReadLength = 1024 * 1024 } = {}) {
  let reads = 0;
  return {
    source: {
      size,
      maxReadLength,
      async read() {
        reads += 1;
        throw new Error('tree-hash admission reached source I/O');
      },
    },
    reads: () => reads,
  };
}

// The original minimal counterexample: 1 MiB with 1-byte leaves would require
// 1,048,576 SHA-256 operations and retain 32 MiB of leaf digests before the
// second manifest allocation. It must fail before touching the source.
{
  const fixture = unreadableSource(1024n * 1024n);
  let progress = 0;
  await assert.rejects(
    sha256TreeByteSource(fixture.source, {
      chunkSize: 1,
      onProgress() { progress += 1; },
    }),
    (error) => error?.code === RESOURCE_CODE && error instanceof RangeError,
  );
  assert.equal(fixture.reads(), 0, 'oversized leaf plans must be rejected before source I/O');
  assert.equal(progress, 0, 'rejected plans must not publish synthetic progress');
}


// The explicit leaf-count boundary itself is deterministic: one request above
// the cap is rejected pre-I/O, while the boundary plan is admitted (the test
// source then throws on its first read so we do not perform 65k digests here).
{
  const admitted = unreadableSource(64n * 1024n);
  await assert.rejects(
    sha256TreeByteSource(admitted.source, { chunkSize: 1 }),
    /tree-hash admission reached source I\/O/,
  );
  assert.equal(admitted.reads(), 1);

  const rejected = unreadableSource(64n * 1024n + 1n);
  await assert.rejects(
    sha256TreeByteSource(rejected.source, { chunkSize: 1 }),
    (error) => error?.code === RESOURCE_CODE,
  );
  assert.equal(rejected.reads(), 0);
}

// The normal 4 MiB identity leaf remains usable through a 256 GiB logical
// source, while the next byte is rejected before I/O. This keeps the guard far
// outside ordinary/default workloads and makes its boundary explicit.
{
  const defaultBoundary = 256n * 1024n * 1024n * 1024n;
  const admitted = unreadableSource(defaultBoundary);
  await assert.rejects(
    sha256TreeByteSource(admitted.source),
    /tree-hash admission reached source I\/O/,
  );
  assert.equal(admitted.reads(), 1);

  const rejected = unreadableSource(defaultBoundary + 1n);
  await assert.rejects(
    sha256TreeByteSource(rejected.source),
    (error) => error?.code === RESOURCE_CODE,
  );
  assert.equal(rejected.reads(), 0);
}

// Admission arithmetic must stay BigInt-safe even for synthetic source sizes
// far beyond Number.MAX_SAFE_INTEGER; no conversion/allocation/read is allowed.
{
  const fixture = unreadableSource(2n ** 80n);
  await assert.rejects(
    sha256TreeByteSource(fixture.source, { chunkSize: Number.MAX_SAFE_INTEGER }),
    (error) => error?.code === RESOURCE_CODE && error instanceof RangeError,
  );
  assert.equal(fixture.reads(), 0);
}

// Cancellation remains the first observable boundary: an already-cancelled
// request must keep its historical AbortError rather than becoming a resource
// admission error merely because its plan is also too large.
{
  const fixture = unreadableSource(1024n * 1024n);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    sha256TreeByteSource(fixture.source, { chunkSize: 1, signal: controller.signal }),
    (error) => error?.name === 'AbortError' && error?.code === 'ABORT_ERR',
  );
  assert.equal(fixture.reads(), 0);
}

// Bounded explicit tiny leaves remain a supported identity parameter, and the
// resource guard must not change sha256tree:v2 output for admitted inputs.
for (const [bytes, chunkSize] of [
  [Uint8Array.of(), 1],
  [Uint8Array.of(1, 2, 3, 4, 5), 1],
  [Uint8Array.of(1, 2, 3, 4, 5), 2],
  [Uint8Array.from({ length: 257 }, (_, i) => i & 0xff), 17],
]) {
  assert.equal(
    await sha256TreeByteSource(bytes, { chunkSize }),
    await baselineTreeHash(bytes, { chunkSize }),
    `admitted chunkSize=${chunkSize} identity must remain byte-for-byte compatible`,
  );
}

console.log('issue #5057 tree hash manifest budget regressions: PASS');
