import assert from 'node:assert/strict';
import test from 'node:test';

import { ByteView } from '../../../js/binary/reader.js';
import { parseELF } from '../../../js/binary/elf.js';
import { parseProgramDynamic } from '../../../js/binary/elf-dynamic.js';

// A defined STT_TLS symbol's st_value is its TLS offset, not a virtual
// address (ELF gABI). Neither the section-backed nor the PT_DYNAMIC symbol
// path may mint a VA from it or push it into image.exports (#5843).

function buildELF64WithTlsDynsym() {
  const shstrtab = new TextEncoder().encode('\0.dynsym\0.dynstr\0.shstrtab\0');
  const dynstr = new TextEncoder().encode('\0_tls_counter\0');
  const dynsym = new Uint8Array(24);
  const dv = new DataView(dynsym.buffer);
  dv.setUint32(0, 1, true);          // st_name -> "_tls_counter"
  dv.setUint8(4, 0x16);              // st_info = STB_GLOBAL(1)<<4 | STT_TLS(6)
  dv.setUint8(5, 0);                 // st_other = default visibility
  dv.setUint16(6, 1, true);          // st_shndx = 1
  dv.setBigUint64(8, 8n, true);      // st_value = TLS offset 8
  dv.setBigUint64(16, 4n, true);     // st_size

  const shoff = 0x90;
  const bytes = new Uint8Array(shoff + 4 * 64);
  const b = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  b.setUint16(16, 3, true);          // e_type = ET_DYN
  b.setUint16(18, 62, true);         // e_machine = x86_64
  b.setUint32(20, 1, true);          // e_version
  b.setBigUint64(24, 0n, true);      // e_entry
  b.setBigUint64(32, 0n, true);      // e_phoff
  b.setBigUint64(40, BigInt(shoff), true); // e_shoff
  b.setUint32(48, 0, true);          // e_flags
  b.setUint16(52, 64, true);         // e_ehsize
  b.setUint16(54, 56, true);         // e_phentsize
  b.setUint16(56, 0, true);          // e_phnum
  b.setUint16(58, 64, true);         // e_shentsize
  b.setUint16(60, 4, true);          // e_shnum
  b.setUint16(62, 3, true);          // e_shstrndx

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
  sh(2, 9, 3, 0n, 0n, 0x58, 14n, 0, 0, 1n, 0n);     // .dynstr
  sh(3, 17, 3, 0n, 0n, 0x70, BigInt(shstrtab.length), 0, 0, 1n, 0n); // .shstrtab
  return bytes;
}

test('#5843: section-backed dynsym keeps STT_TLS st_value in the tls-offset domain', () => {
  const image = parseELF(buildELF64WithTlsDynsym());
  const sym = image.symbols.find((s) => s.name === '_tls_counter');
  assert.ok(sym, 'TLS symbol is present');
  assert.equal(sym.kind, 'tls');
  assert.equal(sym.address, null);
  assert.equal(sym.tlsOffset, 8n);
  assert.equal(sym.addressDomain, 'tls-offset');

  const exported = image.exports.find((e) => e.name === '_tls_counter');
  assert.ok(exported, 'TLS export keeps its name/visibility fact');
  assert.equal(exported.address, null);
  assert.equal(exported.tlsOffset, 8n);
  assert.equal(exported.kind, 'tls');

  assert.ok(!image.exports.some((e) => e.address === 8n || e.address === 0x8n));
  assert.ok(!image.functions.some((f) => f.address === 8n));
});

const BASE = 0x400000n;
const DT_SYMTAB = 6n, DT_STRTAB = 5n, DT_STRSZ = 10n, DT_SYMENT = 11n, DT_NULL = 0n;

function runDynamic() {
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
  sv.setUint32(0, 1, true);        // st_name
  sv.setUint8(4, 0x16);            // STB_GLOBAL | STT_TLS
  sv.setUint8(5, 0);
  sv.setUint16(6, 1, true);
  sv.setBigUint64(8, 8n, true);
  sv.setBigUint64(16, 4n, true);
  bytes.set(symtab, 0x80);
  bytes.set(new TextEncoder().encode('\0_tls_counter\0'), 0x98);

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

test('#5843: PT_DYNAMIC-only dynsym applies the same tls-offset contract', () => {
  const image = runDynamic();
  const sym = image.symbols.find((s) => s.name === '_tls_counter');
  assert.ok(sym, 'TLS symbol is present');
  assert.equal(sym.kind, 'tls');
  assert.equal(sym.address, null);
  assert.equal(sym.tlsOffset, 8n);

  const exported = image.exports.find((e) => e.name === '_tls_counter');
  assert.ok(exported, 'TLS export keeps its name/visibility fact');
  assert.equal(exported.address, null);
  assert.equal(exported.tlsOffset, 8n);
  assert.ok(!image.exports.some((e) => e.address === 8n));
  assert.ok(!image.functions.some((f) => f.address === 8n));
});

function runDynamicNormalObject() {
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
  sv.setUint8(4, 0x11);            // STB_GLOBAL | STT_OBJECT
  sv.setUint8(5, 0);
  sv.setUint16(6, 1, true);
  sv.setBigUint64(8, 0x40n, true); // a real VA
  sv.setBigUint64(16, 4n, true);
  bytes.set(symtab, 0x80);
  bytes.set(new TextEncoder().encode('\0_plain_counter\0'), 0x98);

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

test('#5843: STT_OBJECT address semantics are unchanged', () => {
  const image = runDynamicNormalObject();
  const sym = image.symbols.find((s) => s.name === '_plain_counter');
  assert.equal(sym.address, 0x40n);
  assert.equal(sym.tlsOffset, undefined);
  const exported = image.exports.find((e) => e.name === '_plain_counter');
  assert.equal(exported.address, 0x40n);
  assert.equal(exported.tlsOffset, undefined);
});
