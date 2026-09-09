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

function dwarf4Unit(die) {
  const unitLength = 2 + 4 + 1 + die.length;
  const info = new Uint8Array(4 + unitLength);
  const view = new DataView(info.buffer);
  view.setUint32(0, unitLength, true);
  view.setUint16(4, 4, true);
  view.setUint32(6, 0, true);
  info[10] = 4;
  info.set(die, 11);
  return info;
}

const flatAbbrev = Uint8Array.from([
  0x01, 0x11, 0x00,
  0x00, 0x00,
  0x00,
]);

const simpleUnit = dwarf4Unit(Uint8Array.from([1, 0]));
// One simple CU consumes 13 .debug_info bytes plus 6 bytes to decode the
// shared abbreviation table. This intentionally exercises an exact budget hit.
const exactOneUnitBudget = 19;

test('#4376 exact byte-budget hit with remaining CU reports budget exhaustion', () => {
  const debugInfo = concat(simpleUnit, simpleUnit);
  const parsed = parseDebugInfo(
    { debug_info: debugInfo, debug_abbrev: flatAbbrev },
    { maxBytesScanned: exactOneUnitBudget, maxRecords: 10, maxDepth: 1 },
  );

  assert.equal(parsed.complete, false);
  assert.equal(parsed.units.length, 1);
  assert.equal(parsed.dies.size, 1);
  assert.ok(parsed.diagnostics.includes('byte budget exhausted'));

  const result = new DwarfDebugInfoProvider().probe({
    identity: {},
    debugSections: { debug_info: debugInfo, debug_abbrev: flatAbbrev },
  }, { budget: { maxBytesScanned: exactOneUnitBudget, maxRecords: 10, maxDepth: 1 } });

  assert.equal(result.status.completeness, 'partial');
  assert.equal(result.status.stopReason, 'budget-exhausted');
  assert.ok(result.diagnostics.includes('byte budget exhausted'));
});

test('#4376 exact-fit final CU remains complete', () => {
  const parsed = parseDebugInfo(
    { debug_info: simpleUnit, debug_abbrev: flatAbbrev },
    { maxBytesScanned: exactOneUnitBudget, maxRecords: 10, maxDepth: 1 },
  );

  assert.equal(parsed.complete, true);
  assert.equal(parsed.units.length, 1);
  assert.equal(parsed.dies.size, 1);
  assert.deepEqual(parsed.diagnostics, []);
});
