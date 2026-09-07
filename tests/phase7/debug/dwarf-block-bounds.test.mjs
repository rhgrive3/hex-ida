import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDebugInfo } from '../../../js/analysis/debug/dwarf.js';

// Issue #1860: a DW_FORM_block*/exprloc/data16 payload that declares more bytes
// than the compilation unit holds must fail closed. Cursor.slice() clamped
// silently, so the DIE and the whole parse reported complete:true and a
// following unit's bytes could be swallowed as attribute payload.
const abbrev = Uint8Array.from([
  0x01,       // abbrev code = 1
  0x11,       // DW_TAG_compile_unit
  0x00,       // no children
  0x02, 0x0a, // DW_AT_location, DW_FORM_block1
  0x00, 0x00, // attribute terminator
  0x00,
]);

const unit = (bytes) => Uint8Array.from([bytes.length & 0xff, 0, 0, 0, ...bytes]);

test('a block1 payload that overruns the unit boundary fails closed', () => {
  // unit_length=9: header 7 + DIE code 0x01 + block1 length 0x20, payload missing.
  const info = Uint8Array.from([0x09, 0, 0, 0, 0x04, 0x00, 0, 0, 0, 0, 0x08, 0x01, 0x20]);
  const result = parseDebugInfo({ debug_info: info, debug_abbrev: abbrev });
  assert.equal(result.complete, false, 'the parse must not claim completeness');
  assert.ok(result.diagnostics.some((d) => /read past unit boundary/.test(d)), 'a truncation diagnostic is recorded');
  assert.equal(result.dies.has(11), false, 'the truncated DIE is not published as complete');
});

test('a valid in-unit block payload still parses complete', () => {
  const body = [0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x01, 0x01, 0xAA];
  const info = unit(body);
  const result = parseDebugInfo({ debug_info: info, debug_abbrev: abbrev });
  assert.equal(result.complete, true);
  const die = result.dies.get(11);
  assert.equal(die.complete, true);
  assert.equal(die.attributes.get(0x02)?.value.length, 1);
});

test('a block overrun in one unit does not consume the following unit', () => {
  const u1 = [0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x01, 0x20]; // block1 len 0x20, no payload
  const u2 = [0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x01, 0x01, 0x01, 0xAA];
  const info = Uint8Array.from([...unit(u1), ...unit(u2)]);
  const result = parseDebugInfo({ debug_info: info, debug_abbrev: abbrev });
  assert.equal(result.units.length, 2, 'both units are discovered');
  assert.equal(result.complete, false, 'the overrun is not hidden');
  const secondDies = [...result.dies.values()].filter((d) => d.unit.start !== 0);
  assert.equal(secondDies.length, 1, 'the following unit still parses its own DIE');
  assert.equal(secondDies[0].complete, true);
  assert.equal(secondDies[0].attributes.get(0x02)?.value.length, 1);
});
