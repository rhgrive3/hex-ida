import assert from 'node:assert/strict';
import { parseELF } from '../../../js/binary/elf.js';

const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_RELA = 4;
const SHT_NOBITS = 8;

function buildRelocatable({
  relocationType = 2,
  relocationOffset = 0n,
  targetSize = 7n,
  targetType = SHT_PROGBITS,
  symbolIndex = 1,
} = {}) {
  const sectionCount = 6;
  const sectionHeaderOffset = 0x200;
  const sectionHeaderSize = 64;
  const stringOffset = 0x60;
  const textOffset = 0x70;
  const symbolOffset = 0x90;
  const symbolEntrySize = 24;
  const relocationTableOffset = 0xd0;
  const relocationEntrySize = 24;
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
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  view.setUint16(16, 1, true); // ET_REL
  view.setUint16(18, 62, true); // EM_X86_64
  view.setUint32(20, 1, true);
  view.setBigUint64(40, BigInt(sectionHeaderOffset), true);
  view.setUint16(52, 64, true);
  view.setUint16(54, 56, true);
  view.setUint16(58, sectionHeaderSize, true);
  view.setUint16(60, sectionCount, true);
  view.setUint16(62, 5, true);

  bytes.set(new TextEncoder().encode('\0ext\0'), stringOffset);
  if (targetType !== SHT_NOBITS) bytes.fill(0x90, textOffset, textOffset + Number(targetSize));

  // Symbol 1: undefined global object named "ext". This makes accepted
  // relocations observable both in image.relocations and import.sites.
  const symbolEntry = symbolOffset + symbolEntrySize;
  view.setUint32(symbolEntry, 1, true);
  view.setUint8(symbolEntry + 4, 0x11);
  view.setUint16(symbolEntry + 6, 0, true); // SHN_UNDEF

  view.setBigUint64(relocationTableOffset, relocationOffset, true);
  view.setBigUint64(
    relocationTableOffset + 8,
    (BigInt(symbolIndex) << 32n) | BigInt(relocationType >>> 0),
    true,
  );
  view.setBigInt64(relocationTableOffset + 16, 0n, true);
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
  writeSection(2, { name: '.symtab', type: SHT_SYMTAB, offset: BigInt(symbolOffset), size: 48n, link: 1, info: 1, align: 8n, entsize: 24n });
  writeSection(3, { name: '.text', type: targetType, flags: 0x6n, offset: BigInt(textOffset), size: targetSize, align: 1n });
  writeSection(4, { name: '.rela.text', type: SHT_RELA, offset: BigInt(relocationTableOffset), size: 24n, link: 2, info: 3, align: 8n, entsize: 24n });
  writeSection(5, { name: '.shstrtab', type: SHT_STRTAB, offset: BigInt(shstrOffset), size: BigInt(shstrBytes.length), align: 1n });
  return bytes;
}

function parse(options) {
  return parseELF(buildRelocatable(options));
}

function assertAccepted(options, { fileBacked = true } = {}) {
  const image = parse(options);
  assert.equal(image.metadata.elfMetadata.complete, true);
  assert.equal(image.relocations.length, 1);
  assert.equal(image.imports.length, 1);
  assert.equal(image.imports[0].sites.length, 1);
  if (!fileBacked) assert.equal(image.relocations[0].fileOffset, null);
  return image;
}

function assertSpanRejected(options) {
  const image = parse(options);
  assert.equal(image.metadata.elfMetadata.complete, false);
  assert.ok(image.metadata.elfMetadata.reasons.includes('relocations:4:target-span'));
  assert.equal(image.relocations.length, 0);
  assert.equal(image.imports.length, 1);
  assert.equal(image.imports[0].sites.length, 0, 'rejected relocation must not become import-site evidence');
  return image;
}

// R_X86_64_PC32 stores a 4-byte word. [3,7) is exact-fit; later starts cross.
assertAccepted({ relocationType: 2, relocationOffset: 3n, targetSize: 7n });
for (const relocationOffset of [4n, 5n, 6n]) {
  assertSpanRejected({ relocationType: 2, relocationOffset, targetSize: 7n });
}

// Representative 8-, 2-, and 1-byte x86-64 relocation fields.
assertAccepted({ relocationType: 1, relocationOffset: 0n, targetSize: 8n }); // R_X86_64_64
assertSpanRejected({ relocationType: 1, relocationOffset: 0n, targetSize: 7n });
assertAccepted({ relocationType: 12, relocationOffset: 5n, targetSize: 7n }); // R_X86_64_16
assertSpanRejected({ relocationType: 12, relocationOffset: 6n, targetSize: 7n });
assertAccepted({ relocationType: 14, relocationOffset: 6n, targetSize: 7n }); // R_X86_64_8

// Wider TLS descriptors and linker-relaxation relocation fields keep their
// psABI storage semantics at the section boundary.
assertAccepted({ relocationType: 36, relocationOffset: 0n, targetSize: 16n }); // R_X86_64_TLSDESC
assertSpanRejected({ relocationType: 36, relocationOffset: 0n, targetSize: 15n });
for (const relocationType of [41, 42]) { // GOTPCRELX / REX_GOTPCRELX
  assertAccepted({ relocationType, relocationOffset: 3n, targetSize: 7n });
  assertSpanRejected({ relocationType, relocationOffset: 4n, targetSize: 7n });
}

// R_X86_64_NONE has no storage field; do not fabricate a byte width for it.
{
  const image = parse({ relocationType: 0, relocationOffset: 6n, targetSize: 7n, symbolIndex: 0 });
  assert.equal(image.metadata.elfMetadata.complete, true);
  assert.equal(image.relocations.length, 1);
  assert.ok(!image.metadata.elfMetadata.reasons.includes('relocations:4:target-span'));
}

// NOBITS has no file backing, but its logical sh_size still bounds relocation storage.
assertAccepted(
  { relocationType: 2, relocationOffset: 3n, targetSize: 7n, targetType: SHT_NOBITS },
  { fileBacked: false },
);
assertSpanRejected({ relocationType: 2, relocationOffset: 4n, targetSize: 7n, targetType: SHT_NOBITS });

// Within a machine table we claim to understand, an unsupported relocation type
// must not silently become canonical evidence with an unproved target width.
for (const relocationType of [39, 40, 0xffff]) {
  const image = parse({ relocationType, relocationOffset: 0n, targetSize: 16n });
  assert.equal(image.metadata.elfMetadata.complete, false);
  assert.ok(image.metadata.elfMetadata.reasons.includes('relocations:4:field-width-unknown'));
  assert.equal(image.relocations.length, 0);
  assert.equal(image.imports[0].sites.length, 0);
}

// Preserve the existing start-out-of-range diagnostic rather than replacing it
// with the new full-span diagnostic.
{
  const image = parse({ relocationType: 2, relocationOffset: 7n, targetSize: 7n });
  assert.equal(image.metadata.elfMetadata.complete, false);
  assert.ok(image.metadata.elfMetadata.reasons.includes('relocations:4:offset-range'));
  assert.ok(!image.metadata.elfMetadata.reasons.includes('relocations:4:target-span'));
  assert.equal(image.relocations.length, 0);
}

console.log('issue-8093 ELF ET_REL relocation field-span regression: PASS');
