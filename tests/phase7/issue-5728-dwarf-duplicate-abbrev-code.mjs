// Regression for #5728: DWARF abbreviation codes are unique within one table
// (DWARF §7.5.3). A duplicate declaration must fail closed as malformed —
// complete:false plus a diagnostic — instead of silently overwriting the
// first declaration with last-wins semantics.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseDebugInfo } from '../../js/analysis/debug/dwarf.js';

const debug_abbrev_duplicate = Uint8Array.from([
  // code=1, DW_TAG_compile_unit, no children, DW_AT_low_pc / DW_FORM_addr
  0x01, 0x11, 0x00,
  0x11, 0x01,
  0x00, 0x00,
  // same code=1 declared again, same payload length, DW_AT_high_pc attribute
  0x01, 0x11, 0x00,
  0x12, 0x01,
  0x00, 0x00,
  // abbreviation table terminator
  0x00,
]);

const debug_info = Uint8Array.from([
  0x10, 0x00, 0x00, 0x00, // unit_length = 16
  0x04, 0x00,             // DWARF4
  0x00, 0x00, 0x00, 0x00, // abbrev_offset = 0
  0x08,                   // address_size = 8
  0x01,                   // DIE abbreviation code 1
  0x00, 0x10, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, // 0x401000
]);

test('#5728 a duplicate abbreviation code fails the unit closed', () => {
  const out = parseDebugInfo({ debug_info, debug_abbrev: debug_abbrev_duplicate });
  assert.equal(out.complete, false, 'duplicate abbrev table must not be complete');
  assert.ok(
    out.diagnostics.some((d) => /duplicate abbreviation/i.test(d)),
    `diagnostic present: ${JSON.stringify(out.diagnostics)}`,
  );
});

test('#5728 first declaration wins over the duplicate (no silent last-wins semantic)', () => {
  const out = parseDebugInfo({ debug_info, debug_abbrev: debug_abbrev_duplicate });
  const die = [...out.dies.values()][0];
  assert.ok(die, 'DIE still parsed');
  assert.equal(die.complete, false, 'ambiguous abbreviation evidence is incomplete');
  assert.equal(die.attributes.has(0x11), true, 'first declaration (DW_AT_low_pc) kept');
  assert.equal(die.attributes.has(0x12), false, 'duplicate declaration ignored');
});

test('#5728 a well-formed table stays complete with no diagnostics', () => {
  const debug_abbrev_clean = Uint8Array.from([
    0x01, 0x11, 0x00,
    0x11, 0x01,
    0x00, 0x00,
    0x00,
  ]);
  const out = parseDebugInfo({ debug_info, debug_abbrev: debug_abbrev_clean });
  assert.equal(out.complete, true);
  assert.deepEqual(out.diagnostics, []);
});

test('#5728 identical duplicate declarations are rejected too', () => {
  const identical = Uint8Array.from([
    0x01, 0x11, 0x00,
    0x11, 0x01,
    0x00, 0x00,
    // The second declaration is byte-for-byte identical to the first.
    0x01, 0x11, 0x00,
    0x11, 0x01,
    0x00, 0x00,
    0x00,
  ]);
  const out = parseDebugInfo({ debug_info, debug_abbrev: identical });
  assert.equal(out.complete, false);
  assert.ok(out.diagnostics.some((d) => /duplicate abbreviation/i.test(d)));
  const die = [...out.dies.values()][0];
  assert.ok(die);
  assert.equal(die.complete, false);
  assert.equal(die.attributes.has(0x11), true);
});

test('#5728 a table terminator isolates following abbreviation tables', () => {
  const tables = Uint8Array.from([
    // First table: one unique declaration, then its terminator.
    0x01, 0x11, 0x00,
    0x11, 0x01,
    0x00, 0x00,
    0x00,
    // Following table: code 1 is duplicated, but belongs to another table.
    0x01, 0x11, 0x00,
    0x11, 0x01,
    0x00, 0x00,
    0x01, 0x11, 0x00,
    0x12, 0x01,
    0x00, 0x00,
    0x00,
  ]);
  const out = parseDebugInfo({ debug_info, debug_abbrev: tables });
  assert.equal(out.complete, true);
  assert.deepEqual(out.diagnostics, []);
  const die = [...out.dies.values()][0];
  assert.ok(die);
  assert.equal(die.attributes.has(0x11), true);
  assert.equal(die.attributes.has(0x12), false);
});
