import assert from 'node:assert/strict';
import { ByteView } from '../js/binary/reader.js';
import { parseExceptionFunctions } from '../js/binary/pe-loader-core.js';

const IMAGE_BASE = 0x180000000n;
const SECTION_RVA = 0x1000;
const FILE_OFFSET = 0x100;
const PDATA_RVA = 0x1040;
const XDATA_RVA = 0x1080;
const BEGIN_RVA = 0x1100;

function writeU32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value >>> 0, true);
}

function makeImage(fileSize) {
  const section = {
    index: 1,
    address: IMAGE_BASE + BigInt(SECTION_RVA),
    size: 0x1000n,
    fileOffset: BigInt(FILE_OFFSET),
    fileSize: BigInt(fileSize),
    perms: { read: true, write: false, execute: true },
  };
  return {
    imageBase: IMAGE_BASE,
    bits: 64,
    sections: [section],
    segments: [],
    metadata: {},
    warnings: [],
    functions: [],
    imports: [],
    exports: [],
    relocations: [],
    libraries: [],
    sectionAt(address) {
      const a = BigInt(address);
      return a >= section.address && a < section.address + section.size ? section : null;
    },
  };
}

function runArm64Xdata({ header, xdataAvailable }) {
  const fileSize = (XDATA_RVA - SECTION_RVA) + xdataAvailable;
  const bytes = new Uint8Array(FILE_OFFSET + fileSize);
  const at = (rva) => FILE_OFFSET + (rva - SECTION_RVA);
  writeU32(bytes, at(PDATA_RVA), BEGIN_RVA);
  writeU32(bytes, at(PDATA_RVA) + 4, XDATA_RVA);
  writeU32(bytes, at(XDATA_RVA), header);
  const image = makeImage(fileSize);
  parseExceptionFunctions(new ByteView(bytes), { rva: PDATA_RVA, size: 8 }, image, 0xaa64);
  return image;
}

// Microsoft ARM64 .xdata: bits 22..26 are Epilog Count. Bit 22 is therefore
// Epilog Count=1, not an independent fragment flag. A valid record must create
// the primary function and must not be converted into fragment metadata.
{
  const image = runArm64Xdata({
    header: 4 | (1 << 22), // Function Length=4 instructions, Epilog Count=1.
    xdataAvailable: 8,     // 4-byte header + one 4-byte epilog scope.
  });
  assert.equal(image.functions.length, 1);
  assert.equal(image.functions[0].address, IMAGE_BASE + BigInt(BEGIN_RVA));
  assert.equal(image.functions[0].size, 16n);
  assert.deepEqual(image.metadata.exceptionDirectory.fragments, []);
  assert.equal(image.metadata.exceptionDirectory.invalidRecords, 0);
}

// Bit 31 is the high bit of the 5-bit Code Words field (bits 27..31), so this
// header declares 16 unwind-code words. A mapping that only holds 8 words must
// be rejected as truncated; the old 4-bit decode incorrectly accepted it.
{
  const image = runArm64Xdata({
    header: (4 | 0x80000000) >>> 0,
    xdataAvailable: 4 + 8 * 4,
  });
  assert.equal(image.functions.length, 0);
  assert.equal(image.metadata.exceptionDirectory.invalidRecords, 1);
  assert.ok(image.metadata.peMetadata.reasons.includes('exception:arm64-xdata-span'));
}

// The same bit-31 header is valid when the full 16-word span is mapped.
{
  const image = runArm64Xdata({
    header: (4 | 0x80000000) >>> 0,
    xdataAvailable: 4 + 16 * 4,
  });
  assert.equal(image.functions.length, 1);
  assert.equal(image.functions[0].size, 16n);
  assert.equal(image.metadata.exceptionDirectory.invalidRecords, 0);
}

console.log('ARM64 .xdata header field layout regression: PASS');
