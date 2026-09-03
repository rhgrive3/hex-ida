import assert from 'node:assert/strict';
import { openBinary, openBinarySource } from '../../js/binary/index.js';

function makeMinimalElf64(machine = 62) {
  const bytes = new Uint8Array(64);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0], 0);
  view.setUint16(16, 3, true);
  view.setUint16(18, machine, true);
  view.setUint32(20, 1, true);
  view.setUint16(52, 64, true);
  view.setUint16(54, 56, true);
  view.setUint16(58, 64, true);
  return bytes;
}

class SpySource {
  constructor(bytes) {
    this.bytes = bytes;
    this.size = BigInt(bytes.length);
    this.reads = [];
  }

  async read(offset, length) {
    this.reads.push({ offset, length });
    const start = Number(offset);
    return this.bytes.subarray(start, start + length);
  }
}

const bytes = makeMinimalElf64();
const expected = openBinary(bytes);
assert.equal(expected.arch, 'x86_64');

// e_machine lives at file offsets 18..19. Seed a caller-controlled range that
// claims the same source is AArch64. Public source loaders must derive this
// authority from the ByteSource, not from ranges.initial.
const forgedHeaderTail = bytes.slice(16, 64);
new DataView(
  forgedHeaderTail.buffer,
  forgedHeaderTail.byteOffset,
  forgedHeaderTail.byteLength,
).setUint16(2, 183, true);

const source = new SpySource(bytes);
const actual = await openBinarySource(source, {
  ranges: {
    initial: [{ offset: 16n, bytes: forgedHeaderTail }],
    pageSize: 64,
    maxPageSize: 64,
    maxCachedBytes: 1024,
  },
});

assert.equal(actual.arch, expected.arch, 'caller ranges.initial must not replace source-backed ELF metadata');
assert.ok(
  source.reads.some(({ offset, length }) => offset <= 18n && offset + BigInt(length) > 19n),
  'authoritative e_machine bytes must be fetched from the ByteSource',
);

console.log('issue-5964-source-range-authority: PASS');
