import assert from 'node:assert/strict';
import test from 'node:test';

import { parseELF } from '../../../js/binary/elf.js';
import { parseELFSource } from '../../../js/binary/source-loaders.js';

const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;
const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_SYMTAB_SHNDX = 18;

function setU16(bytes, offset, value) {
  new DataView(bytes.buffer).setUint16(offset, value, true);
}

function setU32(bytes, offset, value) {
  new DataView(bytes.buffer).setUint32(offset, value, true);
}

function setU64(bytes, offset, value) {
  new DataView(bytes.buffer).setBigUint64(offset, BigInt(value), true);
}

function setAscii(bytes, offset, value) {
  for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
}

function buildElf({ bits = 64, xindexEntsize = 4, xindexSize = 8, resolved = 1 } = {}) {
  const is64 = bits === 64;
  const sectionHeaderOffset = is64 ? 0x200 : 0x180;
  const sectionHeaderSize = is64 ? 64 : 40;
  const bytes = new Uint8Array(sectionHeaderOffset + sectionHeaderSize * 5);
  const data = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, is64 ? 2 : 1, 1, 1, 0], 0);

  setU16(bytes, 16, 2); // ET_EXEC
  setU16(bytes, 18, is64 ? 62 : 3); // x86_64 / i386
  setU32(bytes, 20, 1);
  if (is64) {
    setU64(bytes, 24, 0);
    setU64(bytes, 32, 0x40);
    setU64(bytes, 40, sectionHeaderOffset);
    setU32(bytes, 48, 0);
    setU16(bytes, 52, 64);
    setU16(bytes, 54, 56);
    setU16(bytes, 56, 1);
    setU16(bytes, 58, sectionHeaderSize);
    setU16(bytes, 60, 5);
    setU16(bytes, 62, 0);
    setU32(bytes, 0x40, 1); // PT_LOAD
    setU32(bytes, 0x44, 5); // PF_R | PF_X
    setU64(bytes, 0x48, 0x80);
    setU64(bytes, 0x50, 0x400000);
    setU64(bytes, 0x58, 0x400000);
    setU64(bytes, 0x60, 4);
    setU64(bytes, 0x68, 4);
    setU64(bytes, 0x70, 0x1000);
  } else {
    setU32(bytes, 24, 0);
    setU32(bytes, 28, 52);
    setU32(bytes, 32, sectionHeaderOffset);
    setU32(bytes, 36, 0);
    setU16(bytes, 40, 52);
    setU16(bytes, 42, 32);
    setU16(bytes, 44, 1);
    setU16(bytes, 46, sectionHeaderSize);
    setU16(bytes, 48, 5);
    setU16(bytes, 50, 0);
    setU32(bytes, 0x34, 1); // PT_LOAD
    setU32(bytes, 0x38, 0x80);
    setU32(bytes, 0x3c, 0x400000);
    setU32(bytes, 0x40, 0x400000);
    setU32(bytes, 0x44, 4);
    setU32(bytes, 0x48, 4);
    setU32(bytes, 0x4c, 5); // PF_R | PF_X
    setU32(bytes, 0x50, 0x1000);
  }

  const section = (index, { type = 0, flags = 0, address = 0, offset = 0, size = 0, link = 0, info = 0, align = 1, entsize = 0 } = {}) => {
    const position = sectionHeaderOffset + index * sectionHeaderSize;
    setU32(bytes, position + 4, type);
    if (is64) {
      setU64(bytes, position + 8, flags);
      setU64(bytes, position + 16, address);
      setU64(bytes, position + 24, offset);
      setU64(bytes, position + 32, size);
      setU32(bytes, position + 40, link);
      setU32(bytes, position + 44, info);
      setU64(bytes, position + 48, align);
      setU64(bytes, position + 56, entsize);
    } else {
      setU32(bytes, position + 8, flags);
      setU32(bytes, position + 12, address);
      setU32(bytes, position + 16, offset);
      setU32(bytes, position + 20, size);
      setU32(bytes, position + 24, link);
      setU32(bytes, position + 28, info);
      setU32(bytes, position + 32, align);
      setU32(bytes, position + 36, entsize);
    }
  };

  const executableSectionOffset = 0x80;
  const stringTableOffset = 0x90;
  const symbolTableOffset = 0xa0;
  const symbolEntrySize = is64 ? 24 : 16;
  const symbolTableSize = symbolEntrySize * 2;
  const xindexOffset = symbolTableOffset + symbolTableSize;
  section(1, {
    type: SHT_PROGBITS,
    flags: SHF_ALLOC | SHF_EXECINSTR,
    address: 0x400000,
    offset: executableSectionOffset,
    size: 4,
    align: 4,
  });
  bytes.set([0, 0, 0, 0], executableSectionOffset);
  section(2, { type: SHT_STRTAB, offset: stringTableOffset, size: 5, align: 1 });
  bytes.set([0, 0x66, 0x6f, 0x6f, 0], stringTableOffset);
  section(3, {
    type: SHT_SYMTAB,
    offset: symbolTableOffset,
    size: symbolTableSize,
    link: 2,
    info: 1,
    align: is64 ? 8 : 4,
    entsize: symbolEntrySize,
  });

  const symbol = symbolTableOffset + symbolEntrySize;
  setU32(bytes, symbol, 1);
  if (is64) {
    bytes[symbol + 4] = 0x12; // STB_GLOBAL | STT_FUNC
    setU16(bytes, symbol + 6, 0xffff); // SHN_XINDEX
    setU64(bytes, symbol + 8, 0x400000);
    setU64(bytes, symbol + 16, 4);
  } else {
    setU32(bytes, symbol + 4, 0x400000);
    setU32(bytes, symbol + 8, 4);
    bytes[symbol + 12] = 0x12; // STB_GLOBAL | STT_FUNC
    setU16(bytes, symbol + 14, 0xffff); // SHN_XINDEX
  }

  section(4, {
    type: SHT_SYMTAB_SHNDX,
    offset: xindexOffset,
    size: xindexSize,
    link: 3,
    align: 4,
    entsize: xindexEntsize,
  });
  if (xindexSize >= 4) data.setUint32(xindexOffset, 0, true);
  if (xindexSize >= 8) data.setUint32(xindexOffset + 4, resolved, true);
  return bytes;
}

function symbolNamedFoo(image) {
  const symbol = image.symbols.find((entry) => entry.name === 'foo');
  assert.ok(symbol, 'fixture must contain foo');
  return symbol;
}

function assertResolved(image, label) {
  const symbol = symbolNamedFoo(image);
  assert.equal(symbol.defined, true, `${label}: SHN_XINDEX should resolve`);
  assert.equal(symbol.sectionIndex, 1, `${label}: resolved section index`);
  assert.ok(image.functions.some((entry) => entry.name === 'foo'), `${label}: function seed should exist`);
  assert.ok(image.exports.some((entry) => entry.name === 'foo'), `${label}: export should exist`);
  assert.equal(image.metadata.elfMetadata.complete, true, `${label}: valid table remains complete`);
}

function assertUnresolved(image, label) {
  const symbol = symbolNamedFoo(image);
  assert.equal(symbol.defined, null, `${label}: malformed SHN_XINDEX must remain unknown`);
  assert.equal(symbol.sectionIndex, null, `${label}: malformed table must not provide section identity`);
  assert.equal(image.functions.some((entry) => entry.name === 'foo'), false, `${label}: malformed table must not create a function seed`);
  assert.equal(image.exports.some((entry) => entry.name === 'foo'), false, `${label}: malformed table must not create an export`);
  assert.equal(image.metadata.elfMetadata.complete, false, `${label}: malformed table is partial`);
  assert.ok(image.metadata.elfMetadata.reasons.includes('symbols:3:xindex-malformed'), `${label}: partial reason is recorded`);
}

test('#4472 accepts only four-byte SHT_SYMTAB_SHNDX entries for resident ELF32 and ELF64 parsing', () => {
  for (const bits of [32, 64]) {
    assertResolved(parseELF(buildElf({ bits, xindexEntsize: 4 })), `ELF${bits}`);
    for (const xindexEntsize of [0, 8]) {
      assertUnresolved(parseELF(buildElf({ bits, xindexEntsize, resolved: 1 })), `ELF${bits} entsize=${xindexEntsize}`);
    }
  }
});

test('#4472 does not resolve a symbol when the valid-width companion table is too short', () => {
  assertUnresolved(parseELF(buildElf({ xindexEntsize: 4, xindexSize: 4, resolved: 1 })), 'short SHT_SYMTAB_SHNDX');
});

test('#4472 applies the same malformed-table boundary to source-backed ELF parsing', async () => {
  for (const bits of [32, 64]) {
    assertResolved(await parseELFSource(buildElf({ bits, xindexEntsize: 4 })), `source ELF${bits}`);
    assertUnresolved(await parseELFSource(buildElf({ bits, xindexEntsize: 0, resolved: 1 })), `source ELF${bits} entsize=0`);
  }
});

console.log('issue-4472 ELF SHT_SYMTAB_SHNDX entsize: ok');
