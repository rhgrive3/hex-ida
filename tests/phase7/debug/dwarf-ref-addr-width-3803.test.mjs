import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDebugInfo } from '../../../js/analysis/debug/dwarf.js';

// Issue #3803: DW_FORM_ref_addr uses the target address size in DWARF v2,
// but the compilation-unit offset size from DWARF v3 onward. Keeping the
// widths distinct prevents the following attribute stream from desynchronizing.
const abbrev = Uint8Array.from([
  0x01,       // abbrev code = 1
  0x11,       // DW_TAG_compile_unit
  0x00,       // no children
  0x49, 0x10, // DW_AT_type, DW_FORM_ref_addr
  0x03, 0x08, // DW_AT_name, DW_FORM_string
  0x00, 0x00, // attribute terminator
  0x00,       // abbreviation table terminator
]);

function dwarf32Unit(version, addressSize, refAddrBytes) {
  const payload = [
    version & 0xff, (version >>> 8) & 0xff,
    0x00, 0x00, 0x00, 0x00, // abbrev offset
    addressSize,
    0x01,                   // DIE abbrev code
    ...refAddrBytes,
    0x6f, 0x6b, 0x00,       // DW_AT_name = "ok"
  ];
  return Uint8Array.from([
    payload.length & 0xff, (payload.length >>> 8) & 0xff, 0x00, 0x00,
    ...payload,
  ]);
}

function parse(version, addressSize, refAddrBytes) {
  return parseDebugInfo({
    debug_info: dwarf32Unit(version, addressSize, refAddrBytes),
    debug_abbrev: abbrev,
  });
}

test('DWARF2 ref_addr consumes address_size bytes before the next attribute', () => {
  const result = parse(2, 8, [0x08, 0x00, 0x00, 0x00, 0x41, 0x42, 0x43, 0x44]);
  const die = result.dies.get(11);

  assert.equal(result.complete, true);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(die?.attributes.get(0x49)?.value, 0x4443424100000008n);
  assert.equal(die?.attributes.get(0x03)?.value, 'ok');
});

test('DWARF3 ref_addr keeps using the DWARF32 offset size even on a 64-bit target', () => {
  const result = parse(3, 8, [0x08, 0x00, 0x00, 0x00]);
  const die = result.dies.get(11);

  assert.equal(result.complete, true);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(die?.attributes.get(0x49)?.value, 8n);
  assert.equal(die?.attributes.get(0x03)?.value, 'ok');
});
