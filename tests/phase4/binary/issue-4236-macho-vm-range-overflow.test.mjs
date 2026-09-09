import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMachO } from '../../../js/binary/macho-core.js';
import { openBinarySource } from '../../../js/binary/source-loaders.js';
import { MemoryByteSource } from '../../../js/binary/source.js';
import { __chainedInternalsForTests } from '../../../js/chained.js';

const LC_SEGMENT = 0x1;
const LC_SEGMENT_64 = 0x19;
const CPU_X86 = 7;
const CPU_X86_64 = 0x01000007;
const MH_EXECUTE = 2;
const MAX_U32 = 0xffff_ffffn;
const MAX_U64 = 0xffff_ffff_ffff_ffffn;

function putName(bytes, offset, name) {
  bytes.set(new TextEncoder().encode(name).subarray(0, 16), offset);
}

function setU64(view, offset, value, littleEndian = true) {
  view.setBigUint64(offset, BigInt(value), littleEndian);
}

function macho64({ vmaddr, vmsize, fileoff = 0n, filesize = 0n, section = null, littleEndian = true }) {
  const nsects = section ? 1 : 0;
  const commandSize = 72 + nsects * 80;
  const headerSize = 32;
  const bytes = new Uint8Array(headerSize + commandSize);
  const view = new DataView(bytes.buffer);

  if (littleEndian) bytes.set([0xcf, 0xfa, 0xed, 0xfe], 0);
  else bytes.set([0xfe, 0xed, 0xfa, 0xcf], 0);
  view.setInt32(4, CPU_X86_64, littleEndian);
  view.setInt32(8, 3, littleEndian);
  view.setUint32(12, MH_EXECUTE, littleEndian);
  view.setUint32(16, 1, littleEndian);
  view.setUint32(20, commandSize, littleEndian);
  view.setUint32(24, 0, littleEndian);
  view.setUint32(28, 0, littleEndian);

  const p = headerSize;
  view.setUint32(p, LC_SEGMENT_64, littleEndian);
  view.setUint32(p + 4, commandSize, littleEndian);
  putName(bytes, p + 8, '__TEXT');
  setU64(view, p + 24, vmaddr, littleEndian);
  setU64(view, p + 32, vmsize, littleEndian);
  setU64(view, p + 40, fileoff, littleEndian);
  setU64(view, p + 48, filesize, littleEndian);
  view.setInt32(p + 56, 5, littleEndian);
  view.setInt32(p + 60, 5, littleEndian);
  view.setUint32(p + 64, nsects, littleEndian);
  view.setUint32(p + 68, 0, littleEndian);

  if (section) {
    const q = p + 72;
    putName(bytes, q, section.name ?? '__bss');
    putName(bytes, q + 16, '__TEXT');
    setU64(view, q + 32, section.address, littleEndian);
    setU64(view, q + 40, section.size, littleEndian);
    view.setUint32(q + 48, Number(section.offset ?? 0n), littleEndian);
    view.setUint32(q + 64, section.flags ?? 1, littleEndian); // S_ZEROFILL by default.
  }
  return bytes;
}

function macho32({ vmaddr, vmsize, fileoff = 0, filesize = 0, littleEndian = true }) {
  const commandSize = 56;
  const headerSize = 28;
  const bytes = new Uint8Array(headerSize + commandSize);
  const view = new DataView(bytes.buffer);

  if (littleEndian) bytes.set([0xce, 0xfa, 0xed, 0xfe], 0);
  else bytes.set([0xfe, 0xed, 0xfa, 0xce], 0);
  view.setInt32(4, CPU_X86, littleEndian);
  view.setInt32(8, 3, littleEndian);
  view.setUint32(12, MH_EXECUTE, littleEndian);
  view.setUint32(16, 1, littleEndian);
  view.setUint32(20, commandSize, littleEndian);
  view.setUint32(24, 0, littleEndian);

  const p = headerSize;
  view.setUint32(p, LC_SEGMENT, littleEndian);
  view.setUint32(p + 4, commandSize, littleEndian);
  putName(bytes, p + 8, '__TEXT');
  view.setUint32(p + 24, vmaddr, littleEndian);
  view.setUint32(p + 28, vmsize, littleEndian);
  view.setUint32(p + 32, fileoff, littleEndian);
  view.setUint32(p + 36, filesize, littleEndian);
  view.setInt32(p + 40, 5, littleEndian);
  view.setInt32(p + 44, 5, littleEndian);
  view.setUint32(p + 48, 0, littleEndian);
  view.setUint32(p + 52, 0, littleEndian);
  return bytes;
}

function partialReasons(image) {
  return image.metadata?.machoMetadata?.reasons ?? [];
}

function assertVmRangeRejected(image, commandHex) {
  assert.equal(image.segments.length, 0, 'overflowing segment must not become canonical mapping');
  assert.equal(image.sections.length, 0, 'no section may be committed from an invalid parent segment');
  assert.equal(image.metadata.machoMetadata.complete, false, 'malformed VM range must make metadata partial');
  assert.ok(partialReasons(image).includes(`load-command-0x${commandHex}-parse-error`), partialReasons(image).join('\n'));
  assert.match(image.warnings.join('\n'), /VM range exceeds (32|64)-bit address space/);
}

test('Mach-O64 normal VM range remains accepted', () => {
  const image = parseMachO(macho64({ vmaddr: 0x1000n, vmsize: 0x2000n }));
  assert.equal(image.segments.length, 1);
  assert.equal(image.metadata.machoMetadata.complete, true);
  assert.equal(image.segmentAt(0x2fffn)?.name, '__TEXT');
});

test('Mach-O64 half-open range ending exactly at 2^64 remains accepted', () => {
  const vmaddr = 0xffff_ffff_ffff_f000n;
  const image = parseMachO(macho64({ vmaddr, vmsize: 0x1000n }));
  assert.equal(image.segments.length, 1);
  assert.equal(image.metadata.machoMetadata.complete, true);
  assert.equal(image.segmentAt(MAX_U64)?.name, '__TEXT');
  assert.equal(image.segmentAt(MAX_U64 + 1n), null);
});

test('Mach-O64 maximum address keeps zero-sized and one-byte exact-end ranges valid', () => {
  const empty = parseMachO(macho64({ vmaddr: MAX_U64, vmsize: 0n }));
  assert.equal(empty.segments.length, 1);
  assert.equal(empty.metadata.machoMetadata.complete, true);
  assert.equal(empty.segmentAt(MAX_U64), null, 'zero-sized mapping must remain empty');

  const oneByte = parseMachO(macho64({ vmaddr: MAX_U64, vmsize: 1n }));
  assert.equal(oneByte.segments.length, 1);
  assert.equal(oneByte.metadata.machoMetadata.complete, true);
  assert.equal(oneByte.segmentAt(MAX_U64)?.name, '__TEXT');
});

test('Mach-O64 range exceeding the address space by one byte is rejected', () => {
  const image = parseMachO(macho64({ vmaddr: MAX_U64, vmsize: 2n }));
  assertVmRangeRejected(image, '19');
});

test('Mach-O64 VM range above 2^64 fails closed before segment/section commit', () => {
  const vmaddr = 0xffff_ffff_ffff_f800n;
  const image = parseMachO(macho64({
    vmaddr,
    vmsize: 0x1000n,
    section: { address: vmaddr, size: 0x100n },
  }));
  assertVmRangeRejected(image, '19');
  assert.equal(image.segmentAt(MAX_U64 + 1n), null);
});

test('Mach-O64 big-endian VM overflow follows the same fail-closed contract', () => {
  const image = parseMachO(macho64({ vmaddr: 0xffff_ffff_ffff_f800n, vmsize: 0x1000n, littleEndian: false }));
  assertVmRangeRejected(image, '19');
});

test('source-backed Mach-O loader does not publish an overflowing VM mapping', async () => {
  const bytes = macho64({ vmaddr: 0xffff_ffff_ffff_f800n, vmsize: 0x1000n });
  const image = await openBinarySource(new MemoryByteSource(bytes), {
    ranges: { pageSize: 64, maxPageSize: 512, maxCachedBytes: 4096, maxReads: 32 },
  });
  assertVmRangeRejected(image, '19');
  assert.equal(image.metadata.sourceBacked, true);
  assert.ok(image.source, 'source-backed parser must retain its source attachment');
  assert.equal(image.segmentAt(MAX_U64 + 1n), null);
});

test('Mach-O32 VM range above 2^32 fails closed', () => {
  const image = parseMachO(macho32({ vmaddr: 0xffff_f800, vmsize: 0x1000 }));
  assertVmRangeRejected(image, '1');
  assert.equal(image.segmentAt(MAX_U32 + 1n), null);
});

test('Mach-O32 half-open range ending exactly at 2^32 remains accepted', () => {
  const image = parseMachO(macho32({ vmaddr: 0xffff_f000, vmsize: 0x1000 }));
  assert.equal(image.segments.length, 1);
  assert.equal(image.metadata.machoMetadata.complete, true);
  assert.equal(image.segmentAt(MAX_U32)?.name, '__TEXT');
  assert.equal(image.segmentAt(MAX_U32 + 1n), null);
});

test('chained-stub fallback ignores Mach-O64 segments whose VM extent exceeds the address space', () => {
  const { validMachOVmRange, stubSectionWithinSegment, segmentFor } = __chainedInternalsForTests;
  const exact = {
    vmaddr: 0xffff_ffff_ffff_f000n, vmsize: 0x1000n,
    fileoff: 0n, filesize: 0x1000n, validFileRange: true, validVmRange: true,
  };
  const overflow = {
    vmaddr: 0xffff_ffff_ffff_f800n, vmsize: 0x1000n,
    fileoff: 0n, filesize: 0x1000n, validFileRange: true, validVmRange: false,
  };

  assert.equal(validMachOVmRange(exact.vmaddr, exact.vmsize), true);
  assert.equal(validMachOVmRange(overflow.vmaddr, overflow.vmsize), false);
  assert.equal(stubSectionWithinSegment(exact, exact.vmaddr, 0x10n, 0n), true);
  assert.equal(stubSectionWithinSegment(overflow, overflow.vmaddr, 0x10n, 0n), false);
  assert.equal(segmentFor([overflow], MAX_U64 + 0x10n), null);
});

test('existing file-range validation remains fail-closed', () => {
  const image = parseMachO(macho64({ vmaddr: 0x1000n, vmsize: 0x10n, fileoff: 0n, filesize: 0x20n }));
  assert.equal(image.segments.length, 0);
  assert.equal(image.metadata.machoMetadata.complete, false);
  assert.match(image.warnings.join('\n'), /file size exceeds VM size/);
});
