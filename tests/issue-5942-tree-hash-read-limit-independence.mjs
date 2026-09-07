// Issue #5942 regression: the default sha256TreeByteSource identity must not
// depend on ByteSource.maxReadLength. Identical byte sequences hash to one
// identity regardless of the source's per-read I/O ceiling; explicit
// options.chunkSize stays an identity parameter.
import assert from 'node:assert/strict';
import { MemoryByteSource } from '../js/binary/source.js';
import { sha256TreeByteSource } from '../js/platform/hash.js';

const bytes = new Uint8Array([1, 2, 3, 4, 5]);

// 1. Issue repro: same content, different maxReadLength, no chunkSize option.
{
  const a = new MemoryByteSource(bytes, { maxReadLength: 2 });
  const b = new MemoryByteSource(bytes, { maxReadLength: 3 });
  const [ha, hb] = await Promise.all([sha256TreeByteSource(a), sha256TreeByteSource(b)]);
  assert.equal(ha, hb, `identity must not depend on maxReadLength: ${ha} vs ${hb}`);
}

// 2. A tiny ceiling that forces multi-read leaf assembly still matches the
//    full-ceiling identity (leaf assembly is I/O detail, not identity).
{
  const tiny = new MemoryByteSource(bytes, { maxReadLength: 1 });
  const full = new MemoryByteSource(bytes);
  assert.equal(await sha256TreeByteSource(tiny), await sha256TreeByteSource(full));
}

// 3. Empty content is stable across ceilings too.
{
  const empty = new Uint8Array(0);
  const a = new MemoryByteSource(empty, { maxReadLength: 2 });
  const b = new MemoryByteSource(empty, { maxReadLength: 7 });
  assert.equal(await sha256TreeByteSource(a), await sha256TreeByteSource(b));
}

// 4. Content that differs still hashes differently (sanity).
{
  const other = new Uint8Array([1, 2, 3, 4, 6]);
  const ha = await sha256TreeByteSource(new MemoryByteSource(bytes, { maxReadLength: 2 }));
  const hc = await sha256TreeByteSource(new MemoryByteSource(other, { maxReadLength: 2 }));
  assert.notEqual(ha, hc);
}

// 5. An explicit chunkSize remains an identity parameter (documented contract).
{
  const source = new MemoryByteSource(bytes, { maxReadLength: 3 });
  const leaf1 = await sha256TreeByteSource(source, { chunkSize: 2 });
  const leaf2 = await sha256TreeByteSource(source, { chunkSize: 3 });
  assert.notEqual(leaf1, leaf2);
  // Both still agree with the same chunkSize on a different ceiling.
  const source2 = new MemoryByteSource(bytes, { maxReadLength: 5 });
  assert.equal(leaf1, await sha256TreeByteSource(source2, { chunkSize: 2 }));
}

// 6. Invalid chunkSize options still fail closed.
{
  const source = new MemoryByteSource(bytes, { maxReadLength: 3 });
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(sha256TreeByteSource(source, { chunkSize: bad }), TypeError);
  }
}

console.log('issue #5942 tree hash maxReadLength independence regressions: PASS');
