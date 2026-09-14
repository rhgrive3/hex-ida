import assert from 'node:assert/strict';
import test from 'node:test';

import { ByteView } from '../../../js/binary/reader.js';
import { parseELF } from '../../../js/binary/elf.js';
import { parseProgramDynamic } from '../../../js/binary/elf-dynamic.js';

const ET_REL = 1;
const ET_EXEC = 2;
const ET_DYN = 3;
const EM_X86_64 = 62;
const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHF_ALLOC = 0x2n;
const SHF_WRITE = 0x1n;
const SHN_UNDEF = 0;
const SHN_ABS = 0xfff1;
const SHN_COMMON = 0xfff2;

function buildElf({ type, section, value, size = 32n, symbolType = 1 }) {
  const symbolName = new TextEncoder().encode('\0common_obj\0');
  const sectionNames = new TextEncoder().encode('\0.data\0.symtab\0.strtab\0.shstrtab\0');
  const dataOffset = 0x40;
  const symbolOffset = 0x80;
  const stringOffset = 0xb0;
  const sectionStringOffset = 0xc0;
  const sectionHeaderOffset = 0x100;
  const bytes = new Uint8Array(sectionHeaderOffset + 5 * 64);
  const view = new DataView(bytes.buffer);

  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  view.setUint16(16, type, true);
  view.setUint16(18, EM_X86_64, true);
  view.setUint32(20, 1, true);
  view.setBigUint64(40, BigInt(sectionHeaderOffset), true);
  view.setUint16(52, 64, true);
  view.setUint16(58, 64, true);
  view.setUint16(60, 5, true);
  view.setUint16(62, 4, true);

  bytes.set(new Uint8Array(0x40), dataOffset);
  const symbol = symbolOffset + 24;
  view.setUint32(symbol, 1, true);
  view.setUint8(symbol + 4, (1 << 4) | symbolType);
  view.setUint8(symbol + 5, 0);
  view.setUint16(symbol + 6, section, true);
  view.setBigUint64(symbol + 8, value, true);
  view.setBigUint64(symbol + 16, size, true);
  bytes.set(symbolName, stringOffset);
  bytes.set(sectionNames, sectionStringOffset);

  const sectionHeader = (index, name, sectionType, flags, address, offset, sectionSize, link, info, align, entsize) => {
    const position = sectionHeaderOffset + index * 64;
    view.setUint32(position, name, true);
    view.setUint32(position + 4, sectionType, true);
    view.setBigUint64(position + 8, flags, true);
    view.setBigUint64(position + 16, address, true);
    view.setBigUint64(position + 24, offset, true);
    view.setBigUint64(position + 32, sectionSize, true);
    view.setUint32(position + 40, link, true);
    view.setUint32(position + 44, info, true);
    view.setBigUint64(position + 48, align, true);
    view.setBigUint64(position + 56, entsize, true);
  };
  sectionHeader(0, 0, 0, 0n, 0n, 0n, 0n, 0, 0, 0n, 0n);
  sectionHeader(1, 1, SHT_PROGBITS, SHF_ALLOC | SHF_WRITE, 0x4000n, BigInt(dataOffset), 0x40n, 0, 0, 8n, 0n);
  sectionHeader(2, 8, SHT_SYMTAB, 0n, 0n, BigInt(symbolOffset), 48n, 3, 1, 8n, 24n);
  sectionHeader(3, 16, SHT_STRTAB, 0n, 0n, BigInt(stringOffset), BigInt(symbolName.length), 0, 0, 1n, 0n);
  sectionHeader(4, 24, SHT_STRTAB, 0n, 0n, BigInt(sectionStringOffset), BigInt(sectionNames.length), 0, 0, 1n, 0n);
  return bytes;
}

function symbol(image) {
  return image.symbols.find((entry) => entry.name === 'common_obj');
}

function buildDynamicCommonImage() {
  const base = 0x400000n;
  const bytes = new Uint8Array(0x200);
  const view = new DataView(bytes.buffer);
  const dynamic = [
    [6n, base + 0x80n],
    [5n, base + 0x98n],
    [10n, 0x20n],
    [11n, 24n],
    [0n, 0n],
  ];
  for (const [index, [tag, value]] of dynamic.entries()) {
    view.setBigInt64(index * 16, tag, true);
    view.setBigUint64(index * 16 + 8, value, true);
  }
  const symbolOffset = 0x80;
  view.setUint32(symbolOffset, 1, true);
  view.setUint8(symbolOffset + 4, (1 << 4) | 1);
  view.setUint16(symbolOffset + 6, SHN_COMMON, true);
  view.setBigUint64(symbolOffset + 8, 16n, true);
  view.setBigUint64(symbolOffset + 16, 32n, true);
  bytes.set(new TextEncoder().encode('\0common_obj\0'), 0x98);
  const segment = {
    address: base,
    size: BigInt(bytes.length),
    fileOffset: 0n,
    fileSize: BigInt(bytes.length),
    perms: { read: true },
  };
  const image = {
    bits: 64,
    imageBase: base,
    metadata: { machine: EM_X86_64 },
    warnings: [],
    libraries: [],
    imports: [],
    exports: [],
    symbols: [],
    relocations: [],
    functions: [],
    sections: [],
    segments: [segment],
    addressToOffset(address) {
      const delta = BigInt(address) - base;
      return delta >= 0n && delta < BigInt(bytes.length) ? delta : null;
    },
    sectionAt() { return null; },
    segmentAt(address) {
      const candidate = BigInt(address);
      return candidate >= segment.address && candidate < segment.address + segment.size ? segment : null;
    },
  };
  parseProgramDynamic(new ByteView(bytes), [{ type: 2, offset: 0n, filesz: BigInt(dynamic.length * 16) }], image, 64);
  return image;
}

for (const type of [ET_REL, ET_DYN, ET_EXEC]) {
  test(`#4358 ET_${type === ET_REL ? 'REL' : type === ET_DYN ? 'DYN' : 'EXEC'} does not turn SHN_COMMON alignment into a VA`, () => {
    const image = parseELF(buildElf({ type, section: SHN_COMMON, value: 16n }));
    const entry = symbol(image);
    assert.ok(entry);
    assert.equal(entry.defined, true);
    assert.equal(entry.sectionIndex, SHN_COMMON);
    assert.equal(entry.address, 0n);
    assert.equal(entry.commonAlignment, 16n);
    assert.equal(entry.commonSize, 32n);
    assert.equal(entry.addressDomain, 'common-unallocated');
    assert.equal(entry.allocation, 'common-unallocated');
    assert.equal(image.exports.some((exported) => exported.name === 'common_obj'), false);
    assert.equal(image.functions.some((seed) => seed.name === 'common_obj'), false);
  });
}

test('#4358 SHN_ABS and normal ET_DYN section symbols retain address semantics', () => {
  const absolute = parseELF(buildElf({ type: ET_DYN, section: SHN_ABS, value: 0x1234n }));
  assert.equal(symbol(absolute).address, 0x1234n);
  assert.equal(absolute.exports.find((entry) => entry.name === 'common_obj')?.address, 0x1234n);

  const normal = parseELF(buildElf({ type: ET_DYN, section: 1, value: 0x4010n }));
  assert.equal(symbol(normal).address, 0x4010n);
  assert.equal(normal.exports.find((entry) => entry.name === 'common_obj')?.address, 0x4010n);
});

test('#4358 SHN_UNDEF keeps import semantics and does not use malformed st_value as a VA', () => {
  const image = parseELF(buildElf({ type: ET_DYN, section: SHN_UNDEF, value: 0x777n }));
  const entry = symbol(image);
  assert.equal(entry.defined, false);
  assert.equal(entry.address, 0n);
  assert.equal(image.exports.some((exported) => exported.name === 'common_obj'), false);
  assert.equal(image.imports.find((entry) => entry.name === 'common_obj')?.weak, false);
});

test('#4358 PT_DYNAMIC SHN_COMMON keeps alignment out of the export address domain', () => {
  const image = buildDynamicCommonImage();
  const entry = symbol(image);
  assert.ok(entry);
  assert.equal(entry.address, 0n);
  assert.equal(entry.commonAlignment, 16n);
  assert.equal(entry.commonSize, 32n);
  assert.equal(entry.addressDomain, 'common-unallocated');
  assert.equal(image.exports.some((exported) => exported.name === 'common_obj'), false);
});
