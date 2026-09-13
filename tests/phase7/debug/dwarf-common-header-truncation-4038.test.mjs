import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDebugInfo } from '../../../js/analysis/debug/dwarf.js';

const abbrev = Uint8Array.from([
  0x01, 0x11, 0x00, // abbrev 1: DW_TAG_compile_unit, no children
  0x00, 0x00,       // no attributes
  0x00,             // table terminator
]);

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

function parse(debugInfo, options = {}) {
  return parseDebugInfo({ debug_info: Uint8Array.from(debugInfo), debug_abbrev: abbrev }, undefined, options);
}

function validDwarf4Unit() {
  const payload = [
    0x04, 0x00,             // version 4
    0x00, 0x00, 0x00, 0x00, // abbrev offset 0
    0x08,                   // address size
    0x01,                   // one base-type DIE
  ];
  return [...le32(payload.length), ...payload];
}

function validDwarf5Unit({ offsetSize = 4 } = {}) {
  const payload = [
    0x05, 0x00, // version 5
    0x01,       // DW_UT_compile
    0x08,       // address size
    ...(offsetSize === 8 ? le64(0n) : le32(0)),
    0x01,       // one base-type DIE
  ];
  return offsetSize === 8
    ? [0xff, 0xff, 0xff, 0xff, ...le64(BigInt(payload.length)), ...payload]
    : [...le32(payload.length), ...payload];
}

test('issue 4038: a DWARF32 v5 unit shorter than its common header fails closed', () => {
  const debugInfo = [
    0x07, 0x00, 0x00, 0x00, // unit_length = 7 -> unit end 11
    0x05, 0x00,             // version 5
    0x01,                   // DW_UT_compile
    0x08,                   // address size
    0x00, 0x00, 0x00,       // abbrev offset is one byte short
  ];

  const result = parse(debugInfo);
  assert.equal(result.complete, false);
  assert.equal(result.dies.size, 0);
  assert.equal(result.units.length, 0);
  assert.deepEqual(result.diagnostics, ['truncated compilation unit at 0x0']);
});

test('issue 4038: a unit too short to contain a version does not consume the following unit', () => {
  const shortUnit = [
    0x01, 0x00, 0x00, 0x00, // unit_length = 1 -> only half of the version field
    0x04,
  ];
  const following = validDwarf4Unit();

  const result = parse([...shortUnit, ...following]);
  assert.equal(result.complete, false);
  assert.deepEqual(result.diagnostics, ['truncated compilation unit at 0x0']);
  assert.equal(result.units.length, 1);
  assert.equal(result.units[0].start, shortUnit.length);
});

test('issue 4038: a short DWARF4 common header does not consume the following unit', () => {
  const shortUnit = [
    0x06, 0x00, 0x00, 0x00, // unit_length = 6 -> no address-size byte
    0x04, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ];
  const following = validDwarf4Unit();

  const result = parse([...shortUnit, ...following]);
  assert.equal(result.complete, false);
  assert.deepEqual(result.diagnostics, ['truncated compilation unit at 0x0']);
  assert.equal(result.units.length, 1, 'the following compilation unit must remain independently parseable');
  assert.equal(result.units[0].start, shortUnit.length);
  assert.equal(result.dies.has(shortUnit.length + 11), true);
});

test('issue 4038: a DWARF64 v5 unit with a truncated common header fails closed', () => {
  const payload = [
    0x05, 0x00,
    0x01,
    0x08,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 7/8 abbrev-offset bytes
  ];
  const debugInfo = [
    0xff, 0xff, 0xff, 0xff,
    ...le64(BigInt(payload.length)),
    ...payload,
  ];

  const result = parse(debugInfo);
  assert.equal(result.complete, false);
  assert.equal(result.dies.size, 0);
  assert.equal(result.units.length, 0);
  assert.deepEqual(result.diagnostics, ['truncated compilation unit at 0x0']);
});

test('issue 4038: valid minimal DWARF32 and DWARF64 v5 common headers still parse', () => {
  for (const offsetSize of [4, 8]) {
    const result = parse(validDwarf5Unit({ offsetSize }));
    assert.equal(result.complete, true, `offset size ${offsetSize}`);
    assert.deepEqual(result.diagnostics, [], `offset size ${offsetSize}`);
    assert.equal(result.units.length, 1, `offset size ${offsetSize}`);
    assert.equal(result.dies.size, 1, `offset size ${offsetSize}`);
  }
});

test('issue 4038: cancellation still wins before malformed common-header decoding', () => {
  const controller = new AbortController();
  controller.abort('cancel-before-parse');
  const malformed = [
    0x07, 0x00, 0x00, 0x00,
    0x05, 0x00,
    0x01,
    0x08,
    0x00, 0x00, 0x00,
  ];

  const result = parse(malformed, { signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.equal(result.complete, false);
  assert.deepEqual(result.diagnostics, ['debug parse cancelled']);
});
