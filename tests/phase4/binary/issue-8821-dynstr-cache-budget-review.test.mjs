import assert from 'node:assert/strict';
import test from 'node:test';

import { ByteView } from '../../../js/binary/reader.js';
import { parseProgramDynamic } from '../../../js/binary/elf-dynamic.js';
import { buildAliasedDynsymElf } from './issue-8821-aliased-dynsym-fixture.mjs';

const DYNAMIC_FILE_OFF = 0x200;
const DYN_ENT = 16;
const LOAD_FILE_OFF = 0x100;
const VA_BIAS = 0x1000 - LOAD_FILE_OFF;

function blankImage(bytes) {
  return {
    bits: 64,
    imageBase: BigInt(LOAD_FILE_OFF + VA_BIAS),
    metadata: { machine: 62, type: 3 },
    warnings: [], libraries: [], symbols: [], imports: [], exports: [], functions: [], relocations: [], sections: [],
    segments: [{ address: BigInt(LOAD_FILE_OFF + VA_BIAS), fileOffset: BigInt(LOAD_FILE_OFF), fileSize: BigInt(bytes.length - LOAD_FILE_OFF), perms: { read: true, write: false, execute: true } }],
    sectionAt() { return null; },
    segmentAt() { return null; },
  };
}

test('#8821 review regression: a DT_NEEDED-cached name cannot bypass the dynamic-symbol string budget', () => {
  const fixture = buildAliasedDynsymElf({ records: 8, nameLength: 8192 });
  const view = new DataView(fixture.bytes.buffer);
  const oldNull = DYNAMIC_FILE_OFF + 5 * DYN_ENT;
  view.setBigInt64(oldNull, 1n, true); // DT_NEEDED
  view.setBigUint64(oldNull + 8, 1n, true); // same offset used by st_name
  view.setBigInt64(oldNull + DYN_ENT, 0n, true); // DT_NULL
  view.setBigUint64(oldNull + DYN_ENT + 8, 0n, true);

  const image = blankImage(fixture.bytes);
  parseProgramDynamic(
    new ByteView(fixture.bytes, { littleEndian: true }),
    [{ type: 2, offset: BigInt(DYNAMIC_FILE_OFF), filesz: BigInt(fixture.dynamicLength + DYN_ENT) }],
    image,
    64,
    { dynamicSymbolLimits: { maxStringBytes: 4096 } },
  );

  assert.equal(image.libraries.length, 1, 'DT_NEEDED keeps its existing uncounted bootstrap contract');
  assert.equal(image.libraries[0], 'A'.repeat(8192));
  assert.equal(image.metadata.programDynamicSymbolBudget.stopped, true);
  assert.match(String(image.metadata.programDynamicSymbolBudget.reason), /decoded string bytes exceed 4096/);
  assert.equal(image.symbols.length, 0, 'the budgeted symbol consumer must not receive the cached long name');
  assert.equal(image.imports.length, 0);
});

test('#3989 integration regression: invalid st_name remains diagnostic while the null symbol offset 0 is allowed', () => {
  const fixture = buildAliasedDynsymElf({ records: 2, nameLength: 8 });
  const view = new DataView(fixture.bytes.buffer);
  view.setUint32(fixture.symtabFileOff + 24, fixture.strtabLength + 7, true);
  const image = blankImage(fixture.bytes);
  parseProgramDynamic(
    new ByteView(fixture.bytes, { littleEndian: true }),
    [{ type: 2, offset: BigInt(DYNAMIC_FILE_OFF), filesz: BigInt(fixture.dynamicLength) }],
    image,
    64,
    {},
  );

  const outOfRange = (image.metadata.programDynamicDiagnostics || [])
    .filter((line) => line.includes('dynamic string table reference is out of range'));
  assert.equal(outOfRange.length, 1, 'only the invalid non-zero st_name should be diagnosed');
  assert.equal(image.symbols.length, 0);
});
