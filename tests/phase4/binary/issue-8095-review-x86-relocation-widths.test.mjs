import assert from 'node:assert/strict';
import { parseELF } from '../../../js/binary/elf.js';

const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_RELA = 4;

function buildRelocatable({ bits = 64, relocationType, relocationOffset, targetSize = 7n }) {
  const is64 = bits === 64;
  const sectionCount = 6;
  const sectionHeaderOffset = 0x200;
  const sectionHeaderSize = is64 ? 64 : 40;
  const stringOffset = 0x60;
  const textOffset = 0x70;
  const symbolOffset = 0x90;
  const symbolEntrySize = is64 ? 24 : 16;
  const relocationTableOffset = 0xd0;
  const relocationEntrySize = is64 ? 24 : 12;
  const shstrOffset = 0xf0;
  const sectionNames = ['', '.strtab', '.symtab', '.text', '.rela.text', '.shstrtab'];
  const sectionNameOffsets = [];
  const shstrBytes = [];
  for (const name of sectionNames) {
    sectionNameOffsets.push(shstrBytes.length);
    shstrBytes.push(...new TextEncoder().encode(`${name}\0`));
  }

  const bytes = new Uint8Array(sectionHeaderOffset + sectionCount * sectionHeaderSize);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, is64 ? 2 : 1, 1, 1, 0], 0);
  view.setUint16(16, 1, true); // ET_REL
  view.setUint16(18, 62, true); // EM_X86_64
  view.setUint32(20, 1, true);
  if (is64) {
    view.setBigUint64(40, BigInt(sectionHeaderOffset), true);
    view.setUint16(52, 64, true);
    view.setUint16(54, 56, true);
    view.setUint16(58, sectionHeaderSize, true);
    view.setUint16(60, sectionCount, true);
    view.setUint16(62, 5, true);
  } else {
    view.setUint32(32, sectionHeaderOffset, true);
    view.setUint16(40, 52, true);
    view.setUint16(42, 32, true);
    view.setUint16(46, sectionHeaderSize, true);
    view.setUint16(48, sectionCount, true);
    view.setUint16(50, 5, true);
  }

  bytes.set(new TextEncoder().encode('\0ext\0'), stringOffset);
  bytes.fill(0x90, textOffset, textOffset + Number(targetSize));

  // Symbol 1 is an undefined global object so accepted relocations also
  // become observable import-site evidence.
  const symbolEntry = symbolOffset + symbolEntrySize;
  view.setUint32(symbolEntry, 1, true);
  if (is64) {
    view.setUint8(symbolEntry + 4, 0x11);
    view.setUint16(symbolEntry + 6, 0, true);
    view.setBigUint64(relocationTableOffset, relocationOffset, true);
    view.setBigUint64(
      relocationTableOffset + 8,
      (1n << 32n) | BigInt(relocationType >>> 0),
      true,
    );
    view.setBigInt64(relocationTableOffset + 16, 0n, true);
  } else {
    view.setUint8(symbolEntry + 12, 0x11);
    view.setUint16(symbolEntry + 14, 0, true);
    view.setUint32(relocationTableOffset, Number(relocationOffset), true);
    view.setUint32(relocationTableOffset + 4, (1 << 8) | relocationType, true);
    view.setInt32(relocationTableOffset + 8, 0, true);
  }
  bytes.set(shstrBytes, shstrOffset);

  const writeSection = (index, {
    name,
    type,
    flags = 0n,
    offset = 0n,
    size = 0n,
    link = 0,
    info = 0,
    align = 0n,
    entsize = 0n,
  }) => {
    const p = sectionHeaderOffset + index * sectionHeaderSize;
    view.setUint32(p, sectionNameOffsets[sectionNames.indexOf(name)], true);
    view.setUint32(p + 4, type, true);
    if (is64) {
      view.setBigUint64(p + 8, flags, true);
      view.setBigUint64(p + 24, offset, true);
      view.setBigUint64(p + 32, size, true);
      view.setUint32(p + 40, link, true);
      view.setUint32(p + 44, info, true);
      view.setBigUint64(p + 48, align, true);
      view.setBigUint64(p + 56, entsize, true);
    } else {
      view.setUint32(p + 8, Number(flags), true);
      view.setUint32(p + 16, Number(offset), true);
      view.setUint32(p + 20, Number(size), true);
      view.setUint32(p + 24, link, true);
      view.setUint32(p + 28, info, true);
      view.setUint32(p + 32, Number(align), true);
      view.setUint32(p + 36, Number(entsize), true);
    }
  };

  writeSection(0, { name: '', type: 0 });
  writeSection(1, { name: '.strtab', type: SHT_STRTAB, offset: BigInt(stringOffset), size: 5n, align: 1n });
  writeSection(2, {
    name: '.symtab', type: SHT_SYMTAB, offset: BigInt(symbolOffset), size: BigInt(symbolEntrySize * 2),
    link: 1, info: 1, align: BigInt(is64 ? 8 : 4), entsize: BigInt(symbolEntrySize),
  });
  writeSection(3, { name: '.text', type: SHT_PROGBITS, flags: 0x6n, offset: BigInt(textOffset), size: targetSize, align: 1n });
  writeSection(4, {
    name: '.rela.text', type: SHT_RELA, offset: BigInt(relocationTableOffset), size: BigInt(relocationEntrySize),
    link: 2, info: 3, align: BigInt(is64 ? 8 : 4), entsize: BigInt(relocationEntrySize),
  });
  writeSection(5, { name: '.shstrtab', type: SHT_STRTAB, offset: BigInt(shstrOffset), size: BigInt(shstrBytes.length), align: 1n });
  return bytes;
}

function parse(options) {
  return parseELF(buildRelocatable(options));
}

function assertAccepted(options) {
  const image = parse(options);
  assert.equal(image.metadata.elfMetadata.complete, true);
  assert.equal(image.relocations.length, 1);
  assert.equal(image.imports.length, 1);
  assert.equal(image.imports[0].sites.length, 1);
}

function assertSpanRejected(options) {
  const image = parse(options);
  assert.equal(image.metadata.elfMetadata.complete, false);
  assert.ok(image.metadata.elfMetadata.reasons.includes('relocations:4:target-span'));
  assert.equal(image.relocations.length, 0);
  assert.equal(image.imports[0].sites.length, 0);
}

// Current APX CODE_4/CODE_5/CODE_6 relocation families are all word32.
for (const relocationType of [43, 44, 45, 46, 47, 48, 49, 50, 51]) {
  assertAccepted({ bits: 64, relocationType, relocationOffset: 3n, targetSize: 7n });
  assertSpanRejected({ bits: 64, relocationType, relocationOffset: 4n, targetSize: 7n });
}

// psABI `wordclass` is 4 bytes for x86-64 ILP32/ELFCLASS32 and 8 bytes for LP64.
for (const relocationType of [6, 7, 8, 37]) {
  assertAccepted({ bits: 32, relocationType, relocationOffset: 3n, targetSize: 7n });
  assertSpanRejected({ bits: 32, relocationType, relocationOffset: 4n, targetSize: 7n });
}
assertAccepted({ bits: 64, relocationType: 6, relocationOffset: 0n, targetSize: 8n });
assertSpanRejected({ bits: 64, relocationType: 6, relocationOffset: 0n, targetSize: 7n });

console.log('issue-8095 review: x86 relocation width authority regression: PASS');
