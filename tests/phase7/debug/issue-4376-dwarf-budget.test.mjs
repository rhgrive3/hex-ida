import assert from 'node:assert/strict';
import test from 'node:test';

import { DwarfDebugInfoProvider, parseDebugInfo } from '../../../js/analysis/debug/dwarf.js';

function concat(...arrays) {
  const out = new Uint8Array(arrays.reduce((size, array) => size + array.length, 0));
  let offset = 0;
  for (const array of arrays) {
    out.set(array, offset);
    offset += array.length;
  }
  return out;
}

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

const flatAbbrev = Uint8Array.from([
  0x01, 0x11, 0x00, // abbrev 1: compile_unit, no children
  0x00, 0x00,       // attribute terminator
  0x00,             // table terminator
]);

const nestedAbbrev = Uint8Array.from([
  0x01, 0x11, 0x01, // abbrev 1: compile_unit, has children
  0x00, 0x00,       // attribute terminator
  0x00,             // table terminator
]);

test('#4376 maxBytesScanned stops a low-record null-DIE stream', () => {
  const die = Uint8Array.from([1, ...new Uint8Array(512)]);
  const parsed = parseDebugInfo(
    { debug_info: dwarf4Unit(die), debug_abbrev: flatAbbrev },
    { maxBytesScanned: 32, maxRecords: 200000, maxDepth: 64 },
  );

  assert.equal(parsed.complete, false);
  assert.equal(parsed.dies.size, 1);
  assert.ok(parsed.diagnostics.includes('byte budget exhausted'));
});

test('#4376 maxBytesScanned also bounds an unterminated abbreviation table', () => {
  const hugeAbbrev = new Uint8Array(4096).fill(0x01);
  const parsed = parseDebugInfo(
    { debug_info: dwarf4Unit(Uint8Array.from([1, 0])), debug_abbrev: hugeAbbrev },
    { maxBytesScanned: 16, maxRecords: 200000, maxDepth: 64 },
  );

  assert.equal(parsed.complete, false);
  assert.equal(parsed.dies.size, 0);
  assert.ok(parsed.diagnostics.includes('byte budget exhausted'));
});

test('#4376 maxDepth rejects a child DIE beyond the configured stack depth', () => {
  const nested = Uint8Array.from([
    ...new Uint8Array(4).fill(1),
    ...new Uint8Array(4),
  ]);
  const parsed = parseDebugInfo(
    { debug_info: dwarf4Unit(nested), debug_abbrev: nestedAbbrev },
    { maxBytesScanned: 4096, maxRecords: 200000, maxDepth: 2 },
  );

  assert.equal(parsed.complete, false);
  assert.equal(parsed.dies.size, 2);
  assert.ok(parsed.diagnostics.includes('depth budget exhausted'));
});

test('#4376 normal input remains complete within byte and depth budgets', () => {
  const parsed = parseDebugInfo(
    { debug_info: concat(dwarf4Unit(Uint8Array.from([1, 0]))), debug_abbrev: flatAbbrev },
    { maxBytesScanned: 4096, maxRecords: 10, maxDepth: 1 },
  );

  assert.equal(parsed.complete, true);
  assert.equal(parsed.dies.size, 1);
  assert.deepEqual(parsed.diagnostics, []);
});

test('#4376 provider publishes budget exhaustion instead of complete status', () => {
  const result = new DwarfDebugInfoProvider().probe({
    identity: {},
    debugSections: {
      debug_info: dwarf4Unit(Uint8Array.from([1, ...new Uint8Array(128)])),
      debug_abbrev: flatAbbrev,
    },
  }, { budget: { maxBytesScanned: 24 } });

  assert.equal(result.status.completeness, 'partial');
  assert.equal(result.status.stopReason, 'budget-exhausted');
  assert.ok(result.diagnostics.includes('byte budget exhausted'));
});
