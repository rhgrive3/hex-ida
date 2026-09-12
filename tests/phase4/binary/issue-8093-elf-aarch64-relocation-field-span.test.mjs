import assert from 'node:assert/strict';
import { parseELF } from '../../../js/binary/elf.js';
import { relocationFieldWidth } from '../../../js/binary/elf-relocation-target.js';
import { makeSectionlessElf64Fixture } from '../../universal-binary-sectionless.mjs';

const EM_AARCH64 = 183;
const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_RELA = 4;

function buildElf({
  elfType = 1,
  relocationType = 257,
  relocationOffset = 0n,
  targetSize = 8n,
  symbolIndex = 1,
} = {}) {
  const loaded = elfType !== 1;
  const sectionCount = 6;
  const sectionHeaderOffset = 0x300;
  const sectionHeaderSize = 64;
  const programHeaderOffset = 0x40;
  const stringOffset = 0x100;
  const textOffset = 0x120;
  const symbolOffset = 0x150;
  const symbolEntrySize = 24;
  const relocationTableOffset = 0x1a0;
  const shstrOffset = 0x1d0;
  const loadAddress = 0x400000n;
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
  view.setUint16(16, elfType, true);
  view.setUint16(18, EM_AARCH64, true);
  view.setUint32(20, 1, true);
  if (loaded) {
    view.setBigUint64(32, BigInt(programHeaderOffset), true);
    view.setUint16(54, 56, true);
    view.setUint16(56, 1, true);
    const p = programHeaderOffset;
    view.setUint32(p, 1, true); // PT_LOAD
    view.setUint32(p + 4, 6, true); // PF_R | PF_W
    view.setBigUint64(p + 8, BigInt(textOffset), true);
    view.setBigUint64(p + 16, loadAddress, true);
    view.setBigUint64(p + 24, loadAddress, true);
    view.setBigUint64(p + 32, targetSize, true);
    view.setBigUint64(p + 40, targetSize, true);
    view.setBigUint64(p + 48, 1n, true);
  }
  view.setBigUint64(40, BigInt(sectionHeaderOffset), true);
  view.setUint16(52, 64, true);
  if (!loaded) view.setUint16(54, 56, true);
  view.setUint16(58, sectionHeaderSize, true);
  view.setUint16(60, sectionCount, true);
  view.setUint16(62, 5, true);

  bytes.set(new TextEncoder().encode('\0ext\0'), stringOffset);
  bytes.fill(0, textOffset, textOffset + Number(targetSize));

  const symbolEntry = symbolOffset + symbolEntrySize;
  view.setUint32(symbolEntry, 1, true);
  view.setUint8(symbolEntry + 4, 0x11);
  view.setUint16(symbolEntry + 6, 0); // undefined global object

  const storedOffset = loaded ? loadAddress + relocationOffset : relocationOffset;
  view.setBigUint64(relocationTableOffset, storedOffset, true);
  view.setBigUint64(
    relocationTableOffset + 8,
    (BigInt(symbolIndex) << 32n) | BigInt(relocationType >>> 0),
    true,
  );
  view.setBigInt64(relocationTableOffset + 16, 0n, true);
  bytes.set(shstrBytes, shstrOffset);

  const writeSection = (index, { name, type, flags = 0n, address = 0n, offset = 0n, size = 0n, link = 0, info = 0, align = 0n, entsize = 0n }) => {
    const p = sectionHeaderOffset + index * sectionHeaderSize;
    view.setUint32(p, sectionNameOffsets[sectionNames.indexOf(name)], true);
    view.setUint32(p + 4, type, true);
    view.setBigUint64(p + 8, flags, true);
    view.setBigUint64(p + 16, address, true);
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
  writeSection(3, { name: '.text', type: SHT_PROGBITS, flags: 0x3n, address: loaded ? loadAddress : 0n, offset: BigInt(textOffset), size: targetSize, align: 1n });
  writeSection(4, { name: '.rela.text', type: SHT_RELA, offset: BigInt(relocationTableOffset), size: 24n, link: 2, info: 3, align: 8n, entsize: 24n });
  writeSection(5, { name: '.shstrtab', type: SHT_STRTAB, offset: BigInt(shstrOffset), size: BigInt(shstrBytes.length), align: 1n });
  return bytes;
}

function parse(options) {
  return parseELF(buildElf(options));
}

function assertAccepted(options) {
  const image = parse(options);
  assert.equal(image.metadata.elfMetadata.complete, true);
  assert.equal(image.relocations.length, 1);
  return image;
}

function assertRejected(options, reason) {
  const image = parse(options);
  assert.equal(image.metadata.elfMetadata.complete, false);
  assert.ok(image.metadata.elfMetadata.reasons.includes(reason), `${reason}: ${image.metadata.elfMetadata.reasons.join(', ')}`);
  assert.equal(image.relocations.length, 0);
  return image;
}

// AAELF64 storage-width authority: data, instruction, null, dynamic, and reserved.
for (const [type, width] of [
  [0, 0n], [256, 0n],
  [257, 8n], [258, 4n], [260, 8n], [261, 4n],
  [282, 4n], [283, 4n],
  [1027, 8n],
]) {
  assert.equal(relocationFieldWidth(EM_AARCH64, type, 64), width, `AArch64 relocation ${type}`);
}
assert.equal(relocationFieldWidth(EM_AARCH64, 0xffffffff, 64), null);
assert.equal(relocationFieldWidth(EM_AARCH64, 1, 32), undefined, 'P32 code space is not claimed by the ELF64 width table');


function parseDynamicRelocation({ type = 1027, address = 0x4004f8n, symbolIndex = 0 } = {}) {
  const bytes = makeSectionlessElf64Fixture();
  const view = new DataView(bytes.buffer);
  view.setUint16(18, EM_AARCH64, true);
  view.setBigUint64(0x3a0, address, true);
  view.setBigUint64(0x3a8, (BigInt(symbolIndex) << 32n) | BigInt(type >>> 0), true);
  return parseELF(bytes);
}

function assertDynamicAccepted(options) {
  const image = parseDynamicRelocation(options);
  assert.equal(image.metadata.programDynamicPartial, undefined);
  assert.equal(image.relocations.length, 1);
  return image;
}

function assertDynamicRejected(options, warningNeedle) {
  const image = parseDynamicRelocation(options);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.equal(image.relocations.length, 0);
  assert.ok(image.warnings.some((warning) => warning.includes(warningNeedle)), image.warnings.join('\n'));
  return image;
}

// ET_REL: full field span, not merely r_offset, is authoritative.
for (const [type, width] of [[257, 8n], [258, 4n], [260, 8n], [261, 4n], [282, 4n], [283, 4n]]) {
  assertAccepted({ relocationType: type, targetSize: width, relocationOffset: 0n });
  assertRejected({ relocationType: type, targetSize: width, relocationOffset: 1n }, 'relocations:4:target-span');
}

// AArch64 NONE has no target storage and is accepted at an in-range location.
assertAccepted({ relocationType: 256, targetSize: 1n, relocationOffset: 0n, symbolIndex: 0 });

// A recognized-machine reserved/unsupported type must not publish canonical evidence.
assertRejected({ relocationType: 0xffffffff, targetSize: 16n }, 'relocations:4:field-width-unknown');

// Loaded section-backed relocations use the same width authority. RELATIVE is an
// 8-byte dynamic data location and must fit wholly in the owning PT_LOAD.
assertAccepted({ elfType: 3, relocationType: 1027, targetSize: 8n, relocationOffset: 0n, symbolIndex: 0 });
assertRejected({ elfType: 3, relocationType: 1027, targetSize: 8n, relocationOffset: 1n, symbolIndex: 0 }, 'relocations:4:target-span');
assertRejected({ elfType: 3, relocationType: 0xffffffff, targetSize: 16n, relocationOffset: 0n, symbolIndex: 0 }, 'relocations:4:field-width-unknown');


// PT_DYNAMIC uses the same field-width authority. The fixture's PT_LOAD is
// [0x400000,0x400500), so RELATIVE fits exactly at 0x4004f8 but crosses at
// 0x4004fc. This covers the sectionless dynamic-relocation consumer too.
assertDynamicAccepted({ type: 1027, address: 0x4004f8n });
assertDynamicRejected({ type: 1027, address: 0x4004fcn }, 'target field crosses');
assertDynamicRejected({ type: 0xffffffff, address: 0x4004f0n }, 'no supported target-field width');

// TLSDESC is a contiguous pair of pointer-sized values in AAELF64: the full
// 16-byte descriptor must fit, not only its first 8-byte word.
assertDynamicAccepted({ type: 1031, address: 0x4004f0n });
assertDynamicRejected({ type: 1031, address: 0x4004f8n }, 'target field crosses');

console.log('issue-8093 AArch64 ELF relocation field-span regression: PASS');
