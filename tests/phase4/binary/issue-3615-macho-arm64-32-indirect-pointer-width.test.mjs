import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMachO } from '../../../js/binary/macho.js';

const LC_SEGMENT_64 = 0x19;
const LC_SYMTAB = 0x2;
const LC_DYSYMTAB = 0xb;
const CPU_TYPE_ARM64 = 0x0100000c;
const CPU_TYPE_ARM64_32 = 0x0200000c;
const CPU_SUBTYPE_ARM64E = 2;

const S_NON_LAZY_SYMBOL_POINTERS = 0x6;
const S_LAZY_SYMBOL_POINTERS = 0x7;
const S_SYMBOL_STUBS = 0x8;
const S_LAZY_DYLIB_SYMBOL_POINTERS = 0x10;
const S_THREAD_LOCAL_VARIABLE_POINTERS = 0x14;

const POINTER_SECTION_TYPES = [
  S_NON_LAZY_SYMBOL_POINTERS,
  S_LAZY_SYMBOL_POINTERS,
  S_LAZY_DYLIB_SYMBOL_POINTERS,
  S_THREAD_LOCAL_VARIABLE_POINTERS,
];

function buildIndirectFixture({
  cpu = CPU_TYPE_ARM64_32,
  subtype = 0,
  sectionType = S_NON_LAZY_SYMBOL_POINTERS,
  entryWidth = 4,
  reserved2 = 0,
} = {}) {
  const bytes = new Uint8Array(0x300);
  const v = new DataView(bytes.buffer);
  const u8 = (offset, value) => v.setUint8(offset, value);
  const u16 = (offset, value) => v.setUint16(offset, value, true);
  const u32 = (offset, value) => v.setUint32(offset, value >>> 0, true);
  const i32 = (offset, value) => v.setInt32(offset, value, true);
  const u64 = (offset, value) => v.setBigUint64(offset, BigInt(value), true);
  const put = (offset, text) => bytes.set(Buffer.from(text), offset);

  const sectionOffset = 0x180;
  const sectionAddress = 0x1180n;
  const symoff = 0x200;
  const indirectsymoff = 0x240;
  const stroff = 0x250;
  const sectionSize = BigInt(entryWidth * 2);

  u32(0, 0xfeedfacf); // MH_MAGIC_64
  i32(4, cpu);
  i32(8, subtype);
  u32(12, 6); // MH_DYLIB
  u32(16, 3);
  u32(20, 152 + 24 + 80);
  u32(24, 0);
  u32(28, 0);

  let p = 32;
  u32(p, LC_SEGMENT_64);
  u32(p + 4, 152);
  put(p + 8, '__DATA');
  u64(p + 24, 0x1000n);
  u64(p + 32, 0x1000n);
  u64(p + 40, 0n);
  u64(p + 48, BigInt(bytes.length));
  i32(p + 56, 3);
  i32(p + 60, 3);
  u32(p + 64, 1);
  u32(p + 68, 0);

  const q = p + 72;
  put(q, sectionType === S_SYMBOL_STUBS ? '__stubs' : '__ptrs');
  put(q + 16, '__DATA');
  u64(q + 32, sectionAddress);
  u64(q + 40, sectionSize);
  u32(q + 48, sectionOffset);
  u32(q + 52, 2);
  u32(q + 56, 0);
  u32(q + 60, 0);
  u32(q + 64, sectionType);
  u32(q + 68, 0); // reserved1: first indirect entry
  u32(q + 72, reserved2);
  u32(q + 76, 0);
  p += 152;

  u32(p, LC_SYMTAB);
  u32(p + 4, 24);
  u32(p + 8, symoff);
  u32(p + 12, 2);
  u32(p + 16, stroff);
  u32(p + 20, 11);
  p += 24;

  u32(p, LC_DYSYMTAB);
  u32(p + 4, 80);
  u32(p + 56, indirectsymoff);
  u32(p + 60, 2);

  // Two undefined external nlist_64 records.
  u32(symoff, 1);
  u8(symoff + 4, 0x01);
  u8(symoff + 5, 0);
  u16(symoff + 6, 0);
  u64(symoff + 8, 0n);
  u32(symoff + 16, 6);
  u8(symoff + 20, 0x01);
  u8(symoff + 21, 0);
  u16(symoff + 22, 0);
  u64(symoff + 24, 0n);

  u32(indirectsymoff, 0);
  u32(indirectsymoff + 4, 1);
  bytes.set([0, ...Buffer.from('_foo'), 0, ...Buffer.from('_bar'), 0], stroff);
  return bytes;
}

function symbolSites(image, name) {
  return image.imports
    .filter((entry) => entry.name === name)
    .flatMap((entry) => entry.sites ?? [])
    .filter((site) => site.kind.startsWith('indirect-symbol-'));
}

function assertTwoSites(image, stride, kind) {
  assert.equal(image.metadata.indirectSymbols?.complete, true);
  assert.equal(image.metadata.indirectSymbols?.records, 2);
  assert.equal(image.metadata.indirectSymbols?.sites, 2);
  assert.deepEqual(symbolSites(image, '_foo'), [
    { address: 0x1180n, offset: 0x180n, kind },
  ]);
  assert.deepEqual(symbolSites(image, '_bar'), [
    { address: 0x1180n + BigInt(stride), offset: 0x180n + BigInt(stride), kind },
  ]);
}

for (const sectionType of POINTER_SECTION_TYPES) {
  test(`#3615 arm64_32 pointer section type 0x${sectionType.toString(16)} uses 4-byte native entries`, () => {
    const image = parseMachO(buildIndirectFixture({ sectionType }));
    assert.equal(image.arch, 'arm64_32');
    assert.equal(image.bits, 64, 'ARM64_32 remains a 64-bit Mach-O structural container');
    assertTwoSites(image, 4, 'indirect-symbol-pointer');
  });
}

for (const [label, subtype] of [['arm64', 0], ['arm64e', CPU_SUBTYPE_ARM64E]]) {
  test(`#3615 ${label} LP64 pointer sections remain 8-byte entries`, () => {
    const image = parseMachO(buildIndirectFixture({
      cpu: CPU_TYPE_ARM64,
      subtype,
      entryWidth: 8,
    }));
    assert.equal(image.arch, label);
    assertTwoSites(image, 8, 'indirect-symbol-pointer');
  });
}

test('#3615 S_SYMBOL_STUBS remains governed by reserved2 rather than native pointer width', () => {
  const image = parseMachO(buildIndirectFixture({
    sectionType: S_SYMBOL_STUBS,
    entryWidth: 12,
    reserved2: 12,
  }));
  assert.equal(image.arch, 'arm64_32');
  assertTwoSites(image, 12, 'indirect-symbol-stub');
});
