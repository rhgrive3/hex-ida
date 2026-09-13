import assert from 'node:assert/strict';
import test from 'node:test';
import { parseELF } from '../../../js/binary/elf.js';

function u32le(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function attributesFor(arch) {
  const encoder = new TextEncoder();
  const archBytes = [...encoder.encode(arch), 0];
  const attributes = [5, ...archBytes]; // Tag_RISCV_arch = 5
  const fileSubsection = [1, ...u32le(1 + 4 + attributes.length), ...attributes]; // Tag_File = 1
  const vendor = [...encoder.encode('riscv'), 0];
  const vendorSubsection = [...u32le(4 + vendor.length + fileSubsection.length), ...vendor, ...fileSubsection];
  return Uint8Array.from([0x41, ...vendorSubsection]);
}

function makeRiscv32Fixture() {
  const b = new Uint8Array(0x600);
  const v = new DataView(b.buffer);
  const w16 = (o, x) => v.setUint16(o, x, true);
  const w32 = (o, x) => v.setUint32(o, x, true);

  // ELF header: 32-bit, little-endian, current version
  b.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0, 0], 0);
  w16(16, 2); // ET_EXEC
  w16(18, 243); // EM_RISCV
  w32(20, 1); // EV_CURRENT
  w32(24, 0x1000); // e_entry
  w32(28, 0x40); // e_phoff
  w32(32, 0x300); // e_shoff
  w32(36, 0); // e_flags
  w16(40, 52); // e_ehsize
  w16(42, 32); // e_phentsize
  w16(44, 1); // e_phnum
  w16(46, 40); // e_shentsize
  w16(48, 6); // e_shnum
  w16(50, 5); // e_shstrndx

  // Program header: PT_LOAD at 0x40
  const ph = 0x40;
  w32(ph, 1); // PT_LOAD
  w32(ph + 4, 0x100); // p_offset
  w32(ph + 8, 0x1000); // p_vaddr
  w32(ph + 12, 0x1000); // p_paddr
  w32(ph + 16, 0x100); // p_filesz
  w32(ph + 20, 0x100); // p_memsz
  w32(ph + 24, 7); // PF_R | PF_W | PF_X
  w32(ph + 28, 0x1000); // p_align

  // Section 1: .text at file offset 0x100, VA 0x1000, size 0x20
  b.fill(0x13, 0x100, 0x120); // nop

  // Section 2: .riscv.attributes at file offset 0x140
  const attrData = attributesFor('rv32imc');
  b.set(attrData, 0x140);

  // Strings for .strtab and .shstrtab
  const strtab = new TextEncoder().encode('\0$xrv32imc\0$d\0foo\0');
  b.set(strtab, 0x180);

  // Section 3: .symtab at file offset 0x200
  // Symbol 0: STN_UNDEF
  // Symbol 1: $xrv32imc (offset 1, STB_LOCAL (0), STT_NOTYPE (0), shndx 1, value 0x1000, size 0)
  // Symbol 2: $d (offset 11, STB_LOCAL (0), STT_NOTYPE (0), shndx 1, value 0x1010, size 0)
  // Symbol 3: foo (offset 14, STB_GLOBAL (1), STT_FUNC (2), shndx 1, value 0x1000, size 0x20)
  const sym32 = (p, name, val, sz, info, other, shndx) => {
    w32(p, name);
    w32(p + 4, val);
    w32(p + 8, sz);
    b[p + 12] = info;
    b[p + 13] = other;
    w16(p + 14, shndx);
  };
  sym32(0x200, 0, 0, 0, 0, 0, 0);
  sym32(0x210, 1, 0x1000, 0, 0, 0, 1);
  sym32(0x220, 11, 0x1010, 0, 0, 0, 1);
  sym32(0x230, 14, 0x1000, 0x20, 0x12, 0, 1);

  // Section 5: .shstrtab at file offset 0x280
  const shstr = new TextEncoder().encode('\0.text\0.riscv.attributes\0.strtab\0.symtab\0.shstrtab\0');
  b.set(shstr, 0x280);

  // Section headers at 0x300 (40 bytes each)
  const sh32 = (i, name, type, flags, addr, off, sz, link, info, align, entsize) => {
    const p = 0x300 + i * 40;
    w32(p, name);
    w32(p + 4, type);
    w32(p + 8, flags);
    w32(p + 12, addr);
    w32(p + 16, off);
    w32(p + 20, sz);
    w32(p + 24, link);
    w32(p + 28, info);
    w32(p + 32, align);
    w32(p + 36, entsize);
  };

  sh32(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  sh32(1, 1, 1, 6, 0x1000, 0x100, 0x20, 0, 0, 4, 0); // .text (SHT_PROGBITS, SHF_ALLOC | SHF_EXECINSTR)
  sh32(2, 7, 0x70000003, 0, 0, 0x140, attrData.length, 0, 0, 1, 0); // .riscv.attributes (SHT_RISCV_ATTRIBUTES = 0x70000003)
  sh32(3, 25, 3, 0, 0, 0x180, strtab.length, 0, 0, 1, 0); // .strtab (SHT_STRTAB)
  sh32(4, 33, 2, 0, 0, 0x200, 4 * 16, 3, 3, 4, 16); // .symtab (SHT_SYMTAB)
  sh32(5, 41, 3, 0, 0, 0x280, shstr.length, 0, 0, 1, 0); // .shstrtab (SHT_STRTAB)

  return b;
}

test('issue #4074: ELF32 RISC-V parses .riscv.attributes and mapping symbols into riscvIsa metadata', () => {
  const bytes = makeRiscv32Fixture();
  const image = parseELF(bytes);

  assert.equal(image.arch, 'riscv32');
  assert.equal(image.bits, 32);

  // Must have riscvIsa metadata
  assert.ok(image.metadata.riscvIsa, 'ELF32 RISC-V must populate image.metadata.riscvIsa');
  assert.equal(image.metadata.riscvIsa.file?.xlen, 32);
  assert.equal(image.metadata.riscvIsa.file?.canonical, 'rv32imc');
  assert.equal(image.metadata.riscvIsa.file?.compressedInstructions, true);
  assert.equal(image.metadata.riscvIsa.file?.instructionAlignment, 2);

  // Must have mapping symbols
  const mappings = image.metadata.riscvIsa.mappings;
  assert.ok(Array.isArray(mappings), 'mappings must be an array');
  assert.equal(mappings.length, 2);
  assert.equal(mappings[0].address, 0x1000n);
  assert.equal(mappings[0].kind, 'instruction');
  assert.equal(mappings[0].isa?.canonical, 'rv32imc');
  assert.equal(mappings[1].address, 0x1010n);
  assert.equal(mappings[1].kind, 'data');
});
