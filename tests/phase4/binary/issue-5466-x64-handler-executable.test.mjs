import assert from 'node:assert/strict';
import { BinaryImage } from '../../../js/binary/model.js';
import { ByteView } from '../../../js/binary/reader.js';
import { parseExceptionFunctions } from '../../../js/binary/pe-loader.js';

// Issue #5466: parseX64UnwindDescriptor() accepted UNW_FLAG_EHANDLER/UHANDLER
// handler RVAs that pointed into any file-backed section. A handler is an
// executable routine, so a data-section RVA must not validate — and the
// UNWIND_INFO carrying it must not mint a 0.999-confidence function seed.

function writeU32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
}

function x64Image({ handlerRva }) {
  const bytes = new Uint8Array(0x400);
  // .pdata (RVA 0x6000, file 0): one RUNTIME_FUNCTION {begin=0x1000, finish=0x1010, unwind=0x3000}
  writeU32(bytes, 0, 0x1000);
  writeU32(bytes, 4, 0x1010);
  writeU32(bytes, 8, 0x3000);
  // UNWIND_INFO at RVA 0x3000 (in file-backed non-executable .rdata, file 0x200):
  // version 1, flags = UNW_FLAG_EHANDLER, count = 0, handler RVA in the tail.
  writeU32(bytes, 0x200, 0x09); // version 1 in the low 3 bits, UNW_FLAG_EHANDLER (1) in bits 3-5
  writeU32(bytes, 0x204, handlerRva);

  const image = new BinaryImage(bytes, { format: 'pe', bits: 64, imageBase: 0n });
  image.addSegment({ name: '.pdata', address: 0x6000n, size: 12n, fileOffset: 0n, fileSize: 12n, perms: { read: true } });
  image.addSection({
    name: '.text',
    address: 0x1000n,
    size: 0x100n,
    fileOffset: 0x100n,
    fileSize: 0x100n,
    perms: { read: true, write: false, execute: true },
  });
  image.addSegment({ name: '.text', address: 0x1000n, size: 0x100n, fileOffset: 0x100n, fileSize: 0x100n, perms: { read: true, write: false, execute: true } });
  // .rdata at 0x3000, file-backed, NOT executable.
  const rdataPerms = { read: true, write: false, execute: false };
  image.addSection({ name: '.rdata', address: 0x3000n, size: 0x100n, fileOffset: 0x200n, fileSize: 0x100n, perms: rdataPerms });
  image.addSegment({ name: '.rdata', address: 0x3000n, size: 0x100n, fileOffset: 0x200n, fileSize: 0x100n, perms: rdataPerms });
  return { bytes, image };
}

function run(handlerRva) {
  const { bytes, image } = x64Image({ handlerRva });
  parseExceptionFunctions(new ByteView(bytes), { rva: 0x6000, size: 12 }, image, 0x8664);
  return image;
}

// A handler RVA in non-executable .rdata is rejected, and no seed is minted.
{
  const image = run(0x3010);
  assert.equal(image.functions.length, 0, 'a data-section handler must not mint a function seed');
  assert.equal(image.metadata.exceptionDirectory?.invalidRecords, 1);
  assert.ok(image.metadata.peMetadata.reasons.includes('exception:x64-handler-not-executable'));
}

// The same handler RVA in executable .text validates and seeds (control).
{
  const image = run(0x1080);
  assert.equal(image.functions.length, 1, 'an executable handler validates the unwind info');
  assert.equal(image.functions[0].source, 'exception');
  assert.equal(image.functions[0].address, 0x1000n);
  assert.equal(image.metadata.exceptionDirectory?.invalidRecords, 0);
}

// Zero handler RVA keeps its existing rejection.
{
  const image = run(0);
  assert.equal(image.functions.length, 0);
  assert.equal(image.metadata.exceptionDirectory?.invalidRecords, 1);
}

// Unmapped handler RVA keeps its existing rejection.
{
  const image = run(0x9000);
  assert.equal(image.functions.length, 0);
  assert.equal(image.metadata.exceptionDirectory?.invalidRecords, 1);
  assert.ok(image.metadata.peMetadata.reasons.includes('exception:x64-handler-not-executable'));
}

console.log('issue #5466 x64 handler RVA executability regression: PASS');
