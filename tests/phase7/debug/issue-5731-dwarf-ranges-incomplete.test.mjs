import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDebugInfo } from '../../../js/analysis/debug/dwarf.js';

// DW_AT_ranges describes non-contiguous code ranges via
// .debug_rnglists/.debug_ranges. No resolver exists for either format, so a
// DIE locating its code only through a range list must stay incomplete — the
// parse result must never claim completeness while that evidence is
// unresolved, and no address may be fabricated from it (#5731).

function uleb(value) {
  const out = [];
  do { let b = value & 0x7f; value >>>= 7; if (value) b |= 0x80; out.push(b); } while (value);
  return out;
}
const str = (s) => [...new TextEncoder().encode(s), 0];

const abbrev = Uint8Array.from([
  // 1: subprogram: name/string, ranges/sec_offset
  ...uleb(1), 0x2e, 0x00,
    ...uleb(0x03), ...uleb(0x08),   // DW_AT_name, DW_FORM_string
    ...uleb(0x55), ...uleb(0x17),   // DW_AT_ranges, DW_FORM_sec_offset
    0x00, 0x00,
  // 2: subprogram: name/string, low_pc/addr, high_pc/data1 (contiguous control)
  ...uleb(2), 0x2e, 0x00,
    ...uleb(0x03), ...uleb(0x08),   // DW_AT_name, DW_FORM_string
    ...uleb(0x11), ...uleb(0x01),   // DW_AT_low_pc, DW_FORM_addr
    ...uleb(0x12), ...uleb(0x0b),   // DW_AT_high_pc, DW_FORM_data1
    0x00, 0x00,
  0x00,
]);

const addr = (v) => { const out = []; for (let i = 0; i < 8; i++) out.push(Number((v >> BigInt(i * 8)) & 0xffn)); return out; };
const offset32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];

// CU body: first a ranges-only subprogram, then a contiguous one.
const dieRanges = [...uleb(1), ...str('split_fn'), ...offset32(0x40)];
const dieContiguous = [...uleb(2), ...str('plain_fn'), ...addr(0x2000n), 0x10];
const debug_info = Uint8Array.from([
  0, 0, 0, 0,             // unit_length (patched below)
  0x04, 0x00,             // version 4
  0, 0, 0, 0,             // abbrev_offset
  0x08,                   // address_size
  ...dieRanges,
  ...dieContiguous,
]);
new DataView(debug_info.buffer).setUint32(0, debug_info.length - 4, true);

test('#5731: a ranges-only subprogram stays incomplete with a diagnostic', () => {
  const out = parseDebugInfo({ debug_info, debug_abbrev: abbrev });
  assert.equal(out.complete, false, 'unresolved range evidence never reports complete');
  assert.ok(out.diagnostics.some((d) => d.includes('DW_AT_ranges')), JSON.stringify(out.diagnostics));

  const split = [...out.dies.values()].find((d) => d.attributes.get(0x55));
  assert.ok(split, 'the ranges DIE is still present');
  assert.equal(split.complete, false);
  assert.equal(split.attributes.get(0x11), undefined, 'no low_pc is fabricated');
});

test('#5731: contiguous low_pc/high_pc subprograms keep parsing alongside', () => {
  const out = parseDebugInfo({ debug_info, debug_abbrev: abbrev });
  const plain = [...out.dies.values()].find((d) => d.attributes.get(0x11));
  assert.ok(plain, 'the sibling subprogram is still parsed');
  assert.equal(plain.complete, true);
  assert.equal(plain.attributes.get(0x11)?.value, 0x2000n);
});

test('#5731: a CU without any DW_AT_ranges stays complete', () => {
  const dieContiguousOnly = [...uleb(2), ...str('plain_fn'), ...addr(0x2000n), 0x10];
  const info = Uint8Array.from([0, 0, 0, 0, 0x04, 0x00, 0, 0, 0, 0, 8, ...dieContiguousOnly]);
  new DataView(info.buffer).setUint32(0, info.length - 4, true);
  const out = parseDebugInfo({ debug_info: info, debug_abbrev: abbrev });
  assert.equal(out.complete, true);
  assert.deepEqual(out.diagnostics, []);
});
