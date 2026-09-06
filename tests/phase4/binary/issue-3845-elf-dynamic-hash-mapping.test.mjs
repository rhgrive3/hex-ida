import assert from 'node:assert/strict';
import { ByteView } from '../../../js/binary/reader.js';
import { parseProgramDynamic } from '../../../js/binary/elf-dynamic.js';

const DT_NULL = 0n;
const DT_HASH = 4n;
const DT_STRTAB = 5n;
const DT_SYMTAB = 6n;
const DT_STRSZ = 10n;
const DT_SYMENT = 11n;
const DT_SYMTABSZ = 39n;
const DT_GNU_HASH = 0x6ffffef5n;

const BASE = 0x400000n;
const SYMTAB_OFF = 0x80;
const STRTAB_OFF = 0xa0;
const HASH_OFF = 0xb0;
const GNU_HASH_OFF = 0xc0;
const FILE_SIZE = 0x200;

function writeDynamic64(bytes, entries) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  entries.forEach(([tag, value], index) => {
    const off = index * 16;
    view.setBigInt64(off, BigInt(tag), true);
    view.setBigUint64(off + 8, BigInt(value), true);
  });
  return entries.length * 16;
}

function imageFor(bytes) {
  const segment = {
    name: 'LOAD',
    address: BASE,
    size: BigInt(bytes.length),
    fileOffset: 0n,
    fileSize: BigInt(bytes.length),
    perms: { read: true, write: false, execute: false },
  };
  return {
    bits: 64,
    imageBase: BASE,
    metadata: { machine: 62 },
    warnings: [],
    libraries: [],
    imports: [],
    exports: [],
    symbols: [],
    relocations: [],
    functions: [],
    sections: [],
    segments: [segment],
    addressToOffset(address) {
      const delta = BigInt(address) - BASE;
      return delta >= 0n && delta < BigInt(bytes.length) ? delta : null;
    },
    sectionAt() { return null; },
    segmentAt(address) {
      const a = BigInt(address);
      return a >= segment.address && a < segment.address + segment.size ? segment : null;
    },
  };
}

function baseEntries(extra = []) {
  return [
    [DT_SYMTAB, BASE + BigInt(SYMTAB_OFF)],
    [DT_SYMENT, 24n],
    [DT_SYMTABSZ, 24n],
    [DT_STRTAB, BASE + BigInt(STRTAB_OFF)],
    [DT_STRSZ, 1n],
    ...extra,
    [DT_NULL, 0n],
  ];
}

function writeSysvHash(bytes, offset = HASH_OFF) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(offset, 1, true);
  view.setUint32(offset + 4, 1, true);
  view.setUint32(offset + 8, 0, true);
  view.setUint32(offset + 12, 0, true);
}

function writeGnuHash(bytes, offset = GNU_HASH_OFF) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(offset, 1, true); // nbuckets
  view.setUint32(offset + 4, 1, true); // symoffset
  view.setUint32(offset + 8, 1, true); // bloom_size
  view.setUint32(offset + 12, 0, true); // bloom_shift
  view.setBigUint64(offset + 16, 0n, true); // bloom word
  view.setUint32(offset + 24, 0, true); // empty bucket
}

function run(extra = [], setup = null) {
  const bytes = new Uint8Array(FILE_SIZE);
  bytes[STRTAB_OFF] = 0;
  const dynamicSize = writeDynamic64(bytes, baseEntries(extra));
  setup?.(bytes);
  const image = imageFor(bytes);
  parseProgramDynamic(
    new ByteView(bytes),
    [{ type: 2, offset: 0n, filesz: BigInt(dynamicSize) }],
    image,
    64,
  );
  return image;
}

function assertBestEffortSymbolDecode(image) {
  assert.equal(image.metadata.programDynamic.symbolsDeclared, 1);
  assert.equal(image.metadata.programDynamic.symbolsExpected, 1);
  assert.equal(image.metadata.programDynamic.symbols, 1);
}

{
  const image = run();
  assert.equal(image.metadata.programDynamicPartial, undefined);
  assert.equal(image.metadata.programDynamic.hasSysvHash, false);
  assert.equal(image.metadata.programDynamic.hasGnuHash, false);
  assertBestEffortSymbolDecode(image);
}

{
  const image = run([[DT_HASH, BASE + BigInt(HASH_OFF)]], (bytes) => writeSysvHash(bytes));
  assert.equal(image.metadata.programDynamicPartial, undefined);
  assert.equal(image.metadata.programDynamic.hasSysvHash, true);
  assertBestEffortSymbolDecode(image);
}

{
  const image = run([[DT_HASH, BASE + 0x400n]]);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(image.metadata.programDynamicDiagnostics.includes('DT_HASH header is not fully file-backed'));
  assert.equal(image.metadata.programDynamic.hasSysvHash, true);
  assertBestEffortSymbolDecode(image);
}

{
  const image = run([[DT_HASH, BASE + 0x1fcn]]);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(image.metadata.programDynamicDiagnostics.includes('DT_HASH header is not fully file-backed'));
  assertBestEffortSymbolDecode(image);
}

{
  const image = run([[DT_GNU_HASH, BASE + BigInt(GNU_HASH_OFF)]], (bytes) => writeGnuHash(bytes));
  assert.equal(image.metadata.programDynamicPartial, undefined);
  assert.equal(image.metadata.programDynamic.hasGnuHash, true);
  assertBestEffortSymbolDecode(image);
}

{
  const image = run([[DT_GNU_HASH, BASE + 0x400n]]);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(image.metadata.programDynamicDiagnostics.includes('DT_GNU_HASH header is not fully file-backed'));
  assert.equal(image.metadata.programDynamic.hasGnuHash, true);
  assertBestEffortSymbolDecode(image);
}

{
  const image = run([[DT_GNU_HASH, BASE + 0x1f4n]]);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(image.metadata.programDynamicDiagnostics.includes('DT_GNU_HASH header is not fully file-backed'));
  assertBestEffortSymbolDecode(image);
}

{
  const image = run([
    [DT_HASH, BASE + BigInt(HASH_OFF)],
    [DT_GNU_HASH, BASE + BigInt(GNU_HASH_OFF)],
  ], (bytes) => {
    writeSysvHash(bytes);
    writeGnuHash(bytes);
  });
  assert.equal(image.metadata.programDynamicPartial, undefined);
  assert.equal(image.metadata.programDynamic.hasSysvHash, true);
  assert.equal(image.metadata.programDynamic.hasGnuHash, true);
  assertBestEffortSymbolDecode(image);
}

console.log('issue-3845-elf-dynamic-hash-mapping: PASS');
