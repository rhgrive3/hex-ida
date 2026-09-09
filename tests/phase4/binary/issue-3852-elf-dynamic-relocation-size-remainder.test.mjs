import assert from 'node:assert/strict';
import { ByteView } from '../../../js/binary/reader.js';
import { parseProgramDynamic } from '../../../js/binary/elf-dynamic.js';

const DT_NULL = 0n;
const DT_PLTRELSZ = 2n;
const DT_RELA = 7n;
const DT_RELASZ = 8n;
const DT_RELAENT = 9n;
const DT_REL = 17n;
const DT_RELSZ = 18n;
const DT_RELENT = 19n;
const DT_PLTREL = 20n;
const DT_JMPREL = 23n;

const BASE = 0x400000n;
const TABLE_OFF = 0x100;
const FILE_SIZE = 0x300;

function writeDynamic(bytes, bits, entries) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entrySize = bits === 64 ? 16 : 8;
  entries.forEach(([tag, value], index) => {
    const off = index * entrySize;
    if (bits === 64) {
      view.setBigInt64(off, BigInt(tag), true);
      view.setBigUint64(off + 8, BigInt(value), true);
    } else {
      view.setInt32(off, Number(tag), true);
      view.setUint32(off + 4, Number(value), true);
    }
  });
  return entries.length * entrySize;
}

function writeRelocation(bytes, bits, rela) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const address = bits === 64 ? 0x400180n : 0x400180;
  if (bits === 64) {
    view.setBigUint64(TABLE_OFF, BigInt(address), true);
    view.setBigUint64(TABLE_OFF + 8, 0n, true);
    if (rela) view.setBigInt64(TABLE_OFF + 16, 0n, true);
  } else {
    view.setUint32(TABLE_OFF, Number(address), true);
    view.setUint32(TABLE_OFF + 4, 0, true);
    if (rela) view.setInt32(TABLE_OFF + 8, 0, true);
  }
}

function makeImage(bytes, bits, declaredFileSize = bytes.length) {
  const segment = {
    name: 'LOAD',
    address: BASE,
    size: BigInt(declaredFileSize),
    fileOffset: 0n,
    fileSize: BigInt(declaredFileSize),
    perms: { read: true, write: true, execute: true },
  };
  return {
    bits,
    imageBase: BASE,
    metadata: { machine: bits === 64 ? 62 : 3 },
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

function runCase({ bits, kind, declaredSize, entrySize, declaredFileSize = FILE_SIZE, expectedRelocations = 1 }) {
  const bytes = new Uint8Array(FILE_SIZE);
  const rela = kind === 'rela' || kind === 'jmprel-rela';
  writeRelocation(bytes, bits, rela);
  if (declaredSize > entrySize) bytes[TABLE_OFF + entrySize] = 0xaa;

  const tableVa = BASE + BigInt(TABLE_OFF);
  let entries;
  if (kind === 'rela') {
    entries = [
      [DT_RELA, tableVa],
      [DT_RELASZ, BigInt(declaredSize)],
      [DT_RELAENT, BigInt(entrySize)],
      [DT_NULL, 0n],
    ];
  } else if (kind === 'rel') {
    entries = [
      [DT_REL, tableVa],
      [DT_RELSZ, BigInt(declaredSize)],
      [DT_RELENT, BigInt(entrySize)],
      [DT_NULL, 0n],
    ];
  } else {
    entries = [
      [DT_JMPREL, tableVa],
      [DT_PLTRELSZ, BigInt(declaredSize)],
      [DT_PLTREL, rela ? DT_RELA : DT_REL],
      [rela ? DT_RELAENT : DT_RELENT, BigInt(entrySize)],
      [DT_NULL, 0n],
    ];
  }

  const dynamicSize = writeDynamic(bytes, bits, entries);
  const image = makeImage(bytes, bits, declaredFileSize);
  const result = parseProgramDynamic(
    new ByteView(bytes),
    [{ type: 2, offset: 0n, filesz: BigInt(dynamicSize) }],
    image,
    bits,
  );
  assert.equal(result.parsed, true);
  assert.equal(image.metadata.programDynamic.terminated, true);
  assert.equal(image.metadata.programDynamic.entrySpanAligned, true);
  assert.equal(image.relocations.length, expectedRelocations, 'relocation decode preserves the established boundary behavior');
  return image;
}

const cases = [
  { bits: 64, kind: 'rela', entrySize: 24 },
  { bits: 64, kind: 'rel', entrySize: 16 },
  { bits: 32, kind: 'rela', entrySize: 12 },
  { bits: 32, kind: 'rel', entrySize: 8 },
  { bits: 64, kind: 'jmprel-rela', entrySize: 24 },
  { bits: 64, kind: 'jmprel-rel', entrySize: 16 },
  { bits: 32, kind: 'jmprel-rela', entrySize: 12 },
  { bits: 32, kind: 'jmprel-rel', entrySize: 8 },
];

for (const testCase of cases) {
  const label = `ELF${testCase.bits} ${testCase.kind}`;
  const valid = runCase({ ...testCase, declaredSize: testCase.entrySize });
  assert.equal(valid.metadata.programDynamicPartial, undefined, `${label} aligned table remains complete`);

  const malformed = runCase({ ...testCase, declaredSize: testCase.entrySize + 1 });
  assert.equal(malformed.metadata.programDynamicPartial, true, `${label} trailing relocation byte must make metadata partial`);
  assert.ok(
    malformed.metadata.programDynamicDiagnostics?.some((message) =>
      message.includes('is not a multiple of entry size')),
    `${label} explains the relocation table remainder`,
  );
}

{
  const belowMinimum = runCase({
    bits: 64, kind: 'rela', declaredSize: 16, entrySize: 16, expectedRelocations: 0,
  });
  assert.equal(belowMinimum.metadata.programDynamicPartial, true);
  assert.ok(belowMinimum.metadata.programDynamicDiagnostics?.some((message) =>
    message.includes('entry size 16 is smaller than 24')));
}

{
  const crossing = runCase({
    bits: 64, kind: 'rela', declaredSize: 24, entrySize: 24,
    declaredFileSize: TABLE_OFF + 23, expectedRelocations: 0,
  });
  assert.equal(crossing.metadata.programDynamicPartial, true);
  assert.ok(crossing.metadata.programDynamicDiagnostics?.some((message) =>
    message.includes('table crosses a file-backed PT_LOAD boundary')));
}

console.log('issue-3852 ELF dynamic relocation table remainder regression: PASS');
