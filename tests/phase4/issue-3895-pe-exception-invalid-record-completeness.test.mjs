import assert from 'node:assert/strict';
import { BinaryImage } from '../../js/binary/model.js';
import { ByteView } from '../../js/binary/reader.js';
import { parseExceptionFunctions } from '../../js/binary/pe-loader.js';

const INVALID_REASON = 'exception:invalid-record';

function writeU32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
}

function addPdata(image, size) {
  image.addSegment({
    name: '.pdata',
    address: 0x1000n,
    size: BigInt(size),
    fileOffset: 0n,
    fileSize: BigInt(size),
    perms: { read: true, write: false, execute: false },
  });
}

function addText(image, size = 0x100) {
  image.addSection({
    name: '.text',
    address: 0x2000n,
    size: BigInt(size),
    fileOffset: 64n,
    fileSize: BigInt(Math.min(size, 64)),
    perms: { read: true, write: false, execute: true },
  });
}

function reasons(image) {
  return image.metadata.peMetadata?.reasons || [];
}

{
  const bytes = new Uint8Array(64);
  writeU32(bytes, 0, 0x2000);
  writeU32(bytes, 4, 0x1ff0);
  writeU32(bytes, 8, 0x3000);
  const image = new BinaryImage(bytes, { format: 'pe', bits: 64, imageBase: 0n });
  addPdata(image, 12);
  addText(image);

  parseExceptionFunctions(new ByteView(bytes), { rva: 0x1000, size: 12 }, image, 0x8664);

  assert.equal(image.metadata.exceptionDirectory?.invalidRecords, 1);
  assert.equal(image.metadata.peMetadata?.complete, false);
  assert.equal(reasons(image).includes(INVALID_REASON), true);
  assert.equal(image.functions.length, 0);
}

{
  const bytes = new Uint8Array(192);
  writeU32(bytes, 0, 0x2000);
  writeU32(bytes, 4, 0x2010);
  writeU32(bytes, 8, 0x3000);
  writeU32(bytes, 12, 0x2008);
  writeU32(bytes, 16, 0x2018);
  writeU32(bytes, 20, 0x3000);
  bytes[128] = 0x01;
  const image = new BinaryImage(bytes, { format: 'pe', bits: 64, imageBase: 0n });
  addPdata(image, 24);
  addText(image);
  image.addSegment({
    name: '.xdata',
    address: 0x3000n,
    size: 4n,
    fileOffset: 128n,
    fileSize: 4n,
    perms: { read: true, write: false, execute: false },
  });

  parseExceptionFunctions(new ByteView(bytes), { rva: 0x1000, size: 24 }, image, 0x8664);

  assert.equal(image.metadata.exceptionDirectory?.count, 1);
  assert.equal(image.metadata.exceptionDirectory?.invalidRecords, 1);
  assert.equal(image.metadata.peMetadata?.complete, false);
  assert.equal(reasons(image).includes(INVALID_REASON), true);
  assert.equal(image.functions.length, 1);
}

for (const machine of [0xaa64, 0xa641]) {
  const bytes = new Uint8Array(80);
  writeU32(bytes, 0, 0x3000);
  writeU32(bytes, 4, (4 << 2) | 1);
  const image = new BinaryImage(bytes, { format: 'pe', bits: 64, imageBase: 0n });
  addPdata(image, 8);
  addText(image);

  parseExceptionFunctions(new ByteView(bytes), { rva: 0x1000, size: 8 }, image, machine);

  assert.equal(image.metadata.exceptionDirectory?.invalidRecords, 1);
  assert.equal(image.metadata.peMetadata?.complete, false);
  assert.equal(reasons(image).includes(INVALID_REASON), true);
  assert.equal(image.functions.length, 0);
}

{
  const bytes = new Uint8Array(80);
  writeU32(bytes, 0, 0x2000);
  writeU32(bytes, 4, (2 << 2) | 1);
  const image = new BinaryImage(bytes, { format: 'pe', bits: 64, imageBase: 0n });
  addPdata(image, 8);
  addText(image, 4);

  parseExceptionFunctions(new ByteView(bytes), { rva: 0x1000, size: 8 }, image, 0xaa64);

  assert.equal(image.metadata.exceptionDirectory?.invalidRecords, 1);
  assert.equal(image.metadata.peMetadata?.complete, false);
  assert.equal(reasons(image).includes(INVALID_REASON), true);
  assert.equal(image.functions.length, 0);
}

{
  const bytes = new Uint8Array(80);
  writeU32(bytes, 0, 0x2000);
  writeU32(bytes, 4, (4 << 2) | 1);
  const image = new BinaryImage(bytes, { format: 'pe', bits: 64, imageBase: 0n });
  addPdata(image, 8);
  addText(image);

  parseExceptionFunctions(new ByteView(bytes), { rva: 0x1000, size: 8 }, image, 0xaa64);

  assert.equal(image.metadata.exceptionDirectory?.invalidRecords, 0);
  assert.equal(image.metadata.peMetadata?.complete, true);
  assert.equal(reasons(image).includes(INVALID_REASON), false);
  assert.equal(image.functions.length, 1);
  assert.equal(image.functions[0].address, 0x2000n);
  assert.equal(image.functions[0].size, 16n);
}

console.log('issue-3895 PE exception invalid-record completeness regression: PASS');
