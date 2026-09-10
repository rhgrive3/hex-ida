import assert from 'node:assert/strict';
import { parseMachOSource } from '../../../js/binary/macho-source-cache.js';
import { asByteSource } from '../../../js/binary/source.js';

// Issue #5536: parseMachOSource() cached selected-slice results keyed only by
// the input object identity. A mutable Uint8Array input (MemoryByteSource
// keeps the caller's buffer by reference) could change between calls while
// the cached image still reflected the old bytes — the second call returned
// the stale "confirmed" parse instead of re-validating (and rejecting) the
// now-invalid container.

const CPU_ARM64 = 0x0100000c;

function fatBytes() {
  const bytes = new Uint8Array(0x9000), dv = new DataView(bytes.buffer);
  dv.setUint32(0, 0xcafebabe, false); dv.setUint32(4, 1, false);
  dv.setUint32(8, CPU_ARM64, false); dv.setUint32(12, 0, false);
  dv.setUint32(16, 0x4000, false); dv.setUint32(20, 32, false); dv.setUint32(24, 14, false);
  dv.setUint32(0x4000, 0xfeedfacf, true);
  dv.setInt32(0x4004, CPU_ARM64, true); dv.setInt32(0x4008, 0, true);
  dv.setUint32(0x400c, 2, true); dv.setUint32(0x4010, 0, true);
  return bytes;
}

// Mutable byte input: a post-parse mutation must not be served from cache.
{
  const bytes = fatBytes();
  const first = await parseMachOSource(bytes, { sliceIndex: 0 });
  assert.equal(first.arch, 'arm64');
  bytes.fill(0, 0x4000, 0x4004); // destroy the thin magic
  // The fresh parse now rejects the mutated container outright: no cached
  // image can be returned, and the rejection is the issue's expected outcome.
  await assert.rejects(
    parseMachOSource(bytes, { sliceIndex: 0 }),
    (error) => /invalid thin header/.test(error.message),
    'the mutated container is rejected on re-parse, not laundered through the cache',
  );
}

// Immutable ByteSource inputs keep the cache (control, issue-2516 contract).
{
  const bytes = fatBytes();
  const source = asByteSource(bytes);
  const a = await parseMachOSource(source, { sliceIndex: 0 });
  const b = await parseMachOSource(source, { sliceIndex: 0 });
  assert.notEqual(b, a, 'ByteSource-backed cache hits return detached consumer images');
  assert.equal(b.source, a.source, 'detached images retain the shared source capability');
}

// Non-selected (whole-container) parses were never cached.
{
  const bytes = fatBytes();
  const a = await parseMachOSource(bytes, {});
  const b = await parseMachOSource(bytes, {});
  assert.notEqual(b, a);
}

console.log('issue #5536 macho-source-cache mutable-input regression: PASS');
