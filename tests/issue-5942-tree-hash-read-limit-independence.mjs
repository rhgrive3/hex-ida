// Issue #5942 regression: the default sha256TreeByteSource identity must not
// depend on ByteSource.maxReadLength. Identical byte sequences hash to one
// identity regardless of the source's per-read I/O ceiling; explicit
// options.chunkSize stays an identity parameter.
import assert from 'node:assert/strict';
import { MemoryByteSource, asByteSource } from '../js/binary/source.js';
import { sha256TreeByteSource } from '../js/platform/hash.js';

const bytes = new Uint8Array([1, 2, 3, 4, 5]);

class TracingSource extends MemoryByteSource {
  constructor(input, options) {
    super(input, options);
    this.reads = [];
  }

  async read(offset, length, options = {}) {
    this.reads.push({ offset, length });
    return super.read(offset, length, options);
  }
}

// 1. Issue repro: same content, different maxReadLength, no chunkSize option.
{
  const hashes = await Promise.all([64 * 1024, 256 * 1024, 4 * 1024 * 1024].map((maxReadLength) =>
    sha256TreeByteSource(new MemoryByteSource(bytes, { maxReadLength }))));
  assert.equal(new Set(hashes).size, 1, 'identity must not depend on maxReadLength');
}

// 2. A tiny ceiling that forces multi-read leaf assembly still matches the
//    full-ceiling identity (leaf assembly is I/O detail, not identity).
{
  const tiny = new MemoryByteSource(bytes, { maxReadLength: 1 });
  const full = new MemoryByteSource(bytes);
  assert.equal(await sha256TreeByteSource(tiny), await sha256TreeByteSource(full));
}

// 3. Wrapper sources retain the same logical identity and every physical read
//    remains inside the source's declared I/O ceiling.
{
  const parent = new TracingSource(bytes, { maxReadLength: 2 });
  const delegated = asByteSource(parent, { maxReadLength: 1 });
  const subrange = parent.subrange(0, bytes.length);
  const [parentHash, delegatedHash, subrangeHash] = await Promise.all([
    sha256TreeByteSource(parent),
    sha256TreeByteSource(delegated),
    sha256TreeByteSource(subrange),
  ]);
  assert.equal(parentHash, delegatedHash);
  assert.equal(parentHash, subrangeHash);
  assert.ok(parent.reads.every(({ length }) => length <= 2), 'bounded reads must not exceed maxReadLength');
}

// 4. Empty content is stable across ceilings too.
{
  const empty = new Uint8Array(0);
  const a = new MemoryByteSource(empty, { maxReadLength: 2 });
  const b = new MemoryByteSource(empty, { maxReadLength: 7 });
  assert.equal(await sha256TreeByteSource(a), await sha256TreeByteSource(b));
}

// 5. Content that differs still hashes differently (sanity).
{
  const other = new Uint8Array([1, 2, 3, 4, 6]);
  const ha = await sha256TreeByteSource(new MemoryByteSource(bytes, { maxReadLength: 2 }));
  const hc = await sha256TreeByteSource(new MemoryByteSource(other, { maxReadLength: 2 }));
  assert.notEqual(ha, hc);
}

// 6. An explicit chunkSize remains an identity parameter (documented contract).
{
  const source = new MemoryByteSource(bytes, { maxReadLength: 3 });
  const leaf1 = await sha256TreeByteSource(source, { chunkSize: 2 });
  const leaf2 = await sha256TreeByteSource(source, { chunkSize: 3 });
  assert.notEqual(leaf1, leaf2);
  // Both still agree with the same chunkSize on a different ceiling.
  const source2 = new MemoryByteSource(bytes, { maxReadLength: 5 });
  assert.equal(leaf1, await sha256TreeByteSource(source2, { chunkSize: 2 }));
}

// 7. Progress remains tied to bounded reads when a logical leaf is assembled,
//    and cancellation is observed before the next read.
{
  const source = new TracingSource(bytes, { maxReadLength: 2 });
  const progress = [];
  const controller = new AbortController();
  await assert.rejects(
    sha256TreeByteSource(source, {
      onProgress(event) {
        progress.push(event);
        if (progress.length === 1) controller.abort('stop-after-first-read');
      },
      signal: controller.signal,
    }),
    (error) => error === 'stop-after-first-read',
  );
  assert.deepEqual(progress, [{ done: 2n, total: 5n }]);
  assert.equal(source.reads.length, 1, 'abort after a bounded read must prevent the next read');
}

// 8. Invalid chunkSize options still fail closed.
{
  const source = new MemoryByteSource(bytes, { maxReadLength: 3 });
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(sha256TreeByteSource(source, { chunkSize: bad }), TypeError);
  }
}

console.log('issue #5942 tree hash maxReadLength independence regressions: PASS');
