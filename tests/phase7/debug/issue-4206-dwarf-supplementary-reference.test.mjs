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

const DW_AT_name = 0x03;
const DW_AT_type = 0x49;
const DW_AT_specification = 0x47;
const DW_AT_low_pc = 0x11;
const DW_AT_high_pc = 0x12;
const DW_AT_byte_size = 0x0b;
const DW_AT_encoding = 0x3e;
const DW_FORM_addr = 0x01;
const DW_FORM_string = 0x08;
const DW_FORM_data1 = 0x0b;
const DW_FORM_ref_sup4 = 0x1c;
const DW_FORM_strp_sup = 0x1d;
const DW_FORM_ref_sup8 = 0x24;

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

function collisionFixture(typeForm) {
  const refWidth = typeForm === DW_FORM_ref_sup8 ? 8 : 4;
  const variablePrefix = [0x02, 0x76, 0x00];
  const localBaseOffset = 12 + 1 + variablePrefix.length + refWidth;
  const reference = Array.from({ length: refWidth }, (_, index) => Number((BigInt(localBaseOffset) >> BigInt(index * 8)) & 0xffn));
  const info = dwarf5Header([
    0x01,
    ...variablePrefix,
    ...reference,
    0x03, ...new TextEncoder().encode('WrongLocal'), 0x00, 0x04, 0x05,
    0x00,
  ]);
  return { info, abbrev: abbrevForTypeForm(typeForm), localBaseOffset };
}

function providerType(typeForm) {
  const fixture = collisionFixture(typeForm);
  const provider = new DwarfDebugInfoProvider();
  const result = provider.probe({
    snapshotId: `supplementary-${typeForm}`,
    identity: {},
    debugSections: {
      '.debug_info': fixture.info,
      '.debug_abbrev': fixture.abbrev,
    },
  });
  const records = provider.types(result).records;
  assert.equal(records.length, 1);
  return { result, record: records[0], fixture };
}

for (const [name, form] of [['ref_sup4', DW_FORM_ref_sup4], ['ref_sup8', DW_FORM_ref_sup8]]) {
  test(`#4206 ${name} never resolves a supplementary offset against the current .debug_info namespace`, () => {
    const { result, record, fixture } = providerType(form);
    assert.equal(result.parsed.dies.has(fixture.localBaseOffset), true, 'collision target exists in current object');
    assert.equal(record.descriptor.claim.name, 'unknown');
    assert.equal(record.descriptor.machine, null);
    assert.equal(record.descriptor.complete, false);
    assert.equal(result.status.completeness, 'partial');
    assert.ok(result.diagnostics.some((message) => message.includes(`unsupported form 0x${form.toString(16)}`)));
  });
}

test('#4206 strp_sup is consumed but remains unsupported without a supplementary string namespace', () => {
  const abbrev = Uint8Array.from([
    ...uleb(1), ...uleb(0x11), 0x01, 0x00, 0x00,
    ...uleb(2), ...uleb(0x34), 0x00,
      ...uleb(DW_AT_name), ...uleb(DW_FORM_strp_sup),
      0x00, 0x00,
    ...uleb(3), ...uleb(0x24), 0x00,
      ...uleb(DW_AT_name), ...uleb(DW_FORM_string),
      ...uleb(DW_AT_byte_size), ...uleb(DW_FORM_data1),
      ...uleb(DW_AT_encoding), ...uleb(DW_FORM_data1),
      0x00, 0x00,
    0x00,
  ]);
  const info = dwarf5Header([
    0x01,
    0x02, 0x00, 0x00, 0x00, 0x00, // supplementary string offset 0
    0x03, ...new TextEncoder().encode('AfterSupString'), 0x00, 0x04, 0x05,
    0x00,
  ]);
  const parsed = parseDebugInfo({ debug_info: info, debug_abbrev: abbrev, debug_str: new TextEncoder().encode('WrongLocal\0') });
  const variable = parsed.dies.get(13);
  assert.ok(variable);
  assert.equal(variable.attributes.get(DW_AT_name)?.value, null);
  assert.equal(variable.complete, false);
  assert.ok([...parsed.dies.values()].some((die) => die.offset > 13 && die.attributes.get(DW_AT_name)?.value === 'AfterSupString'), 'cursor remains synchronized after strp_sup payload');
  assert.ok(parsed.diagnostics.some((message) => message.includes('unsupported form 0x1d')));
});


test('#4206 supplementary DW_AT_specification cannot inherit attributes from a colliding local DIE', () => {
  const abbrev = Uint8Array.from([
    ...uleb(1), ...uleb(0x11), 0x01, 0x00, 0x00,
    ...uleb(2), ...uleb(0x2e), 0x00, // defining subprogram
      ...uleb(DW_AT_specification), ...uleb(DW_FORM_ref_sup4),
      ...uleb(DW_AT_low_pc), ...uleb(DW_FORM_addr),
      ...uleb(DW_AT_high_pc), ...uleb(DW_FORM_data1),
      0x00, 0x00,
    ...uleb(3), ...uleb(0x2e), 0x00, // local declaration that must not be used
      ...uleb(DW_AT_name), ...uleb(DW_FORM_string),
      0x00, 0x00,
    0x00,
  ]);
  const localDeclarationOffset = 12 + 1 + 1 + 4 + 8 + 1;
  const info = dwarf5Header([
    0x01,
    0x02,
    localDeclarationOffset, 0x00, 0x00, 0x00,
    0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x10,
    0x03, ...new TextEncoder().encode('WrongSpec'), 0x00,
    0x00,
  ]);
  const provider = new DwarfDebugInfoProvider();
  const result = provider.probe({
    snapshotId: 'supplementary-specification',
    identity: {},
    debugSections: { '.debug_info': info, '.debug_abbrev': abbrev },
  });
  const definition = provider.symbols(result).records.find((record) => record.address === '0x1000');
  assert.ok(definition);
  assert.equal(definition.name, null);
  assert.equal(definition.descriptor.complete, false);
  assert.equal(result.status.completeness, 'partial');
});

test('#4206 truncated supplementary reference payload fails closed without escaping the parser', () => {
  const abbrev = abbrevForTypeForm(DW_FORM_ref_sup8);
  const info = dwarf5Header([
    0x01,
    0x02, 0x76, 0x00,
    0x12, 0x34, // ref_sup8 payload is truncated inside the declared unit
  ]);
  const parsed = parseDebugInfo({ debug_info: info, debug_abbrev: abbrev });
  assert.equal(parsed.complete, false);
  assert.ok(parsed.diagnostics.some((message) => /read past unit boundary/.test(message)));
});

test('#4206 DW_FORM_indirect cannot disguise a supplementary reference as a current-object offset', () => {
  const DW_FORM_indirect = 0x16;
  const abbrev = abbrevForTypeForm(DW_FORM_indirect);
  const localBaseOffset = 12 + 1 + 1 + 2 + 1 + 4; // root + variable code/name + actual-form ULEB + ref_sup4 payload
  const info = dwarf5Header([
    0x01,
    0x02, 0x76, 0x00,
    DW_FORM_ref_sup4,
    localBaseOffset, 0x00, 0x00, 0x00,
    0x03, ...new TextEncoder().encode('WrongIndirectLocal'), 0x00, 0x04, 0x05,
    0x00,
  ]);
  const provider = new DwarfDebugInfoProvider();
  const result = provider.probe({
    snapshotId: 'supplementary-indirect',
    identity: {},
    debugSections: { '.debug_info': info, '.debug_abbrev': abbrev },
  });
  const record = provider.types(result).records[0];
  assert.ok(record);
  assert.equal(result.parsed.dies.has(localBaseOffset), true);
  assert.equal(record.descriptor.claim.name, 'unknown');
  assert.equal(record.descriptor.complete, false);
  assert.ok(result.diagnostics.some((message) => message.includes('unsupported form 0x16')));
});
