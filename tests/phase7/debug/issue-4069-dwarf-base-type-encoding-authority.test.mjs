import assert from 'node:assert/strict';
import test from 'node:test';

import { DwarfDebugInfoProvider } from '../../../js/analysis/debug/dwarf.js';

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

const abbrev = Uint8Array.from([
  ...uleb(1), 0x11, 0x01, 0x00, 0x00, // compile_unit, children
  ...uleb(2), 0x34, 0x00,             // variable, no children
    ...uleb(0x03), ...uleb(0x08),     // DW_AT_name / DW_FORM_string
    ...uleb(0x49), ...uleb(0x13),     // DW_AT_type / DW_FORM_ref4
    0x00, 0x00,
  ...uleb(3), 0x24, 0x00,             // base_type, no children
    ...uleb(0x03), ...uleb(0x08),     // DW_AT_name / DW_FORM_string
    ...uleb(0x0b), ...uleb(0x0b),     // DW_AT_byte_size / DW_FORM_data1
    ...uleb(0x3e), ...uleb(0x0b),     // DW_AT_encoding / DW_FORM_data1
    0x00, 0x00,
  ...uleb(4), 0x24, 0x00,             // base_type without DW_AT_encoding
    ...uleb(0x03), ...uleb(0x08),
    ...uleb(0x0b), ...uleb(0x0b),
    0x00, 0x00,
  0x00,
]);

function fixture(encoding, { byteSize = 8, name = 'T', includeEncoding = true } = {}) {
  // DWARF32/v4 header is 11 bytes. Root is @11, variable @12, base type @19.
  const baseOffset = 19;
  const info = Uint8Array.from([
    0, 0, 0, 0,
    0x04, 0x00,
    0, 0, 0, 0,
    0x08,
    0x01,
    0x02, 0x76, 0x00,
    baseOffset, 0, 0, 0,
    includeEncoding ? 0x03 : 0x04,
    ...new TextEncoder().encode(name), 0x00,
    byteSize,
    ...(includeEncoding ? [encoding] : []),
    0x00,
  ]);
  new DataView(info.buffer).setUint32(0, info.length - 4, true);
  return info;
}

function typeFor(encoding = 0, options) {
  const provider = new DwarfDebugInfoProvider();
  const result = provider.probe({
    snapshotId: `snap-4069-${encoding}`,
    identity: {},
    debugSections: {
      '.debug_info': fixture(encoding, options),
      '.debug_abbrev': abbrev,
    },
  });
  const records = provider.types(result).records;
  assert.equal(records.length, 1);
  return records[0].descriptor;
}

test('#4069 keeps supported DW_ATE encodings complete with their existing machine classes', () => {
  for (const [encoding, expectedClass] of [
    [0x02, 'boolean'],
    [0x04, 'float'],
    [0x05, 'integer'],
    [0x06, 'integer'],
    [0x07, 'integer'],
    [0x08, 'integer'],
    [0x0d, 'integer'],
    [0x0e, 'integer'],
  ]) {
    const descriptor = typeFor(encoding);
    assert.equal(descriptor.machine.class, expectedClass, `encoding 0x${encoding.toString(16)}`);
    assert.equal(descriptor.complete, true, `encoding 0x${encoding.toString(16)}`);
  }
});

test('#4069 does not launder standard unsupported DW_ATE_complex_float into complete integer evidence', () => {
  const descriptor = typeFor(0x03, { name: 'complex' });
  assert.deepEqual(descriptor.machine, { widthBits: 64, class: 'unknown' });
  assert.equal(descriptor.complete, false);
});

test('#4069 does not launder other unsupported standard encodings into integer evidence', () => {
  for (const encoding of [0x01, 0x09, 0x0f, 0x10]) {
    const descriptor = typeFor(encoding);
    assert.equal(descriptor.machine.class, 'unknown', `encoding 0x${encoding.toString(16)}`);
    assert.equal(descriptor.complete, false, `encoding 0x${encoding.toString(16)}`);
  }
});

test('#4069 treats unknown vendor encodings as incomplete unknown machine types', () => {
  for (const encoding of [0x80, 0xff]) {
    const descriptor = typeFor(encoding);
    assert.deepEqual(descriptor.machine, { widthBits: 64, class: 'unknown' });
    assert.equal(descriptor.complete, false);
  }
});

test('#4069 does not fabricate an encoding when DW_AT_encoding is absent', () => {
  const descriptor = typeFor(0, { includeEncoding: false, name: 'missing-encoding' });
  assert.deepEqual(descriptor.machine, { widthBits: 64, class: 'unknown' });
  assert.equal(descriptor.complete, false);
});
