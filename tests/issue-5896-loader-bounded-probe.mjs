// Issue #5896 regression: the source-backed binary loader must respect the
// ByteSource per-read ceiling. A valid maxReadLength < 16 used to die at the
// fixed 16-byte format probe with BYTE_SOURCE_LIMIT_ERROR before format
// detection could even run.
import assert from 'node:assert/strict';
import { MemoryByteSource } from '../js/binary/source.js';
import { openBinarySource } from '../js/binary/source-loaders.js';

function elfFixture() {
  const bytes = new Uint8Array(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0);
  const v = new DataView(bytes.buffer);
  v.setUint16(16, 2, true);   // e_type EXEC
  v.setUint16(18, 0x3e, true);// e_machine x86_64
  v.setUint32(20, 1, true);   // e_version
  v.setBigUint64(24, 0n, true);
  v.setBigUint64(32, 0n, true);
  v.setBigUint64(40, 0n, true);
  v.setUint32(48, 0, true);
  v.setUint16(52, 64, true);
  return bytes;
}

// 1. The issue repro: maxReadLength=4 must reach format parsing (ELF detected,
//    header version read through bounded chunks).
{
  const source = new MemoryByteSource(elfFixture(), { maxReadLength: 4 });
  const image = await openBinarySource(source);
  assert.equal(image?.format, 'elf', `maxReadLength=4 source must parse, got ${image?.format}`);
}

// 2. Every ceiling 1..15 parses; the per-read contract holds throughout.
for (const limit of [1, 2, 3, 5, 8, 15]) {
  const source = new MemoryByteSource(elfFixture(), { maxReadLength: limit });
  const image = await openBinarySource(source);
  assert.equal(image?.format, 'elf', `maxReadLength=${limit} must parse`);
}

// 3. A recording source must never issue a read above its ceiling.
{
  const bytes = elfFixture();
  class RecordingSource extends MemoryByteSource {
    async read(offset, length, options = {}) {
      assert.ok(length <= this.maxReadLength, `read ${length} exceeded ceiling ${this.maxReadLength}`);
      return super.read(offset, length, options);
    }
  }
  const source = new RecordingSource(bytes, { maxReadLength: 3 });
  const image = await openBinarySource(source);
  assert.equal(image?.format, 'elf');
}

// 4. A FAT Mach-O container with a small ceiling reaches container validation
//    (bounds error for garbage entries), not the loader entry limit error.
{
  const fatBytes = new Uint8Array(8 + 20 + 64);
  const v = new DataView(fatBytes.buffer);
  v.setUint32(0, 0xcafebabe, false);
  v.setUint32(4, 1, false);
  let error = null;
  try { await openBinarySource(new MemoryByteSource(fatBytes, { maxReadLength: 4 })); } catch (e) { error = e; }
  assert.ok(error);
  assert.notEqual(error.code, 'BYTE_SOURCE_LIMIT_ERROR', `entry probe must not hit the read ceiling: ${error.message}`);
  assert.doesNotMatch(error.message, /exceeds the .*-byte limit/);
}

console.log('issue #5896 source-loader bounded probe regressions: PASS');
