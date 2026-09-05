import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDebugInfo } from '../../../js/analysis/debug/dwarf.js';

function dwarf4Unit(die, abbrevOffset = 0) {
  const unitLength = 2 + 4 + 1 + die.length;
  const info = new Uint8Array(4 + unitLength);
  const view = new DataView(info.buffer);
  view.setUint32(0, unitLength, true);
  view.setUint16(4, 4, true);
  view.setUint32(6, abbrevOffset, true);
  info[10] = 4;
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

const oneAttributeTable = Uint8Array.from([
  0x01, 0x11, 0x00,       // abbrev 1: compile_unit, no children
  0x3c, 0x19,             // DW_AT_declaration / DW_FORM_flag_present
  0x00, 0x00,             // attribute terminator
  0x00,                   // table terminator
]);
const oneDie = Uint8Array.from([0x01, 0x00]);

test('#3932 repeated CUs reuse one bounded abbreviation parse', () => {
  const info = concat(dwarf4Unit(oneDie), dwarf4Unit(oneDie));
  const parsed = parseDebugInfo(
    { debug_info: info, debug_abbrev: oneAttributeTable },
    { maxRecords: 10, maxAbbrevDeclarations: 1, maxAbbrevAttributes: 1 },
  );

  assert.equal(parsed.complete, true);
  assert.equal(parsed.cancelled, false);
  assert.equal(parsed.units.length, 2);
  assert.equal(parsed.dies.size, 2);
  assert.equal(parsed.diagnostics.length, 0);
});

test('#3932 abbreviation declaration budget fails closed before DIE publication', () => {
  const twoDeclarations = Uint8Array.from([
    0x01, 0x11, 0x00, 0x00, 0x00,
    0x02, 0x2e, 0x00, 0x00, 0x00,
    0x00,
  ]);
  const parsed = parseDebugInfo(
    { debug_info: dwarf4Unit(oneDie), debug_abbrev: twoDeclarations },
    { maxRecords: 10, maxAbbrevDeclarations: 1, maxAbbrevAttributes: 10 },
  );

  assert.equal(parsed.complete, false);
  assert.equal(parsed.cancelled, false);
  assert.equal(parsed.dies.size, 0);
  assert.ok(parsed.diagnostics.includes('abbreviation declaration budget exhausted'));
});

test('#3932 abbreviation attribute budget fails closed before DIE publication', () => {
  const twoAttributes = Uint8Array.from([
    0x01, 0x11, 0x00,
    0x3c, 0x19,
    0x3f, 0x19,
    0x00, 0x00,
    0x00,
  ]);
  const parsed = parseDebugInfo(
    { debug_info: dwarf4Unit(oneDie), debug_abbrev: twoAttributes },
    { maxRecords: 10, maxAbbrevDeclarations: 10, maxAbbrevAttributes: 1 },
  );

  assert.equal(parsed.complete, false);
  assert.equal(parsed.cancelled, false);
  assert.equal(parsed.dies.size, 0);
  assert.ok(parsed.diagnostics.includes('abbreviation attribute budget exhausted'));
});

test('#3932 abbreviation parsing observes cancellation checkpoints', () => {
  let checks = 0;
  const signal = {
    get aborted() {
      checks += 1;
      return checks >= 4;
    },
  };
  const parsed = parseDebugInfo(
    { debug_info: dwarf4Unit(oneDie), debug_abbrev: oneAttributeTable },
    { maxRecords: 10, maxAbbrevDeclarations: 10, maxAbbrevAttributes: 10 },
    { signal },
  );

  assert.equal(parsed.complete, false);
  assert.equal(parsed.cancelled, true);
  assert.equal(parsed.dies.size, 0);
  assert.ok(parsed.diagnostics.includes('debug parse cancelled'));
  assert.ok(checks >= 4);
});
