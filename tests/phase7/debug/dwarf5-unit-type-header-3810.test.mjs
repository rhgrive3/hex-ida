import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDebugInfo } from '../../../js/analysis/debug/dwarf.js';

const abbrev = Uint8Array.from([
  0x01, 0x24, 0x00, // abbrev 1: DW_TAG_base_type, no children
  0x00, 0x00,       // no attributes
  0x00,             // abbreviation table terminator
]);

const DW_UT = {
  compile: 0x01,
  type: 0x02,
  partial: 0x03,
  skeleton: 0x04,
  splitCompile: 0x05,
  splitType: 0x06,
};

function le32(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function le64(value) {
  let remaining = BigInt(value);
  const bytes = [];
  for (let index = 0; index < 8; index += 1) {
    bytes.push(Number(remaining & 0xffn));
    remaining >>= 8n;
  }
  return bytes;
}

function dwarf5Unit({ unitType, offsetSize = 4, extraHeader = [], die = [0x01] }) {
  const commonHeader = [
    0x05, 0x00, // version 5
    unitType,
    0x08,       // address size
    ...(offsetSize === 8 ? le64(0n) : le32(0)), // abbrev offset
  ];
  const payload = [...commonHeader, ...extraHeader, ...die];
  return Uint8Array.from(offsetSize === 8
    ? [0xff, 0xff, 0xff, 0xff, ...le64(BigInt(payload.length)), ...payload]
    : [...le32(payload.length), ...payload]);
}

function parse(info) {
  return parseDebugInfo({ debug_info: info, debug_abbrev: abbrev });
}

function typeHeader(offsetSize) {
  const dieOffset = offsetSize === 8 ? 40 : 24;
  return [
    ...le64(0x1122334455667788n),
    ...(offsetSize === 8 ? le64(BigInt(dieOffset)) : le32(dieOffset)),
  ];
}

test('DWARF5 consumes unit_type-specific headers before the first DIE', () => {
  const cases = [
    { name: 'compile', unitType: DW_UT.compile, offsetSize: 4, extraHeader: [], dieOffset: 12 },
    { name: 'partial', unitType: DW_UT.partial, offsetSize: 4, extraHeader: [], dieOffset: 12 },
    { name: 'type DWARF32', unitType: DW_UT.type, offsetSize: 4, extraHeader: typeHeader(4), dieOffset: 24 },
    { name: 'type DWARF64', unitType: DW_UT.type, offsetSize: 8, extraHeader: typeHeader(8), dieOffset: 40 },
    { name: 'skeleton', unitType: DW_UT.skeleton, offsetSize: 4, extraHeader: le64(0x8877665544332211n), dieOffset: 20 },
    { name: 'split compile', unitType: DW_UT.splitCompile, offsetSize: 4, extraHeader: le64(0x0102030405060708n), dieOffset: 20 },
    { name: 'split type', unitType: DW_UT.splitType, offsetSize: 4, extraHeader: typeHeader(4), dieOffset: 24 },
  ];

  for (const fixture of cases) {
    const result = parse(dwarf5Unit(fixture));
    assert.equal(result.complete, true, fixture.name);
    assert.deepEqual(result.diagnostics, [], fixture.name);
    assert.deepEqual([...result.dies.keys()], [fixture.dieOffset], fixture.name);
    assert.equal(result.dies.get(fixture.dieOffset)?.tag, 0x24, fixture.name);
  }
});

test('truncated DWARF5 unit_type-specific headers fail closed', () => {
  const cases = [
    { name: 'type DWARF32', unitType: DW_UT.type, offsetSize: 4, extraHeader: typeHeader(4) },
    { name: 'type DWARF64', unitType: DW_UT.type, offsetSize: 8, extraHeader: typeHeader(8) },
    { name: 'skeleton', unitType: DW_UT.skeleton, offsetSize: 4, extraHeader: le64(1n) },
    { name: 'split compile', unitType: DW_UT.splitCompile, offsetSize: 4, extraHeader: le64(1n) },
    { name: 'split type', unitType: DW_UT.splitType, offsetSize: 4, extraHeader: typeHeader(4) },
  ];

  for (const fixture of cases) {
    const truncated = fixture.extraHeader.slice(0, -1);
    const result = parse(dwarf5Unit({ ...fixture, extraHeader: truncated, die: [] }));
    assert.equal(result.complete, false, fixture.name);
    assert.equal(result.dies.size, 0, fixture.name);
    assert.deepEqual(result.diagnostics, ['truncated DWARF5 unit header at 0x0'], fixture.name);
  }
});
