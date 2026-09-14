import assert from 'node:assert/strict';
import { parsePE } from '../js/binary/pe.js';

function u16(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function u32(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function u64(bytes, offset, value) {
  let n = BigInt(value);
  for (let i = 0; i < 8; i++) {
    bytes[offset + i] = Number(n & 0xffn);
    n >>= 8n;
  }
}

function makePE(pointerToRawData) {
  const bytes = new Uint8Array(0x1200);
  const pe = 0x80;
  const coff = pe + 4;
  const optional = coff + 20;
  const optionalSize = 0xf0;
  const section = optional + optionalSize;

  u16(bytes, 0, 0x5a4d);
  u32(bytes, 0x3c, pe);
  u32(bytes, pe, 0x00004550);
  u16(bytes, coff, 0x8664);
  u16(bytes, coff + 2, 1);
  u16(bytes, coff + 16, optionalSize);
  u16(bytes, optional, 0x20b);
  u64(bytes, optional + 24, 0x140000000n);
  u32(bytes, optional + 32, 0x1000);
  u32(bytes, optional + 36, 0x200);
  u32(bytes, optional + 56, 0x2000);
  u32(bytes, optional + 60, 0x200);
  u16(bytes, optional + 68, 3);
  u32(bytes, optional + 108, 0);

  bytes.set(new TextEncoder().encode('.text\0\0\0'), section);
  u32(bytes, section + 8, 0x200);
  u32(bytes, section + 12, 0x1000);
  u32(bytes, section + 16, 0x200);
  u32(bytes, section + 20, pointerToRawData);
  u32(bytes, section + 36, 0x60000020);

  return bytes;
}

function parse(pointerToRawData) {
  return parsePE(makePE(pointerToRawData));
}

const base = 0x140000000n;
const sectionAddress = base + 0x1000n;

{
  const bytes = makePE(0x820);
  bytes[0x800] = 0x41;
  bytes[0x820] = 0x43;
  const image = parsePE(bytes);
  assert.equal(image.sections[0].fileOffset, 0x800n);
  assert.equal(image.readVirtual(sectionAddress, 1)?.[0], 0x41);
  assert.deepEqual(image.metadata.peSectionRawMappings[0], {
    sectionIndex: 1,
    name: '.text',
    declaredFileOffset: 0x820,
    effectiveFileOffset: 0x800,
    sizeOfRawData: 0x200,
    fileBacked: true,
    roundedDown: true,
    policy: 'windows-image-loader-0x200-round-down',
  });
  assert.ok(image.warnings.some((warning) => warning.includes('0x820') && warning.includes('0x800')));
}

{
  const image = parse(0x9ff);
  assert.equal(image.sections[0].fileOffset, 0x800n);
  assert.equal(image.metadata.peSectionRawMappings[0].effectiveFileOffset, 0x800);
}

{
  const image = parse(0);
  assert.equal(image.sections[0].fileOffset, 0n);
  assert.equal(image.sections[0].fileSize, 0n);
  assert.equal(image.addressToOffset(sectionAddress), null);
  assert.equal(image.readVirtual(sectionAddress, 1)?.[0], 0);
  assert.equal(image.metadata.peSectionRawMappings[0].fileBacked, false);
  assert.equal(image.metadata.peSectionRawMappings[0].roundedDown, false);
}

{
  const image = parse(1);
  assert.equal(image.sections[0].fileOffset, 0n);
  assert.equal(image.sections[0].fileSize, 0x200n);
  assert.equal(image.addressToOffset(sectionAddress), 0n);
  assert.equal(image.metadata.peSectionRawMappings[0].declaredFileOffset, 1);
  assert.equal(image.metadata.peSectionRawMappings[0].effectiveFileOffset, 0);
  assert.equal(image.metadata.peSectionRawMappings[0].fileBacked, true);
  assert.equal(image.metadata.peSectionRawMappings[0].roundedDown, true);
}

{
  const image = parse(0x800);
  assert.equal(image.sections[0].fileOffset, 0x800n);
  assert.equal(image.metadata.peSectionRawMappings[0].declaredFileOffset, 0x800);
  assert.equal(image.metadata.peSectionRawMappings[0].effectiveFileOffset, 0x800);
  assert.equal(image.metadata.peSectionRawMappings[0].roundedDown, false);
}

console.log('issue-2476 PE raw offset rounding regression: ok');
