import assert from 'node:assert/strict';
import {
  openBinary,
  openBinarySource,
  parseELFSource,
  parseMachOSource,
  parsePESource,
} from '../../js/binary/index.js';

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

function makeMinimalPe64(machine = 0x8664) {
  const bytes = new Uint8Array(0x200);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0x5a4d, true);
  view.setUint32(0x3c, 0x80, true);
  view.setUint32(0x80, 0x00004550, true);
  const coff = 0x84;
  view.setUint16(coff, machine, true);
  view.setUint16(coff + 2, 0, true);
  view.setUint16(coff + 16, 112, true);
  view.setUint16(coff + 18, 0x2022, true);
  const opt = coff + 20;
  view.setUint16(opt, 0x20b, true);
  view.setBigUint64(opt + 24, 0x140000000n, true);
  view.setUint32(opt + 32, 0x1000, true);
  view.setUint32(opt + 36, 0x200, true);
  view.setUint32(opt + 56, 0x1000, true);
  view.setUint32(opt + 60, 0x200, true);
  view.setUint16(opt + 68, 3, true);
  view.setUint32(opt + 108, 0, true);
  return bytes;
}

function makeMinimalMachO64(cpu = 0x01000007) {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0xfeedfacf, true);
  view.setInt32(4, cpu, true);
  view.setInt32(8, cpu === 0x01000007 ? 3 : 0, true);
  view.setUint32(12, 2, true);
  view.setUint32(16, 0, true);
  view.setUint32(20, 0, true);
  view.setUint32(24, 0, true);
  view.setUint32(28, 0, true);
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

// Public source-loader exports historically accepted a caller prefix. That
// argument is now compatibility-only: metadata authority must still come from
// the declared ByteSource while openBinarySource may reuse its private verified
// prefix internally.
const directElfSource = new SpySource(bytes);
const directElf = await parseELFSource(directElfSource, {}, makeMinimalElf64(183));
assert.equal(directElf.arch, 'x86_64', 'public parseELFSource must ignore a forged caller prefix');
assert.deepEqual(directElfSource.reads[0], { offset: 0n, length: 16 }, 'ELF public loader must fetch its own prefix');

const peBytes = makeMinimalPe64();
assert.equal(openBinary(peBytes).arch, 'x86_64');
const directPeSource = new SpySource(peBytes);
const directPe = await parsePESource(directPeSource, {}, makeMinimalPe64(0xaa64));
assert.equal(directPe.arch, 'x86_64', 'public parsePESource must ignore a forged caller prefix');
assert.deepEqual(directPeSource.reads[0], { offset: 0n, length: 16 }, 'PE public loader must fetch its own prefix');

const machoBytes = makeMinimalMachO64();
assert.equal(openBinary(machoBytes).arch, 'x86_64');
const directMachOSource = new SpySource(machoBytes);
const directMachO = await parseMachOSource(directMachOSource, {}, makeMinimalMachO64(0x0100000c));
assert.equal(directMachO.arch, 'x86_64', 'public parseMachOSource must ignore a forged caller prefix');
assert.deepEqual(directMachOSource.reads[0], { offset: 0n, length: 16 }, 'Mach-O public loader must fetch its own prefix');

console.log('issue-5964-source-range-authority: PASS');
