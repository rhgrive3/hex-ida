import assert from 'node:assert/strict';
import test from 'node:test';

import { ByteView } from '../../../js/binary/reader.js';
import { parseELF } from '../../../js/binary/elf.js';
import { parseProgramDynamic } from '../../../js/binary/elf-dynamic.js';

// STB_GNU_UNIQUE (10) is a process-wide unique global binding (GNU ELF ABI).
// A defined, default-visibility STB_GNU_UNIQUE symbol in .dynsym must keep its
// place in the export/linkage truth instead of vanishing into an anonymous
// `bind-10` bucket (#5844).

function buildELF64WithUniqueDynsym() {
  const shstrtab = new TextEncoder().encode('\0.dynsym\0.dynstr\0.shstrtab\0');
  const dynstr = new TextEncoder().encode('\0unique_obj\0');
  const dynsym = new Uint8Array(24);
  const dv = new DataView(dynsym.buffer);
  dv.setUint32(0, 1, true);          // st_name -> "unique_obj"
  dv.setUint8(4, (10 << 4) | 1);     // st_info = STB_GNU_UNIQUE | STT_OBJECT
  dv.setUint8(5, 0);                 // st_other = STV_DEFAULT
  dv.setUint16(6, 1, true);          // st_shndx = 1
  dv.setBigUint64(8, 0x4000n, true); // st_value
  dv.setBigUint64(16, 8n, true);     // st_size

  const shoff = 0x90;
  const bytes = new Uint8Array(shoff + 4 * 64);
  const b = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  b.setUint16(16, 3, true);          // ET_DYN
  b.setUint16(18, 62, true);         // x86_64
  b.setUint32(20, 1, true);
  b.setBigUint64(24, 0n, true);
  b.setBigUint64(32, 0n, true);
  b.setBigUint64(40, BigInt(shoff), true);
  b.setUint16(52, 64, true);
  b.setUint16(54, 56, true);
  b.setUint16(56, 0, true);
  b.setUint16(58, 64, true);
  b.setUint16(60, 4, true);
  b.setUint16(62, 3, true);

  bytes.set(dynsym, 0x40);
  bytes.set(dynstr, 0x58);
  bytes.set(shstrtab, 0x70);

  const sh = (i, name, type, flags, addr, off, size, link, info, align, entsize) => {
    const p = shoff + i * 64;
    b.setUint32(p, name, true); b.setUint32(p + 4, type, true);
    b.setBigUint64(p + 8, BigInt(flags), true); b.setBigUint64(p + 16, BigInt(addr), true);
    b.setBigUint64(p + 24, BigInt(off), true); b.setBigUint64(p + 32, BigInt(size), true);
    b.setUint32(p + 40, link, true); b.setUint32(p + 44, info, true);
    b.setBigUint64(p + 48, BigInt(align), true); b.setBigUint64(p + 56, BigInt(entsize), true);
  };
  sh(0, 0, 0, 0n, 0n, 0n, 0n, 0, 0, 0n, 0n);
  sh(1, 1, 11, 0n, 0n, 0x40, 24n, 2, 1, 8n, 24n);   // .dynsym
  sh(2, 9, 3, 0n, 0n, 0x58, 12n, 0, 0, 1n, 0n);     // .dynstr
  sh(3, 17, 3, 0n, 0n, 0x70, BigInt(shstrtab.length), 0, 0, 1n, 0n); // .shstrtab
  return bytes;
}

test('#5844: section-backed STB_GNU_UNIQUE dynsym entry becomes a named export', () => {
  const image = parseELF(buildELF64WithUniqueDynsym());
  const sym = image.symbols.find((s) => s.name === 'unique_obj');
  assert.ok(sym, 'the unique symbol is present');
  assert.equal(sym.binding, 'gnu-unique');
  assert.equal(sym.defined, true);
  assert.equal(sym.address, 0x4000n);

  const exported = image.exports.find((e) => e.name === 'unique_obj');
  assert.ok(exported, 'the unique symbol is exported');
  assert.equal(exported.address, 0x4000n);
  assert.equal(exported.kind, 'object');
});

const BASE = 0x400000n;
const DT_SYMTAB = 6n, DT_STRTAB = 5n, DT_STRSZ = 10n, DT_SYMENT = 11n, DT_NULL = 0n;

function runDynamic(bind) {
  const bytes = new Uint8Array(0x200);
  const b = new DataView(bytes.buffer);
  const dyn = [
    [DT_SYMTAB, BASE + 0x80n],
    [DT_STRTAB, BASE + 0x98n],
    [DT_STRSZ, 0x20n],
    [DT_SYMENT, 24n],
    [DT_NULL, 0n],
  ];
  dyn.forEach(([tag, value], index) => {
    b.setBigInt64(index * 16, BigInt(tag), true);
    b.setBigUint64(index * 16 + 8, BigInt(value), true);
  });
  const symtab = new Uint8Array(24);
  const sv = new DataView(symtab.buffer);
  sv.setUint32(0, 1, true);
  sv.setUint8(4, (bind << 4) | 1);   // binding | STT_OBJECT
  sv.setUint8(5, 0);
  sv.setUint16(6, 1, true);
  sv.setBigUint64(8, 0x40n, true);
  sv.setBigUint64(16, 8n, true);
  bytes.set(symtab, 0x80);
  bytes.set(new TextEncoder().encode('\0unique_obj\0'), 0x98);

  const segment = {
    name: 'LOAD', address: BASE, size: BigInt(bytes.length),
    fileOffset: 0n, fileSize: BigInt(bytes.length),
    perms: { read: true, write: false, execute: false },
  };
  const image = {
    bits: 64, imageBase: BASE, metadata: { machine: 62 }, warnings: [],
    libraries: [], imports: [], exports: [], symbols: [], relocations: [], functions: [], sections: [],
    segments: [segment],
    addressToOffset(address) {
      const delta = BigInt(address) - BASE;
      return delta >= 0n && delta < BigInt(bytes.length) ? delta : null;
    },
    sectionAt() { return null; },
    segmentAt(address) {
      const a = BigInt(address);
      return a >= segment.address && a < segment.address + segment.size ? segment : null;
    },
  };
  parseProgramDynamic(new ByteView(bytes), [{ type: 2, offset: 0n, filesz: BigInt(dyn.length * 16) }], image, 64);
  return image;
}

test('#5844: PT_DYNAMIC STB_GNU_UNIQUE dynsym entry becomes a named export', () => {
  const image = runDynamic(10);
  const sym = image.symbols.find((s) => s.name === 'unique_obj');
  assert.ok(sym);
  assert.equal(sym.binding, 'gnu-unique');
  assert.equal(sym.defined, true);
  const exported = image.exports.find((e) => e.name === 'unique_obj');
  assert.ok(exported, 'the unique symbol is exported on the PT_DYNAMIC path');
  assert.equal(exported.address, 0x40n);
});

test('#5844: global and weak export behavior is unchanged', () => {
  for (const bind of [1, 2]) {
    const image = runDynamic(bind);
    const exported = image.exports.find((e) => e.name === 'unique_obj');
    assert.ok(exported, `bind ${bind} still exports`);
    assert.equal(exported.address, 0x40n);
  }
  const local = runDynamic(0);
  assert.ok(!local.exports.some((e) => e.name === 'unique_obj'), 'locals stay unexported');
});
