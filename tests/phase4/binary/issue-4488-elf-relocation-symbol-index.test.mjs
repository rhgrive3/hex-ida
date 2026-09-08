import assert from 'node:assert/strict';
import { parseELF } from '../../../js/binary/elf.js';

const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_RELA = 4;
const SHT_REL = 9;

function buildRelocatable({ bits, symIndex, named = true, symbolType = 2, symbolSizeExtra = 0 }) {
  const is64 = bits === 64;
  const sectionCount = 6;
  const sectionHeaderOffset = 0x200;
  const sectionHeaderSize = is64 ? 64 : 40;
  const textOffset = 0x70;
  const stringOffset = 0x60;
  const symbolOffset = 0x90;
  const symbolEntrySize = is64 ? 24 : 16;
  const symbolSize = symbolEntrySize * 2 + symbolSizeExtra;
  const relocationOffset = is64 ? 0xd0 : 0xb0;
  const relocationEntrySize = is64 ? 24 : 8;
  const relocationSize = relocationEntrySize;
  const sectionNames = ['', '.strtab', '.symtab', '.text', is64 ? '.rela.text' : '.rel.text', '.shstrtab'];
  const sectionNameOffsets = [];
  const shstrBytes = [];
  for (const name of sectionNames) {
    sectionNameOffsets.push(shstrBytes.length);
    shstrBytes.push(...new TextEncoder().encode(`${name}\0`));
  }
  const shstrOffset = is64 ? 0xf0 : 0xc0;
  const bytes = new Uint8Array(sectionHeaderOffset + sectionCount * sectionHeaderSize);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, is64 ? 2 : 1, 1, 1, 0], 0);
  view.setUint16(16, 1, true); // ET_REL
  view.setUint16(18, is64 ? 62 : 3, true); // x86-64 / i386
  view.setUint32(20, 1, true);
  if (is64) {
    view.setBigUint64(40, BigInt(sectionHeaderOffset), true);
    view.setUint16(52, 64, true);
    view.setUint16(54, 56, true);
    view.setUint16(56, 0, true);
    view.setUint16(58, sectionHeaderSize, true);
    view.setUint16(60, sectionCount, true);
    view.setUint16(62, 5, true);
  } else {
    view.setUint32(32, sectionHeaderOffset, true);
    view.setUint16(40, 52, true);
    view.setUint16(42, 32, true);
    view.setUint16(44, 0, true);
    view.setUint16(46, sectionHeaderSize, true);
    view.setUint16(48, sectionCount, true);
    view.setUint16(50, 5, true);
  }

  const strtab = new TextEncoder().encode(named ? '\0named\0' : '\0');
  bytes.set(strtab, stringOffset);
  bytes.fill(0x90, textOffset, textOffset + 16);
  const symbolView = new DataView(bytes.buffer, symbolOffset, symbolSize);
  const symbolNameOffset = named ? 1 : 0;
  const symbolInfo = (1 << 4) | symbolType; // global, caller-selected type
  const symbolEntry = symbolEntrySize;
  if (is64) {
    symbolView.setUint32(symbolEntry, symbolNameOffset, true);
    symbolView.setUint8(symbolEntry + 4, symbolInfo);
    symbolView.setUint8(symbolEntry + 5, 0);
    symbolView.setUint16(symbolEntry + 6, 3, true); // .text
    symbolView.setBigUint64(symbolEntry + 8, 0n, true);
    symbolView.setBigUint64(symbolEntry + 16, 4n, true);
    view.setBigUint64(relocationOffset, 0n, true);
    view.setBigUint64(relocationOffset + 8, (BigInt(symIndex) << 32n) | 1n, true);
    view.setBigInt64(relocationOffset + 16, 0n, true);
  } else {
    symbolView.setUint32(symbolEntry, symbolNameOffset, true);
    symbolView.setUint32(symbolEntry + 4, 0, true);
    symbolView.setUint32(symbolEntry + 8, 4, true);
    symbolView.setUint8(symbolEntry + 12, symbolInfo);
    symbolView.setUint8(symbolEntry + 13, 0);
    symbolView.setUint16(symbolEntry + 14, 3, true); // .text
    view.setUint32(relocationOffset, 0, true);
    view.setUint32(relocationOffset + 4, (symIndex << 8) | 1, true);
  }
  bytes.set(shstrBytes, shstrOffset);

  const writeSection = (index, { name, type, flags = 0n, addr = 0n, offset = 0n, size = 0n, link = 0, info = 0, align = 0n, entsize = 0n }) => {
    const p = sectionHeaderOffset + index * sectionHeaderSize;
    if (is64) {
      view.setUint32(p, sectionNameOffsets[sectionNames.indexOf(name)], true);
      view.setUint32(p + 4, type, true);
      view.setBigUint64(p + 8, flags, true);
      view.setBigUint64(p + 16, addr, true);
      view.setBigUint64(p + 24, offset, true);
      view.setBigUint64(p + 32, size, true);
      view.setUint32(p + 40, link, true);
      view.setUint32(p + 44, info, true);
      view.setBigUint64(p + 48, align, true);
      view.setBigUint64(p + 56, entsize, true);
    } else {
      view.setUint32(p, sectionNameOffsets[sectionNames.indexOf(name)], true);
      view.setUint32(p + 4, type, true);
      view.setUint32(p + 8, Number(flags), true);
      view.setUint32(p + 12, Number(addr), true);
      view.setUint32(p + 16, Number(offset), true);
      view.setUint32(p + 20, Number(size), true);
      view.setUint32(p + 24, link, true);
      view.setUint32(p + 28, info, true);
      view.setUint32(p + 32, Number(align), true);
      view.setUint32(p + 36, Number(entsize), true);
    }
  };
  writeSection(0, { name: '', type: 0 });
  writeSection(1, { name: '.strtab', type: SHT_STRTAB, offset: BigInt(stringOffset), size: BigInt(strtab.length), align: 1n });
  writeSection(2, { name: '.symtab', type: SHT_SYMTAB, offset: BigInt(symbolOffset), size: BigInt(symbolSize), link: 1, info: 1, align: is64 ? 8n : 4n, entsize: BigInt(symbolEntrySize) });
  writeSection(3, { name: '.text', type: SHT_PROGBITS, flags: 0x6n, offset: BigInt(textOffset), size: 16n, align: is64 ? 16n : 4n });
  writeSection(4, { name: is64 ? '.rela.text' : '.rel.text', type: is64 ? SHT_RELA : SHT_REL, offset: BigInt(relocationOffset), size: BigInt(relocationSize), link: 2, info: 3, align: is64 ? 8n : 4n, entsize: BigInt(relocationEntrySize) });
  writeSection(5, { name: '.shstrtab', type: SHT_STRTAB, offset: BigInt(shstrOffset), size: BigInt(shstrBytes.length), align: 1n });
  return bytes;
}

function parse(options) {
  return parseELF(buildRelocatable(options));
}

{
  const image = parse({ bits: 64, symIndex: 0 });
  assert.equal(image.metadata.elfMetadata.complete, true);
  assert.equal(image.relocations.length, 1);
  assert.equal(image.relocations[0].symbol, null);
  assert.equal(image.relocations[0].symbolIndex, 0);
}

{
  const image = parse({ bits: 64, symIndex: 1 });
  assert.equal(image.metadata.elfMetadata.complete, true);
  assert.equal(image.relocations.length, 1);
  assert.equal(image.relocations[0].symbol, 'named');
  assert.equal(image.relocations[0].symbolIndex, 1);
}

{
  const image = parse({ bits: 64, symIndex: 1, named: false, symbolType: 3 });
  assert.equal(image.metadata.elfMetadata.complete, true, 'an unnamed but declared symbol entry remains valid');
  assert.equal(image.relocations.length, 1);
  assert.equal(image.relocations[0].symbol, null);
  assert.equal(image.relocations[0].symbolIndex, 1);
}

{
  const image = parse({ bits: 64, symIndex: 2 });
  assert.equal(image.metadata.elfMetadata.complete, false);
  assert.ok(image.metadata.elfMetadata.reasons.includes('relocations:4:symbol-index-range'));
  assert.equal(image.relocations.length, 0, 'out-of-range symbol references do not become canonical relocations');
}

{
  const image = parse({ bits: 64, symIndex: 2, symbolSizeExtra: 1 });
  assert.equal(image.metadata.elfMetadata.complete, false);
  assert.ok(image.metadata.elfMetadata.reasons.includes('relocations:4:symbol-table-span'));
  assert.equal(image.relocations.length, 0, 'a malformed symbol-table span must not publish a nonzero relocation');
}

{
  const image = parse({ bits: 32, symIndex: 1 });
  assert.equal(image.metadata.elfMetadata.complete, true);
  assert.equal(image.relocations.length, 1);
  assert.equal(image.relocations[0].symbol, 'named');
  assert.equal(image.relocations[0].symbolIndex, 1);
}

{
  const image = parse({ bits: 32, symIndex: 2 });
  assert.equal(image.metadata.elfMetadata.complete, false);
  assert.ok(image.metadata.elfMetadata.reasons.includes('relocations:4:symbol-index-range'));
  assert.equal(image.relocations.length, 0);
}

console.log('issue-4488 ELF relocation symbol-index range regression: PASS');
