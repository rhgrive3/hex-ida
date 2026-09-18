import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDebugInfo } from '../../../js/analysis/debug/dwarf.js';

const DW_UT = Object.freeze({ compile: 0x01, splitCompile: 0x05 });

function le32(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function le64(value) {
  let current = BigInt(value);
  const out = [];
  for (let index = 0; index < 8; index += 1) {
    out.push(Number(current & 0xffn));
    current >>= 8n;
  }
  return out;
}

function abbrev({ withBase }) {
  return Uint8Array.from([
    0x01,       // abbrev code = 1
    0x11,       // DW_TAG_compile_unit
    0x00,       // no children
    ...(withBase ? [0x72, 0x17] : []), // DW_AT_str_offsets_base, DW_FORM_sec_offset
    0x03, 0x25, // DW_AT_name, DW_FORM_strx1
    0x00, 0x00,
    0x00,
  ]);
}

function dwarf5Unit({ offsetSize = 4, unitType = DW_UT.compile, base = null, strx = 0 }) {
  const splitHeader = unitType === DW_UT.splitCompile ? le64(0x0102030405060708n) : [];
  const die = [
    0x01,
    ...(base == null ? [] : (offsetSize === 8 ? le64(base) : le32(base))),
    strx,
  ];
  const common = [0x05, 0x00, unitType, 0x08, ...(offsetSize === 8 ? le64(0) : le32(0))];
  const body = [...common, ...splitHeader, ...die];
  return Uint8Array.from(offsetSize === 8
    ? [0xff, 0xff, 0xff, 0xff, ...le64(body.length), ...body]
    : [...le32(body.length), ...body]);
}

function strOffsetsTable({ offsetSize = 4, version = 5, padding = 0, entries = [1n], truncateTo = null }) {
  const encodedEntries = entries.flatMap((entry) => offsetSize === 8 ? le64(entry) : le32(Number(entry)));
  const payload = [version & 0xff, (version >>> 8) & 0xff, padding & 0xff, (padding >>> 8) & 0xff, ...encodedEntries];
  const bytes = offsetSize === 8
    ? [0xff, 0xff, 0xff, 0xff, ...le64(payload.length), ...payload]
    : [...le32(payload.length), ...payload];
  return Uint8Array.from(truncateTo == null ? bytes : bytes.slice(0, truncateTo));
}

function parse({ offsetSize = 4, unitType = DW_UT.compile, base = null, table, strings = '\0right\0wrong\0' }) {
  return parseDebugInfo({
    debug_info: dwarf5Unit({ offsetSize, unitType, base }),
    debug_abbrev: abbrev({ withBase: base != null }),
    debug_str_offsets: table,
    debug_str: Buffer.from(strings, 'utf8'),
  });
}

function rootDie(result) {
  return [...result.dies.values()][0];
}

test('DWARF32 explicit str_offsets_base resolves the first entry', () => {
  const result = parse({ base: 8, table: strOffsetsTable({ entries: [1n] }) });
  assert.equal(rootDie(result)?.attributes.get(0x03)?.value, 'right');
  assert.equal(rootDie(result)?.complete, true);
});

test('DWARF64 explicit str_offsets_base=16 resolves an 8-byte entry', () => {
  const result = parse({ offsetSize: 8, base: 16, table: strOffsetsTable({ offsetSize: 8, entries: [1n] }) });
  assert.equal(rootDie(result)?.attributes.get(0x03)?.value, 'right');
  assert.equal(rootDie(result)?.complete, true);
});

test('DWARF64 split compile may derive the implicit base from its validated contribution header', () => {
  const result = parse({
    offsetSize: 8,
    unitType: DW_UT.splitCompile,
    table: strOffsetsTable({ offsetSize: 8, entries: [1n] }),
  });
  assert.equal(rootDie(result)?.attributes.get(0x03)?.value, 'right');
  assert.equal(rootDie(result)?.complete, true);
});

test('a normal CU with missing str_offsets_base fails closed instead of assuming 8', () => {
  const result = parse({ table: strOffsetsTable({ entries: [1n] }) });
  assert.equal(rootDie(result)?.attributes.get(0x03)?.value, null);
  assert.equal(rootDie(result)?.complete, false);
  assert.equal(result.complete, false);
  assert.ok(result.diagnostics.some((item) => item.includes('unresolved DW_FORM_strx')));
});

test('an implicit split base rejects a malformed contribution version', () => {
  const result = parse({
    unitType: DW_UT.splitCompile,
    table: strOffsetsTable({ version: 4, entries: [1n] }),
  });
  assert.equal(rootDie(result)?.attributes.get(0x03)?.value, null);
  assert.equal(rootDie(result)?.complete, false);
  assert.equal(result.complete, false);
});

test('an implicit split base rejects non-zero contribution padding', () => {
  const result = parse({
    unitType: DW_UT.splitCompile,
    table: strOffsetsTable({ padding: 1, entries: [1n] }),
  });
  assert.equal(rootDie(result)?.attributes.get(0x03)?.value, null);
  assert.equal(rootDie(result)?.complete, false);
  assert.equal(result.complete, false);
});

test('an implicit split base rejects a truncated contribution', () => {
  const result = parse({
    unitType: DW_UT.splitCompile,
    table: strOffsetsTable({ entries: [1n], truncateTo: 10 }),
  });
  assert.equal(rootDie(result)?.attributes.get(0x03)?.value, null);
  assert.equal(rootDie(result)?.complete, false);
  assert.equal(result.complete, false);
});

test('an explicit base must name the first entry of a valid matching-format contribution', () => {
  const malformed = strOffsetsTable({ version: 4, entries: [1n] });
  const result = parse({ base: 8, table: malformed });
  assert.equal(rootDie(result)?.attributes.get(0x03)?.value, null);
  assert.equal(rootDie(result)?.complete, false);
  assert.equal(result.complete, false);
});

test('an explicit base can select a later contribution even when an earlier CU uses the other DWARF format', () => {
  const first = strOffsetsTable({ entries: [8n] });
  const second = strOffsetsTable({ offsetSize: 8, entries: [1n] });
  const combined = Uint8Array.from([...first, ...second]);
  const secondBase = first.length + 16;
  const result = parse({ offsetSize: 8, base: secondBase, table: combined });
  assert.equal(rootDie(result)?.attributes.get(0x03)?.value, 'right');
  assert.equal(rootDie(result)?.complete, true);
});

test('an explicit base whose contribution format disagrees with the CU fails closed', () => {
  const result = parse({ offsetSize: 8, base: 8, table: strOffsetsTable({ entries: [1n] }) });
  assert.equal(rootDie(result)?.attributes.get(0x03)?.value, null);
  assert.equal(rootDie(result)?.complete, false);
  assert.equal(result.complete, false);
});

test('embedded entry bytes cannot impersonate a contribution header for an interior explicit base', () => {
  const table = Uint8Array.from([
    ...le32(20), 0x05, 0x00, 0x00, 0x00, // real contribution: entries start at 8, end at 24
    ...le32(8), 0x05, 0x00, 0x00, 0x00,  // fake header embedded in real entries at 8
    ...le32(1),                           // fake entry would resolve to "right"
    ...le32(0),
  ]);
  const result = parse({ base: 16, table });
  assert.equal(rootDie(result)?.attributes.get(0x03)?.value, null);
  assert.equal(rootDie(result)?.complete, false);
  assert.equal(result.complete, false);
});

test('a resolved string offset that is out of range still fails closed', () => {
  const result = parse({ base: 8, table: strOffsetsTable({ entries: [0xffffn] }) });
  assert.equal(rootDie(result)?.attributes.get(0x03)?.value, null);
  assert.equal(rootDie(result)?.complete, false);
  assert.equal(result.complete, false);
});
