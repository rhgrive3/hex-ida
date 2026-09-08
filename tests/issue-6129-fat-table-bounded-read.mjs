// Issue #6129 regression: the Mach-O universal (FAT) slice table must be
// materialized through reads that each respect the ByteSource maxReadLength
// ceiling. A table of 20/32 bytes per slice used to be fetched with one
// readExactly, so a valid maxReadLength=16 source failed the FAT parse with
// BYTE_SOURCE_LIMIT_ERROR even though the file was complete.
import assert from 'node:assert/strict';
import { ByteSource } from '../js/binary/source.js';
import { parseMachOSource } from '../js/binary/source-loaders.js';
import { makeMachO64Fixture } from './universal-binary.mjs';

function fatFixture(bits) {
  const entrySize = bits === 64 ? 32 : 20;
  const bytes = new Uint8Array(8 + entrySize + 64);
  const v = new DataView(bytes.buffer);
  v.setUint32(0, bits === 64 ? 0xcafebabf : 0xcafebabe, false);
  v.setUint32(4, 1, false);
  return { bytes, entrySize };
}

// Build a valid FAT container from the repository's normal thin Mach-O fixture.
// The second architecture uses the arm64e subtype so the parser can validate
// and select a real alternate slice rather than stopping at malformed-table
// validation.
function normalFatFixture(bits, count = 1) {
  const thin = makeMachO64Fixture();
  const entrySize = bits === 64 ? 32 : 20;
  const offsets = Array.from({ length: count }, (_, index) => 0x4000 * (index + 1));
  const bytes = new Uint8Array(offsets[count - 1] + thin.length);
  const v = new DataView(bytes.buffer);
  v.setUint32(0, bits === 64 ? 0xcafebabf : 0xcafebabe, false);
  v.setUint32(4, count, false);
  for (let index = 0; index < count; index++) {
    const entry = 8 + index * entrySize;
    const subtype = index === 0 ? 0 : 2;
    const offset = offsets[index];
    v.setUint32(entry, 0x0100000c, false);
    v.setUint32(entry + 4, subtype, false);
    if (bits === 64) {
      v.setBigUint64(entry + 8, BigInt(offset), false);
      v.setBigUint64(entry + 16, BigInt(thin.length), false);
      v.setUint32(entry + 24, 14, false);
    } else {
      v.setUint32(entry + 8, offset, false);
      v.setUint32(entry + 12, thin.length, false);
      v.setUint32(entry + 16, 14, false);
    }
    const slice = thin.slice();
    new DataView(slice.buffer).setInt32(8, subtype, true);
    bytes.set(slice, offset);
  }
  return { bytes, offsets, thinSize: thin.length };
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

// A complete FAT32/FAT64 container must parse under the same 16-byte ceiling
// as the malformed-table regressions, and every read in the full parse must
// carry the caller's exact AbortSignal.
async function assertNormalFat(bits, count) {
  const { bytes, offsets, thinSize } = normalFatFixture(bits, count);
  const source = new RecordingSource(bytes, 16);
  const controller = new AbortController();
  const selectedIndex = count > 1 ? 1 : 0;
  const image = await parseMachOSource(source, {
    sliceIndex: selectedIndex,
    signal: controller.signal,
  });
  assert.equal(image.format, 'macho');
  assert.equal(image.metadata.fat.slices.length, count);
  assert.deepEqual(
    image.metadata.fat.slices.map((slice) => slice.offset),
    offsets.map((offset) => BigInt(offset)),
  );
  assert.equal(image.metadata.fat.selected.offset, BigInt(offsets[selectedIndex]));
  assert.equal(image.metadata.fat.selected.size, BigInt(thinSize));
  assert.equal(image.metadata.fat.selected.arch, selectedIndex ? 'arm64e' : 'arm64');
  assert.ok(source.reads.length > 2, `normal FAT${bits} parse must perform chunked source reads`);
  assert.ok(source.reads.every((read) => read.length <= 16), `FAT${bits} read exceeded maxReadLength`);
  assert.ok(source.signals.length > 0);
  assert.ok(source.signals.every((signal) => signal === controller.signal), `FAT${bits} lost AbortSignal identity`);
}

for (const bits of [32, 64]) {
  await assertNormalFat(bits, 1);
  await assertNormalFat(bits, 2);
}

// The valid-slice path above proves the selected offset/size contract; retain
// an explicit invalid-size check so that validation cannot be bypassed while
// adding the bounded table reader.
{
  const { bytes, offsets, thinSize } = normalFatFixture(32, 1);
  new DataView(bytes.buffer).setUint32(20, thinSize + 1, false);
  await assert.rejects(
    () => parseMachOSource(new RecordingSource(bytes, 16)),
    /slice is outside file bounds/,
  );
  assert.equal(offsets[0], 0x4000);
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

// 5. Existing count and table-bound guards remain fail-closed.
{
  const { bytes } = fatFixture(32);
  new DataView(bytes.buffer).setUint32(4, 129, false);
  await assert.rejects(
    () => parseMachOSource(new RecordingSource(bytes, 16)),
    /unreasonable Mach-O slice count 129/,
  );
}
{
  const bytes = new Uint8Array(8 + 19);
  const v = new DataView(bytes.buffer);
  v.setUint32(0, 0xcafebabe, false);
  v.setUint32(4, 1, false);
  await assert.rejects(
    () => parseMachOSource(new RecordingSource(bytes, 16)),
    /Mach-O universal slice table is truncated/,
  );
}

console.log('issue #6129 FAT slice table bounded-read regressions: PASS');
