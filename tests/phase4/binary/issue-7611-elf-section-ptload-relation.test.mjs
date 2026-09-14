import assert from 'node:assert/strict';
import test from 'node:test';

import { parseELF } from '../../../js/binary/elf.js';
import { elfSectionFileSpanConsistentWithLoads } from '../../../js/binary/elf-mapping.js';

const code11 = Uint8Array.from([0xb8, 0x3c, 0, 0, 0, 0xbf, 0x0b, 0, 0, 0, 0x0f, 0x05]);
const code22 = Uint8Array.from([0xb8, 0x3c, 0, 0, 0, 0xbf, 0x16, 0, 0, 0, 0x0f, 0x05]);
const SHF_ALLOC_EXEC = 0x6n;

function buildELF({
  type = 2,
  loads = [{ offset: 0x1000n, vaddr: 0x400000n, filesz: 0x1000n, memsz: 0x1000n, flags: 5, marker: code11 }],
  secAddr = 0x400000n,
  secOffset = 0x2000n,
  secSize = 0x100n,
  secType = 1,
  secFlags = SHF_ALLOC_EXEC,
  secMarker = code22,
} = {}) {
  const shstrtab = new TextEncoder().encode('\0.target\0.shstrtab\0');
  const shoff = 0x5000;
  const bytes = new Uint8Array(0x6000);
  const b = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  b.setUint16(0x10, type, true);
  b.setUint16(0x12, 62, true);
  b.setUint32(0x14, 1, true);
  b.setBigUint64(0x18, type === 1 ? 0n : 0x400000n, true);
  b.setBigUint64(0x20, loads.length ? 0x40n : 0n, true);
  b.setBigUint64(0x28, BigInt(shoff), true);
  b.setUint16(0x34, 64, true);
  b.setUint16(0x36, 56, true);
  b.setUint16(0x38, loads.length, true);
  b.setUint16(0x3a, 64, true);
  b.setUint16(0x3c, 3, true);
  b.setUint16(0x3e, 2, true);

  loads.forEach((load, index) => {
    const p = 0x40 + index * 56;
    const offset = BigInt(load.offset);
    const vaddr = BigInt(load.vaddr);
    const filesz = BigInt(load.filesz);
    const memsz = BigInt(load.memsz ?? load.filesz);
    b.setUint32(p, 1, true);
    b.setUint32(p + 4, load.flags ?? 5, true);
    b.setBigUint64(p + 8, offset, true);
    b.setBigUint64(p + 16, vaddr, true);
    b.setBigUint64(p + 24, vaddr, true);
    b.setBigUint64(p + 32, filesz, true);
    b.setBigUint64(p + 40, memsz, true);
    b.setBigUint64(p + 48, 0x1000n, true);
    if (load.marker && offset <= BigInt(bytes.length - load.marker.length)) bytes.set(load.marker, Number(offset));
  });

  if (secType !== 8 && secMarker && secOffset <= BigInt(bytes.length - secMarker.length)) {
    bytes.set(secMarker, Number(secOffset));
  }
  bytes.set(shstrtab, 0x4f00);

  const sh = (index, name, sectionType, flags, addr, offset, size, align = 1n) => {
    const p = shoff + index * 64;
    b.setUint32(p, name, true);
    b.setUint32(p + 4, sectionType, true);
    b.setBigUint64(p + 8, BigInt(flags), true);
    b.setBigUint64(p + 16, BigInt(addr), true);
    b.setBigUint64(p + 24, BigInt(offset), true);
    b.setBigUint64(p + 32, BigInt(size), true);
    b.setBigUint64(p + 48, BigInt(align), true);
  };
  sh(0, 0, 0, 0n, 0n, 0n, 0n, 0n);
  sh(1, 1, secType, secFlags, secAddr, secOffset, secSize, 16n);
  sh(2, 9, 3, 0n, 0n, 0x4f00n, BigInt(shstrtab.length));
  return bytes;
}

function targetSection(image) {
  return image.sections.find((section) => section.index === 1);
}

function has7611Warning(image) {
  return image.warnings.some((warning) => warning.includes('inconsistent with the runtime PT_LOAD mapping'));
}

test('#7611 contradictory file-backed SHF_ALLOC section loses runtime mapping authority', () => {
  const image = parseELF(buildELF());
  assert.equal(targetSection(image)?.source, 'unmapped-section');
  assert.equal(image.addressToOffset(0x400000n), 0x1000n);
  assert.deepEqual([...image.readVirtual(0x400000n, code11.length)], [...code11]);
  assert.ok(has7611Warning(image));
});

test('#7611 PT_LOAD-consistent SHF_ALLOC subrange keeps authority', () => {
  const image = parseELF(buildELF({ secAddr: 0x400010n, secOffset: 0x1010n, secSize: 0x20n, secMarker: null }));
  assert.equal(targetSection(image)?.source, 'section-header');
  assert.equal(image.addressToOffset(0x400010n), 0x1010n);
  assert.equal(has7611Warning(image), false);
});

test('#7611 PROGBITS cannot bridge PT_LOAD file bytes into the zero-fill tail', () => {
  const image = parseELF(buildELF({
    loads: [{ offset: 0x1000n, vaddr: 0x400000n, filesz: 0x100n, memsz: 0x200n, flags: 5, marker: code11 }],
    secAddr: 0x400080n,
    secOffset: 0x1080n,
    secSize: 0x100n,
  }));
  assert.equal(targetSection(image)?.source, 'unmapped-section');
  assert.equal(image.addressToOffset(0x4000c0n), 0x10c0n);
  assert.equal(image.addressToOffset(0x400120n), null);
  assert.ok([...image.readVirtual(0x400120n, 4)].every((byte) => byte === 0));
});

test('#7611 runtime SHF_ALLOC PROGBITS outside every PT_LOAD is not byte authority', () => {
  const image = parseELF(buildELF({ secAddr: 0x500000n, secOffset: 0x2000n, secSize: 0x20n }));
  assert.equal(targetSection(image)?.source, 'unmapped-section');
  assert.equal(image.addressToOffset(0x500000n), null);
});

test('#7611 NOBITS over PT_LOAD file bytes loses authority', () => {
  const image = parseELF(buildELF({ secType: 8, secAddr: 0x400080n, secOffset: 0x1080n, secSize: 0x80n }));
  assert.equal(targetSection(image)?.source, 'unmapped-section');
  assert.equal(image.addressToOffset(0x400080n), 0x1080n);
  assert.ok(has7611Warning(image));
});

test('#7611 NOBITS wholly inside one legitimate PT_LOAD zero-fill tail stays authoritative', () => {
  const image = parseELF(buildELF({
    loads: [{ offset: 0x1000n, vaddr: 0x400000n, filesz: 0x100n, memsz: 0x200n, flags: 6, marker: code11 }],
    secType: 8,
    secAddr: 0x400100n,
    secOffset: 0x1100n,
    secSize: 0x100n,
  }));
  assert.equal(targetSection(image)?.source, 'section-header');
  assert.equal(image.addressToOffset(0x400180n), null);
  assert.equal(image.resolveVirtualMapping(0x400180n)?.kind, 'zero');
  assert.ok([...image.readVirtual(0x400180n, 4)].every((byte) => byte === 0));
});

test('#7611 NOBITS without an owning PT_LOAD loses authority', () => {
  const image = parseELF(buildELF({ secType: 8, secAddr: 0x500000n, secOffset: 0x2000n, secSize: 0x100n }));
  assert.equal(targetSection(image)?.source, 'unmapped-section');
  assert.equal(image.resolveVirtualMapping(0x500000n), null);
});

test('#7611 preserves the existing #5888 out-of-file SHF_ALLOC exclusion', () => {
  const image = parseELF(buildELF({ secOffset: 0x7000n, secSize: 0x100n, secMarker: null }));
  assert.equal(targetSection(image)?.source, 'unmapped-section');
  assert.ok(image.warnings.some((warning) => warning.includes('file span beyond EOF')));
  assert.equal(image.addressToOffset(0x400000n), 0x1000n);
});

test('#7611 preserves ET_REL synthetic-section authority', () => {
  const image = parseELF(buildELF({
    type: 1,
    loads: [],
    secAddr: 0n,
    secOffset: 0x1000n,
    secSize: 0x20n,
    secMarker: code22,
  }));
  assert.equal(targetSection(image)?.source, 'ET_REL-synthetic-section');
});

test('#7611 preserves non-ALLOC metadata sections without giving them runtime byte authority', () => {
  const image = parseELF(buildELF({ secFlags: 0x4n }));
  assert.equal(targetSection(image)?.source, 'section-header');
  assert.equal(image.addressToOffset(0x400000n), 0x1000n);
  assert.deepEqual([...image.readVirtual(0x400000n, code11.length)], [...code11]);
});

test('#7611 helper checks every overlapping PT_LOAD and is segment-order independent', () => {
  const agreeingA = { source: 'PT_LOAD', address: 0x400000n, size: 0x1000n, fileOffset: 0x1000n, fileSize: 0x1000n };
  const agreeingB = { source: 'PT_LOAD', address: 0x400000n, size: 0x1000n, fileOffset: 0x1000n, fileSize: 0x1000n };
  const conflicting = { source: 'PT_LOAD', address: 0x400000n, size: 0x1000n, fileOffset: 0x2000n, fileSize: 0x1000n };

  for (const segments of [[agreeingA, agreeingB], [agreeingB, agreeingA]]) {
    assert.equal(elfSectionFileSpanConsistentWithLoads({ segments }, 0x400000n, 0x100n, 0x1000n), true);
  }
  for (const segments of [[agreeingA, conflicting], [conflicting, agreeingA]]) {
    assert.equal(elfSectionFileSpanConsistentWithLoads({ segments }, 0x400000n, 0x100n, 0x1000n), false);
  }
});
