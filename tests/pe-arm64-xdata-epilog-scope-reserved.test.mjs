import assert from 'node:assert/strict';
import { ByteView } from '../js/binary/reader.js';
import {
  createPEMetadataBudget,
  parseExceptionFunctions,
} from '../js/binary/pe-loader-core.js';

const IMAGE_BASE = 0x180000000n;
const SECTION_RVA = 0x1000;
const FILE_OFFSET = 0x100;
const PDATA_RVA = 0x1040;
const XDATA_RVA = 0x1080;
const BEGIN_RVA = 0x1100;
const MACHINE_ARM64 = 0xaa64;

function writeU32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .setUint32(offset, value >>> 0, true);
}

function makeImage(fileSize = 0x400) {
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

function runArm64Xdata({
  header,
  extensionWord = null,
  scopeWords = [],
  unwindWords = [],
  metadataLimits = null,
}) {
  const bytes = new Uint8Array(FILE_OFFSET + 0x400);
  const at = (rva) => FILE_OFFSET + (rva - SECTION_RVA);
  writeU32(bytes, at(PDATA_RVA), BEGIN_RVA);
  writeU32(bytes, at(PDATA_RVA) + 4, XDATA_RVA);

  let p = at(XDATA_RVA);
  writeU32(bytes, p, header);
  p += 4;
  if (extensionWord != null) {
    writeU32(bytes, p, extensionWord);
    p += 4;
  }
  for (const scope of scopeWords) {
    writeU32(bytes, p, scope);
    p += 4;
  }
  for (const word of unwindWords) {
    writeU32(bytes, p, word);
    p += 4;
  }

  const image = makeImage();
  const budget = metadataLimits == null
    ? null
    : createPEMetadataBudget(image, { limits: metadataLimits });
  parseExceptionFunctions(
    new ByteView(bytes),
    { rva: PDATA_RVA, size: 8 },
    image,
    MACHINE_ARM64,
    budget,
  );
  return image;
}

const fullHeader = (epilogCount, codeWords = 1) => (
  4 | (epilogCount << 22) | (codeWords << 27)
) >>> 0;

function assertRejectedReservedScope(image) {
  assert.equal(image.functions.length, 0, 'reserved epilog scope must not mint a function seed');
  assert.equal(image.metadata.exceptionDirectory.count, 0);
  assert.equal(image.metadata.exceptionDirectory.invalidRecords, 1);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(
    image.metadata.peMetadata.reasons.includes('exception:arm64-xdata-epilog-reserved'),
    `missing reserved-scope reason: ${JSON.stringify(image.metadata.peMetadata.reasons)}`,
  );
  assert.ok(
    image.warnings.some((warning) => warning.includes('reserved bits')),
    `missing reserved-scope warning: ${JSON.stringify(image.warnings)}`,
  );
}

// A structurally valid full-form scope with Res=0 remains authoritative.
{
  const image = runArm64Xdata({
    header: fullHeader(1),
    scopeWords: [1],
    unwindWords: [0x000000e4],
  });
  assert.equal(image.functions.length, 1);
  assert.equal(image.functions[0].address, IMAGE_BASE + BigInt(BEGIN_RVA));
  assert.equal(image.functions[0].size, 16n);
  assert.equal(image.metadata.exceptionDirectory.count, 1);
  assert.equal(image.metadata.exceptionDirectory.invalidRecords, 0);
  assert.equal(image.metadata.peMetadata.complete, true);
}

// Bits 18..21 are reserved. Each individual bit must invalidate the whole
// .xdata record before it can contribute 0.995-confidence function evidence.
for (let bit = 18; bit <= 21; bit += 1) {
  const image = runArm64Xdata({
    header: fullHeader(1),
    scopeWords: [(1 << bit) | 1],
    unwindWords: [0x000000e4],
  });
  assertRejectedReservedScope(image);
}

// The all-reserved-bits form is equally invalid.
{
  const image = runArm64Xdata({
    header: fullHeader(1),
    scopeWords: [(0xf << 18) | 1],
    unwindWords: [0x000000e4],
  });
  assertRejectedReservedScope(image);
}

// Validation must cover every declared scope, not only the first one.
{
  const image = runArm64Xdata({
    header: fullHeader(2),
    scopeWords: [1, (1 << 18) | 2],
    unwindWords: [0x000000e4],
  });
  assertRejectedReservedScope(image);
}

// The extended-header path can declare more than 31 scopes and must apply the
// same reserved-bit rule to every one of them.
{
  const scopes = Array.from({ length: 32 }, (_, index) => index + 1);
  scopes[31] |= 1 << 18;
  const image = runArm64Xdata({
    header: 4, // Epilog Count=0 and Code Words=0 => extension word follows.
    extensionWord: 32 | (1 << 16),
    scopeWords: scopes,
    unwindWords: [0x000000e4],
  });
  assertRejectedReservedScope(image);
}

// E=1 means the header carries a packed single-epilog index and there is no
// epilog-scope word list. Bits that look reserved inside the unwind-code word
// must therefore not be interpreted as a scope.
{
  const image = runArm64Xdata({
    header: (fullHeader(1) | (1 << 21)) >>> 0,
    scopeWords: [],
    // Keep reserved-looking bits in the code word while leaving a valid
    // reachable sequence for the stricter unwind-code validator.
    unwindWords: [0x003ce4e3],
  });
  assert.equal(image.functions.length, 1);
  assert.equal(image.metadata.exceptionDirectory.invalidRecords, 0);
}

// The new scope reads are budgeted. A budget that covers the fixed .pdata
// record and .xdata header, but not the declared scope word, must fail closed.
{
  const image = runArm64Xdata({
    header: fullHeader(1),
    scopeWords: [1],
    unwindWords: [0x000000e4],
    metadataLimits: { inputBytes: 12 },
  });
  assert.equal(image.functions.length, 0);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(
    image.metadata.peMetadata.reasons.includes('budget:arm64-xdata-epilog-scopes:inputBytes'),
    `missing scope-budget reason: ${JSON.stringify(image.metadata.peMetadata.reasons)}`,
  );
}

console.log('PE ARM64 .xdata epilog-scope reserved-bit regression: PASS');
