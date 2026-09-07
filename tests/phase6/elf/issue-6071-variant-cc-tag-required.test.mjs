import test from 'node:test';
import assert from 'node:assert/strict';
import { parseELF } from '../../../js/binary/elf-core.js';
import { parseProgramDynamic } from '../../../js/binary/elf-dynamic.js';

const BASE = 0x400000n;
const DYNAMIC_OFFSET = 0x100;
const SYMTAB_OFFSET = 0x200;
const STRTAB_OFFSET = 0x300;
const JMPREL_OFFSET = 0x400;
// R_RISCV_JUMP_SLOT / DT_RISCV_VARIANT_CC are RISC-V psABI constants.
const DT_VARIANT_CC = 0x70000001;

function reader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    length: bytes.length,
    u8: (off) => view.getUint8(off),
    u16: (off) => view.getUint16(off, true),
    u32: (off) => view.getUint32(off, true),
    i32: (off) => view.getInt32(off, true),
    u64: (off) => view.getBigUint64(off, true),
    i64: (off) => view.getBigInt64(off, true),
    slice: (off, size) => bytes.slice(off, off + size),
    cstring(off, maxLength) {
      const end = Math.min(bytes.length, off + maxLength);
      let stop = off;
      while (stop < end && bytes[stop] !== 0) stop++;
      return new TextDecoder().decode(bytes.subarray(off, stop));
    },
  };
}

function putDynamic(view, index, tag, value) {
  const off = DYNAMIC_OFFSET + index * 16;
  view.setBigInt64(off, BigInt(tag), true);
  view.setBigUint64(off + 8, BigInt(value), true);
}

// options: { stOther, withTag, machine, type }
function fixture({ stOther = 0x80, withTag = false, machine = 243, type = 2 } = {}) {
  const bytes = new Uint8Array(0x800);
  const view = new DataView(bytes.buffer);
  const strtabVa = BASE + BigInt(STRTAB_OFFSET);
  const symtabVa = BASE + BigInt(SYMTAB_OFFSET);
  const jmprelVa = BASE + BigInt(JMPREL_OFFSET);
  const stringBytes = Uint8Array.from([0, ...new TextEncoder().encode('vecfn'), 0]);

  let i = 0;
  putDynamic(view, i++, 5, strtabVa);   // DT_STRTAB
  putDynamic(view, i++, 10, stringBytes.length); // DT_STRSZ
  putDynamic(view, i++, 6, symtabVa);   // DT_SYMTAB
  putDynamic(view, i++, 11, 24);        // DT_SYMENT
  putDynamic(view, i++, 39, 48);        // DT_SYMTABSZ: two symbols
  putDynamic(view, i++, 23, jmprelVa);  // DT_JMPREL
  putDynamic(view, i++, 2, 24);         // DT_PLTRELSZ
  putDynamic(view, i++, 20, 7);         // DT_PLTREL = DT_RELA
  if (withTag) putDynamic(view, i++, DT_VARIANT_CC, 0);
  putDynamic(view, i++, 0, 0);          // DT_NULL
  const entries = i;

  bytes.set(stringBytes, STRTAB_OFFSET);

  view.setUint32(SYMTAB_OFFSET + 24, 1, true); // st_name -> 'vecfn'
  view.setUint8(SYMTAB_OFFSET + 28, 0x10 | type); // STB_GLOBAL | symbol type
  view.setUint8(SYMTAB_OFFSET + 29, stOther);
  view.setUint16(SYMTAB_OFFSET + 30, 0, true); // SHN_UNDEF: import-like, no function-seed partial
  view.setBigUint64(SYMTAB_OFFSET + 32, BASE + 0x1000n, true);
  view.setBigUint64(SYMTAB_OFFSET + 40, 16n, true);

  // JMPREL: one R_RISCV_JUMP_SLOT (type 5) against symbol 1
  view.setBigUint64(JMPREL_OFFSET, BASE + 0x2000n, true);
  view.setBigUint64(JMPREL_OFFSET + 8, (1n << 32n) | 5n, true);
  view.setBigInt64(JMPREL_OFFSET + 16, 0n, true);

  const segment = {
    address: BASE, size: 0x800n, fileOffset: 0n, fileSize: 0x800n,
    perms: { read: true, write: true, execute: false },
  };
  const image = {
    warnings: [], libraries: [], metadata: { machine }, segments: [segment], sections: [],
    symbols: [], imports: [], exports: [], functions: [], relocations: [],
    addressToOffset(address) { const d = BigInt(address) - BASE; return d >= 0n && d < 0x800n ? Number(d) : null; },
    sectionAt() { return null; },
    segmentAt(address) { const v = BigInt(address); return v >= BASE && v < BASE + 0x800n ? segment : null; },
  };
  parseProgramDynamic(
    reader(bytes),
    [{ type: 2, offset: BigInt(DYNAMIC_OFFSET), filesz: BigInt(entries * 16) }],
    image,
    64,
  );
  return image;
}

function partialReasons(image) {
  return image.warnings.filter((w) => w.includes('DT_RISCV_VARIANT_CC'));
}

test('6071: variant-cc JUMP_SLOT with tag stays valid', () => {
  const image = fixture({ withTag: true });
  assert.equal(image.relocations.length, 1);
  assert.equal(partialReasons(image).length, 0);
  assert.equal(image.metadata.programDynamicPartial ?? false, false);
});

test('6071: variant-cc JUMP_SLOT without tag is partial, not complete', () => {
  const image = fixture({ withTag: false });
  assert.equal(image.relocations.length, 1);
  assert.ok(partialReasons(image).length > 0, 'expected a DT_RISCV_VARIANT_CC diagnostic');
  assert.equal(image.metadata.programDynamicPartial, true);
});

test('6071: ordinary JUMP_SLOT without tag stays valid', () => {
  const image = fixture({ stOther: 0, withTag: false });
  assert.equal(partialReasons(image).length, 0);
});

test('6071: non-function variant flag still requires tag without function calling convention', () => {
  const image = fixture({ type: 1, withTag: false });
  const sym = image.symbols.find((s) => s.name === 'vecfn');
  assert.ok(sym, 'vecfn must be decoded');
  assert.equal(sym.riscvVariantCcFlag, true);
  assert.equal(sym.riscvVariantCc, false, 'non-function symbols must not gain function calling convention');
  assert.equal(sym.callingConvention, null);
  assert.ok(partialReasons(image).length > 0, 'variant flag on a JUMP_SLOT still requires DT_RISCV_VARIANT_CC');
});

test('6071: variant symbol without JUMP_SLOT is not rejected', () => {
  const bytes = new Uint8Array(0x800);
  const view = new DataView(bytes.buffer);
  const strtabVa = BASE + BigInt(STRTAB_OFFSET);
  const symtabVa = BASE + BigInt(SYMTAB_OFFSET);
  const stringBytes = Uint8Array.from([0, ...new TextEncoder().encode('vecfn'), 0]);
  putDynamic(view, 0, 5, strtabVa);
  putDynamic(view, 1, 10, stringBytes.length);
  putDynamic(view, 2, 6, symtabVa);
  putDynamic(view, 3, 11, 24);
  putDynamic(view, 4, 39, 48);
  putDynamic(view, 5, 0, 0);
  bytes.set(stringBytes, STRTAB_OFFSET);
  view.setUint32(SYMTAB_OFFSET + 24, 1, true);
  view.setUint8(SYMTAB_OFFSET + 28, 0x12);
  view.setUint8(SYMTAB_OFFSET + 29, 0x80);
  view.setUint16(SYMTAB_OFFSET + 30, 1, true);
  const segment = { address: BASE, size: 0x800n, fileOffset: 0n, fileSize: 0x800n, perms: { read: true, write: true, execute: false } };
  const image = {
    warnings: [], libraries: [], metadata: { machine: 243 }, segments: [segment], sections: [],
    symbols: [], imports: [], exports: [], functions: [], relocations: [],
    addressToOffset(address) { const d = BigInt(address) - BASE; return d >= 0n && d < 0x800n ? Number(d) : null; },
    sectionAt() { return null; },
    segmentAt(address) { const v = BigInt(address); return v >= BASE && v < BASE + 0x800n ? segment : null; },
  };
  parseProgramDynamic(reader(bytes), [{ type: 2, offset: BigInt(DYNAMIC_OFFSET), filesz: BigInt(6 * 16) }], image, 64);
  assert.equal(partialReasons(image).length, 0);
});

test('6071: non-RISC-V machine ignores the invariant', () => {
  const image = fixture({ withTag: false, machine: 62 });
  assert.equal(partialReasons(image).length, 0);
});


function buildSectionBackedVariantCcElf({ withTag = false } = {}) {
  const dynstrOffset = 0x100;
  const dynsymOffset = 0x120;
  const relaOffset = 0x160;
  const dynamicOffset = 0x180;
  const shstrOffset = 0x1c0;
  const shoff = 0x240;
  const names = ['', '.dynsym', '.dynstr', '.rela.plt', '.dynamic', '.shstrtab'];
  const shstrParts = [];
  const nameOffsets = new Map();
  for (const name of names) {
    nameOffsets.set(name, shstrParts.length);
    shstrParts.push(...Buffer.from(name, 'utf8'), 0);
  }
  const dynstr = Uint8Array.from([0, ...Buffer.from('vecfn', 'utf8'), 0]);
  const shstr = Uint8Array.from(shstrParts);
  const sectionCount = names.length;
  const bytes = new Uint8Array(shoff + sectionCount * 64);
  const view = new DataView(bytes.buffer);

  bytes.set(dynstr, dynstrOffset);
  bytes.set(shstr, shstrOffset);

  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0);
  view.setUint16(16, 3, true);  // ET_DYN
  view.setUint16(18, 243, true); // EM_RISCV
  view.setUint32(20, 1, true);
  view.setBigUint64(24, 0n, true); // entry
  view.setBigUint64(32, 0n, true); // phoff
  view.setBigUint64(40, BigInt(shoff), true);
  view.setUint32(48, 0, true);
  view.setUint16(52, 64, true);
  view.setUint16(54, 56, true);
  view.setUint16(56, 0, true);
  view.setUint16(58, 64, true);
  view.setUint16(60, sectionCount, true);
  view.setUint16(62, names.length - 1, true);

  const putDynamic = (index, tag, value) => {
    const off = dynamicOffset + index * 16;
    view.setBigInt64(off, BigInt(tag), true);
    view.setBigUint64(off + 8, BigInt(value), true);
  };
  let dynamicEntries = 0;
  if (withTag) {
    putDynamic(dynamicEntries++, 0x70000001n, 0n); // DT_RISCV_VARIANT_CC
  }
  putDynamic(dynamicEntries++, 0n, 0n); // DT_NULL

  // Two 64-bit dynsym entries: the null entry and an undefined variant-CC function.
  view.setUint32(dynsymOffset + 24, 1, true); // st_name -> vecfn
  view.setUint8(dynsymOffset + 24 + 4, 0x12); // STB_GLOBAL | STT_FUNC
  view.setUint8(dynsymOffset + 24 + 5, 0x80); // STO_RISCV_VARIANT_CC
  view.setUint16(dynsymOffset + 24 + 6, 0, true); // SHN_UNDEF
  view.setBigUint64(dynsymOffset + 24 + 8, 0n, true);
  view.setBigUint64(dynsymOffset + 24 + 16, 16n, true);

  // One R_RISCV_JUMP_SLOT relocation against dynsym[1].
  view.setBigUint64(relaOffset, 0x500n, true);
  view.setBigUint64(relaOffset + 8, (1n << 32n) | 5n, true);
  view.setBigInt64(relaOffset + 16, 0n, true);

  const writeSection = (index, {
    name = '', type = 0, flags = 0n, address = 0n, offset = 0,
    size = 0, link = 0, info = 0, alignment = 1n, entrySize = 0n,
  } = {}) => {
    const off = shoff + index * 64;
    view.setUint32(off, nameOffsets.get(name) ?? 0, true);
    view.setUint32(off + 4, type, true);
    view.setBigUint64(off + 8, BigInt(flags), true);
    view.setBigUint64(off + 16, BigInt(address), true);
    view.setBigUint64(off + 24, BigInt(offset), true);
    view.setBigUint64(off + 32, BigInt(size), true);
    view.setUint32(off + 40, link, true);
    view.setUint32(off + 44, info, true);
    view.setBigUint64(off + 48, BigInt(alignment), true);
    view.setBigUint64(off + 56, BigInt(entrySize), true);
  };
  writeSection(0);
  writeSection(1, { name: '.dynsym', type: 11, offset: dynsymOffset, size: 48, link: 2, alignment: 8n, entrySize: 24n });
  writeSection(2, { name: '.dynstr', type: 3, offset: dynstrOffset, size: dynstr.length });
  writeSection(3, { name: '.rela.plt', type: 4, offset: relaOffset, size: 24, link: 1, alignment: 8n, entrySize: 24n });
  writeSection(4, { name: '.dynamic', type: 6, offset: dynamicOffset, size: dynamicEntries * 16, link: 2, alignment: 8n, entrySize: 16n });
  writeSection(5, { name: '.shstrtab', type: 3, offset: shstrOffset, size: shstr.length });
  return bytes;
}

test('6071: full parseELF section-backed dynsym JUMP_SLOT without DT_RISCV_VARIANT_CC is partial', () => {
  const missing = parseELF(buildSectionBackedVariantCcElf());
  assert.equal(missing.relocations.length, 1);
  assert.equal(missing.relocations[0].source, 'RELA');
  assert.equal(missing.relocations[0].symbol, 'vecfn');
  assert.equal(missing.relocations[0].symbolIndex, 1);
  assert.equal(missing.relocations[0].symbolTableIndex, 1);
  assert.ok(missing.metadata.programDynamicPartial);
  assert.ok(missing.warnings.some((warning) => warning.includes('section-backed RISC-V variant-cc JUMP_SLOT requires DT_RISCV_VARIANT_CC')));

  const tagged = parseELF(buildSectionBackedVariantCcElf({ withTag: true }));
  assert.equal(tagged.metadata.programDynamicPartial ?? false, false);
  assert.equal(tagged.warnings.some((warning) => warning.includes('section-backed RISC-V variant-cc JUMP_SLOT requires DT_RISCV_VARIANT_CC')), false);
});
