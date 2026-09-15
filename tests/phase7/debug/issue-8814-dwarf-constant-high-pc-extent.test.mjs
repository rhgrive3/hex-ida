import test from 'node:test';
import assert from 'node:assert/strict';

import { DwarfDebugInfoProvider, parseDebugInfo } from '../../../js/analysis/debug/dwarf.js';

const DW_TAG_compile_unit = 0x11;
const DW_TAG_subprogram = 0x2e;
const DW_AT_name = 0x03;
const DW_AT_low_pc = 0x11;
const DW_AT_high_pc = 0x12;
const DW_FORM_addr = 0x01;
const DW_FORM_string = 0x08;
const DW_FORM_data8 = 0x07;
const DW_FORM_data16 = 0x1e;
const DW_FORM_sdata = 0x0d;
const DW_FORM_udata = 0x0f;

const CONSTANT_EXTENT_DIAGNOSTIC = 'DW_AT_high_pc constant extent exceeds exact size bounds';

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

function cstr(value) {
  return [...new TextEncoder().encode(value), 0];
}

function unit(dieBytes) {
  const body = [
    0x04, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x08,
    ...dieBytes,
  ];
  return Uint8Array.from([...le32(body.length), ...body]);
}

function subprogramAbbrev(highForm) {
  return Uint8Array.from([
    0x01, DW_TAG_compile_unit, 0x01, 0x00, 0x00,
    0x02, DW_TAG_subprogram, 0x00,
    DW_AT_name, DW_FORM_string,
    DW_AT_low_pc, DW_FORM_addr,
    DW_AT_high_pc, highForm,
    0x00, 0x00,
    0x00,
  ]);
}

function sectionsFor(highForm, highBytes, low = 0x1000) {
  return {
    debug_info: unit([
      0x01,
      0x02, ...cstr('target'), ...le64(low), ...highBytes,
      0x00,
    ]),
    debug_abbrev: subprogramAbbrev(highForm),
  };
}

function probe(sections) {
  return new DwarfDebugInfoProvider().probe({
    snapshotId: 'snap-8814',
    identity: {},
    debugSections: sections,
    endian: 'little',
  });
}

test('#8814 a constant-class high_pc above the size domain downgrades the probe and never throws', () => {
  const sections = sectionsFor(DW_FORM_data8, le64(0x0020000000000000n));
  const parsed = parseDebugInfo(sections);
  assert.equal(parsed.complete, false);
  assert.ok(parsed.diagnostics.some((entry) => entry.includes(CONSTANT_EXTENT_DIAGNOSTIC)), parsed.diagnostics.join('; '));

  const provider = new DwarfDebugInfoProvider();
  const result = probe(sections);
  assert.equal(result.status.completeness, 'partial');
  const [record] = provider.symbols(result, {}).records;
  assert.equal(record.name, 'target');
  assert.equal(record.address, '0x1000');
  assert.equal(record.sizeBytes, null);
  assert.equal(record.descriptor.complete, false);
});

test('#8814 the maximum encoded 64-bit constant is handled the same way', () => {
  for (const highBytes of [le64(0xffffffffffffffffn), le64(0x0020000000000001n)]) {
    const provider = new DwarfDebugInfoProvider();
    const result = probe(sectionsFor(DW_FORM_data8, highBytes));
    assert.equal(result.status.completeness, 'partial');
    const [record] = provider.symbols(result, {}).records;
    assert.equal(record.sizeBytes, null);
    assert.equal(record.descriptor.complete, false);
  }
});

test('#8814 an ordinary constant offset keeps its exact size and completeness', () => {
  const provider = new DwarfDebugInfoProvider();
  const result = probe(sectionsFor(DW_FORM_udata, [0x20]));
  assert.equal(result.status.completeness, 'complete');
  const [record] = provider.symbols(result, {}).records;
  assert.equal(record.sizeBytes, 0x20);
  assert.equal(record.descriptor.complete, true);
});

test('#8814 a negative constant extent is unknown evidence, not a coercion', () => {
  // DW_FORM_sdata -1: a constant-class high_pc must not become a negative size.
  const provider = new DwarfDebugInfoProvider();
  const result = probe(sectionsFor(DW_FORM_sdata, [0x7f]));
  assert.equal(result.status.completeness, 'partial');
  assert.ok(result.diagnostics.some((entry) => entry.includes(CONSTANT_EXTENT_DIAGNOSTIC)));
  const [record] = provider.symbols(result, {}).records;
  assert.equal(record.sizeBytes, null);
  assert.equal(record.descriptor.complete, false);
});

test('#8814 a non-numeric constant form cannot stop symbol enumeration', () => {
  // DW_FORM_data16 has no numeric meaning for high_pc; the parsed value is a
  // block, so Number()/BigInt() coercion would throw out of symbols().
  const provider = new DwarfDebugInfoProvider();
  const result = probe(sectionsFor(DW_FORM_data16, new Uint8Array(16)));
  assert.equal(result.status.completeness, 'partial');
  const [record] = provider.symbols(result, {}).records;
  assert.equal(record.sizeBytes, null);
  assert.equal(record.descriptor.complete, false);
});

test('#8814 one unrepresentable extent does not abort the rest of the page', () => {
  const debugAbbrev = Uint8Array.from([
    0x01, DW_TAG_compile_unit, 0x01, 0x00, 0x00,
    0x02, DW_TAG_subprogram, 0x00,
    DW_AT_name, DW_FORM_string,
    DW_AT_low_pc, DW_FORM_addr,
    DW_AT_high_pc, DW_FORM_data8,
    0x00, 0x00,
    0x00,
  ]);
  const die = (name, high) => [0x02, ...cstr(name), ...le64(0x1000), ...le64(high)];
  const sections = {
    debug_info: unit([0x01, ...die('bad', 0x0020000000000000n), ...die('good', 0x10n), 0x00]),
    debug_abbrev: debugAbbrev,
  };
  const provider = new DwarfDebugInfoProvider();
  const result = probe(sections);
  assert.equal(result.status.completeness, 'partial');

  const first = provider.symbols(result, { pageSize: 1 });
  assert.equal(first.records.length, 1);
  assert.equal(first.records[0].name, 'bad');
  assert.equal(first.records[0].sizeBytes, null);
  assert.notEqual(first.nextCursor, null);

  const second = provider.symbols(result, { cursor: first.nextCursor, pageSize: 1 });
  assert.equal(second.records[0].name, 'good');
  assert.equal(second.records[0].sizeBytes, 0x10);
  assert.equal(second.records[0].descriptor.complete, true);
});

test('#8814 a non-address DW_AT_low_pc cannot throw during parse or enumeration', () => {
  // The #4232 repair validated address-class ranges with BigInt(), which throws
  // on a value that is not numeric at all; both paths must fail closed instead.
  const debugAbbrev = Uint8Array.from([
    0x01, DW_TAG_compile_unit, 0x01, 0x00, 0x00,
    0x02, DW_TAG_subprogram, 0x00,
    DW_AT_low_pc, DW_FORM_string,
    DW_AT_high_pc, DW_FORM_addr,
    0x00, 0x00,
    0x00,
  ]);
  const sections = {
    debug_info: unit([0x01, 0x02, ...cstr('no-address'), ...le64(0x2000), 0x00]),
    debug_abbrev: debugAbbrev,
  };
  const parsed = parseDebugInfo(sections);
  assert.equal(parsed.complete, false);
  assert.ok(parsed.diagnostics.some((entry) => entry.includes('DW_AT_low_pc is not an address')));

  const provider = new DwarfDebugInfoProvider();
  const result = probe(sections);
  assert.equal(result.status.completeness, 'partial');
  const [record] = provider.symbols(result, {}).records;
  assert.equal(record.address, null);
  assert.equal(record.sizeBytes, null);
  assert.equal(record.descriptor.complete, false);
});

test('#8814 an absolute range above the size domain still fails closed (#4232 boundary)', () => {
  const provider = new DwarfDebugInfoProvider();
  const result = probe(sectionsFor(DW_FORM_addr, le64(0xfffffffffffffff0n)));
  assert.equal(result.status.completeness, 'partial');
  assert.ok(result.diagnostics.some((entry) => entry.includes('DW_AT_high_pc range exceeds exact size bounds')));
  const [record] = provider.symbols(result, {}).records;
  assert.equal(record.sizeBytes, null);
});
