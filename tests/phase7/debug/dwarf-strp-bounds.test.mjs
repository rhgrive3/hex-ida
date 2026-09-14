import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDebugInfo } from '../../../js/analysis/debug/dwarf.js';

// Issue #1861: DWARF string-section references must be in bounds and NUL
// terminated. cstring() clamped out-of-range offsets to an empty decode and
// accepted unterminated spans, so DW_FORM_strp / line_strp / strx* referencing
// bad positions became valid-looking empty names on complete DIEs.
const abbrev = Uint8Array.from([
  0x01,       // abbrev code = 1
  0x11,       // DW_TAG_compile_unit
  0x00,       // no children
  0x03, 0x0e, // DW_AT_name, DW_FORM_strp
  0x00, 0x00, // attribute terminator
  0x00,
]);
const unit = (strp) => Uint8Array.from([12, 0, 0, 0, 4, 0, 0, 0, 0, 0, 8, 1, ...strp]);
const parse = (strBytes, strp = [0, 0, 0, 0]) => parseDebugInfo({
  debug_info: unit(strp),
  debug_abbrev: abbrev,
  debug_str: Uint8Array.from(strBytes),
});

test('an out-of-range strp offset fails closed instead of decoding an empty name', () => {
  const result = parse([0], [4, 0, 0, 0]);   // .debug_str length 1, offset 4 is past it
  const die = result.dies.get(11);
  assert.equal(die.complete, false, 'out-of-range strp must not be complete');
  assert.equal(die.attributes.get(3)?.value, null);
  assert.ok(result.diagnostics.some((d) => /unsupported form/.test(d)), 'a diagnostic is recorded');
});

test('an unterminated strp span fails closed instead of decoding the whole section tail', () => {
  const result = parse(Buffer.from('hello', 'utf8'));
  const die = result.dies.get(11);
  assert.equal(die.complete, false, 'unterminated strp must not be complete');
  assert.equal(die.attributes.get(3)?.value, null);
});

test('a terminated strp string still resolves and stays complete', () => {
  const result = parse(Buffer.from('hello\0', 'utf8'));
  const die = result.dies.get(11);
  assert.equal(result.complete, true);
  assert.equal(die.complete, true);
  assert.equal(die.attributes.get(3)?.value, 'hello');
});
