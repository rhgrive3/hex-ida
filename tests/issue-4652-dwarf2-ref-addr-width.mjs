import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDebugInfo } from '../js/analysis/debug/dwarf.js';

// Issue #4652: DW_FORM_ref_addr width is version-dependent — the target
// address size in DWARF v2, the unit offset size from DWARF v3 on. A v2 CU on
// a 64-bit target encodes an 8-byte ref_addr; reading it at offsetSize=4
// desynchronizes the whole DIE attribute stream.

const abbrev = Uint8Array.from([
  0x01,       // abbrev code = 1
  0x11,       // DW_TAG_compile_unit
  0x00,       // no children
  0x49, 0x10, // DW_AT_type, DW_FORM_ref_addr
  0x03, 0x08, // DW_AT_name, DW_FORM_string
  0x00, 0x00, // attribute terminator
  0x00,       // abbreviation table terminator
]);

function dwarf32Unit(version, addressSize, refAddrBytes, nameBytes) {
  const payload = [
    version & 0xff, (version >>> 8) & 0xff,
    0x00, 0x00, 0x00, 0x00, // abbrev offset
    addressSize,
    0x01,                   // DIE abbrev code
    ...refAddrBytes,
    ...nameBytes,
  ];
  return Uint8Array.from([
    payload.length & 0xff, (payload.length >>> 8) & 0xff, 0x00, 0x00,
    ...payload,
  ]);
}

test('#4652 DWARF2 ref_addr consumes the full 8-byte address on a 64-bit target', () => {
  const result = parseDebugInfo({
    debug_info: dwarf32Unit(2, 8,
      [0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11],
      [0x78, 0x00]),
    debug_abbrev: abbrev,
  });
  const die = result.dies.get(11);

  assert.equal(result.complete, true);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(die?.attributes.get(0x49)?.value, 0x1122334455667788n,
    'DWARF v2 ref_addr must read address_size bytes');
  assert.equal(die?.attributes.get(0x03)?.value, 'x',
    'the next attribute must stay aligned after an 8-byte ref_addr');
});

test('#4652 DWARF4 ref_addr keeps the DWARF32 offset size on the same 64-bit target', () => {
  const result = parseDebugInfo({
    debug_info: dwarf32Unit(4, 8,
      [0x08, 0x00, 0x00, 0x00],
      [0x78, 0x00]),
    debug_abbrev: abbrev,
  });
  const die = result.dies.get(11);

  assert.equal(result.complete, true);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(die?.attributes.get(0x49)?.value, 8n);
  assert.equal(die?.attributes.get(0x03)?.value, 'x');
});
