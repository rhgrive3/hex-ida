import assert from 'node:assert/strict';
import test from 'node:test';

import { DwarfDebugInfoProvider, parseDebugInfo } from '../../../js/analysis/debug/dwarf.js';

function uleb(value) {
  const out = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    out.push(byte);
  } while (value);
  return out;
}

function littleEndian(value, width) {
  const number = BigInt(value);
  return Array.from({ length: width }, (_, index) => Number((number >> BigInt(index * 8)) & 0xffn));
}

const DW_AT_name = 0x03;
const DW_AT_byte_size = 0x0b;
const DW_AT_encoding = 0x3e;
const DW_AT_type = 0x49;
const DW_FORM_string = 0x08;
const DW_FORM_data1 = 0x0b;
const DW_FORM_ref_addr = 0x10;
const DW_FORM_ref4 = 0x13;
const DW_FORM_indirect = 0x16;
const DW_FORM_ref_sig8 = 0x20;

function abbrevForTypeForm(typeForm) {
  return Uint8Array.from([
    ...uleb(1), ...uleb(0x11), 0x01, 0x00, 0x00, // compile_unit, children
    ...uleb(2), ...uleb(0x34), 0x00,             // variable
      ...uleb(DW_AT_name), ...uleb(DW_FORM_string),
      ...uleb(DW_AT_type), ...uleb(typeForm),
      0x00, 0x00,
    ...uleb(3), ...uleb(0x24), 0x00,             // base_type
      ...uleb(DW_AT_name), ...uleb(DW_FORM_string),
      ...uleb(DW_AT_byte_size), ...uleb(DW_FORM_data1),
      ...uleb(DW_AT_encoding), ...uleb(DW_FORM_data1),
      0x00, 0x00,
    0x00,
  ]);
}

function dwarf5Header(body) {
  const info = Uint8Array.from([
    0, 0, 0, 0,
    0x05, 0x00, // version 5
    0x01,       // DW_UT_compile
    0x08,       // address_size
    0, 0, 0, 0, // abbrev offset
    ...body,
  ]);
  new DataView(info.buffer).setUint32(0, info.length - 4, true);
  return info;
}

function collisionFixture(typeForm, { indirectActualForm = null } = {}) {
  const encodedForm = indirectActualForm ?? typeForm;
  const valueWidth = encodedForm === DW_FORM_ref_sig8 ? 8 : 4;
  const variablePrefix = [0x02, 0x76, 0x00]; // variable + "v\0"
  const indirectPrefix = typeForm === DW_FORM_indirect ? uleb(encodedForm) : [];
  const localBaseOffset = 12 + 1 + variablePrefix.length + indirectPrefix.length + valueWidth;
  const body = [
    0x01,
    ...variablePrefix,
    ...indirectPrefix,
    ...littleEndian(localBaseOffset, valueWidth),
    0x03, ...new TextEncoder().encode('WrongLocal'), 0x00, 0x04, 0x05,
    0x00,
  ];
  return { info: dwarf5Header(body), abbrev: abbrevForTypeForm(typeForm), localBaseOffset };
}

function probeFixture(fixture, snapshotId) {
  const provider = new DwarfDebugInfoProvider();
  const result = provider.probe({
    snapshotId,
    identity: {},
    debugSections: {
      '.debug_info': fixture.info,
      '.debug_abbrev': fixture.abbrev,
    },
  });
  return { provider, result };
}

test('#4240 ref_sig8 never resolves a type signature against a colliding current .debug_info DIE offset', () => {
  const fixture = collisionFixture(DW_FORM_ref_sig8);
  const { provider, result } = probeFixture(fixture, 'ref-sig8-collision');
  const records = provider.types(result).records;

  assert.equal(result.parsed.dies.has(fixture.localBaseOffset), true, 'a local collision target exists');
  assert.equal(records.length, 1);
  assert.equal(records[0].descriptor.claim.name, 'unknown');
  assert.equal(records[0].descriptor.machine, null);
  assert.equal(records[0].descriptor.complete, false);
  assert.equal(result.status.completeness, 'partial');
  assert.ok(result.diagnostics.some((message) => message.includes('unsupported form 0x20')));
});

test('#4240 ref_sig8 consumes its full eight-byte payload and keeps the following DIE synchronized', () => {
  const fixture = collisionFixture(DW_FORM_ref_sig8);
  const parsed = parseDebugInfo({ debug_info: fixture.info, debug_abbrev: fixture.abbrev });
  const variable = parsed.dies.get(13);
  const following = parsed.dies.get(fixture.localBaseOffset);

  assert.ok(variable);
  assert.equal(variable.attributes.get(DW_AT_type)?.value, null);
  assert.equal(variable.complete, false);
  assert.ok(following);
  assert.equal(following.attributes.get(DW_AT_name)?.value, 'WrongLocal');
});

test('#4240 DW_FORM_indirect cannot disguise ref_sig8 as a current-object offset', () => {
  const fixture = collisionFixture(DW_FORM_indirect, { indirectActualForm: DW_FORM_ref_sig8 });
  const { provider, result } = probeFixture(fixture, 'ref-sig8-indirect');
  const record = provider.types(result).records[0];

  assert.ok(record);
  assert.equal(result.parsed.dies.has(fixture.localBaseOffset), true);
  assert.equal(record.descriptor.claim.name, 'unknown');
  assert.equal(record.descriptor.complete, false);
  assert.ok(result.diagnostics.some((message) => message.includes('unsupported form 0x16')));
});

test('#4240 ordinary ref4 references keep resolving in the current compilation unit', () => {
  const fixture = collisionFixture(DW_FORM_ref4);
  const { provider, result } = probeFixture(fixture, 'ref4-control');
  const record = provider.types(result).records[0];

  assert.ok(record);
  assert.equal(record.descriptor.claim.name, 'WrongLocal');
  assert.deepEqual(record.descriptor.machine, { widthBits: 32, class: 'integer' });
  assert.equal(record.descriptor.complete, true);
});

test('#4240 ordinary ref_addr references keep resolving in the current .debug_info section', () => {
  const fixture = collisionFixture(DW_FORM_ref_addr);
  const { provider, result } = probeFixture(fixture, 'ref-addr-control');
  const record = provider.types(result).records[0];

  assert.ok(record);
  assert.equal(record.descriptor.claim.name, 'WrongLocal');
  assert.deepEqual(record.descriptor.machine, { widthBits: 32, class: 'integer' });
  assert.equal(record.descriptor.complete, true);
});

test('#4240 truncated ref_sig8 payload fails closed instead of escaping the parser', () => {
  const abbrev = abbrevForTypeForm(DW_FORM_ref_sig8);
  const info = dwarf5Header([
    0x01,
    0x02, 0x76, 0x00,
    0x12, 0x34, 0x56, // eight-byte signature is truncated inside the unit
  ]);
  const parsed = parseDebugInfo({ debug_info: info, debug_abbrev: abbrev });

  assert.equal(parsed.complete, false);
  assert.ok(parsed.diagnostics.some((message) => message.includes('read past unit boundary')));
});

test('#4240 ref_sig8 in DW_AT_specification cannot inherit from a colliding local declaration', () => {
  const DW_AT_specification = 0x47;
  const DW_AT_low_pc = 0x11;
  const DW_AT_high_pc = 0x12;
  const DW_FORM_addr = 0x01;
  const abbrev = Uint8Array.from([
    ...uleb(1), ...uleb(0x11), 0x01, 0x00, 0x00,
    ...uleb(2), ...uleb(0x2e), 0x00,
      ...uleb(DW_AT_specification), ...uleb(DW_FORM_ref_sig8),
      ...uleb(DW_AT_low_pc), ...uleb(DW_FORM_addr),
      ...uleb(DW_AT_high_pc), ...uleb(DW_FORM_data1),
      0x00, 0x00,
    ...uleb(3), ...uleb(0x2e), 0x00,
      ...uleb(DW_AT_name), ...uleb(DW_FORM_string),
      0x00, 0x00,
    0x00,
  ]);
  const localDeclarationOffset = 12 + 1 + 1 + 8 + 8 + 1;
  const info = dwarf5Header([
    0x01,
    0x02,
    ...littleEndian(localDeclarationOffset, 8),
    ...littleEndian(0x1000, 8),
    0x10,
    0x03, ...new TextEncoder().encode('WrongSpec'), 0x00,
    0x00,
  ]);
  const provider = new DwarfDebugInfoProvider();
  const result = provider.probe({
    snapshotId: 'ref-sig8-specification-collision',
    identity: {},
    debugSections: { '.debug_info': info, '.debug_abbrev': abbrev },
  });
  const definition = provider.symbols(result).records.find((record) => record.address === '0x1000');

  assert.ok(definition);
  assert.equal(result.parsed.dies.has(localDeclarationOffset), true);
  assert.equal(definition.name, null);
  assert.equal(definition.descriptor.complete, false);
  assert.equal(result.status.completeness, 'partial');
});
