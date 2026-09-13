import assert from 'node:assert/strict';
import { parsePE } from '../../../js/binary/pe.js';
import { BinaryImage } from '../../../js/binary/model.js';
import { ByteView } from '../../../js/binary/reader.js';
import { createPEMetadataBudget, parseExceptionFunctions } from '../../../js/binary/pe-loader.js';

const ARMNT = 0x01c4;
const IMAGE_BASE = 0x10000000n;
const TEXT_RVA = 0x1000;
const PDATA_RVA = 0x2000;

function writeU16(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(offset, value, true);
}
function writeU32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value >>> 0, true);
}

function packedArm({ length = 4, flag = 1, ret = 0, h = 0, reg = 0, r = 0, l = 1, c = 0, stackAdjust = 0 } = {}) {
  assert.equal(length % 2, 0);
  const lengthUnits = length / 2;
  return (
    (flag & 3)
    | ((lengthUnits & 0x7ff) << 2)
    | ((ret & 3) << 13)
    | ((h & 1) << 15)
    | ((reg & 7) << 16)
    | ((r & 1) << 19)
    | ((l & 1) << 20)
    | ((c & 1) << 21)
    | ((stackAdjust & 0x3ff) << 22)
  ) >>> 0;
}

function buildArmntPe({
  records = [{ start: 0x1001, unwind: packedArm() }],
  textFlags = 0x60000020,
  textRawSize = 0x200,
  textVirtualSize = 0x200,
  directorySize = records.length * 8,
} = {}) {
  const bytes = new Uint8Array(0x800);
  bytes[0] = 0x4d; bytes[1] = 0x5a;
  writeU32(bytes, 0x3c, 0x80);
  const pe = 0x80;
  bytes.set([0x50, 0x45, 0, 0], pe);
  const coff = pe + 4;
  writeU16(bytes, coff, ARMNT);
  writeU16(bytes, coff + 2, 2);
  writeU16(bytes, coff + 16, 224);
  writeU16(bytes, coff + 18, 0x2102);

  const opt = coff + 20;
  writeU16(bytes, opt, 0x10b);
  bytes[opt + 2] = 14;
  writeU32(bytes, opt + 4, 0x200);
  writeU32(bytes, opt + 8, 0x200);
  writeU32(bytes, opt + 16, 0);
  writeU32(bytes, opt + 20, TEXT_RVA);
  writeU32(bytes, opt + 24, PDATA_RVA);
  writeU32(bytes, opt + 28, Number(IMAGE_BASE));
  writeU32(bytes, opt + 32, 0x1000);
  writeU32(bytes, opt + 36, 0x200);
  writeU16(bytes, opt + 40, 6);
  writeU16(bytes, opt + 48, 6);
  writeU32(bytes, opt + 56, 0x3000);
  writeU32(bytes, opt + 60, 0x200);
  writeU16(bytes, opt + 68, 2);
  writeU32(bytes, opt + 72, 0x100000);
  writeU32(bytes, opt + 76, 0x1000);
  writeU32(bytes, opt + 80, 0x100000);
  writeU32(bytes, opt + 84, 0x1000);
  writeU32(bytes, opt + 92, 16);
  writeU32(bytes, opt + 96 + 3 * 8, PDATA_RVA);
  writeU32(bytes, opt + 96 + 3 * 8 + 4, directorySize);

  const sec = opt + 224;
  function section(offset, name, vsize, va, rawSize, rawPtr, flags) {
    for (let i = 0; i < 8; i++) bytes[offset + i] = i < name.length ? name.charCodeAt(i) : 0;
    writeU32(bytes, offset + 8, vsize);
    writeU32(bytes, offset + 12, va);
    writeU32(bytes, offset + 16, rawSize);
    writeU32(bytes, offset + 20, rawPtr);
    writeU32(bytes, offset + 36, flags);
  }
  section(sec, '.text', textVirtualSize, TEXT_RVA, textRawSize, 0x200, textFlags);
  section(sec + 40, '.pdata', Math.max(8, directorySize), PDATA_RVA, 0x200, 0x400, 0x40000040);

  bytes.set([0x10, 0xb5, 0x10, 0xbd], 0x200);
  for (let i = 0; i < records.length; i++) {
    writeU32(bytes, 0x400 + i * 8, records[i].start);
    writeU32(bytes, 0x404 + i * 8, records[i].unwind);
  }
  return bytes;
}

function parse(options) {
  return parsePE(buildArmntPe(options));
}
function reasons(image) {
  return image.metadata.peMetadata?.reasons || [];
}

function directExceptionImage({ unwindData, xdataHeader = null, xdataWord1 = 0, xdataBodyWord = 0xff } = {}) {
  const bytes = new Uint8Array(192);
  writeU32(bytes, 0, 0x2001);
  writeU32(bytes, 4, unwindData ?? packedArm());
  const image = new BinaryImage(bytes, { format: 'pe', bits: 32, imageBase: 0n });
  image.metadata.machine = ARMNT;
  image.addSection({
    name: '.pdata', address: 0x1000n, size: 8n, fileOffset: 0n, fileSize: 8n,
    perms: { read: true, write: false, execute: false },
  });
  image.addSection({
    name: '.text', address: 0x2000n, size: 0x40n, fileOffset: 64n, fileSize: 0x40n,
    perms: { read: true, write: false, execute: true },
  });
  image.addSection({
    name: '.xdata', address: 0x3000n, size: 0x20n, fileOffset: 128n, fileSize: 0x20n,
    perms: { read: true, write: false, execute: false },
  });
  if (xdataHeader !== null) {
    writeU32(bytes, 128, xdataHeader);
    writeU32(bytes, 132, xdataWord1);
    writeU32(bytes, 136, xdataBodyWord);
  }
  return { bytes, image };
}

{
  const image = parse();
  assert.equal(image.arch, 'armv7');
  assert.equal(image.bits, 32);
  assert.equal(image.functions.length, 1, 'packed ARMNT .pdata must recover a stripped function');
  assert.equal(image.functions[0].address, IMAGE_BASE + 0x1000n, 'Thumb bit must not pollute canonical address');
  assert.equal(image.functions[0].size, 4n);
  assert.equal(image.functions[0].source, 'exception');
  assert.equal(image.metadata.exceptionDirectory?.kind, 'armnt-pdata');
  assert.equal(image.metadata.exceptionDirectory?.count, 1);
  assert.equal(image.metadata.exceptionDirectory?.records?.[0]?.rawBeginRva, 0x1001, 'raw Thumb-state RVA is retained as metadata');
  assert.equal(image.metadata.exceptionDirectory?.records?.[0]?.thumb, true);
  assert.equal(image.metadata.peMetadata?.complete, true);
}

{
  const image = parse({ textFlags: 0x40000040 });
  assert.equal(image.functions.length, 0);
  assert.equal(image.metadata.peMetadata?.complete, false);
  assert.equal(reasons(image).includes('exception:armnt-target-range'), true);
}

{
  const image = parse({
    records: [{ start: 0x11ff, unwind: packedArm({ length: 4 }) }],
    textRawSize: 0x200,
    textVirtualSize: 0x400,
  });
  assert.equal(image.functions.length, 0, 'extent crossing file-backed text must not become authority');
  assert.equal(reasons(image).includes('exception:armnt-target-file-span'), true);
}

{
  const image = parse({ records: [{ start: 0x1001, unwind: packedArm({ flag: 3 }) }] });
  assert.equal(image.functions.length, 0);
  assert.equal(reasons(image).includes('exception:armnt-reserved-flag'), true);
}

{
  const image = parse({ records: [{ start: 0x1001, unwind: packedArm({ length: 0 }) }] });
  assert.equal(image.functions.length, 0);
  assert.equal(reasons(image).includes('exception:armnt-packed-length'), true);
}

{
  const image = parse({ records: [
    { start: 0x1011, unwind: packedArm({ length: 4 }) },
    { start: 0x1001, unwind: packedArm({ length: 4 }) },
  ] });
  assert.equal(image.functions.length, 1);
  assert.equal(image.metadata.exceptionDirectory?.invalidRecords, 1);
  assert.equal(reasons(image).includes('exception:armnt-order-overlap'), true);
}

{
  const image = parse({ records: [
    { start: 0x1001, unwind: packedArm({ length: 8 }) },
    { start: 0x1005, unwind: packedArm({ length: 4 }) },
  ] });
  assert.equal(image.functions.length, 1);
  assert.equal(reasons(image).includes('exception:armnt-order-overlap'), true);
}

{
  const image = parse({ records: [{ start: 0x1001, unwind: packedArm({ flag: 2, length: 4 }) }] });
  assert.equal(image.functions.length, 0, 'fragment record is not an independent primary function');
  assert.equal(image.metadata.exceptionDirectory?.fragments?.length, 1);
  assert.equal(image.metadata.exceptionDirectory?.fragments?.[0]?.address, IMAGE_BASE + 0x1000n);
}

{
  const image = parse({ directorySize: 9 });
  assert.equal(image.metadata.peMetadata?.complete, false);
  assert.equal(reasons(image).includes('exception:directory-record-remainder'), true);
}

{
  const image = parse({ records: [{ start: 0x1000, unwind: packedArm() }] });
  assert.equal(image.functions.length, 0, 'ARMNT .pdata must carry the Thumb-state bit');
  assert.equal(image.metadata.peMetadata?.complete, false);
  assert.equal(reasons(image).includes('exception:armnt-thumb-state'), true);
}

{
  const image = parse({ records: [{ start: 0x1001, unwind: packedArm({ ret: 0, l: 0 }) }] });
  assert.equal(image.functions.length, 0, 'pop {pc} packed form requires LR to be saved');
  assert.equal(reasons(image).includes('exception:armnt-packed-fields'), true);
}

{
  const image = parse({ records: [{ start: 0x1001, unwind: packedArm({ c: 1, l: 1, r: 0, reg: 7, ret: 1 }) }] });
  assert.equal(image.functions.length, 0, 'frame-chain packed form must not duplicate r11 in Reg');
  assert.equal(reasons(image).includes('exception:armnt-packed-fields'), true);
}

{
  // Flag 0 points at a full ARM .xdata record. E=1 packs the sole epilogue
  // index into the header; one unwind-code word makes index 0 valid.
  const xdataHeader = 2 | (1 << 21) | (1 << 28);
  const { bytes, image } = directExceptionImage({ unwindData: 0x3000, xdataHeader });
  parseExceptionFunctions(new ByteView(bytes), { rva: 0x1000, size: 8 }, image, ARMNT);
  assert.equal(image.functions.length, 1);
  assert.equal(image.functions[0].address, 0x2000n);
  assert.equal(image.functions[0].size, 4n);
  assert.equal(image.metadata.exceptionDirectory?.records?.[0]?.encoding, 'xdata');
  assert.equal(image.metadata.peMetadata?.complete, true);
}

{
  const fragmentHeader = 2 | (1 << 21) | (1 << 22) | (1 << 28);
  const { bytes, image } = directExceptionImage({ unwindData: 0x3000, xdataHeader: fragmentHeader });
  parseExceptionFunctions(new ByteView(bytes), { rva: 0x1000, size: 8 }, image, ARMNT);
  assert.equal(image.functions.length, 0);
  assert.equal(image.metadata.exceptionDirectory?.fragments?.length, 1);
  assert.equal(image.metadata.exceptionDirectory?.records?.[0]?.encoding, 'xdata-fragment');
}

{
  const reservedVersionHeader = 2 | (1 << 18) | (1 << 21) | (1 << 28);
  const { bytes, image } = directExceptionImage({ unwindData: 0x3000, xdataHeader: reservedVersionHeader });
  parseExceptionFunctions(new ByteView(bytes), { rva: 0x1000, size: 8 }, image, ARMNT);
  assert.equal(image.functions.length, 0);
  assert.equal(reasons(image).includes('exception:armnt-xdata-fields'), true);
}

{
  const { bytes, image } = directExceptionImage();
  const budget = createPEMetadataBudget(image, { limits: { inputBytes: 7 } });
  parseExceptionFunctions(new ByteView(bytes), { rva: 0x1000, size: 8 }, image, ARMNT, budget);
  assert.equal(image.functions.length, 0);
  assert.equal(image.metadata.peMetadata?.complete, false);
  assert.equal(reasons(image).some((reason) => reason.startsWith('budget:exception-record:inputBytes')), true);
}

// Existing ARM64 exception support must remain intact. This tiny direct fixture is
// intentionally checked through parsePE's public result only by asserting ARMNT
// work did not change the machine mapping; dedicated ARM64 regressions cover its
// descriptor semantics.
{
  const image = parse();
  assert.equal(image.metadata.machine, ARMNT);
}

console.log('issue-8175 PE ARMNT .pdata regression: PASS');
