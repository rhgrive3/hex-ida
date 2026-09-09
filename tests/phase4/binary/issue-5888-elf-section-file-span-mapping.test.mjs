import assert from 'node:assert/strict';
import test from 'node:test';

import { parseELF } from '../../../js/binary/elf.js';

// A file-backed SHF_ALLOC section must live inside the file to serve as
// virtual mapping authority. `sectionHasMappedAddress()` ranks the smallest
// covering mapping, so a malformed section header whose sh_offset/sh_size
// points past EOF could shadow a validated PT_LOAD (#5888).

function buildELF({ secOffset, secSize }) {
  const shstrtab = new TextEncoder().encode('\0.badsec\0.shstrtab\0');
  const shoff = 0x80;
  const bytes = new Uint8Array(0x400);
  const b = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  b.setUint16(16, 2, true);            // e_type = ET_EXEC
  b.setUint16(18, 62, true);           // e_machine = x86_64
  b.setUint32(20, 1, true);
  b.setBigUint64(24, 0x400100n, true); // e_entry
  b.setBigUint64(32, 0x40n, true);     // e_phoff
  b.setBigUint64(40, BigInt(shoff), true);
  b.setUint32(48, 0, true);
  b.setUint16(52, 64, true);
  b.setUint16(54, 56, true);
  b.setUint16(56, 1, true);            // e_phnum
  b.setUint16(58, 64, true);
  b.setUint16(60, 4, true);            // e_shnum
  b.setUint16(62, 3, true);            // e_shstrndx

  // PT_LOAD: offset 0x100, vaddr 0x400000, filesz/memsz 0x100, R|X
  b.setUint32(0x40, 1, true);
  b.setUint32(0x44, 5, true);
  b.setBigUint64(0x48, 0x100n, true);
  b.setBigUint64(0x50, 0x400000n, true);
  b.setBigUint64(0x58, 0x400000n, true);
  b.setBigUint64(0x60, 0x100n, true);
  b.setBigUint64(0x68, 0x100n, true);
  b.setBigUint64(0x70, 0x1000n, true);

  bytes.set(shstrtab, 0x70);
  const sh = (i, name, type, flags, addr, off, size, align = 1n) => {
    const p = shoff + i * 64;
    b.setUint32(p, name, true); b.setUint32(p + 4, type, true);
    b.setBigUint64(p + 8, BigInt(flags), true); b.setBigUint64(p + 16, BigInt(addr), true);
    b.setBigUint64(p + 24, BigInt(off), true); b.setBigUint64(p + 32, BigInt(size), true);
    b.setBigUint64(p + 48, BigInt(align), true);
  };
  sh(0, 0, 0, 0n, 0n, 0n, 0n, 0n);
  sh(1, 1, 1, 0x2n, 0x400020n, secOffset, secSize); // .badsec SHF_ALLOC PROGBITS
  sh(2, 8, 3, 0n, 0n, 0x70, 22n);                   // .shstrtab
  sh(3, 0, 3, 0n, 0n, 0x70, BigInt(shstrtab.length));
  return bytes;
}

function offsetFor(args) {
  const image = parseELF(buildELF(args));
  return { image, offset: image.addressToOffset(0x400020n), read: image.readVirtual(0x400020n, 1n) };
}

test('#5888: a valid contained SHF_ALLOC section keeps its mapping authority', () => {
  const { image, offset, read } = offsetFor({ secOffset: 0x120, secSize: 0x10 });
  assert.equal(offset, 0x120n);
  assert.ok(read);
  assert.ok(!image.warnings.some((w) => w.includes('excluded from virtual mapping authority')));
});

test('#5888: a section with sh_offset beyond EOF cannot shadow a valid PT_LOAD', () => {
  const { image, offset, read } = offsetFor({ secOffset: 0x1000, secSize: 0x10 });
  assert.equal(offset, 0x120n, 'the validated PT_LOAD owns the mapping');
  assert.ok(read, 'the VA stays readable');
  assert.ok(image.warnings.some((w) => w.includes('file span beyond EOF')));
  const excluded = image.sections.find((s) => s.index === 1);
  assert.equal(excluded?.source, 'unmapped-section');
});

test('#5888: a section whose sh_size runs past EOF cannot shadow a valid PT_LOAD', () => {
  const { image, offset, read } = offsetFor({ secOffset: 0x3f8, secSize: 0x20 });
  assert.equal(offset, 0x120n);
  assert.ok(read);
  assert.ok(image.warnings.some((w) => w.includes('file span beyond EOF')));
  assert.equal(image.sections.find((s) => s.index === 1)?.source, 'unmapped-section');
});

test('#5888: SHT_NOBITS has no file bytes and cannot shadow PT_LOAD file-backed bytes (#7611)', () => {
  const image = parseELF(buildELF({ secOffset: 0x1000, secSize: 0x10 }));
  const nobits = buildELF({ secOffset: 0x1000, secSize: 0x10 });
  const b = new DataView(nobits.buffer);
  b.setUint32(0x80 + 64 + 4, 8, true); // section 1 type -> SHT_NOBITS
  const nobitsImage = parseELF(nobits);
  void image;
  const sec = nobitsImage.sections.find((s) => s.index === 1);
  assert.equal(sec?.fileSize, 0n);
  // Reconciled with #7611: the PT_LOAD has filesz === memsz (no zero-fill
  // tail), so this NOBITS section's VA range overlaps file-backed loader
  // bytes. Zero-fill authority there would shadow runtime bytes; the section
  // stays listed for metadata but loses mapping authority fail-closed.
  assert.equal(sec?.source, 'unmapped-section', 'NOBITS over file-backed PT_LOAD bytes has no zero-fill authority');
  assert.ok(nobitsImage.warnings.some((w) => w.includes('excluded from virtual mapping authority')));
  assert.equal(nobitsImage.addressToOffset(0x400020n), 0x120n, 'the validated PT_LOAD owns the mapping');
  assert.ok(nobitsImage.readVirtual(0x400020n, 1n), 'the VA stays readable via the PT_LOAD');
});
