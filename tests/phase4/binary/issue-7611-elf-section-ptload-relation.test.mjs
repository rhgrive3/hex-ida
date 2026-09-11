import assert from 'node:assert/strict';
import test from 'node:test';

import { parseELF } from '../../../js/binary/elf.js';

// A file-backed SHF_ALLOC section covered by a file-backed PT_LOAD must agree
// with the segment's VA→file mapping. Program headers are the runtime byte
// authority; `BinaryImage` ranks the smallest covering mapping, so a section
// header claiming different file bytes for the same VA would silently replace
// runtime code (#7611). Such a section stays listed for metadata but loses
// mapping authority ('unmapped-section'), exactly like the #5888 EOF case.

const code11 = Uint8Array.from([0xb8, 0x3c, 0x00, 0x00, 0x00, 0xbf, 0x0b, 0x00, 0x00, 0x00, 0x0f, 0x05]);
const code22 = Uint8Array.from([0xb8, 0x3c, 0x00, 0x00, 0x00, 0xbf, 0x16, 0x00, 0x00, 0x00, 0x0f, 0x05]);

function buildELF({ secAddr = 0x400000n, secOffset = 0x2000, secSize = 0x100n, secType = 1, secFlags = 0x6n, loadVaddr = 0x400000n, loadFilesz = 0x1000n, loadMemsz = 0x1000n } = {}) {
  const shstrtab = new TextEncoder().encode('\0.badsec\0.shstrtab\0');
  const shoff = 0x3000;
  const bytes = new Uint8Array(0x4000);
  const b = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  b.setUint16(16, 2, true);            // ET_EXEC
  b.setUint16(18, 62, true);           // x86_64
  b.setUint32(20, 1, true);
  b.setBigUint64(24, 0x400000n, true); // e_entry
  b.setBigUint64(32, 0x40n, true);     // e_phoff
  b.setBigUint64(40, BigInt(shoff), true);
  b.setUint32(48, 0, true);
  b.setUint16(52, 64, true);
  b.setUint16(54, 56, true);
  b.setUint16(56, 1, true);            // e_phnum
  b.setUint16(58, 64, true);
  b.setUint16(60, 4, true);            // e_shnum
  b.setUint16(62, 3, true);            // e_shstrndx

  // PT_LOAD: offset 0x1000, vaddr 0x400000, R|X
  b.setUint32(0x40, 1, true);
  b.setUint32(0x44, 5, true);
  b.setBigUint64(0x48, 0x1000n, true);
  b.setBigUint64(0x50, loadVaddr, true);
  b.setBigUint64(0x58, loadVaddr, true);
  b.setBigUint64(0x60, loadFilesz, true);
  b.setBigUint64(0x68, loadMemsz, true);
  b.setBigUint64(0x70, 0x1000n, true);

  bytes.set(code11, 0x1000);
  bytes.set(code22, 0x2000);
  bytes.set(shstrtab, 0x2f00);

  const sh = (i, name, type, flags, addr, off, size, align = 1n) => {
    const p = shoff + i * 64;
    b.setUint32(p, name, true); b.setUint32(p + 4, type, true);
    b.setBigUint64(p + 8, BigInt(flags), true); b.setBigUint64(p + 16, BigInt(addr), true);
    b.setBigUint64(p + 24, BigInt(off), true); b.setBigUint64(p + 32, BigInt(size), true);
    b.setBigUint64(p + 48, BigInt(align), true);
  };
  sh(0, 0, 0, 0n, 0n, 0n, 0n, 0n);
  sh(1, 1, secType, secFlags, secAddr, secOffset, secSize, 16n); // .badsec
  sh(2, 8, 3, 0n, 0n, 0x2f00, 22n);
  sh(3, 0, 3, 0n, 0n, 0x2f00, BigInt(shstrtab.length));
  return bytes;
}

test('#7611: a SHF_ALLOC section disagreeing with the covering PT_LOAD mapping loses mapping authority', () => {
  const image = parseELF(buildELF({}));
  assert.equal(image.addressToOffset(0x400000n), 0x1000n, 'the PT_LOAD owns the VA→file mapping');
  const read = image.readVirtual(0x400000n, 12n);
  assert.ok(read);
  assert.deepEqual(Array.from(read), Array.from(code11), 'runtime bytes come from the PT_LOAD, not the section header');
  assert.ok(image.warnings.some((w) => w.includes('sh_offset disagrees with the covering PT_LOAD')));
  assert.equal(image.sections.find((s) => s.index === 1)?.source, 'unmapped-section');
});

test('#7611: a SHF_ALLOC section agreeing with the covering PT_LOAD keeps its mapping authority', () => {
  const image = parseELF(buildELF({ secAddr: 0x400010n, secOffset: 0x1010, secSize: 0x10n }));
  assert.equal(image.addressToOffset(0x400010n), 0x1010n);
  assert.ok(image.readVirtual(0x400010n, 4n));
  assert.ok(!image.warnings.some((w) => w.includes('excluded from virtual mapping authority')));
  assert.equal(image.sections.find((s) => s.index === 1)?.source, 'section-header');
});

test('#7611: a section in the zero-fill tail beyond the PT_LOAD file span keeps legacy authority', () => {
  const image = parseELF(buildELF({ secAddr: 0x4000800n, secOffset: 0x2000, secSize: 0x10n, loadFilesz: 0x800n, loadMemsz: 0x1000n }));
  assert.equal(image.addressToOffset(0x4000800n), 0x2000n, 'no file-backed PT_LOAD range covers the VA: no relation to contradict');
  assert.equal(image.sections.find((s) => s.index === 1)?.source, 'section-header');
});

test('#7611: a SHF_ALLOC section outside every PT_LOAD keeps legacy authority', () => {
  const image = parseELF(buildELF({ secAddr: 0x500000n, secOffset: 0x2000, secSize: 0x10n }));
  assert.equal(image.addressToOffset(0x500000n), 0x2000n, 'no covering segment: the #7611 relation check does not fire');
  assert.equal(image.sections.find((s) => s.index === 1)?.source, 'section-header');
});

test('#7611: SHT_NOBITS sections are not subject to the file-offset relation', () => {
  const image = parseELF(buildELF({ secType: 8, secOffset: 0x2000 }));
  assert.equal(image.sections.find((s) => s.index === 1)?.source, 'section-header', 'NOBITS has no file bytes');
  assert.ok(!image.warnings.some((w) => w.includes('sh_offset disagrees with the covering PT_LOAD')));
});
