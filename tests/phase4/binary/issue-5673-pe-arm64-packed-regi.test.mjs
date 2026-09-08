import assert from 'node:assert/strict';
import { BinaryImage } from '../../../js/binary/model.js';
import { ByteView } from '../../../js/binary/reader.js';
import { createPEMetadataBudget, parseExceptionFunctions } from '../../../js/binary/pe-loader.js';

// Issue #5673: ARM64 packed unwind encodes RegI as the count of saved
// nonvolatile integer registers x19-x28. Only 10 such registers exist, so a
// packed entry with RegI = 11..15 is unsatisfiable and must not be adopted as
// a 0.995-confidence function seed.

function writeU32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
}

function arm64PdataImage(unwindData, { begin = 0x2000 } = {}) {
  const bytes = new Uint8Array(256);
  writeU32(bytes, 0, begin);
  writeU32(bytes, 4, unwindData);
  const image = new BinaryImage(bytes, { format: 'pe', bits: 64, imageBase: 0n });
  image.addSegment({
    name: '.pdata',
    address: 0x1000n,
    size: 8n,
    fileOffset: 0n,
    fileSize: 8n,
    perms: { read: true, write: false, execute: false },
  });
  image.addSection({
    name: '.text',
    address: 0x2000n,
    size: 0x100n,
    fileOffset: 64n,
    fileSize: 64n,
    perms: { read: true, write: false, execute: true },
  });
  return { bytes, image };
}

function packedUnwind({ flag = 1, functionLength = 4, regF = 0, regI = 0 } = {}) {
  return (flag | (functionLength << 2) | (regF << 13) | (regI << 16)) >>> 0;
}

function parse(unwindData, options) {
  const { bytes, image } = arm64PdataImage(unwindData, options);
  parseExceptionFunctions(new ByteView(bytes), { rva: 0x1000, size: 8 }, image, 0xaa64);
  return image;
}

function reasons(image) {
  return image.metadata.peMetadata?.reasons || [];
}

// RegI = 11..15 cannot describe a real prologue: rejected, no seed.
for (const regI of [11, 12, 13, 14, 15]) {
  const image = parse(packedUnwind({ regI }));
  assert.equal(image.functions.length, 0, `RegI=${regI} must not mint a function seed`);
  assert.equal(image.metadata.exceptionDirectory?.invalidRecords, 1, `RegI=${regI} counts as an invalid record`);
  assert.equal(reasons(image).includes('exception:arm64-packed-registers'), true, `RegI=${regI} records a partial reason`);
  assert.equal(image.metadata.peMetadata?.complete, false, `RegI=${regI} lowers metadata completeness`);
}

// The same packed encoding with a representable RegI still seeds.
for (const regI of [0, 1, 10]) {
  const image = parse(packedUnwind({ regI }));
  assert.equal(image.functions.length, 1, `RegI=${regI} remains a valid packed entry`);
  assert.equal(image.functions[0].address, 0x2000n);
  assert.equal(image.functions[0].source, 'exception');
  assert.equal(image.metadata.peMetadata?.complete, true);
}

// Packed fragments (flag=2) share the packed encoding: invalid RegI rejects
// them before any fragment is recorded.
{
  const image = parse(packedUnwind({ flag: 2, regI: 15 }));
  assert.equal(image.functions.length, 0);
  assert.equal((image.metadata.exceptionDirectory?.fragments || []).length, 0, 'invalid packed fragment is not recorded');
  assert.equal(image.metadata.exceptionDirectory?.invalidRecords, 1);
}

// A RegI=0 packed fragment (no saved integer registers) stays valid.
{
  const image = parse(packedUnwind({ flag: 2, regI: 0 }));
  assert.equal(image.functions.length, 0, 'fragment entries do not seed functions');
  assert.equal((image.metadata.exceptionDirectory?.fragments || []).length, 1, 'valid fragment is still recorded');
  assert.equal(image.metadata.peMetadata?.complete, true);
}

// ARM64EC (0xa641) shares the ARM64 packed encoding: same rejection.
{
  const { bytes, image } = arm64PdataImage(packedUnwind({ regI: 12 }));
  parseExceptionFunctions(new ByteView(bytes), { rva: 0x1000, size: 8 }, image, 0xa641);
  assert.equal(image.functions.length, 0, 'ARM64EC rejects unsatisfiable RegI');
  assert.equal(image.metadata.exceptionDirectory?.invalidRecords, 1);
}

// The rejection keeps the directory scan alive: a later valid record is still
// processed, and the invalid one is attributed through the wrapper budget.
{
  const bytes = new Uint8Array(256);
  writeU32(bytes, 0, 0x2000);
  writeU32(bytes, 4, packedUnwind({ regI: 15 }));
  writeU32(bytes, 8, 0x2004);
  writeU32(bytes, 12, packedUnwind({ regI: 2 }));
  const image = new BinaryImage(bytes, { format: 'pe', bits: 64, imageBase: 0n });
  image.addSegment({
    name: '.pdata',
    address: 0x1000n,
    size: 16n,
    fileOffset: 0n,
    fileSize: 16n,
    perms: { read: true, write: false, execute: false },
  });
  image.addSection({
    name: '.text',
    address: 0x2000n,
    size: 0x100n,
    fileOffset: 64n,
    fileSize: 64n,
    perms: { read: true, write: false, execute: true },
  });
  parseExceptionFunctions(new ByteView(bytes), { rva: 0x1000, size: 16 }, image, 0xaa64);
  assert.equal(image.functions.length, 1, 'valid record after an invalid RegI record still seeds');
  assert.equal(image.functions[0].address, 0x2004n);
  assert.equal(image.metadata.exceptionDirectory?.invalidRecords, 1);
  assert.equal(image.metadata.peMetadata?.complete, false, 'wrapper attributes the invalid record');
  assert.equal(reasons(image).includes('exception:invalid-record'), true);
}

console.log('issue #5673 PE ARM64 packed unwind RegI range regression: PASS');
