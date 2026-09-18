import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDebugInfo } from '../../../js/analysis/debug/dwarf.js';

function dwarf4Unit(die = Uint8Array.from([0x01]), abbrevOffset = 0) {
  const unitLength = 2 + 4 + 1 + die.length;
  const info = new Uint8Array(4 + unitLength);
  const view = new DataView(info.buffer);
  view.setUint32(0, unitLength, true);
  view.setUint16(4, 4, true);
  view.setUint32(6, abbrevOffset, true);
  info[10] = 8;
  info.set(die, 11);
  return info;
}


function concat(...arrays) {
  const out = new Uint8Array(arrays.reduce((size, array) => size + array.length, 0));
  let offset = 0;
  for (const array of arrays) {
    out.set(array, offset);
    offset += array.length;
  }
  return out;
}

function parseWith(debug_abbrev) {
  return parseDebugInfo({ debug_info: dwarf4Unit(), debug_abbrev });
}

const truncatedTables = [
  ['abbreviation code ULEB', [0x80]],
  ['tag ULEB', [0x01, 0x80]],
  ['child byte', [0x01, 0x11]],
  ['attribute ULEB', [0x01, 0x11, 0x00, 0x80]],
  ['form ULEB', [0x01, 0x11, 0x00, 0x03, 0x80]],
  ['DW_FORM_implicit_const SLEB', [0x01, 0x11, 0x00, 0x03, 0x21, 0x80]],
];

for (const [label, bytes] of truncatedTables) {
  test(`#4041 truncated ${label} fails closed instead of throwing`, () => {
    const parsed = parseWith(Uint8Array.from(bytes));
    assert.equal(parsed.complete, false);
    assert.equal(parsed.cancelled, false);
    assert.equal(parsed.dies.size, 0, 'a partial abbreviation declaration must not publish DIE facts');
    assert.ok(
      parsed.diagnostics.includes('truncated abbreviation table for unit at 0x0'),
      `missing truncation diagnostic: ${parsed.diagnostics.join('; ')}`,
    );
  });
}

test('#4041 a complete abbreviation table keeps existing successful parsing', () => {
  const parsed = parseWith(Uint8Array.from([
    0x01, 0x11, 0x00, // code=1, DW_TAG_compile_unit, no children
    0x00, 0x00,       // no attributes
    0x00,             // table terminator
  ]));

  assert.equal(parsed.complete, true);
  assert.equal(parsed.cancelled, false);
  assert.equal(parsed.units.length, 1);
  assert.equal(parsed.dies.size, 1);
  assert.deepEqual(parsed.diagnostics, []);
});

test('#4041 overlong abbreviation LEB fails closed as malformed', () => {
  const parsed = parseWith(Uint8Array.from(Array(20).fill(0x80)));
  assert.equal(parsed.complete, false);
  assert.equal(parsed.dies.size, 0);
  assert.ok(parsed.diagnostics.includes('malformed abbreviation table for unit at 0x0'));
});


test('#4041 a bad abbreviation table does not consume a following independent unit', () => {
  const validTable = Uint8Array.from([
    0x01, 0x11, 0x00,
    0x00, 0x00,
    0x00,
  ]);
  const truncatedOffset = validTable.length;
  const parsed = parseDebugInfo({
    debug_info: concat(dwarf4Unit(Uint8Array.from([0x01]), truncatedOffset), dwarf4Unit()),
    debug_abbrev: concat(validTable, Uint8Array.from([0x80])),
  });

  assert.equal(parsed.complete, false);
  assert.equal(parsed.cancelled, false);
  assert.equal(parsed.units.length, 1, 'the malformed unit stays unpublished');
  assert.equal(parsed.units[0].start, dwarf4Unit().length, 'the following unit remains parseable');
  assert.equal(parsed.dies.size, 1);
  assert.ok(parsed.diagnostics.includes('truncated abbreviation table for unit at 0x0'));
});
