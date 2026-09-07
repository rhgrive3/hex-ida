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

function makePE({ pointerToRawData = 0x800, sizeOfRawData = 0x201, virtualSize = 0x600, fileAlignment = 0x200, sectionAlignment = 0x1000, length = 0x1400 } = {}) {
  const bytes = new Uint8Array(length);
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
  u32(bytes, optional + 32, sectionAlignment);
  u32(bytes, optional + 36, fileAlignment);
  u32(bytes, optional + 56, 0x3000);
  u32(bytes, optional + 60, 0x200);
  u16(bytes, optional + 68, 3);
  u32(bytes, optional + 108, 0);

  bytes.set(new TextEncoder().encode('.text\0\0\0'), section);
  u32(bytes, section + 8, virtualSize);
  u32(bytes, section + 12, 0x1000);
  u32(bytes, section + 16, sizeOfRawData);
  u32(bytes, section + 20, pointerToRawData);
  u32(bytes, section + 36, 0x60000020);
  return bytes;
}

const base = 0x140000000n;
const sectionAddress = base + 0x1000n;

{
  const bytes = makePE({ sizeOfRawData: 0x201 });
  bytes[0xb00] = 0x5a;
  const image = parsePE(bytes);
  assert.equal(image.sections[0].fileSize, 0x400n);
  assert.equal(image.addressToOffset(sectionAddress + 0x300n), 0xb00n);
  assert.equal(image.readVirtual(sectionAddress + 0x300n, 1)?.[0], 0x5a);
  assert.deepEqual(image.metadata.peSectionRawSizes[0], {
    sectionIndex: 1,
    name: '.text',
    declaredRawSize: 0x201,
    effectiveRawSize: 0x400,
    fileAlignment: 0x200,
    alignmentValid: true,
    roundedUp: true,
    clippedToFile: false,
    clippedToVirtual: false,
    policy: 'windows-image-loader-file-alignment-round-up',
  });
}

{
  const image = parsePE(makePE({ sizeOfRawData: 0x3ff }));
  assert.equal(image.sections[0].fileSize, 0x400n);
  assert.equal(image.metadata.peSectionRawSizes[0].effectiveRawSize, 0x400);
}

{
  const image = parsePE(makePE({ sizeOfRawData: 0x400 }));
  assert.equal(image.sections[0].fileSize, 0x400n);
  assert.equal(image.metadata.peSectionRawSizes[0].roundedUp, false);
}

{
  const image = parsePE(makePE({ pointerToRawData: 0x1000, sizeOfRawData: 0x201, length: 0x1200 }));
  assert.equal(image.sections[0].fileSize, 0x200n);
  assert.equal(image.metadata.peSectionRawSizes[0].clippedToFile, true);
  assert.ok(image.warnings.some((warning) => warning.includes('raw mapping is truncated')));
}

{
  const image = parsePE(makePE({ sizeOfRawData: 0x201, virtualSize: 0x300 }));
  assert.equal(image.sections[0].fileSize, 0x300n);
  assert.equal(image.metadata.peSectionRawSizes[0].effectiveRawSize, 0x400);
  assert.equal(image.metadata.peSectionRawSizes[0].clippedToVirtual, true);
  assert.equal(image.addressToOffset(sectionAddress + 0x300n), null);
}

{
  const bytes = makePE({ pointerToRawData: 0x820, sizeOfRawData: 0x201 });
  bytes[0xb00] = 0x71;
  const image = parsePE(bytes);
  assert.equal(image.sections[0].fileOffset, 0x800n);
  assert.equal(image.sections[0].fileSize, 0x400n);
  assert.equal(image.readVirtual(sectionAddress + 0x300n, 1)?.[0], 0x71);
}

{
  const image = parsePE(makePE({ sizeOfRawData: 0x201, fileAlignment: 0x180 }));
  assert.equal(image.sections[0].fileSize, 0x201n);
  assert.equal(image.metadata.peSectionRawSizes[0].alignmentValid, false);
  assert.equal(image.metadata.peSectionRawSizes[0].effectiveRawSize, 0x201);
  assert.ok(image.warnings.some((warning) => warning.includes('invalid FileAlignment')));
}

console.log('issue-2477 PE raw size rounding regression: ok');
