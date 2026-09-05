import assert from 'node:assert/strict';
import { BinaryImage } from '../../js/binary/model.js';
import { ByteView } from '../../js/binary/reader.js';
import { createPEMetadataBudget, parseExceptionFunctions } from '../../js/binary/pe-loader.js';

const REMAINDER_REASON = 'exception:directory-record-remainder';

function parseDirectory(size, machine, { mapped = true } = {}) {
  const bytes = new Uint8Array(size);
  const image = new BinaryImage(bytes, { format: 'pe', bits: 64, imageBase: 0n });
  if (mapped) {
    image.addSegment({
      name: '.pdata',
      address: 0x1000n,
      size: BigInt(size),
      fileOffset: 0n,
      fileSize: BigInt(size),
      perms: { read: true, write: false, execute: false },
    });
  }
  parseExceptionFunctions(
    new ByteView(bytes),
    { rva: 0x1000, size },
    image,
    machine,
  );
  return image;
}

function writeU32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
}

function validX64Fixture(size = 12) {
  const bytes = new Uint8Array(256);
  writeU32(bytes, 0, 0x2000);
  writeU32(bytes, 4, 0x2010);
  writeU32(bytes, 8, 0x3000);
  if (size > 12) bytes[12] = 0xaa;
  bytes[128] = 0x01; // UNWIND_INFO version 1, flags 0

  const image = new BinaryImage(bytes, { format: 'pe', bits: 64, imageBase: 0n });
  image.addSegment({
    name: '.pdata',
    address: 0x1000n,
    size: BigInt(size),
    fileOffset: 0n,
    fileSize: BigInt(size),
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
  image.addSegment({
    name: '.xdata',
    address: 0x3000n,
    size: 4n,
    fileOffset: 128n,
    fileSize: 4n,
    perms: { read: true, write: false, execute: false },
  });
  return { bytes, image };
}

function reasons(image) {
  return image.metadata.peMetadata?.reasons || [];
}

for (const size of [12, 24]) {
  const image = parseDirectory(size, 0x8664);
  assert.equal(image.metadata.peMetadata?.complete, true, `x64 ${size}-byte table remains complete`);
  assert.equal(reasons(image).includes(REMAINDER_REASON), false);
}

for (const size of [13, 23]) {
  const image = parseDirectory(size, 0x8664);
  assert.equal(image.metadata.peMetadata?.complete, false, `x64 ${size}-byte table is partial`);
  assert.equal(reasons(image).includes(REMAINDER_REASON), true);
}

for (const machine of [0xaa64, 0xa641]) {
  const aligned = parseDirectory(8, machine);
  assert.equal(aligned.metadata.peMetadata?.complete, true);
  assert.equal(reasons(aligned).includes(REMAINDER_REASON), false);

  const remainder = parseDirectory(9, machine);
  assert.equal(remainder.metadata.peMetadata?.complete, false);
  assert.equal(reasons(remainder).includes(REMAINDER_REASON), true);
}

const valid = validX64Fixture();
parseExceptionFunctions(new ByteView(valid.bytes), { rva: 0x1000, size: 12 }, valid.image, 0x8664);
assert.equal(valid.image.metadata.peMetadata?.complete, true);
assert.equal(valid.image.metadata.exceptionDirectory?.count, 1);
assert.equal(valid.image.functions.length, 1);
assert.equal(valid.image.functions[0].address, 0x2000n);
assert.equal(valid.image.functions[0].size, 0x10n);
assert.equal(valid.image.functions[0].source, 'exception');

const budgeted = validX64Fixture(13);
const budget = createPEMetadataBudget(budgeted.image, { limits: { inputBytes: 12 } });
parseExceptionFunctions(new ByteView(budgeted.bytes), { rva: 0x1000, size: 13 }, budgeted.image, 0x8664, budget);
assert.equal(budgeted.image.metadata.peMetadata?.complete, false);
assert.equal(reasons(budgeted.image).includes(REMAINDER_REASON), true);
assert.equal(reasons(budgeted.image).some((reason) => reason.startsWith('budget:x64-unwind-header:inputBytes')), true);

const unmapped = parseDirectory(13, 0x8664, { mapped: false });
assert.equal(unmapped.metadata.peMetadata?.complete, false);
assert.equal(reasons(unmapped).includes('exception:directory-span'), true);
assert.equal(reasons(unmapped).includes(REMAINDER_REASON), false, 'existing unmapped-span reason remains authoritative');

console.log('issue-3784 PE exception-directory remainder regression: PASS');
