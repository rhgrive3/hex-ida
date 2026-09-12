import assert from 'node:assert/strict';
import { BinaryImage } from '../../../js/binary/model.js';
import { ByteView } from '../../../js/binary/reader.js';
import {
  createPEMetadataBudget,
  parseExceptionFunctions,
} from '../../../js/binary/pe-loader-core.js';

const PDATA_RVA = 0x1000;
const TEXT_RVA = 0x2000;
const XDATA_RVA = 0x3000;
const MACHINE_ARM64 = 0xaa64;

function writeU32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .setUint32(offset, value >>> 0, true);
}

function buildCase({
  hasHandler = true,
  handlerRva = TEXT_RVA + 0x40,
  extended = false,
  packedEpilog = false,
  xdataFileSize = 0x100,
  machine = MACHINE_ARM64,
  metadataLimits = null,
} = {}) {
  const bytes = new Uint8Array(0x400);
  const pdataOffset = 0;
  const textOffset = 0x100;
  const xdataOffset = 0x200;

  writeU32(bytes, pdataOffset, TEXT_RVA);
  writeU32(bytes, pdataOffset + 4, XDATA_RVA);

  const xBit = hasHandler ? (1 << 20) : 0;
  if (extended) {
    writeU32(bytes, xdataOffset, (4 | xBit) >>> 0);
    writeU32(bytes, xdataOffset + 4, 1 << 16); // epilog count 0, code words 1
    writeU32(bytes, xdataOffset + 8, 0x000000e4);
    if (hasHandler) writeU32(bytes, xdataOffset + 12, handlerRva);
  } else {
    writeU32(bytes, xdataOffset, (4 | xBit | (packedEpilog ? (1 << 21) : 0) | (1 << 27)) >>> 0); // one unwind-code word
    writeU32(bytes, xdataOffset + 4, 0x000000e4);
    if (hasHandler) writeU32(bytes, xdataOffset + 8, handlerRva);
  }

  const image = new BinaryImage(bytes, { format: 'pe', bits: 64, imageBase: 0n });
  image.addSegment({
    name: '.pdata',
    address: BigInt(PDATA_RVA),
    size: 8n,
    fileOffset: BigInt(pdataOffset),
    fileSize: 8n,
    perms: { read: true, write: false, execute: false },
  });
  image.addSection({
    name: '.text',
    address: BigInt(TEXT_RVA),
    size: 0x100n,
    fileOffset: BigInt(textOffset),
    fileSize: 0x100n,
    perms: { read: true, write: false, execute: true },
  });
  image.addSection({
    name: '.xdata',
    address: BigInt(XDATA_RVA),
    size: 0x100n,
    fileOffset: BigInt(xdataOffset),
    fileSize: BigInt(xdataFileSize),
    perms: { read: true, write: false, execute: false },
  });

  const budget = metadataLimits == null
    ? null
    : createPEMetadataBudget(image, { limits: metadataLimits });
  parseExceptionFunctions(
    new ByteView(bytes),
    { rva: PDATA_RVA, size: 8 },
    image,
    machine,
    budget,
  );
  return image;
}

function reasons(image) {
  return image.metadata.peMetadata?.reasons || [];
}

function assertHandlerRejected(image, expectedReason = 'exception:arm64-handler-not-executable') {
  assert.equal(image.functions.length, 0, 'invalid ARM64 handler metadata must not mint a function seed');
  assert.equal(image.metadata.exceptionDirectory?.count, 0);
  assert.equal(image.metadata.exceptionDirectory?.invalidRecords, 1);
  assert.equal(image.metadata.peMetadata?.complete, false);
  assert.ok(reasons(image).includes(expectedReason), `missing ${expectedReason}: ${JSON.stringify(reasons(image))}`);
}

// X=0 has no handler field and keeps the existing authoritative path.
{
  const image = buildCase({ hasHandler: false });
  assert.equal(image.functions.length, 1);
  assert.equal(image.functions[0].address, BigInt(TEXT_RVA));
  assert.equal(image.metadata.exceptionDirectory?.invalidRecords, 0);
  assert.equal(image.metadata.peMetadata?.complete, true);
}

// X=1 with an executable, file-backed handler RVA remains valid.
{
  const image = buildCase({ handlerRva: TEXT_RVA + 0x40 });
  assert.equal(image.functions.length, 1);
  assert.equal(image.metadata.exceptionDirectory?.count, 1);
  assert.equal(image.metadata.exceptionDirectory?.invalidRecords, 0);
  assert.equal(image.metadata.peMetadata?.complete, true);
}

// The handler field is semantic authority, not padding: zero is invalid.
assertHandlerRejected(buildCase({ handlerRva: 0 }));

// An RVA outside every mapping is invalid.
assertHandlerRejected(buildCase({ handlerRva: 0xffffffff }));

// A gap between mapped sections is invalid even when the .xdata bytes are intact.
assertHandlerRejected(buildCase({ handlerRva: 0x4000 }));

// A file-backed data mapping is not an exception-handler routine.
assertHandlerRejected(buildCase({ handlerRva: XDATA_RVA + 0x40 }));

// X=1 declares the trailing 4-byte handler field. If that field is not fully
// file-backed, the record must stay fail-closed through the existing span guard.
{
  const image = buildCase({ xdataFileSize: 10 });
  assertHandlerRejected(image, 'exception:arm64-xdata-span');
}

// Extended-header records compute the handler position after the extension and
// unwind-code words; both valid and invalid targets must use that position.
{
  const valid = buildCase({ extended: true, handlerRva: TEXT_RVA + 0x80 });
  assert.equal(valid.functions.length, 1);
  assert.equal(valid.metadata.exceptionDirectory?.invalidRecords, 0);

  const invalid = buildCase({ extended: true, handlerRva: 0 });
  assertHandlerRejected(invalid);
}

// E=1 uses the header's packed epilog index instead of a scope-word list. The
// handler still follows the unwind-code words and must receive the same proof.
{
  const valid = buildCase({ packedEpilog: true, handlerRva: TEXT_RVA + 0x20 });
  assert.equal(valid.functions.length, 1);
  assert.equal(valid.metadata.exceptionDirectory?.invalidRecords, 0);
  assertHandlerRejected(buildCase({ packedEpilog: true, handlerRva: 0 }));
}

// ARM64EC shares the ARM64 .xdata layout and must enforce the same handler proof.
assertHandlerRejected(buildCase({ machine: 0xa641, handlerRva: 0 }));

// Reading the newly semantic handler field is budgeted. Exhaustion must stop
// authoritative decoding without being mislabeled as a malformed handler.
{
  const image = buildCase({
    handlerRva: TEXT_RVA + 0x40,
    metadataLimits: { inputBytes: 12 }, // 8-byte .pdata + 4-byte .xdata header only
  });
  assert.equal(image.functions.length, 0);
  assert.equal(image.metadata.peMetadata?.complete, false);
  assert.ok(
    reasons(image).includes('budget:arm64-xdata-handler:inputBytes'),
    `missing handler-read budget reason: ${JSON.stringify(reasons(image))}`,
  );
  assert.equal(reasons(image).includes('exception:arm64-handler-not-executable'), false);
}

console.log('issue #4162 ARM64 .xdata handler RVA regression: PASS');
