import assert from 'node:assert/strict';
import { parseDelayImports, parseImports } from '../../js/binary/pe-loader.js';

const DIRECTORY_RVA = 0x1000;

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.length = bytes.length;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u32(offset) { return this.view.getUint32(offset, true); }
  slice(start, length) { return this.bytes.slice(start, start + length); }
  cstring(start, max) {
    const limit = Math.min(this.length, start + max);
    let end = start;
    while (end < limit && this.bytes[end] !== 0) end++;
    return String.fromCharCode(...this.bytes.subarray(start, end));
  }
}

function writeU32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value >>> 0, true);
}

function makeImage(bytes) {
  const imageBase = 0x400000n;
  const section = {
    index: 1,
    address: imageBase + BigInt(DIRECTORY_RVA),
    size: BigInt(bytes.length),
    fileOffset: 0,
    fileSize: bytes.length,
    perms: { read: true, write: false, execute: false },
  };
  return {
    bits: 32,
    imageBase,
    sections: [section],
    segments: [],
    metadata: {},
    libraries: [],
    imports: [],
    functions: [],
    warnings: [],
  };
}

function makeBudget(image, stopDescriptorReason = null, stopAt = Infinity) {
  let seenDescriptors = 0;
  image.metadata.peMetadata ||= { complete: true, reasons: [] };
  const partial = (reason, warning = null) => {
    const meta = image.metadata.peMetadata;
    meta.complete = false;
    if (!meta.reasons.includes(reason)) meta.reasons.push(reason);
    if (warning && !image.warnings.includes(warning)) image.warnings.push(warning);
    return false;
  };
  return {
    remainingStringBytes: 1 << 30,
    take(_cost, reason = 'metadata') {
      if (reason === stopDescriptorReason && ++seenDescriptors === stopAt) {
        return partial(`budget:${reason}:records`, `forced ${reason} budget stop`);
      }
      return true;
    },
    partial,
  };
}

function normalFixture(nonzeroDescriptors, includeZeroDescriptor) {
  const descriptorSize = 20;
  const directorySize = (nonzeroDescriptors + (includeZeroDescriptor ? 1 : 0)) * descriptorSize;
  const support = directorySize + 0x20;
  const bytes = new Uint8Array(support + 0x80);
  const nameRva = DIRECTORY_RVA + support;
  const thunkRva = nameRva + 0x20;
  const iatRva = nameRva + 0x30;
  bytes.set([0x78, 0x2e, 0x64, 0x6c, 0x6c, 0], support); // x.dll\0
  for (let i = 0; i < nonzeroDescriptors; i++) {
    const off = i * descriptorSize;
    writeU32(bytes, off, thunkRva);
    writeU32(bytes, off + 12, nameRva);
    writeU32(bytes, off + 16, iatRva);
  }
  const image = makeImage(bytes);
  return { reader: new Reader(bytes), image, directory: { rva: DIRECTORY_RVA, size: directorySize } };
}

function delayFixture(nonzeroDescriptors, includeZeroDescriptor) {
  const descriptorSize = 32;
  const directorySize = (nonzeroDescriptors + (includeZeroDescriptor ? 1 : 0)) * descriptorSize;
  const support = directorySize + 0x20;
  const bytes = new Uint8Array(support + 0x80);
  const nameRva = DIRECTORY_RVA + support;
  const thunkRva = nameRva + 0x20;
  const iatRva = nameRva + 0x30;
  bytes.set([0x78, 0x2e, 0x64, 0x6c, 0x6c, 0], support); // x.dll\0
  for (let i = 0; i < nonzeroDescriptors; i++) {
    const off = i * descriptorSize;
    writeU32(bytes, off, 1); // dlattrRva: descriptor pointer fields are RVAs
    writeU32(bytes, off + 4, nameRva);
    writeU32(bytes, off + 12, iatRva);
    writeU32(bytes, off + 16, thunkRva);
  }
  const image = makeImage(bytes);
  return { reader: new Reader(bytes), image, directory: { rva: DIRECTORY_RVA, size: directorySize } };
}

{
  const fixture = normalFixture(1, true);
  parseImports(fixture.reader, fixture.directory, fixture.image, makeBudget(fixture.image));
  assert.equal(fixture.image.metadata.peImports.complete, true);
  assert.equal(fixture.image.metadata.peMetadata.complete, true);
  assert.equal(fixture.image.metadata.peImports.truncatedTables, 0);
  assert.ok(!fixture.image.warnings.some((warning) => warning.includes('thunk table')));
}

{
  const fixture = delayFixture(1, true);
  parseDelayImports(fixture.reader, fixture.directory, fixture.image, makeBudget(fixture.image));
  assert.equal(fixture.image.metadata.peMetadata.complete, true);
  assert.ok(!fixture.image.metadata.peMetadata.reasons.some((reason) => reason.includes('unterminated')));
  assert.ok(!fixture.image.warnings.some((warning) => warning.includes('thunk table')));
}

{
  const fixture = delayFixture(0, true);
  writeU32(fixture.reader.bytes, 8, 1); // nonzero ModuleHandleRVA: not an all-zero terminator
  parseDelayImports(fixture.reader, fixture.directory, fixture.image, makeBudget(fixture.image));
  assert.equal(fixture.image.metadata.peMetadata.complete, false);
  assert.ok(fixture.image.metadata.peMetadata.reasons.includes('delay-imports:malformed-descriptor'));
  assert.ok(fixture.image.metadata.peMetadata.reasons.includes('delay-imports:unterminated-descriptor'));
}

{
  const fixture = normalFixture(1, false);
  parseImports(fixture.reader, fixture.directory, fixture.image, makeBudget(fixture.image));
  assert.equal(fixture.image.metadata.peImports.complete, false);
  assert.ok(fixture.image.metadata.peMetadata.reasons.includes('imports-partial'));
}

{
  const fixture = delayFixture(1, false);
  parseDelayImports(fixture.reader, fixture.directory, fixture.image, makeBudget(fixture.image));
  assert.equal(fixture.image.metadata.peMetadata.complete, false);
  assert.ok(fixture.image.metadata.peMetadata.reasons.includes('delay-imports:unterminated-descriptor'));
}

{
  const fixture = normalFixture(65536, true);
  parseImports(fixture.reader, fixture.directory, fixture.image, makeBudget(fixture.image));
  assert.equal(fixture.image.metadata.peImports.complete, false);
  assert.ok(fixture.image.warnings.some((warning) => warning.includes('65536-record safety guard')));
}

{
  const fixture = delayFixture(65536, true);
  parseDelayImports(fixture.reader, fixture.directory, fixture.image, makeBudget(fixture.image));
  assert.equal(fixture.image.metadata.peMetadata.complete, false);
  assert.ok(fixture.image.metadata.peMetadata.reasons.includes('delay-imports:unterminated-descriptor'));
  assert.ok(fixture.image.warnings.some((warning) => warning.includes('65536-record safety guard')));
}

{
  const fixture = normalFixture(1, true);
  const budget = makeBudget(fixture.image, 'import-descriptor', 2);
  parseImports(fixture.reader, fixture.directory, fixture.image, budget);
  assert.ok(fixture.image.metadata.peMetadata.reasons.includes('budget:import-descriptor:records'));
  assert.ok(!fixture.image.metadata.peMetadata.reasons.includes('imports-partial'));
}

{
  const fixture = delayFixture(1, true);
  const budget = makeBudget(fixture.image, 'delay-import-descriptor', 2);
  parseDelayImports(fixture.reader, fixture.directory, fixture.image, budget);
  assert.ok(fixture.image.metadata.peMetadata.reasons.includes('budget:delay-import-descriptor:records'));
  assert.ok(!fixture.image.metadata.peMetadata.reasons.includes('delay-imports:unterminated-descriptor'));
}

// Directory capacity declared beyond the file-backed section span: the core
// parser fail-closes on the mapped span (mappedFileSpanForRva returns null)
// before reading any descriptor, so exhaustion must be classified as a
// mapped-boundary/directory-span partial, never as hard-guard exhaustion.
function clippedSpanFixture(kind) {
  const descriptorSize = kind === 'normal' ? 20 : 32;
  const records = 65536;
  const dirBytes = records * descriptorSize;
  const supportLength = 0x80;
  const bytes = new Uint8Array(supportLength + dirBytes + 0x40);
  const sectionRva = DIRECTORY_RVA - supportLength;
  const nameRva = sectionRva;
  const thunkRva = sectionRva + 0x10;
  const iatRva = sectionRva + 0x18;
  bytes.set([0x78, 0x2e, 0x64, 0x6c, 0x6c, 0], 0); // x.dll\0
  writeU32(bytes, 0x10, 0); // terminated thunk table
  writeU32(bytes, 0x18, 0); // terminated iat
  const descriptorBase = supportLength;
  for (let i = 0; i < records; i++) {
    const off = descriptorBase + i * descriptorSize;
    if (kind === 'normal') {
      writeU32(bytes, off, thunkRva);
      writeU32(bytes, off + 12, nameRva);
      writeU32(bytes, off + 16, iatRva);
    } else {
      writeU32(bytes, off, 1); // dlattrRva: descriptor pointer fields are RVAs
      writeU32(bytes, off + 4, nameRva);
      writeU32(bytes, off + 12, iatRva);
      writeU32(bytes, off + 16, thunkRva);
    }
  }
  const imageBase = 0x400000n;
  const section = {
    index: 1,
    address: imageBase + BigInt(sectionRva),
    size: BigInt(bytes.length),
    fileOffset: 0,
    fileSize: supportLength + dirBytes,
    perms: { read: true, write: false, execute: false },
  };
  const image = {
    bits: 32,
    imageBase,
    sections: [section],
    segments: [],
    metadata: {},
    libraries: [],
    imports: [],
    functions: [],
    warnings: [],
  };
  return {
    reader: new Reader(bytes),
    image,
    directory: { rva: DIRECTORY_RVA, size: (records + 1) * descriptorSize },
  };
}

{
  const fixture = normalFixture(65536, false);
  parseImports(fixture.reader, fixture.directory, fixture.image, makeBudget(fixture.image));
  assert.equal(fixture.image.metadata.peImports.complete, false);
  assert.ok(fixture.image.metadata.peMetadata.reasons.includes('imports-partial'));
  assert.ok(!fixture.image.warnings.some((warning) => warning.includes('65536-record safety guard')));
}

{
  const fixture = delayFixture(65536, false);
  parseDelayImports(fixture.reader, fixture.directory, fixture.image, makeBudget(fixture.image));
  assert.equal(fixture.image.metadata.peMetadata.complete, false);
  assert.ok(fixture.image.metadata.peMetadata.reasons.includes('delay-imports:unterminated-descriptor'));
  assert.ok(!fixture.image.warnings.some((warning) => warning.includes('65536-record safety guard')));
}

{
  const fixture = clippedSpanFixture('normal');
  parseImports(fixture.reader, fixture.directory, fixture.image, makeBudget(fixture.image));
  assert.equal(fixture.image.metadata.peMetadata.complete, false);
  assert.equal(fixture.image.metadata.peImports.complete, false);
  assert.ok(fixture.image.metadata.peMetadata.reasons.includes('imports-partial'));
  assert.ok(!fixture.image.warnings.some((warning) => warning.includes('65536-record safety guard')));
}

{
  const fixture = clippedSpanFixture('delay');
  parseDelayImports(fixture.reader, fixture.directory, fixture.image, makeBudget(fixture.image));
  assert.equal(fixture.image.metadata.peMetadata.complete, false);
  assert.ok(fixture.image.metadata.peMetadata.reasons.includes('delay-imports:directory-span'));
  assert.ok(!fixture.image.metadata.peMetadata.reasons.includes('delay-imports:unterminated-descriptor'));
  assert.ok(!fixture.image.warnings.some((warning) => warning.includes('65536-record safety guard')));
}

console.log('issue-3695-pe-import-descriptor-termination: PASS');
