import assert from 'node:assert/strict';
import test from 'node:test';

import { parseELF } from '../../../js/binary/elf.js';

const ET_REL = 1;
const EM_X86_64 = 62;
const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_SYMTAB_SHNDX = 18;
const SHF_ALLOC = 0x2n;
const SHF_EXECINSTR = 0x4n;
const SHN_ABS = 0xfff1;
const SHN_COMMON = 0xfff2;
const SHN_XINDEX = 0xffff;
const SECTION_COUNT = 0x10000;
const SECTION_HEADER_OFFSET = 0x40;
const SECTION_HEADER_SIZE = 64;
const DIRECT_EXECUTABLE_SECTION = 1;
const LARGE_EXECUTABLE_SECTION = 0xff00;
const COLLIDING_EXECUTABLE_SECTION = 0xfff1;
const LAST_EXECUTABLE_SECTION = SECTION_COUNT - 1;

function buildLargeSectionIndexELF() {
  const names = ['', 'direct', 'large', 'collision', 'last', 'out-of-range', 'absolute', 'common'];
  const nameOffsets = new Map();
  let stringSize = 0;
  for (const name of names) {
    nameOffsets.set(name, stringSize);
    stringSize += name.length + 1;
  }
  const strings = new Uint8Array(stringSize);
  for (const name of names) {
    for (let i = 0; i < name.length; i++) strings[nameOffsets.get(name) + i] = name.charCodeAt(i);
  }

  const symbols = [
    { name: 'direct', type: 2, section: DIRECT_EXECUTABLE_SECTION, value: 0n, xindex: 0 },
    { name: 'large', type: 2, section: SHN_XINDEX, value: 0n, xindex: LARGE_EXECUTABLE_SECTION },
    { name: 'collision', type: 2, section: SHN_XINDEX, value: 0n, xindex: COLLIDING_EXECUTABLE_SECTION },
    { name: 'last', type: 2, section: SHN_XINDEX, value: 0n, xindex: LAST_EXECUTABLE_SECTION },
    { name: 'out-of-range', type: 2, section: SHN_XINDEX, value: 0n, xindex: SECTION_COUNT },
    { name: 'absolute', type: 1, section: SHN_ABS, value: 0x1234n, xindex: 0 },
    { name: 'common', type: 1, section: SHN_COMMON, value: 0x20n, xindex: 0 },
  ];

  const dataOffset = SECTION_HEADER_OFFSET + SECTION_COUNT * SECTION_HEADER_SIZE;
  const codeOffset = dataOffset;
  const stringOffset = codeOffset + 0x10;
  const symbolOffset = stringOffset + strings.length;
  const xindexOffset = symbolOffset + (symbols.length + 1) * 24;
  const bytes = new Uint8Array(xindexOffset + (symbols.length + 1) * 4);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);

  view.setUint16(16, ET_REL, true);
  view.setUint16(18, EM_X86_64, true);
  view.setUint32(20, 1, true);
  view.setBigUint64(40, BigInt(SECTION_HEADER_OFFSET), true);
  view.setUint16(52, 64, true);
  view.setUint16(58, SECTION_HEADER_SIZE, true);
  view.setUint16(60, 0, true); // extended section count is in section 0
  view.setUint16(62, 0, true); // no section-name table is needed

  const section = (index, {
    type = 0,
    flags = 0n,
    offset = 0n,
    size = 0n,
    link = 0,
    info = 0,
    align = 1n,
    entsize = 0n,
  } = {}) => {
    const p = SECTION_HEADER_OFFSET + index * SECTION_HEADER_SIZE;
    view.setUint32(p + 4, type, true);
    view.setBigUint64(p + 8, flags, true);
    view.setBigUint64(p + 24, offset, true);
    view.setBigUint64(p + 32, size, true);
    view.setUint32(p + 40, link, true);
    view.setUint32(p + 44, info, true);
    view.setBigUint64(p + 48, align, true);
    view.setBigUint64(p + 56, entsize, true);
  };

  section(0, { size: BigInt(SECTION_COUNT) });
  for (const index of [DIRECT_EXECUTABLE_SECTION, LARGE_EXECUTABLE_SECTION, COLLIDING_EXECUTABLE_SECTION, LAST_EXECUTABLE_SECTION]) {
    section(index, {
      type: SHT_PROGBITS,
      flags: SHF_ALLOC | SHF_EXECINSTR,
      offset: BigInt(codeOffset),
      size: 0x10n,
      align: 1n,
    });
  }
  section(2, { type: SHT_STRTAB, offset: BigInt(stringOffset), size: BigInt(strings.length) });
  section(3, {
    type: SHT_SYMTAB,
    offset: BigInt(symbolOffset),
    size: BigInt((symbols.length + 1) * 24),
    link: 2,
    info: 1,
    align: 8n,
    entsize: 24n,
  });
  section(4, {
    type: SHT_SYMTAB_SHNDX,
    offset: BigInt(xindexOffset),
    size: BigInt((symbols.length + 1) * 4),
    link: 3,
    align: 4n,
    entsize: 4n,
  });

  bytes.set(strings, stringOffset);
  const symbol = (index, value) => {
    const p = symbolOffset + index * 24;
    view.setUint32(p, nameOffsets.get(value.name), true);
    view.setUint8(p + 4, (1 << 4) | value.type); // global binding
    view.setUint16(p + 6, value.section, true);
    view.setBigUint64(p + 8, value.value, true);
    view.setBigUint64(p + 16, 4n, true);
    view.setUint32(xindexOffset + index * 4, value.xindex, true);
  };
  for (let index = 0; index < symbols.length; index++) symbol(index + 1, symbols[index]);
  return bytes;
}

test('#4475 extended section indices resolve actual sections above SHN_LORESERVE', () => {
  const image = parseELF(buildLargeSectionIndexELF());
  const byName = new Map(image.symbols.map((symbol) => [symbol.name, symbol]));

  assert.equal(image.sections.length, SECTION_COUNT);
  assert.equal(byName.get('direct').sectionIndex, DIRECT_EXECUTABLE_SECTION);
  assert.equal(byName.get('direct').defined, true);

  for (const [name, sectionIndex] of [
    ['large', LARGE_EXECUTABLE_SECTION],
    ['collision', COLLIDING_EXECUTABLE_SECTION],
    ['last', LAST_EXECUTABLE_SECTION],
  ]) {
    const symbol = byName.get(name);
    assert.equal(symbol.defined, true, name);
    assert.equal(symbol.sectionIndex, sectionIndex, name);
    assert.deepEqual(symbol.sectionRelative, { sectionIndex, offset: 0n }, name);
    assert.ok(image.functions.some((seed) => seed.name === name), `${name} must seed a function`);
  }

  const outOfRange = byName.get('out-of-range');
  assert.equal(outOfRange.defined, null);
  assert.equal(outOfRange.sectionIndex, null);
  assert.equal(image.functions.some((seed) => seed.name === 'out-of-range'), false);
  assert.ok(image.warnings.some((warning) => warning.includes('out-of-range extended section index')));
});

test('#4475 direct SHN_ABS and SHN_COMMON retain their special semantics', () => {
  const image = parseELF(buildLargeSectionIndexELF());
  const byName = new Map(image.symbols.map((symbol) => [symbol.name, symbol]));
  const absolute = byName.get('absolute');
  const common = byName.get('common');

  assert.equal(absolute.defined, true);
  assert.equal(absolute.sectionIndex, SHN_ABS);
  assert.equal(absolute.address, 0x1234n);
  assert.equal(common.defined, true);
  assert.equal(common.sectionIndex, SHN_COMMON);
  assert.equal(common.address, 0n);
});
