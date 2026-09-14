import assert from 'node:assert/strict';
import { parseELF } from '../../../js/binary/elf.js';

const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_RELA = 4;

// ET_REL x86-64: relocation import sites must attach to the import record of
// the symbol the relocation actually references (tableIndex + symbolIndex),
// never to the first same-name import (#5682).

const sectionCount = 6;
const sectionHeaderOffset = 0x200;
const stringOffset = 0x60;
const textOffset = 0x70;
const symbolOffset = 0x90;
const symbolEntrySize = 24;
const shstrOffset = 0x100;
const relocationOffset = 0xe0;
const relocationEntrySize = 24;

const sectionNames = ['', '.strtab', '.symtab', '.text', '.rela.text', '.shstrtab'];
const sectionNameOffsets = [];
const shstrBytes = [];
for (const name of sectionNames) {
  sectionNameOffsets.push(shstrBytes.length);
  shstrBytes.push(...new TextEncoder().encode(`${name}\0`));
}

function buildImage({ symbols, relocSymbolIndex }) {
  const symbolSize = symbolEntrySize * (1 + symbols.length);
  const bytes = new Uint8Array(sectionHeaderOffset + sectionCount * 64);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  view.setUint16(16, 1, true); // ET_REL
  view.setUint16(18, 62, true); // x86-64
  view.setUint32(20, 1, true);
  view.setBigUint64(40, BigInt(sectionHeaderOffset), true);
  view.setUint16(52, 64, true);
  view.setUint16(54, 56, true);
  view.setUint16(58, 64, true);
  view.setUint16(60, sectionCount, true);
  view.setUint16(62, 5, true);

  bytes.set(new TextEncoder().encode('\0foo\0'), stringOffset);
  bytes.fill(0x90, textOffset, textOffset + 16);
  const symbolView = new DataView(bytes.buffer, symbolOffset, symbolSize);
  symbols.forEach(({ bind }, i) => {
    const p = symbolEntrySize * (i + 1);
    symbolView.setUint32(p, 1, true); // name 'foo'
    symbolView.setUint8(p + 4, (bind << 4) | 2); // function, caller-selected binding
    symbolView.setUint16(p + 6, 0, true); // SHN_UNDEF
  });
  view.setBigUint64(relocationOffset, 0n, true);
  view.setBigUint64(relocationOffset + 8, (BigInt(relocSymbolIndex) << 32n) | 1n, true);
  view.setBigInt64(relocationOffset + 16, 0n, true);
  bytes.set(shstrBytes, shstrOffset);

  const writeSection = (index, { name, type, flags = 0n, offset = 0n, size = 0n, link = 0, info = 0, align = 0n, entsize = 0n }) => {
    const p = sectionHeaderOffset + index * 64;
    view.setUint32(p, sectionNameOffsets[sectionNames.indexOf(name)], true);
    view.setUint32(p + 4, type, true);
    view.setBigUint64(p + 8, flags, true);
    view.setBigUint64(p + 24, offset, true);
    view.setBigUint64(p + 32, size, true);
    view.setUint32(p + 40, link, true);
    view.setUint32(p + 44, info, true);
    view.setBigUint64(p + 48, align, true);
    view.setBigUint64(p + 56, entsize, true);
  };
  writeSection(0, { name: '', type: 0 });
  writeSection(1, { name: '.strtab', type: SHT_STRTAB, offset: BigInt(stringOffset), size: 5n, align: 1n });
  writeSection(2, { name: '.symtab', type: SHT_SYMTAB, offset: BigInt(symbolOffset), size: BigInt(symbolSize), link: 1, info: 1, align: 8n, entsize: 24n });
  writeSection(3, { name: '.text', type: SHT_PROGBITS, flags: 0x6n, offset: BigInt(textOffset), size: 16n, align: 16n });
  writeSection(4, { name: '.rela.text', type: SHT_RELA, offset: BigInt(relocationOffset), size: BigInt(relocationEntrySize), link: 2, info: 3, align: 8n, entsize: 24n });
  writeSection(5, { name: '.shstrtab', type: SHT_STRTAB, offset: BigInt(shstrOffset), size: BigInt(shstrBytes.length), align: 1n });
  return parseELF(bytes);
}

// Discriminating case: WEAK foo (index 1) + GLOBAL foo (index 2); the
// relocation references the GLOBAL entry. Both records survive import
// dedupe (the weak flag differs), so the site's owner is observable.
{
  const image = buildImage({ symbols: [{ bind: 2 }, { bind: 1 }], relocSymbolIndex: 2 });
  assert.equal(image.metadata.elfMetadata.complete, true);
  assert.equal(image.imports.length, 2, 'weak and global foo stay distinct import records');
  assert.equal(image.relocations.length, 1);
  assert.equal(image.relocations[0].symbolIndex, 2);
  assert.equal(image.relocations[0].symbol, 'foo');

  const globalImport = image.imports.find((x) => x.weak === false);
  const weakImport = image.imports.find((x) => x.weak === true);
  assert.equal(globalImport.sites.length, 1, 'the site belongs to the referenced GLOBAL symbol');
  assert.equal(weakImport.sites.length, 0, 'the weak same-name import must not absorb the site');
}

// Site-preservation control: two identical GLOBAL undefined foo entries; the
// model dedupes them into one import record and the relocation site survives.
{
  const image = buildImage({ symbols: [{ bind: 1 }, { bind: 1 }], relocSymbolIndex: 2 });
  assert.equal(image.metadata.elfMetadata.complete, true);
  assert.equal(image.imports.length, 1, 'identical same-name imports dedupe');
  assert.equal(image.imports[0].sites.length, 1, 'the relocation site is preserved through dedupe');
}

console.log('issue-5682 ELF relocation import-site identity regression: PASS');
