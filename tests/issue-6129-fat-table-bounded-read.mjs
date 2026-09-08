// Issue #6129 regression: the Mach-O universal (FAT) slice table must be
// materialized through reads that each respect the ByteSource maxReadLength
// ceiling. A table of 20/32 bytes per slice used to be fetched with one
// readExactly, so a valid maxReadLength=16 source failed the FAT parse with
// BYTE_SOURCE_LIMIT_ERROR even though the file was complete.
import assert from 'node:assert/strict';
import { ByteSource } from '../js/binary/source.js';
import { parseMachOSource } from '../js/binary/source-loaders.js';

function fatFixture(bits) {
  const entrySize = bits === 64 ? 32 : 20;
  const bytes = new Uint8Array(8 + entrySize + 64);
  const v = new DataView(bytes.buffer);
  v.setUint32(0, bits === 64 ? 0xcafebabf : 0xcafebabe, false);
  v.setUint32(4, 1, false);
  return { bytes, entrySize };
}

// Recording source: every underlying read must stay within the declared ceiling.
class RecordingSource extends ByteSource {
  constructor(bytes, maxReadLength) {
    super(BigInt(bytes.byteLength), { maxReadLength });
    this.bytes = bytes;
    this.reads = [];
    this.signals = [];
  }
  async read(offset, length, options = {}) {
    this.reads.push({ offset: Number(offset), length });
    this.signals.push(options?.signal ?? null);
    assert.ok(length <= this.maxReadLength, `underlying read ${length} exceeded maxReadLength ${this.maxReadLength}`);
    return this.bytes.subarray(Number(offset), Number(offset) + length);
  }
}

// 1. FAT32 count=1 with maxReadLength=16: the 20-byte table is read in chunks
//    and the parse reaches slice validation (garbage entry -> bounds error,
//    NOT a limit error).
{
  const { bytes } = fatFixture(32);
  const source = new RecordingSource(bytes, 16);
  let error = null;
  try { await parseMachOSource(source); } catch (e) { error = e; }
  assert.ok(error, 'garbage entries must still fail validation');
  assert.equal(error.code, undefined, `table read must not hit the per-read limit: ${error.code} ${error.message}`);
  assert.doesNotMatch(error.message, /limit/i, `no limit error may remain at the table stage: ${error.message}`);
  assert.match(error.message, /slice is outside file bounds/);
  const tableReads = source.reads.filter((r) => r.offset < 8 + 20 && r.offset >= 8);
  assert.ok(tableReads.length >= 2, `20-byte table must be chunked under a 16-byte ceiling: ${JSON.stringify(tableReads)}`);
  assert.equal(source.signals.every((s) => s === undefined || s === null || typeof s === 'object'), true);
}

// 2. FAT64 count=1 with maxReadLength=16: the 32-byte entry splits too.
{
  const { bytes } = fatFixture(64);
  const source = new RecordingSource(bytes, 16);
  let error = null;
  try { await parseMachOSource(source); } catch (e) { error = e; }
  assert.ok(error);
  assert.doesNotMatch(error.message, /limit/i, `no limit error may remain at the table stage: ${error.message}`);
  assert.match(error.message, /slice is outside file bounds/);
  const tableReads = source.reads.filter((r) => r.offset >= 8 && r.offset < 8 + 32);
  assert.ok(tableReads.length >= 2, `32-byte FAT64 entry must be chunked: ${JSON.stringify(tableReads)}`);
}

// 3. Larger tables never issue a single read above the ceiling (chunk size
//    equals maxReadLength except for the final remainder).
{
  const entrySize = 20;
  const count = 5;
  const bytes = new Uint8Array(8 + entrySize * count + 64);
  const v = new DataView(bytes.buffer);
  v.setUint32(0, 0xcafebabe, false);
  v.setUint32(4, count, false);
  const source = new RecordingSource(bytes, 16);
  try { await parseMachOSource(source); } catch (e) { assert.doesNotMatch(e.message, /limit/i); }
  const tableEnd = 8 + entrySize * count;
  const tableReads = source.reads.filter((r) => r.offset >= 8 && r.offset < tableEnd);
  const tableBytes = tableReads.reduce((n, r) => n + (Math.min(r.offset + r.length, tableEnd) - r.offset), 0);
  assert.equal(tableBytes, entrySize * count);
  for (const read of tableReads) assert.ok(read.length <= 16);
}

// 4. Full-size ceilings keep the single-read fast path and complete parse behavior.
{
  const { bytes } = fatFixture(32);
  let error = null;
  try { await parseMachOSource(bytes); } catch (e) { error = e; }
  assert.ok(error);
  assert.match(error.message, /slice is outside file bounds/);
}

console.log('issue #6129 FAT slice table bounded-read regressions: PASS');
